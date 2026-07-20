'use strict';

// ===========================================================================
// Mocked tests for the Telegram JOIN-REQUEST gate (chat_join_request flow).
//
// LOCAL / MOCKED ONLY:
//  - No live Telegram: a fake verify bot records calls and returns canned
//    values (approve/decline included).
//  - No live Supabase: an in-memory model implements the RPC + table semantics
//    (base migration + approval-gate hotfix) needed by the join-request gate.
//  - No production, no network, no real secret/token is used or printed.
//
// Covers: exact-id approval, forwarded-link decline (different Telegram id),
// missing/mismatched/expired/revoked invite decline, pending/blocked decline,
// wrong-channel safe ignore, join-time set ONLY after Telegram approval, approval
// failure never marks joined, invite revoke+clear after success, duplicate
// update_id dedup, idempotent joined admin notification, and /start recovery.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

process.env.TELEGRAM_VERIFY_CODE_SECRET = 'join-gate-test-code-secret';
process.env.TELEGRAM_VERIFY_CHANNEL_ID = '-1002222222222';
process.env.TELEGRAM_VERIFY_ADMIN_CHAT_ID = '555000555';

const CHANNEL_ID = process.env.TELEGRAM_VERIFY_CHANNEL_ID;
const ADMIN_CHAT = process.env.TELEGRAM_VERIFY_ADMIN_CHAT_ID;

const tv = require('../lib/telegram-verification');

