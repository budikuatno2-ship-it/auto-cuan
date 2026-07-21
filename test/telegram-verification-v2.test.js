'use strict';

// ===========================================================================
// Mocked tests for Telegram verification v2 — APPROVAL-GATED flow.
//
// LOCAL / MOCKED ONLY:
//  - No live Telegram call: a fake bot object records calls and returns canned
//    values.
//  - No live Supabase: an in-memory model implements the RPC semantics of the
//    base migration + approval-gate hotfix closely enough to assert behavior.
//    For endpoint tests, @supabase/supabase-js is stubbed via Module._load (it
//    is not installed in this sandbox).
//  - No production, no network, no real secret/token is used or printed.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const CODE_SECRET = 'unit-test-code-secret-value';
const WEBHOOK_SECRET = 'unit-test-webhook-secret-value';

process.env.TELEGRAM_VERIFY_CODE_SECRET = CODE_SECRET;
process.env.TELEGRAM_VERIFY_CHANNEL_ID = '-1000000000001';
process.env.TELEGRAM_VERIFY_ADMIN_CHAT_ID = '900900900';
process.env.TELEGRAM_VERIFY_CHANNEL_INVITE_URL = 'https://t.me/+staticFallbackInvite';

const tv = require('../lib/telegram-verification');

const now = () => Date.now();
const iso = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// In-memory model of the SQL RPCs (base migration + approval-gate hotfix)
// ---------------------------------------------------------------------------
function makeModelDb() {
  const db = {
    users: [],
    challenges: [],
    verifications: {},
    webhook: {},
    senders: {},
    _failActiveHashTimes: 0,
    _uid: 1
  };

  db.seedUser = function (u) {
    const user = Object.assign({
      id: 'user-' + (db._uid++), username: 'u', password_hash: 'ph',
      device_id: 'd', devices: ['d'], is_blocked: false, is_approved: false,
      created_at: iso(now())
    }, u);
    db.users.push(user);
    return user;
  };
  db.getUser = function (id) { return db.users.find(function (x) { return x.id === id; }); };
  db.seedChallenge = function (c) {
    const ch = Object.assign({
      id: 'ch-' + (db._uid++), user_id: null, hash: null,
      expires: now() + 15 * 60000, used: null, revoked: null, failed: 0, locked: null
    }, c);
    db.challenges.push(ch);
    return ch;
  };
  db.seedVerification = function (v) {
    const row = Object.assign({
      user_id: null, telegram_user_id: null, telegram_private_chat_id: null,
      telegram_verified_at: null, channel_joined_at: null,
      dynamic_invite_link: null, invite_expires_at: null, invite_revoked_at: null,
      // Stage 4 (joined) outbox
      admin_notification_status: 'pending', admin_notification_claim_token: null,
      admin_notification_claimed_at: null, admin_notification_attempts: 0,
      admin_notification_last_error: null, admin_notification_sent_at: null,
      // Stage 2 (verified) outbox
      verify_notification_status: 'pending', verify_notification_claim_token: null,
      verify_notification_claimed_at: null, verify_notification_attempts: 0,
      verify_notification_last_error: null, verify_notification_sent_at: null,
      // Stage 3 (invite delivery) outbox
      invite_delivery_status: 'pending', invite_delivery_claim_token: null,
      invite_delivery_claimed_at: null, invite_delivery_attempts: 0,
      invite_delivery_last_error: null, invite_delivery_sent_at: null
    }, v);
    db.verifications[row.user_id] = row;
    return row;
  };

  function ok(data) { return Promise.resolve({ data: data, error: null }); }
  function pgErr(code, message) { return Promise.resolve({ data: null, error: { code: code, message: message } }); }

  function reserved(name) { return name === 'budi' || name === 'review'; }
  function activeChallengeByHash(hash) {
    return db.challenges.find(function (c) { return c.hash === hash && !c.used && !c.revoked; });
  }

  db.rpc = function (name, args) {
    switch (name) {
      case 'register_pending_user_with_telegram_challenge': {
        if (db._failActiveHashTimes > 0) { db._failActiveHashTimes--; return pgErr('23505', 'duplicate key value violates unique constraint "uq_autc_active_hash"'); }
        if (db.users.find(function (u) { return u.username === args.p_username; })) {
          return pgErr('23505', 'duplicate key value violates unique constraint "app_users_username_key"');
        }
        const user = db.seedUser({ username: args.p_username, password_hash: args.p_password_hash, device_id: args.p_device_id, devices: [args.p_device_id] });
        const ch = db.seedChallenge({ user_id: user.id, hash: args.p_code_hash, expires: Date.parse(args.p_expires_at) });
        return ok([{ id: user.id, username: user.username, created_at: user.created_at, challenge_id: ch.id }]);
      }
      case 'issue_telegram_challenge': {
        if (db._failActiveHashTimes > 0) { db._failActiveHashTimes--; return pgErr('23505', 'duplicate key value violates unique constraint "uq_autc_active_hash"'); }
        const user = db.getUser(args.p_user_id);
        if (!user || user.is_approved !== false || user.is_blocked !== false || reserved(user.username)) return ok([]);
        db.challenges.forEach(function (c) { if (c.user_id === user.id && !c.used && !c.revoked) c.revoked = now(); });
        const ch = db.seedChallenge({ user_id: user.id, hash: args.p_code_hash, expires: Date.parse(args.p_expires_at) });
        return ok([{ challenge_id: ch.id, expires_at: args.p_expires_at }]);
      }
      case 'check_telegram_sender_limit': {
        const s = db.senders[args.p_telegram_user_id];
        const locked = !!(s && s.locked && s.locked > now());
        return ok([{ locked: locked, locked_until: s ? (s.locked ? iso(s.locked) : null) : null }]);
      }
      case 'record_invalid_telegram_attempt': {
        const id = args.p_telegram_user_id;
        let s = db.senders[id];
        if (!s) { s = db.senders[id] = { failed: 0, window: now(), locked: null }; }
        if (s.window < now() - args.p_window_seconds * 1000) { s.failed = 0; s.window = now(); }
        s.failed += 1;
        if (s.failed >= args.p_max_attempts) s.locked = now() + args.p_lock_seconds * 1000;
        return ok([{ locked: !!(s.locked && s.locked > now()), locked_until: s.locked ? iso(s.locked) : null }]);
      }
      case 'clear_telegram_sender_limit': {
        delete db.senders[args.p_telegram_user_id];
        return ok(null);
      }
      case 'consume_challenge_and_bind_telegram': {
        const ch = activeChallengeByHash(args.p_code_hash);
        if (!ch) return ok([{ result_code: 'not_found', user_id: null, username: null }]);
        if (ch.locked && ch.locked > now()) return ok([{ result_code: 'locked', user_id: null, username: null }]);
        if (ch.expires <= now()) return ok([{ result_code: 'expired', user_id: null, username: null }]);
        const user = db.getUser(ch.user_id);
        if (!user || user.is_approved !== false || user.is_blocked !== false || reserved(user.username)) {
          return ok([{ result_code: 'not_found', user_id: null, username: null }]);
        }
        const other = Object.values(db.verifications).find(function (v) { return v.telegram_user_id === args.p_telegram_user_id && v.user_id !== ch.user_id; });
        if (other) { ch.failed += 1; if (ch.failed >= 5) ch.locked = now() + 15 * 60000; return ok([{ result_code: 'telegram_used_elsewhere', user_id: null, username: null }]); }
        let v = db.verifications[ch.user_id];
        if (v && v.telegram_user_id != null && v.telegram_user_id !== args.p_telegram_user_id) {
          ch.failed += 1; if (ch.failed >= 5) ch.locked = now() + 15 * 60000;
          return ok([{ result_code: 'bound_other_telegram', user_id: null, username: null }]);
        }
        if (!v) v = db.seedVerification({ user_id: ch.user_id });
        v.telegram_user_id = args.p_telegram_user_id;
        v.telegram_private_chat_id = args.p_private_chat_id;
        if (!v.telegram_verified_at) v.telegram_verified_at = now();
        ch.used = now();
        return ok([{ result_code: 'ok', user_id: user.id, username: user.username }]);
      }
      case 'confirm_channel_join': {
        // Approval-gate hotfix: REQUIRES an approved, not-blocked account.
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
      // --- Stage 4 (joined) admin notification outbox ---
      case 'claim_admin_notification': {
        const v = db.verifications[args.p_user_id];
        const lease = Math.min(Math.max(args.p_lease_seconds || 120, 30), 300) * 1000;
        if (!v || !v.channel_joined_at) return ok([]);
        const claimable = (v.admin_notification_status === 'pending' || v.admin_notification_status === 'failed' ||
          (v.admin_notification_status === 'claimed' && v.admin_notification_claimed_at && v.admin_notification_claimed_at < now() - lease));
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
      // --- Stage 2 (verified) admin notification outbox ---
      case 'claim_verify_notification': {
        const v = db.verifications[args.p_user_id];
        const lease = Math.min(Math.max(args.p_lease_seconds || 120, 30), 300) * 1000;
        if (!v || !v.telegram_verified_at) return ok([]);
        const claimable = (v.verify_notification_status === 'pending' || v.verify_notification_status === 'failed' ||
          (v.verify_notification_status === 'claimed' && v.verify_notification_claimed_at && v.verify_notification_claimed_at < now() - lease));
        if (!claimable) return ok([]);
        const tok = 'vntok-' + (db._uid++);
        v.verify_notification_status = 'claimed'; v.verify_notification_claim_token = tok;
        v.verify_notification_claimed_at = now(); v.verify_notification_attempts += 1;
        const user = db.getUser(v.user_id);
        return ok([{ claim_token: tok, out_user_id: v.user_id, event_ref: 'VN-' + v.user_id + '-' + Math.floor(v.telegram_verified_at / 1000), telegram_user_id: v.telegram_user_id, telegram_private_chat_id: v.telegram_private_chat_id, username: user ? user.username : null }]);
      }
      case 'complete_verify_notification': {
        const v = db.verifications[args.p_user_id];
        if (v && v.verify_notification_claim_token === args.p_claim_token && v.verify_notification_status === 'claimed') { v.verify_notification_status = 'sent'; v.verify_notification_sent_at = now(); return ok(true); }
        return ok(false);
      }
      case 'fail_verify_notification': {
        const v = db.verifications[args.p_user_id];
        if (v && v.verify_notification_claim_token === args.p_claim_token && v.verify_notification_status === 'claimed') { v.verify_notification_status = 'failed'; v.verify_notification_last_error = String(args.p_error_code).slice(0, 120); return ok(true); }
        return ok(false);
      }
      // --- Stage 3 (invite delivery) outbox ---
      case 'claim_invite_delivery': {
        const v = db.verifications[args.p_user_id];
        const lease = Math.min(Math.max(args.p_lease_seconds || 120, 30), 300) * 1000;
        if (!v || !v.telegram_verified_at || v.telegram_private_chat_id == null) return ok([]);
        const user = db.getUser(v.user_id);
        if (!user || user.is_approved !== true || user.is_blocked !== false) return ok([]);
        const claimable = (v.invite_delivery_status === 'pending' || v.invite_delivery_status === 'failed' ||
          (v.invite_delivery_status === 'claimed' && v.invite_delivery_claimed_at && v.invite_delivery_claimed_at < now() - lease));
        if (!claimable) return ok([]);
        const tok = 'idtok-' + (db._uid++);
        v.invite_delivery_status = 'claimed'; v.invite_delivery_claim_token = tok;
        v.invite_delivery_claimed_at = now(); v.invite_delivery_attempts += 1;
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
        const v = db.verifications[args.p_user_id]; if (v) { v.dynamic_invite_link = args.p_invite_link; v.invite_expires_at = args.p_expires_at; v.invite_revoked_at = null; }
        return ok(null);
      }
      case 'revoke_or_expire_dynamic_invite': {
        const v = db.verifications[args.p_user_id]; if (v) { v.invite_revoked_at = v.invite_revoked_at || now(); v.dynamic_invite_link = null; }
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
        return pgErr('P0001', 'unknown rpc ' + name);
    }
  };

  // Minimal PostgREST-like query builder for the few direct table reads/writes.
  db.from = function (table) {
    const b = { _table: table, _op: 'select', _filters: [], _payload: null };
    b.select = function () { b._op = b._op === 'select' ? 'select' : b._op; return b; };
    b.insert = function (p) { b._op = 'insert'; b._payload = p; return b; };
    b.update = function (p) { b._op = 'update'; b._payload = p; return b; };
    b.eq = function (col, val) { b._filters.push([col, val]); return b; };
    b.order = function () { return b; };
    b.limit = function () { return Promise.resolve({ data: rows().filter(match), error: null }); };
    function rows() {
      if (table === 'app_users') return db.users;
      if (table === 'app_user_telegram_verifications') return Object.values(db.verifications);
      return [];
    }
    function match(r) { return b._filters.every(function (f) { return r[f[0]] === f[1]; }); }
    b.maybeSingle = function () {
      const found = rows().find(match) || null;
      return Promise.resolve({ data: found, error: null });
    };
    b.then = function (resolve) {
      if (b._op === 'update') { rows().filter(match).forEach(function (r) { Object.assign(r, b._payload); }); return resolve({ data: null, error: null }); }
      if (b._op === 'insert') { return resolve({ data: b._payload, error: null }); }
      return resolve({ data: rows().filter(match), error: null });
    };
    return b;
  };

  return db;
}

// ---------------------------------------------------------------------------
// Fake verify bot (records calls; no network)
// ---------------------------------------------------------------------------
function makeFakeBot(opts) {
  opts = opts || {};
  const calls = { sendMessage: [], editMessageText: [], editMessageReplyMarkup: [], answerCallbackQuery: [], getChatMember: [], createChatInviteLink: [], revokeChatInviteLink: [], approveChatJoinRequest: [], declineChatJoinRequest: [] };
  let msgId = 100;
  return {
    calls: calls,
    sendMessage: async function (chatId, text, options) { calls.sendMessage.push({ chatId, text, options }); return { message_id: ++msgId }; },
    editMessageText: async function (chatId, messageId, text, options) { calls.editMessageText.push({ chatId, messageId, text, options }); if (opts.editThrows) throw new Error('api'); return {}; },
    editMessageReplyMarkup: async function (chatId, messageId) { calls.editMessageReplyMarkup.push({ chatId, messageId }); return {}; },
    answerCallbackQuery: async function (id, options) { calls.answerCallbackQuery.push({ id, options }); return {}; },
    getChatMember: async function (chatId, userId) { calls.getChatMember.push({ chatId, userId }); if (opts.memberThrows) throw new Error('api'); return opts.member || { status: 'member' }; },
    createChatInviteLink: async function (chatId, options) { calls.createChatInviteLink.push({ chatId, options }); if (opts.inviteThrows) throw new Error('api'); return opts.inviteLink || 'https://t.me/+dynamicPerUser'; },
    revokeChatInviteLink: async function (chatId, link) { calls.revokeChatInviteLink.push({ chatId, link }); return {}; },
    approveChatJoinRequest: async function (chatId, userId) { calls.approveChatJoinRequest.push({ chatId, userId }); if (opts.approveThrows) throw new Error('api'); return true; },
    declineChatJoinRequest: async function (chatId, userId) { calls.declineChatJoinRequest.push({ chatId, userId }); if (opts.declineThrows) throw new Error('api'); return true; }
  };
}

// ===========================================================================
// 1. Code generation / normalization / HMAC
// ===========================================================================
test('code: generated code is 8 chars from the unambiguous alphabet', function () {
  for (let i = 0; i < 200; i++) {
    const c = tv.generateRawCode();
    assert.equal(c.length, 8);
    for (const ch of c) assert.ok(tv.CODE_ALPHABET.indexOf(ch) !== -1, 'char in alphabet: ' + ch);
    assert.ok(!/[O0I1]/.test(c), 'no ambiguous chars');
  }
});

test('code: display format is XXXX-XXXX', function () {
  assert.equal(tv.formatCodeForDisplay('ABCD2345'), 'ABCD-2345');
});

test('code: normalization strips separators/whitespace and uppercases', function () {
  assert.equal(tv.normalizeCode('abcd-2345'), 'ABCD2345');
  assert.equal(tv.normalizeCode(' a b c d 2 3 4 5 '), 'ABCD2345');
  assert.equal(tv.normalizeCode('abcd2345'), 'ABCD2345');
  assert.equal(tv.normalizeCode('short'), null);
  assert.equal(tv.normalizeCode('ABCD234O'), null, 'O is not in alphabet');
});

test('hmac: deterministic and depends on secret; hides the raw code', function () {
  const h1 = tv.computeCodeHash('ABCD2345');
  const h2 = tv.computeCodeHash('abcd-2345');
  assert.equal(h1, h2, 'normalized inputs hash equally');
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.ok(h1.indexOf('ABCD2345') === -1);
});

test('hmac: missing code secret fails closed (null)', function () {
  const saved = process.env.TELEGRAM_VERIFY_CODE_SECRET;
  delete process.env.TELEGRAM_VERIFY_CODE_SECRET;
  try {
    assert.equal(tv.hasCodeSecret(), false);
    assert.equal(tv.computeCodeHash('ABCD2345'), null);
  } finally { process.env.TELEGRAM_VERIFY_CODE_SECRET = saved; }
});

// ===========================================================================
// 2. Username masking
// ===========================================================================
test('mask: username masking keeps ends, hides middle', function () {
  assert.equal(tv.maskUsername('budi'), 'bu*i');
  assert.equal(tv.maskUsername('ab'), 'a*');
  assert.equal(tv.maskUsername('a'), '*');
});

// ===========================================================================
// 3. Membership classifier
// ===========================================================================
test('membership: accepts joined states, rejects others', function () {
  assert.equal(tv.classifyMembership({ status: 'creator' }), true);
  assert.equal(tv.classifyMembership({ status: 'administrator' }), true);
  assert.equal(tv.classifyMembership({ status: 'member' }), true);
  assert.equal(tv.classifyMembership({ status: 'restricted', is_member: true }), true);
  assert.equal(tv.classifyMembership({ status: 'restricted', is_member: false }), false);
  assert.equal(tv.classifyMembership({ status: 'left' }), false);
  assert.equal(tv.classifyMembership({ status: 'kicked' }), false);
  assert.equal(tv.classifyMembership(null), false);
});

// ===========================================================================
// 4. Registration RPC orchestration
// ===========================================================================
test('register: returns v2 fields and never a channel URL; passes only HMAC to SQL', async function () {
  const db = makeModelDb();
  let captured = null;
  const origRpc = db.rpc;
  db.rpc = function (name, args) { if (name === 'register_pending_user_with_telegram_challenge') captured = args; return origRpc(name, args); };

  const reg = await tv.registerPendingUser(db, { username: 'alice', passwordHash: 'ph', deviceId: 'dev1', userAgent: 'UA' });
  assert.ok(reg.id);
  assert.match(reg.displayCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.ok(reg.rawCode && reg.rawCode.length === 8);
  assert.match(captured.p_code_hash, /^[0-9a-f]{64}$/);
  assert.ok(captured.p_code_hash.indexOf(reg.rawCode) === -1);
});

test('register: retries on active-hash collision then succeeds', async function () {
  const db = makeModelDb();
  db._failActiveHashTimes = 2;
  const reg = await tv.registerPendingUser(db, { username: 'bob', passwordHash: 'ph', deviceId: 'dev2', userAgent: '' });
  assert.ok(reg.id, 'succeeds after bounded retries');
});

test('register: duplicate username surfaces 23505 to caller', async function () {
  const db = makeModelDb();
  db.seedUser({ username: 'carol' });
  await assert.rejects(
    tv.registerPendingUser(db, { username: 'carol', passwordHash: 'ph', deviceId: 'd', userAgent: '' }),
    function (e) { return e.pgcode === '23505'; }
  );
});

test('register: fails closed when code secret is missing', async function () {
  const db = makeModelDb();
  const saved = process.env.TELEGRAM_VERIFY_CODE_SECRET;
  delete process.env.TELEGRAM_VERIFY_CODE_SECRET;
  try {
    await assert.rejects(tv.registerPendingUser(db, { username: 'z', passwordHash: 'p', deviceId: 'd', userAgent: '' }),
      function (e) { return e.failClosed === true; });
  } finally { process.env.TELEGRAM_VERIFY_CODE_SECRET = saved; }
});

// ===========================================================================
// 5. Challenge issuance / rotation
// ===========================================================================
test('issue: rotates code and revokes previous active challenge', async function () {
  const db = makeModelDb();
  const user = db.seedUser({ username: 'dave' });
  const first = await tv.issueChallengeForUser(db, user.id);
  const second = await tv.issueChallengeForUser(db, user.id);
  assert.notEqual(first.challengeId, second.challengeId);
  const actives = db.challenges.filter(function (c) { return c.user_id === user.id && !c.used && !c.revoked; });
  assert.equal(actives.length, 1, 'only one active challenge remains');
});

test('issue: returns null for ineligible (approved) user', async function () {
  const db = makeModelDb();
  const user = db.seedUser({ username: 'eve', is_approved: true });
  const res = await tv.issueChallengeForUser(db, user.id);
  assert.equal(res, null);
});

// ===========================================================================
// 6. Consume + binding
// ===========================================================================
async function seedPendingWithCode(db, username, tgBound) {
  const user = db.seedUser({ username: username });
  const raw = tv.generateRawCode();
  db.seedChallenge({ user_id: user.id, hash: tv.computeCodeHash(raw) });
  if (tgBound != null) db.seedVerification({ user_id: user.id, telegram_user_id: tgBound, telegram_verified_at: now() });
  return { user, raw };
}

test('consume: valid active code binds telegram identity', async function () {
  const db = makeModelDb();
  const { user, raw } = await seedPendingWithCode(db, 'frank');
  const r = await tv.consumeAndBind(db, tv.computeCodeHash(raw), 555, 777);
  assert.equal(r.resultCode, 'ok');
  assert.equal(r.userId, user.id);
  assert.equal(db.verifications[user.id].telegram_user_id, 555);
});

test('consume: expired / revoked / used codes are not usable', async function () {
  const db = makeModelDb();
  const u1 = db.seedUser({ username: 'g1' });
  const expiredRaw = tv.generateRawCode();
  db.seedChallenge({ user_id: u1.id, hash: tv.computeCodeHash(expiredRaw), expires: now() - 1000 });
  assert.equal((await tv.consumeAndBind(db, tv.computeCodeHash(expiredRaw), 1, 1)).resultCode, 'expired');

  const u2 = db.seedUser({ username: 'g2' });
  const revokedRaw = tv.generateRawCode();
  db.seedChallenge({ user_id: u2.id, hash: tv.computeCodeHash(revokedRaw), revoked: now() });
  assert.equal((await tv.consumeAndBind(db, tv.computeCodeHash(revokedRaw), 2, 2)).resultCode, 'not_found');

  const u3 = db.seedUser({ username: 'g3' });
  const usedRaw = tv.generateRawCode();
  db.seedChallenge({ user_id: u3.id, hash: tv.computeCodeHash(usedRaw), used: now() });
  assert.equal((await tv.consumeAndBind(db, tv.computeCodeHash(usedRaw), 3, 3)).resultCode, 'not_found');
});

test('consume: account approved/blocked after issuance stops the code', async function () {
  const db = makeModelDb();
  const { user, raw } = await seedPendingWithCode(db, 'harry');
  user.is_approved = true;
  assert.equal((await tv.consumeAndBind(db, tv.computeCodeHash(raw), 9, 9)).resultCode, 'not_found');
});

test('consume: one telegram id cannot claim two web accounts', async function () {
  const db = makeModelDb();
  await seedPendingWithCode(db, 'accountA', 42);
  const b = await seedPendingWithCode(db, 'accountB');
  const r = await tv.consumeAndBind(db, tv.computeCodeHash(b.raw), 42, 100);
  assert.equal(r.resultCode, 'telegram_used_elsewhere');
});

test('consume: one web account cannot bind two telegram ids', async function () {
  const db = makeModelDb();
  const user = db.seedUser({ username: 'iris' });
  db.seedVerification({ user_id: user.id, telegram_user_id: 71, telegram_verified_at: now() });
  const raw = tv.generateRawCode();
  db.seedChallenge({ user_id: user.id, hash: tv.computeCodeHash(raw) });
  const r = await tv.consumeAndBind(db, tv.computeCodeHash(raw), 72, 100);
  assert.equal(r.resultCode, 'bound_other_telegram');
});

// ===========================================================================
// 7. Sender rate limit
// ===========================================================================
test('sender limit: locks after threshold, check reflects it, clear resets', async function () {
  const db = makeModelDb();
  const tgId = 321;
  let res;
  for (let i = 0; i < tv.SENDER_MAX_ATTEMPTS; i++) res = await tv.recordInvalidAttempt(db, tgId);
  assert.equal(res.locked, true);
  assert.equal((await tv.checkSenderLimit(db, tgId)).locked, true);
  await tv.clearSenderLimit(db, tgId);
  assert.equal((await tv.checkSenderLimit(db, tgId)).locked, false);
});

// ===========================================================================
// 8. Webhook claim / reclaim / token ownership
// ===========================================================================
test('webhook: claim, duplicate, lease, reclaim, and stale-token completion', async function () {
  const db = makeModelDb();
  const first = await tv.claimWebhookUpdate(db, 5001);
  assert.equal(first.claimState, 'claimed');
  const dup = await tv.claimWebhookUpdate(db, 5001);
  assert.equal(dup.claimState, 'lease_active');
  assert.equal(await db.rpc('complete_telegram_webhook_update', { p_update_id: 5001, p_processing_token: 'wrong', p_outcome_code: 'x' }).then(function (r) { return r.data; }), false);
  assert.equal(await tv.completeWebhookUpdate(db, 5001, first.processingToken, 'verified'), true);
  assert.equal((await tv.claimWebhookUpdate(db, 5001)).claimState, 'already_processed');
});

test('webhook: expired lease is reclaimable; the old token can no longer complete', async function () {
  const db = makeModelDb();
  const c = await tv.claimWebhookUpdate(db, 6001);
  db.webhook[6001].lease = now() - 1000;
  const re = await tv.claimWebhookUpdate(db, 6001);
  assert.equal(re.claimState, 'reclaimed');
  assert.notEqual(re.processingToken, c.processingToken);
  assert.equal(await tv.completeWebhookUpdate(db, 6001, c.processingToken, 'x'), false, 'stale token rejected');
  assert.equal(await tv.completeWebhookUpdate(db, 6001, re.processingToken, 'ok'), true);
});

// ===========================================================================
// 9. processWebhookUpdate — Stage 2 message flow (NO invite, NO join button)
// ===========================================================================
test('webhook message: /start sends instructions and no channel link', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  const res = await tv.processWebhookUpdate({ update_id: 1, message: { chat: { id: 10, type: 'private' }, from: { id: 10 }, text: '/start' } }, { supabase: db, bot: bot });
  assert.equal(res.outcome, 'start');
  assert.equal(bot.calls.sendMessage.length, 1);
  assert.ok(bot.calls.sendMessage[0].text.indexOf('t.me') === -1, 'no channel link in /start');
});

test('webhook message: valid code -> success message with NO invite and NO join button', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  const { user, raw } = await seedPendingWithCode(db, 'jane');
  const res = await tv.processWebhookUpdate({ update_id: 2, message: { chat: { id: 20, type: 'private' }, from: { id: 20, username: 'janetg' }, text: tv.formatCodeForDisplay(raw) } }, { supabase: db, bot: bot });
  assert.equal(res.outcome, 'verified');
  // loading first, then edited into the Stage-2 success message
  assert.equal(bot.calls.sendMessage[0].text, tv.MSG.loading);
  const edit = bot.calls.editMessageText[0];
  assert.ok(edit.text.indexOf('\u2705 Verifikasi Telegram berhasil') === 0);
  assert.ok(edit.text.indexOf('Menunggu persetujuan admin') !== -1, 'says waiting for admin approval');
  assert.ok(edit.text.indexOf('setelah akun disetujui admin') !== -1);
  // No join button / no reply markup on the success edit.
  assert.ok(!edit.options || !edit.options.reply_markup, 'no join keyboard on verification success');
  // No invite link created during verification.
  assert.equal(bot.calls.createChatInviteLink.length, 0, 'NO invite created on verification');
  // No verify_channel_join callback button anywhere in this flow.
  const anyJoinButton = bot.calls.editMessageText.concat(bot.calls.sendMessage).some(function (c) {
    const kb = c.options && c.options.reply_markup && c.options.reply_markup.inline_keyboard;
    return kb && kb.flat().some(function (b) { return b.callback_data === 'verify_channel_join'; });
  });
  assert.equal(anyJoinButton, false, 'no verify_channel_join button on verification');
  // Verified but still pending approval; invite delivery untouched.
  assert.ok(db.verifications[user.id].telegram_verified_at);
  assert.equal(db.getUser(user.id).is_approved, false);
});

test('webhook message: admin is notified immediately after verification (durable outbox)', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  const { user, raw } = await seedPendingWithCode(db, 'kev');
  await tv.processWebhookUpdate({ update_id: 30, message: { chat: { id: 61, type: 'private' }, from: { id: 61, username: 'kevtg' }, text: raw } }, { supabase: db, bot: bot });
  const adminMsg = bot.calls.sendMessage.find(function (m) { return String(m.chatId) === '900900900'; });
  assert.ok(adminMsg, 'verification admin notification sent to verify admin chat');
  assert.ok(adminMsg.text.indexOf('USER TERVERIFIKASI TELEGRAM') !== -1);
  assert.ok(adminMsg.text.indexOf('Menunggu persetujuan admin') !== -1);
  assert.ok(adminMsg.text.indexOf('VN-' + user.id) !== -1, 'includes deterministic verify event reference');
  assert.equal(db.verifications[user.id].verify_notification_status, 'sent');
});

test('verify notify: repeated verification does not notify the admin twice (idempotent)', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  const user = db.seedUser({ username: 'ivy' });
  db.seedVerification({ user_id: user.id, telegram_user_id: 88, telegram_verified_at: now() });
  await tv.notifyVerifyAdminBestEffort({ supabase: db, bot: bot }, user.id, { id: 88, username: 'ivytg' });
  const count1 = bot.calls.sendMessage.filter(function (m) { return String(m.chatId) === '900900900'; }).length;
  await tv.notifyVerifyAdminBestEffort({ supabase: db, bot: bot }, user.id, { id: 88, username: 'ivytg' });
  const count2 = bot.calls.sendMessage.filter(function (m) { return String(m.chatId) === '900900900'; }).length;
  assert.equal(count1, 1);
  assert.equal(count2, 1, 'no duplicate verification notification');
});

