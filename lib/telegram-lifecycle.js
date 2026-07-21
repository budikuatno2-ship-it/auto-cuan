'use strict';

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
//    supabase/telegram-member-lifecycle-hotfix.sql. The RPCs are the idempotency
//    gate: each due item is CLAIMED (counter/timestamp advanced) BEFORE its
//    message is sent, so the runner is safe to run daily and can never exceed the
//    at-most-two reminder / one review-request guarantees.
//  - Unknown channel members are never messaged or tagged: the RPCs only return
//    records that already carry a bound telegram_private_chat_id, and messages go
//    exclusively to that private chat.
// ===========================================================================

const {
  buildReviewRequestMessage,
  reviewRatingButtons,
  BOT_URL
} = require('./telegram-verification');

const DEFAULT_BATCH_LIMIT = 100;
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
  return safe ? (BOT_URL + '?start=' + safe) : BOT_URL;
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
  const v = process.env.TELEGRAM_VERIFY_CHANNEL_ID;
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
async function claimVerificationReminder(supabase, userId) {
  const row = firstRow(await rpc(supabase, 'claim_verification_reminder', { p_user_id: userId }));
  return {
    outcome: row ? row.outcome : 'skip',
    privateChatId: row ? row.telegram_private_chat_id : null,
    reminderCount: row ? row.reminder_count : null
  };
}
async function listDueReviewRequests(supabase, limit) {
  return allRows(await rpc(supabase, 'list_due_review_requests', { p_limit: limit || DEFAULT_BATCH_LIMIT }));
}
async function claimReviewRequest(supabase, userId) {
  const row = firstRow(await rpc(supabase, 'claim_review_request', { p_user_id: userId }));
  return {
    outcome: row ? row.outcome : 'skip',
    privateChatId: row ? row.telegram_private_chat_id : null
  };
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

// Due legacy verification reminders. Claims BEFORE sending (bounded at two).
async function runVerificationReminders(deps, opts) {
  opts = opts || {};
  const supabase = deps.supabase;
  const bot = deps.bot;
  const limit = opts.limit || DEFAULT_BATCH_LIMIT;

  let due = [];
  try { due = await listDueVerificationReminders(supabase, limit); } catch (e) { return { due: 0, sent: 0, skipped: 0, failed: 0, error: 'list_failed' }; }

  const summary = { due: due.length, sent: 0, skipped: 0, failed: 0 };
  if (opts.dryRun) return summary;

  for (const row of due) {
    const userId = row && row.user_id;
    if (!userId) { summary.skipped += 1; continue; }
    let claim = { outcome: 'skip' };
    try { claim = await claimVerificationReminder(supabase, userId); } catch (e) { summary.failed += 1; continue; }
    if (claim.outcome !== 'reminded' || claim.privateChatId == null) { summary.skipped += 1; continue; }
    try {
      await bot.sendMessage(claim.privateChatId, buildVerificationReminderMessage(), { reply_markup: verificationReminderButton() });
      summary.sent += 1;
    } catch (e) {
      // The reminder slot is already consumed (bounded); a failed send is coarse.
      summary.failed += 1;
    }
  }
  return summary;
}

// Due 30-day review requests. Claims (sets review_requested_at) BEFORE sending,
// so exactly one request is ever issued and never repeated after submission.
async function runReviewRequests(deps, opts) {
  opts = opts || {};
  const supabase = deps.supabase;
  const bot = deps.bot;
  const limit = opts.limit || DEFAULT_BATCH_LIMIT;

  let due = [];
  try { due = await listDueReviewRequests(supabase, limit); } catch (e) { return { due: 0, sent: 0, skipped: 0, failed: 0, error: 'list_failed' }; }

  const summary = { due: due.length, sent: 0, skipped: 0, failed: 0 };
  if (opts.dryRun) return summary;

  for (const row of due) {
    const userId = row && row.user_id;
    if (!userId) { summary.skipped += 1; continue; }
    let claim = { outcome: 'skip' };
    try { claim = await claimReviewRequest(supabase, userId); } catch (e) { summary.failed += 1; continue; }
    if (claim.outcome !== 'claimed' || claim.privateChatId == null) { summary.skipped += 1; continue; }
    try {
      await bot.sendMessage(claim.privateChatId, buildReviewRequestMessage(), { reply_markup: reviewRatingButtons() });
      summary.sent += 1;
    } catch (e) {
      summary.failed += 1;
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
  DEFAULT_ANNOUNCEMENT_KEY,
  // message/button builders
  buildVerificationReminderMessage,
  buildLegacyAnnouncementMessage,
  buildBotDeepLink,
  verificationReminderButton,
  legacyAnnouncementButton,
  // rpc wrappers
  listDueVerificationReminders,
  claimVerificationReminder,
  listDueReviewRequests,
  claimReviewRequest,
  claimLegacyChannelAnnouncement,
  // runners
  runVerificationReminders,
  runReviewRequests,
  runDailyLifecycle,
  sendLegacyChannelAnnouncement
};