const now = () => Date.now();
const iso = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// In-memory model of the RPCs / table reads used by the join-request gate.
// ---------------------------------------------------------------------------
function makeModelDb() {
  const db = { users: [], verifications: {}, webhook: {}, _uid: 1 };

  db.seedUser = function (u) {
    const user = Object.assign({
      id: 'user-' + (db._uid++), username: 'u', is_blocked: false, is_approved: false,
      created_at: iso(now())
    }, u);
    db.users.push(user);
    return user;
  };
  db.getUser = function (id) { return db.users.find(function (x) { return x.id === id; }); };
  db.seedVerification = function (v) {
    const row = Object.assign({
      user_id: null, telegram_user_id: null, telegram_private_chat_id: null,
      telegram_verified_at: null, channel_joined_at: null,
      dynamic_invite_link: null, invite_expires_at: null, invite_revoked_at: null,
      admin_notification_status: 'pending', admin_notification_claim_token: null,
      admin_notification_claimed_at: null, admin_notification_attempts: 0,
      admin_notification_last_error: null, admin_notification_sent_at: null
    }, v);
    db.verifications[row.user_id] = row;
    return row;
  };

  function ok(data) { return Promise.resolve({ data: data, error: null }); }

  db.rpc = function (name, args) {
    switch (name) {
      case 'confirm_channel_join': {
        const v = Object.values(db.verifications).find(function (x) { return x.telegram_user_id === args.p_telegram_user_id; });
        if (!v) return ok([{ outcome: 'not_found', user_id: null, admin_notification_status: null }]);
        if (!v.telegram_verified_at) return ok([{ outcome: 'not_verified', user_id: null, admin_notification_status: null }]);
        const user = db.getUser(v.user_id);
        if (!user) return ok([{ outcome: 'not_found', user_id: null, admin_notification_status: null }]);
        if (user.is_blocked === true) return ok([{ outcome: 'blocked', user_id: null, admin_notification_status: null }]);
        if (user.is_approved !== true) return ok([{ outcome: 'pending_approval', user_id: null, admin_notification_status: null }]);
        if (v.channel_joined_at) return ok([{ outcome: 'already_joined', user_id: v.user_id, admin_notification_status: v.admin_notification_status }]);
        v.channel_joined_at = now();
        if (v.admin_notification_status !== 'sent') v.admin_notification_status = 'pending';
        return ok([{ outcome: 'joined_now', user_id: v.user_id, admin_notification_status: 'pending' }]);
      }
      case 'save_dynamic_invite_link': {
        const v = db.verifications[args.p_user_id]; if (v) { v.dynamic_invite_link = args.p_invite_link; v.invite_expires_at = args.p_expires_at; v.invite_revoked_at = null; }
        return ok(null);
      }
      case 'revoke_or_expire_dynamic_invite': {
        const v = db.verifications[args.p_user_id]; if (v) { v.invite_revoked_at = v.invite_revoked_at || now(); v.dynamic_invite_link = null; }
        return ok(null);
      }
      case 'claim_telegram_webhook_update': {
        const id = args.p_update_id;
        const lease = Math.min(Math.max(args.p_lease_seconds || 30, 10), 60) * 1000;
        let row = db.webhook[id];
        if (!row) { const tok = 'tok-' + (db._uid++); db.webhook[id] = { token: tok, lease: now() + lease, processed: null, outcome: null }; return ok([{ claim_state: 'claimed', processing_token: tok }]); }
        if (row.processed) return ok([{ claim_state: 'already_processed', processing_token: null }]);
        if (row.lease > now()) return ok([{ claim_state: 'lease_active', processing_token: null }]);
        const tok2 = 'tok-' + (db._uid++); row.token = tok2; row.lease = now() + lease;
        return ok([{ claim_state: 'reclaimed', processing_token: tok2 }]);
      }
      case 'complete_telegram_webhook_update': {
        const row = db.webhook[args.p_update_id];
        if (row && !row.processed && row.token === args.p_processing_token) { row.processed = now(); row.outcome = args.p_outcome_code; return ok(true); }
        return ok(false);
      }
      case 'claim_admin_notification': {
        const v = db.verifications[args.p_user_id];
        if (!v || !v.channel_joined_at) return ok([]);
        const claimable = (v.admin_notification_status === 'pending' || v.admin_notification_status === 'failed');
        if (!claimable) return ok([]);
        const tok = 'ntok-' + (db._uid++);
        v.admin_notification_status = 'claimed'; v.admin_notification_claim_token = tok;
        v.admin_notification_claimed_at = now(); v.admin_notification_attempts += 1;
        const user = db.getUser(v.user_id);
        return ok([{ claim_token: tok, user_id: v.user_id, event_ref: 'VF-' + v.user_id + '-' + Math.floor(v.channel_joined_at / 1000), telegram_user_id: v.telegram_user_id, username: user ? user.username : null }]);
      }
      case 'complete_admin_notification': {
        const v = db.verifications[args.p_user_id];
        if (v && v.admin_notification_claim_token === args.p_claim_token && v.admin_notification_status === 'claimed') { v.admin_notification_status = 'sent'; v.admin_notification_sent_at = now(); return ok(true); }
        return ok(false);
      }
      case 'fail_admin_notification': {
        const v = db.verifications[args.p_user_id];
        if (v && v.admin_notification_claim_token === args.p_claim_token && v.admin_notification_status === 'claimed') { v.admin_notification_status = 'failed'; v.admin_notification_last_error = String(args.p_error_code).slice(0, 120); return ok(true); }
        return ok(false);
      }
      default:
        return Promise.resolve({ data: null, error: { code: 'P0001', message: 'unknown rpc ' + name } });
    }
  };

  db.from = function (table) {
    const b = { _t: table, _filters: [] };
    b.select = function () { return b; };
    b.eq = function (c, v) { b._filters.push([c, v]); return b; };
    b.order = function () { return b; };
    b.limit = function () { return Promise.resolve({ data: rows().filter(match), error: null }); };
    function rows() {
      if (table === 'app_users') return db.users;
      if (table === 'app_user_telegram_verifications') return Object.values(db.verifications);
      return [];
    }
    function match(r) { return b._filters.every(function (f) { return r[f[0]] === f[1]; }); }
    b.maybeSingle = function () { return Promise.resolve({ data: rows().find(match) || null, error: null }); };
    return b;
  };

  return db;
}

