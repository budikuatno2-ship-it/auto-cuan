'use strict';

// ===========================================================================
// Mocked tests for the admin approval gate + Delete User (api/admin-users.js)
// and the admin User-Approval list filters (public/index.html).
//
// LOCAL / MOCKED ONLY:
//  - @supabase/supabase-js and lib/telegram-verify-bot are stubbed via
//    Module._load. No live Telegram call, no live Supabase, no network, no real
//    secret/token. The in-memory model implements enough of the SQL RPC + table
//    semantics (base migration + approval-gate hotfix) to assert behavior.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'public', 'index.html');
const SESSION_SECRET = 'approval-gate-local-test-secret';

process.env.SESSION_SECRET = SESSION_SECRET;
process.env.SUPABASE_URL = 'https://example.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'local-test-key';
process.env.TELEGRAM_VERIFY_CHANNEL_ID = '-1000000000009';

const sessions = require('../lib/admin-session');

function makeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }
  };
}

const now = () => Date.now();
const iso = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// In-memory model (admin-users flows): supports the query builder used by
// admin-users.js plus the RPCs deliverApprovalInvite uses.
// ---------------------------------------------------------------------------
function makeAdminModel() {
  const db = { users: [], verifications: {}, _uid: 1 };

  db.seedUser = function (u) {
    const user = Object.assign({
      id: 'u-' + (db._uid++), username: 'user', device_id: 'dev-' + db._uid,
      devices: ['dev'], user_agent: '', is_blocked: false, is_approved: false,
      created_at: iso(now()), last_login_at: null
    }, u);
    db.users.push(user);
    return user;
  };
  db.seedVerification = function (v) {
    const row = Object.assign({
      user_id: null, telegram_user_id: null, telegram_private_chat_id: null,
      telegram_verified_at: null, channel_joined_at: null, dynamic_invite_link: null,
      invite_delivery_status: 'pending', invite_delivery_claim_token: null,
      invite_delivery_claimed_at: null, invite_delivery_attempts: 0,
      invite_delivery_last_error: null, invite_delivery_sent_at: null
    }, v);
    db.verifications[row.user_id] = row;
    return row;
  };
  db.getUser = function (id) { return db.users.find(function (u) { return u.id === id; }); };

  function ok(data) { return Promise.resolve({ data: data, error: null }); }

  db.rpc = function (name, args) {
    switch (name) {
      case 'claim_invite_delivery': {
        const v = db.verifications[args.p_user_id];
        if (!v || !v.telegram_verified_at || v.telegram_private_chat_id == null) return ok([]);
        const user = db.getUser(v.user_id);
        if (!user || user.is_approved !== true || user.is_blocked !== false) return ok([]);
        if (!(v.invite_delivery_status === 'pending' || v.invite_delivery_status === 'failed')) return ok([]);
        const tok = 'idtok-' + (db._uid++);
        v.invite_delivery_status = 'claimed'; v.invite_delivery_claim_token = tok; v.invite_delivery_attempts += 1;
        return ok([{ claim_token: tok, out_user_id: v.user_id, telegram_user_id: v.telegram_user_id, telegram_private_chat_id: v.telegram_private_chat_id, username: user.username }]);
      }
      case 'complete_invite_delivery': {
        const v = db.verifications[args.p_user_id];
        if (v && v.invite_delivery_claim_token === args.p_claim_token && v.invite_delivery_status === 'claimed') { v.invite_delivery_status = 'sent'; v.invite_delivery_sent_at = now(); return ok(true); }
        return ok(false);
      }
      case 'fail_invite_delivery': {
        const v = db.verifications[args.p_user_id];
        if (v && v.invite_delivery_claim_token === args.p_claim_token && v.invite_delivery_status === 'claimed') { v.invite_delivery_status = 'failed'; v.invite_delivery_last_error = String(args.p_error_code).slice(0, 120); return ok(true); }
        return ok(false);
      }
      case 'save_dynamic_invite_link': {
        const v = db.verifications[args.p_user_id]; if (v) { v.dynamic_invite_link = args.p_invite_link; v.invite_expires_at = args.p_expires_at; }
        return ok(null);
      }
      case 'save_invite_message_id': {
        const v = db.verifications[args.p_user_id]; if (v) { v.invite_message_id = args.p_message_id; }
        return ok(null);
      }
      case 'clear_invite_message_id': {
        const v = db.verifications[args.p_user_id]; if (v) { v.invite_message_id = null; }
        return ok(null);
      }
      default:
        return Promise.resolve({ data: null, error: { code: 'P0001', message: 'unknown rpc ' + name } });
    }
  };

  db.from = function (table) {
    const b = { _t: table, _op: 'select', _filters: [], _payload: null };
    b.select = function () { return b; };
    b.insert = function (p) { b._op = 'insert'; b._payload = p; return b; };
    b.update = function (p) { b._op = 'update'; b._payload = p; return b; };
    b.eq = function (c, v) { b._filters.push([c, v]); return b; };
    b.order = function () { return b; };
    b.limit = function () { return Promise.resolve({ data: rows().filter(match), error: null }); };
    function rows() {
      if (table === 'app_users') return db.users;
      if (table === 'app_user_telegram_verifications') return Object.values(db.verifications);
      return [];
    }
    function match(r) { return b._filters.every(function (f) { return r[f[0]] === f[1]; }); }
    b.maybeSingle = function () {
      if (b._op === 'update' && b._payload) {
        const matched = rows().filter(match);
        if (matched.length === 0) return Promise.resolve({ data: null, error: null });
        matched.forEach(function (r) { Object.assign(r, b._payload); });
        const r = matched[0];
        return Promise.resolve({ data: { id: r.id, username: r.username, created_at: r.created_at }, error: null });
      }
      const found = rows().find(match) || null;
      return Promise.resolve({ data: found, error: null });
    };
    b.then = function (resolve) {
      if (b._op === 'insert') { return resolve({ data: b._payload, error: null }); }
      if (b._op === 'update') { rows().filter(match).forEach(function (r) { Object.assign(r, b._payload); }); return resolve({ data: null, error: null }); }
      return resolve({ data: rows().filter(match), error: null });
    };
    return b;
  };

  return db;
}