test('verify notify: failed admin send stays retryable (failed -> sent)', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  const user = db.seedUser({ username: 'nate' });
  db.seedVerification({ user_id: user.id, telegram_user_id: 99, telegram_verified_at: now() });
  // First attempt: admin send fails -> marked failed (retryable).
  bot.sendMessage = async function (chatId) { if (String(chatId) === '900900900') throw new Error('send failed'); return { message_id: 1 }; };
  await tv.notifyVerifyAdminBestEffort({ supabase: db, bot: bot }, user.id, { id: 99 });
  assert.equal(db.verifications[user.id].verify_notification_status, 'failed');
  // Retry with a working bot -> sent.
  const calls = [];
  bot.sendMessage = async function (chatId, text) { calls.push({ chatId, text }); return { message_id: 2 }; };
  await tv.notifyVerifyAdminBestEffort({ supabase: db, bot: bot }, user.id, { id: 99 });
  assert.equal(db.verifications[user.id].verify_notification_status, 'sent');
  assert.equal(calls.filter(function (m) { return String(m.chatId) === '900900900'; }).length, 1);
});

test('webhook message: expired/invalid code tells user to LOGIN again (not register)', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  const res = await tv.processWebhookUpdate({ update_id: 3, message: { chat: { id: 30, type: 'private' }, from: { id: 30 }, text: 'ZZZZZZZZ' } }, { supabase: db, bot: bot });
  assert.equal(res.outcome, 'not_found');
  const edit = bot.calls.editMessageText[0];
  assert.equal(edit.text, tv.MSG.invalidCode);
  assert.ok(edit.text.indexOf('login menggunakan username dan password') !== -1, 'tells the user to login again');
  assert.ok(edit.text.indexOf('Tidak perlu mendaftar ulang') !== -1, 'tells the user NOT to register again');
  assert.ok(db.senders[30] && db.senders[30].failed === 1);
});

