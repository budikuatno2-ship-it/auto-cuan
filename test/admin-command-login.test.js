'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const commandLogin = require('../lib/admin-command-login');
const adminAccess = require('../lib/admin-access');
const uiPack = require('../public/ui-bugfix-pack-v1');
const loginBrowser = require('../lib/admin-command-login-browser');
const accountApi = require('../api/reset-password');

function makeDb(options) {
  const opts = options || {};
  const claimed = new Set();
  const calls = [];
  return {
    calls: calls,
    rpc(name, args) {
      calls.push({ name: name, args: args });
      if (name === 'get_admin_maintenance_code_status') {
        // This fixture models the pre-migration deployment stage: the
        // admin-maintenance-code SQL migration is not yet applied, so its
        // feature probe must report unavailable and the legacy
        // admin-command-login flow stays in charge of /akses.
        return Promise.resolve({ data: null, error: { message: 'function not found' } });
      }
      if (name === 'claim_auth_recovery_webhook_update') {
        if (claimed.has(args.p_update_id)) return Promise.resolve({ data: [{ claimed: false }], error: null });
        claimed.add(args.p_update_id);
        return Promise.resolve({ data: [{ claimed: true }], error: null });
      }
      if (name === 'complete_auth_recovery_webhook_update') {
        return Promise.resolve({ data: null, error: null });
      }
      if (name === 'get_admin_command_login_context') {
        const ok = args.p_telegram_user_id === 999;
        return Promise.resolve({
          data: [ok ? {
            result_code: 'ok', user_id: 'user-budi', username: 'budi',
            device_bound: opts.deviceBound === true, device_label: opts.deviceBound ? 'Windows · Chrome' : null
          } : {
            result_code: 'identity_mismatch', user_id: null, username: null,
            device_bound: false, device_label: null
          }],
          error: null
        });
      }
      if (name === 'create_admin_command_login_grant') {
        if (args.p_telegram_user_id !== 999) {
          return Promise.resolve({ data: [{ result_code: 'identity_mismatch' }], error: null });
        }
        if (args.p_target === 'device' && opts.deviceBound !== true) {
          return Promise.resolve({ data: [{ result_code: 'device_unbound', device_bound: false }], error: null });
        }
        return Promise.resolve({
          data: [{
            result_code: 'ok', grant_id: 'grant-1', user_id: 'user-budi', username: 'budi',
            device_bound: opts.deviceBound === true, device_label: opts.deviceBound ? 'Windows · Chrome' : null
          }],
          error: null
        });
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
    sent: sent,
    edits: edits,
    answers: answers,
    async sendMessage(chatId, text, options) {
      sent.push({ chatId: chatId, text: text, options: options });
      return { message_id: 100 };
    },
    async editMessageText(chatId, messageId, text, options) {
      edits.push({ chatId: chatId, messageId: messageId, text: text, options: options });
      return {};
    },
    async answerCallbackQuery(id, options) {
      answers.push({ id: id, options: options });
      return {};
    }
  };
}

function accessUpdate(updateId, userId, chatId, text) {
  return {
    update_id: updateId,
    message: {
      message_id: 10,
      chat: { id: chatId, type: 'private' },
      from: { id: userId },
      text: text || '/akses'
    }
  };
}

function laptopUpdate(updateId, userId, chatId) {
  return {
    update_id: updateId,
    callback_query: {
      id: 'cb-' + updateId,
      data: commandLogin.LAPTOP_CALLBACK,
      from: { id: userId },
      message: { message_id: 100, chat: { id: chatId, type: 'private' } }
    }
  };
}

test('/akses command is narrow and private-command shaped', function () {
  assert.equal(commandLogin.COMMAND_RE.test('/akses'), true);
  assert.equal(commandLogin.COMMAND_RE.test('/AKSES'), true);
  assert.equal(commandLogin.COMMAND_RE.test('/akses@AutoCuanVerificationBot'), true);
  assert.equal(commandLogin.COMMAND_RE.test('/akses please'), false);
  assert.equal(commandLogin.COMMAND_RE.test('/start'), false);
});

test('one-time login tokens are high entropy and only their SHA-256 form is DB-ready', function () {
  const token = commandLogin.randomToken();
  assert.match(token, /^[A-Za-z0-9_-]{40,100}$/);
  const hash = commandLogin.hashToken(token);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.notEqual(hash, token);
  assert.equal(commandLogin.hashToken('short'), null);
});

test('wrong Telegram identity cannot create an admin command login grant', async function () {
  const db = makeDb();
  const bot = makeBot();
  const result = await commandLogin.handleUpdate(accessUpdate(1, 111, 5001), { db: db, bot: bot });

  assert.equal(result.handled, true);
  assert.equal(result.outcome, 'admin_command_login_identity_mismatch');
  assert.equal(db.calls.filter(function (c) { return c.name === 'create_admin_command_login_grant'; }).length, 0);
  assert.equal(bot.sent.length, 1);
  assert.equal(bot.sent[0].chatId, 5001, 'the generic denial stays in the sender own chat');
});

test('verified /akses returns exactly the simple HP/Laptop menu', async function () {
  const db = makeDb({ deviceBound: true });
  const bot = makeBot();
  const result = await adminAccess.handleAdminAccessUpdate(accessUpdate(2, 999, 5002), { db: db, bot: bot });

  assert.equal(result.outcome, 'admin_command_login_menu_sent');
  assert.equal(bot.sent.length, 1);
  const keyboard = bot.sent[0].options.reply_markup.inline_keyboard;
  assert.equal(keyboard.length, 2);
  assert.equal(keyboard[0][0].text, '📱 Buka di HP');
  assert.match(keyboard[0][0].url, /^https:\/\/autocuan\.web\.id\/api\/reset-password\?action=admin-command-login&token=/);
  assert.equal(keyboard[1][0].text, '💻 Buka di Laptop');
  assert.equal(keyboard[1][0].callback_data, commandLogin.LAPTOP_CALLBACK);

  const grantCall = db.calls.find(function (c) { return c.name === 'create_admin_command_login_grant'; });
  assert.equal(grantCall.args.p_target, 'direct');
  assert.match(grantCall.args.p_token_hash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(keyboard[0][0].url, /ac_sess|SESSION_SECRET|TELEGRAM_VERIFY_BOT_TOKEN/i);
});

test('duplicate /akses webhook delivery creates no second menu or grant', async function () {
  const db = makeDb({ deviceBound: true });
  const bot = makeBot();
  const update = accessUpdate(3, 999, 5003);

  const first = await commandLogin.handleUpdate(update, { db: db, bot: bot });
  const second = await commandLogin.handleUpdate(update, { db: db, bot: bot });

  assert.equal(first.outcome, 'admin_command_login_menu_sent');
  assert.equal(second.outcome, 'duplicate');
  assert.equal(bot.sent.length, 1);
  assert.equal(db.calls.filter(function (c) { return c.name === 'create_admin_command_login_grant'; }).length, 1);
});

test('Laptop choice on a paired laptop creates a device grant and no URL/code', async function () {
  const db = makeDb({ deviceBound: true });
  const bot = makeBot();
  const result = await commandLogin.handleUpdate(laptopUpdate(4, 999, 5004), { db: db, bot: bot });

  assert.equal(result.outcome, 'admin_command_laptop_granted');
  const grantCall = db.calls.find(function (c) { return c.name === 'create_admin_command_login_grant'; });
  assert.equal(grantCall.args.p_target, 'device');
  assert.equal(grantCall.args.p_token_hash, null);
  assert.equal(bot.edits.length, 1);
  assert.match(bot.edits[0].text, /Perintah login dikirim ke Laptop utama/);
  assert.deepEqual(bot.edits[0].options.reply_markup.inline_keyboard, []);
  assert.doesNotMatch(bot.edits[0].text, /\b\d{6}\b/, 'no numeric login code should appear');
});

test('first Laptop choice uses one pairing button, never a typed code', async function () {
  const db = makeDb({ deviceBound: false });
  const bot = makeBot();
  const result = await commandLogin.handleUpdate(laptopUpdate(5, 999, 5005), { db: db, bot: bot });

  assert.equal(result.outcome, 'admin_command_laptop_pair_ready');
  const grantCall = db.calls.find(function (c) { return c.name === 'create_admin_command_login_grant'; });
  assert.equal(grantCall.args.p_target, 'pair');
  assert.match(grantCall.args.p_token_hash, /^[a-f0-9]{64}$/);
  assert.equal(bot.edits.length, 1);
  const button = bot.edits[0].options.reply_markup.inline_keyboard[0][0];
  assert.equal(button.text, '💻 Hubungkan & Buka Auto-Cuan');
  assert.match(button.url, /^https:\/\/autocuan\.web\.id\/api\/reset-password\?action=admin-command-login&token=/);
  assert.doesNotMatch(bot.edits[0].text, /\b\d{6}\b/);
});

test('admin-access dispatcher preserves legacy flow while routing /akses first', function () {
  assert.equal(typeof adminAccess.handleAdminAccessUpdate, 'function');
  assert.equal(typeof adminAccess.requestAccess, 'function', 'legacy browser-bound functions remain available as hidden fallback');
  assert.equal(adminAccess.__commandLogin, commandLogin);
  assert.equal(commandLogin.matchesUpdate(accessUpdate(6, 999, 5006)), true);
});

test('maintenance web admin entry is hidden and trusted-laptop polling reuses reset-password function', function () {
  assert.match(uiPack.STYLE_TEXT, /\.maintenance-admin\{display:none!important;\}/);
  assert.equal(typeof uiPack.installTelegramAdminDevicePoll, 'function');
  const src = fs.readFileSync(path.join(ROOT, 'public', 'ui-bugfix-pack-v1.js'), 'utf8');
  assert.match(src, /\/api\/reset-password/);
  assert.match(src, /action: 'admin-command-device-poll'/);
  assert.match(src, /location\.reload\(\)/);
});

test('device cookie is HttpOnly/Strict and pair-on-phone protection is present', function () {
  const cookie = loginBrowser.__test.buildDeviceCookie('A'.repeat(43));
  assert.match(cookie, /^ac_admin_dev=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal(loginBrowser.__test.isMobileUserAgent('Mozilla/5.0 (Linux; Android 15; Mobile)'), true);
  assert.equal(loginBrowser.__test.isMobileUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), false);

  const src = fs.readFileSync(path.join(ROOT, 'lib', 'admin-command-login-browser.js'), 'utf8');
  assert.match(src, /p_new_device_hash: mobile \? null : deviceHash/);
  assert.match(src, /createSessionToken\(\{ userId: row\.user_id, username: row\.username, isAdmin: true \}\)/);
  assert.equal(typeof accountApi.__test.adminCommandBrowser.buildDeviceCookie, 'function');
});

test('command login reuses an existing Vercel API slot instead of creating function #13', function () {
  const apiFiles = fs.readdirSync(path.join(ROOT, 'api')).filter(function (name) { return name.endsWith('.js'); });
  assert.equal(apiFiles.length, 12);
  assert.equal(apiFiles.includes('admin-telegram-login.js'), false);
  const wrapper = fs.readFileSync(path.join(ROOT, 'api', 'reset-password.js'), 'utf8');
  assert.match(wrapper, /admin-command-login/);
  assert.match(wrapper, /admin-command-device-poll/);
  assert.match(wrapper, /reset-password-legacy-handler/);
});

test('command-login migration stores hashes, keeps RLS, and grants RPC execution only to service_role', function () {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'admin-telegram-command-login-migration.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.admin_command_login_grants/);
  assert.match(sql, /token_hash\s+text/);
  assert.match(sql, /device_hash\s+text/);
  assert.doesNotMatch(sql, /raw_token|raw_device|login_token\s+text/i);
  assert.match(sql, /ALTER TABLE public\.admin_command_login_grants ENABLE ROW LEVEL SECURITY/);

  [
    'get_admin_command_login_context',
    'create_admin_command_login_grant',
    'consume_admin_command_login_token',
    'consume_admin_command_device_grant'
  ].forEach(function (name) {
    assert.match(sql, new RegExp('REVOKE ALL ON FUNCTION public\\.' + name + '\\([^)]*\\) FROM PUBLIC, anon, authenticated'));
    assert.match(sql, new RegExp('GRANT EXECUTE ON FUNCTION public\\.' + name + '\\([^)]*\\) TO service_role'));
  });
});
