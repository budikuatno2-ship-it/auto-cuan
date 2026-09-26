'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const deepscanEngine = require('../lib/deepscan-engine');
const moneyManagementHandler = require('../lib/money-management-handler');
const sectorHotHandler = require('../api/sector-hot');
const { createInteractiveBot } = require('../lib/telegram-interactive-bot');

test('Macro DeepScan: screenTicker handles floor, stop loss valid to Rp1, and R/R', () => {
  // Mock 90 daily candles: historical high around 1800, now pulled back to accumulation floor ~1000
  const candles = [];
  const floorPrice = 1000;
  for (let i = 0; i < 90; i++) {
    const isEarly = i < 20;
    const isPeak = i >= 20 && i < 40;
    const price = isPeak ? 1800 - (i - 20) * 10 : (isEarly ? 1200 + i * 20 : floorPrice + (i - 40) * 0.8);
    candles.push({
      date: `2026-06-${String(i % 30 + 1).padStart(2, '0')}`,
      open: Math.round(price),
      high: Math.round(price + 20),
      low: Math.round(price - 10),
      close: Math.round(price),
      volume: 1000000
    });
  }

  const brokerData = {
    totalNet: 5000000000,
    cr3: 65,
    cr5: 80,
    days: 90
  };

  const screened = deepscanEngine.screenTicker('TEST', candles, brokerData);
  assert.ok(screened != null, 'screened candidate should not be null');
  assert.equal(screened.ticker, 'TEST');
  assert.ok(screened.stop_loss >= 1, 'Stop loss must be valid down to Rp1');
  assert.ok(screened.tp1 > screened.entry_high, 'TP1 must be above entry');
  assert.ok(screened.tp2 >= screened.tp1, 'TP2 must be >= TP1');
  assert.ok(screened.score > 0, 'Score must be positive');
});

test('Macro DeepScan: getLatestDeepScan returns structured results', async () => {
  const result = await deepscanEngine.getLatestDeepScan({ rootDir: path.resolve(__dirname, '..') });
  assert.ok(result.ok, 'getLatestDeepScan should be ok');
  assert.ok(Array.isArray(result.top_picks), 'top_picks must be an array');
  assert.ok(Array.isArray(result.all_results), 'all_results must be an array');
});

test('Money Management: calculations for cashflow and trading journal', async () => {
  // Test mock request
  const mockReqSummary = {
    method: 'GET',
    query: { action: 'summary', dev_user_id: 'test-user-123' },
    headers: { 'x-user-id': 'test-user-123' }
  };

  let responseData = null;
  let responseStatus = 200;
  const mockRes = {
    status(code) {
      responseStatus = code;
      return this;
    },
    json(data) {
      responseData = data;
      return this;
    },
    setHeader() {},
    end() {}
  };

  await moneyManagementHandler(mockReqSummary, mockRes);
  assert.equal(responseStatus, 200);
  assert.ok(responseData && responseData.success, 'summary should succeed');
  assert.ok(responseData.summary != null, 'summary object must exist');
  assert.equal(typeof responseData.summary.idle_cash_rdl, 'number');
  assert.equal(typeof responseData.summary.win_rate, 'number');
});

test('Telegram Group Bot: Zero BYOK in group chat for market commands', async () => {
  let replyText = '';
  let replyMarkup = null;

  const mockCtx = {
    chat: { id: -1001234567890, type: 'supergroup' },
    from: { id: 987654321, username: 'testmember' },
    telegram: {
      sendMessage: async (chatId, text, opts) => {
        replyText = text;
        replyMarkup = opts && opts.reply_markup;
        return { message_id: 111 };
      },
      editMessageText: async (chatId, msgId, undef, text) => {
        replyText = text;
        return true;
      },
      deleteMessage: async () => true
    },
    reply: async (text, opts) => {
      replyText = text;
      replyMarkup = opts && opts.reply_markup;
      return { message_id: 111 };
    }
  };

  const bot = createInteractiveBot({
    adminId: '999999',
    env: { BOT_TOKEN: 'mock_token', PUBLIC_WEB_BASE_URL: 'https://autocuan.web.id', BOT_GROUP_ZERO_BYOK: 'true' },
    getBotUser: async (id) => ({
      telegram_id: id,
      username: 'testmember',
      email: 'testmember@gmail.com',
      status: 'active'
    }),
    loadScreener: () => ({
      daytrade: [{ ticker: 'BBCA', unified_score: 88, sector: 'Banking' }]
    })
  });

  // Call /opini in group chat
  const handled = await bot.handleUpdate(Object.assign({}, mockCtx, {
    message: { text: '/opini' }
  }));

  assert.ok(handled, 'command should be handled');
  assert.ok(replyText.includes('Web Dashboard'), 'Group reply must include Web Dashboard link');
  assert.ok(replyText.includes('autocuan.web.id'), 'Link must direct to public web base');
});