function makeFakeBot(opts) {
  opts = opts || {};
  const calls = { sendMessage: [], editMessageText: [], answerCallbackQuery: [], getChatMember: [], createChatInviteLink: [], revokeChatInviteLink: [], approveChatJoinRequest: [], declineChatJoinRequest: [] };
  let msgId = 100;
  return {
    calls: calls,
    sendMessage: async function (chatId, text, options) { calls.sendMessage.push({ chatId, text, options }); return { message_id: ++msgId }; },
    editMessageText: async function (chatId, messageId, text, options) { calls.editMessageText.push({ chatId, messageId, text, options }); return {}; },
    answerCallbackQuery: async function (id, options) { calls.answerCallbackQuery.push({ id, options }); return {}; },
    getChatMember: async function (chatId, userId) { calls.getChatMember.push({ chatId, userId }); if (opts.memberThrows) throw new Error('api'); return opts.member || { status: 'member' }; },
    createChatInviteLink: async function (chatId, options) { calls.createChatInviteLink.push({ chatId, options }); if (opts.inviteThrows) throw new Error('api'); return opts.inviteLink || 'https://t.me/+freshLink'; },
    revokeChatInviteLink: async function (chatId, link) { calls.revokeChatInviteLink.push({ chatId, link }); return {}; },
    approveChatJoinRequest: async function (chatId, userId) { calls.approveChatJoinRequest.push({ chatId, userId }); if (opts.approveThrows) throw new Error('api'); return true; },
    declineChatJoinRequest: async function (chatId, userId) { calls.declineChatJoinRequest.push({ chatId, userId }); if (opts.declineThrows) throw new Error('api'); return true; }
  };
}

// Seed an approved+verified account holding a currently-valid stored invite link.
function seedApprovedWithInvite(db, opts) {
  opts = opts || {};
  const user = db.seedUser({ username: opts.username || 'appr', is_approved: true, is_blocked: false });
  db.seedVerification({
    user_id: user.id,
    telegram_user_id: opts.tgId,
    telegram_private_chat_id: opts.chatId != null ? opts.chatId : (opts.tgId),
    telegram_verified_at: now(),
    dynamic_invite_link: opts.link || 'https://t.me/+storedLink',
    invite_expires_at: iso(now() + 20 * 60000),
    invite_revoked_at: null
  });
  return user;
}

function joinRequest(updateId, tgId, chatId, inviteLink) {
  const cjr = { chat: { id: chatId, type: 'channel' }, from: { id: tgId, username: 'requser' } };
  if (inviteLink !== undefined) cjr.invite_link = { invite_link: inviteLink };
  return { update_id: updateId, chat_join_request: cjr };
}

// ===========================================================================
// Verify-bot payload: creates_join_request=true, no member_limit, approve/decline
// ===========================================================================
test('verify bot: createChatInviteLink sends creates_join_request=true and NO member_limit', async function () {
  const savedFetch = global.fetch;
  const savedToken = process.env.TELEGRAM_VERIFY_BOT_TOKEN;
  process.env.TELEGRAM_VERIFY_BOT_TOKEN = 'verify-token-test';
  const captured = [];
  global.fetch = async function (url, init) {
    captured.push({ url: url, body: JSON.parse(init.body) });
    return { ok: true, json: async function () { return { ok: true, result: { invite_link: 'https://t.me/+created' } }; } };
  };
  try {
    // Re-require to bind the freshly-set token/fetch (module reads env at call time).
    delete require.cache[require.resolve('../lib/telegram-verify-bot')];
    const bot = require('../lib/telegram-verify-bot');
    const link = await bot.createChatInviteLink(CHANNEL_ID, { expireSeconds: 1800, name: 'Auto-Cuan Verifikasi' });
    assert.equal(link, 'https://t.me/+created');
    const payload = captured[0].body;
    assert.equal(payload.creates_join_request, true, 'creates_join_request must be true');
    assert.ok(!('member_limit' in payload), 'member_limit must be omitted');
    assert.ok(typeof payload.name === 'string' && payload.name.length > 0 && payload.name.length <= 32, 'safe bounded name');
    assert.ok(payload.expire_date > Math.floor(Date.now() / 1000), 'expire_date ~30m in the future');
  } finally {
    global.fetch = savedFetch;
    if (savedToken === undefined) delete process.env.TELEGRAM_VERIFY_BOT_TOKEN; else process.env.TELEGRAM_VERIFY_BOT_TOKEN = savedToken;
    delete require.cache[require.resolve('../lib/telegram-verify-bot')];
  }
});

