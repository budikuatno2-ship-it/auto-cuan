'use strict';

// BATCH 10: outbound throttle / queue + 429 retry_after backoff regression.
// All timing is injected via `sleep`, so these tests never wait on real timers.

const test = require('node:test');
const assert = require('node:assert/strict');
const notifier = require('../lib/telegram-notifier');

async function withTelegramEnv(fetchImpl, fn) {
  const saved = {
    enabled: process.env.TELEGRAM_ENABLED,
    token: process.env.TELEGRAM_BOT_TOKEN,
    chat: process.env.TELEGRAM_CHAT_ID,
    fetch: global.fetch
  };
  process.env.TELEGRAM_ENABLED = '1';
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_CHAT_ID = '123';
  global.fetch = fetchImpl;
  try {
    return await fn();
  } finally {
    if (saved.enabled === undefined) delete process.env.TELEGRAM_ENABLED; else process.env.TELEGRAM_ENABLED = saved.enabled;
    if (saved.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = saved.token;
    if (saved.chat === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = saved.chat;
    global.fetch = saved.fetch;
    notifier.resetTelegramThrottle();
  }
}

function okResponse() {
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => '' };
}

test('acquireSendSlot spaces consecutive sends by the configured interval', async () => {
  notifier.resetTelegramThrottle();
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  await notifier.acquireSendSlot({ min_interval_ms: 1000, sleep });
  await notifier.acquireSendSlot({ min_interval_ms: 1000, sleep });
  assert.ok(waits.some((w) => w >= 900), `expected a ~1000ms wait, got ${JSON.stringify(waits)}`);
});

test('burst of 5 alerts is paced: every send after the first waits, none are dropped', async () => {
  notifier.resetTelegramThrottle();
  let fetchCount = 0;
  await withTelegramEnv(async () => { fetchCount++; return okResponse(); }, async () => {
    const waits = [];
    const sleep = async (ms) => { waits.push(ms); };
    const results = await Promise.all([0, 1, 2, 3, 4].map((i) =>
      notifier.sendTelegramMessage('alert ' + i, { skip_market_guard: true, min_interval_ms: 1000, sleep })
    ));
    assert.equal(fetchCount, 5, 'all 5 alerts must still be sent');
    assert.ok(results.every((r) => r.sent === true), 'no alert dropped');
    const paced = waits.filter((w) => w > 0).length;
    assert.ok(paced >= 4, `expected >=4 paced gaps, got ${paced}`);
  });
});

test('429 response extracts retry_after, parks the gate and warns without throwing', async () => {
  notifier.resetTelegramThrottle();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    await withTelegramEnv(async () => ({
      ok: false,
      status: 429,
      headers: { get: () => null },
      text: async () => JSON.stringify({ ok: false, parameters: { retry_after: 2 } })
    }), async () => {
      const result = await notifier.sendTelegramMessage('test', {
        skip_market_guard: true,
        min_interval_ms: 0,
        sleep: async () => {}
      });
      assert.equal(result.sent, false);
      assert.equal(result.reason, 'rate_limited');
      assert.equal(result.retry_after_seconds, 2);
      assert.equal(result.backoff_ms, 2000);

      const state = notifier.getTelegramThrottleState();
      assert.equal(state.backoffActive, true, 'gate must be parked after 429');
      assert.ok(state.retryAfterUntil > Date.now(), 'retryAfterUntil must be in the future');
    });
    assert.ok(warnings.some((w) => w.includes('[TELEGRAM_RATE_LIMITED]')), 'structured warning must be logged');
  } finally {
    console.warn = originalWarn;
    notifier.resetTelegramThrottle();
  }
});

test('an active 429 backoff is honored: the next send waits out retry_after', async () => {
  notifier.resetTelegramThrottle();
  notifier.applyRateLimitBackoff(2);
  const waits = [];
  await notifier.acquireSendSlot({ min_interval_ms: 0, sleep: async (ms) => { waits.push(ms); } });
  assert.ok(waits.some((w) => w > 1500), `expected to honour ~2000ms backoff, got ${JSON.stringify(waits)}`);
  notifier.resetTelegramThrottle();
});

test('resetTelegramThrottle clears the parked gate', () => {
  notifier.applyRateLimitBackoff(5);
  assert.equal(notifier.getTelegramThrottleState().backoffActive, true);
  notifier.resetTelegramThrottle();
  assert.equal(notifier.getTelegramThrottleState().backoffActive, false);
});