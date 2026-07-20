'use strict';

// ===========================================================================
// Telegram verification v2 — core logic and webhook orchestration
// (APPROVAL-GATED flow).
//
// Responsibilities:
//  - Generate cryptographically-secure one-time codes (8 chars, unambiguous
//    Base32-style alphabet), display formatting, and normalization.
//  - HMAC-SHA256 the normalized code with TELEGRAM_VERIFY_CODE_SECRET (fail
//    closed when the secret is absent). The RAW code is never stored/logged.
//  - Public AC-XXXXXX recognition code integration (display only; NOT auth).
//  - Username masking (safe for Telegram messages).
//  - Membership-status classification.
//  - Service-role RPC orchestration (all state changes go through the SQL
//    functions in supabase/telegram-verification-v2-migration.sql and
//    supabase/telegram-verification-v2-approval-gate-hotfix.sql).
//  - Synchronous webhook update processing with durable claim/complete AND
//    guarded try/catch/finally so a loading message is never left stuck.
//
// APPROVAL GATE (new flow):
//   Stage 2  code verified  -> bind identity, tell the user their account is
//                              "waiting for admin approval". NO invite, NO join
//                              button. Notify the admin immediately (durable,
//                              at-least-once, token-owned).
//   Stage 3  admin approves -> handled in api/admin-users.js: create a dynamic
//                              single-use invite and DM it to the user with the
//                              Gabung Channel / Saya Sudah Bergabung buttons.
//   Stage 4  user joins      -> membership confirmed ONLY for an APPROVED account,
//                              invite revoked, admin notified of the join.
//
// SECURITY / ISOLATION:
//  - This module NEVER references TELEGRAM_BOT_TOKEN and NEVER requires
//    lib/telegram-notifier.js. All Telegram I/O is delegated to an injected
//    `bot` object (see lib/telegram-verify-bot.js) that uses
//    TELEGRAM_VERIFY_BOT_TOKEN only.
//  - Raw user code text and raw Telegram message text are never logged. Only
//    coarse outcome codes are logged/returned. No console usage in this module.
// ===========================================================================

const crypto = require('crypto');
const { generateApprovalCode, maskUsername } = require('./free-user-approval');

// --- Constants -------------------------------------------------------------
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars, no 0/O/1/I
const CODE_LENGTH = 8;                 // 8 * log2(32) = 40 bits of entropy
const CODE_EXPIRY_MINUTES = 15;
const MAX_GEN_RETRIES = 5;             // bounded retries on active-hash collision

const SENDER_MAX_ATTEMPTS = 5;
const SENDER_WINDOW_SECONDS = 15 * 60; // rolling window
const SENDER_LOCK_SECONDS = 15 * 60;   // temporary lock

const WEBHOOK_LEASE_SECONDS = 30;
const NOTIFY_LEASE_SECONDS = 120;

const INVITE_TTL_SECONDS = 30 * 60;    // ~30 minutes
const INVITE_MEMBER_LIMIT = 1;

const BOT_USERNAME = 'AutoCuanVerificationBot';
const BOT_URL = 'https://t.me/AutoCuanVerificationBot';

const CALLBACK_JOIN = 'verify_channel_join';

// Telegram membership statuses that count as "joined".
const JOINED_STATUSES = { creator: true, administrator: true, member: true };

// --- User-facing messages (Indonesian) ------------------------------------
const MSG = {
  loading: '\u23F3 Memuat dan memverifikasi akun...',
  checking: '\u23F3 Memeriksa keanggotaan channel...',
  start: [
    'Halo! Untuk verifikasi akun Auto-Cuan:',
    '',
    '1. Salin kode verifikasi dari halaman pendaftaran website.',
    '2. Kirim kode itu ke chat ini.',
    '',
    'Kode berlaku ' + CODE_EXPIRY_MINUTES + ' menit.'
  ].join('\n'),
  // Expired / revoked / invalid code. Tells the user to LOGIN again for a fresh
  // code (a correct pending login rotates the code) — NOT to register again.
  invalidCode: [
    'Kode verifikasi tidak valid atau sudah kedaluwarsa.',
    '',
    'Silakan kembali ke website lalu login menggunakan username dan password untuk mendapatkan kode baru.',
    '',
    'Tidak perlu mendaftar ulang.'
  ].join('\n'),
  senderLocked: 'Terlalu banyak percobaan. Silakan coba lagi nanti.',
  configError: 'Verifikasi sedang tidak tersedia. Coba lagi nanti.',
  notJoined: 'Kamu belum terdeteksi sebagai anggota channel. Silakan gabung dulu, lalu tekan tombol lagi.',
  // Stage 4: a verified-but-not-yet-approved account tries to join the channel.
  pendingApproval: 'Akun kamu masih menunggu persetujuan admin.',
  // Generic safe failure used by the guarded try/catch/finally so a loading
  // message is never left stuck. Never exposes DB/Telegram error detail.
  safeFailure: [
    '\u274C Proses belum berhasil',
    '',
    'Terjadi gangguan sementara. Silakan coba lagi beberapa saat lagi.'
  ].join('\n'),
  completed: [
    '\u2705 Berhasil bergabung ke channel',
    '',
    'Akun Auto-Cuan kamu sudah aktif. Selamat datang!'
  ].join('\n')
};

