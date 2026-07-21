'use strict';

// ===========================================================================
// Telegram member analytics — PURE computation (no I/O, no console, no token).
//
// computeTelegramAnalytics() turns a snapshot of app_users + their Telegram
// verification rows into the compact counts rendered by the Admin User Approval
// page. Every number is DERIVED from the supplied server data; nothing is
// hardcoded. The function is side-effect free so it can be unit-tested directly
// and reused by api/admin-users.js.
//
// Reserved/system accounts (budi, review) are NOT members and are excluded from
// every count so the member metrics stay meaningful.
//
// UNKNOWN JOIN DATES: a legacy member whose historical channel_joined_at was
// never recorded is reported via `joinDateUnknown` and is NEVER counted as
// review-eligible. A join date is never invented.
// ===========================================================================

var RESERVED = { budi: true, review: true };
var REVIEW_MIN_DAYS = 30;
var DAY_MS = 24 * 60 * 60 * 1000;

function isReserved(username) {
  return RESERVED[String(username == null ? '' : username).trim().toLowerCase()] === true;
}

// Parse a value into epoch ms, or null when it is missing/invalid.
function toMs(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    var t0 = value.getTime();
    return isNaN(t0) ? null : t0;
  }
  var t = Date.parse(String(value));
  return isNaN(t) ? null : t;
}

// Decide whether a created_at falls inside an optional [from, to] range. `to` is
// treated as inclusive of the whole calendar day when it is a plain date. A row
// whose created_at is unknown is excluded whenever any bound is supplied (we
// cannot confirm it belongs to the window).
function withinRange(createdMs, fromMs, toMs_) {
  if (fromMs == null && toMs_ == null) return true;
  if (createdMs == null) return false;
  if (fromMs != null && createdMs < fromMs) return false;
  if (toMs_ != null && createdMs > toMs_) return false;
  return true;
}

// Normalize a "to" bound so a plain YYYY-MM-DD includes the entire day.
function normalizeToBound(value) {
  if (value == null) return null;
  var s = String(value);
  var base = toMs(s);
  if (base == null) return null;
  // A date-only string (no time component) should include the full day.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s.trim())) return base + DAY_MS - 1;
  return base;
}

// opts: { from, to, now, minDays }
//   from / to : optional ISO date/datetime strings (filter on user.created_at)
//   now       : optional reference time (Date | ISO | ms); defaults to Date.now()
//   minDays   : optional review threshold in days; defaults to 30
function computeTelegramAnalytics(users, verifications, opts) {
  opts = opts || {};
  var nowMs = toMs(opts.now);
  if (nowMs == null) nowMs = Date.now();
  var minDays = Number.isFinite(opts.minDays) ? opts.minDays : REVIEW_MIN_DAYS;
  var reviewCutoffMs = nowMs - minDays * DAY_MS;

  var fromMs = toMs(opts.from);
  var toBoundMs = normalizeToBound(opts.to);

  // Index verifications by user_id for an in-memory join.
  var byUser = {};
  (Array.isArray(verifications) ? verifications : []).forEach(function (v) {
    if (v && v.user_id != null) byUser[String(v.user_id)] = v;
  });

  var counts = {
    totalUsers: 0,
    telegramVerified: 0,
    approved: 0,
    joinedChannel: 0,
    approvedNotJoined: 0,
    verificationNotCompleted: 0,
    eligibleForReview: 0,
    reviewSubmitted: 0,
    joinDateUnknown: 0
  };
  var scoreSum = 0;
  var scoreCount = 0;

  (Array.isArray(users) ? users : []).forEach(function (u) {
    if (!u || isReserved(u.username)) return;
    var createdMs = toMs(u.created_at);
    if (!withinRange(createdMs, fromMs, toBoundMs)) return;

    counts.totalUsers += 1;

    var v = byUser[String(u.id)] || null;
    var verified = !!(v && v.telegram_verified_at);
    var joinedMs = v ? toMs(v.channel_joined_at) : null;
    var joined = joinedMs != null;
    var approved = u.is_approved === true;
    var blocked = u.is_blocked === true;
    var hasPrivateChat = !!(v && v.telegram_private_chat_id != null);

    if (verified) counts.telegramVerified += 1;
    if (approved) counts.approved += 1;
    if (joined) counts.joinedChannel += 1;
    if (approved && !joined) counts.approvedNotJoined += 1;

    // "Started the bot but did not finish" = a bound private chat with no
    // completed verification. This is exactly the reminder-eligible pool.
    if (hasPrivateChat && !verified) counts.verificationNotCompleted += 1;

    // Unknown historical join date: verified+approved but no recorded join.
    if (verified && approved && !joined) counts.joinDateUnknown += 1;

    // Review eligibility requires a KNOWN join date at least `minDays` old.
    if (verified && approved && !blocked && joined &&
        joinedMs <= reviewCutoffMs &&
        !(v && v.review_submitted_at)) {
      counts.eligibleForReview += 1;
    }

    if (v && v.review_submitted_at) counts.reviewSubmitted += 1;
    if (v && v.review_score != null && Number.isFinite(Number(v.review_score))) {
      scoreSum += Number(v.review_score);
      scoreCount += 1;
    }
  });

  // Average review score: null when there are no submitted scores (never faked).
  var averageReviewScore = scoreCount > 0 ? Math.round((scoreSum / scoreCount) * 100) / 100 : null;

  return Object.assign({}, counts, {
    averageReviewScore: averageReviewScore,
    reviewCount: scoreCount,
    range: {
      from: opts.from != null && fromMs != null ? String(opts.from) : null,
      to: opts.to != null && toBoundMs != null ? String(opts.to) : null
    },
    minDays: minDays
  });
}

module.exports = {
  computeTelegramAnalytics,
  isReserved,
  REVIEW_MIN_DAYS
};
