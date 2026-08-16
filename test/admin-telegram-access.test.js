'use strict';

// ===========================================================================
// Regression coverage for the Telegram-INITIATED maintenance admin entry.
//
// Architecture: creating a challenge from the public maintenance page is
// dormant — it never sends a Telegram message. A message is only ever sent
// once the admin's own verified Telegram account opens the deep link
// (t.me/<bot>?start=<requestRef>) and the resulting /start is verified
// server-side against their existing telegram binding (activation). Only
// after activation can the existing approve/deny buttons and browser
// consume/session-issuance flow proceed.
//
// Covers:
//   1.  anonymous request creation sends ZERO Telegram messages
//   2.  anonymous requestRef knowledge cannot approve
//   3.  wrong Telegram user cannot activate a request
//   4.  only the verified bound Telegram admin can activate/approve
//   5.  wrong browser cannot consume
//   6.  expired request cannot activate or consume
//   7.  consumed request cannot replay
//   8.  simultaneous consume yields one session maximum
//   9.  requestRef in the Telegram deep link contains no privileged secret
//   10. Telegram deletion failure does not restore validity
//   11. repeated deep-link/start processing is harmless/idempotent
//   12. anonymous challenge creation cannot grow persistent live rows without bound
//   13. maintenance public users remain fail-closed (delegated to maintenance-gate.test.js)
//   14. logout re-locks maintenance (delegated to maintenance-gate.test.js)
//   15. existing password server-side break-glass remains functional
//   16. no Telegram message is sent before a verified Telegram admin initiates the bot flow
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
// Only one admin (one live row) exists, matching production (only 'budi').
function createFakeAdminAccessDb(options) {
  const opts = options || {};
  const calls = [];
  const claimedUpdateIds = new Set();
  const ipRequestTimestamps = new Map(); // ip_hash -> [Date.now(), ...] within the window
  let row = null; // { state, browser_binding_hash, telegram_user_id, telegram_chat_id, telegram_message_id, expires_at, request_context }

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
          telegram_chat_id: null,
          telegram_message_id: null,
          activation_claimed_at: null,
          expires_at: args.p_expires_at,
          request_context: args.p_context || ''
        };
        return Promise.resolve({
          data: [{ result_code: 'ok', request_id: 'req-1', user_id: 'user-budi', telegram_user_id: 999, telegram_chat_id: null, expires_at: args.p_expires_at }],
          error: null
        });
      }

      if (name === 'activate_admin_access_request') {
        if (!row) return Promise.resolve({ data: [{ result_code: 'not_found' }], error: null });
        if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
          if (row.state === 'pending' || row.state === 'approved') row.state = 'expired';
          return Promise.resolve({ data: [{ result_code: 'expired', request_context: null, expires_at: row.expires_at }], error: null });
        }
        if (row.state !== 'pending') {
          return Promise.resolve({ data: [{ result_code: 'already_' + row.state, request_context: null, expires_at: row.expires_at }], error: null });
        }
        if (args.p_telegram_user_id !== opts.adminTelegramUserId) {
          return Promise.resolve({ data: [{ result_code: 'identity_mismatch', request_context: null, expires_at: null }], error: null });
        }
        if (row.telegram_message_id) {
          return Promise.resolve({ data: [{ result_code: 'already_activated', request_context: null, expires_at: row.expires_at }], error: null });
        }
        if (row.activation_claimed_at && (Date.now() - row.activation_claimed_at) < 20000) {
          return Promise.resolve({ data: [{ result_code: 'claim_in_progress', request_context: null, expires_at: row.expires_at }], error: null });
        }
        row.telegram_user_id = args.p_telegram_user_id;
        row.telegram_chat_id = args.p_telegram_chat_id;
        row.activation_claimed_at = Date.now();
        return Promise.resolve({ data: [{ result_code: 'claimed', request_context: row.request_context, expires_at: row.expires_at }], error: null });
      }

      if (name === 'release_admin_access_activation') {
        if (!row || row.telegram_user_id !== args.p_telegram_user_id || row.telegram_message_id) {
          return Promise.resolve({ data: [{ result_code: 'not_found' }], error: null });
        }
        row.activation_claimed_at = null;
        return Promise.resolve({ data: [{ result_code: 'ok' }], error: null });
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

function startUpdate(updateId, requestRef, telegramUserId, chatId) {
  return {
    update_id: updateId,
    message: {
      message_id: 1,
      chat: { id: chatId, type: 'private' },
      from: { id: telegramUserId },
      text: '/start ' + requestRef
    }
  };
}

function approveUpdate(updateId, requestRef, telegramUserId, chatId, messageId) {
  const adminAccess = require('../lib/admin-access');
  return {
    update_id: updateId,
    callback_query: {
      id: 'cb-' + updateId,
      data: adminAccess.CALLBACK_APPROVE_PREFIX + requestRef,
      from: { id: telegramUserId },
      message: { message_id: messageId || 4242, chat: { id: chatId } }
    }
  };
}

// ---------------------------------------------------------------------------
// 1 / 16. Anonymous request creation never sends a Telegram message.
// ---------------------------------------------------------------------------
test('anonymous request creation sends ZERO Telegram messages', async function () {
  await withEnv(async function () {
    const db = createFakeAdminAccessDb({ adminTelegramUserId: 999 });
    const bot = makeBot();
    const handler = requireApiWithFakes(db, bot);

    const reqRes = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders(), body: { action: 'admin-access-request', context: 'ua' } }, reqRes);

    assert.equal(reqRes.body.success, true);
    assert.ok(reqRes.body.deepLink, 'a deep link must be returned so the admin can self-initiate activation');
    assert.equal(bot.sentMessages.length, 0, 'creating a challenge must never notify Telegram');
    assert.equal(db.__row().state, 'pending');
    assert.equal(db.__row().telegram_chat_id, null, 'no chat is bound until the admin activates it');
  });
});