test('verify bot: approve/decline call the right Telegram methods with chat+user id', async function () {
  const savedFetch = global.fetch;
  const savedToken = process.env.TELEGRAM_VERIFY_BOT_TOKEN;
  process.env.TELEGRAM_VERIFY_BOT_TOKEN = 'verify-token-test';
  const captured = [];
  global.fetch = async function (url, init) {
    captured.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, json: async function () { return { ok: true, result: true }; } };
  };
  try {
    delete require.cache[require.resolve('../lib/telegram-verify-bot')];
    const bot = require('../lib/telegram-verify-bot');
    await bot.approveChatJoinRequest(CHANNEL_ID, 4242);
    await bot.declineChatJoinRequest(CHANNEL_ID, 4242);
    assert.ok(captured[0].url.indexOf('/approveChatJoinRequest') !== -1);
    assert.deepEqual(captured[0].body, { chat_id: CHANNEL_ID, user_id: 4242 });
    assert.ok(captured[1].url.indexOf('/declineChatJoinRequest') !== -1);
    assert.deepEqual(captured[1].body, { chat_id: CHANNEL_ID, user_id: 4242 });
  } finally {
    global.fetch = savedFetch;
    if (savedToken === undefined) delete process.env.TELEGRAM_VERIFY_BOT_TOKEN; else process.env.TELEGRAM_VERIFY_BOT_TOKEN = savedToken;
    delete require.cache[require.resolve('../lib/telegram-verify-bot')];
  }
});

// ===========================================================================
// chat_join_request — approval path
// ===========================================================================
test('join request: matching approved Telegram id with the stored valid link is APPROVED', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  const user = seedApprovedWithInvite(db, { username: 'ada', tgId: 111, chatId: 7000, link: 'https://t.me/+storedLink' });
  const res = await tv.processWebhookUpdate(joinRequest(1, 111, CHANNEL_ID, 'https://t.me/+storedLink'), { supabase: db, bot: bot });
  assert.equal(res.outcome, 'joined');
  // Approved on Telegram with the exact requester id, in the exact channel.
  assert.equal(bot.calls.approveChatJoinRequest.length, 1);
  assert.deepEqual(bot.calls.approveChatJoinRequest[0], { chatId: CHANNEL_ID, userId: 111 });
  assert.equal(bot.calls.declineChatJoinRequest.length, 0, 'not declined');
  // DB finalized, invite revoked + cleared, admin notified once, user DMed.
  assert.ok(db.verifications[user.id].channel_joined_at, 'channel_joined_at set after approval');
  assert.equal(bot.calls.revokeChatInviteLink.length, 1, 'used invite revoked');
  assert.equal(db.verifications[user.id].dynamic_invite_link, null, 'stored invite cleared');
  assert.equal(db.verifications[user.id].admin_notification_status, 'sent');
  const adminMsg = bot.calls.sendMessage.find(function (m) { return String(m.chatId) === ADMIN_CHAT; });
  assert.ok(adminMsg && adminMsg.text.indexOf('VF-' + user.id) !== -1, 'joined admin notification with deterministic event ref');
  const userMsg = bot.calls.sendMessage.find(function (m) { return String(m.chatId) === '7000'; });
  assert.ok(userMsg && userMsg.text.indexOf('Permintaan bergabung disetujui') !== -1, 'user privately confirmed');
});

test('join request: channel_joined_at is set ONLY after approveChatJoinRequest succeeds', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot({ approveThrows: true });
  const user = seedApprovedWithInvite(db, { username: 'nora', tgId: 222, chatId: 8000, link: 'https://t.me/+storedLink' });
  const res = await tv.processWebhookUpdate(joinRequest(2, 222, CHANNEL_ID, 'https://t.me/+storedLink'), { supabase: db, bot: bot });
  assert.equal(res.outcome, 'approve_failed');
  assert.equal(bot.calls.approveChatJoinRequest.length, 1);
  assert.ok(!db.verifications[user.id].channel_joined_at, 'NOT marked joined when Telegram approval fails');
  assert.equal(bot.calls.declineChatJoinRequest.length, 0, 'eligible request is never declined');
  assert.ok(db.verifications[user.id].dynamic_invite_link, 'invite NOT cleared when approval failed (recoverable)');
});

