'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const unified = require('../lib/telegram-unified-subscription');
const general = require('../lib/telegram-unified-general');
const voucherAdminBot = require('../lib/voucher-admin-bot');
const voucherContinuation = require('../lib/telegram-voucher-admin-continuation');
const zeroLink = require('../lib/admin-command-zero-link-pairing');
const commandLogin = require('../lib/admin-command-login');

const ADMIN_ID = 6396446903;

function privateUpdate(text, id, updateId) {
  const userId = id == null ? 123456 : id;
  return {
    update_id: updateId == null ? 7001 : updateId,
    message: {
      message_id: 91,
      text,
      from: { id: userId },
      chat: { id: userId, type: 'private' }
    }
  };
}

function callbackUpdate(data, id, updateId) {
  const userId = id == null ? ADMIN_ID : id;
  return {
    update_id: updateId == null ? 7101 : updateId,
    callback_query: {
      id: 'callback-1',
      data,
      from: { id: userId },
      message: {
        message_id: 92,
        from: { id: 999999, is_bot: true },
        chat: { id: userId, type: 'private' }
      }
    }
  };
}

function botFixture() {
  const sent = [];
  const deleted = [];
  return {
    sent,
    deleted,
    bot: {
      async sendMessage(chatId, text) {
        sent.push({ chatId, text });
        return { message_id: 501 };
      },
      async deleteMessage(chatId, messageId) {
        deleted.push({ chatId, messageId });
        return true;
      }
    }
  };
}

function publicSubscriptionDb() {
  return {
    from(table) {
      const query = {
        select() { return query; },
        eq() { return query; },
        async maybeSingle() {
          if (table === 'telegram_subscription_links') return { data: null, error: null };
          return { data: null, error: null };
        },
        async order() {
          if (table === 'subscription_plans') {
            return {
              data: [{
                code: 'PREMIUM_1_MONTH',
                display_name: 'Premium 1 Month',
                kind: 'term',
                duration_months: 1,
                subscription_plan_prices: {
                  normal_price_idr: 100000,
                  promo_price_idr: 35000,
                  promo_enabled: true,
                  promo_starts_at: '2026-01-01T00:00:00.000Z',
                  promo_ends_at: '2099-01-01T00:00:00.000Z',
                  active: true
                }
              }],
              error: null
            };
          }
          return { data: [], error: null };
        }
      };
      return query;
    },
    async rpc() {
      return { data: null, error: null };
    }
  };
}

function quantityDb(step) {
  const calls = [];
  return {
    calls,
    from(table) {
      assert.equal(table, 'voucher_admin_sessions');
      const query = {
        select() { return query; },
        eq() { return query; },
        async maybeSingle() {
          if (!step) return { data: null, error: null };
          return {
            data: {
              step,
              expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString()
            },
            error: null
          };
        }
      };
      return query;
    },
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === 'claim_voucher_admin_webhook_update') return { data: true, error: null };
      if (name === 'set_voucher_admin_quantity') {
        return {
          data: {
            voucher_type: 'LIFETIME',
            plan_code: 'LIFETIME',
            confirmation_key: '11111111-1111-4111-8111-111111111111'
          },
          error: null
        };
      }
      return { data: {}, error: null };
    }
  };
}

const enabledEnv = {
  SUBSCRIPTION_FEATURE_ENABLED: 'true',
  VOUCHER_ADMIN_BOT_ENABLED: 'true',
  TELEGRAM_VERIFY_BOT_TOKEN: '1234567890:verification-test-token',
  VOUCHER_CODE_PEPPER: 'voucher-code-pepper-at-least-16'
};

test('public BotFather commands route to exactly one intended surface', () => {
  assert.equal(general.matchesUpdate(privateUpdate('/akun')), true);
  assert.equal(general.matchesUpdate(privateUpdate('/help')), true);

  for (const text of ['/langganan', '/subscription', '/beli', '/status', '/trial', '/voucher', '/voucher AC-ABCDEFGHIJKL']) {
    assert.equal(unified.__test.classifyUpdate(privateUpdate(text)).kind, 'subscription_user', text);
    assert.equal(general.matchesUpdate(privateUpdate(text)), false, text);
  }

  const token = 'sub_' + 'A'.repeat(43);
  assert.equal(unified.__test.classifyUpdate(privateUpdate('/start ' + token)).kind, 'subscription_link');
});

test('public subscription commands execute their intended handler branches', async () => {
  for (const item of [
    ['/langganan', 'subscription_menu'],
    ['/subscription', 'subscription_menu'],
    ['/beli', 'subscription_buy_menu'],
    ['/status', 'subscription_status'],
    ['/trial', 'trial_not_linked'],
    ['/voucher AC-ABCDEFGHIJKL', 'voucher_not_linked']
  ]) {
    const fixture = botFixture();
    const result = await unified.handleUpdate(privateUpdate(item[0], 123456, 7200 + item[0].length), {
      db: publicSubscriptionDb(),
      bot: fixture.bot,
      env: enabledEnv
    });
    assert.equal(result.handled, true, item[0]);
    assert.equal(result.outcome, item[1], item[0]);
    assert.equal(fixture.sent.length, 1, item[0]);
    assert.deepEqual(fixture.deleted, [{ chatId: 123456, messageId: 91 }], item[0]);
  }
});