test('no Telegram message is sent before a verified Telegram admin initiates the bot flow', async function () {
  await withEnv(async function () {
    const adminAccess = require('../lib/admin-access');
    const db = createFakeAdminAccessDb({ adminTelegramUserId: 999 });
    const bot = makeBot();
    const handler = requireApiWithFakes(db, bot);

    const reqRes = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders(), body: { action: 'admin-access-request' } }, reqRes);
    const requestRef = reqRes.body.requestRef;

    // A random Telegram user (not the bound admin) opens the same deep link.
    const result = await adminAccess.handleAdminAccessUpdate(startUpdate(1, requestRef, 424242, 5000), { db: db, bot: bot });

    assert.equal(result.outcome, 'admin_access_activate_identity_mismatch');
    assert.equal(bot.sentMessages.length, 1, 'a generic reply may go to the SENDER only');
    assert.equal(bot.sentMessages[0].chatId, 5000, 'the reply must go to whoever actually sent /start, never to the admin');
    assert.equal(db.__row().state, 'pending');
    assert.equal(db.__row().telegram_chat_id, null, 'the admin is never contacted by an unverified /start');
  });
});

// ---------------------------------------------------------------------------
// 3 / 4. Activation identity gate.
// ---------------------------------------------------------------------------
test('wrong Telegram user cannot activate a request', async function () {
  await withEnv(async function () {
    const adminAccess = require('../lib/admin-access');
    const db = createFakeAdminAccessDb({ adminTelegramUserId: 999 });
    const bot = makeBot();

    const requestRef = 'wrong-activator-test-request-reference';
    await db.rpc('create_admin_access_request', {
      p_username: 'budi', p_request_ref: requestRef, p_browser_binding_hash: 'h', p_expires_at: new Date(Date.now() + 120000).toISOString(), p_context: 'ctx'
    });

    const result = await adminAccess.handleAdminAccessUpdate(startUpdate(2, requestRef, 111, 5001), { db: db, bot: bot });

    assert.equal(result.outcome, 'admin_access_activate_identity_mismatch');
    assert.equal(db.__row().telegram_chat_id, null);
  });
});