test('webhook message: locked sender is rejected before hashing', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  db.senders[40] = { failed: 5, window: now(), locked: now() + 60000 };
  const res = await tv.processWebhookUpdate({ update_id: 4, message: { chat: { id: 40, type: 'private' }, from: { id: 40 }, text: 'ABCD2345' } }, { supabase: db, bot: bot });
  assert.equal(res.outcome, 'sender_locked');
  assert.equal(bot.calls.sendMessage[0].text, tv.MSG.senderLocked);
  assert.equal(bot.calls.editMessageText.length, 0, 'no loading edit; never processed the code');
});

test('webhook message: non-private message is ignored', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  const res = await tv.processWebhookUpdate({ update_id: 5, message: { chat: { id: -50, type: 'channel' }, from: { id: 1 }, text: 'ABCD2345' } }, { supabase: db, bot: bot });
  assert.equal(res.outcome, 'ignored_non_private');
  assert.equal(bot.calls.sendMessage.length, 0);
});

test('webhook message: internal failure after loading edits into the safe-failure message', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  const { raw } = await seedPendingWithCode(db, 'boom');
  const origRpc = db.rpc;
  db.rpc = function (name, args) { if (name === 'consume_challenge_and_bind_telegram') throw new Error('db down'); return origRpc(name, args); };
  const res = await tv.processWebhookUpdate({ update_id: 33, message: { chat: { id: 71, type: 'private' }, from: { id: 71 }, text: raw } }, { supabase: db, bot: bot });
  assert.equal(res.outcome, 'error');
  // Loading was shown, then edited into the neutral safe-failure text.
  assert.equal(bot.calls.sendMessage[0].text, tv.MSG.loading);
  const lastEdit = bot.calls.editMessageText[bot.calls.editMessageText.length - 1];
  assert.equal(lastEdit.text, tv.MSG.safeFailure);
  assert.ok(lastEdit.text.indexOf('Proses belum berhasil') !== -1);
});

