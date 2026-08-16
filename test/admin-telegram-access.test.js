'use strict';

// ===========================================================================
// Regression coverage for the Telegram-approved maintenance admin entry.
//
// Covers, per the migration plan:
//   3. unapproved challenge cannot create an admin session
//   4. approved challenge from the wrong browser cannot be consumed
//   5. wrong Telegram user cannot approve
//   6. expired challenge fails
//   7. rejected challenge fails
//   8. consumed challenge cannot replay
//   9. simultaneous/double consumption yields at most one session
//   10. repeated Telegram callback is harmless (idempotent)
//   11. Telegram message deletion failure does not restore challenge validity
//
// LOCAL / STATIC ONLY. No network, no real Supabase, no real Telegram API —
// db.rpc and the bot client are stubbed.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ROOT = path.resolve(__dirname, '..');

function makeRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function sameOriginHeaders(cookie, ip) {
  const headers = {
    host: 'app.test',
    origin: 'https://app.test',
    'content-type': 'application/json',
    cookie: cookie || ''
  };
  if (ip) headers['x-vercel-forwarded-for'] = ip;
  return headers;
}

function withEnv(fn) {
  const keys = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SESSION_SECRET', 'TELEGRAM_VERIFY_BOT_TOKEN', 'SECURITY_GUARD_MODE'];
  const previous = {};
  keys.forEach(function (key) { previous[key] = process.env[key]; });
  process.env.SUPABASE_URL = 'https://example.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-test';
  process.env.SESSION_SECRET = 'session-secret-for-admin-access-tests';
  process.env.TELEGRAM_VERIFY_BOT_TOKEN = 'bot-token-for-tests';
  process.env.SECURITY_GUARD_MODE = 'off';
  return Promise.resolve(fn()).finally(function () {
    keys.forEach(function (key) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    });
  });
}

