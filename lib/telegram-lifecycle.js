'use strict';

const runtimeEnv = require('./runtime-env');

// ===========================================================================
// Telegram member-lifecycle scheduler helpers (verification reminders + 30-day
// review requests) and the manual legacy channel announcement.
//
// SECURITY / ISOLATION (same posture as lib/telegram-verification.js):
//  - NEVER references TELEGRAM_BOT_TOKEN and NEVER imports lib/telegram-notifier.
//    All Telegram I/O is delegated to an injected `bot` (lib/telegram-verify-bot,
//    TELEGRAM_VERIFY_BOT_TOKEN only). Channel id comes from
//    TELEGRAM_VERIFY_CHANNEL_ID only.
//  - No console usage; only coarse, non-secret outcome objects are returned.
//  - All state changes go through the service-role RPCs in
//    supabase/telegram-member-lifecycle-hotfix.sql, using a two-phase
//    claim -> send -> commit/release protocol so a failed Telegram send is fully
//    RETRYABLE and never consumes a delivered attempt:
//       1) claim_*   leases the due record (concurrent workers are serialized;
//                    only one wins, the delivered counter is NOT advanced yet);
//       2) on a confirmed successful send, commit_* advances the delivered state
//          (verification_reminder_count / verification_reminded_at or
//          review_requested_at) and clears the lease;
//       3) on a failed send, release_* clears the lease so a later daily run
//          retries. Nothing is counted for a failed send.
//    Because delivered state advances only on commit, the "at most two delivered
//    reminders" and "one delivered review request" invariants hold, duplicates
//    are prevented, and the runner is safe to run daily.
//  - Unknown channel members are never messaged or tagged: the RPCs only return
//    records that already carry a bound telegram_private_chat_id, and messages go
//    exclusively to that private chat.
// ===========================================================================

const {
  buildReviewRequestMessage,
  reviewRatingButtons,
  BOT_URL,
  getBotUrl
} = require('./telegram-verification');

const DEFAULT_BATCH_LIMIT = 100;
// Delivery lease held while a single message is being sent. Long enough to cover
// a Telegram send; an abandoned lease self-heals after it expires.
const DEFAULT_CLAIM_LEASE_SECONDS = 120;
// Safe, non-secret default deep-link payload. It never encodes a user id/username.
const DEFAULT_DEEP_LINK_PAYLOAD = 'verifikasi';
const DEFAULT_ANNOUNCEMENT_KEY = 'legacy_verification_v1';

// --- User-facing messages (Indonesian) -------------------------------------
function buildVerificationReminderMessage() {
  return 'Verifikasi akun Auto-Cuan kamu belum selesai.';
}

function buildLegacyAnnouncementMessage() {
  return 'Pengguna lama Auto-Cuan yang belum melakukan verifikasi, silakan klik tombol di bawah.';
}

// Build a SAFE Telegram deep link that opens the verification bot. The payload is
// sanitized to Telegram's allowed start-parameter charset and length; it never
// carries an identifier. A blank/invalid payload degrades to the plain bot URL.
function buildBotDeepLink(payload) {
  const raw = payload == null ? DEFAULT_DEEP_LINK_PAYLOAD : String(payload);
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  const url = getBotUrl();
  if (!url) return null;
  return safe ? (url + '?start=' + safe) : url;
}

// Reminder button: opens the verification bot directly (no advertisement, no
// external link). URL button only — no callback identity.
function verificationReminderButton() {
  return { inline_keyboard: [[{ text: '\u2705 Lanjutkan Verifikasi', url: buildBotDeepLink('verifikasi') }]] };
}

// Legacy channel-announcement button: a single safe deep link to the bot.
function legacyAnnouncementButton() {
  return { inline_keyboard: [[{ text: '\u2705 Verifikasi Akun Lama', url: buildBotDeepLink('verifikasi_lama') }]] };
}

// --- Env accessor (opaque; never logged) -----------------------------------
function getChannelId() {
  const v = runtimeEnv.resolve('TELEGRAM_VERIFY_CHANNEL_ID');
  return (typeof v === 'string' && v.trim()) ? v.trim() : null;
}

// --- RPC helpers ------------------------------------------------------------
function firstRow(data) {
  if (Array.isArray(data)) return data.length ? data[0] : null;
  return data || null;
}
function allRows(data) {
  if (Array.isArray(data)) return data;
  return data ? [data] : [];
}
async function rpc(supabase, name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) {
    const e = new Error('rpc_error');
    e.rpc = name;
    e.pgcode = error.code || null;
    throw e;
  }
  return data;
}

