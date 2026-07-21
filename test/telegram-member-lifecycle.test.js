'use strict';

// ===========================================================================
// Mocked tests for the additive Telegram member-lifecycle features:
//   - Admin analytics counts + From/To date filters (+ unknown join dates)
//   - 30-day in-bot rating (values 1-5, invalid/duplicate callbacks, button
//     removal, sender-identity validation, idempotency)
//   - Legacy verification reminders (max two, 24h gap, stop after verification,
//     never message unknown members)
//   - Legacy channel announcement (admin-only, safe deep link, double-submit
//     blocked, no mass tagging)
//   - Telegram verify-token isolation for the new libs
//   - Regression guards: existing join gate intact, Approved view intact,
//     Delete User absent, API count == 12.
//
// LOCAL / MOCKED ONLY: no live Telegram, no live Supabase, no secrets/tokens.
// An in-memory model implements the RPC semantics of
// supabase/telegram-member-lifecycle-hotfix.sql closely enough to assert
// behavior; @supabase/supabase-js is stubbed via Module._load for endpoint tests.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const DAY = 24 * 60 * 60 * 1000;

process.env.TELEGRAM_VERIFY_CODE_SECRET = 'unit-test-code-secret-value';
process.env.TELEGRAM_VERIFY_CHANNEL_ID = '-1000000000009';

const tv = require('../lib/telegram-verification');
const lifecycle = require('../lib/telegram-lifecycle');
const analytics = require('../lib/telegram-analytics');

const now = () => Date.now();
const iso = (ms) => new Date(ms).toISOString();
function reserved(name) { return name === 'budi' || name === 'review'; }
function clampLimit(n) { return Math.min(Math.max(n || 50, 1), 500); }

// ---------------------------------------------------------------------------
// In-memory model of the lifecycle RPCs + minimal table reads.
// ---------------------------------------------------------------------------
function makeModelDb() {
  const db = { users: [], verifications: {}, announcements: {}, webhook: {}, _uid: 1 };
  // Timestamps may be seeded as ms numbers or ISO strings; normalize for compares.
  function T(x) { if (x == null) return null; return typeof x === 'number' ? x : Date.parse(x); }

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
      review_requested_at: null, review_submitted_at: null, review_score: null,
      review_request_claim_token: null, review_request_claim_expires_at: null,
      verification_reminder_count: 0, verification_reminded_at: null,
      verification_reminder_claim_token: null, verification_reminder_claim_expires_at: null
    }, v);
    db.verifications[row.user_id] = row;
    return row;
  };
  function newToken() { return 'ctok-' + (db._uid++); }
  function leaseMs(sec) { return now() + (Math.min(Math.max(sec || 120, 10), 3600)) * 1000; }

  function ok(data) { return Promise.resolve({ data: data, error: null }); }

  db.rpc = function (name, args) {
    switch (name) {
      case 'claim_telegram_webhook_update': {
        const id = args.p_update_id;
        if (!db.webhook[id]) { const tok = 'tok-' + (db._uid++); db.webhook[id] = { token: tok, processed: null }; return ok([{ claim_state: 'claimed', processing_token: tok }]); }
        if (db.webhook[id].processed) return ok([{ claim_state: 'already_processed', processing_token: null }]);
        return ok([{ claim_state: 'lease_active', processing_token: null }]);
      }
      case 'complete_telegram_webhook_update': {
        const row = db.webhook[args.p_update_id];
        if (row && !row.processed && row.token === args.p_processing_token) { row.processed = now(); return ok(true); }
        return ok(false);
      }
      case 'record_review_rating': {
        const score = args.p_score;
        if (score == null || score < 1 || score > 5) return ok([{ outcome: 'invalid_score', out_user_id: null }]);
        const v = Object.values(db.verifications).find(function (x) { return x.telegram_user_id === args.p_telegram_user_id; });
        if (!v) return ok([{ outcome: 'not_found', out_user_id: null }]);
        if (!v.telegram_verified_at) return ok([{ outcome: 'ineligible', out_user_id: null }]);
        const u = db.getUser(v.user_id);
        if (!u || u.is_approved !== true || u.is_blocked !== false || reserved(u.username)) return ok([{ outcome: 'ineligible', out_user_id: null }]);
        if (v.review_submitted_at) return ok([{ outcome: 'already_submitted', out_user_id: v.user_id }]);
        v.review_score = score; v.review_submitted_at = now(); if (!v.review_requested_at) v.review_requested_at = now();
        v.review_request_claim_token = null; v.review_request_claim_expires_at = null;
        return ok([{ outcome: 'recorded', out_user_id: v.user_id }]);
      }
      case 'list_due_review_requests': {
        const cutoff = now() - 30 * DAY;
        const rows = Object.values(db.verifications).filter(function (v) {
          if (!v.telegram_verified_at || v.telegram_private_chat_id == null) return false;
          if (v.channel_joined_at == null || T(v.channel_joined_at) > cutoff) return false;
          if (v.review_requested_at || v.review_submitted_at) return false;
          if (v.review_request_claim_expires_at != null && T(v.review_request_claim_expires_at) > now()) return false;
          const u = db.getUser(v.user_id);
          return u && u.is_approved === true && u.is_blocked === false && !reserved(u.username);
        }).map(function (v) { return { user_id: v.user_id, telegram_private_chat_id: v.telegram_private_chat_id }; });
        return ok(rows.slice(0, clampLimit(args.p_limit)));
      }
      // Phase 1: lease only (does NOT set review_requested_at).
      case 'claim_review_request': {
        const v = db.verifications[args.p_user_id];
        const cutoff = now() - 30 * DAY;
        const skip = ok([{ outcome: 'skip', telegram_private_chat_id: null, claim_token: null }]);
        if (!v || !v.telegram_verified_at || v.telegram_private_chat_id == null || v.channel_joined_at == null ||
            T(v.channel_joined_at) > cutoff || v.review_requested_at || v.review_submitted_at) return skip;
        if (v.review_request_claim_expires_at != null && T(v.review_request_claim_expires_at) > now()) return skip;
        const u = db.getUser(v.user_id);
        if (!u || u.is_approved !== true || u.is_blocked !== false || reserved(u.username)) return skip;
        const token = newToken();
        v.review_request_claim_token = token;
        v.review_request_claim_expires_at = leaseMs(args.p_lease_seconds);
        return ok([{ outcome: 'claimed', telegram_private_chat_id: v.telegram_private_chat_id, claim_token: token }]);
      }
      // Phase 2 (success): set review_requested_at + clear lease (owner only).
      case 'commit_review_request': {
        const v = db.verifications[args.p_user_id];
        if (!v || args.p_token == null || v.review_request_claim_token !== args.p_token) return ok([{ outcome: 'stale' }]);
        if (v.review_submitted_at) { v.review_request_claim_token = null; v.review_request_claim_expires_at = null; return ok([{ outcome: 'stale' }]); }
        if (!v.review_requested_at) v.review_requested_at = now();
        v.review_request_claim_token = null; v.review_request_claim_expires_at = null;
        return ok([{ outcome: 'committed' }]);
      }
      // Phase 2 (failure): clear lease only, review_requested_at stays null.
      case 'release_review_request': {
        const v = db.verifications[args.p_user_id];
        if (!v || args.p_token == null || v.review_request_claim_token !== args.p_token) return ok([{ outcome: 'stale' }]);
        v.review_request_claim_token = null; v.review_request_claim_expires_at = null;
        return ok([{ outcome: 'released' }]);
      }
      case 'list_due_verification_reminders': {
        const rows = Object.values(db.verifications).filter(function (v) {
          if (v.telegram_private_chat_id == null || v.telegram_verified_at) return false;
          if (v.verification_reminder_count >= 2) return false;
          if (v.verification_reminder_claim_expires_at != null && T(v.verification_reminder_claim_expires_at) > now()) return false;
          const u = db.getUser(v.user_id);
          if (!u || u.is_blocked !== false || reserved(u.username)) return false;
          if (v.verification_reminder_count === 0) return true;
          if (v.verification_reminder_count === 1) return v.verification_reminded_at != null && T(v.verification_reminded_at) <= now() - DAY;
          return false;
        }).map(function (v) { return { user_id: v.user_id, telegram_private_chat_id: v.telegram_private_chat_id, verification_reminder_count: v.verification_reminder_count }; });
        return ok(rows.slice(0, clampLimit(args.p_limit)));
      }
      // Phase 1: lease only (does NOT increment the delivered counter).
      case 'claim_verification_reminder': {
        const v = db.verifications[args.p_user_id];
        const skip = ok([{ outcome: 'skip', telegram_private_chat_id: null, reminder_count: null, claim_token: null }]);
        if (!v || v.telegram_verified_at || v.telegram_private_chat_id == null || v.verification_reminder_count >= 2) return skip;
        if (v.verification_reminder_claim_expires_at != null && T(v.verification_reminder_claim_expires_at) > now()) return skip;
        if (v.verification_reminder_count === 1 && (v.verification_reminded_at == null || T(v.verification_reminded_at) > now() - DAY)) return skip;
        const u = db.getUser(v.user_id);
        if (!u || u.is_blocked !== false || reserved(u.username)) return skip;
        const token = newToken();
        v.verification_reminder_claim_token = token;
        v.verification_reminder_claim_expires_at = leaseMs(args.p_lease_seconds);
        return ok([{ outcome: 'claimed', telegram_private_chat_id: v.telegram_private_chat_id, reminder_count: v.verification_reminder_count, claim_token: token }]);
      }
      // Phase 2 (success): increment counter + stamp reminded_at + clear lease.
      case 'commit_verification_reminder': {
        const v = db.verifications[args.p_user_id];
        if (!v || args.p_token == null || v.verification_reminder_claim_token !== args.p_token) return ok([{ outcome: 'stale', reminder_count: null }]);
        if (v.verification_reminder_count >= 2) { v.verification_reminder_claim_token = null; v.verification_reminder_claim_expires_at = null; return ok([{ outcome: 'stale', reminder_count: v.verification_reminder_count }]); }
        v.verification_reminder_count += 1; v.verification_reminded_at = now();
        v.verification_reminder_claim_token = null; v.verification_reminder_claim_expires_at = null;
        return ok([{ outcome: 'committed', reminder_count: v.verification_reminder_count }]);
      }
      // Phase 2 (failure): clear lease only, counter untouched.
      case 'release_verification_reminder': {
        const v = db.verifications[args.p_user_id];
        if (!v || args.p_token == null || v.verification_reminder_claim_token !== args.p_token) return ok([{ outcome: 'stale' }]);
        v.verification_reminder_claim_token = null; v.verification_reminder_claim_expires_at = null;
        return ok([{ outcome: 'released' }]);
      }
      case 'claim_legacy_channel_announcement': {
        const key = args.p_key || 'default';
        if (db.announcements[key]) return ok([{ claimed: false, legacy_notice_sent_at: iso(db.announcements[key]) }]);
        db.announcements[key] = now();
        return ok([{ claimed: true, legacy_notice_sent_at: iso(db.announcements[key]) }]);
      }
      default:
        return Promise.resolve({ data: null, error: { code: 'P0001', message: 'unknown rpc ' + name } });
    }
  };

  // Minimal PostgREST-like reader for the analytics endpoint.
  db.from = function (table) {
    const b = { _table: table };
    b.select = function () { return b; };
    b.eq = function () { return b; };
    b.order = function () { return b; };
    b.limit = function () {
      let rows = [];
      if (table === 'app_users') rows = db.users;
      else if (table === 'app_user_telegram_verifications') rows = Object.values(db.verifications);
      return Promise.resolve({ data: rows, error: null });
    };
    return b;
  };

  return db;
}

