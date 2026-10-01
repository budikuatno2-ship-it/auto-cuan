'use strict';

/**
 * AUDIT FASE 12 (BATCH 6) — Webhook Alert Engine: Trigger Dedup, State Machine & Payload Signature
 *
 * Regression suite for the second (screener) Telegram dispatch path:
 *   - lib/webhook-alert-engine.js
 *
 * Findings covered (each FAILS on the pre-fix code):
 *   F12W-01  no short-window in-flight trigger dedup (two concurrent identical
 *            triggers could both dispatch before any cooldown was recorded)
 *   F12W-02  the short window must expire and allow a fresh trigger
 *   F12W-03  a released (failed) trigger must be immediately re-claimable
 *   F12W-04  no alert state machine — illegal transitions were undetectable
 *   F12W-05  a state cannot be committed without an active claim
 *   F12W-06  no payload signature primitives (deterministic HMAC-SHA256)
 *   F12W-07  signature verification must reject tampering / wrong secret / empty input
 *   F12W-08  sendAlert must suppress a concurrent duplicate when claim_dedup is on
 *   F12W-09  a failed dispatch must release its claim so the ticker is not stuck
 *   F12W-10  sendAlert must reject an unsigned payload when signature_secret is set
 *
 * LOCAL / OFFLINE ONLY — global.fetch is mocked; no real network, no real Telegram.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../lib/webhook-alert-engine');

const T0 = 1789000000000; // fixed clock, no wall-time dependency

function resetState() {
  engine.clearCooldownCache();
  engine.clearAlertClaims();
}

// ---------------------------------------------------------------------------
// F12W-01..03 — short-window trigger dedup (in-flight claim)
// ---------------------------------------------------------------------------
test('F12W-01 a duplicate trigger inside the short window must not be claimed twice', () => {
  resetState();
  const first = engine.claimAlert('BBCA', { now: T0 });
  assert.equal(first.claimed, true, 'the first trigger must claim the ticker');
  assert.equal(first.state, 'PENDING');

  const second = engine.claimAlert('BBCA', { now: T0 + 1000 });
  assert.equal(second.claimed, false, 'a second trigger 1s later must be suppressed');
  assert.equal(second.reason, 'duplicate_trigger_window');
  assert.ok(second.remainingMs > 0, 'remaining window must be reported');
});

test('F12W-02 the short window must expire and allow a fresh trigger', () => {
  resetState();
  engine.claimAlert('BBCA', { now: T0, claim_window_ms: 60000 });
  const late = engine.claimAlert('BBCA', { now: T0 + 61000 });
  assert.equal(late.claimed, true, 'after the window a new trigger must be allowed');
});

test('F12W-03 a released trigger must be immediately re-claimable', () => {
  resetState();
  engine.claimAlert('BBCA', { now: T0 });
  assert.equal(engine.releaseAlert('BBCA'), true, 'release must report it removed the claim');
  const again = engine.claimAlert('BBCA', { now: T0 + 1000 });
  assert.equal(again.claimed, true, 'a released trigger must not stay blocked');
  const claim = engine.getAlertClaim('BBCA', { now: T0 + 1000 });
  assert.ok(claim, 'the re-claimed ticker must be visible in the claim ledger');
  assert.equal(claim.state, 'PENDING');
});

// ---------------------------------------------------------------------------
// F12W-04 / F12W-05 — alert state machine
// ---------------------------------------------------------------------------
test('F12W-04 illegal alert state transitions must be rejected', () => {
  resetState();
  engine.claimAlert('BBCA', { now: T0 });

  const sent = engine.commitAlert('BBCA', 'SENT', { now: T0 });
  assert.equal(sent.ok, true, 'PENDING -> SENT must be legal');
  assert.equal(sent.state, 'SENT');

  const back = engine.commitAlert('BBCA', 'PENDING', { now: T0 });
  assert.equal(back.ok, false, 'SENT is terminal — no transition back to PENDING');
  assert.equal(back.reason, 'illegal_transition');

  const bogus = engine.commitAlert('BBCA', 'NOT_A_STATE', { now: T0 });
  assert.equal(bogus.ok, false);
  assert.equal(bogus.reason, 'unknown_state');
});

test('F12W-04b PENDING -> FAILED -> PENDING (retry) must be legal', () => {
  resetState();
  engine.claimAlert('TLKM', { now: T0 });
  assert.equal(engine.commitAlert('TLKM', 'FAILED', { now: T0 }).ok, true);
  const rearm = engine.commitAlert('TLKM', 'PENDING', { now: T0 });
  assert.equal(rearm.ok, true, 'FAILED must be re-armable for a retry');
  assert.equal(rearm.state, 'PENDING');
});

test('F12W-05 a state cannot be committed without an active claim', () => {
  resetState();
  const res = engine.commitAlert('BMRI', 'SENT', { now: T0 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no_active_claim');
});

// ---------------------------------------------------------------------------
// F12W-06 / F12W-07 — payload signature validation
// ---------------------------------------------------------------------------
test('F12W-06 signPayload must be deterministic and verifyPayloadSignature must accept it', () => {
  assert.equal(typeof engine.signPayload, 'function');
  assert.equal(typeof engine.verifyPayloadSignature, 'function');

  const secret = 'unit-test-signature-secret';
  const sigA = engine.signPayload({ ticker: 'BBCA', action: 'BUY', price: 9140 }, secret);
  const sigB = engine.signPayload({ price: 9140, action: 'BUY', ticker: 'BBCA' }, secret);
  assert.match(sigA, /^[0-9a-f]{64}$/, 'HMAC-SHA256 hex digest expected');
  assert.equal(sigA, sigB, 'key order must not change the signature');
  assert.equal(engine.verifyPayloadSignature({ ticker: 'BBCA', action: 'BUY', price: 9140 }, sigA, secret), true);
});

test('F12W-07 verifyPayloadSignature must reject tampering, wrong secret and empty inputs', () => {
  const secret = 'unit-test-signature-secret';
  const payload = { ticker: 'BBCA', action: 'BUY', price: 9140 };
  const sig = engine.signPayload(payload, secret);

  assert.equal(engine.verifyPayloadSignature({ ticker: 'BBCA', action: 'BUY', price: 9141 }, sig, secret), false, 'tampered payload must fail');
  assert.equal(engine.verifyPayloadSignature(payload, sig, 'wrong-secret'), false, 'wrong secret must fail');
  assert.equal(engine.verifyPayloadSignature(payload, '', secret), false, 'empty signature must fail');
  assert.equal(engine.verifyPayloadSignature(payload, sig, ''), false, 'empty secret must fail');
  assert.equal(engine.verifyPayloadSignature(payload, null, secret), false);
  assert.equal(engine.verifyPayloadSignature(null, sig, secret), false, 'null payload must fail');
  assert.equal(engine.signPayload(payload, ''), null, 'signing without a secret must return null, never a fake signature');
});

// ---------------------------------------------------------------------------
// F12W-08 / F12W-09 — sendAlert integration
// ---------------------------------------------------------------------------
test('F12W-08 sendAlert claim_dedup suppresses a concurrent duplicate trigger', async () => {
  resetState();
  const origFetch = global.fetch;

  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  let releaseFetch;
  const gate = new Promise((resolve) => { releaseFetch = resolve; });

  global.fetch = async () => {
    markStarted();
    await gate;
    return { ok: true, status: 204, text: async () => '' };
  };

  try {
    const candidate = { ticker: 'BBCA', status: 'TRADE_CANDIDATE', last_price: 9140, entry_high: 9140, stop_loss: 8900, tp1: 9500 };
    const first = engine.sendAlert(candidate, {
      skip_market_guard: true,
      claim_dedup: true,
      discord: false,
      telegramBotToken: 'mock-token',
      telegramChatId: '12345'
    });

    await started; // the first dispatch is now in flight (claim held)

    const second = await engine.sendAlert(candidate, {
      skip_market_guard: true,
      claim_dedup: true,
      dryRun: true
    });
    assert.equal(second.skipped, true, 'the concurrent duplicate must be suppressed');
    assert.equal(second.reason, 'duplicate_trigger_window');

    releaseFetch();
    const firstRes = await first;
    assert.equal(firstRes.success, true, 'the first (in-flight) dispatch must complete normally');
  } finally {
    global.fetch = origFetch;
  }
});

test('F12W-09 a failed dispatch must release its claim so the ticker is not stuck', async () => {
  resetState();
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500, text: async () => 'Internal Server Error' });

  try {
    const candidate = { ticker: 'TLKM', status: 'TRADE_CANDIDATE', last_price: 3200, entry_high: 3200, stop_loss: 3100, tp1: 3350 };
    const res = await engine.sendAlert(candidate, {
      skip_market_guard: true,
      claim_dedup: true,
      discord: false,
      telegramBotToken: 'mock-token',
      telegramChatId: '12345'
    });
    assert.equal(res.success, false, 'both channels failed so the dispatch must not report success');
    assert.equal(engine.getAlertClaim('TLKM'), null, 'the claim must be released after a failure');
  } finally {
    global.fetch = origFetch;
  }
});

test('F12W-10 sendAlert must reject an unsigned payload when signature_secret is set', async () => {
  resetState();
  const secret = 'unit-test-signature-secret';
  const candidate = { ticker: 'BBRI', status: 'TRADE_CANDIDATE', last_price: 5000 };

  const unsigned = await engine.sendAlert(candidate, {
    dryRun: true,
    skip_market_guard: true,
    signature_secret: secret
  });
  assert.equal(unsigned.skipped, true);
  assert.equal(unsigned.reason, 'invalid_signature');

  // The gate signs the canonical signal identity (buildSignaturePayload), so a
  // signature over different content must be rejected even if it is valid HMAC.
  const wrong = await engine.sendAlert(candidate, {
    dryRun: true,
    skip_market_guard: true,
    signature_secret: secret,
    payload_signature: engine.signPayload({ ticker: 'BBRI', status: 'AVOID' }, secret)
  });
  assert.equal(wrong.reason, 'invalid_signature', 'a signature for different content must be rejected');

  const goodSig = engine.signPayload(engine.buildSignaturePayload(candidate), secret);
  const signed = await engine.sendAlert(candidate, {
    dryRun: true,
    skip_market_guard: true,
    signature_secret: secret,
    payload_signature: goodSig
  });
  assert.equal(signed.skipped, false, 'a correctly signed payload must pass the gate');
  assert.equal(signed.success, true);
});