function makeFakeVerifyBot(opts) {
  opts = opts || {};
  const calls = { sendMessage: [], createChatInviteLink: [], revokeChatInviteLink: [], approveChatJoinRequest: [], declineChatJoinRequest: [] };
  const bot = {
    calls: calls,
    inviteThrows: !!opts.inviteThrows,
    sendThrows: !!opts.sendThrows,
    sendMessage: async function (chatId, text, options) { calls.sendMessage.push({ chatId, text, options }); if (bot.sendThrows) throw new Error('send'); return { message_id: 1 }; },
    editMessageText: async function () { return {}; },
    editMessageReplyMarkup: async function () { return {}; },
    answerCallbackQuery: async function () { return {}; },
    getChatMember: async function () { return { status: 'member' }; },
    createChatInviteLink: async function (chatId, options) { calls.createChatInviteLink.push({ chatId, options }); if (bot.inviteThrows) throw new Error('invite'); return opts.inviteLink || 'https://t.me/+approved'; },
    revokeChatInviteLink: async function (chatId, link) { calls.revokeChatInviteLink.push({ chatId, link }); return {}; },
    approveChatJoinRequest: async function (chatId, userId) { calls.approveChatJoinRequest.push({ chatId, userId }); return true; },
    declineChatJoinRequest: async function (chatId, userId) { calls.declineChatJoinRequest.push({ chatId, userId }); return true; }
  };
  return bot;
}

// Require api/admin-users with @supabase/supabase-js AND lib/telegram-verify-bot
// stubbed. Returns the handler bound to the provided model + fake bot.
function loadAdminUsers(db, verifyBot) {
  const origLoad = Module._load;
  const abs = require.resolve('../api/admin-users');
  delete require.cache[abs];
  Module._load = function (request) {
    if (request === '@supabase/supabase-js') return { createClient: function () { return db; } };
    if (request === '../lib/telegram-verify-bot') return { createVerifyBot: function () { return verifyBot; } };
    return origLoad.apply(this, arguments);
  };
  let handler;
  try { handler = require('../api/admin-users'); } finally { Module._load = origLoad; delete require.cache[abs]; }
  return handler;
}

function adminReq(body) {
  const token = sessions.createSessionToken({ userId: 'admin-id', username: 'budi', isAdmin: true, deviceId: 'admin-device' });
  return { method: 'POST', headers: { host: 'app.test', origin: 'https://app.test', cookie: 'ac_sess=' + token }, body: body };
}

function seedVerifiedPending(db, username) {
  const user = db.seedUser({ username: username, is_approved: false, is_blocked: false });
  db.seedVerification({ user_id: user.id, telegram_user_id: 100 + db._uid, telegram_private_chat_id: 5000 + db._uid, telegram_verified_at: now() });
  return user;
}