// A minimal db.rpc stub that models the SQL RPCs' state machine so tests can
// exercise the actual JS control flow in lib/admin-access.js and
// api/reset-password.js against something that behaves like the real thing.
function createFakeAdminAccessDb(options) {
  const opts = options || {};
  const calls = [];
  const claimedUpdateIds = new Set();
  const ipRequestTimestamps = new Map(); // ip_hash -> [Date.now(), ...] within the window
  let row = null; // { state, browser_binding_hash, telegram_user_id, telegram_chat_id, telegram_message_id, expires_at }

  function rowIsLive() {
    return row && (row.state === 'pending' || row.state === 'approved') && new Date(row.expires_at).getTime() > Date.now();
  }

  return {
    __row: function () { return row; },
    __calls: calls,
    rpc(name, args) {
      calls.push({ name: name, args: args });

      if (name === 'create_admin_access_request') {
        if (opts.createResult) return Promise.resolve({ data: [opts.createResult], error: null });

        if (args.p_ip_hash) {
          const now = Date.now();
          const windowMs = 5 * 60 * 1000;
          const list = (ipRequestTimestamps.get(args.p_ip_hash) || []).filter(function (t) { return now - t < windowMs; });
          if (list.length >= 5) {
            ipRequestTimestamps.set(args.p_ip_hash, list);
            return Promise.resolve({ data: [{ result_code: 'ip_throttled', user_id: 'user-budi', expires_at: null }], error: null });
          }
        }

        // No-preemption: a live row is never replaced by a new create call.
        if (rowIsLive()) {
          return Promise.resolve({ data: [{ result_code: 'throttled', user_id: 'user-budi', expires_at: row.expires_at }], error: null });
        }

        if (args.p_ip_hash) {
          const now = Date.now();
          const list = ipRequestTimestamps.get(args.p_ip_hash) || [];
          list.push(now);
          ipRequestTimestamps.set(args.p_ip_hash, list);
        }

        row = {
          state: 'pending',
          browser_binding_hash: args.p_browser_binding_hash,
          telegram_user_id: null,
          telegram_chat_id: 555,
          telegram_message_id: null,
          expires_at: args.p_expires_at
        };
        return Promise.resolve({
          data: [{ result_code: 'ok', request_id: 'req-1', user_id: 'user-budi', telegram_user_id: 999, telegram_chat_id: 555, expires_at: args.p_expires_at }],
          error: null
        });
      }

      if (name === 'record_admin_access_message') {
        if (row) row.telegram_message_id = args.p_telegram_message_id;
        return Promise.resolve({ data: [{ result_code: 'ok' }], error: null });
      }

      if (name === 'approve_admin_access_request') {
        if (!row) return Promise.resolve({ data: [{ result_code: 'not_found' }], error: null });
        if (row.state !== 'pending') {
          return Promise.resolve({ data: [{ result_code: 'already_' + row.state, telegram_chat_id: row.telegram_chat_id, telegram_message_id: row.telegram_message_id }], error: null });
        }
        if (args.p_telegram_user_id !== opts.adminTelegramUserId) {
          return Promise.resolve({ data: [{ result_code: 'identity_mismatch', telegram_chat_id: row.telegram_chat_id, telegram_message_id: row.telegram_message_id }], error: null });
        }
        row.state = 'approved';
        row.telegram_user_id = args.p_telegram_user_id;
        return Promise.resolve({ data: [{ result_code: 'ok', telegram_chat_id: row.telegram_chat_id, telegram_message_id: row.telegram_message_id }], error: null });
      }

      if (name === 'deny_admin_access_request') {
        if (!row) return Promise.resolve({ data: [{ result_code: 'not_found' }], error: null });
        if (row.state !== 'pending') {
          return Promise.resolve({ data: [{ result_code: 'already_' + row.state, telegram_chat_id: row.telegram_chat_id, telegram_message_id: row.telegram_message_id }], error: null });
        }
        if (args.p_telegram_user_id !== opts.adminTelegramUserId) {
          return Promise.resolve({ data: [{ result_code: 'identity_mismatch', telegram_chat_id: row.telegram_chat_id, telegram_message_id: row.telegram_message_id }], error: null });
        }
        row.state = 'denied';
        return Promise.resolve({ data: [{ result_code: 'ok', telegram_chat_id: row.telegram_chat_id, telegram_message_id: row.telegram_message_id }], error: null });
      }

      if (name === 'consume_admin_access_request') {
        if (!row || row.browser_binding_hash !== args.p_browser_binding_hash) {
          return Promise.resolve({ data: [{ result_code: 'not_found' }], error: null });
        }
        if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
          if (row.state === 'pending' || row.state === 'approved') row.state = 'expired';
          return Promise.resolve({ data: [{ result_code: 'expired', expires_at: row.expires_at }], error: null });
        }
        if (row.state === 'denied') return Promise.resolve({ data: [{ result_code: 'denied', expires_at: row.expires_at }], error: null });
        if (row.state === 'consumed') return Promise.resolve({ data: [{ result_code: 'already_consumed', expires_at: row.expires_at }], error: null });
        if (row.state === 'pending') return Promise.resolve({ data: [{ result_code: 'pending', expires_at: row.expires_at }], error: null });
        // approved -> consumed, exactly once
        row.state = 'consumed';
        return Promise.resolve({
          data: [{ result_code: 'ok', user_id: 'user-budi', username: 'budi', telegram_chat_id: row.telegram_chat_id, telegram_message_id: row.telegram_message_id, expires_at: row.expires_at }],
          error: null
        });
      }

      if (name === 'claim_auth_recovery_webhook_update') {
        const id = args.p_update_id;
        if (claimedUpdateIds.has(id)) return Promise.resolve({ data: [{ claimed: false }], error: null });
        claimedUpdateIds.add(id);
        return Promise.resolve({ data: [{ claimed: true }], error: null });
      }

      if (name === 'complete_auth_recovery_webhook_update') {
        return Promise.resolve({ data: null, error: null });
      }

      return Promise.resolve({ data: null, error: null });
    },
    from() {
      throw new Error('unexpected .from() call in admin-access tests');
    }
  };
}