async function listDueVerificationReminders(supabase, limit) {
  return allRows(await rpc(supabase, 'list_due_verification_reminders', { p_limit: limit || DEFAULT_BATCH_LIMIT }));
}
// Phase 1: lease a reminder (no counter advance). Returns a claim token.
async function claimVerificationReminder(supabase, userId, leaseSeconds) {
  const row = firstRow(await rpc(supabase, 'claim_verification_reminder', {
    p_user_id: userId,
    p_lease_seconds: leaseSeconds || DEFAULT_CLAIM_LEASE_SECONDS
  }));
  return {
    outcome: row ? row.outcome : 'skip',
    privateChatId: row ? row.telegram_private_chat_id : null,
    reminderCount: row ? row.reminder_count : null,
    claimToken: row ? row.claim_token : null
  };
}
// Phase 2 (success): record delivery + clear lease. Only the lease owner commits.
async function commitVerificationReminder(supabase, userId, token) {
  const row = firstRow(await rpc(supabase, 'commit_verification_reminder', { p_user_id: userId, p_token: token }));
  return { outcome: row ? row.outcome : 'stale', reminderCount: row ? row.reminder_count : null };
}
// Phase 2 (failure): clear lease so a later run retries; nothing is counted.
async function releaseVerificationReminder(supabase, userId, token) {
  const row = firstRow(await rpc(supabase, 'release_verification_reminder', { p_user_id: userId, p_token: token }));
  return { outcome: row ? row.outcome : 'stale' };
}

async function listDueReviewRequests(supabase, limit) {
  return allRows(await rpc(supabase, 'list_due_review_requests', { p_limit: limit || DEFAULT_BATCH_LIMIT }));
}
// Phase 1: lease a review request (review_requested_at NOT set yet).
async function claimReviewRequest(supabase, userId, leaseSeconds) {
  const row = firstRow(await rpc(supabase, 'claim_review_request', {
    p_user_id: userId,
    p_lease_seconds: leaseSeconds || DEFAULT_CLAIM_LEASE_SECONDS
  }));
  return {
    outcome: row ? row.outcome : 'skip',
    privateChatId: row ? row.telegram_private_chat_id : null,
    claimToken: row ? row.claim_token : null
  };
}
// Phase 2 (success): set review_requested_at + clear lease. Only the owner commits.
async function commitReviewRequest(supabase, userId, token) {
  const row = firstRow(await rpc(supabase, 'commit_review_request', { p_user_id: userId, p_token: token }));
  return { outcome: row ? row.outcome : 'stale' };
}
// Phase 2 (failure): clear lease so a later run retries; review_requested_at stays null.
async function releaseReviewRequest(supabase, userId, token) {
  const row = firstRow(await rpc(supabase, 'release_review_request', { p_user_id: userId, p_token: token }));
  return { outcome: row ? row.outcome : 'stale' };
}
async function claimLegacyChannelAnnouncement(supabase, key) {
  const row = firstRow(await rpc(supabase, 'claim_legacy_channel_announcement', { p_key: key || DEFAULT_ANNOUNCEMENT_KEY }));
  return {
    claimed: !!(row && row.claimed === true),
    sentAt: row ? row.legacy_notice_sent_at : null
  };
}

// ===========================================================================
// Runners. Each returns a coarse summary: { due, sent, skipped, failed }.
// dryRun (default false) lists what is due WITHOUT claiming or sending.
// ===========================================================================

// Due legacy verification reminders. Two-phase: lease -> send -> commit/release.
// A failed send is RELEASED (retryable) and never counts toward the two-reminder
// cap; only a confirmed send is COMMITTED (increments the delivered counter).
async function runVerificationReminders(deps, opts) {
  opts = opts || {};
  const supabase = deps.supabase;
  const bot = deps.bot;
  const limit = opts.limit || DEFAULT_BATCH_LIMIT;
  const lease = opts.leaseSeconds || DEFAULT_CLAIM_LEASE_SECONDS;

  let due = [];
  try { due = await listDueVerificationReminders(supabase, limit); } catch (e) { return { due: 0, sent: 0, skipped: 0, failed: 0, released: 0, error: 'list_failed' }; }

  const summary = { due: due.length, sent: 0, skipped: 0, failed: 0, released: 0 };
  if (opts.dryRun) return summary;

  for (const row of due) {
    const userId = row && row.user_id;
    if (!userId) { summary.skipped += 1; continue; }

    let claim = { outcome: 'skip' };
    try { claim = await claimVerificationReminder(supabase, userId, lease); } catch (e) { summary.failed += 1; continue; }
    if (claim.outcome !== 'claimed' || claim.privateChatId == null || claim.claimToken == null) { summary.skipped += 1; continue; }

    let delivered = false;
    try {
      await bot.sendMessage(claim.privateChatId, buildVerificationReminderMessage(), { reply_markup: verificationReminderButton() });
      delivered = true;
    } catch (e) {
      // Failed send: release the lease so a later daily run retries. Not counted.
      try { await releaseVerificationReminder(supabase, userId, claim.claimToken); summary.released += 1; } catch (_) {}
      summary.failed += 1;
      continue;
    }

    if (delivered) {
      // Confirmed send: record the delivered reminder (increments the counter).
      try { await commitVerificationReminder(supabase, userId, claim.claimToken); } catch (_) {}
      summary.sent += 1;
    }
  }
  return summary;
}

