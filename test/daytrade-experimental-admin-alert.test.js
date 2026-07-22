'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const alertLib = require('../lib/daytrade-experimental-admin-alert');
const live = require('../lib/intraday-shadow-scoring-live');

const FIXTURES = path.join(__dirname, 'fixtures', 'intraday-shadow-scoring-live');
const FIXTURE_DATE = '2026-07-21';
const FIXTURE_DIR = path.join(FIXTURES, FIXTURE_DATE);

const ADMIN_CHAT = '-1009999999';
const PUBLIC_CHAT = '-1001111111';
const TRADING_DAY = '2026-07-22';

// Env in which the experimental alert is allowed to run: production scoring and
// worker mutation are OFF; the explicit feature flag is ON.
const ENABLED_ENV = Object.freeze({
  DAYTRADE_INTRADAY_SCORE_ENABLED: 'false',
  DAYTRADE_WORKER_ALLOW_MUTATION: 'false',
  DAYTRADE_EXPERIMENTAL_ADMIN_ALERT_ENABLED: 'true',
  TELEGRAM_VERIFY_ADMIN_CHAT_ID: ADMIN_CHAT
});

async function tmpStateFile() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'exp-daytrade-'));
  return path.join(dir, 'alerts.jsonl');
}

function makeCandidate(overrides) {
  return Object.assign({
    ticker: 'ASPR',
    date: TRADING_DAY,
    snapshot: '09:30',
    confirmation_state: 'CONFIRMED',
    confirmed: true,
    confirmed_rank: 1,
    confirmation_reason: 'TWO_CONSECUTIVE_SNAPSHOTS',
    shadow_score: 16,
    entry_snapshot_time: '09:45',
    entry_reference_price: 1020,
    data_quality_status: 'OK',
    stale: false
  }, overrides || {});
}

// Strip block and line comments so negative "must not reference" assertions
// check the executable CODE, not the module's own documentation (which
// legitimately names the things it deliberately avoids).
function codeOnly(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

const MODULE_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'daytrade-experimental-admin-alert.js'), 'utf8');
const MODULE_CODE = codeOnly(MODULE_SRC);

function captureSender() {
  const calls = [];
  const sender = async function (text, adminChatId, env) {
    calls.push({ text, adminChatId, env });
    return { ok: true, sent: true, skipped: false, reason: null };
  };
  return { calls, sender };
}

// ===================================================================
// Gate — pure decision rules
// ===================================================================

test('1. confirmed rank 1 with score exactly 16 passes the gate', () => {
  const gate = alertLib.evaluateCandidateGate(makeCandidate({ shadow_score: 16 }), { tradingDay: TRADING_DAY });
  assert.equal(gate.eligible, true);
  assert.equal(gate.reason, 'PASS');
});

test('1b. all three accepted confirmation reasons pass', () => {
  for (const reason of alertLib.ALLOWED_CONFIRMATION_REASONS) {
    const gate = alertLib.evaluateCandidateGate(makeCandidate({ confirmation_reason: reason }), { tradingDay: TRADING_DAY });
    assert.equal(gate.eligible, true, reason + ' should pass');
  }
});

test('2. score below 16 fails', () => {
  const gate = alertLib.evaluateCandidateGate(makeCandidate({ shadow_score: 15.9 }), { tradingDay: TRADING_DAY });
  assert.equal(gate.eligible, false);
  assert.equal(gate.reason, 'REJECT_SCORE_BELOW_THRESHOLD');
});

test('3. rank 2-5 all fail', () => {
  for (const rank of [2, 3, 4, 5]) {
    const gate = alertLib.evaluateCandidateGate(makeCandidate({ confirmed_rank: rank }), { tradingDay: TRADING_DAY });
    assert.equal(gate.eligible, false, 'rank ' + rank + ' must fail');
    assert.equal(gate.reason, 'REJECT_RANK_NOT_1');
  }
});