function makeFakeBot(opts) {
  opts = opts || {};
  const calls = { sendMessage: [], editMessageText: [], editMessageReplyMarkup: [], answerCallbackQuery: [], getChatMember: [] };
  let msgId = 500;
  return {
    calls: calls,
    sendMessage: async function (chatId, text, options) { calls.sendMessage.push({ chatId, text, options }); if (opts.sendThrows) throw new Error('api'); return { message_id: ++msgId }; },
    editMessageText: async function (chatId, messageId, text, options) { calls.editMessageText.push({ chatId, messageId, text, options }); if (opts.editThrows) throw new Error('api'); return {}; },
    editMessageReplyMarkup: async function (chatId, messageId) { calls.editMessageReplyMarkup.push({ chatId, messageId }); return {}; },
    answerCallbackQuery: async function (id, options) { calls.answerCallbackQuery.push({ id, options }); return {}; },
    getChatMember: async function (chatId, userId) { calls.getChatMember.push({ chatId, userId }); return { status: 'member' }; }
  };
}

// ===========================================================================
// 1. Analytics counts + date filters
// ===========================================================================
function analyticsPopulation(nowMs) {
  // Users span registration dates; verifications encode lifecycle state.
  const users = [
    { id: 'u1', username: 'verifiedApprovedJoined30', is_approved: true, is_blocked: false, created_at: iso(nowMs - 40 * DAY) },
    { id: 'u2', username: 'verifiedApprovedJoined10', is_approved: true, is_blocked: false, created_at: iso(nowMs - 20 * DAY) },
    { id: 'u3', username: 'verifiedApprovedUnknownJoin', is_approved: true, is_blocked: false, created_at: iso(nowMs - 60 * DAY) },
    { id: 'u4', username: 'startedNotVerified', is_approved: false, is_blocked: false, created_at: iso(nowMs - 5 * DAY) },
    { id: 'u5', username: 'neverStarted', is_approved: false, is_blocked: false, created_at: iso(nowMs - 2 * DAY) },
    { id: 'u6', username: 'reviewedMember', is_approved: true, is_blocked: false, created_at: iso(nowMs - 90 * DAY) },
    { id: 'budi', username: 'budi', is_approved: true, is_blocked: false, created_at: iso(nowMs - 200 * DAY) }
  ];
  const verifications = [
    { user_id: 'u1', telegram_user_id: 101, telegram_private_chat_id: 1001, telegram_verified_at: iso(nowMs - 39 * DAY), channel_joined_at: iso(nowMs - 35 * DAY) },
    { user_id: 'u2', telegram_user_id: 102, telegram_private_chat_id: 1002, telegram_verified_at: iso(nowMs - 19 * DAY), channel_joined_at: iso(nowMs - 10 * DAY) },
    { user_id: 'u3', telegram_user_id: 103, telegram_private_chat_id: 1003, telegram_verified_at: iso(nowMs - 59 * DAY), channel_joined_at: null },
    { user_id: 'u4', telegram_user_id: 104, telegram_private_chat_id: 1004, telegram_verified_at: null, channel_joined_at: null },
    { user_id: 'u6', telegram_user_id: 106, telegram_private_chat_id: 1006, telegram_verified_at: iso(nowMs - 89 * DAY), channel_joined_at: iso(nowMs - 80 * DAY), review_submitted_at: iso(nowMs - 1 * DAY), review_score: 4, review_requested_at: iso(nowMs - 2 * DAY) }
  ];
  return { users, verifications };
}