// Stage 2: verification success (NO invite, NO join button). Explains that the
// channel link will be sent automatically after admin approval.
function buildVerificationSuccessMessage(maskedUsername, approvalCode) {
  return [
    '\u2705 Verifikasi Telegram berhasil',
    '',
    'Username: ' + maskedUsername,
    'Kode pengguna: ' + approvalCode,
    'Status: Menunggu persetujuan admin',
    '',
    'Link channel akan dikirim otomatis setelah akun disetujui admin.'
  ].join('\n');
}

// Stage 3: message delivered to the user AFTER an admin approves the account,
// carrying the dynamic single-use invite via the join buttons.
function buildApprovalInviteMessage() {
  return [
    '\u2705 Akun Auto-Cuan kamu sudah disetujui',
    '',
    'Silakan bergabung ke channel melalui tombol di bawah.'
  ].join('\n');
}

// Stage 2: admin notification "user verified, waiting for approval".
function buildVerifyAdminNotification(v) {
  return [
    '\uD83D\uDD14 USER TERVERIFIKASI TELEGRAM',
    '',
    'Username web: ' + v.maskedUsername,
    'Kode pengguna: ' + v.approvalCode,
    'Telegram username: ' + v.telegramUsername,
    'Telegram user ID: ' + v.telegramUserId,
    'Status Telegram: Terverifikasi',
    'Status akun: Menunggu persetujuan admin',
    'Event reference: ' + v.eventRef
  ].join('\n');
}

// Stage 4: admin notification "approved user joined the channel".
function buildAdminNotification(v) {
  return [
    '\u2705 USER JOIN CHANNEL',
    '',
    'Username web: ' + v.maskedUsername,
    'Kode pengguna: ' + v.approvalCode,
    'Telegram username: ' + v.telegramUsername + ' (ID: ' + v.telegramUserId + ')',
    'Status akun: Disetujui',
    'Status channel: Sudah bergabung',
    'Event reference: ' + v.eventRef
  ].join('\n');
}

// --- Code secret / HMAC (fail closed) --------------------------------------
function getCodeSecret() {
  const s = process.env.TELEGRAM_VERIFY_CODE_SECRET;
  return (typeof s === 'string' && s.length > 0) ? s : null;
}

function hasCodeSecret() {
  return getCodeSecret() !== null;
}

// Generate a raw 8-char code using rejection-free crypto.randomInt over the
// 32-char alphabet (32 divides 256 evenly at the byte level via randomInt).
function generateRawCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return out;
}

// Display format XXXX-XXXX (does not change the underlying value).
function formatCodeForDisplay(rawCode) {
  const s = String(rawCode || '');
  if (s.length !== CODE_LENGTH) return s;
  return s.slice(0, 4) + '-' + s.slice(4);
}

// Normalize arbitrary user input to a canonical 8-char uppercase code, or null
// when it cannot be a valid code. Strips separators/whitespace and uppercases.
function normalizeCode(input) {
  if (input == null) return null;
  const cleaned = String(input).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.length !== CODE_LENGTH) return null;
  for (const ch of cleaned) {
    if (CODE_ALPHABET.indexOf(ch) === -1) return null;
  }
  return cleaned;
}

// HMAC-SHA256 of the normalized code, hex. Returns null if secret is missing
// (fail closed) or the input is not a valid normalized code.
function computeCodeHash(input) {
  const secret = getCodeSecret();
  if (!secret) return null;
  const normalized = normalizeCode(input);
  if (!normalized) return null;
  return crypto.createHmac('sha256', secret).update(normalized, 'utf8').digest('hex');
}

// --- Membership classification ---------------------------------------------
// Accept creator/administrator/member, and restricted only when is_member===true.
function classifyMembership(chatMember) {
  if (!chatMember || typeof chatMember !== 'object') return false;
  const status = String(chatMember.status || '').toLowerCase();
  if (JOINED_STATUSES[status]) return true;
  if (status === 'restricted' && chatMember.is_member === true) return true;
  return false;
}

// --- RPC wrappers -----------------------------------------------------------
// Each returns a normalized row object or throws a sanitized Error. The Supabase
// client is passed in (service-role). We never log RPC error details verbatim.

function firstRow(data) {
  if (Array.isArray(data)) return data.length ? data[0] : null;
  return data || null;
}