function requireApiWithFakes(db, bot) {
  const originalLoad = Module._load;
  const apiPath = require.resolve('../api/reset-password');
  const botPath = require.resolve('../lib/telegram-verify-bot');
  delete require.cache[apiPath];
  Module._load = function (request, parent) {
    if (request === '@supabase/supabase-js') {
      return { createClient: function () { return db; } };
    }
    if (request === '../lib/telegram-verify-bot' || (parent && parent.filename === apiPath && request.indexOf('telegram-verify-bot') !== -1)) {
      return { createVerifyBot: function () { return bot; } };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return require('../api/reset-password');
  } finally {
    Module._load = originalLoad;
    delete require.cache[apiPath];
    delete require.cache[botPath];
  }
}

function makeBot(overrides) {
  const sent = [];
  const edits = [];
  const answered = [];
  const deleted = [];
  return Object.assign({
    sentMessages: sent,
    edits: edits,
    answered: answered,
    deleted: deleted,
    sendMessage: async function (chatId, text, options) { sent.push({ chatId, text, options }); return { message_id: 4242 }; },
    editMessageText: async function (chatId, messageId, text, options) { edits.push({ chatId, messageId, text, options }); return {}; },
    editMessageReplyMarkup: async function (chatId, messageId) { edits.push({ chatId, messageId, stripped: true }); return {}; },
    answerCallbackQuery: async function (id, options) { answered.push({ id, options }); return {}; },
    deleteMessage: async function (chatId, messageId) { deleted.push({ chatId, messageId }); return {}; }
  }, overrides || {});
}

function chalCookieFrom(res) {
  const set = res.headers['Set-Cookie'];
  const arr = Array.isArray(set) ? set : [set];
  const chal = arr.find(function (c) { return typeof c === 'string' && c.indexOf('ac_chal=') === 0; });
  return chal ? chal.split(';')[0].slice('ac_chal='.length) : null;
}

function sessCookieFrom(res) {
  const set = res.headers['Set-Cookie'];
  const arr = Array.isArray(set) ? set : [set];
  const sess = arr.find(function (c) { return typeof c === 'string' && c.indexOf('ac_sess=') === 0; });
  return sess || null;
}

test('unapproved challenge cannot create an admin session (still pending)', async function () {
  await withEnv(async function () {
    const db = createFakeAdminAccessDb({ adminTelegramUserId: 999 });
    const bot = makeBot();
    const handler = requireApiWithFakes(db, bot);

    const reqRes = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders(), body: { action: 'admin-access-request', context: 'ua' } }, reqRes);
    assert.equal(reqRes.body.success, true);
    const chal = chalCookieFrom(reqRes);
    assert.ok(chal);

    const pollRes = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders('ac_chal=' + chal), body: { action: 'admin-access-poll', requestRef: reqRes.body.requestRef } }, pollRes);
    assert.equal(pollRes.body.state, 'pending');
    assert.equal(sessCookieFrom(pollRes), null, 'no ac_sess may be issued before approval');
  });
});

test('approved challenge from the wrong browser cannot be consumed', async function () {
  await withEnv(async function () {
    const db = createFakeAdminAccessDb({ adminTelegramUserId: 999 });
    const bot = makeBot();
    const handler = requireApiWithFakes(db, bot);

    const reqRes = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders(), body: { action: 'admin-access-request' } }, reqRes);
    const requestRef = reqRes.body.requestRef;

    // Approve out-of-band (simulating the Telegram callback).
    await db.rpc('approve_admin_access_request', { p_request_ref: requestRef, p_telegram_user_id: 999 });

    // Poll from a DIFFERENT browser (no matching ac_chal cookie at all).
    const pollRes = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders('ac_chal=totally-different-binding-value'), body: { action: 'admin-access-poll', requestRef: requestRef } }, pollRes);

    assert.equal(pollRes.body.success, false);
    assert.equal(sessCookieFrom(pollRes), null, 'wrong browser must never receive a session');
  });
});