// ===========================================================================
// 10. processWebhookUpdate — LEGACY verify_channel_join callback compatibility.
//     New approval messages never emit this button; the compat handler answers
//     promptly and REPLACES the message with a fresh join-request link (approved)
//     or the right pending/error state. It never performs the old direct join.
// ===========================================================================
function joinCallback(updateId, tgId) {
  return { update_id: updateId, callback_query: { id: 'cb' + updateId, from: { id: tgId, username: 'tguser' }, message: { message_id: 900, chat: { id: tgId, type: 'private' } }, data: 'verify_channel_join' } };
}

test('legacy callback: pending account is answered and shown the waiting-admin message (no join)', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot({ member: { status: 'member' } });
  const user = db.seedUser({ username: 'pending1', is_approved: false });
  db.seedVerification({ user_id: user.id, telegram_user_id: 500, telegram_verified_at: now() });
  const res = await tv.processWebhookUpdate(joinCallback(70, 500), { supabase: db, bot: bot });
  assert.equal(res.outcome, 'legacy_pending');
  assert.equal(bot.calls.answerCallbackQuery.length, 1, 'callback answered promptly');
  const lastEdit = bot.calls.editMessageText[bot.calls.editMessageText.length - 1];
  assert.equal(lastEdit.text, 'Akun kamu masih menunggu persetujuan admin.');
  assert.equal(bot.calls.getChatMember.length, 0, 'no membership check for pending');
  assert.ok(!db.verifications[user.id].channel_joined_at);
});