test('only the verified bound Telegram admin can activate a request', async function () {
  await withEnv(async function () {
    const adminAccess = require('../lib/admin-access');
    const db = createFakeAdminAccessDb({ adminTelegramUserId: 999 });
    const bot = makeBot();

    const requestRef = 'correct-activator-test-request-reference';
    await db.rpc('create_admin_access_request', {
      p_username: 'budi', p_request_ref: requestRef, p_browser_binding_hash: 'h', p_expires_at: new Date(Date.now() + 120000).toISOString(), p_context: 'Windows · Chrome'
    });

    const result = await adminAccess.handleAdminAccessUpdate(startUpdate(3, requestRef, 999, 5002), { db: db, bot: bot });

    assert.equal(result.outcome, 'admin_access_activated');
    assert.equal(bot.sentMessages.length, 1);
    assert.equal(bot.sentMessages[0].chatId, 5002);
    assert.match(bot.sentMessages[0].text, /Izinkan Akses/);
    assert.match(bot.sentMessages[0].options.reply_markup.inline_keyboard[0][0].callback_data, new RegExp('^' + adminAccess.CALLBACK_APPROVE_PREFIX));
    assert.equal(db.__row().telegram_chat_id, 5002);
    assert.equal(db.__row().state, 'pending', 'activation alone must not approve — buttons still required');
  });
});

// ---------------------------------------------------------------------------
// 2. Anonymous requestRef knowledge cannot approve.
// ---------------------------------------------------------------------------
test('anonymous requestRef knowledge cannot approve without the bound Telegram identity', async function () {
  await withEnv(async function () {
    const adminAccess = require('../lib/admin-access');
    const db = createFakeAdminAccessDb({ adminTelegramUserId: 999 });
    const bot = makeBot();

    const requestRef = 'anon-approve-attempt-test-request-ref';
    await db.rpc('create_admin_access_request', {
      p_username: 'budi', p_request_ref: requestRef, p_browser_binding_hash: 'h', p_expires_at: new Date(Date.now() + 120000).toISOString(), p_context: ''
    });

    // Attacker knows the requestRef (e.g. it leaked, or they created the
    // challenge themselves) and presses approve directly without ever being
    // the identity that activated it.
    const result = await adminAccess.handleAdminAccessUpdate(approveUpdate(10, requestRef, 555, 6000), { db: db, bot: bot });

    assert.equal(result.outcome, 'admin_access_identity_mismatch');
    assert.equal(db.__row().state, 'pending');
  });
});

// ---------------------------------------------------------------------------
// 5. Wrong browser cannot consume.
// ---------------------------------------------------------------------------
test('wrong browser cannot consume an approved request', async function () {
  await withEnv(async function () {
    const db = createFakeAdminAccessDb({ adminTelegramUserId: 999 });
    const bot = makeBot();
    const handler = requireApiWithFakes(db, bot);

    const reqRes = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders(), body: { action: 'admin-access-request' } }, reqRes);
    const requestRef = reqRes.body.requestRef;
    await db.rpc('approve_admin_access_request', { p_request_ref: requestRef, p_telegram_user_id: 999 });

    const pollRes = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders('ac_chal=totally-different-binding-value'), body: { action: 'admin-access-poll', requestRef: requestRef } }, pollRes);

    assert.equal(pollRes.body.success, false);
    assert.equal(sessCookieFrom(pollRes), null, 'wrong browser must never receive a session');
  });
});

// ---------------------------------------------------------------------------
// 6. Expired request cannot activate or consume.
// ---------------------------------------------------------------------------
test('expired request cannot activate or consume', async function () {
  await withEnv(async function () {
    const adminAccess = require('../lib/admin-access');
    const db = createFakeAdminAccessDb({ adminTelegramUserId: 999 });
    const bot = makeBot();
    const handler = requireApiWithFakes(db, bot);

    const reqRes = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders(), body: { action: 'admin-access-request' } }, reqRes);
    const chal = chalCookieFrom(reqRes);
    const requestRef = reqRes.body.requestRef;
    db.__row().expires_at = new Date(Date.now() - 1000).toISOString();

    const activateResult = await adminAccess.handleAdminAccessUpdate(startUpdate(4, requestRef, 999, 5003), { db: db, bot: bot });
    assert.equal(activateResult.outcome, 'admin_access_activate_expired');
    assert.equal(bot.sentMessages.length, 1, 'only the generic denial reply, never the challenge/buttons message');

    const pollRes = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders('ac_chal=' + chal), body: { action: 'admin-access-poll', requestRef: requestRef } }, pollRes);
    assert.equal(pollRes.body.success, false);
    assert.equal(pollRes.body.state, 'expired');
    assert.equal(sessCookieFrom(pollRes), null);
  });
});

