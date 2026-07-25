'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const webhook = require('../lib/telegram-membership-webhook');
const bot = require('../lib/telegram-verify-bot');

test('/paket handles an empty active catalog without sending blank Telegram text', async () => {
  const sent = [];
  const originalSend = bot.sendMessage;
  const originalAction = bot.sendChatAction;
  bot.sendMessage = async (_chatId, text) => { sent.push(text); };
  bot.sendChatAction = async () => true;
  const db = {
    claimUpdate: async () => true,
    releaseUpdate: async () => true,
    account: async () => ({ verified: true }),
    packages: async () => []
  };
  try {
    const outcome = await webhook.processUpdate({
      update_id: 9001,
      message: { text: '/paket', from: { id: 77 }, chat: { id: 77, type: 'private' } }
    }, db);
    assert.equal(outcome, 'packages_unavailable');
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Paket belum tersedia/);
    assert.notEqual(sent[0], '');
  } finally {
    bot.sendMessage = originalSend;
    bot.sendChatAction = originalAction;
  }
});