// ===========================================================================
// chat_join_request — decline / fail-closed paths
// ===========================================================================
test('join request: forwarded link used by a DIFFERENT Telegram id is DECLINED', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  // Ada is approved with a stored link; a different Telegram id (999) presents it.
  seedApprovedWithInvite(db, { username: 'ada', tgId: 111, chatId: 7000, link: 'https://t.me/+storedLink' });
  const res = await tv.processWebhookUpdate(joinRequest(3, 999, CHANNEL_ID, 'https://t.me/+storedLink'), { supabase: db, bot: bot });
  assert.equal(res.outcome, 'declined_unknown');
  assert.equal(bot.calls.approveChatJoinRequest.length, 0, 'never approved');
  assert.equal(bot.calls.declineChatJoinRequest.length, 1);
  assert.deepEqual(bot.calls.declineChatJoinRequest[0], { chatId: CHANNEL_ID, userId: 999 });
});

test('join request: MISSING invite_link is declined', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  seedApprovedWithInvite(db, { username: 'ivy', tgId: 333, chatId: 9000, link: 'https://t.me/+storedLink' });
  const res = await tv.processWebhookUpdate(joinRequest(4, 333, CHANNEL_ID, undefined), { supabase: db, bot: bot });
  assert.equal(res.outcome, 'declined_missing_link');
  assert.equal(bot.calls.declineChatJoinRequest.length, 1);
  assert.equal(bot.calls.approveChatJoinRequest.length, 0);
});

test('join request: MISMATCHED link is declined', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  seedApprovedWithInvite(db, { username: 'max', tgId: 444, chatId: 9100, link: 'https://t.me/+storedLink' });
  const res = await tv.processWebhookUpdate(joinRequest(5, 444, CHANNEL_ID, 'https://t.me/+differentLink'), { supabase: db, bot: bot });
  assert.equal(res.outcome, 'declined_link_mismatch');
  assert.equal(bot.calls.declineChatJoinRequest.length, 1);
});

test('join request: EXPIRED invite is declined', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  const user = db.seedUser({ username: 'exp', is_approved: true, is_blocked: false });
  db.seedVerification({ user_id: user.id, telegram_user_id: 555, telegram_private_chat_id: 9200, telegram_verified_at: now(), dynamic_invite_link: 'https://t.me/+storedLink', invite_expires_at: iso(now() - 1000), invite_revoked_at: null });
  const res = await tv.processWebhookUpdate(joinRequest(6, 555, CHANNEL_ID, 'https://t.me/+storedLink'), { supabase: db, bot: bot });
  assert.equal(res.outcome, 'declined_expired');
  assert.equal(bot.calls.declineChatJoinRequest.length, 1);
});

test('join request: REVOKED invite is declined', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  const user = db.seedUser({ username: 'rev', is_approved: true, is_blocked: false });
  db.seedVerification({ user_id: user.id, telegram_user_id: 666, telegram_private_chat_id: 9300, telegram_verified_at: now(), dynamic_invite_link: 'https://t.me/+storedLink', invite_expires_at: iso(now() + 60000), invite_revoked_at: iso(now() - 1000) });
  const res = await tv.processWebhookUpdate(joinRequest(7, 666, CHANNEL_ID, 'https://t.me/+storedLink'), { supabase: db, bot: bot });
  assert.equal(res.outcome, 'declined_revoked');
  assert.equal(bot.calls.declineChatJoinRequest.length, 1);
});

