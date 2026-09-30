'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const moneyManagementHandler = require('../lib/money-management-handler');
const { createInteractiveBot } = require('../lib/telegram-interactive-bot');

test('Money Management: calculations for cashflow and trading journal', async () => {
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
    env: {
      BOT_TOKEN: 'mock_token',
      PUBLIC_WEB_BASE_URL: 'https://autocuan.web.id',
      BOT_GROUP_ZERO_BYOK: 'true'
    },
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

  const handled = await bot.handleUpdate(Object.assign({}, mockCtx, {
    message: { text: '/opini' }
  }));

  assert.ok(handled, 'command should be handled');
  assert.ok(replyText.includes('Web Dashboard'), 'Group reply must include Web Dashboard link');
  assert.ok(replyText.includes('autocuan.web.id'), 'Link must direct to public web base');
});