test('4. provisional candidate fails (state + reason)', () => {
  const provisionalState = alertLib.evaluateCandidateGate(makeCandidate({
    confirmation_state: 'PROVISIONAL', confirmed: false, confirmation_reason: 'SINGLE_SNAPSHOT_UNCONFIRMED'
  }), { tradingDay: TRADING_DAY });
  assert.equal(provisionalState.eligible, false);
  assert.equal(provisionalState.reason, 'REJECT_NOT_CONFIRMED');

  // Even if it were mislabeled CONFIRMED, a one-snapshot reason is rejected.
  const oneSnapshotReason = alertLib.evaluateCandidateGate(makeCandidate({
    confirmation_reason: 'SINGLE_SNAPSHOT_UNCONFIRMED'
  }), { tradingDay: TRADING_DAY });
  assert.equal(oneSnapshotReason.eligible, false);
  assert.equal(oneSnapshotReason.reason, 'REJECT_INVALID_CONFIRMATION_REASON');
});

test('5. stale or previous-day candidate fails', () => {
  const stale = alertLib.evaluateCandidateGate(makeCandidate({ stale: true }), { tradingDay: TRADING_DAY });
  assert.equal(stale.eligible, false);
  assert.equal(stale.reason, 'REJECT_STALE_OR_PREVIOUS_DAY');

  const previousDay = alertLib.evaluateCandidateGate(makeCandidate({ date: '2026-07-21' }), { tradingDay: TRADING_DAY });
  assert.equal(previousDay.eligible, false);
  assert.equal(previousDay.reason, 'REJECT_STALE_OR_PREVIOUS_DAY');
});

test('6. missing next-snapshot price fails', () => {
  const noPrice = alertLib.evaluateCandidateGate(makeCandidate({ entry_reference_price: null }), { tradingDay: TRADING_DAY });
  assert.equal(noPrice.eligible, false);
  assert.equal(noPrice.reason, 'REJECT_MISSING_NEXT_SNAPSHOT_PRICE');

  const noSnapshot = alertLib.evaluateCandidateGate(makeCandidate({ entry_snapshot_time: null }), { tradingDay: TRADING_DAY });
  assert.equal(noSnapshot.eligible, false);
  assert.equal(noSnapshot.reason, 'REJECT_MISSING_NEXT_SNAPSHOT_PRICE');
});

test('7. duplicate same-day ticker fails', () => {
  const alertedKeys = new Set([alertLib.dedupKey(TRADING_DAY, 'ASPR')]);
  const gate = alertLib.evaluateCandidateGate(makeCandidate(), { tradingDay: TRADING_DAY, alertedKeys });
  assert.equal(gate.eligible, false);
  assert.equal(gate.reason, 'REJECT_DUPLICATE_SAME_DAY');
});

// ===================================================================
// Delivery — admin-only protection
// ===================================================================

test('8. public user delivery is impossible — never resolves/uses the public chat', async () => {
  // Admin resolver ignores the public chat env entirely.
  assert.equal(alertLib.resolveAdminChatId({ TELEGRAM_CHAT_ID: PUBLIC_CHAT }), null);
  assert.equal(alertLib.resolveAdminChatId({ TELEGRAM_VERIFY_ADMIN_CHAT_ID: ADMIN_CHAT }), ADMIN_CHAT);

  // With ONLY the public chat configured (no admin chat) nothing is sent.
  const { calls, sender } = captureSender();
  const stateFile = await tmpStateFile();
  const result = await alertLib.runExperimentalAdminAlert({
    env: { DAYTRADE_EXPERIMENTAL_ADMIN_ALERT_ENABLED: 'true', TELEGRAM_CHAT_ID: PUBLIC_CHAT },
    tradingDay: TRADING_DAY,
    candidates: [makeCandidate()],
    stateFile,
    sender
  });
  assert.equal(result.status, 'missing_admin_chat_id');
  assert.equal(result.sent, 0);
  assert.equal(calls.length, 0, 'sender must never be invoked without an admin chat');

  // With BOTH configured, the sender is called with the ADMIN chat, never public.
  const cap2 = captureSender();
  const stateFile2 = await tmpStateFile();
  const result2 = await alertLib.runExperimentalAdminAlert({
    env: { DAYTRADE_EXPERIMENTAL_ADMIN_ALERT_ENABLED: 'true', TELEGRAM_CHAT_ID: PUBLIC_CHAT, TELEGRAM_VERIFY_ADMIN_CHAT_ID: ADMIN_CHAT },
    tradingDay: TRADING_DAY,
    candidates: [makeCandidate()],
    stateFile: stateFile2,
    sender: cap2.sender
  });
  assert.equal(result2.sent, 1);
  assert.equal(cap2.calls.length, 1);
  assert.equal(cap2.calls[0].adminChatId, ADMIN_CHAT);
  assert.notEqual(cap2.calls[0].adminChatId, PUBLIC_CHAT);
});