test('wrong Telegram user cannot approve', async function () {
  await withEnv(async function () {
    const adminAccess = require('../lib/admin-access');
    const db = createFakeAdminAccessDb({ adminTelegramUserId: 999 });
    const bot = makeBot();

    const requestRef = 'wrong-user-test-request-reference-ref';
    const created = await db.rpc('create_admin_access_request', {
      p_username: 'budi', p_request_ref: requestRef, p_browser_binding_hash: 'h', p_expires_at: new Date(Date.now() + 120000).toISOString(), p_context: ''
    });
    void created;

    const result = await adminAccess.handleAdminAccessUpdate({
      update_id: 1,
      callback_query: {
        id: 'cb1',
        data: adminAccess.CALLBACK_APPROVE_PREFIX + requestRef,
        from: { id: 111 }, // NOT the configured admin telegram id (999)
        message: { message_id: 4242, chat: { id: 555 } }
      }
    }, { db: db, bot: bot });

    assert.equal(result.handled, true);
    assert.equal(result.outcome, 'admin_access_identity_mismatch');
    assert.equal(db.__row().state, 'pending', 'the request must remain pending, not become approved');
    assert.equal(bot.edits.length, 0, 'controls must not be disabled for a rejected identity');
    assert.equal(bot.answered.length, 1);
  });
});

test('expired challenge fails', async function () {
  await withEnv(async function () {
    const db = createFakeAdminAccessDb({ adminTelegramUserId: 999, createResult: null });
    const bot = makeBot();
    const handler = requireApiWithFakes(db, bot);

    const reqRes = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders(), body: { action: 'admin-access-request' } }, reqRes);
    const chal = chalCookieFrom(reqRes);
    db.__row().expires_at = new Date(Date.now() - 1000).toISOString();
    db.__row().state = 'approved';

    const pollRes = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders('ac_chal=' + chal), body: { action: 'admin-access-poll', requestRef: reqRes.body.requestRef } }, pollRes);

    assert.equal(pollRes.body.success, false);
    assert.equal(pollRes.body.state, 'expired');
    assert.equal(sessCookieFrom(pollRes), null);
  });
});

test('rejected challenge fails', async function () {
  await withEnv(async function () {
    const db = createFakeAdminAccessDb({ adminTelegramUserId: 999 });
    const bot = makeBot();
    const handler = requireApiWithFakes(db, bot);

    const reqRes = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders(), body: { action: 'admin-access-request' } }, reqRes);
    const chal = chalCookieFrom(reqRes);
    const requestRef = reqRes.body.requestRef;

    await db.rpc('deny_admin_access_request', { p_request_ref: requestRef, p_telegram_user_id: 999 });

    const pollRes = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders('ac_chal=' + chal), body: { action: 'admin-access-poll', requestRef: requestRef } }, pollRes);

    assert.equal(pollRes.body.success, false);
    assert.equal(pollRes.body.state, 'denied');
    assert.equal(sessCookieFrom(pollRes), null);
  });
});

test('consumed challenge cannot replay, and double consumption yields at most one session', async function () {
  await withEnv(async function () {
    const db = createFakeAdminAccessDb({ adminTelegramUserId: 999 });
    const bot = makeBot();
    const handler = requireApiWithFakes(db, bot);

    const reqRes = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders(), body: { action: 'admin-access-request' } }, reqRes);
    const chal = chalCookieFrom(reqRes);
    const requestRef = reqRes.body.requestRef;
    await db.rpc('approve_admin_access_request', { p_request_ref: requestRef, p_telegram_user_id: 999 });

    const firstPoll = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders('ac_chal=' + chal), body: { action: 'admin-access-poll', requestRef: requestRef } }, firstPoll);
    assert.equal(firstPoll.body.success, true);
    assert.equal(firstPoll.body.state, 'approved');
    assert.match(sessCookieFrom(firstPoll), /^ac_sess=/);

    const secondPoll = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders('ac_chal=' + chal), body: { action: 'admin-access-poll', requestRef: requestRef } }, secondPoll);
    assert.equal(secondPoll.body.success, false, 'a replay must not succeed');
    assert.equal(sessCookieFrom(secondPoll), null, 'a replay must not issue a second session');
  });
});