test('legacy callback: approved & not-joined is REPLACED with a fresh join-request link (no direct join)', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot({ inviteLink: 'https://t.me/+legacyRefresh' });
  const user = db.seedUser({ username: 'kate', is_approved: true });
  // Stale stored link (no expiry recorded) -> refreshed.
  db.seedVerification({ user_id: user.id, telegram_user_id: 111, telegram_verified_at: now(), dynamic_invite_link: 'https://t.me/+perUser' });

  const res = await tv.processWebhookUpdate(joinCallback(7, 111), { supabase: db, bot: bot });
  assert.equal(res.outcome, 'legacy_invite');
  assert.equal(bot.calls.answerCallbackQuery.length, 1);
  // A new join-request invite was minted and the message replaced with a URL button.
  assert.equal(bot.calls.createChatInviteLink.length, 1);
  const lastEdit = bot.calls.editMessageText[bot.calls.editMessageText.length - 1];
  assert.ok(lastEdit.text.indexOf('telah disetujui') !== -1);
  const flat = lastEdit.options.reply_markup.inline_keyboard.flat();
  assert.equal(flat.length, 1, 'single request-link button');
  assert.equal(flat[0].url, 'https://t.me/+legacyRefresh');
  assert.ok(!flat[0].callback_data, 'no callback identity on the request button');
  // The legacy handler NEVER completes a direct join / notifies the admin.
  assert.ok(!db.verifications[user.id].channel_joined_at, 'no direct join performed');
  assert.equal(bot.calls.getChatMember.length, 0, 'no membership-based direct join');
});