test('8b. the module code never uses the public chat, verification channel, swing/top5/portfolio delivery, or DB mutation', () => {
  assert.ok(!/TELEGRAM_CHAT_ID/.test(MODULE_CODE), 'code must not use the public chat env');
  assert.ok(!/TELEGRAM_VERIFY_CHANNEL_ID/.test(MODULE_CODE), 'code must not use the verification channel');
  assert.ok(!/\bswing\b|konglo|portfolio|sendDailyTop5/i.test(MODULE_CODE), 'code must not touch swing/top5/portfolio delivery');
  assert.ok(!/\.insert\(|\.upsert\(|\.update\(|@supabase\/supabase-js/.test(MODULE_CODE), 'code must not mutate DB / import supabase');
  // No require of any forbidden module.
  assert.ok(!/require\(['"][^'"]*(telegram-templates|top5-progress-monitor|daytrade-screener-engine|daytrade-intraday-score-adjustment|supabase)[^'"]*['"]\)/.test(MODULE_SRC), 'must not import swing/top5/engine/scoring/supabase modules');
});

// ===================================================================
// Feature flag
// ===================================================================

test('9. feature flag false sends nothing', async () => {
  for (const flag of [undefined, '', '0', 'false', 'yes', 'TRUEISH']) {
    const env = { TELEGRAM_VERIFY_ADMIN_CHAT_ID: ADMIN_CHAT };
    if (flag !== undefined) env.DAYTRADE_EXPERIMENTAL_ADMIN_ALERT_ENABLED = flag;
    assert.equal(alertLib.isExperimentalAdminAlertEnabled(env), false, 'flag "' + flag + '" must be OFF');

    const { calls, sender } = captureSender();
    const stateFile = await tmpStateFile();
    const result = await alertLib.runExperimentalAdminAlert({
      env, tradingDay: TRADING_DAY, candidates: [makeCandidate()], stateFile, sender
    });
    assert.equal(result.status, 'disabled');
    assert.equal(result.sent, 0);
    assert.equal(calls.length, 0, 'nothing may be sent while the flag is off');
  }
});

test('10. feature flag true can send admin-only', async () => {
  for (const flag of ['1', 'true', 'TRUE']) {
    assert.equal(alertLib.isExperimentalAdminAlertEnabled({ DAYTRADE_EXPERIMENTAL_ADMIN_ALERT_ENABLED: flag }), true);
  }
  const { calls, sender } = captureSender();
  const stateFile = await tmpStateFile();
  const result = await alertLib.runExperimentalAdminAlert({
    env: Object.assign({}, ENABLED_ENV),
    tradingDay: TRADING_DAY,
    candidates: [makeCandidate()],
    stateFile,
    sender
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.enabled, true);
  assert.equal(result.sent, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].adminChatId, ADMIN_CHAT);
  // Message is clearly labeled and includes all required fields.
  const msg = calls[0].text;
  assert.ok(msg.startsWith('EXPERIMENTAL DAY TRADE \u2014 ADMIN ONLY'));
  assert.ok(msg.includes('Ticker: ASPR'));
  assert.ok(msg.includes('Signal time: 2026-07-22 09:30'));
  assert.ok(msg.includes('Confirmation: TWO_CONSECUTIVE_SNAPSHOTS'));
  assert.ok(msg.includes('Shadow score: 16'));
  assert.ok(msg.includes('Entry snapshot: 09:45'));
  assert.ok(msg.includes('Entry reference price: 1020'));
  assert.ok(/shadow evaluation/i.test(msg));
  assert.ok(/not a buy instruction/i.test(msg));
  assert.ok(/No profitability is claimed/i.test(msg));
});

// ===================================================================
// Idempotency — reruns cannot resend the same ticker/date
// ===================================================================

test('11. idempotency: a rerun does not resend the same ticker/date alert', async () => {
  const stateFile = await tmpStateFile();
  const first = captureSender();
  const r1 = await alertLib.runExperimentalAdminAlert({
    env: Object.assign({}, ENABLED_ENV), tradingDay: TRADING_DAY, candidates: [makeCandidate()], stateFile, sender: first.sender
  });
  assert.equal(r1.sent, 1);
  assert.equal(first.calls.length, 1);

  // State file now records the alert.
  const keys = await alertLib.readAlertedKeys(stateFile);
  assert.ok(keys.has(alertLib.dedupKey(TRADING_DAY, 'ASPR')));

  // Rerun with the same state file -> gate rejects as duplicate, nothing sent.
  const second = captureSender();
  const r2 = await alertLib.runExperimentalAdminAlert({
    env: Object.assign({}, ENABLED_ENV), tradingDay: TRADING_DAY, candidates: [makeCandidate()], stateFile, sender: second.sender
  });
  assert.equal(r2.sent, 0);
  assert.equal(second.calls.length, 0);
  assert.equal(r2.alerts[0].reason, 'REJECT_DUPLICATE_SAME_DAY');
});

test('12. within one run the same ticker is not sent twice', async () => {
  const stateFile = await tmpStateFile();
  const { calls, sender } = captureSender();
  const result = await alertLib.runExperimentalAdminAlert({
    env: Object.assign({}, ENABLED_ENV), tradingDay: TRADING_DAY,
    candidates: [makeCandidate(), makeCandidate()], stateFile, sender
  });
  assert.equal(result.sent, 1, 'duplicate candidate in the same run sent only once');
  assert.equal(calls.length, 1);
});

// ===================================================================
// Safety flags
// ===================================================================

test('13. worker mutation enabled blocks the alert (safety violation)', async () => {
  const { calls, sender } = captureSender();
  const stateFile = await tmpStateFile();
  const result = await alertLib.runExperimentalAdminAlert({
    env: { DAYTRADE_EXPERIMENTAL_ADMIN_ALERT_ENABLED: 'true', TELEGRAM_VERIFY_ADMIN_CHAT_ID: ADMIN_CHAT, DAYTRADE_WORKER_ALLOW_MUTATION: 'true' },
    tradingDay: TRADING_DAY, candidates: [makeCandidate()], stateFile, sender
  });
  assert.equal(result.status, 'safety_violation');
  assert.equal(result.sent, 0);
  assert.equal(calls.length, 0);
});

test('14. production intraday scoring enabled blocks the alert (safety violation)', async () => {
  for (const val of ['1', 'true']) {
    const { calls, sender } = captureSender();
    const stateFile = await tmpStateFile();
    const result = await alertLib.runExperimentalAdminAlert({
      env: { DAYTRADE_EXPERIMENTAL_ADMIN_ALERT_ENABLED: 'true', TELEGRAM_VERIFY_ADMIN_CHAT_ID: ADMIN_CHAT, DAYTRADE_INTRADAY_SCORE_ENABLED: val },
      tradingDay: TRADING_DAY, candidates: [makeCandidate()], stateFile, sender
    });
    assert.equal(result.status, 'safety_violation');
    assert.equal(calls.length, 0);
  }
});

// ===================================================================
// Integration with the completed live shadow evaluation
// ===================================================================

test('15. candidates derived from a live shadow evaluation gate + deliver admin-only', async () => {
  const ev = await live.evaluateLiveThroughTime(FIXTURE_DIR, FIXTURE_DATE, '16:00', {});
  const candidates = alertLib.buildAlertCandidatesFromEvaluation(ev, { tradingDay: FIXTURE_DATE });
  // The fixture's confirmed rank-1 (WINR) becomes the single eligible signal.
  assert.ok(candidates.some((c) => c.ticker === 'WINR' && c.confirmed_rank === 1));

  const { calls, sender } = captureSender();
  const stateFile = await tmpStateFile();
  const result = await alertLib.runExperimentalAdminAlert({
    env: { DAYTRADE_EXPERIMENTAL_ADMIN_ALERT_ENABLED: 'true', TELEGRAM_VERIFY_ADMIN_CHAT_ID: ADMIN_CHAT },
    tradingDay: FIXTURE_DATE, evaluation: ev, stateFile, sender
  });
  assert.equal(result.enabled, true);
  assert.equal(result.sent, 1);
  assert.equal(calls[0].adminChatId, ADMIN_CHAT);
  assert.ok(calls[0].text.includes('Ticker: WINR'));
});

test('16. dry-run previews eligibility but never sends or records', async () => {
  const ev = await live.evaluateLiveThroughTime(FIXTURE_DIR, FIXTURE_DATE, '16:00', {});
  const { calls, sender } = captureSender();
  const stateFile = await tmpStateFile();
  const result = await alertLib.runExperimentalAdminAlert({
    env: { DAYTRADE_EXPERIMENTAL_ADMIN_ALERT_ENABLED: 'false', TELEGRAM_VERIFY_ADMIN_CHAT_ID: ADMIN_CHAT },
    tradingDay: FIXTURE_DATE, evaluation: ev, stateFile, sender, dryRun: true
  });
  assert.equal(result.status, 'dry_run');
  assert.equal(result.sent, 0);
  assert.equal(calls.length, 0);
  assert.ok(result.alerts.some((a) => a.eligible === true && a.dry_run === true));
  assert.equal(fs.existsSync(stateFile), false, 'dry-run must not create the state file');
});

// ===================================================================
// Non-interference: base scoring, swing, top5, progress monitor unchanged
// ===================================================================

test('17. Swing Konglo and Non-Konglo templates remain intact and unchanged by this feature', () => {
  const templates = require('../lib/telegram-templates');
  assert.equal(typeof templates.formatSwingKongloSignalMessage, 'function');
  assert.equal(typeof templates.formatSwingNonKongloSignalMessage, 'function');
  // The experimental module neither imports nor uses the swing templates.
  assert.ok(!/require\(['"][^'"]*telegram-templates[^'"]*['"]\)/.test(MODULE_SRC));
  assert.ok(!/konglo/i.test(MODULE_CODE));
});

test('18. nightly Top5 + progress monitor modules remain intact and unchanged by this feature', () => {
  const monitor = require('../lib/top5-progress-monitor');
  for (const fn of ['computeTop5Progress', 'detectTop5ProgressEvents', 'buildTop5ProgressDiagnostics', 'deriveTrackingStatus']) {
    assert.equal(typeof monitor[fn], 'function', fn + ' must still exist');
  }
  // The experimental module must not import the progress monitor (it only reads
  // the shadow evaluation's confirmed_top5 field, which is unrelated).
  assert.ok(!/require\(['"][^'"]*top5-progress-monitor[^'"]*['"]\)/.test(MODULE_SRC), 'must not import the top5 progress monitor');
  assert.ok(!/progress[_-]?monitor/i.test(MODULE_CODE), 'code must not reference the progress monitor');
});

test('19. the base Day Trade scoring formula module is not imported or altered by this feature', () => {
  // The gate READS shadow output; it must not require the scoring engine or the
  // score-adjustment module, so it cannot change the base formula.
  assert.ok(!/require\(['"][^'"]*(daytrade-screener-engine|daytrade-intraday-score-adjustment)[^'"]*['"]\)/.test(MODULE_SRC));
});

// ===================================================================
// API surface invariant
// ===================================================================

test('20. API JavaScript endpoint count remains exactly 12', async () => {
  const entries = await fsp.readdir(path.join(__dirname, '..', 'api'));
  assert.equal(entries.filter((f) => f.endsWith('.js')).length, 12);
});
