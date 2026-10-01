'use strict';

const test = require('node:test');
const assert = require('node:assert');

test('BUG-F6-001: formatTelegramSafeText & safe() corrupts comparison expressions and lacks entity escaping', () => {
  const { formatTelegramSafeText } = require('../lib/telegram-notifier');
  const { safe } = require('../lib/telegram-templates');

  const rawNote = 'Beli jika Price < 1500 dan MA > 1200';
  const cleanNotifier = formatTelegramSafeText(rawNote);
  const cleanTemplate = safe(rawNote);

  // Expect text comparison operators < and > not to be stripped as HTML tags
  assert.strictEqual(cleanNotifier, 'Beli jika Price < 1500 dan MA > 1200');
  assert.strictEqual(cleanTemplate, 'Beli jika Price < 1500 dan MA > 1200');
});

test('BUG-F6-002: checkAlertCooldown suppresses TP1_HIT / TP2_HIT / EARLY_EXIT_DISTRIBUTION after BUY setup', () => {
  const { recordAlertCooldown, checkAlertCooldown } = require('../lib/telegram-notifier');

  const ticker = 'BBCA';
  const t0 = 1700000000000;
  recordAlertCooldown(ticker, 'A_PLUS_SETUP', { now: t0, cooldownMs: 20 * 60 * 1000 });

  // 3 minutes later, TP1 is hit
  const tp1Check = checkAlertCooldown(ticker, 'TP1_HIT', { now: t0 + 3 * 60 * 1000 });
  assert.strictEqual(tp1Check.suppressed, false, 'TP1_HIT must bypass cooldown so traders receive take profit alert');

  // Or bandar distribution alert
  const distCheck = checkAlertCooldown(ticker, 'EARLY_EXIT_DISTRIBUTION', { now: t0 + 4 * 60 * 1000 });
  assert.strictEqual(distCheck.suppressed, false, 'EARLY_EXIT_DISTRIBUTION must bypass cooldown');
});

test('BUG-F6-003: sendTelegramPhoto & sendTelegramDocument ignore 429 rate limit backoff and retry_after', async () => {
  const notifier = require('../lib/telegram-notifier');

  process.env.TELEGRAM_ENABLED = '1';
  process.env.TELEGRAM_BOT_TOKEN = 'mock-token';
  process.env.TELEGRAM_CHAT_ID = '12345';

  const originalFetch = global.fetch;
  notifier.resetTelegramThrottle();

  global.fetch = async () => ({
    ok: false,
    status: 429,
    text: async () => JSON.stringify({ parameters: { retry_after: 30 } }),
    headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? '30' : null) }
  });

  try {
    const res = await notifier.sendTelegramPhoto(Buffer.from('fake'), 'test.png', 'Caption', { skip_market_guard: true });
    assert.strictEqual(res.reason, 'rate_limited', 'sendTelegramPhoto must identify 429 as rate_limited');
    assert.strictEqual(notifier.getTelegramThrottleState().backoffActive, true, 'Throttle gate must be parked for 30s');
  } finally {
    global.fetch = originalFetch;
    notifier.resetTelegramThrottle();
  }
});

test('BUG-F6-004: sendTelegramMessage skips acquireSendSlot throttling for chunk i > 0 during active 429 backoff', async () => {
  const notifier = require('../lib/telegram-notifier');

  process.env.TELEGRAM_ENABLED = '1';
  process.env.TELEGRAM_BOT_TOKEN = 'mock-token';
  process.env.TELEGRAM_CHAT_ID = '12345';

  notifier.resetTelegramThrottle();
  notifier.applyRateLimitBackoff(10); // active backoff for 10s

  const originalFetch = global.fetch;
  let chunkCount = 0;

  global.fetch = async () => {
    chunkCount++;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true })
    };
  };

  try {
    const longMsg = 'A'.repeat(3700);
    let sleepCalled = false;
    await notifier.sendTelegramMessage(longMsg, {
      skip_market_guard: true,
      min_interval_ms: 100,
      sleep: async () => { sleepCalled = true; }
    });

    assert.strictEqual(sleepCalled, true, 'acquireSendSlot must be called and waited for chunk 2 even when retryAfterUntil is in future');
  } finally {
    global.fetch = originalFetch;
    notifier.resetTelegramThrottle();
  }
});

test('BUG-F6-005: classifyTelegramResult locks 429 rate limit on multi-chunk send as delivery_uncertain and non-retryable', () => {
  const { classifyTelegramResult } = require('../lib/telegram-delivery');

  const partialRateLimitResult = {
    sent: false,
    skipped: false,
    reason: 'rate_limited',
    status: 429,
    chunks_sent: 1,
    chunks_total: 2,
    retry_after_seconds: 5
  };

  const classified = classifyTelegramResult(partialRateLimitResult);

  assert.strictEqual(classified.retryable, true, '429 rate limit on multi-chunk must be retryable');
  assert.notStrictEqual(classified.state, 'delivery_uncertain', '429 must not brick the delivery as permanently uncertain');
});