async function rpc(supabase, name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) {
    const e = new Error('rpc_error');
    e.rpc = name;
    e.pgcode = error.code || null;
    e.pgmessage = typeof error.message === 'string' ? error.message : '';
    throw e;
  }
  return data;
}

// Atomic pending registration + first challenge. Generates the raw code in Node
// and passes ONLY the HMAC to SQL. Retries on active-hash collision. Returns the
// raw/display code ONLY after the RPC commits.
async function registerPendingUser(supabase, input) {
  if (!hasCodeSecret()) {
    const e = new Error('code_secret_missing');
    e.failClosed = true;
    throw e;
  }
  const expiresAt = new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000).toISOString();
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_GEN_RETRIES; attempt++) {
    const rawCode = generateRawCode();
    const codeHash = computeCodeHash(rawCode);
    try {
      const data = await rpc(supabase, 'register_pending_user_with_telegram_challenge', {
        p_username: input.username,
        p_password_hash: input.passwordHash,
        p_device_id: input.deviceId,
        p_user_agent: input.userAgent || '',
        p_code_hash: codeHash,
        p_expires_at: expiresAt
      });
      const row = firstRow(data);
      if (!row) { lastErr = new Error('empty_registration'); continue; }
      return {
        id: row.id,
        username: row.username,
        createdAt: row.created_at,
        challengeId: row.challenge_id,
        rawCode: rawCode,
        displayCode: formatCodeForDisplay(rawCode),
        expiresAt: expiresAt
      };
    } catch (e) {
      lastErr = e;
      if (e.pgcode === '23505' && /uq_autc_active_hash/.test(e.pgmessage)) {
        continue; // regenerate a fresh code and retry
      }
      throw e; // username/device duplicate or other error -> caller maps it
    }
  }
  throw (lastErr || new Error('registration_failed'));
}

// (Re)issue a fresh challenge for an existing pending user (rotates/revokes the
// previous active challenge atomically). Returns null when ineligible.
async function issueChallengeForUser(supabase, userId) {
  if (!hasCodeSecret()) {
    const e = new Error('code_secret_missing');
    e.failClosed = true;
    throw e;
  }
  const expiresAt = new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000).toISOString();
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_GEN_RETRIES; attempt++) {
    const rawCode = generateRawCode();
    const codeHash = computeCodeHash(rawCode);
    try {
      const data = await rpc(supabase, 'issue_telegram_challenge', {
        p_user_id: userId,
        p_code_hash: codeHash,
        p_expires_at: expiresAt
      });
      const row = firstRow(data);
      if (!row) return null; // ineligible (approved/blocked/reserved) -> no code
      return {
        challengeId: row.challenge_id,
        rawCode: rawCode,
        displayCode: formatCodeForDisplay(rawCode),
        expiresAt: row.expires_at || expiresAt
      };
    } catch (e) {
      lastErr = e;
      if (e.pgcode === '23505' && /uq_autc_active_hash/.test(e.pgmessage)) continue;
      throw e;
    }
  }
  throw (lastErr || new Error('issue_failed'));
}

async function checkSenderLimit(supabase, telegramUserId) {
  const row = firstRow(await rpc(supabase, 'check_telegram_sender_limit', { p_telegram_user_id: telegramUserId }));
  return { locked: !!(row && row.locked), lockedUntil: row ? row.locked_until : null };
}

async function recordInvalidAttempt(supabase, telegramUserId) {
  const row = firstRow(await rpc(supabase, 'record_invalid_telegram_attempt', {
    p_telegram_user_id: telegramUserId,
    p_max_attempts: SENDER_MAX_ATTEMPTS,
    p_window_seconds: SENDER_WINDOW_SECONDS,
    p_lock_seconds: SENDER_LOCK_SECONDS
  }));
  return { locked: !!(row && row.locked), lockedUntil: row ? row.locked_until : null };
}

async function clearSenderLimit(supabase, telegramUserId) {
  await rpc(supabase, 'clear_telegram_sender_limit', { p_telegram_user_id: telegramUserId });
}

async function consumeAndBind(supabase, codeHash, telegramUserId, privateChatId) {
  const row = firstRow(await rpc(supabase, 'consume_challenge_and_bind_telegram', {
    p_code_hash: codeHash,
    p_telegram_user_id: telegramUserId,
    p_private_chat_id: privateChatId
  }));
  return {
    resultCode: row ? row.result_code : 'not_found',
    userId: row ? row.user_id : null,
    username: row ? row.username : null
  };
}

async function confirmChannelJoin(supabase, telegramUserId) {
  const row = firstRow(await rpc(supabase, 'confirm_channel_join', { p_telegram_user_id: telegramUserId }));
  return {
    outcome: row ? row.outcome : 'not_found',
    userId: row ? row.user_id : null,
    adminNotificationStatus: row ? row.admin_notification_status : null
  };
}