test('join request: PENDING (unapproved) account is declined', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  const user = db.seedUser({ username: 'pend', is_approved: false, is_blocked: false });
  db.seedVerification({ user_id: user.id, telegram_user_id: 777, telegram_private_chat_id: 9400, telegram_verified_at: now(), dynamic_invite_link: 'https://t.me/+storedLink', invite_expires_at: iso(now() + 60000) });
  const res = await tv.processWebhookUpdate(joinRequest(8, 777, CHANNEL_ID, 'https://t.me/+storedLink'), { supabase: db, bot: bot });
  assert.equal(res.outcome, 'declined_pending');
  assert.equal(bot.calls.declineChatJoinRequest.length, 1);
  assert.equal(bot.calls.approveChatJoinRequest.length, 0);
  // Neutral message only (never reveals a username exists).
  const dm = bot.calls.sendMessage.find(function (m) { return String(m.chatId) === '9400'; });
  assert.ok(dm && dm.text.indexOf('tidak dapat disetujui') !== -1);
  assert.ok(dm.text.indexOf(user.username) === -1, 'no username disclosed');
});

test('join request: BLOCKED account is declined', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  const user = db.seedUser({ username: 'blk', is_approved: true, is_blocked: true });
  db.seedVerification({ user_id: user.id, telegram_user_id: 888, telegram_private_chat_id: 9500, telegram_verified_at: now(), dynamic_invite_link: 'https://t.me/+storedLink', invite_expires_at: iso(now() + 60000) });
  const res = await tv.processWebhookUpdate(joinRequest(9, 888, CHANNEL_ID, 'https://t.me/+storedLink'), { supabase: db, bot: bot });
  assert.equal(res.outcome, 'declined_blocked');
  assert.equal(bot.calls.declineChatJoinRequest.length, 1);
});

test('join request: unbound Telegram id (no verification row) is declined', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  const res = await tv.processWebhookUpdate(joinRequest(10, 12345, CHANNEL_ID, 'https://t.me/+whatever'), { supabase: db, bot: bot });
  assert.equal(res.outcome, 'declined_unknown');
  assert.equal(bot.calls.declineChatJoinRequest.length, 1);
  // No safe private chat known -> no neutral message sent.
  assert.equal(bot.calls.sendMessage.length, 0);
});

test('join request: WRONG channel id is safely ignored (no approve, no decline)', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  seedApprovedWithInvite(db, { username: 'ada', tgId: 111, chatId: 7000, link: 'https://t.me/+storedLink' });
  const res = await tv.processWebhookUpdate(joinRequest(11, 111, '-1009999999999', 'https://t.me/+storedLink'), { supabase: db, bot: bot });
  assert.equal(res.outcome, 'ignored_wrong_channel');
  assert.equal(bot.calls.approveChatJoinRequest.length, 0);
  assert.equal(bot.calls.declineChatJoinRequest.length, 0);
});

// ===========================================================================
// Dedup + idempotency
// ===========================================================================
test('join request: duplicate update_id is not processed twice', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  seedApprovedWithInvite(db, { username: 'dup', tgId: 111, chatId: 7000, link: 'https://t.me/+storedLink' });
  db.webhook[42] = { token: 't', lease: now() - 1000, processed: now(), outcome: 'joined' };
  const res = await tv.processWebhookUpdate(joinRequest(42, 111, CHANNEL_ID, 'https://t.me/+storedLink'), { supabase: db, bot: bot });
  assert.equal(res.outcome, 'duplicate');
  assert.equal(bot.calls.approveChatJoinRequest.length, 0, 'no processing on a duplicate');
  assert.equal(bot.calls.declineChatJoinRequest.length, 0);
});

test('join request: joined admin notification is idempotent (never sent twice)', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  const user = db.seedUser({ username: 'idem', is_approved: true, is_blocked: false });
  db.seedVerification({ user_id: user.id, telegram_user_id: 111, telegram_verified_at: now(), channel_joined_at: now() });
  await tv.notifyAdminBestEffort({ supabase: db, bot: bot }, user.id, { id: 111, username: 'idemtg' });
  const c1 = bot.calls.sendMessage.filter(function (m) { return String(m.chatId) === ADMIN_CHAT; }).length;
  await tv.notifyAdminBestEffort({ supabase: db, bot: bot }, user.id, { id: 111, username: 'idemtg' });
  const c2 = bot.calls.sendMessage.filter(function (m) { return String(m.chatId) === ADMIN_CHAT; }).length;
  assert.equal(c1, 1);
  assert.equal(c2, 1, 'no duplicate joined admin notification');
});

