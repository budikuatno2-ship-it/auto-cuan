'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const zeroLink = require('../lib/admin-command-zero-link-pairing');
const commandLogin = require('../lib/admin-command-login');

function makeDb(options) {
  const opts = options || {};
  const calls = [];
  const claimed = new Set();
  return {
    calls,
    rpc(name, args) {
      calls.push({ name, args });
      if (name === 'get_admin_command_login_context') {
        return Promise.resolve({ data: [{
          result_code: 'ok',
          user_id: 'user-budi',
          username: 'budi',
          device_bound: true,
          device_label: 'Windows · Chrome'
        }], error: null });
      }
      if (name === 'get_admin_command_pair_candidate') {
        if (opts.candidate === 'none') {
          return Promise.resolve({ data: [{ result_code: 'none', candidate_count: 0 }], error: null });
        }
        if (opts.candidate === 'ambiguous') {
          return Promise.resolve({ data: [{ result_code: 'ambiguous', candidate_count: 2 }], error: null });
        }
        return Promise.resolve({ data: [{
          result_code: 'ok',
          request_ref: 'PairRequestRef_Rebind123456',
          display_tag: 'R3B1ND',
          device_label: 'Windows · Chrome',
          candidate_count: 1
        }], error: null });
      }
      if (name === 'claim_auth_recovery_webhook_update') {
        if (claimed.has(args.p_update_id)) return Promise.resolve({ data: [{ claimed: false }], error: null });
        claimed.add(args.p_update_id);
        return Promise.resolve({ data: [{ claimed: true }], error: null });
      }
      if (name === 'complete_auth_recovery_webhook_update') {
        return Promise.resolve({ data: null, error: null });
      }
      if (name === 'create_admin_command_login_grant') {
        return Promise.resolve({ data: [{
          result_code: 'ok',
          grant_id: 'grant-1',
          user_id: 'user-budi',
          username: 'budi',
          device_bound: true,
          device_label: 'Windows · Chrome'
        }], error: null });
      }
      if (name === 'approve_admin_command_pair_request') {
        return Promise.resolve({ data: [{
          result_code: 'ok',
          request_ref: args.p_request_ref,
          display_tag: 'R3B1ND',
          device_label: 'Windows · Chrome'
        }], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    }
  };
}

function makeBot() {
  const sent = [];
  const edits = [];
  const answers = [];
  return {
    sent, edits, answers,
    async sendMessage(chatId, text, options) {
      sent.push({ chatId, text, options });
      return { message_id: 100 };
    },
    async editMessageText(chatId, messageId, text, options) {
      edits.push({ chatId, messageId, text, options });
      return {};
    },
    async answerCallbackQuery(id, options) {
      answers.push({ id, options });
      return {};
    }
  };
}

function accessUpdate(id) {
  return {
    update_id: id,
    message: {
      message_id: 10,
      chat: { id: 7000 + id, type: 'private' },
      from: { id: 999 },
      text: '/akses'
    }
  };
}

function callbackUpdate(id, data) {
  return {
    update_id: id,
    callback_query: {
      id: 'cb-' + id,
      data,
      from: { id: 999 },
      message: { message_id: 100, chat: { id: 8000 + id, type: 'private' } }
    }
  };
}

test('cleared site data surfaces zero-link rebind even while DB still says device_bound=true', async function () {
  const db = makeDb();
  const bot = makeBot();

  const result = await zeroLink.handleUpdate(accessUpdate(201), { db, bot });

  assert.equal(result.outcome, 'admin_zero_link_menu_sent');
  assert.equal(bot.sent.length, 1);
  const rows = bot.sent[0].options.reply_markup.inline_keyboard;
  assert.equal(rows.length, 2);
  assert.equal(rows[1][0].text, '🔄 Hubungkan ulang Laptop · R3B1ND');
  assert.equal(rows[1][0].callback_data, 'admin_pair:PairRequestRef_Rebind123456');
  assert.equal(Object.prototype.hasOwnProperty.call(rows[1][0], 'url'), false);
  assert.match(bot.sent[0].text, /menghapus data\/cookie Auto-Cuan/);
  assert.match(bot.sent[0].text, /mengganti binding Laptop utama lama/);
});

test('old Laptop callback also prefers a fresh rebind candidate over the stale device binding', async function () {
  const db = makeDb();
  const bot = makeBot();

  const result = await zeroLink.handleUpdate(
    callbackUpdate(202, commandLogin.LAPTOP_CALLBACK),
    { db, bot }
  );

  assert.equal(result.outcome, 'admin_zero_link_pair_approved');
  const approval = db.calls.find(function (c) { return c.name === 'approve_admin_command_pair_request'; });
  assert.ok(approval, 'fresh browser pair request was not approved');
  assert.equal(approval.args.p_request_ref, 'PairRequestRef_Rebind123456');
  assert.equal(
    db.calls.some(function (c) { return c.name === 'create_admin_command_login_grant'; }),
    false,
    'stale paired-device grant must not win while a fresh browser rebind is pending'
  );
  assert.equal(bot.edits.length, 1);
  assert.doesNotMatch(JSON.stringify(bot.edits[0]), /"url"/);
});

test('ambiguous fresh browsers fail closed instead of targeting the stale paired device', async function () {
  const db = makeDb({ candidate: 'ambiguous' });
  const bot = makeBot();

  const result = await zeroLink.handleUpdate(accessUpdate(203), { db, bot });

  assert.equal(result.outcome, 'admin_zero_link_menu_sent');
  const rows = bot.sent[0].options.reply_markup.inline_keyboard;
  assert.equal(rows.length, 1);
  assert.equal(rows[0][0].text, '📱 Buka di HP');
  assert.match(bot.sent[0].text, /lebih dari satu browser/);
  const deviceGrants = db.calls.filter(function (c) {
    return c.name === 'create_admin_command_login_grant' && c.args && c.args.p_target === 'device';
  });
  assert.equal(deviceGrants.length, 0);
});
