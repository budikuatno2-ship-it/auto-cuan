'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const identity = require('../lib/subscription-identity');
const capability = require('../lib/subscription-capability');
const senderModule = require('../lib/voucher-admin-sender');
const unified = require('../lib/telegram-unified-subscription');

function privateUpdate(text, id, updateId) {
  const userId = id || 123456;
  return {
    update_id: updateId || 1001,
    message: {
      message_id: 77,
      text,
      from: { id: userId },
      chat: { id: userId, type: 'private' }
    }
  };
}

test('subscription link tokens have explicit sub_ namespace', () => {
  const old = process.env.TELEGRAM_SUBSCRIPTION_LINK_PEPPER;
  process.env.TELEGRAM_SUBSCRIPTION_LINK_PEPPER = 'test-link-pepper-at-least-16';
  try {
    const token = identity.createLinkToken();
    assert.match(token, /^sub_[A-Za-z0-9_-]{40,80}$/);
    assert.equal(identity.normalizeLinkToken(token), token);
    assert.equal(identity.normalizeLinkToken(token.slice(4)), null);
    assert.match(identity.linkTokenHash(token), /^[a-f0-9]{64}$/);
  } finally {
    if (old === undefined) delete process.env.TELEGRAM_SUBSCRIPTION_LINK_PEPPER;
    else process.env.TELEGRAM_SUBSCRIPTION_LINK_PEPPER = old;
  }
});

test('/akses remains outside subscription dispatcher', () => {
  const classified = unified.__test.classifyUpdate(privateUpdate('/akses'));
  assert.equal(classified.kind, 'none');
});

test('subscription deep link is routed before legacy admin /start handling', () => {
  const token = 'sub_' + 'A'.repeat(43);
  const classified = unified.__test.classifyUpdate(privateUpdate('/start ' + token));
  assert.equal(classified.kind, 'subscription_link');
});

test('voucher admin configuration shares verification bot token', () => {
  const env = {
    SUBSCRIPTION_FEATURE_ENABLED: 'true',
    VOUCHER_ADMIN_BOT_ENABLED: 'true',
    TELEGRAM_VERIFY_BOT_TOKEN: 'verification-bot-token-123456',
    VOUCHER_CODE_PEPPER: 'voucher-pepper-at-least-16'
  };
  assert.equal(capability.hasVoucherAdminConfiguration(env), true);
  assert.equal(senderModule.configured(env), true);
  assert.equal(capability.hasVoucherAdminConfiguration(Object.assign({}, env, { TELEGRAM_VERIFY_BOT_TOKEN: '' })), false);
});

test('voucher sender calls Telegram using verification token, never retired voucher token', async () => {
  const urls = [];
  const env = {
    SUBSCRIPTION_FEATURE_ENABLED: 'true',
    VOUCHER_ADMIN_BOT_ENABLED: 'true',
    TELEGRAM_VERIFY_BOT_TOKEN: 'verification-bot-token-123456',
    VOUCHER_ADMIN_TELEGRAM_BOT_TOKEN: 'retired-token-must-not-be-used'
  };
  const sender = senderModule.createVoucherAdminSender({
    env,
    fetch: async (url) => {
      urls.push(String(url));
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    }
  });
  await sender.sendMessage(123, 'test');
  assert.equal(urls.length, 1);
  assert.match(urls[0], /verification-bot-token-123456/);
  assert.doesNotMatch(urls[0], /retired-token-must-not-be-used/);
});

test('linked subscription command cleans origin message after success', async () => {
  const oldFeature = process.env.SUBSCRIPTION_FEATURE_ENABLED;
  const oldPepper = process.env.TELEGRAM_SUBSCRIPTION_LINK_PEPPER;
  process.env.SUBSCRIPTION_FEATURE_ENABLED = 'true';
  process.env.TELEGRAM_SUBSCRIPTION_LINK_PEPPER = 'test-link-pepper-at-least-16';
  const sent = [];
  const deleted = [];
  const rpcCalls = [];
  const db = {
    rpc: async (name, args) => {
      rpcCalls.push({ name, args });
      return { error: null, data: 'linked' };
    }
  };
  const bot = {
    sendMessage: async (chatId, text) => { sent.push({ chatId, text }); return { message_id: 88 }; },
    deleteMessage: async (chatId, messageId) => { deleted.push({ chatId, messageId }); return true; }
  };
  try {
    const token = identity.createLinkToken();
    const update = privateUpdate('/start ' + token, 987654, 1111);
    const result = await unified.handleUpdate(update, { db, bot, env: process.env });
    assert.equal(result.handled, true);
    assert.equal(result.outcome, 'subscription_linked');
    assert.equal(rpcCalls[0].name, 'consume_subscription_telegram_link');
    assert.equal(rpcCalls[0].args.p_telegram_user_id, 987654);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /berhasil terhubung/i);
    assert.deepEqual(deleted, [{ chatId: 987654, messageId: 77 }]);
  } finally {
    if (oldFeature === undefined) delete process.env.SUBSCRIPTION_FEATURE_ENABLED;
    else process.env.SUBSCRIPTION_FEATURE_ENABLED = oldFeature;
    if (oldPepper === undefined) delete process.env.TELEGRAM_SUBSCRIPTION_LINK_PEPPER;
    else process.env.TELEGRAM_SUBSCRIPTION_LINK_PEPPER = oldPepper;
  }
});

test('unified dispatcher stays fail-closed when subscription feature is disabled', async () => {
  const result = await unified.handleUpdate(privateUpdate('/trial'), {
    db: {},
    bot: {},
    env: { SUBSCRIPTION_FEATURE_ENABLED: 'false' }
  });
  assert.equal(result.handled, false);
  assert.equal(result.outcome, 'subscription_disabled');
});