// Due 30-day review requests. Two-phase: lease -> send -> commit/release. A
// failed send is RELEASED (review_requested_at stays null, so it is retried);
// only a confirmed send is COMMITTED (sets review_requested_at exactly once).
async function runReviewRequests(deps, opts) {
  opts = opts || {};
  const supabase = deps.supabase;
  const bot = deps.bot;
  const limit = opts.limit || DEFAULT_BATCH_LIMIT;
  const lease = opts.leaseSeconds || DEFAULT_CLAIM_LEASE_SECONDS;

  let due = [];
  try { due = await listDueReviewRequests(supabase, limit); } catch (e) { return { due: 0, sent: 0, skipped: 0, failed: 0, released: 0, error: 'list_failed' }; }

  const summary = { due: due.length, sent: 0, skipped: 0, failed: 0, released: 0 };
  if (opts.dryRun) return summary;

  for (const row of due) {
    const userId = row && row.user_id;
    if (!userId) { summary.skipped += 1; continue; }

    let claim = { outcome: 'skip' };
    try { claim = await claimReviewRequest(supabase, userId, lease); } catch (e) { summary.failed += 1; continue; }
    if (claim.outcome !== 'claimed' || claim.privateChatId == null || claim.claimToken == null) { summary.skipped += 1; continue; }

    let delivered = false;
    try {
      await bot.sendMessage(claim.privateChatId, buildReviewRequestMessage(), { reply_markup: reviewRatingButtons() });
      delivered = true;
    } catch (e) {
      try { await releaseReviewRequest(supabase, userId, claim.claimToken); summary.released += 1; } catch (_) {}
      summary.failed += 1;
      continue;
    }

    if (delivered) {
      try { await commitReviewRequest(supabase, userId, claim.claimToken); } catch (_) {}
      summary.sent += 1;
    }
  }
  return summary;
}

// Combined daily entry point. Idempotent + safe to run daily.
async function runDailyLifecycle(deps, opts) {
  const reminders = await runVerificationReminders(deps, opts);
  const reviews = await runReviewRequests(deps, opts);
  return { reminders, reviews };
}

// ===========================================================================
// Manual legacy channel announcement (admin-triggered). Posts ONE generic
// message with a safe deep-link button to the verification channel. Protected
// against double submission by claim_legacy_channel_announcement (single-row
// guard): only the first trigger sends; a repeat returns { status:'duplicate' }.
// It never mass-tags individual users. dryRun (default false) reports readiness
// WITHOUT claiming or sending.
// ===========================================================================
async function sendLegacyChannelAnnouncement(deps, opts) {
  opts = opts || {};
  const supabase = deps.supabase;
  const bot = deps.bot;
  const channelId = opts.channelId || getChannelId();
  const key = opts.key || DEFAULT_ANNOUNCEMENT_KEY;

  if (!channelId) return { status: 'skipped', reason: 'missing_channel_id' };
  if (opts.dryRun) return { status: 'ready', channel_configured: true };

  // Double-submission guard FIRST: only the claiming call may post.
  let claim = { claimed: false };
  try { claim = await claimLegacyChannelAnnouncement(supabase, key); } catch (e) { return { status: 'error', reason: 'claim_failed' }; }
  if (!claim.claimed) return { status: 'duplicate', reason: 'already_announced' };

  try {
    await bot.sendMessage(channelId, buildLegacyAnnouncementMessage(), { reply_markup: legacyAnnouncementButton() });
    return { status: 'sent' };
  } catch (e) {
    // Sending failed after claiming; report coarse failure (guard already set).
    return { status: 'failed', reason: 'send_failed' };
  }
}

module.exports = {
  // constants
  DEFAULT_BATCH_LIMIT,
  DEFAULT_CLAIM_LEASE_SECONDS,
  DEFAULT_ANNOUNCEMENT_KEY,
  // message/button builders
  buildVerificationReminderMessage,
  buildLegacyAnnouncementMessage,
  buildBotDeepLink,
  verificationReminderButton,
  legacyAnnouncementButton,
  // rpc wrappers (two-phase delivery)
  listDueVerificationReminders,
  claimVerificationReminder,
  commitVerificationReminder,
  releaseVerificationReminder,
  listDueReviewRequests,
  claimReviewRequest,
  commitReviewRequest,
  releaseReviewRequest,
  claimLegacyChannelAnnouncement,
  // runners
  runVerificationReminders,
  runReviewRequests,
  runDailyLifecycle,
  sendLegacyChannelAnnouncement
};