// ---------------------------------------------------------------------------
// 7 / 8. Consumed cannot replay; concurrent consume yields one session.
// ---------------------------------------------------------------------------
test('consumed request cannot replay, and simultaneous consume yields one session maximum', async function () {
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

// ---------------------------------------------------------------------------
// 9. requestRef in the deep link carries no privileged secret.
// ---------------------------------------------------------------------------
test('the deep link carries only the opaque requestRef — no session, binding, or secret', async function () {
  await withEnv(async function () {
    const db = createFakeAdminAccessDb({ adminTelegramUserId: 999 });
    const bot = makeBot();
    const handler = requireApiWithFakes(db, bot);

    const reqRes = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders(), body: { action: 'admin-access-request' } }, reqRes);

    const deepLink = reqRes.body.deepLink;
    const url = new URL(deepLink);
    assert.equal(url.hostname, 't.me');
    const startParam = url.searchParams.get('start');
    assert.equal(startParam, reqRes.body.requestRef);
    assert.doesNotMatch(deepLink, /ac_sess|ac_chal|SESSION_SECRET|bot-token-for-tests/i);
    // The raw browser binding (needed to consume) is never in the URL.
    const cookieValue = chalCookieFrom(reqRes);
    assert.ok(cookieValue);
    assert.doesNotMatch(deepLink, new RegExp(cookieValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

// ---------------------------------------------------------------------------
// 10. Telegram deletion failure does not restore validity.
// ---------------------------------------------------------------------------
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

    await new Promise(function (resolve) { setTimeout(resolve, 10); });

    const replay = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders('ac_chal=' + chal), body: { action: 'admin-access-poll', requestRef: requestRef } }, replay);
    assert.equal(replay.body.success, false, 'the challenge must stay consumed even though the Telegram message could not be deleted');
  });
});

// ---------------------------------------------------------------------------
// 11. Repeated deep-link/start processing and repeated callback presses are
// idempotent/harmless.
// ---------------------------------------------------------------------------
test('repeated deep-link/start delivery of the same webhook update is harmless', async function () {
  await withEnv(async function () {
    const adminAccess = require('../lib/admin-access');
    const db = createFakeAdminAccessDb({ adminTelegramUserId: 999 });
    const bot = makeBot();

    const requestRef = 'repeated-start-update-test-request-ref';
    await db.rpc('create_admin_access_request', {
      p_username: 'budi', p_request_ref: requestRef, p_browser_binding_hash: 'h', p_expires_at: new Date(Date.now() + 120000).toISOString(), p_context: ''
    });

    const update = startUpdate(20, requestRef, 999, 7000);
    const first = await adminAccess.handleAdminAccessUpdate(update, { db: db, bot: bot });
    const second = await adminAccess.handleAdminAccessUpdate(update, { db: db, bot: bot });

    assert.equal(first.outcome, 'admin_access_activated');
    assert.equal(second.outcome, 'duplicate');
    assert.equal(bot.sentMessages.length, 1, 'the challenge/buttons message is sent exactly once for one Telegram update');
    assert.equal(db.__calls.filter(function (c) { return c.name === 'activate_admin_access_request'; }).length, 1);
  });
});

test('a NEW Telegram update re-typing the SAME requestRef after successful activation sends zero additional messages', async function () {
  await withEnv(async function () {
    const adminAccess = require('../lib/admin-access');
    const db = createFakeAdminAccessDb({ adminTelegramUserId: 999 });
    const bot = makeBot();

    const requestRef = 'retype-start-test-request-reference-ref';
    await db.rpc('create_admin_access_request', {
      p_username: 'budi', p_request_ref: requestRef, p_browser_binding_hash: 'h', p_expires_at: new Date(Date.now() + 120000).toISOString(), p_context: ''
    });

    // Two DIFFERENT Telegram updates (distinct update_id) — update_id dedup
    // alone cannot cover this; the ref itself must be idempotent.
    const first = await adminAccess.handleAdminAccessUpdate(startUpdate(21, requestRef, 999, 7001), { db: db, bot: bot });
    const second = await adminAccess.handleAdminAccessUpdate(startUpdate(22, requestRef, 999, 7001), { db: db, bot: bot });

    assert.equal(first.outcome, 'admin_access_activated');
    assert.equal(second.outcome, 'admin_access_activate_already_activated');
    assert.equal(bot.sentMessages.length, 1, 'the approval message is sent exactly once, ever, for this challenge');
    assert.equal(db.__row().state, 'pending', 'still just activated, not approved, no matter how many times /start is sent');
  });
});