// ===========================================================================
// /start recovery
// ===========================================================================
test('/start recovery: approved & not-joined gets a fresh join-request link', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot({ member: { status: 'left' }, inviteLink: 'https://t.me/+recoverLink' });
  const user = db.seedUser({ username: 'rec', is_approved: true, is_blocked: false });
  db.seedVerification({ user_id: user.id, telegram_user_id: 111, telegram_private_chat_id: 111, telegram_verified_at: now() });
  const res = await tv.processWebhookUpdate({ update_id: 50, message: { chat: { id: 111, type: 'private' }, from: { id: 111 }, text: '/start' } }, { supabase: db, bot: bot });
  assert.equal(res.outcome, 'start_invite');
  assert.equal(bot.calls.createChatInviteLink.length, 1, 'a fresh join-request invite is minted');
  const msg = bot.calls.sendMessage[bot.calls.sendMessage.length - 1];
  assert.ok(msg.text.indexOf('telah disetujui') !== -1);
  const flat = msg.options.reply_markup.inline_keyboard.flat();
  assert.equal(flat.length, 1);
  assert.equal(flat[0].url, 'https://t.me/+recoverLink');
  assert.ok(!flat[0].callback_data);
});

test('/start recovery: already-joined account is told access is complete', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  const user = db.seedUser({ username: 'done', is_approved: true, is_blocked: false });
  db.seedVerification({ user_id: user.id, telegram_user_id: 222, telegram_private_chat_id: 222, telegram_verified_at: now(), channel_joined_at: now() });
  const res = await tv.processWebhookUpdate({ update_id: 51, message: { chat: { id: 222, type: 'private' }, from: { id: 222 }, text: '/start' } }, { supabase: db, bot: bot });
  assert.equal(res.outcome, 'start_joined');
  assert.equal(bot.calls.getChatMember.length, 0, 'no reconciliation needed');
  const msg = bot.calls.sendMessage[bot.calls.sendMessage.length - 1];
  assert.equal(msg.text, tv.MSG.alreadyJoined);
});

test('/start recovery: Telegram approved but DB not finalized -> reconciled once (no double notify)', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot({ member: { status: 'member' } });
  const user = db.seedUser({ username: 'reconcile', is_approved: true, is_blocked: false });
  db.seedVerification({ user_id: user.id, telegram_user_id: 333, telegram_private_chat_id: 333, telegram_verified_at: now(), dynamic_invite_link: 'https://t.me/+stale', invite_expires_at: iso(now() + 60000) });
  const res = await tv.processWebhookUpdate({ update_id: 52, message: { chat: { id: 333, type: 'private' }, from: { id: 333 }, text: '/start' } }, { supabase: db, bot: bot });
  assert.equal(res.outcome, 'start_reconciled');
  assert.ok(db.verifications[user.id].channel_joined_at, 'finalized on reconciliation');
  assert.equal(db.verifications[user.id].admin_notification_status, 'sent');
  assert.equal(bot.calls.revokeChatInviteLink.length, 1, 'stale invite revoked');
  const adminCount1 = bot.calls.sendMessage.filter(function (m) { return String(m.chatId) === ADMIN_CHAT; }).length;

  // A second /start must not approve/notify again.
  const res2 = await tv.processWebhookUpdate({ update_id: 53, message: { chat: { id: 333, type: 'private' }, from: { id: 333 }, text: '/start' } }, { supabase: db, bot: bot });
  assert.equal(res2.outcome, 'start_joined');
  const adminCount2 = bot.calls.sendMessage.filter(function (m) { return String(m.chatId) === ADMIN_CHAT; }).length;
  assert.equal(adminCount2, adminCount1, 'no duplicate joined notification');
});

// ===========================================================================
// Static-fallback / hygiene
// ===========================================================================
test('hygiene: no static channel invite URL is ever read by the join-request flow', function () {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'telegram-verification.js'), 'utf8');
  assert.equal(src.indexOf('TELEGRAM_VERIFY_CHANNEL_INVITE_URL') !== -1, false);
});
