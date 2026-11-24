'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const notifier = require('../lib/telegram-notifier');

// M-P1e (2026-11-15): these tests exercise the LIVE-path 429 handling of
// sendTelegramMessage. The dry-run gate contract (lib/telegram-gate.js header)
// forbids setting TELEGRAM_LIVE=true in process.env, so we pass the official
// `options.gate_env` injection seam (added to telegram-notifier.js without
// changing the gate's decision rules) instead of mutating process.env. The
// gate stays fully armed in production; only the inspected env object changes.
const GATE_LIVE_ENV = { TELEGRAM_ENABLED: '1', TELEGRAM_LIVE: 'true', TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '123' };

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
  }
}

test('sendTelegramMessage exposes Telegram 429 body retry_after metadata', async () => {
  await withTelegramEnv(async () => ({
    ok: false,
    status: 429,
    headers: { get: () => null },
    text: async () => JSON.stringify({ ok: false, parameters: { retry_after: 7 } })
  }), async () => {
    const result = await notifier.sendTelegramMessage('test', { timeout_ms: 100, skip_market_guard: true, gate_env: GATE_LIVE_ENV });
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'rate_limited');
    assert.equal(result.status, 429);
    assert.equal(result.retry_after_seconds, 7);
  });
});

test('sendTelegramMessage falls back to Retry-After header when Telegram body omits it', async () => {
  await withTelegramEnv(async () => ({
    ok: false,
    status: 429,
    headers: { get: (name) => String(name).toLowerCase() === 'retry-after' ? '11' : null },
    text: async () => JSON.stringify({ ok: false, description: 'Too Many Requests' })
  }), async () => {
    const result = await notifier.sendTelegramMessage('test', { timeout_ms: 100, skip_market_guard: true, gate_env: GATE_LIVE_ENV });
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'rate_limited');
    assert.equal(result.status, 429);
    assert.equal(result.retry_after_seconds, 11);
  });
});