test('analytics: counts are derived from server data and exclude reserved accounts', function () {
  const nowMs = now();
  const { users, verifications } = analyticsPopulation(nowMs);
  const a = analytics.computeTelegramAnalytics(users, verifications, { now: iso(nowMs) });

  assert.equal(a.totalUsers, 6, 'budi (reserved) excluded from total');
  assert.equal(a.telegramVerified, 4);      // u1,u2,u3,u6
  assert.equal(a.approved, 4);              // u1,u2,u3,u6
  assert.equal(a.joinedChannel, 3);         // u1,u2,u6
  assert.equal(a.approvedNotJoined, 1);     // u3 (approved, no join recorded)
  assert.equal(a.verificationNotCompleted, 1); // u4 (private chat, not verified)
  assert.equal(a.reviewSubmitted, 1);       // u6
  assert.equal(a.averageReviewScore, 4);    // only u6 -> 4
  assert.equal(a.reviewCount, 1);
});

test('analytics: eligible-for-review counts only members joined >= 30 days ago (known date)', function () {
  const nowMs = now();
  const { users, verifications } = analyticsPopulation(nowMs);
  const a = analytics.computeTelegramAnalytics(users, verifications, { now: iso(nowMs) });
  // u1 joined 35d ago (eligible). u6 joined 80d ago but already submitted (excluded).
  // u2 joined 10d ago (too recent). u3 unknown join date (never eligible).
  assert.equal(a.eligibleForReview, 1);
});

test('analytics: unknown historical join date is surfaced and never invented', function () {
  const nowMs = now();
  const { users, verifications } = analyticsPopulation(nowMs);
  const a = analytics.computeTelegramAnalytics(users, verifications, { now: iso(nowMs) });
  assert.equal(a.joinDateUnknown, 1, 'u3 verified+approved with no channel_joined_at');
  // The unknown-join member must NOT be counted as review-eligible.
  assert.ok(a.eligibleForReview < a.joinedChannel + a.joinDateUnknown);
});

test('analytics: review eligibility triggers at EXACTLY 30 days, not before', function () {
  const nowMs = now();
  const users = [
    { id: 'a', username: 'exactly30', is_approved: true, is_blocked: false, created_at: iso(nowMs - 31 * DAY) },
    { id: 'b', username: 'justUnder30', is_approved: true, is_blocked: false, created_at: iso(nowMs - 31 * DAY) }
  ];
  const verifications = [
    { user_id: 'a', telegram_user_id: 1, telegram_private_chat_id: 11, telegram_verified_at: iso(nowMs - 31 * DAY), channel_joined_at: iso(nowMs - 30 * DAY) },
    { user_id: 'b', telegram_user_id: 2, telegram_private_chat_id: 12, telegram_verified_at: iso(nowMs - 31 * DAY), channel_joined_at: iso(nowMs - 30 * DAY + 60 * 1000) }
  ];
  const a = analytics.computeTelegramAnalytics(users, verifications, { now: iso(nowMs) });
  assert.equal(a.eligibleForReview, 1, 'exactly 30 days is eligible; 30 days minus 1 minute is not');
});

test('analytics: From/To filters restrict by registration date', function () {
  const nowMs = now();
  const { users, verifications } = analyticsPopulation(nowMs);
  // Only include users registered in the last 25 days -> u2 (20d), u4 (5d), u5 (2d).
  const a = analytics.computeTelegramAnalytics(users, verifications, {
    now: iso(nowMs),
    from: iso(nowMs - 25 * DAY),
    to: iso(nowMs + DAY)
  });
  assert.equal(a.totalUsers, 3);
  assert.equal(a.telegramVerified, 1); // only u2 verified in range
  assert.equal(a.range.from != null, true);
  assert.equal(a.range.to != null, true);
});

test('analytics: date-only "to" bound includes the whole day', function () {
  const day = '2026-01-10';
  const users = [
    { id: 'x', username: 'sameDayLate', is_approved: false, is_blocked: false, created_at: '2026-01-10T23:30:00.000Z' }
  ];
  const a = analytics.computeTelegramAnalytics(users, [], { from: '2026-01-01', to: day, now: '2026-02-01T00:00:00.000Z' });
  assert.equal(a.totalUsers, 1, 'a late-in-the-day registration on the "to" date is included');
});

// ===========================================================================
// 2. 30-day rating: values, buttons, message builders
// ===========================================================================
test('rating: parse accepts only 1..5', function () {
  assert.equal(tv.parseRatingScore('rate_1'), 1);
  assert.equal(tv.parseRatingScore('rate_5'), 5);
  assert.equal(tv.parseRatingScore('rate_0'), null);
  assert.equal(tv.parseRatingScore('rate_6'), null);
  assert.equal(tv.parseRatingScore('rate_x'), null);
  assert.equal(tv.parseRatingScore('verify_channel_join'), null);
  assert.equal(tv.parseRatingScore(null), null);
});

test('rating: request message + five star buttons rate_1..rate_5', function () {
  const msg = tv.buildReviewRequestMessage();
  assert.ok(msg.indexOf('Sudah 30 hari bersama Auto-Cuan.') === 0);
  assert.ok(msg.indexOf('Bagaimana pengalaman kamu?') !== -1);
  const kb = tv.reviewRatingButtons().inline_keyboard.flat();
  assert.equal(kb.length, 5);
  kb.forEach(function (b, i) {
    assert.equal(b.callback_data, 'rate_' + (i + 1));
    assert.ok(b.text.indexOf('\u2B50') !== -1);
    assert.ok(!b.url, 'rating buttons are callbacks, not external links');
  });
});

async function seedRatingReady(db, tgId, chatId) {
  const user = db.seedUser({ username: 'member' + tgId, is_approved: true, is_blocked: false });
  db.seedVerification({ user_id: user.id, telegram_user_id: tgId, telegram_private_chat_id: chatId, telegram_verified_at: iso(now() - 40 * DAY), channel_joined_at: iso(now() - 35 * DAY), review_requested_at: iso(now() - DAY) });
  return user;
}

function rateCallback(updateId, tgId, chatId, data) {
  return { update_id: updateId, callback_query: { id: 'cb' + updateId, from: { id: tgId }, message: { message_id: 700, chat: { id: chatId, type: 'private' } }, data: data } };
}

