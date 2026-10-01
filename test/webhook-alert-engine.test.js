'use strict';

/**
 * Webhook Alert Engine Test Suite
 *
 * Verifies:
 *   1. Formatting of Telegram Signal Card v2 and Discord Rich Embed with Pattern Edge
 *   2. Embed color coding based on signal status (Green, Orange, Yellow, Red)
 *   3. Cooldown & deduplication guard (drops duplicate alerts within cooldown)
 *   4. Cooldown bypass via force flag and drastic status changes (e.g. Watchlist -> Buy)
 *   5. Dry-run mode safety (zero HTTP fetch calls)
 *   6. Isolated multi-channel fault tolerance (failure in one does not break the other)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const alertEngine = require('../lib/webhook-alert-engine');

test('formatting: Discord Embed and Telegram Card include Trading Plan and Pattern Personality Edge', () => {
  const candidate = {
    ticker: 'BBCA',
    last_price: 9000,
    entry_low: 8950,
    entry_high: 9000,
    stop_loss: 8800,
    tp1: 9250,
    tp2: 9450,
    risk_reward: 1.6,
    volume_ratio_20d: 2.8,
    tx_value_1d: 350_000_000_000,
    status: 'A_PLUS_SETUP',
    foreign_net: 80_000_000_000,
    above_ma5: true,
    candle_pattern: 'Bullish Engulfing'
  };

  // 1. Discord Embed formatting
  const discordPayload = alertEngine.formatDiscordEmbed(candidate);
  assert.ok(discordPayload.embeds && discordPayload.embeds.length === 1);

  const embed = discordPayload.embeds[0];
  assert.ok(embed.title.includes('BBCA'));
  assert.ok(embed.title.includes('A+ Setup'));
  assert.equal(embed.color, alertEngine.DISCORD_COLORS.GREEN);

  // Assert fields
  const fieldNames = embed.fields.map(f => f.name);
  assert.ok(fieldNames.includes('🎯 Trading Plan'));
  assert.ok(fieldNames.includes('📊 Technical Context'));
  assert.ok(fieldNames.includes('👁 Pattern Personality Edge'));

  const edgeField = embed.fields.find(f => f.name === '👁 Pattern Personality Edge');
  assert.ok(edgeField.value.includes('COMBO_FX_TECH_MA5'));
  assert.ok(edgeField.value.includes('64.2%')); // Win Rate
  assert.ok(edgeField.value.includes('2.06'));  // Profit Factor

  // 2. Telegram message formatting
  const telegramMessage = alertEngine.formatTelegramMessage(candidate);
  assert.ok(telegramMessage.includes('BBCA'));
  assert.ok(telegramMessage.includes('🎯 Trading Plan'));
  assert.ok(telegramMessage.includes('Edge:'));
  assert.ok(telegramMessage.includes('COMBO_FX_TECH_MA5'));
  assert.ok(telegramMessage.includes('WR 64.2%'));
  assert.ok(telegramMessage.includes('PF 2.06'));
});

test('formatting: Discord Embed colors adjust correctly for various status types', () => {
  // Green for A+ Setup / Ready Breakout
  const green = alertEngine.resolveDiscordColor({ status: 'READY_BREAKOUT' });
  assert.equal(green, alertEngine.DISCORD_COLORS.GREEN);

  // Orange for Pullback / Reclaim
  const orange = alertEngine.resolveDiscordColor({ status: 'WAIT_PULLBACK' });
  assert.equal(orange, alertEngine.DISCORD_COLORS.ORANGE);

  // Yellow for Radar / Watchlist
  const yellow = alertEngine.resolveDiscordColor({ status: 'EARLY_RADAR' });
  assert.equal(yellow, alertEngine.DISCORD_COLORS.YELLOW);

  // Red for Avoid / Distribution / SL
  const red = alertEngine.resolveDiscordColor({ status: 'AVOID' });
  assert.equal(red, alertEngine.DISCORD_COLORS.RED);
});

test('cooldown: duplicate alerts within cooldown window are dropped silently', async () => {
  alertEngine.clearCooldownCache();

  const candidate = {
    ticker: 'TLKM',
    status: 'TRADE_CANDIDATE',
    last_price: 3200,
    entry_high: 3200,
    stop_loss: 3100,
    tp1: 3350
  };

  // First dispatch: records cooldown
  alertEngine.recordCooldown('TLKM', candidate, { cooldownMs: 15000 });

  const status = alertEngine.getCooldownStatus('TLKM');
  assert.ok(status);
  assert.equal(status.ticker, 'TLKM');
  assert.equal(status.isExpired, false);

  // Second dispatch: should be dropped
  const check = alertEngine.checkCooldown('TLKM', candidate);
  assert.equal(check.shouldDrop, true);
  assert.ok(check.reason.includes('in_cooldown'));

  // sendAlert with dryRun
  const result = await alertEngine.sendAlert(candidate, { dryRun: true });
  assert.equal(result.skipped, true);
  assert.ok(result.reason.includes('in_cooldown'));
});

test('cooldown: bypasses cooldown when force option is true', async () => {
  alertEngine.clearCooldownCache();

  const candidate = {
    ticker: 'BBNI',
    status: 'READY_BREAKOUT',
    last_price: 5400,
    entry_high: 5400,
    stop_loss: 5250,
    tp1: 5600
  };

  alertEngine.recordCooldown('BBNI', candidate, { cooldownMs: 60000 });

  // Normal check drops
  const checkNormal = alertEngine.checkCooldown('BBNI', candidate);
  assert.equal(checkNormal.shouldDrop, true);

  // Forced check bypasses
  const checkForced = alertEngine.checkCooldown('BBNI', candidate, { force: true });
  assert.equal(checkForced.shouldDrop, false);
  assert.equal(checkForced.reason, 'forced_bypass');

  // sendAlert with force: true
  const res = await alertEngine.sendAlert(candidate, { dryRun: true, force: true });
  assert.equal(res.skipped, false);
  assert.equal(res.success, true);
});

test('cooldown: bypasses cooldown when candidate undergoes drastic status change (Watchlist -> Buy)', async () => {
  alertEngine.clearCooldownCache();

  // Initially recorded as neutral watchlist
  const watchlistCandidate = {
    ticker: 'BMRI',
    status: 'WATCHLIST',
    last_price: 6800
  };
  alertEngine.recordCooldown('BMRI', watchlistCandidate, { cooldownMs: 60000 });

  // Upgraded to confirmed buy setup
  const buyCandidate = {
    ticker: 'BMRI',
    status: 'A_PLUS_SETUP',
    last_price: 6950,
    entry_high: 6950,
    stop_loss: 6800,
    tp1: 7200
  };

  const check = alertEngine.checkCooldown('BMRI', buyCandidate);
  assert.equal(check.shouldDrop, false);
  assert.equal(check.reason, 'status_changed_bypass');

  const res = await alertEngine.sendAlert(buyCandidate, { dryRun: true });
  assert.equal(res.skipped, false);
  assert.equal(res.success, true);
});

test('dryRun: mode returns payload structure without making network fetch requests', async () => {
  alertEngine.clearCooldownCache();

  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error('fetch should not be called in dry-run mode');
  };

  try {
    const candidate = {
      ticker: 'ASII',
      status: 'A_PLUS_SETUP',
      last_price: 5100,
      entry_high: 5100,
      stop_loss: 4950,
      tp1: 5300
    };

    const res = await alertEngine.sendAlert(candidate, {
      dryRun: true,
      telegram: true,
      discord: true
    });

    assert.equal(fetchCalled, false, 'global.fetch must not be invoked during dryRun');
    assert.equal(res.success, true);
    assert.equal(res.skipped, false);
    assert.ok(res.channels.telegram && res.channels.telegram.dryRun);
    assert.ok(res.channels.discord && res.channels.discord.dryRun);
    assert.ok(res.channels.discord.payload);
  } finally {
    global.fetch = originalFetch;
  }
});

test('resilience: failure in one channel does not interrupt dispatch in the other channel', async () => {
  alertEngine.clearCooldownCache();

  const originalFetch = global.fetch;

  // Mock fetch: telegram fails with 500, discord succeeds with 204
  global.fetch = async (url) => {
    if (String(url).startsWith('https://api.telegram.org/')) {
      return {
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error'
      };
    }
    return {
      ok: true,
      status: 204,
      text: async () => ''
    };
  };

  try {
    const candidate = {
      ticker: 'UNTR',
      status: 'READY_BREAKOUT',
      last_price: 24000,
      entry_high: 24000,
      stop_loss: 23200,
      tp1: 25200
    };

    const res = await alertEngine.sendAlert(candidate, {
      dryRun: false,
      telegramBotToken: 'mock_token',
      telegramChatId: '123456',
      discordWebhookUrl: 'https://discord.com/api/webhooks/123/mock'
    });

    // Discord succeeded, so overall success is true despite Telegram failing
    assert.equal(res.success, true);
    assert.equal(res.channels.telegram.sent, false);
    assert.ok(res.channels.telegram.error.includes('HTTP 500'));
    assert.equal(res.channels.discord.sent, true);
    assert.equal(res.channels.discord.status, 204);
  } finally {
    global.fetch = originalFetch;
  }
});