test('legacy callback: already-joined account is told access is complete', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  const user = db.seedUser({ username: 'leo', is_approved: true });
  db.seedVerification({ user_id: user.id, telegram_user_id: 222, telegram_verified_at: now(), channel_joined_at: now() });
  const res = await tv.processWebhookUpdate(joinCallback(9, 222), { supabase: db, bot: bot });
  assert.equal(res.outcome, 'legacy_joined');
  const lastEdit = bot.calls.editMessageText[bot.calls.editMessageText.length - 1];
  assert.equal(lastEdit.text, tv.MSG.alreadyJoined);
  assert.equal(bot.calls.createChatInviteLink.length, 0);
});

test('legacy callback: unrelated callback data is answered and ignored', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  const res = await tv.processWebhookUpdate({ update_id: 11, callback_query: { id: 'x', from: { id: 1 }, message: { chat: { id: 1, type: 'private' } }, data: 'something_else' } }, { supabase: db, bot: bot });
  assert.equal(res.outcome, 'ignored_callback');
  assert.equal(bot.calls.answerCallbackQuery.length, 1);
  assert.equal(bot.calls.getChatMember.length, 0);
});

test('legacy callback: invite refresh failure edits into safe failure and leaves no stuck message', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot({ inviteThrows: true });
  const user = db.seedUser({ username: 'cbfail', is_approved: true });
  db.seedVerification({ user_id: user.id, telegram_user_id: 444, telegram_verified_at: now() });
  const res = await tv.processWebhookUpdate(joinCallback(12, 444), { supabase: db, bot: bot });
  assert.equal(res.outcome, 'legacy_invite_failed');
  assert.equal(bot.calls.answerCallbackQuery.length, 1, 'callback still answered promptly');
  const lastEdit = bot.calls.editMessageText[bot.calls.editMessageText.length - 1];
  assert.equal(lastEdit.text, tv.MSG.safeFailure, 'no stuck loading/interim message');
});

test('webhook: duplicate processed update is not reprocessed', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  db.webhook[13] = { token: 't', lease: now() - 1000, processed: now(), outcome: 'verified' };
  const res = await tv.processWebhookUpdate({ update_id: 13, message: { chat: { id: 1, type: 'private' }, from: { id: 1 }, text: '/start' } }, { supabase: db, bot: bot });
  assert.equal(res.outcome, 'duplicate');
  assert.equal(bot.calls.sendMessage.length, 0);
});

// ===========================================================================
// 11. confirm_channel_join requires an APPROVED account
// ===========================================================================
test('confirm_channel_join: requires is_approved=true (pending -> pending_approval, approved -> joined)', async function () {
  const db = makeModelDb();
  const user = db.seedUser({ username: 'appr', is_approved: false });
  db.seedVerification({ user_id: user.id, telegram_user_id: 1212, telegram_verified_at: now() });
  // Pending account cannot confirm the join.
  assert.equal((await tv.confirmChannelJoin(db, 1212)).outcome, 'pending_approval');
  // After approval it can.
  db.getUser(user.id).is_approved = true;
  assert.equal((await tv.confirmChannelJoin(db, 1212)).outcome, 'joined_now');
});

// ===========================================================================
// 12. Stage 3: deliverApprovalInvite (invite created + delivered on approval)
// ===========================================================================
test('deliver invite: creates a single-use invite and DMs the join buttons', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot({ inviteLink: 'https://t.me/+approvedInvite' });
  const user = db.seedUser({ username: 'ada', is_approved: true });
  db.seedVerification({ user_id: user.id, telegram_user_id: 777, telegram_private_chat_id: 7000, telegram_verified_at: now() });
  const result = await tv.deliverApprovalInvite({ supabase: db, bot: bot }, user.id);
  assert.equal(result.status, 'sent');
  // One dynamic JOIN-REQUEST invite; member_limit is NEVER sent.
  assert.equal(bot.calls.createChatInviteLink.length, 1);
  assert.ok(!('memberLimit' in bot.calls.createChatInviteLink[0].options), 'no member_limit passed');
  assert.ok(bot.calls.createChatInviteLink[0].options.name, 'a safe invite name is passed');
  // DM to the bound private chat with a SINGLE request-link URL button.
  const dm = bot.calls.sendMessage.find(function (m) { return String(m.chatId) === '7000'; });
  assert.ok(dm, 'invite DM sent to the bound private chat');
  assert.ok(dm.text.indexOf('telah disetujui') !== -1);
  assert.ok(dm.text.indexOf('mengajukan permintaan bergabung') !== -1, 'request-join wording');
  const flat = dm.options.reply_markup.inline_keyboard.flat();
  assert.equal(flat.length, 1, 'exactly one button (the request link)');
  assert.equal(flat[0].url, 'https://t.me/+approvedInvite', 'request-link button URL is the join-request invite');
  assert.ok(!flat.some(function (b) { return b.callback_data; }), 'NO callback button (no verify_channel_join, no Saya Sudah Bergabung)');
  assert.equal(db.verifications[user.id].dynamic_invite_link, 'https://t.me/+approvedInvite');
  assert.equal(db.verifications[user.id].invite_delivery_status, 'sent');
  // The Telegram message_id of the approval message is persisted so the button
  // can be cleaned later.
  assert.equal(typeof db.verifications[user.id].invite_message_id, 'number');
  assert.ok(db.verifications[user.id].invite_message_id > 0);
});

test('deliver invite: does NOT complete when the message_id is missing (retryable warning)', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot({ inviteLink: 'https://t.me/+noMsgId' });
  // sendMessage resolves without a message_id.
  bot.sendMessage = async function (chatId, text, options) { bot.calls.sendMessage.push({ chatId, text, options }); return {}; };
  const user = db.seedUser({ username: 'nomsg', is_approved: true });
  db.seedVerification({ user_id: user.id, telegram_user_id: 909, telegram_private_chat_id: 9090, telegram_verified_at: now() });
  const result = await tv.deliverApprovalInvite({ supabase: db, bot: bot }, user.id);
  assert.equal(result.status, 'failed');
  assert.equal(result.warning, 'invite_message_id_missing');
  assert.equal(db.verifications[user.id].invite_delivery_status, 'failed', 'not marked sent');
  // Warning must not expose any Telegram response body or token.
  assert.ok(String(result.warning).indexOf('token') === -1);
});