test('rating: valid rating is stored once, thanks the user, and removes the buttons', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  const user = await seedRatingReady(db, 800, 8000);
  const res = await tv.processWebhookUpdate(rateCallback(1, 800, 8000, 'rate_4'), { supabase: db, bot: bot });
  assert.equal(res.outcome, 'rating_recorded');
  assert.equal(db.verifications[user.id].review_score, 4);
  assert.ok(db.verifications[user.id].review_submitted_at);
  // Message edited to a thank-you with an EMPTY inline keyboard (buttons removed).
  const edit = bot.calls.editMessageText[bot.calls.editMessageText.length - 1];
  assert.ok(edit.text.indexOf('Terima kasih') !== -1);
  assert.deepEqual(edit.options.reply_markup, { inline_keyboard: [] });
  // No verification/join side effects.
  assert.equal(bot.calls.getChatMember.length, 0);
});

test('rating: invalid rating callback (rate_0 / rate_6) is rejected and stores nothing', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  const user = await seedRatingReady(db, 801, 8001);
  const r0 = await tv.processWebhookUpdate(rateCallback(2, 801, 8001, 'rate_0'), { supabase: db, bot: bot });
  const r6 = await tv.processWebhookUpdate(rateCallback(3, 801, 8001, 'rate_6'), { supabase: db, bot: bot });
  assert.equal(r0.outcome, 'rating_invalid');
  assert.equal(r6.outcome, 'rating_invalid');
  assert.equal(db.verifications[user.id].review_score, null, 'no score stored for invalid values');
  assert.equal(bot.calls.editMessageText.length, 0, 'no message edit for invalid ratings');
  // Callback is still answered so the spinner never sticks.
  assert.equal(bot.calls.answerCallbackQuery.length, 2);
});

test('rating: duplicate rating callbacks are idempotent (score not overwritten)', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  const user = await seedRatingReady(db, 802, 8002);
  await tv.processWebhookUpdate(rateCallback(4, 802, 8002, 'rate_3'), { supabase: db, bot: bot });
  const dup = await tv.processWebhookUpdate(rateCallback(5, 802, 8002, 'rate_5'), { supabase: db, bot: bot });
  assert.equal(dup.outcome, 'rating_duplicate');
  assert.equal(db.verifications[user.id].review_score, 3, 'first score preserved; duplicate does not overwrite');
  // Buttons remain removed on the duplicate edit too.
  const edit = bot.calls.editMessageText[bot.calls.editMessageText.length - 1];
  assert.deepEqual(edit.options.reply_markup, { inline_keyboard: [] });
});

test('rating: a sender not bound to any record cannot rate (identity validated)', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  await seedRatingReady(db, 803, 8003);
  // A different Telegram id sends the callback.
  const res = await tv.processWebhookUpdate(rateCallback(6, 999999, 8003, 'rate_5'), { supabase: db, bot: bot });
  assert.equal(res.outcome, 'rating_not_found');
  assert.equal(bot.calls.editMessageText.length, 0);
});

test('rating: never re-requested after submission (not listed as due)', async function () {
  const db = makeModelDb();
  const user = await seedRatingReady(db, 804, 8004);
  db.verifications[user.id].review_requested_at = null; // even if request flag clear...
  await db.rpc('record_review_rating', { p_telegram_user_id: 804, p_score: 5 });
  const due = await lifecycle.listDueReviewRequests(db, 100);
  assert.ok(!due.some(function (r) { return r.user_id === user.id; }), 'submitted member never appears in review due list');
});

// ===========================================================================
// 3. Review-request runner (30-day)
// ===========================================================================
test('review runner: sends one request to an eligible member and is idempotent daily', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  const user = db.seedUser({ username: 'joined31', is_approved: true, is_blocked: false });
  db.seedVerification({ user_id: user.id, telegram_user_id: 55, telegram_private_chat_id: 5500, telegram_verified_at: iso(now() - 40 * DAY), channel_joined_at: iso(now() - 31 * DAY) });

  const first = await lifecycle.runReviewRequests({ supabase: db, bot: bot }, {});
  assert.equal(first.sent, 1);
  const dm = bot.calls.sendMessage[0];
  assert.equal(String(dm.chatId), '5500');
  assert.ok(dm.text.indexOf('Sudah 30 hari') !== -1);
  assert.equal(dm.options.reply_markup.inline_keyboard.flat().length, 5);
  assert.ok(db.verifications[user.id].review_requested_at, 'request timestamp set (claim before send)');

  // Second daily run: nothing due (already requested) -> no duplicate DM.
  const second = await lifecycle.runReviewRequests({ supabase: db, bot: bot }, {});
  assert.equal(second.sent, 0);
  assert.equal(bot.calls.sendMessage.length, 1);
});

test('review runner: too-recent member (<30 days) is not requested', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  const user = db.seedUser({ username: 'joined10', is_approved: true, is_blocked: false });
  db.seedVerification({ user_id: user.id, telegram_user_id: 56, telegram_private_chat_id: 5600, telegram_verified_at: iso(now() - 20 * DAY), channel_joined_at: iso(now() - 10 * DAY) });
  const res = await lifecycle.runReviewRequests({ supabase: db, bot: bot }, {});
  assert.equal(res.sent, 0);
  assert.equal(bot.calls.sendMessage.length, 0);
});

// ===========================================================================
// 4. Legacy verification reminders
// ===========================================================================
function seedReminderCandidate(db, opts) {
  opts = opts || {};
  const user = db.seedUser({ username: opts.username || ('pending' + db._uid), is_approved: false, is_blocked: !!opts.blocked });
  db.seedVerification({
    user_id: user.id,
    telegram_user_id: opts.tgId || null,
    telegram_private_chat_id: ('privateChatId' in opts) ? opts.privateChatId : 9000,
    telegram_verified_at: opts.verifiedAt || null,
    verification_reminder_count: opts.count || 0,
    verification_reminded_at: opts.remindedAt || null
  });
  return user;
}

test('reminder: sends at most TWO reminders (second only after 24h), then stops', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  const user = seedReminderCandidate(db, { username: 'legacy1', privateChatId: 7001 });

  // First reminder.
  let r = await lifecycle.runVerificationReminders({ supabase: db, bot: bot }, {});
  assert.equal(r.sent, 1);
  assert.equal(db.verifications[user.id].verification_reminder_count, 1);
  assert.equal(String(bot.calls.sendMessage[0].chatId), '7001');
  assert.ok(bot.calls.sendMessage[0].text.indexOf('Verifikasi akun Auto-Cuan kamu belum selesai.') !== -1);
  assert.ok(bot.calls.sendMessage[0].options.reply_markup.inline_keyboard.flat()[0].url.indexOf('t.me') !== -1);

  // Immediate re-run: second reminder is NOT yet due (needs 24h gap).
  r = await lifecycle.runVerificationReminders({ supabase: db, bot: bot }, {});
  assert.equal(r.sent, 0);
  assert.equal(db.verifications[user.id].verification_reminder_count, 1);

  // Backdate the first reminder past 24h -> second reminder sends.
  db.verifications[user.id].verification_reminded_at = now() - 25 * 60 * 60 * 1000;
  r = await lifecycle.runVerificationReminders({ supabase: db, bot: bot }, {});
  assert.equal(r.sent, 1);
  assert.equal(db.verifications[user.id].verification_reminder_count, 2);

  // Backdate again -> still capped at two; no third reminder ever.
  db.verifications[user.id].verification_reminded_at = now() - 100 * 60 * 60 * 1000;
  r = await lifecycle.runVerificationReminders({ supabase: db, bot: bot }, {});
  assert.equal(r.sent, 0);
  assert.equal(db.verifications[user.id].verification_reminder_count, 2, 'never exceeds two');
});

