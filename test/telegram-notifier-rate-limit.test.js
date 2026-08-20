'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const notifier = require('../lib/telegram-notifier');

test('sendTelegramMessage exposes Telegram 429 retry_after metadata', async () => {
  const saved = {
    enabled: process.env.TELEGRAM_ENABLED,
    token: process.env.TELEGRAM_BOT_TOKEN,
    chat: process.env.TELEGRAM_CHAT_ID,
    fetch: global.fetch
  };
  process.env.TELEGRAM_ENABLED = '1';
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_CHAT_ID = '123';
  global.fetch = async () => ({
    ok: false,
    status: 429,
    headers: { get: () => null },
    text: async () => JSON.stringify({ ok: false, parameters: { retry_after: 7 } })
  });
  try {
    const result = await notifier.sendTelegramMessage('test', { timeout_ms: 100 });
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'rate_limited');
    assert.equal(result.status, 429);
    assert.equal(result.retry_after_seconds, 7);
  } finally {
    if (saved.enabled === undefined) delete process.env.TELEGRAM_ENABLED; else process.env.TELEGRAM_ENABLED = saved.enabled;
    if (saved.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = saved.token;
    if (saved.chat === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = saved.chat;
    global.fetch = saved.fetch;
  }
});