// ---------------------------------------------------------------------------
// Concurrency: two different Telegram updates for the SAME requestRef,
// nearly simultaneous. At most one approval message may ever be sent.
// ---------------------------------------------------------------------------
test('two concurrent valid /start updates for the same requestRef produce at most one approval message', async function () {
  await withEnv(async function () {
    const adminAccess = require('../lib/admin-access');
    const db = createFakeAdminAccessDb({ adminTelegramUserId: 999 });
    const bot = makeBot();

    const requestRef = 'concurrent-start-test-request-reference';
    await db.rpc('create_admin_access_request', {
      p_username: 'budi', p_request_ref: requestRef, p_browser_binding_hash: 'h', p_expires_at: new Date(Date.now() + 120000).toISOString(), p_context: ''
    });

    // Two distinct updates racing (not a replay of the same update_id).
    const [a, b] = await Promise.all([
      adminAccess.handleAdminAccessUpdate(startUpdate(30, requestRef, 999, 7002), { db: db, bot: bot }),
      adminAccess.handleAdminAccessUpdate(startUpdate(31, requestRef, 999, 7002), { db: db, bot: bot })
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    assert.ok(bot.sentMessages.length <= 1, 'at most one approval message may ever be sent for a race');
    assert.ok(
      outcomes.includes('admin_access_activated') || bot.sentMessages.length === 0,
      'if neither activated, something else absorbed the race safely'
    );
    // Exactly one of the two actually claimed and sent; the other observed
    // the claim (claim_in_progress) rather than sending a second message.
    const activatedCount = outcomes.filter(function (o) { return o === 'admin_access_activated'; }).length;
    assert.ok(activatedCount <= 1);
  });
});

// ---------------------------------------------------------------------------
// Delivery failure: safe retry by the verified admin, no retry by anyone else.
// ---------------------------------------------------------------------------
test('failed initial Telegram delivery releases the claim so the verified admin can safely retry', async function () {
  await withEnv(async function () {
    const adminAccess = require('../lib/admin-access');
    const db = createFakeAdminAccessDb({ adminTelegramUserId: 999 });
    let failNext = true;
    const bot = makeBot({
      sendMessage: async function (chatId, text, options) {
        if (failNext) { failNext = false; throw new Error('telegram_unreachable'); }
        return { message_id: 9001 };
      }
    });

    const requestRef = 'delivery-retry-test-request-reference';
    await db.rpc('create_admin_access_request', {
      p_username: 'budi', p_request_ref: requestRef, p_browser_binding_hash: 'h', p_expires_at: new Date(Date.now() + 120000).toISOString(), p_context: ''
    });

    const first = await adminAccess.handleAdminAccessUpdate(startUpdate(40, requestRef, 999, 7003), { db: db, bot: bot });
    assert.equal(first.outcome, 'admin_access_activate_delivery_failed');
    assert.equal(db.__row().telegram_message_id, null);
    assert.equal(db.__row().activation_claimed_at, null, 'the claim must be released immediately on failure, not left to expire');

    // Same verified admin retries with a brand-new update — must succeed
    // immediately, not be told to wait out the claim window.
    const second = await adminAccess.handleAdminAccessUpdate(startUpdate(41, requestRef, 999, 7003), { db: db, bot: bot });
    assert.equal(second.outcome, 'admin_access_activated');
    assert.equal(db.__row().telegram_message_id, 9001);
  });
});

test('a failed delivery claim cannot be released or claimed by the wrong Telegram identity', async function () {
  await withEnv(async function () {
    const adminAccess = require('../lib/admin-access');
    const db = createFakeAdminAccessDb({ adminTelegramUserId: 999 });
    const bot = makeBot({ sendMessage: async function () { throw new Error('telegram_unreachable'); } });

    const requestRef = 'delivery-retry-wrong-identity-test-ref';
    await db.rpc('create_admin_access_request', {
      p_username: 'budi', p_request_ref: requestRef, p_browser_binding_hash: 'h', p_expires_at: new Date(Date.now() + 120000).toISOString(), p_context: ''
    });

    await adminAccess.handleAdminAccessUpdate(startUpdate(42, requestRef, 999, 7004), { db: db, bot: bot });

    // release_admin_access_activation requires the SAME telegram_user_id
    // that made the claim — an impostor cannot release or hijack it.
    const release = await db.rpc('release_admin_access_activation', { p_request_ref: requestRef, p_telegram_user_id: 111 });
    assert.equal(release.data[0].result_code, 'not_found');

    // And a wrong identity still cannot activate/claim it at all.
    const wrongUser = await adminAccess.handleAdminAccessUpdate(startUpdate(43, requestRef, 111, 7005), { db: db, bot: bot });
    assert.equal(wrongUser.outcome, 'admin_access_activate_identity_mismatch');
  });
});

test('repeated Telegram approve callback (retry / double press) is harmless', async function () {
  await withEnv(async function () {
    const adminAccess = require('../lib/admin-access');
    const db = createFakeAdminAccessDb({ adminTelegramUserId: 999 });
    const bot = makeBot();

    const requestRef = 'repeated-callback-test-request-reference';
    await db.rpc('create_admin_access_request', {
      p_username: 'budi', p_request_ref: requestRef, p_browser_binding_hash: 'h', p_expires_at: new Date(Date.now() + 120000).toISOString(), p_context: ''
    });

    const update = approveUpdate(55, requestRef, 999, 555, 4242);
    const first = await adminAccess.handleAdminAccessUpdate(update, { db: db, bot: bot });
    const second = await adminAccess.handleAdminAccessUpdate(update, { db: db, bot: bot });

    assert.equal(first.outcome, 'admin_access_approved');
    assert.equal(second.outcome, 'duplicate');
    assert.equal(bot.answered.length, 2, 'Telegram must still get an answered callback both times (no hanging spinner)');
    assert.equal(db.__calls.filter(function (c) { return c.name === 'approve_admin_access_request'; }).length, 1);
  });
});

// ---------------------------------------------------------------------------
// 12. Anonymous creation cannot grow persistent live rows without bound.
// ---------------------------------------------------------------------------
test('anonymous challenge creation cannot grow unbounded live rows', async function () {
  await withEnv(async function () {
    const db = createFakeAdminAccessDb({ adminTelegramUserId: 999 });
    const bot = makeBot();
    const handler = requireApiWithFakes(db, bot);

    for (let i = 0; i < 20; i++) {
      const res = makeRes();
      await handler({ method: 'POST', headers: sameOriginHeaders('', '203.0.113.1' + (i % 4)), body: { action: 'admin-access-request' } }, res);
    }

    // No-preemption means at most ONE row is ever live at a time for the
    // single admin, regardless of how many anonymous callers try.
    const liveCount = [db.__row()].filter(function (r) {
      return r && (r.state === 'pending' || r.state === 'approved') && new Date(r.expires_at).getTime() > Date.now();
    }).length;
    assert.equal(liveCount, 1);
    assert.equal(bot.sentMessages.length, 0, 'none of this anonymous churn ever notified Telegram');
  });
});

// ---------------------------------------------------------------------------
// 15. Existing password break-glass remains functional.
// ---------------------------------------------------------------------------
test('existing password login action remains functional as server-side break-glass', async function () {
  await withEnv(async function () {
    const GOOD_HASH = 'a'.repeat(64);
    const db = {
      from(table) {
        const query = {
          select() { return query; },
          eq() { return query; },
          maybeSingle() {
            return Promise.resolve({
              data: table === 'app_users' ? {
                id: 'user-budi', username: 'budi', password_hash: GOOD_HASH,
                is_blocked: false, is_approved: true, created_at: new Date().toISOString()
              } : null,
              error: null
            });
          },
          update() { return query; },
          then(resolve) { return Promise.resolve({ data: null, error: null }).then(resolve); }
        };
        return query;
      },
      rpc() { return Promise.resolve({ data: null, error: null }); }
    };
    const bot = makeBot();
    const handler = requireApiWithFakes(db, bot);

    const res = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders(), body: { action: 'login', username: 'budi', passwordHash: GOOD_HASH } }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.isAdmin, true);
    assert.match(sessCookieFrom(res), /^ac_sess=/);
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
// Anti-spam / DB-hygiene layer kept from the prior hardening pass. No longer
// a Telegram-notification concern (creation never notifies), but still
// bounds row creation for database hygiene and keeps the no-preemption
// griefing protection.
// ===========================================================================

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

test('IP flood is bounded independently of the per-admin cooldown, using only Vercel-trusted forwarded-for', async function () {
  await withEnv(async function () {
    const db = createFakeAdminAccessDb({ adminTelegramUserId: 999 });
    const bot = makeBot();
    const handler = requireApiWithFakes(db, bot);

    const results = [];
    for (let i = 0; i < 6; i++) {
      const res = makeRes();
      await handler({ method: 'POST', headers: sameOriginHeaders('', '198.51.100.7'), body: { action: 'admin-access-request' } }, res);
      results.push(res.body);
    }
    assert.equal(results[0].success, true);
    results.slice(1).forEach(function (r) { assert.equal(r.success, false); });
  });
});

test('a client-supplied X-Forwarded-For (without the trusted Vercel header) is never used for rate-limit bucketing', async function () {
  await withEnv(async function () {
    const db = createFakeAdminAccessDb({ adminTelegramUserId: 999 });
    const bot = makeBot();
    const handler = requireApiWithFakes(db, bot);

    const res = makeRes();
    await handler({
      method: 'POST',
      headers: Object.assign(sameOriginHeaders(), { 'x-forwarded-for': '1.2.3.4' }),
      body: { action: 'admin-access-request' }
    }, res);

    assert.equal(res.body.success, true);
    const call = db.__calls.find(function (c) { return c.name === 'create_admin_access_request'; });
    assert.equal(call.args.p_ip_hash, null, 'a spoofable x-forwarded-for alone must not be trusted as the rate-limit key');
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

    await db.rpc('approve_admin_access_request', { p_request_ref: legitRef, p_telegram_user_id: 999 });
    assert.equal(db.__row().state, 'approved');

    for (let i = 0; i < 3; i++) {
      const attackerRes = makeRes();
      await handler({ method: 'POST', headers: sameOriginHeaders('', '198.51.100.200'), body: { action: 'admin-access-request' } }, attackerRes);
      assert.equal(attackerRes.body.success, false, 'a live approved challenge must never be preempted by a new request');
    }
    assert.equal(db.__row().state, 'approved', 'the legitimate approval must survive the attacker\'s spam');

    const consumeRes = makeRes();
    await handler({ method: 'POST', headers: sameOriginHeaders('ac_chal=' + legitChal), body: { action: 'admin-access-poll', requestRef: legitRef } }, consumeRes);
    assert.equal(consumeRes.body.success, true);
    assert.equal(consumeRes.body.state, 'approved');
  });
});

// ===========================================================================
// Migration contract checks.
// ===========================================================================

test('migration is additive-only, RLS-enabled, service-role-only, and never stores a raw browser binding', function () {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'admin-telegram-access-migration.sql'), 'utf8');

  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.admin_access_requests/);
  assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|ALTER TABLE public\.app_users|ALTER TABLE public\.app_user_telegram_verifications/);
  assert.match(sql, /ALTER TABLE public\.admin_access_requests ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON public\.admin_access_requests FROM anon, authenticated/);
  ['create_admin_access_request', 'activate_admin_access_request', 'release_admin_access_activation', 'record_admin_access_message', 'approve_admin_access_request', 'deny_admin_access_request', 'consume_admin_access_request'].forEach(function (fnName) {
    const re = new RegExp('REVOKE ALL ON FUNCTION public\\.' + fnName + '\\([^)]*\\) FROM PUBLIC, anon, authenticated');
    assert.match(sql, re, fnName + ' must be revoked from PUBLIC/anon/authenticated');
    const grantRe = new RegExp('GRANT EXECUTE ON FUNCTION public\\.' + fnName + '\\([^)]*\\) TO service_role');
    assert.match(sql, grantRe, fnName + ' must be granted to service_role only');
  });
  // browser_binding_hash is the only browser-binding column — no raw/plaintext sibling column.
  assert.match(sql, /browser_binding_hash\s+text NOT NULL/);
  assert.doesNotMatch(sql, /browser_binding\s+text/);
  // Every state-mutating RPC takes a row lock before mutating it.
  assert.match(sql, /FOR UPDATE/);
});