test('reminder: stops immediately after verification', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  const user = seedReminderCandidate(db, { username: 'legacy2', privateChatId: 7002, verifiedAt: iso(now()) });
  const r = await lifecycle.runVerificationReminders({ supabase: db, bot: bot }, {});
  assert.equal(r.sent, 0, 'a verified user is never reminded');
  assert.equal(bot.calls.sendMessage.length, 0);
});

test('reminder: blocked and reserved users are never reminded', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  seedReminderCandidate(db, { username: 'legacyBlocked', privateChatId: 7003, blocked: true });
  seedReminderCandidate(db, { username: 'budi', privateChatId: 7004 });
  seedReminderCandidate(db, { username: 'review', privateChatId: 7005 });
  const r = await lifecycle.runVerificationReminders({ supabase: db, bot: bot }, {});
  assert.equal(r.sent, 0);
  assert.equal(bot.calls.sendMessage.length, 0);
});

test('reminder: an unknown member (no private chat id) is never messaged or tagged', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  // Record with NO private chat id.
  seedReminderCandidate(db, { username: 'unknownChat', privateChatId: null });
  // A user with no verification record at all.
  db.seedUser({ username: 'noRecord', is_approved: false, is_blocked: false });
  const due = await lifecycle.listDueVerificationReminders(db, 100);
  assert.equal(due.length, 0, 'unknown members are never selected');
  const r = await lifecycle.runVerificationReminders({ supabase: db, bot: bot }, {});
  assert.equal(r.sent, 0);
  assert.equal(bot.calls.sendMessage.length, 0, 'no message ever sent to an unknown member');
});

test('reminder: dry-run lists due count without claiming or sending', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  const user = seedReminderCandidate(db, { username: 'legacyDry', privateChatId: 7006 });
  const r = await lifecycle.runVerificationReminders({ supabase: db, bot: bot }, { dryRun: true });
  assert.equal(r.due, 1);
  assert.equal(r.sent, 0);
  assert.equal(db.verifications[user.id].verification_reminder_count, 0, 'dry-run claims nothing');
  assert.equal(bot.calls.sendMessage.length, 0);
});

// ===========================================================================
// 5. Legacy channel announcement
// ===========================================================================
test('announcement: posts one generic message with a safe deep-link button (no mass tagging)', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  const res = await lifecycle.sendLegacyChannelAnnouncement({ supabase: db, bot: bot }, { channelId: '-100999', key: 'k1' });
  assert.equal(res.status, 'sent');
  const msg = bot.calls.sendMessage[0];
  assert.equal(String(msg.chatId), '-100999');
  assert.ok(msg.text.indexOf('Pengguna lama Auto-Cuan yang belum melakukan verifikasi') !== -1);
  const btn = msg.options.reply_markup.inline_keyboard.flat();
  assert.equal(btn.length, 1);
  assert.ok(btn[0].url.indexOf('https://t.me/') === 0, 'safe Telegram deep link to the bot');
  assert.ok(btn[0].url.indexOf('?start=') !== -1, 'deep link uses a start payload');
  // No per-user mentions/tags anywhere in the announcement text.
  assert.equal(/@\w/.test(msg.text), false, 'no @mention tagging of individual users');
});

test('announcement: duplicate submissions are blocked (single-row guard)', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  const first = await lifecycle.sendLegacyChannelAnnouncement({ supabase: db, bot: bot }, { channelId: '-100999', key: 'dupkey' });
  const second = await lifecycle.sendLegacyChannelAnnouncement({ supabase: db, bot: bot }, { channelId: '-100999', key: 'dupkey' });
  assert.equal(first.status, 'sent');
  assert.equal(second.status, 'duplicate');
  assert.equal(bot.calls.sendMessage.length, 1, 'the announcement is posted exactly once');
});

test('announcement: deep link builder sanitizes payloads and never encodes identifiers', function () {
  assert.equal(lifecycle.buildBotDeepLink('verifikasi'), tv.BOT_URL + '?start=verifikasi');
  // Dangerous characters stripped from the start payload (query part only).
  const link = lifecycle.buildBotDeepLink('abc def/../<script>');
  assert.ok(link.indexOf('https://t.me/') === 0, 'points at the bot');
  const payload = (link.split('?start=')[1] || '');
  assert.equal(payload, 'abcdefscript', 'payload sanitized to safe charset');
  assert.ok(payload.indexOf(' ') === -1 && payload.indexOf('/') === -1 && payload.indexOf('<') === -1);
  // Empty/blank payload degrades safely to the plain bot URL.
  assert.equal(lifecycle.buildBotDeepLink('   '), tv.BOT_URL);
});

// ===========================================================================
// 6. Endpoint tests (supabase stubbed via Module._load; signed admin session)
// ===========================================================================
function requireApiWithSupabaseStub(relPath, db) {
  const origLoad = Module._load;
  const abs = require.resolve(relPath);
  delete require.cache[abs];
  Module._load = function (request) {
    if (request === '@supabase/supabase-js') return { createClient: function () { return db; } };
    return origLoad.apply(this, arguments);
  };
  let handler;
  try { handler = require(relPath); } finally { Module._load = origLoad; delete require.cache[abs]; }
  return handler;
}
function makeReq(opts) { return { method: opts.method || 'POST', headers: opts.headers || {}, query: opts.query || {}, body: opts.body || {} }; }
function makeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }
  };
}
function adminCookieHeader() {
  process.env.SESSION_SECRET = 'unit-test-session-secret-value';
  const adminSession = require('../lib/admin-session');
  const token = adminSession.createSessionToken({ userId: 'admin-1', username: 'budi', isAdmin: true });
  return { cookie: adminSession.SESSION_COOKIE_NAME + '=' + token };
}