async function claimWebhookUpdate(supabase, updateId) {
  const row = firstRow(await rpc(supabase, 'claim_telegram_webhook_update', {
    p_update_id: updateId,
    p_lease_seconds: WEBHOOK_LEASE_SECONDS
  }));
  return { claimState: row ? row.claim_state : 'lease_active', processingToken: row ? row.processing_token : null };
}

async function completeWebhookUpdate(supabase, updateId, processingToken, outcomeCode) {
  return await rpc(supabase, 'complete_telegram_webhook_update', {
    p_update_id: updateId,
    p_processing_token: processingToken,
    p_outcome_code: outcomeCode
  });
}

// --- Stage 4 (joined) admin notification outbox ----------------------------
async function claimAdminNotification(supabase, userId) {
  const row = firstRow(await rpc(supabase, 'claim_admin_notification', {
    p_user_id: userId,
    p_lease_seconds: NOTIFY_LEASE_SECONDS
  }));
  if (!row || !row.claim_token) return null;
  return {
    claimToken: row.claim_token,
    userId: row.user_id,
    eventRef: row.event_ref,
    telegramUserId: row.telegram_user_id,
    username: row.username
  };
}

async function completeAdminNotification(supabase, userId, claimToken) {
  return await rpc(supabase, 'complete_admin_notification', { p_user_id: userId, p_claim_token: claimToken });
}

async function failAdminNotification(supabase, userId, claimToken, errorCode) {
  return await rpc(supabase, 'fail_admin_notification', {
    p_user_id: userId, p_claim_token: claimToken, p_error_code: String(errorCode || 'unknown').slice(0, 120)
  });
}

// --- Stage 2 (verified) admin notification outbox --------------------------
async function claimVerifyNotification(supabase, userId) {
  const row = firstRow(await rpc(supabase, 'claim_verify_notification', {
    p_user_id: userId,
    p_lease_seconds: NOTIFY_LEASE_SECONDS
  }));
  if (!row || !row.claim_token) return null;
  return {
    claimToken: row.claim_token,
    userId: row.out_user_id,
    eventRef: row.event_ref,
    telegramUserId: row.telegram_user_id,
    telegramPrivateChatId: row.telegram_private_chat_id,
    username: row.username
  };
}

async function completeVerifyNotification(supabase, userId, claimToken) {
  return await rpc(supabase, 'complete_verify_notification', { p_user_id: userId, p_claim_token: claimToken });
}

async function failVerifyNotification(supabase, userId, claimToken, errorCode) {
  return await rpc(supabase, 'fail_verify_notification', {
    p_user_id: userId, p_claim_token: claimToken, p_error_code: String(errorCode || 'unknown').slice(0, 120)
  });
}

// --- Stage 3 approval invite-delivery outbox -------------------------------
async function claimInviteDelivery(supabase, userId) {
  const row = firstRow(await rpc(supabase, 'claim_invite_delivery', {
    p_user_id: userId,
    p_lease_seconds: NOTIFY_LEASE_SECONDS
  }));
  if (!row || !row.claim_token) return null;
  return {
    claimToken: row.claim_token,
    userId: row.out_user_id,
    telegramUserId: row.telegram_user_id,
    telegramPrivateChatId: row.telegram_private_chat_id,
    username: row.username
  };
}

async function completeInviteDelivery(supabase, userId, claimToken) {
  return await rpc(supabase, 'complete_invite_delivery', { p_user_id: userId, p_claim_token: claimToken });
}

async function failInviteDelivery(supabase, userId, claimToken, errorCode) {
  return await rpc(supabase, 'fail_invite_delivery', {
    p_user_id: userId, p_claim_token: claimToken, p_error_code: String(errorCode || 'unknown').slice(0, 120)
  });
}

async function saveInvite(supabase, userId, inviteLink, expiresAt) {
  await rpc(supabase, 'save_dynamic_invite_link', {
    p_user_id: userId, p_invite_link: inviteLink, p_expires_at: expiresAt
  });
}

async function revokeInviteRecord(supabase, userId) {
  await rpc(supabase, 'revoke_or_expire_dynamic_invite', { p_user_id: userId });
}

// Read the stored dynamic invite link (service-role read) so the bot can revoke
// it against Telegram. Returns null on any issue.
async function readInviteLink(supabase, telegramUserId) {
  try {
    const { data, error } = await supabase
      .from('app_user_telegram_verifications')
      .select('user_id, dynamic_invite_link')
      .eq('telegram_user_id', telegramUserId)
      .maybeSingle();
    if (error || !data) return null;
    return data.dynamic_invite_link || null;
  } catch (e) {
    return null;
  }
}