test('repeated Telegram callback (retry / double press) is harmless', async function () {
  await withEnv(async function () {
    const adminAccess = require('../lib/admin-access');
    const db = createFakeAdminAccessDb({ adminTelegramUserId: 999 });
    const bot = makeBot();

    const requestRef = 'repeated-callback-test-request-reference';
    await db.rpc('create_admin_access_request', {
      p_username: 'budi', p_request_ref: requestRef, p_browser_binding_hash: 'h', p_expires_at: new Date(Date.now() + 120000).toISOString(), p_context: ''
    });

    const update = {
      update_id: 55,
      callback_query: {
        id: 'cb1',
        data: adminAccess.CALLBACK_APPROVE_PREFIX + requestRef,
        from: { id: 999 },
        message: { message_id: 4242, chat: { id: 555 } }
      }
    };

    const first = await adminAccess.handleAdminAccessUpdate(update, { db: db, bot: bot });
    const second = await adminAccess.handleAdminAccessUpdate(update, { db: db, bot: bot });

    assert.equal(first.outcome, 'admin_access_approved');
    assert.equal(second.outcome, 'duplicate');
    // Telegram must still get an answered callback both times (no hanging spinner).
    assert.equal(bot.answered.length, 2);
    // But approval only actually happened once.
    assert.equal(db.__calls.filter(function (c) { return c.name === 'approve_admin_access_request'; }).length, 1);
  });
});

test('Telegram message deletion failure does not restore challenge validity', async function () {
  await withEnv(async function () {
    const db = createFakeAdminAccessDb({ adminTelegramUserId: 999 });
    const bot = makeBot({ deleteMessage: async function () { throw new Error('telegram_unreachable'); } });
    const handler = requireApiWithFakes(db, bot);

    const reqRes = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders(), body: { action: 'admin-access-request' } }, reqRes);
    const chal = chalCookieFrom(reqRes);
    const requestRef = reqRes.body.requestRef;
    await db.rpc('approve_admin_access_request', { p_request_ref: requestRef, p_telegram_user_id: 999 });

    const pollRes = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders('ac_chal=' + chal), body: { action: 'admin-access-poll', requestRef: requestRef } }, pollRes);
    assert.equal(pollRes.body.success, true, 'deletion failure must not block session issuance');

    // Give the fire-and-forget cleanup a tick to run and confirm it does not throw / crash the process.
    await new Promise(function (resolve) { setTimeout(resolve, 10); });

    const replay = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders('ac_chal=' + chal), body: { action: 'admin-access-poll', requestRef: requestRef } }, replay);
    assert.equal(replay.body.success, false, 'the challenge must stay consumed even though the Telegram message could not be deleted');
  });
});

test('binding cookie hash is never the raw browser-binding value', async function () {
  await withEnv(async function () {
    const adminAccess = require('../lib/admin-access');
    const raw = adminAccess.generateBrowserBinding();
    const hash = adminAccess.hashBrowserBinding(raw);
    assert.notEqual(hash, raw);
    assert.match(hash, /^[a-f0-9]{64}$/);
  });
});

// ===========================================================================
// Anti-spam hardening (pre-PR pass): the request endpoint is intentionally
// public/unauthenticated. These tests cover the layered mitigations added
// on top of the original 10-second cooldown:
//   - rapid repeated requests cannot create Telegram notification spam
//   - throttling never grants access
//   - legitimate retry becomes possible after the bounded cooldown
//   - attacker cannot invalidate/steal an already-approved legitimate request
//   - throttling does not change Telegram identity verification or binding
// ===========================================================================

test('rapid repeated requests cannot create Telegram notification spam', async function () {
  await withEnv(async function () {
    const db = createFakeAdminAccessDb({ adminTelegramUserId: 999 });
    const bot = makeBot();
    const handler = requireApiWithFakes(db, bot);

    for (let i = 0; i < 8; i++) {
      const res = makeRes();
      await handler({ method: 'POST', headers: sameOriginHeaders('', '203.0.113.9'), body: { action: 'admin-access-request' } }, res);
    }

    // Exactly one live challenge exists, so exactly one Telegram message was sent —
    // repeated public clicks (or a spamming attacker) cannot multiply notifications.
    assert.equal(bot.sentMessages.length, 1);
  });
});