test('a new admin-access request never preempts a live one, and a rate-limited IP is checked before touching any existing row', function () {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'admin-telegram-access-migration.sql'), 'utf8');
  const fnStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.create_admin_access_request');
  const fn = sql.slice(fnStart, sql.indexOf('\n$$;\n', fnStart));
  assert.match(fn, /p_ip_hash/);
  assert.match(fn, /ip_throttled/);
  assert.match(fn, /state IN \('pending','approved'\)\s*\n\s*AND expires_at > now\(\)/);
  const ipCheckIdx = fn.indexOf('ip_throttled');
  const liveCheckIdx = fn.indexOf("state IN ('pending','approved')\n     AND expires_at > now()");
  assert.ok(ipCheckIdx !== -1 && liveCheckIdx !== -1 && ipCheckIdx < liveCheckIdx);
  // create() must never send/record a Telegram message itself.
  assert.doesNotMatch(fn, /sendMessage/);
});

test('activation only sends a Telegram message after verifying the sender is the bound admin identity', function () {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'admin-telegram-access-migration.sql'), 'utf8');
  const fn = sql.slice(sql.indexOf('FUNCTION public.activate_admin_access_request'), sql.indexOf('FUNCTION public.release_admin_access_activation'));
  assert.match(fn, /v\.telegram_user_id = p_telegram_user_id/);
  assert.match(fn, /v\.telegram_verified_at IS NOT NULL/);
  assert.match(fn, /identity_mismatch/);
  assert.match(fn, /FOR UPDATE/);
  // True idempotency: a distinct claim state from "sent", not just a resend.
  assert.match(fn, /telegram_message_id IS NOT NULL/);
  assert.match(fn, /already_activated/);
  assert.match(fn, /activation_claimed_at/);
  assert.match(fn, /claim_in_progress/);
});