// Read the join-eligibility snapshot for a Telegram user id WITHOUT mutating the
// join timestamp (used to gate the callback BEFORE the membership check so a
// pending account gets the "waiting admin" message). Returns a coarse outcome.
async function readJoinEligibility(supabase, telegramUserId) {
  try {
    const { data: ver, error: verErr } = await supabase
      .from('app_user_telegram_verifications')
      .select('user_id, telegram_verified_at, channel_joined_at')
      .eq('telegram_user_id', telegramUserId)
      .maybeSingle();
    if (verErr || !ver || !ver.user_id) return { outcome: 'not_found', userId: null };
    if (!ver.telegram_verified_at) return { outcome: 'not_verified', userId: ver.user_id };

    const { data: user, error: userErr } = await supabase
      .from('app_users')
      .select('id, is_approved, is_blocked')
      .eq('id', ver.user_id)
      .maybeSingle();
    if (userErr || !user) return { outcome: 'not_found', userId: ver.user_id };
    if (user.is_blocked === true) return { outcome: 'blocked', userId: ver.user_id };
    if (user.is_approved !== true) return { outcome: 'pending_approval', userId: ver.user_id };
    return { outcome: 'approved', userId: ver.user_id, channelJoinedAt: ver.channel_joined_at };
  } catch (e) {
    return { outcome: 'error', userId: null };
  }
}

// --- Env accessors (opaque; never logged) ----------------------------------
function getChannelId() {
  const v = process.env.TELEGRAM_VERIFY_CHANNEL_ID;
  return (typeof v === 'string' && v.trim()) ? v.trim() : null;
}
function getAdminChatId() {
  const v = process.env.TELEGRAM_VERIFY_ADMIN_CHAT_ID;
  return (typeof v === 'string' && v.trim()) ? v.trim() : null;
}
function getStaticInviteUrl() {
  const v = process.env.TELEGRAM_VERIFY_CHANNEL_INVITE_URL;
  return (typeof v === 'string' && v.trim()) ? v.trim() : null;
}

// --- Reply keyboards --------------------------------------------------------
// Join buttons: 🔗 Gabung Channel (invite URL) + ✅ Saya Sudah Bergabung
// (fixed callback literal, carries NO identity).
function joinButtons(channelUrl) {
  const rows = [];
  if (channelUrl) rows.push([{ text: '\uD83D\uDD17 Gabung Channel', url: channelUrl }]);
  rows.push([{ text: '\u2705 Saya Sudah Bergabung', callback_data: CALLBACK_JOIN }]);
  return { inline_keyboard: rows };
}

// ===========================================================================
// Webhook processing
// ===========================================================================

// Process a single Telegram update synchronously. Claims the update_id first,
// processes the relevant message/callback, then completes with the matching
// processing_token. Returns a coarse outcome code (safe to log).
//
// deps: { supabase, bot }
async function processWebhookUpdate(update, deps) {
  const supabase = deps.supabase;

  const updateId = update && update.update_id;
  if (typeof updateId !== 'number' || !Number.isFinite(updateId)) {
    return { outcome: 'bad_update_id', claimed: false };
  }

  const claim = await claimWebhookUpdate(supabase, updateId);
  if (claim.claimState === 'already_processed') return { outcome: 'duplicate', claimed: false };
  if (claim.claimState === 'lease_active') return { outcome: 'in_progress', claimed: false };

  const token = claim.processingToken;
  let outcome = 'ignored';
  try {
    if (update.message) {
      outcome = await handleMessage(update.message, deps);
    } else if (update.callback_query) {
      outcome = await handleCallback(update.callback_query, deps);
    } else {
      outcome = 'ignored';
    }
  } catch (e) {
    // handleMessage/handleCallback already guarantee a user-facing safe-failure
    // edit; this outer guard only records a coarse outcome.
    outcome = 'error';
  }

  try { await completeWebhookUpdate(supabase, updateId, token, outcome); } catch (e) { /* best effort */ }
  return { outcome: outcome, claimed: true };
}