test('throttling never grants access', async function () {
  await withEnv(async function () {
    const db = createFakeAdminAccessDb({ adminTelegramUserId: 999 });
    const bot = makeBot();
    const handler = requireApiWithFakes(db, bot);

    const first = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders('', '203.0.113.9'), body: { action: 'admin-access-request' } }, first);
    assert.equal(first.body.success, true);

    const second = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders('', '203.0.113.9'), body: { action: 'admin-access-request' } }, second);
    assert.equal(second.body.success, false);
    assert.equal(second.body.requestRef, undefined, 'a throttled response must not hand out a pollable requestRef');
    assert.equal(chalCookieFrom(second), null, 'a throttled response must not set a browser-binding cookie either');
  });
});

test('IP flood is throttled independently of the per-admin cooldown', async function () {
  await withEnv(async function () {
    const db = createFakeAdminAccessDb({ adminTelegramUserId: 999 });
    const bot = makeBot();
    const handler = requireApiWithFakes(db, bot);

    // Consume the existing-live-request throttle immediately by letting the
    // first request through, then hammer from the SAME ip. The 6th+ call
    // within the 5-request/5-minute window must be ip_throttled even if the
    // live-request state had somehow cleared.
    const results = [];
    for (let i = 0; i < 6; i++) {
      const res = makeRes();
      await handler({ method: 'POST', headers: sameOriginHeaders('', '198.51.100.7'), body: { action: 'admin-access-request' } }, res);
      results.push(res.body);
    }
    assert.equal(results[0].success, true);
    assert.equal(bot.sentMessages.length, 1, 'only the first call from this IP is ever eligible to notify Telegram');
    results.slice(1).forEach(function (r) { assert.equal(r.success, false); });
  });
});

test('legitimate retry becomes possible after the bounded cooldown', async function () {
  await withEnv(async function () {
    const db = createFakeAdminAccessDb({ adminTelegramUserId: 999 });
    const bot = makeBot();
    const handler = requireApiWithFakes(db, bot);

    const first = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders(), body: { action: 'admin-access-request' } }, first);
    assert.equal(first.body.success, true);

    // Simulate the TTL elapsing.
    db.__row().expires_at = new Date(Date.now() - 1000).toISOString();

    const retry = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders(), body: { action: 'admin-access-request' } }, retry);
    assert.equal(retry.body.success, true, 'a genuinely expired challenge must not permanently block retry');
    assert.notEqual(retry.body.requestRef, first.body.requestRef);
  });
});

test('an attacker spamming admin-access-request cannot invalidate or steal an already-approved legitimate request', async function () {
  await withEnv(async function () {
    const db = createFakeAdminAccessDb({ adminTelegramUserId: 999 });
    const bot = makeBot();
    const handler = requireApiWithFakes(db, bot);

    const legit = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders('', '203.0.113.50'), body: { action: 'admin-access-request' } }, legit);
    const legitChal = chalCookieFrom(legit);
    const legitRef = legit.body.requestRef;

    // Approve it out-of-band (the real admin pressed the Telegram button).
    await db.rpc('approve_admin_access_request', { p_request_ref: legitRef, p_telegram_user_id: 999 });
    assert.equal(db.__row().state, 'approved');

    // Attacker (different IP, no cookie) spams the same public endpoint while
    // the legitimate approval is in flight, trying to force a fresh challenge.
    for (let i = 0; i < 3; i++) {
      const attackerRes = makeRes();
      await handler({ method: 'POST', headers: sameOriginHeaders('', '198.51.100.200'), body: { action: 'admin-access-request' } }, attackerRes);
      assert.equal(attackerRes.body.success, false, 'a live approved challenge must never be preempted by a new request');
    }
    assert.equal(db.__row().state, 'approved', 'the legitimate approval must survive the attacker\'s spam');
    assert.equal(bot.sentMessages.length, 1, 'no extra Telegram messages were sent to the admin because of the attack');

    // The legitimate browser can still consume its own original challenge.
    const consumeRes = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders('ac_chal=' + legitChal), body: { action: 'admin-access-poll', requestRef: legitRef } }, consumeRes);
    assert.equal(consumeRes.body.success, true);
    assert.equal(consumeRes.body.state, 'approved');
  });
});

