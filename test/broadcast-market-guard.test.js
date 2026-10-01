'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const telegramNotifier = require('../lib/telegram-notifier');

// Mock helpers
function makeWibDate(dateStr, timeStr) {
  return new Date(`${dateStr}T${timeStr}:00+07:00`);
}

test('Broadcast Market Guard Integration - Midday Break 12:45 WIB (Incident Case)', async () => {
  // Simulating 12:45 WIB on Thursday
  const testDate = makeWibDate('2026-09-17', '12:45');

  // Set env temporarily
  const origEnabled = process.env.TELEGRAM_ENABLED;
  const origToken = process.env.TELEGRAM_BOT_TOKEN;
  const origChat = process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_ENABLED = '1';
  process.env.TELEGRAM_BOT_TOKEN = 'mock_token';
  process.env.TELEGRAM_CHAT_ID = 'mock_chat_id';

  try {
    const result = await telegramNotifier.sendTelegramMessage('KAEF ENTRY ZONE SIGNAL', {
      now: testDate
    });

    assert.equal(result.sent, false);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'market_closed');
    assert.equal(result.session, 'CLOSED');
    assert.equal(result.time_wib, '12:45');
  } finally {
    process.env.TELEGRAM_ENABLED = origEnabled;
    process.env.TELEGRAM_BOT_TOKEN = origToken;
    process.env.TELEGRAM_CHAT_ID = origChat;
  }
});

test('Broadcast Market Guard Integration - Friday Prayer Break 11:35 WIB', async () => {
  // Simulating Friday 11:35 WIB
  const testDate = makeWibDate('2026-09-18', '11:35');

  const origEnabled = process.env.TELEGRAM_ENABLED;
  const origToken = process.env.TELEGRAM_BOT_TOKEN;
  const origChat = process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_ENABLED = '1';
  process.env.TELEGRAM_BOT_TOKEN = 'mock_token';
  process.env.TELEGRAM_CHAT_ID = 'mock_chat_id';

  try {
    const result = await telegramNotifier.sendTelegramMessage('FRIDAY SIGNAL', {
      now: testDate
    });

    assert.equal(result.sent, false);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'market_closed');
    assert.equal(result.session, 'CLOSED');
  } finally {
    process.env.TELEGRAM_ENABLED = origEnabled;
    process.env.TELEGRAM_BOT_TOKEN = origToken;
    process.env.TELEGRAM_CHAT_ID = origChat;
  }
});

test('Broadcast Market Guard Integration - Weekend (Saturday/Sunday)', async () => {
  // Simulating Saturday 10:00 WIB
  const testDate = makeWibDate('2026-09-19', '10:00');

  const origEnabled = process.env.TELEGRAM_ENABLED;
  const origToken = process.env.TELEGRAM_BOT_TOKEN;
  const origChat = process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_ENABLED = '1';
  process.env.TELEGRAM_BOT_TOKEN = 'mock_token';
  process.env.TELEGRAM_CHAT_ID = 'mock_chat_id';

  try {
    const result = await telegramNotifier.sendTelegramMessage('WEEKEND SIGNAL', {
      now: testDate
    });

    assert.equal(result.sent, false);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'market_closed');
  } finally {
    process.env.TELEGRAM_ENABLED = origEnabled;
    process.env.TELEGRAM_BOT_TOKEN = origToken;
    process.env.TELEGRAM_CHAT_ID = origChat;
  }
});

test('Broadcast Market Guard Integration - Active Market Hours 10:00 WIB & Session 2 14:15 WIB', async () => {
  const origFetch = global.fetch;
  const origEnabled = process.env.TELEGRAM_ENABLED;
  const origToken = process.env.TELEGRAM_BOT_TOKEN;
  const origChat = process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_ENABLED = '1';
  process.env.TELEGRAM_BOT_TOKEN = 'mock_token';
  process.env.TELEGRAM_CHAT_ID = 'mock_chat_id';

  let fetchCalls = [];
  global.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
      text: async () => JSON.stringify({ ok: true, result: {} })
    };
  };

  try {
    // 1. Session 1 Active: 10:00 WIB Thursday
    const morningDate = makeWibDate('2026-09-17', '10:00');
    const res1 = await telegramNotifier.sendTelegramMessage('ACTIVE MORNING SIGNAL', {
      now: morningDate
    });
    assert.equal(res1.sent, true);
    assert.equal(res1.skipped, false);
    assert.equal(res1.reason, null);

    // 2. Session 2 Active: 14:15 WIB Thursday
    const afternoonDate = makeWibDate('2026-09-17', '14:15');
    const res2 = await telegramNotifier.sendTelegramMessage('ACTIVE AFTERNOON SIGNAL', {
      now: afternoonDate
    });
    assert.equal(res2.sent, true);
    assert.equal(res2.skipped, false);
    assert.equal(res2.reason, null);

    assert.equal(fetchCalls.length, 2);
  } finally {
    global.fetch = origFetch;
    process.env.TELEGRAM_ENABLED = origEnabled;
    process.env.TELEGRAM_BOT_TOKEN = origToken;
    process.env.TELEGRAM_CHAT_ID = origChat;
  }
});

test('Broadcast Market Guard Integration - Explicit Bypass for Debug/Test Mode', async () => {
  const origFetch = global.fetch;
  const origEnabled = process.env.TELEGRAM_ENABLED;
  const origToken = process.env.TELEGRAM_BOT_TOKEN;
  const origChat = process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_ENABLED = '1';
  process.env.TELEGRAM_BOT_TOKEN = 'mock_token';
  process.env.TELEGRAM_CHAT_ID = 'mock_chat_id';

  let called = false;
  global.fetch = async () => {
    called = true;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true })
    };
  };

  try {
    // At 12:45 WIB with skip_market_guard=true -> should proceed
    const testDate = makeWibDate('2026-09-17', '12:45');
    const res = await telegramNotifier.sendTelegramMessage('DEBUG SIGNAL', {
      now: testDate,
      skip_market_guard: true
    });
    assert.equal(res.sent, true);
    assert.equal(called, true);
  } finally {
    global.fetch = origFetch;
    process.env.TELEGRAM_ENABLED = origEnabled;
    process.env.TELEGRAM_BOT_TOKEN = origToken;
    process.env.TELEGRAM_CHAT_ID = origChat;
  }
});
