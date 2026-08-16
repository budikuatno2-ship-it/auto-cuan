'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const zeroLink = require('../lib/admin-command-zero-link-pairing');
const commandLogin = require('../lib/admin-command-login');
const adminAccess = require('../lib/admin-access');
const zeroLinkBrowser = require('../lib/admin-command-zero-link-browser');

function makeDb(options) {
  const opts = options || {};
  const claimed = new Set();
  const calls = [];
  return {
    calls,
    rpc(name, args) {
      calls.push({ name, args });
      if (name === 'claim_auth_recovery_webhook_update') {
        if (claimed.has(args.p_update_id)) return Promise.resolve({ data: [{ claimed: false }], error: null });
        claimed.add(args.p_update_id);
        return Promise.resolve({ data: [{ claimed: true }], error: null });
      }
      if (name === 'complete_auth_recovery_webhook_update') {
        return Promise.resolve({ data: null, error: null });
      }
      if (name === 'get_admin_command_login_context') {
        if (args.p_telegram_user_id !== 999) {
          return Promise.resolve({ data: [{ result_code: 'identity_mismatch', device_bound: false }], error: null });
        }
        return Promise.resolve({ data: [{
          result_code: 'ok', user_id: 'user-budi', username: 'budi',
          device_bound: opts.deviceBound === true,
          device_label: opts.deviceBound ? 'Windows · Chrome' : null
        }], error: null });
      }
      if (name === 'create_admin_command_login_grant') {
        return Promise.resolve({ data: [{
          result_code: 'ok', grant_id: 'grant-hp', user_id: 'user-budi', username: 'budi',
          device_bound: opts.deviceBound === true,
          device_label: opts.deviceBound ? 'Windows · Chrome' : null
        }], error: null });
      }
      if (name === 'get_admin_command_pair_candidate') {
        if (opts.candidate === 'ambiguous') {
          return Promise.resolve({ data: [{ result_code: 'ambiguous', candidate_count: 2 }], error: null });
        }
        if (opts.candidate === 'none') {
          return Promise.resolve({ data: [{ result_code: 'none', candidate_count: 0 }], error: null });
        }
        return Promise.resolve({ data: [{
          result_code: 'ok',
          request_ref: 'PairRequestRef_1234567890',
          display_tag: 'K7M4Q2',
          device_label: 'Windows · Chrome',
          candidate_count: 1
        }], error: null });
      }
      if (name === 'approve_admin_command_pair_request') {
        if (opts.approve === 'ambiguous') {
          return Promise.resolve({ data: [{ result_code: 'ambiguous' }], error: null });
        }
        return Promise.resolve({ data: [{
          result_code: 'ok',
          request_ref: args.p_request_ref,
          display_tag: 'K7M4Q2',
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

function accessUpdate(id, userId) {
  return {
    update_id: id,
    message: {
      message_id: 10,
      chat: { id: 5000 + id, type: 'private' },
      from: { id: userId == null ? 999 : userId },
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
      message: { message_id: 100, chat: { id: 6000 + id, type: 'private' } }
    }
  };
}

test('zero-link layer owns /akses and both new/old laptop callbacks', function () {
  assert.equal(zeroLink.matchesUpdate(accessUpdate(1)), true);
  assert.equal(zeroLink.matchesUpdate(callbackUpdate(2, 'admin_pair:PairRequestRef_1234567890')), true);
  assert.equal(zeroLink.matchesUpdate(callbackUpdate(3, commandLogin.LAPTOP_CALLBACK)), true);
  assert.equal(zeroLink.matchesUpdate(callbackUpdate(4, 'something_else')), false);
  assert.equal(adminAccess.__zeroLinkPairing, zeroLink);
});

test('first /akses menu uses a Telegram callback for Laptop and never a laptop URL', async function () {
  const db = makeDb({ deviceBound: false });
  const bot = makeBot();
  const result = await zeroLink.handleUpdate(accessUpdate(10), { db, bot });

  assert.equal(result.outcome, 'admin_zero_link_menu_sent');
  assert.equal(bot.sent.length, 1);
  const rows = bot.sent[0].options.reply_markup.inline_keyboard;
  assert.equal(rows.length, 2);
  assert.equal(rows[0][0].text, '📱 Buka di HP');
  assert.match(rows[0][0].url, /^https:\/\/autocuan\.web\.id\/api\/reset-password\?action=admin-command-login&token=/);
  assert.equal(rows[1][0].text, '💻 Hubungkan Laptop · K7M4Q2');
  assert.equal(rows[1][0].callback_data, 'admin_pair:PairRequestRef_1234567890');
  assert.equal(Object.prototype.hasOwnProperty.call(rows[1][0], 'url'), false, 'Laptop pairing must not open an external URL');
  assert.match(bot.sent[0].text, /ID perangkat: K7M4Q2/);
});

test('multiple pending browsers fail closed and expose no Laptop approval button', async function () {
  const db = makeDb({ deviceBound: false, candidate: 'ambiguous' });
  const bot = makeBot();
  const result = await zeroLink.handleUpdate(accessUpdate(11), { db, bot });

  assert.equal(result.outcome, 'admin_zero_link_menu_sent');
  const rows = bot.sent[0].options.reply_markup.inline_keyboard;
  assert.equal(rows.length, 1);
  assert.equal(rows[0][0].text, '📱 Buka di HP');
  assert.match(bot.sent[0].text, /lebih dari satu browser/);
});

test('pair callback approves exact browser request and edits Telegram message without a URL', async function () {
  const db = makeDb({ deviceBound: false });
  const bot = makeBot();
  const result = await zeroLink.handleUpdate(
    callbackUpdate(12, 'admin_pair:PairRequestRef_1234567890'),
    { db, bot }
  );

  assert.equal(result.outcome, 'admin_zero_link_pair_approved');
  const approval = db.calls.find(function (c) { return c.name === 'approve_admin_command_pair_request'; });
  assert.equal(approval.args.p_request_ref, 'PairRequestRef_1234567890');
  assert.equal(approval.args.p_telegram_user_id, 999);
  assert.equal(bot.edits.length, 1);
  assert.match(bot.edits[0].text, /Tidak ada link atau kode yang perlu dibuka/);
  assert.deepEqual(bot.edits[0].options.reply_markup.inline_keyboard, []);
  assert.doesNotMatch(bot.edits[0].text, /https?:\/\//);
});

test('old pre-deploy Laptop callback can no longer generate a pairing URL', async function () {
  const db = makeDb({ deviceBound: false });
  const bot = makeBot();
  const result = await zeroLink.handleUpdate(callbackUpdate(13, commandLogin.LAPTOP_CALLBACK), { db, bot });

  assert.equal(result.outcome, 'admin_zero_link_pair_approved');
  assert.equal(bot.edits.length, 1);
  assert.doesNotMatch(bot.edits[0].text, /https?:\/\//);
  const allOptions = JSON.stringify(bot.edits[0].options || {});
  assert.doesNotMatch(allOptions, /"url"/);
});

test('zero-link browser secrets are high entropy, HttpOnly and SameSite Strict', function () {
  const secret = zeroLinkBrowser.randomSecret();
  assert.match(secret, /^[A-Za-z0-9_-]{40,100}$/);
  assert.match(zeroLinkBrowser.hashSecret(secret), /^[a-f0-9]{64}$/);
  assert.match(zeroLinkBrowser.randomRequestRef(), /^[A-Za-z0-9_-]{20,60}$/);
  assert.match(zeroLinkBrowser.randomDisplayTag(), /^[A-Z0-9]{6}$/);
  const cookie = zeroLinkBrowser.buildCookie('ac_admin_pair', secret, 180);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
});

test('browser pairing runtime is dashboard-only and never contains a pairing URL', function () {
  const api = fs.readFileSync(path.join(ROOT, 'api', 'reset-password.js'), 'utf8');
  const server = fs.readFileSync(path.join(ROOT, 'lib', 'admin-command-zero-link-browser.js'), 'utf8');
  const ui = fs.readFileSync(path.join(ROOT, 'public', 'admin-zero-link-pairing.js'), 'utf8');
  const loader = fs.readFileSync(path.join(ROOT, 'public', 'website-approved-access.js'), 'utf8');

  assert.match(api, /admin-command-pair-poll/);
  assert.match(server, /pagePath !== '\/dashboard'/);
  assert.match(server, /poll_admin_command_pair_request/);
  assert.match(ui, /action: 'admin-command-pair-poll'/);
  assert.match(ui, /ID perangkat/);
  assert.match(ui, /Tidak perlu buka link atau mengetik kode/);
  assert.match(loader, /admin-zero-link-pairing\.js\?v=/);
  assert.doesNotMatch(ui, /action=admin-command-login&token=/);
});

test('zero-link pairing migration is hashed, RLS-enabled and service-role-only', function () {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'admin-telegram-zero-link-pairing-migration.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.admin_command_pair_requests/);
  assert.match(sql, /pair_hash\s+text/);
  assert.doesNotMatch(sql, /raw_pair|raw_secret/i);
  assert.match(sql, /ALTER TABLE public\.admin_command_pair_requests ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /candidate-count recheck|candidate-count/i);

  [
    'poll_admin_command_pair_request',
    'get_admin_command_pair_candidate',
    'approve_admin_command_pair_request'
  ].forEach(function (name) {
    assert.match(sql, new RegExp('REVOKE ALL ON FUNCTION public\\.' + name + '\\([^)]*\\) FROM PUBLIC, anon, authenticated'));
    assert.match(sql, new RegExp('GRANT EXECUTE ON FUNCTION public\\.' + name + '\\([^)]*\\) TO service_role'));
  });
});