// Handle a private message. Non-private messages are ignored safely.
// GUARANTEE: once a loading message exists, any internal failure edits it into
// the neutral safe-failure text (never a stuck "loading" message, never a raw
// DB/Telegram error).
async function handleMessage(message, deps) {
  const supabase = deps.supabase;
  const bot = deps.bot;

  const chat = message.chat || {};
  if (String(chat.type || '') !== 'private') return 'ignored_non_private';

  const from = message.from || {};
  const senderId = from.id;
  const chatId = chat.id;
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  if (typeof senderId !== 'number' || typeof chatId !== 'number') return 'ignored';

  // /start -> instructions only, never the channel link.
  if (/^\/start\b/.test(text)) {
    try { await bot.sendMessage(chatId, MSG.start); } catch (e) { /* nothing to recover */ }
    return 'start';
  }
  if (!text) return 'ignored_empty';

  // Sender lock check BEFORE hashing/consuming (no loading message yet).
  let limit;
  try {
    limit = await checkSenderLimit(supabase, senderId);
  } catch (e) {
    return 'error';
  }
  if (limit.locked) {
    try { await bot.sendMessage(chatId, MSG.senderLocked); } catch (e) {}
    return 'sender_locked';
  }

  // Immediately show a loading message and keep its id for the final edit.
  let loadingMessageId = null;
  try {
    const sent = await bot.sendMessage(chatId, MSG.loading);
    loadingMessageId = sent && sent.message_id;
  } catch (e) { loadingMessageId = null; }

  const editOrSend = async (finalText, replyMarkup) => {
    if (loadingMessageId != null) {
      try { await bot.editMessageText(chatId, loadingMessageId, finalText, { reply_markup: replyMarkup }); return; }
      catch (e) { /* fall through to a fresh message */ }
    }
    try { await bot.sendMessage(chatId, finalText, { reply_markup: replyMarkup }); } catch (e) { /* ignore */ }
  };

  try {
    const codeHash = computeCodeHash(text);
    if (!codeHash) {
      // Invalid format OR missing secret (fail closed).
      if (!hasCodeSecret()) { await editOrSend(MSG.configError); return 'config_error'; }
      await recordInvalidAttempt(supabase, senderId);
      await editOrSend(MSG.invalidCode);
      return 'invalid_format';
    }

    const result = await consumeAndBind(supabase, codeHash, senderId, chatId);
    if (result.resultCode !== 'ok') {
      await recordInvalidAttempt(supabase, senderId);
      await editOrSend(MSG.invalidCode);
      return result.resultCode; // coarse, safe: not_found/expired/locked/bound_other_telegram/telegram_used_elsewhere
    }

    // Success (Stage 2): clear sender limiter. Do NOT create an invite and do NOT
    // show any join button — the account must be approved by an admin first.
    try { await clearSenderLimit(supabase, senderId); } catch (e) { /* non-fatal */ }

    const masked = maskUsername(result.username);
    const approvalCode = generateApprovalCode({ id: result.userId });
    await editOrSend(buildVerificationSuccessMessage(masked, approvalCode));

    // Immediately notify the admin (durable, at-least-once, token-owned).
    await notifyVerifyAdminBestEffort(deps, result.userId, from);
    return 'verified';
  } catch (e) {
    // Any unexpected failure after the loading message -> neutral safe failure.
    await editOrSend(MSG.safeFailure);
    return 'error';
  }
}

// Handle the fixed-action channel-join callback. Identity comes ONLY from
// callback_query.from.id; callback_data is a fixed literal and is not trusted
// for any identifier. Always answers the callback promptly, and guarantees the
// interim "checking" message is never left stuck.
async function handleCallback(cq, deps) {
  const supabase = deps.supabase;
  const bot = deps.bot;

  const data = typeof cq.data === 'string' ? cq.data : '';
  const cqId = cq.id;

  // Always answer promptly to clear Telegram's spinner.
  try { await bot.answerCallbackQuery(cqId); } catch (e) {}
  if (data !== CALLBACK_JOIN) {
    return 'ignored_callback';
  }

  const msg = cq.message || {};
  const chat = msg.chat || {};
  if (String(chat.type || '') !== 'private') return 'ignored_non_private';

  const from = cq.from || {};
  const senderId = from.id;
  const chatId = chat.id;
  const messageId = msg.message_id;
  if (typeof senderId !== 'number') return 'ignored';

  const editMsg = async (finalText, replyMarkup) => {
    if (chatId != null && messageId != null) {
      try { await bot.editMessageText(chatId, messageId, finalText, { reply_markup: replyMarkup }); return; }
      catch (e) {}
    }
    if (chatId != null) { try { await bot.sendMessage(chatId, finalText, { reply_markup: replyMarkup }); } catch (e) {} }
  };

  let showedInterim = false;
  try {
    // Approval gate FIRST (before any membership check): a pending/unverified
    // account never reaches getChatMember.
    const eligibility = await readJoinEligibility(supabase, senderId);
    if (eligibility.outcome === 'not_found' || eligibility.outcome === 'not_verified' || eligibility.outcome === 'error') {
      await editMsg(MSG.invalidCode);
      return eligibility.outcome === 'error' ? 'error' : eligibility.outcome;
    }
    if (eligibility.outcome === 'blocked') {
      await editMsg(MSG.invalidCode);
      return 'blocked';
    }
    if (eligibility.outcome === 'pending_approval') {
      await editMsg(MSG.pendingApproval);
      return 'pending_approval';
    }

    // Approved: check membership.
    await editMsg(MSG.checking);
    showedInterim = true;

    const channelId = getChannelId();
    let joined = false;
    if (channelId) {
      try {
        const member = await bot.getChatMember(channelId, senderId);
        joined = classifyMembership(member);
      } catch (e) { joined = false; }
    }
    if (!joined) {
      await editMsg(MSG.notJoined, joinButtons(await readInviteLink(supabase, senderId) || getStaticInviteUrl()));
      return 'not_joined';
    }

    // Confirm the join (idempotent) — re-validates verified+approved+not-blocked
    // and sets channel_joined_at.
    const confirm = await confirmChannelJoin(supabase, senderId);
    if (confirm.outcome === 'pending_approval') { await editMsg(MSG.pendingApproval); return 'pending_approval'; }
    if (confirm.outcome === 'not_found' || confirm.outcome === 'not_verified' || confirm.outcome === 'blocked') {
      await editMsg(MSG.invalidCode);
      return confirm.outcome;
    }

    // Best-effort invite revocation after a confirmed join.
    await revokeInviteBestEffort(deps, senderId, confirm.userId);

    // Durable at-least-once admin notification (Stage 4 "joined").
    await notifyAdminBestEffort(deps, confirm.userId, from);

    await editMsg(MSG.completed);
    return confirm.outcome === 'already_joined' ? 'already_joined' : 'joined';
  } catch (e) {
    // Guarantee no stuck "checking"/interim message on an unexpected failure.
    if (showedInterim) { await editMsg(MSG.safeFailure); }
    else { await editMsg(MSG.safeFailure); }
    return 'error';
  }
}