test('endpoint analytics: authenticated admin gets server-derived counts', async function () {
  process.env.SUPABASE_URL = 'http://local';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
  const nowMs = now();
  const db = makeModelDb();
  const pop = analyticsPopulation(nowMs);
  pop.users.forEach(function (u) { db.users.push(u); });
  pop.verifications.forEach(function (v) { db.verifications[v.user_id] = Object.assign({ review_requested_at: null, review_submitted_at: null, review_score: null, verification_reminder_count: 0, verification_reminded_at: null }, v); });

  const handler = requireApiWithSupabaseStub('../api/admin-users', db);
  const res = makeRes();
  await handler(makeReq({ headers: adminCookieHeader(), body: { action: 'analytics' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.ok(res.body.analytics, 'analytics payload present');
  assert.equal(res.body.analytics.totalUsers, 6);
  assert.equal(res.body.analytics.telegramVerified, 4);
  assert.equal(res.body.analytics.eligibleForReview, 1);
  assert.equal(res.body.analytics.joinDateUnknown, 1);
});

test('endpoint analytics: unauthenticated request is rejected (401)', async function () {
  process.env.SUPABASE_URL = 'http://local';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
  const handler = requireApiWithSupabaseStub('../api/admin-users', makeModelDb());
  const res = makeRes();
  await handler(makeReq({ headers: {}, body: { action: 'analytics' } }), res);
  assert.equal(res.statusCode, 401, 'analytics requires an authenticated admin session');
});

test('endpoint announcement: requires an authenticated admin (401 without session)', async function () {
  process.env.SUPABASE_URL = 'http://local';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
  const handler = requireApiWithSupabaseStub('../api/admin-users', makeModelDb());
  const res = makeRes();
  await handler(makeReq({ headers: {}, body: { action: 'legacy_channel_announcement', confirm: true } }), res);
  assert.equal(res.statusCode, 401, 'announcement must be admin-only');
});

test('endpoint announcement: admin dry-run (no confirm) reports readiness without posting', async function () {
  process.env.SUPABASE_URL = 'http://local';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
  process.env.TELEGRAM_VERIFY_CHANNEL_ID = '-1000000000009';
  const db = makeModelDb();
  const handler = requireApiWithSupabaseStub('../api/admin-users', db);
  const res = makeRes();
  await handler(makeReq({ headers: adminCookieHeader(), body: { action: 'legacy_channel_announcement' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.announcement.status, 'ready', 'no confirm -> dry-run readiness, nothing posted');
  assert.equal(Object.keys(db.announcements).length, 0, 'no announcement claimed in dry-run');
});

// ===========================================================================
// 7. Token isolation for the new libs
// ===========================================================================
test('isolation: lifecycle + analytics libs never read TELEGRAM_BOT_TOKEN or import the notifier', function () {
  ['lib/telegram-lifecycle.js', 'lib/telegram-analytics.js'].forEach(function (rel) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.equal(src.indexOf('process.env.TELEGRAM_BOT_TOKEN') !== -1, false, rel + ' must not read TELEGRAM_BOT_TOKEN');
    assert.equal(/require\([^)]*telegram-notifier/.test(src), false, rel + ' must not import telegram-notifier');
  });
});

test('isolation: lifecycle lib uses only the verify channel env and never logs via console', function () {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'telegram-lifecycle.js'), 'utf8');
  assert.equal(src.indexOf('console.') !== -1, false, 'lifecycle lib must not use console');
  assert.equal(src.indexOf('process.env.TELEGRAM_VERIFY_BOT_TOKEN') !== -1, false, 'lifecycle never reads the bot token; it delegates to the injected bot');
});

test('isolation: admin-users API still never reads TELEGRAM_BOT_TOKEN', function () {
  const src = fs.readFileSync(path.join(ROOT, 'api', 'admin-users.js'), 'utf8');
  assert.equal(src.indexOf('process.env.TELEGRAM_BOT_TOKEN') !== -1, false);
});

// ===========================================================================
// 8. Regression guards
// ===========================================================================
test('regression: verification join callback still works alongside rating callbacks', async function () {
  const db = makeModelDb();
  const bot = makeFakeBot();
  // A rate_* callback must not touch the join flow (no membership check).
  await seedRatingReady(db, 900, 9000);
  const rate = await tv.processWebhookUpdate(rateCallback(70, 900, 9000, 'rate_2'), { supabase: db, bot: bot });
  assert.equal(rate.outcome, 'rating_recorded');
  assert.equal(bot.calls.getChatMember.length, 0);
  // An unrelated callback is still answered and ignored (unchanged behavior).
  const other = await tv.processWebhookUpdate({ update_id: 71, callback_query: { id: 'z', from: { id: 1 }, message: { chat: { id: 1, type: 'private' } }, data: 'totally_unrelated' } }, { supabase: db, bot: bot });
  assert.equal(other.outcome, 'ignored_callback');
});

test('regression: Approved Users view + analytics panel present, Delete User absent', function () {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  // Approved view helpers intact.
  assert.ok(html.indexOf('function renderApprovedUsersTable') !== -1, 'approved users table helper intact');
  assert.ok(html.indexOf("label: 'Sudah Di-approve'") !== -1, 'approved filter tab intact');
  // Analytics panel added.
  assert.ok(html.indexOf('renderTelegramAnalyticsPanel') !== -1, 'analytics panel present');
  assert.ok(html.indexOf('analyticsFromInput') !== -1 && html.indexOf('analyticsToInput') !== -1, 'From/To filters present');
  // No Delete User control anywhere in the approved helpers.
  const start = html.indexOf('function renderApprovedUsersTable');
  const end = html.indexOf('// ===== APPROVED-USERS-HELPERS-END =====');
  assert.equal(/delete/i.test(html.slice(start, end)), false, 'approved table renders no delete control');
});

test('regression: Delete User remains absent in admin API', function () {
  const admin = fs.readFileSync(path.join(ROOT, 'api', 'admin-users.js'), 'utf8');
  assert.equal(/action\s*===\s*['"]delete['"]/.test(admin), false, 'no delete action in admin-users');
  assert.equal(/delete[_-]?user/i.test(admin), false, 'no delete-user handler in admin-users');
  const apiFiles = fs.readdirSync(path.join(ROOT, 'api')).filter(function (f) { return f.endsWith('.js'); });
  assert.ok(!apiFiles.some(function (f) { return /delete/i.test(f); }), 'no delete-user API file');
});

test('api count: exactly 12 API JavaScript files (no new API file added)', function () {
  const files = fs.readdirSync(path.join(ROOT, 'api')).filter(function (f) { return f.endsWith('.js'); });
  assert.equal(files.length, 12, 'API JS file count must remain 12; got ' + files.length);
});

test('sql hotfix: additive only, review_score constrained 1..5, service-role-only grants', function () {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'telegram-member-lifecycle-hotfix.sql'), 'utf8');
  // No destructive statements (match real statements, not the word in comments).
  assert.equal(/\bDROP\s+(TABLE|FUNCTION|INDEX|COLUMN|CONSTRAINT|TRIGGER|VIEW|SCHEMA|TYPE)\b/i.test(sql), false, 'no DROP statement');
  assert.equal(/\bDELETE\s+FROM\b/i.test(sql), false, 'no destructive DELETE');
  assert.equal(/\bTRUNCATE\b/i.test(sql), false, 'no TRUNCATE');
  // Score constraint present.
  assert.ok(/review_score\s*>=\s*1\s*AND\s*review_score\s*<=\s*5/.test(sql), 'review_score constrained to 1..5');
  // Security posture.
  assert.ok(sql.indexOf('SET search_path = pg_catalog, public') !== -1, 'fixed safe search_path');
  assert.ok(sql.indexOf('REVOKE ALL ON FUNCTION') !== -1, 'revokes function execute');
  assert.ok(/GRANT\s+EXECUTE\s+ON\s+FUNCTION[\s\S]*service_role/.test(sql), 'grants only to service_role');
  assert.ok(sql.indexOf('ENABLE ROW LEVEL SECURITY') !== -1, 'RLS enabled on new table');
});


// ===========================================================================
// 9. Retryable delivery (two-phase claim -> send -> commit/release)
// ===========================================================================
test('reminder: a FAILED send does not consume an attempt and a later run retries', async function () {
  const db = makeModelDb();
  const user = seedReminderCandidate(db, { username: 'legacyRetry', privateChatId: 7101 });

  // First run: the Telegram send throws.
  const failBot = makeFakeBot({ sendThrows: true });
  const r1 = await lifecycle.runVerificationReminders({ supabase: db, bot: failBot }, {});
  assert.equal(r1.sent, 0);
  assert.equal(r1.failed, 1);
  assert.equal(r1.released, 1, 'the lease is released on a failed send');
  assert.equal(db.verifications[user.id].verification_reminder_count, 0, 'a failed send consumes no delivered attempt');
  assert.equal(db.verifications[user.id].verification_reminder_claim_token, null, 'lease cleared for retry');

  // Second daily run: the send succeeds -> exactly one delivered reminder.
  const okBot = makeFakeBot();
  const r2 = await lifecycle.runVerificationReminders({ supabase: db, bot: okBot }, {});
  assert.equal(r2.sent, 1);
  assert.equal(okBot.calls.sendMessage.length, 1);
  assert.equal(db.verifications[user.id].verification_reminder_count, 1, 'delivered reminder recorded on success');
});

test('reminder: successful reminders stop at EXACTLY two even after failures', async function () {
  const db = makeModelDb();
  const user = seedReminderCandidate(db, { username: 'legacyTwo', privateChatId: 7103 });

  // Deliver #1.
  await lifecycle.runVerificationReminders({ supabase: db, bot: makeFakeBot() }, {});
  assert.equal(db.verifications[user.id].verification_reminder_count, 1);

  // A failed attempt before the 24h gap must not count and must not send.
  db.verifications[user.id].verification_reminded_at = now() - 25 * 60 * 60 * 1000;
  const fail = makeFakeBot({ sendThrows: true });
  const rf = await lifecycle.runVerificationReminders({ supabase: db, bot: fail }, {});
  assert.equal(rf.sent, 0);
  assert.equal(db.verifications[user.id].verification_reminder_count, 1, 'still one delivered');

  // Retry succeeds -> #2 delivered.
  const ok2 = makeFakeBot();
  await lifecycle.runVerificationReminders({ supabase: db, bot: ok2 }, {});
  assert.equal(db.verifications[user.id].verification_reminder_count, 2);

  // No third reminder is ever delivered.
  db.verifications[user.id].verification_reminded_at = now() - 100 * 60 * 60 * 1000;
  const ok3 = makeFakeBot();
  const r3 = await lifecycle.runVerificationReminders({ supabase: db, bot: ok3 }, {});
  assert.equal(r3.sent, 0);
  assert.equal(ok3.calls.sendMessage.length, 0);
  assert.equal(db.verifications[user.id].verification_reminder_count, 2, 'never exceeds two delivered');
});

test('reminder: concurrent workers do not duplicate a send (lease serializes)', async function () {
  const db = makeModelDb();
  const user = seedReminderCandidate(db, { username: 'legacyConc', privateChatId: 7102 });

  // Worker A wins the lease.
  const a = await lifecycle.claimVerificationReminder(db, user.id, 120);
  assert.equal(a.outcome, 'claimed');
  assert.ok(a.claimToken);
  // Worker B, running at the same time, sees an active lease and skips.
  const b = await lifecycle.claimVerificationReminder(db, user.id, 120);
  assert.equal(b.outcome, 'skip');
  assert.equal(b.claimToken, null);
  // A leased record is not offered to any other worker via the due list.
  const due = await lifecycle.listDueVerificationReminders(db, 100);
  assert.equal(due.length, 0);
  // Only worker A can commit; the counter advances exactly once.
  const staleCommit = await lifecycle.commitVerificationReminder(db, user.id, 'ctok-does-not-exist');
  assert.equal(staleCommit.outcome, 'stale');
  const okCommit = await lifecycle.commitVerificationReminder(db, user.id, a.claimToken);
  assert.equal(okCommit.outcome, 'committed');
  assert.equal(db.verifications[user.id].verification_reminder_count, 1);
});

test('review: a FAILED send stays retryable and a later run delivers exactly once', async function () {
  const db = makeModelDb();
  const user = db.seedUser({ username: 'reviewRetry', is_approved: true, is_blocked: false });
  db.seedVerification({ user_id: user.id, telegram_user_id: 77, telegram_private_chat_id: 7700, telegram_verified_at: iso(now() - 40 * DAY), channel_joined_at: iso(now() - 31 * DAY) });

  const failBot = makeFakeBot({ sendThrows: true });
  const r1 = await lifecycle.runReviewRequests({ supabase: db, bot: failBot }, {});
  assert.equal(r1.sent, 0);
  assert.equal(r1.released, 1);
  assert.equal(db.verifications[user.id].review_requested_at, null, 'failed review send leaves it retryable');
  assert.equal(db.verifications[user.id].review_request_claim_token, null, 'lease cleared for retry');

  const okBot = makeFakeBot();
  const r2 = await lifecycle.runReviewRequests({ supabase: db, bot: okBot }, {});
  assert.equal(r2.sent, 1);
  assert.ok(db.verifications[user.id].review_requested_at, 'delivered review records review_requested_at');

  // Never a duplicate request afterwards.
  const r3 = await lifecycle.runReviewRequests({ supabase: db, bot: makeFakeBot() }, {});
  assert.equal(r3.sent, 0);
});

test('review: concurrent workers do not duplicate a request (lease serializes)', async function () {
  const db = makeModelDb();
  const user = db.seedUser({ username: 'reviewConc', is_approved: true, is_blocked: false });
  db.seedVerification({ user_id: user.id, telegram_user_id: 78, telegram_private_chat_id: 7800, telegram_verified_at: iso(now() - 40 * DAY), channel_joined_at: iso(now() - 31 * DAY) });

  const a = await lifecycle.claimReviewRequest(db, user.id, 120);
  assert.equal(a.outcome, 'claimed');
  const b = await lifecycle.claimReviewRequest(db, user.id, 120);
  assert.equal(b.outcome, 'skip');
  const due = await lifecycle.listDueReviewRequests(db, 100);
  assert.equal(due.length, 0);
  await lifecycle.commitReviewRequest(db, user.id, a.claimToken);
  assert.ok(db.verifications[user.id].review_requested_at);
  // A submitted review is terminal: after submission it is never requested again.
  await db.rpc('record_review_rating', { p_telegram_user_id: 78, p_score: 5 });
  const dueAfter = await lifecycle.listDueReviewRequests(db, 100);
  assert.equal(dueAfter.length, 0);
});

// ===========================================================================
// 10. Secure VPS runner shell script
// ===========================================================================
function runLifecycleShell(env) {
  const { execFileSync } = require('node:child_process');
  const script = path.join(ROOT, 'tools', 'run-telegram-lifecycle.sh');
  const mergedEnv = Object.assign({}, process.env, { NODE_OPTIONS: '' }, env);
  try {
    const out = execFileSync('bash', [script], { env: mergedEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out: out, err: '' };
  } catch (e) {
    return { code: (e.status == null ? 1 : e.status), out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
}
function tmpDir() {
  const os = require('node:os');
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tglife-'));
}

test('runner: rejects a missing env file (non-zero exit)', function () {
  const dir = tmpDir();
  const envFile = path.join(dir, 'absent.env');
  const r = runLifecycleShell({ TELEGRAM_LIFECYCLE_ENV_FILE: envFile, TELEGRAM_LIFECYCLE_LOCK_FILE: path.join(dir, 'lock') });
  assert.notEqual(r.code, 0);
  assert.ok(/env file not found/i.test(r.err), 'reports missing env file');
});

test('runner: rejects insecure env-file permissions (group/world access)', function () {
  const dir = tmpDir();
  const envFile = path.join(dir, 'insecure.env');
  fs.writeFileSync(envFile, 'SUPABASE_URL=x\n');
  fs.chmodSync(envFile, 0o644); // group/world readable -> must be rejected
  const r = runLifecycleShell({ TELEGRAM_LIFECYCLE_ENV_FILE: envFile, TELEGRAM_LIFECYCLE_LOCK_FILE: path.join(dir, 'lock') });
  assert.notEqual(r.code, 0);
  assert.ok(/insecure permissions/i.test(r.err), 'reports insecure permissions');
});

test('runner: never prints secret values from the env file', function () {
  const dir = tmpDir();
  const envFile = path.join(dir, 'secure.env');
  const SECRET = 'SUPERSECRETVALUE_do_not_leak_1234567890';
  fs.writeFileSync(envFile, [
    'SUPABASE_URL=http://local',
    'SUPABASE_SERVICE_ROLE_KEY=' + SECRET,
    'TELEGRAM_VERIFY_BOT_TOKEN=' + SECRET,
    'TELEGRAM_VERIFY_CHANNEL_ID=-100999'
  ].join('\n') + '\n');
  fs.chmodSync(envFile, 0o600);
  // Node will fail fast (no @supabase/supabase-js here); that is fine — we only
  // assert that no secret value is ever emitted to stdout/stderr.
  const r = runLifecycleShell({ TELEGRAM_LIFECYCLE_ENV_FILE: envFile, TELEGRAM_LIFECYCLE_LOCK_FILE: path.join(dir, 'lock') });
  const combined = r.out + r.err;
  assert.equal(combined.indexOf(SECRET), -1, 'secret value must never be printed');
});

test('runner: lock prevents overlapping executions (non-zero when held)', async function () {
  const { spawn } = require('node:child_process');
  const dir = tmpDir();
  const envFile = path.join(dir, 'secure.env');
  const lock = path.join(dir, 'run.lock');
  fs.writeFileSync(envFile, [
    'SUPABASE_URL=http://local',
    'SUPABASE_SERVICE_ROLE_KEY=svc',
    'TELEGRAM_VERIFY_BOT_TOKEN=tok',
    'TELEGRAM_VERIFY_CHANNEL_ID=-100999'
  ].join('\n') + '\n');
  fs.chmodSync(envFile, 0o600);

  // Hold the lock in a background process (blocking flock) for the duration.
  const holder = spawn('bash', ['-c', 'exec 9>"$1"; flock 9; sleep 10', '_', lock], { stdio: 'ignore' });
  await new Promise(function (r) { setTimeout(r, 400); }); // let the holder acquire

  try {
    const r = runLifecycleShell({ TELEGRAM_LIFECYCLE_ENV_FILE: envFile, TELEGRAM_LIFECYCLE_LOCK_FILE: lock });
    assert.notEqual(r.code, 0, 'a second run must not proceed while the lock is held');
    assert.ok(/already in progress/i.test(r.err), 'reports an in-progress run');
  } finally {
    holder.kill('SIGKILL');
  }
});

test('runner: shell script + sample env exist; sample carries names only (no secrets)', function () {
  const sh = fs.readFileSync(path.join(ROOT, 'tools', 'run-telegram-lifecycle.sh'), 'utf8');
  assert.ok(sh.indexOf('flock') !== -1, 'uses a lock');
  assert.ok(sh.indexOf('run-telegram-lifecycle.js --execute') !== -1, 'invokes the node runner in execute mode');
  assert.ok(sh.indexOf('/home/ubuntu/auto-cuan-runner/telegram-lifecycle.env') !== -1, 'documents the external env-file path');
  const sample = fs.readFileSync(path.join(ROOT, 'tools', 'telegram-lifecycle.env.sample'), 'utf8');
  // Variable names present, values empty (names only).
  ['SUPABASE_URL=', 'SUPABASE_SERVICE_ROLE_KEY=', 'TELEGRAM_VERIFY_BOT_TOKEN=', 'TELEGRAM_VERIFY_CHANNEL_ID='].forEach(function (k) {
    assert.ok(sample.indexOf(k) !== -1, 'sample declares ' + k);
    assert.ok(new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'm').test(sample), k + ' has no value in the sample');
  });
  assert.equal(sample.indexOf('TELEGRAM_BOT_TOKEN='), -1, 'sample never mentions the recommendation bot token');
});

// ===========================================================================
// 11. SQL + migration guards for the two-phase delivery
// ===========================================================================
test('sql hotfix: two-phase claim/commit/release RPCs + lease columns, still additive', function () {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'telegram-member-lifecycle-hotfix.sql'), 'utf8');
  ['claim_verification_reminder', 'commit_verification_reminder', 'release_verification_reminder',
   'claim_review_request', 'commit_review_request', 'release_review_request'].forEach(function (fn) {
    assert.ok(sql.indexOf('FUNCTION public.' + fn) !== -1, fn + ' function present');
  });
  ['verification_reminder_claim_token', 'verification_reminder_claim_expires_at',
   'review_request_claim_token', 'review_request_claim_expires_at'].forEach(function (c) {
    assert.ok(sql.indexOf(c) !== -1, c + ' lease column present');
  });
  // New signatures are locked down to service_role.
  assert.ok(sql.indexOf('public.claim_verification_reminder(uuid,integer)') !== -1);
  assert.ok(sql.indexOf('public.commit_verification_reminder(uuid,uuid)') !== -1);
  assert.ok(sql.indexOf('public.release_review_request(uuid,uuid)') !== -1);
  // Still additive / non-destructive.
  assert.equal(/\bDROP\s+(TABLE|FUNCTION|INDEX|COLUMN|CONSTRAINT|TRIGGER|VIEW|SCHEMA|TYPE)\b/i.test(sql), false, 'no DROP');
  assert.equal(/\bDELETE\s+FROM\b/i.test(sql), false, 'no destructive DELETE');
  assert.equal(/\bTRUNCATE\b/i.test(sql), false, 'no TRUNCATE');
  assert.ok(sql.indexOf('SET search_path = pg_catalog, public') !== -1, 'fixed safe search_path');
});

test('base migration: fresh install includes the delivery lease columns', function () {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'telegram-verification-v2-migration.sql'), 'utf8');
  ['review_request_claim_token', 'review_request_claim_expires_at',
   'verification_reminder_claim_token', 'verification_reminder_claim_expires_at'].forEach(function (c) {
    assert.ok(sql.indexOf(c) !== -1, c + ' present in base migration for fresh installs');
  });
});