test('throttling does not change Telegram identity verification or browser binding', async function () {
  await withEnv(async function () {
    const adminAccess = require('../lib/admin-access');
    const db = createFakeAdminAccessDb({ adminTelegramUserId: 999 });
    const bot = makeBot();
    const handler = requireApiWithFakes(db, bot);

    const legit = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders('', '203.0.113.77'), body: { action: 'admin-access-request' } }, legit);
    const requestRef = legit.body.requestRef;
    const bindingHashBefore = db.__row().browser_binding_hash;

    // Throttled attacker call from another IP touches nothing on the live row.
    const attackerRes = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders('', '203.0.113.78'), body: { action: 'admin-access-request' } }, attackerRes);
    assert.equal(attackerRes.body.success, false);
    assert.equal(db.__row().browser_binding_hash, bindingHashBefore, 'browser binding must be untouched by throttling');

    // Wrong Telegram identity is still rejected exactly as before hardening.
    const result = await adminAccess.handleAdminAccessUpdate({
      update_id: 777,
      callback_query: {
        id: 'cb-throttle-identity',
        data: adminAccess.CALLBACK_APPROVE_PREFIX + requestRef,
        from: { id: 123456 }, // not the bound admin id (999)
        message: { message_id: 1, chat: { id: 555 } }
      }
    }, { db: db, bot: bot });
    assert.equal(result.outcome, 'admin_access_identity_mismatch');
    assert.equal(db.__row().state, 'pending');
  });
});

test('migration is additive-only, RLS-enabled, service-role-only, and never stores a raw browser binding', function () {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'admin-telegram-access-migration.sql'), 'utf8');

  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.admin_access_requests/);
  assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|ALTER TABLE public\.app_users|ALTER TABLE public\.app_user_telegram_verifications/);
  assert.match(sql, /ALTER TABLE public\.admin_access_requests ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON public\.admin_access_requests FROM anon, authenticated/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.create_admin_access_request\([^)]*\) FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.consume_admin_access_request\([^)]*\) FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.create_admin_access_request\([^)]*\) TO service_role/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.consume_admin_access_request\([^)]*\) TO service_role/);
  // browser_binding_hash is the only browser-binding column — no raw/plaintext sibling column.
  assert.match(sql, /browser_binding_hash\s+text NOT NULL/);
  assert.doesNotMatch(sql, /browser_binding\s+text/);
  // Every state-mutating RPC takes a row lock before mutating it.
  assert.match(sql, /FOR UPDATE/);
});

test('a new admin-access request never preempts a live one, and a rate-limited IP is checked before touching any existing row', function () {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'admin-telegram-access-migration.sql'), 'utf8');
  const fn = sql.slice(sql.indexOf('FUNCTION public.create_admin_access_request'), sql.indexOf('FUNCTION public.record_admin_access_message'));
  assert.match(fn, /p_ip_hash/);
  assert.match(fn, /ip_throttled/);
  assert.match(fn, /state IN \('pending','approved'\)\s*\n\s*AND expires_at > now\(\)/);
  // The IP-window check must appear before the live-row/no-preemption check.
  const ipCheckIdx = fn.indexOf('ip_throttled');
  const liveCheckIdx = fn.indexOf("state IN ('pending','approved')\n     AND expires_at > now()");
  assert.ok(ipCheckIdx !== -1 && liveCheckIdx !== -1 && ipCheckIdx < liveCheckIdx);
});

test('session issuance re-checks blocked/approved status and the Telegram binding immediately before consuming', function () {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'admin-telegram-access-migration.sql'), 'utf8');
  const fn = sql.slice(sql.indexOf('FUNCTION public.consume_admin_access_request'));
  assert.match(fn, /is_blocked IS DISTINCT FROM TRUE\s*\n\s*AND is_approved IS TRUE/);
  assert.match(fn, /v\.telegram_user_id = v_request\.telegram_user_id/);
  assert.match(fn, /v\.telegram_verified_at IS NOT NULL/);
});