async function revokeInviteBestEffort(deps, telegramUserId, userId) {
  const supabase = deps.supabase;
  const bot = deps.bot;
  const channelId = getChannelId();
  const link = await readInviteLink(supabase, telegramUserId);
  if (link && channelId) {
    try {
      await bot.revokeChatInviteLink(channelId, link);
      if (userId) { try { await revokeInviteRecord(supabase, userId); } catch (e) {} } // clears stored URL
    } catch (e) { /* leave stored link for a later retry */ }
  }
}

// Claim the Stage-2 verification outbox, send to the verify admin chat, then
// complete/fail with the claim token. Never resends an already-sent
// notification. at-least-once.
async function notifyVerifyAdminBestEffort(deps, userId, telegramFrom) {
  const supabase = deps.supabase;
  const bot = deps.bot;
  if (!userId) return;

  let claim = null;
  try { claim = await claimVerifyNotification(supabase, userId); } catch (e) { claim = null; }
  if (!claim) return; // nothing to send (already sent, or not claimable)

  const adminChatId = getAdminChatId();
  if (!adminChatId) {
    try { await failVerifyNotification(supabase, userId, claim.claimToken, 'missing_admin_chat'); } catch (e) {}
    return;
  }

  const tgUsername = telegramFrom && typeof telegramFrom.username === 'string' && telegramFrom.username
    ? '@' + telegramFrom.username : '-';
  const message = buildVerifyAdminNotification({
    maskedUsername: maskUsername(claim.username),
    approvalCode: generateApprovalCode({ id: claim.userId }),
    telegramUsername: tgUsername,
    telegramUserId: claim.telegramUserId,
    eventRef: claim.eventRef
  });

  try {
    await bot.sendMessage(adminChatId, message);
    try { await completeVerifyNotification(supabase, userId, claim.claimToken); } catch (e) { /* rare dup risk */ }
  } catch (e) {
    try { await failVerifyNotification(supabase, userId, claim.claimToken, 'telegram_send_failed'); } catch (e2) {}
  }
}

// Claim the Stage-4 joined outbox, send to the verify admin chat, then
// complete/fail with the claim token. Never resends an already-sent
// notification. at-least-once.
async function notifyAdminBestEffort(deps, userId, telegramFrom) {
  const supabase = deps.supabase;
  const bot = deps.bot;
  if (!userId) return;

  let claim = null;
  try { claim = await claimAdminNotification(supabase, userId); } catch (e) { claim = null; }
  if (!claim) return; // nothing to send (already sent, or not claimable)

  const adminChatId = getAdminChatId();
  if (!adminChatId) {
    try { await failAdminNotification(supabase, userId, claim.claimToken, 'missing_admin_chat'); } catch (e) {}
    return;
  }

  const tgUsername = telegramFrom && typeof telegramFrom.username === 'string' && telegramFrom.username
    ? '@' + telegramFrom.username : '-';
  const message = buildAdminNotification({
    maskedUsername: maskUsername(claim.username),
    approvalCode: generateApprovalCode({ id: claim.userId }),
    telegramUsername: tgUsername,
    telegramUserId: claim.telegramUserId,
    eventRef: claim.eventRef
  });

  try {
    await bot.sendMessage(adminChatId, message);
    try { await completeAdminNotification(supabase, userId, claim.claimToken); } catch (e) { /* rare dup risk */ }
  } catch (e) {
    try { await failAdminNotification(supabase, userId, claim.claimToken, 'telegram_send_failed'); } catch (e2) {}
  }
}