test('deliver invite: replacing an old invite removes the previous button first', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot({ inviteLink: 'https://t.me/+replacement' });
  const user = db.seedUser({ username: 'replace', is_approved: true });
  db.seedVerification({
    user_id: user.id, telegram_user_id: 321, telegram_private_chat_id: 3210, telegram_verified_at: now(),
    dynamic_invite_link: 'https://t.me/+oldLink', invite_message_id: 555
  });
  const result = await tv.deliverApprovalInvite({ supabase: db, bot: bot }, user.id);
  assert.equal(result.status, 'sent');
  // The previously stored message had its keyboard removed before replacement.
  assert.equal(bot.calls.editMessageReplyMarkup.length, 1);
  assert.deepEqual(bot.calls.editMessageReplyMarkup[0], { chatId: 3210, messageId: 555 });
  // The old link was revoked and a fresh message_id stored.
  assert.equal(bot.calls.revokeChatInviteLink.length, 1);
  assert.equal(typeof db.verifications[user.id].invite_message_id, 'number');
  assert.notEqual(db.verifications[user.id].invite_message_id, 555);
});

test('deliver invite: never claims an unverified/unapproved account', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  const user = db.seedUser({ username: 'nope', is_approved: false });
  db.seedVerification({ user_id: user.id, telegram_user_id: 1, telegram_private_chat_id: 2, telegram_verified_at: now() });
  const result = await tv.deliverApprovalInvite({ supabase: db, bot: bot }, user.id);
  assert.equal(result.status, 'skipped');
  assert.equal(bot.calls.createChatInviteLink.length, 0);
});

test('deliver invite: create failure is recorded failed (retryable) and does not throw', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot({ inviteThrows: true });
  // No static fallback for this test.
  const savedStatic = process.env.TELEGRAM_VERIFY_CHANNEL_INVITE_URL;
  delete process.env.TELEGRAM_VERIFY_CHANNEL_INVITE_URL;
  try {
    const user = db.seedUser({ username: 'grace', is_approved: true });
    db.seedVerification({ user_id: user.id, telegram_user_id: 5, telegram_private_chat_id: 50, telegram_verified_at: now() });
    const result = await tv.deliverApprovalInvite({ supabase: db, bot: bot }, user.id);
    assert.equal(result.status, 'failed');
    assert.equal(db.verifications[user.id].invite_delivery_status, 'failed');
    // Retryable: a fresh (working) delivery marks it sent.
    const bot2 = makeFakeBot({ inviteLink: 'https://t.me/+retried' });
    const retry = await tv.deliverApprovalInvite({ supabase: db, bot: bot2 }, user.id);
    assert.equal(retry.status, 'sent');
    assert.equal(db.verifications[user.id].invite_delivery_status, 'sent');
  } finally {
    if (savedStatic === undefined) delete process.env.TELEGRAM_VERIFY_CHANNEL_INVITE_URL; else process.env.TELEGRAM_VERIFY_CHANNEL_INVITE_URL = savedStatic;
  }
});

// ===========================================================================
// 13. Endpoint tests (supabase stubbed via Module._load)
// ===========================================================================
function requireApiWithSupabaseStub(relPath, dbFactory) {
  const origLoad = Module._load;
  const abs = require.resolve(relPath);
  delete require.cache[abs];
  const db = dbFactory();
  Module._load = function (request) {
    if (request === '@supabase/supabase-js') return { createClient: function () { return db; } };
    return origLoad.apply(this, arguments);
  };
  let handler;
  try { handler = require(relPath); } finally { Module._load = origLoad; delete require.cache[abs]; }
  return { handler, db };
}

function makeReq(opts) {
  return { method: opts.method || 'POST', headers: opts.headers || {}, query: opts.query || {}, body: opts.body || {} };
}
function makeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }
  };
}

test('endpoint register: v2 response has verification code and NO channel URL', async function () {
  process.env.SUPABASE_URL = 'http://local';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
  const { handler } = requireApiWithSupabaseStub('../api/register-user', makeModelDb);
  const req = makeReq({ body: { username: 'quinn', passwordHash: 'ph', deviceId: 'dev', userAgent: 'UA' } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.ok(res.body.telegram_verification_code, 'has one-time code');
  assert.equal(res.body.telegram_bot_url, 'https://t.me/AutoCuanVerificationBot');
  assert.ok(!('telegram_channel_url' in res.body), 'no channel URL in response');
});

test('endpoint register: fails closed without the code secret', async function () {
  process.env.SUPABASE_URL = 'http://local';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
  const saved = process.env.TELEGRAM_VERIFY_CODE_SECRET;
  delete process.env.TELEGRAM_VERIFY_CODE_SECRET;
  try {
    const { handler } = requireApiWithSupabaseStub('../api/register-user', makeModelDb);
    const res = makeRes();
    await handler(makeReq({ body: { username: 'rick', passwordHash: 'ph', deviceId: 'dev' } }), res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.success, false);
  } finally { process.env.TELEGRAM_VERIFY_CODE_SECRET = saved; }
});

test('endpoint login webhook: missing/wrong secret -> 401 before processing', async function () {
  process.env.TELEGRAM_VERIFY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  const { handler } = requireApiWithSupabaseStub('../api/login-user', makeModelDb);
  let res = makeRes();
  await handler(makeReq({ query: { action: 'telegram-verify-webhook' }, headers: {} }), res);
  assert.equal(res.statusCode, 401);
  res = makeRes();
  await handler(makeReq({ query: { action: 'telegram-verify-webhook' }, headers: { 'x-telegram-bot-api-secret-token': 'nope' } }), res);
  assert.equal(res.statusCode, 401);
});

test('endpoint login webhook: oversized body -> 413', async function () {
  process.env.TELEGRAM_VERIFY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  const { handler } = requireApiWithSupabaseStub('../api/login-user', makeModelDb);
  const res = makeRes();
  await handler(makeReq({
    query: { action: 'telegram-verify-webhook' },
    headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET, 'content-length': String(64 * 1024) },
    body: { update_id: 1 }
  }), res);
  assert.equal(res.statusCode, 413);
});

test('endpoint login webhook: GET is rejected (POST only)', async function () {
  process.env.TELEGRAM_VERIFY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  const { handler } = requireApiWithSupabaseStub('../api/login-user', makeModelDb);
  const res = makeRes();
  await handler(makeReq({ method: 'GET', query: { action: 'telegram-verify-webhook' }, headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET } }), res);
  assert.equal(res.statusCode, 405);
});

test('endpoint login webhook: valid secret + ignored update -> 200, no session cookie', async function () {
  process.env.SUPABASE_URL = 'http://local';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
  process.env.TELEGRAM_VERIFY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  const { handler } = requireApiWithSupabaseStub('../api/login-user', makeModelDb);
  const res = makeRes();
  await handler(makeReq({
    query: { action: 'telegram-verify-webhook' },
    headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    body: { update_id: 999 }
  }), res);
  assert.equal(res.statusCode, 200);
  assert.ok(!res.headers['Set-Cookie'], 'webhook never sets a session cookie');
});