// ===========================================================================
// Approval gate
// ===========================================================================
test('approve: an UNVERIFIED pending user cannot be approved', async function () {
  const db = makeAdminModel();
  const bot = makeFakeVerifyBot();
  const user = db.seedUser({ username: 'unveri', is_approved: false });
  db.seedVerification({ user_id: user.id, telegram_user_id: null, telegram_private_chat_id: null, telegram_verified_at: null });
  const handler = loadAdminUsers(db, bot);
  const res = makeRes();
  await handler(adminReq({ action: 'approve', username: 'unveri' }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
  assert.equal(res.body.eligibility, 'not_verified');
  assert.equal(db.getUser(user.id).is_approved, false, 'still pending');
  assert.equal(bot.calls.createChatInviteLink.length, 0, 'no invite created for unverified user');
});

test('approve: a VERIFIED pending user can be approved and the invite is created + sent', async function () {
  const db = makeAdminModel();
  const bot = makeFakeVerifyBot({ inviteLink: 'https://t.me/+forAda' });
  const user = seedVerifiedPending(db, 'ada');
  const handler = loadAdminUsers(db, bot);
  const res = makeRes();
  await handler(adminReq({ action: 'approve', username: 'ada' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.approval_transitioned, true);
  assert.equal(db.getUser(user.id).is_approved, true);
  // A single JOIN-REQUEST invite is created (NO member_limit) and DMed to the
  // bound private chat with a single request-link URL button.
  assert.equal(bot.calls.createChatInviteLink.length, 1);
  assert.ok(!('memberLimit' in bot.calls.createChatInviteLink[0].options), 'no member_limit passed');
  const dm = bot.calls.sendMessage.find(function (m) { return String(m.chatId) === String(db.verifications[user.id].telegram_private_chat_id); });
  assert.ok(dm, 'invite DM sent to the bound private chat');
  const flat = dm.options.reply_markup.inline_keyboard.flat();
  assert.equal(flat.length, 1, 'exactly one button (the request link)');
  assert.equal(flat[0].url, 'https://t.me/+forAda', 'request-link URL button');
  assert.ok(!flat.some(function (b) { return b.callback_data; }), 'no verify_channel_join callback button');
  assert.equal(res.body.invite_delivery.status, 'sent');
  assert.equal(db.verifications[user.id].invite_delivery_status, 'sent');
});

test('approve: account STAYS approved even when invite delivery fails (warning returned, retryable)', async function () {
  const db = makeAdminModel();
  const bot = makeFakeVerifyBot({ inviteThrows: true });
  const user = seedVerifiedPending(db, 'grace');
  const handler = loadAdminUsers(db, bot);
  const res = makeRes();
  await handler(adminReq({ action: 'approve', username: 'grace' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.approval_transitioned, true);
  assert.equal(db.getUser(user.id).is_approved, true, 'approval NOT rolled back on delivery failure');
  assert.notEqual(res.body.invite_delivery.status, 'sent');
  assert.equal(res.body.invite_delivery.retryable, true);
  assert.ok(res.body.warning, 'warning surfaced to the admin UI');
  assert.equal(db.verifications[user.id].invite_delivery_status, 'failed');
});

test('approve: an already-approved budi is an untouched no-op (no transition, no invite)', async function () {
  const db = makeAdminModel();
  const bot = makeFakeVerifyBot();
  db.seedUser({ username: 'budi', is_approved: true });
  const handler = loadAdminUsers(db, bot);
  const res = makeRes();
  await handler(adminReq({ action: 'approve', username: 'budi' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.approval_transitioned, false);
  assert.equal(bot.calls.createChatInviteLink.length, 0, 'no invite for an already-approved account');
});

test('approve: a still-pending reserved account is rejected by the gate', async function () {
  const db = makeAdminModel();
  const bot = makeFakeVerifyBot();
  db.seedUser({ username: 'review', is_approved: false });
  const handler = loadAdminUsers(db, bot);
  const res = makeRes();
  await handler(adminReq({ action: 'approve', username: 'review' }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(bot.calls.createChatInviteLink.length, 0);
});

test('approve: repeated approval does not re-deliver (idempotent)', async function () {
  const db = makeAdminModel();
  const bot = makeFakeVerifyBot();
  seedVerifiedPending(db, 'rex');
  const handler = loadAdminUsers(db, bot);
  let res = makeRes();
  await handler(adminReq({ action: 'approve', username: 'rex' }), res);
  assert.equal(res.body.approval_transitioned, true);
  res = makeRes();
  await handler(adminReq({ action: 'approve', username: 'rex' }), res);
  assert.equal(res.body.approval_transitioned, false);
  assert.deepEqual(res.body.approval_notification, { status: 'skipped', reason: 'no_approval_transition' });
});

test('retry_invite: a failed delivery can be retried and then succeeds', async function () {
  const db = makeAdminModel();
  const bot = makeFakeVerifyBot({ inviteThrows: true });
  const user = seedVerifiedPending(db, 'nina');
  const handler = loadAdminUsers(db, bot);
  // Approve -> invite delivery fails.
  let res = makeRes();
  await handler(adminReq({ action: 'approve', username: 'nina' }), res);
  assert.equal(db.verifications[user.id].invite_delivery_status, 'failed');
  // Fix the bot and retry.
  bot.inviteThrows = false;
  res = makeRes();
  await handler(adminReq({ action: 'retry_invite', username: 'nina' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.invite_delivery.status, 'sent');
  assert.equal(db.verifications[user.id].invite_delivery_status, 'sent');
});

// ===========================================================================
// List enrichment: telegram_status + verified/joined flags
// ===========================================================================
test('list: returns telegram_status (unverified/verified/joined) per user', async function () {
  const db = makeAdminModel();
  const bot = makeFakeVerifyBot();
  const u1 = db.seedUser({ username: 'plainpending', is_approved: false });
  const u2 = seedVerifiedPending(db, 'verifiedpending');
  const u3 = db.seedUser({ username: 'joineduser', is_approved: true });
  db.seedVerification({ user_id: u3.id, telegram_user_id: 3, telegram_private_chat_id: 30, telegram_verified_at: now(), channel_joined_at: now() });
  const handler = loadAdminUsers(db, bot);
  const res = makeRes();
  await handler(adminReq({ action: 'list' }), res);
  assert.equal(res.statusCode, 200);
  const byName = {};
  res.body.users.forEach(function (u) { byName[u.username] = u; });
  assert.equal(byName['plainpending'].telegram_status, 'unverified');
  assert.equal(byName['verifiedpending'].telegram_status, 'verified');
  assert.ok(byName['verifiedpending'].telegram_verified_at);
  assert.equal(byName['joineduser'].telegram_status, 'joined');
  void u1; void u2;
});

// ===========================================================================
// Admin User-Approval list FILTER logic (extracted from public/index.html)
// ===========================================================================
function loadAdminFilterFns() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const start = html.indexOf('function userIsPending(u)');
  const end = html.indexOf('function telegramStatusLabel(u)');
  assert.ok(start >= 0 && end > start, 'filter helper functions must exist in index.html');
  const src = html.slice(start, end);
  return vm.runInNewContext(src + '\n({ adminUserMatchesFilter: adminUserMatchesFilter, userIsPending: userIsPending, userIsVerified: userIsVerified })', {});
}

const SAMPLE_USERS = [
  { username: 'readyA', is_approved: false, is_blocked: false, telegram_verified_at: iso(now()) },
  { username: 'readyB', is_approved: false, is_blocked: false, telegram_verified_at: iso(now()), channel_joined_at: null },
  { username: 'unverifiedA', is_approved: false, is_blocked: false, telegram_verified_at: null },
  { username: 'approvedA', is_approved: true, is_blocked: false, telegram_verified_at: iso(now()) },
  { username: 'blockedA', is_approved: false, is_blocked: true, telegram_verified_at: iso(now()) }
];

test('filter: default "Siap Di-approve" (ready) = verified + pending + not blocked only', function () {
  const fns = loadAdminFilterFns();
  const ready = SAMPLE_USERS.filter(function (u) { return fns.adminUserMatchesFilter(u, 'ready'); }).map(function (u) { return u.username; });
  assert.deepEqual(ready.sort(), ['readyA', 'readyB']);
});

test('filter: "Belum Verifikasi" = pending + not blocked + not verified', function () {
  const fns = loadAdminFilterFns();
  const unverified = SAMPLE_USERS.filter(function (u) { return fns.adminUserMatchesFilter(u, 'unverified'); }).map(function (u) { return u.username; });
  assert.deepEqual(unverified, ['unverifiedA']);
});

test('filter: "Semua Pending" = every not-blocked pending account', function () {
  const fns = loadAdminFilterFns();
  const pending = SAMPLE_USERS.filter(function (u) { return fns.adminUserMatchesFilter(u, 'pending'); }).map(function (u) { return u.username; });
  assert.deepEqual(pending.sort(), ['readyA', 'readyB', 'unverifiedA']);
});

test('filter: "Blocked" = blocked accounts only', function () {
  const fns = loadAdminFilterFns();
  const blocked = SAMPLE_USERS.filter(function (u) { return fns.adminUserMatchesFilter(u, 'blocked'); }).map(function (u) { return u.username; });
  assert.deepEqual(blocked, ['blockedA']);
});