// ===========================================================================
// Stage 3: approval invite delivery (called from api/admin-users.js after a
// successful false->true approval). Fully guarded: NEVER throws, so a Telegram
// or DB failure can never roll back the account approval. Returns a coarse
// status object { status, warning? }. Retryable: a 'failed' delivery is picked
// up again by claim_invite_delivery on a later retry action.
//
// deps: { supabase, bot }
// ===========================================================================
async function deliverApprovalInvite(deps, userId) {
  const supabase = deps.supabase;
  const bot = deps.bot;
  if (!userId) return { status: 'skipped', reason: 'missing_user_id' };

  // Claim the delivery work (only for approved+verified+chat-bound accounts).
  let claim = null;
  try { claim = await claimInviteDelivery(supabase, userId); } catch (e) { return { status: 'error', warning: 'invite_claim_failed' }; }
  if (!claim) return { status: 'skipped', reason: 'not_claimable' };

  const channelId = getChannelId();
  const chatId = claim.telegramPrivateChatId;
  if (!channelId) {
    try { await failInviteDelivery(supabase, userId, claim.claimToken, 'missing_channel_id'); } catch (e) {}
    return { status: 'failed', warning: 'missing_channel_id' };
  }
  if (chatId == null) {
    try { await failInviteDelivery(supabase, userId, claim.claimToken, 'missing_private_chat'); } catch (e) {}
    return { status: 'failed', warning: 'missing_private_chat' };
  }

  // Create the dynamic single-use, ~30-minute invite.
  let inviteLink = null;
  try {
    inviteLink = await bot.createChatInviteLink(channelId, {
      expireSeconds: INVITE_TTL_SECONDS,
      memberLimit: INVITE_MEMBER_LIMIT
    });
  } catch (e) {
    try { await failInviteDelivery(supabase, userId, claim.claimToken, 'invite_create_failed'); } catch (e2) {}
    return { status: 'failed', warning: 'invite_create_failed' };
  }

  // Fallback to the static invite (documented WEAKER fallback) if the dynamic
  // link could not be created.
  const usedStatic = !inviteLink;
  const channelUrl = inviteLink || getStaticInviteUrl();
  if (!channelUrl) {
    try { await failInviteDelivery(supabase, userId, claim.claimToken, 'no_invite_url'); } catch (e) {}
    return { status: 'failed', warning: 'no_invite_url' };
  }

  // Persist the dynamic invite for later revocation (best-effort).
  if (inviteLink) {
    const expiresAt = new Date(Date.now() + INVITE_TTL_SECONDS * 1000).toISOString();
    try { await saveInvite(supabase, userId, inviteLink, expiresAt); } catch (e) { /* non-fatal */ }
  }

  // Deliver the private approval message with the join buttons.
  try {
    await bot.sendMessage(chatId, buildApprovalInviteMessage(), { reply_markup: joinButtons(channelUrl) });
  } catch (e) {
    try { await failInviteDelivery(supabase, userId, claim.claimToken, 'invite_send_failed'); } catch (e2) {}
    return { status: 'failed', warning: 'invite_send_failed' };
  }

  try { await completeInviteDelivery(supabase, userId, claim.claimToken); } catch (e) { /* rare dup risk */ }
  return { status: 'sent', usedStaticFallback: usedStatic };
}

module.exports = {
  // constants
  CODE_ALPHABET,
  CODE_LENGTH,
  CODE_EXPIRY_MINUTES,
  MAX_GEN_RETRIES,
  SENDER_MAX_ATTEMPTS,
  INVITE_TTL_SECONDS,
  INVITE_MEMBER_LIMIT,
  BOT_USERNAME,
  BOT_URL,
  CALLBACK_JOIN,
  MSG,
  // code helpers
  getCodeSecret,
  hasCodeSecret,
  generateRawCode,
  formatCodeForDisplay,
  normalizeCode,
  computeCodeHash,
  classifyMembership,
  buildVerificationSuccessMessage,
  buildApprovalInviteMessage,
  buildVerifyAdminNotification,
  buildAdminNotification,
  joinButtons,
  // re-exports
  maskUsername,
  generateApprovalCode,
  // rpc orchestration
  registerPendingUser,
  issueChallengeForUser,
  checkSenderLimit,
  recordInvalidAttempt,
  clearSenderLimit,
  consumeAndBind,
  confirmChannelJoin,
  claimWebhookUpdate,
  completeWebhookUpdate,
  claimAdminNotification,
  completeAdminNotification,
  failAdminNotification,
  claimVerifyNotification,
  completeVerifyNotification,
  failVerifyNotification,
  claimInviteDelivery,
  completeInviteDelivery,
  failInviteDelivery,
  saveInvite,
  revokeInviteRecord,
  readInviteLink,
  readJoinEligibility,
  // stage 3 delivery
  deliverApprovalInvite,
  // webhook
  processWebhookUpdate,
  handleMessage,
  handleCallback,
  notifyVerifyAdminBestEffort,
  notifyAdminBestEffort
};
