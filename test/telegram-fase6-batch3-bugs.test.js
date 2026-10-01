'use strict';

const test = require('node:test');
const assert = require('node:assert');

test('BUG-F6-011: webhook-alert-engine suppresses TP1_HIT, TP2_HIT, and EARLY_EXIT_DISTRIBUTION during cooldown', () => {
  const webhookEngine = require('../lib/webhook-alert-engine');

  webhookEngine.clearCooldownCache();
  const ticker = 'BBCA';
  const t0 = 1700000000000;

  // Initial confirmed buy signal
  webhookEngine.recordCooldown(ticker, { status: 'A_PLUS_SETUP' }, { now: t0 });

  // 5 minutes later, TP1 is reached
  const tp1Check = webhookEngine.checkCooldown(ticker, { status: 'TP1_HIT' }, { now: t0 + 5 * 60 * 1000 });
  assert.strictEqual(tp1Check.shouldDrop, false, 'Take Profit alert TP1_HIT must not be suppressed by cooldown');

  // Distribution warning triggered
  const distCheck = webhookEngine.checkCooldown(ticker, { status: 'EARLY_EXIT_DISTRIBUTION' }, { now: t0 + 6 * 60 * 1000 });
  assert.strictEqual(distCheck.shouldDrop, false, 'Distribution exit alert must not be suppressed by cooldown');
});

test('BUG-F6-012: sendAlert market session guard is bypassed when options.now is omitted', async () => {
  const webhookEngine = require('../lib/webhook-alert-engine');
  const daytradeEngine = require('../lib/daytrade-screener-engine');

  webhookEngine.clearCooldownCache();

  // Mock market closed
  const origGetMarketSessionStatus = daytradeEngine.getMarketSessionStatus;
  daytradeEngine.getMarketSessionStatus = () => ({ session: 'CLOSED' });

  try {
    // Calling sendAlert without options.now
    const res = await webhookEngine.sendAlert({ ticker: 'BBRI', status: 'A_PLUS' }, {
      dryRun: true,
      telegram: true
    });

    assert.strictEqual(res.reason, 'market_session_closed', 'sendAlert must enforce closed market gate even when options.now is not injected');
  } finally {
    daytradeEngine.getMarketSessionStatus = origGetMarketSessionStatus;
  }
});

test('BUG-F6-013: dispatchTelegram does not chunk messages exceeding Telegram 4096 character limit', async () => {
  const webhookEngine = require('../lib/webhook-alert-engine');

  const longText = 'A'.repeat(4500);
  const origFetch = global.fetch;
  let capturedBody = null;

  global.fetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, status: 200 };
  };

  try {
    await webhookEngine.dispatchTelegram(longText, 'mock-token', '12345');
    // Telegram API limit is 4096 chars. Unchunked single send will be rejected with HTTP 400 Bad Request
    assert.ok(capturedBody && capturedBody.text.length <= 4096, 'Telegram text must be chunked to <= 4096 chars');
  } finally {
    global.fetch = origFetch;
  }
});

test('BUG-F6-014: createChatInviteLink ignores caller explicit expire_date and forces creates_join_request: true', async () => {
  const verifyBot = require('../lib/telegram-verify-bot');

  process.env.TELEGRAM_VERIFY_BOT_TOKEN = 'mock-verify-token';
  const origFetch = global.fetch;
  let capturedPayload = null;

  global.fetch = async (url, opts) => {
    capturedPayload = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({ ok: true, result: { invite_link: 'https://t.me/+test' } })
    };
  };

  try {
    const explicitExpireDate = 1890000000;
    await verifyBot.createChatInviteLink(-1001234567890, {
      expire_date: explicitExpireDate,
      creates_join_request: false
    });

    assert.strictEqual(capturedPayload.expire_date, explicitExpireDate, 'createChatInviteLink must respect caller provided expire_date');
    assert.strictEqual(capturedPayload.creates_join_request, false, 'createChatInviteLink must respect caller creates_join_request: false option');
  } finally {
    global.fetch = origFetch;
  }
});