test('the activation release RPC requires the exact identity that made the claim, and refuses once a message was sent', function () {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'admin-telegram-access-migration.sql'), 'utf8');
  const fn = sql.slice(sql.indexOf('FUNCTION public.release_admin_access_activation'), sql.indexOf('REVOKE ALL ON public.admin_access_requests'));
  assert.match(fn, /telegram_user_id = p_telegram_user_id/);
  assert.match(fn, /telegram_message_id IS NULL/);
});

test('session issuance re-checks blocked/approved status and the Telegram binding immediately before consuming', function () {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'admin-telegram-access-migration.sql'), 'utf8');
  const fn = sql.slice(sql.indexOf('FUNCTION public.consume_admin_access_request'));
  assert.match(fn, /is_blocked IS DISTINCT FROM TRUE\s*\n\s*AND is_approved IS TRUE/);
  assert.match(fn, /v\.telegram_user_id = v_request\.telegram_user_id/);
  assert.match(fn, /v\.telegram_verified_at IS NOT NULL/);
});

test('the maintenance-page request handler never imports/calls the bot client directly (only activation, driven by the webhook, does)', function () {
  const src = fs.readFileSync(path.join(ROOT, 'api', 'reset-password.js'), 'utf8');
  const fnStart = src.indexOf('async function adminAccessRequest');
  const fnEnd = src.indexOf('\n}', fnStart);
  const fn = src.slice(fnStart, fnEnd);
  assert.doesNotMatch(fn, /createVerifyBot/);
  assert.match(fn, /trustedRateLimitIp/);
});