test('endpoint login pending: correct password rotates code, issues NO session', async function () {
  process.env.SUPABASE_URL = 'http://local';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
  const { handler, db } = requireApiWithSupabaseStub('../api/login-user', makeModelDb);
  db.seedUser({ id: 'u-pending', username: 'sam', password_hash: 'HASH', devices: ['dev'], is_approved: false, is_blocked: false });
  const res = makeRes();
  await handler(makeReq({ body: { username: 'sam', passwordHash: 'HASH', deviceId: 'dev', userAgent: 'UA' } }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.approval_status, 'pending');
  assert.ok(res.body.telegram_verification_code, 'fresh one-time code issued');
  assert.equal(res.body.telegram_bot_url, 'https://t.me/AutoCuanVerificationBot');
  assert.ok(!('telegram_channel_url' in res.body), 'no channel URL');
  assert.ok(!res.headers['Set-Cookie'], 'no session issued for a pending user');
});

test('endpoint login: approved budi authenticates normally (unchanged), gets a session', async function () {
  process.env.SUPABASE_URL = 'http://local';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
  process.env.SESSION_SECRET = 'unit-test-session-secret';
  const { handler, db } = requireApiWithSupabaseStub('../api/login-user', makeModelDb);
  db.seedUser({ id: 'u-budi', username: 'budi', password_hash: 'BUDIHASH', devices: ['dev-budi'], is_approved: true, is_blocked: false });
  const res = makeRes();
  await handler(makeReq({ body: { username: 'budi', passwordHash: 'BUDIHASH', deviceId: 'dev-budi', userAgent: 'UA' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.isAdmin, true);
  assert.ok(res.headers['Set-Cookie'], 'approved user still receives a session cookie');
  assert.ok(!('approval_status' in res.body), 'budi never enters the pending v2 flow');
});

// ===========================================================================
// 14. Isolation / hygiene / API count
// ===========================================================================
test('isolation: verify bot READS only the verify token (no recommendation token env access)', function () {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'telegram-verify-bot.js'), 'utf8');
  assert.ok(src.indexOf('process.env.TELEGRAM_VERIFY_BOT_TOKEN') !== -1, 'reads verify token');
  assert.equal(src.indexOf('process.env.TELEGRAM_BOT_TOKEN') !== -1, false, 'does not read TELEGRAM_BOT_TOKEN');
  assert.equal(/require\([^)]*telegram-notifier/.test(src), false, 'does not import telegram-notifier');
});

test('isolation: verification lib does not USE TELEGRAM_BOT_TOKEN or import telegram-notifier', function () {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'telegram-verification.js'), 'utf8');
  assert.equal(src.indexOf('process.env.TELEGRAM_BOT_TOKEN') !== -1, false);
  assert.equal(/require\([^)]*telegram-notifier/.test(src), false);
});

test('isolation: new libs never log via console (raw code/text cannot leak to logs)', function () {
  const a = fs.readFileSync(path.join(ROOT, 'lib', 'telegram-verification.js'), 'utf8');
  const b = fs.readFileSync(path.join(ROOT, 'lib', 'telegram-verify-bot.js'), 'utf8');
  assert.equal(a.indexOf('console.') !== -1, false);
  assert.equal(b.indexOf('console.') !== -1, false);
});

test('isolation: verify bot token accessor never falls back to recommendation token', function () {
  const bot = require('../lib/telegram-verify-bot');
  const savedVerify = process.env.TELEGRAM_VERIFY_BOT_TOKEN;
  const savedRec = process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_VERIFY_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = 'recommendation-token-should-not-be-used';
  try {
    assert.equal(bot.__getVerifyBotToken(), null, 'no fallback to TELEGRAM_BOT_TOKEN');
  } finally {
    if (savedVerify === undefined) delete process.env.TELEGRAM_VERIFY_BOT_TOKEN; else process.env.TELEGRAM_VERIFY_BOT_TOKEN = savedVerify;
    if (savedRec === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = savedRec;
  }
});

test('isolation: TELEGRAM_BOT_TOKEN is never USED (env-accessed) by the verification code paths', function () {
  ['lib/telegram-verification.js', 'lib/telegram-verify-bot.js', 'api/admin-users.js'].forEach(function (rel) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.equal(src.indexOf('process.env.TELEGRAM_BOT_TOKEN') !== -1, false, rel + ' must not read process.env.TELEGRAM_BOT_TOKEN');
  });
});

test('api count: exactly 12 API JavaScript files', function () {
  const files = fs.readdirSync(path.join(ROOT, 'api')).filter(function (f) { return f.endsWith('.js'); });
  assert.equal(files.length, 12, 'API JS file count must remain 12; got ' + files.length);
});

test('hygiene: active verification flow never references TELEGRAM_VERIFY_CHANNEL_INVITE_URL (static fallback removed)', function () {
  ['lib/telegram-verification.js', 'lib/telegram-verify-bot.js', 'api/admin-users.js', 'api/login-user.js'].forEach(function (rel) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.equal(src.indexOf('TELEGRAM_VERIFY_CHANNEL_INVITE_URL') !== -1, false, rel + ' must not reference the static channel invite URL');
  });
});

test('hygiene: new approval message + request button carry NO verify_channel_join callback', function () {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'telegram-verification.js'), 'utf8');
  // The request-link builder must be url-only (no callback_data).
  const btn = tv.requestJoinButton('https://t.me/+sample');
  const flat = btn.inline_keyboard.flat();
  assert.equal(flat.length, 1);
  assert.ok(flat[0].url, 'request button is a URL button');
  assert.ok(!flat[0].callback_data, 'request button has no callback identity');
  // The approval message text is the new request-join wording.
  const msg = tv.buildApprovalInviteMessage();
  assert.ok(msg.indexOf('telah disetujui') !== -1);
  assert.ok(msg.indexOf('Saya Sudah Bergabung') === -1, 'no legacy button label in the message');
  // verify_channel_join literal only appears in the legacy CALLBACK_JOIN constant
  // and its compat handler — never assembled into a new outbound keyboard.
  assert.ok(src.indexOf("text: '\\u2705 Saya Sudah Bergabung'") === -1, 'no join-callback keyboard is constructed');
});

test('hygiene: member_limit is never sent when creating an invite link', function () {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'telegram-verify-bot.js'), 'utf8');
  // No member_limit key is ever placed on the createChatInviteLink payload.
  assert.equal(/member_limit\s*:/.test(src), false, 'member_limit must not be added to the invite payload');
  assert.ok(/creates_join_request\s*:\s*true/.test(src), 'creates_join_request must be true');
});

test('safety: Delete User remains absent (no delete-user action or endpoint)', function () {
  const admin = fs.readFileSync(path.join(ROOT, 'api', 'admin-users.js'), 'utf8');
  assert.equal(/action\s*===\s*['"]delete['"]/.test(admin), false, 'no delete action in admin-users');
  assert.equal(/delete[_-]?user/i.test(admin), false, 'no delete-user handler in admin-users');
  const apiFiles = fs.readdirSync(path.join(ROOT, 'api')).filter(function (f) { return f.endsWith('.js'); });
  assert.ok(!apiFiles.some(function (f) { return /delete/i.test(f); }), 'no delete-user API file');
});