test('/start without subscription payload remains available to account verification', () => {
  const update = privateUpdate('/start');
  assert.equal(general.matchesUpdate(update), false);
  assert.equal(unified.__test.classifyUpdate(update).kind, 'none');
  assert.equal(zeroLink.matchesUpdate(update), false);
  assert.equal(commandLogin.matchesUpdate(update), false);
  assert.equal(voucherContinuation.isHiddenAdminShape(voucherContinuation.privateInput(update)), false);
});

test('/akses remains isolated as the verified administrator access command', () => {
  const update = privateUpdate('/akses', ADMIN_ID);
  assert.equal(general.matchesUpdate(update), false);
  assert.equal(unified.__test.classifyUpdate(update).kind, 'none');
  assert.equal(zeroLink.matchesUpdate(update), true);
  assert.equal(commandLogin.matchesUpdate(update), true);
});

test('all hidden voucher-admin slash commands are recognized and parse safely', () => {
  const commands = [
    '/voucheradmin',
    '/buatvoucher',
    '/daftarvoucher',
    '/detailvoucher VB-A1B2C3D4E5F6',
    '/nonaktifkanvoucher VB-A1B2C3D4E5F6',
    '/auditvoucher VV-A1B2C3D4E5F6',
    '/statistiklifetime',
    '/batal'
  ];
  for (const text of commands) {
    const update = privateUpdate(text, ADMIN_ID);
    assert.equal(unified.__test.classifyUpdate(update).kind, 'voucher_admin', text);
    assert.equal(voucherContinuation.HIDDEN_ADMIN_COMMAND_RE.test(text), true, text);
  }

  for (const text of [
    '/buatvoucher',
    '/daftarvoucher',
    '/detailvoucher VB-A1B2C3D4E5F6',
    '/nonaktifkanvoucher VB-A1B2C3D4E5F6',
    '/auditvoucher VV-A1B2C3D4E5F6',
    '/statistiklifetime',
    '/batal'
  ]) {
    assert.ok(voucherAdminBot.parseCommand(text), text);
  }
});

test('voucher-admin callbacks stay inside the voucher admin dispatcher', () => {
  for (const data of [
    'v:begin',
    'v:list',
    'v:detail',
    'v:disable',
    'v:audit',
    'v:stats',
    'v:type:LIFETIME',
    'v:type:PERCENT_100',
    'v:plan:PREMIUM_1_MONTH',
    'v:confirm:11111111-1111-4111-8111-111111111111',
    'v:cancel'
  ]) {
    assert.equal(unified.__test.classifyUpdate(callbackUpdate(data)).kind, 'voucher_admin', data);
  }
});

test('non-admin hidden voucher commands are swallowed silently before verification', async () => {
  const result = await voucherContinuation.handleUpdate(privateUpdate('/buatvoucher', 123456, 7301), {
    db: {},
    bot: botFixture().bot,
    env: enabledEnv
  });
  assert.equal(result.handled, true);
  assert.equal(result.outcome, 'voucher_admin_hidden_ignored');
});

test('active voucher quantity session consumes plain integer and produces confirmation', async () => {
  const db = quantityDb('quantity');
  const fixture = botFixture();
  const adminSent = [];
  const sender = {
    async sendMessage(chatId, text, extra) {
      adminSent.push({ chatId, text, extra });
      return { message_id: 601 };
    }
  };

  const result = await voucherContinuation.handleUpdate(privateUpdate('1', ADMIN_ID, 7302), {
    db,
    bot: fixture.bot,
    env: enabledEnv,
    voucherAdminCapability: { ready: true },
    voucherAdminSender: sender
  });

  assert.equal(result.handled, true);
  assert.equal(result.outcome, 'quantity');
  assert.equal(db.calls.some(call => call.name === 'set_voucher_admin_quantity' && call.args.p_requested_quantity === 1), true);
  assert.equal(adminSent.length, 1);
  assert.match(adminSent[0].text, /Konfirmasi batch/);
  assert.match(adminSent[0].text, /LIFETIME/);
  assert.deepEqual(fixture.deleted, [{ chatId: ADMIN_ID, messageId: 91 }]);
});

test('invalid text during voucher quantity session gets quantity guidance instead of verification error', async () => {
  const db = quantityDb('quantity');
  const fixture = botFixture();
  const result = await voucherContinuation.handleUpdate(privateUpdate('satu', ADMIN_ID, 7303), {
    db,
    bot: fixture.bot,
    env: enabledEnv
  });
  assert.equal(result.handled, true);
  assert.equal(result.outcome, 'voucher_admin_quantity_invalid');
  assert.equal(fixture.sent.length, 1);
  assert.match(fixture.sent[0].text, /angka bulat positif/);
  assert.equal(db.calls.length, 0);
});

test('plain integer is not swallowed when no voucher quantity session exists', async () => {
  const db = quantityDb(null);
  const fixture = botFixture();
  const result = await voucherContinuation.handleUpdate(privateUpdate('1', ADMIN_ID, 7304), {
    db,
    bot: fixture.bot,
    env: enabledEnv
  });
  assert.equal(result.handled, false);
  assert.equal(result.outcome, 'no_voucher_quantity_session');
  assert.equal(fixture.sent.length, 0);
  assert.equal(fixture.deleted.length, 0);
  assert.equal(db.calls.length, 0);
});
