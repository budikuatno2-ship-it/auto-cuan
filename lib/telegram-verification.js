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
// APPROVAL GATE + JOIN-REQUEST GATE (current flow):
//   Stage 2  code verified  -> bind identity, tell the user their account is
//                              "waiting for admin approval". NO invite, NO join
//                              button. Notify the admin immediately (durable,
//                              at-least-once, token-owned).
//   Stage 3  admin approves -> handled in api/admin-users.js: create a dynamic
//                              JOIN-REQUEST invite (creates_join_request=true, no
//                              member_limit, ~30m) and DM it to the user with a
//                              SINGLE "Ajukan Bergabung" request-link button. No
//                              static fallback; a failed delivery stays retryable.
//   Stage 4  user clicks link -> Telegram raises chat_join_request (the user is
//                              NOT added yet). The webhook matches the requester
//                              Telegram id against the approved account and the
//                              stored, valid, non-revoked invite. On an exact
//                              match it approveChatJoinRequest FIRST, then (only
//                              after Telegram confirms) finalizes channel_joined_at,
//                              revokes+clears the invite, and notifies the admin.
//                              Every other request is DECLINED (fail closed) with
//                              only a neutral message and a coarse outcome code;
//                              a forwarded link cannot admit a different account.
//   Legacy    verify_channel_join callback -> compatibility only: answered
//                              immediately and replaced with a fresh join-request
//                              link (approved) or the right pending/error state.
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
// Reuse a stored join-request invite only when it still has at least this much
// life left; otherwise revoke it and mint a fresh one.
const INVITE_REUSE_MIN_REMAINING_MS = 60 * 1000;
// Safe, non-secret invite link name (never encodes any identifier).
const INVITE_LINK_NAME = 'Auto-Cuan Verifikasi';

const BOT_USERNAME = 'AutoCuanVerificationBot';
const BOT_URL = 'https://t.me/AutoCuanVerificationBot';

// Legacy callback literal. New approval messages NEVER use it; a compatibility
// handler still recognizes it for approval messages already sitting in Telegram
// and replaces them with a fresh join-request link.
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
  // Access already complete (already a channel member).
  alreadyJoined: [
    '\u2705 Akses kamu sudah lengkap',
    '',
    'Akun Auto-Cuan kamu sudah tergabung di channel.'
  ].join('\n'),
  // Sent privately after a chat_join_request is APPROVED by the bot (fallback
  // separate message, used ONLY when editing the original approval message fails).
  joinRequestApproved: [
    '\u2705 Permintaan bergabung disetujui',
    '',
    'Akun Telegram kamu sudah cocok dengan akun Auto-Cuan yang disetujui.',
    'Selamat bergabung di channel.'
  ].join('\n'),
  // Replaces the ORIGINAL approval message (its inline keyboard removed) after a
  // successful join. This is what makes the used "Ajukan Bergabung" button vanish.
  channelAccessActive: [
    '\u2705 Akses channel sudah aktif',
    '',
    'Permintaan bergabung kamu telah disetujui.',
    'Selamat bergabung di channel Auto-Cuan.'
  ].join('\n'),
  // Neutral decline message. Never reveals whether a specific website username
  // exists or any account detail.
  joinRequestDeclined: [
    'Permintaan bergabung tidak dapat disetujui.',
    'Pastikan akun Auto-Cuan sudah diverifikasi dan disetujui admin.'
  ].join('\n'),
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
// carrying the dynamic join-request invite via a single request-link button.
// The bot matches the requester's Telegram id automatically on chat_join_request.
function buildApprovalInviteMessage() {
  return [
    '\u2705 Akun Auto-Cuan kamu telah disetujui',
    '',
    'Klik tombol di bawah untuk mengajukan permintaan bergabung ke channel.',
    'Bot akan mencocokkan akun Telegram kamu secara otomatis.'
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

// Persist the message_id of the private approval message so a later
// chat_join_request can edit that exact message and remove its used button.
async function saveInviteMessageId(supabase, userId, messageId) {
  await rpc(supabase, 'save_invite_message_id', { p_user_id: userId, p_message_id: messageId });
}

// Clear the stored approval message_id once its button has been removed.
async function clearInviteMessageId(supabase, userId) {
  await rpc(supabase, 'clear_invite_message_id', { p_user_id: userId });
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

// Read the stored dynamic invite link by app user id (service-role read) so a
// previous invite can be revoked before a replacement is created. Returns null
// on any issue.
async function readStoredInviteByUserId(supabase, userId) {
  try {
    const { data, error } = await supabase
      .from('app_user_telegram_verifications')
      .select('user_id, dynamic_invite_link')
      .eq('user_id', userId)
      .maybeSingle();
    if (error || !data) return null;
    return data.dynamic_invite_link || null;
  } catch (e) {
    return null;
  }
}

// Read the stored invite reference by app user id: the dynamic invite link AND
// the message_id of the previously-delivered approval message (so its used
// button can be cleaned before a replacement is delivered). Returns
// { link, messageId } (either field may be null) or null on any issue.
async function readStoredInviteRefByUserId(supabase, userId) {
  try {
    const { data, error } = await supabase
      .from('app_user_telegram_verifications')
      .select('user_id, dynamic_invite_link, invite_message_id')
      .eq('user_id', userId)
      .maybeSingle();
    if (error || !data) return null;
    return {
      link: data.dynamic_invite_link || null,
      messageId: data.invite_message_id != null ? data.invite_message_id : null
    };
  } catch (e) {
    return null;
  }
}

// Read the full join-request decision context for a Telegram user id WITHOUT
// mutating any state. Identity is resolved ONLY by telegram_user_id. Returns a
// coarse `outcome` plus the invite/verification fields needed to fail closed.
//   outcome: not_found | not_verified | reserved | blocked | pending_approval
//            | eligible | error
async function readJoinRequestContext(supabase, telegramUserId) {
  try {
    const { data: ver, error: verErr } = await supabase
      .from('app_user_telegram_verifications')
      .select('user_id, telegram_verified_at, telegram_private_chat_id, channel_joined_at, dynamic_invite_link, invite_expires_at, invite_revoked_at, invite_message_id')
      .eq('telegram_user_id', telegramUserId)
      .maybeSingle();
    if (verErr || !ver || !ver.user_id) return { outcome: 'not_found', userId: null, telegramPrivateChatId: null, inviteMessageId: null };

    const base = {
      userId: ver.user_id,
      telegramPrivateChatId: ver.telegram_private_chat_id != null ? ver.telegram_private_chat_id : null,
      dynamicInviteLink: ver.dynamic_invite_link || null,
      inviteExpiresAt: ver.invite_expires_at || null,
      inviteRevokedAt: ver.invite_revoked_at || null,
      channelJoinedAt: ver.channel_joined_at || null,
      inviteMessageId: ver.invite_message_id != null ? ver.invite_message_id : null
    };
    if (!ver.telegram_verified_at) return Object.assign({ outcome: 'not_verified' }, base);

    const { data: user, error: userErr } = await supabase
      .from('app_users')
      .select('id, username, is_approved, is_blocked')
      .eq('id', ver.user_id)
      .maybeSingle();
    if (userErr || !user) return Object.assign({ outcome: 'not_found' }, base);

    const uname = String(user.username || '').toLowerCase();
    if (uname === 'budi' || uname === 'review') return Object.assign({ outcome: 'reserved' }, base);
    if (user.is_blocked === true) return Object.assign({ outcome: 'blocked' }, base);
    if (user.is_approved !== true) return Object.assign({ outcome: 'pending_approval' }, base);
    return Object.assign({ outcome: 'eligible' }, base);
  } catch (e) {
    return { outcome: 'error', userId: null, telegramPrivateChatId: null, inviteMessageId: null };
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

// --- Reply keyboards --------------------------------------------------------
// Single request-link button. Clicking the URL creates a chat_join_request that
// the webhook then matches against the approved account. NO callback identity,
// NO "Saya Sudah Bergabung", NO static link. Returns null (no keyboard) when the
// invite link is missing so we never render a broken/absent button.
function requestJoinButton(inviteLink) {
  if (!inviteLink) return undefined;
  return { inline_keyboard: [[{ text: '\uD83D\uDD10 Ajukan Bergabung', url: inviteLink }]] };
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
    if (update.chat_join_request) {
      outcome = await handleChatJoinRequest(update.chat_join_request, deps);
    } else if (update.message) {
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

  // /start -> context-aware recovery. Never leaks account info; only surfaces a
  // fresh join-request link to an approved-but-not-joined account.
  if (/^\/start\b/.test(text)) {
    return await handleStart(chatId, senderId, from, deps);
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

// ===========================================================================
// /start recovery. Context-aware, identity resolved ONLY from the sender's
// Telegram id. Never reveals whether a website username exists.
//   unbound / not verified   -> code-entry instructions
//   verified pending         -> "waiting for admin approval"
//   approved & not joined     -> reconcile via getChatMember if Telegram already
//                                approved a request; otherwise reuse/refresh the
//                                join-request invite and send the request button
//   joined                    -> "access already complete"
// ===========================================================================
// Best-effort cleanup of a stale "Ajukan Bergabung" button: edit the stored
// approval message into the completed text with no keyboard, then clear the
// stored message id (only after a successful edit). Tolerates a missing /
// already-edited message. Returns true only when the id was cleared.
async function cleanupApprovalButton(deps, ctx) {
  const supabase = deps.supabase;
  const bot = deps.bot;
  if (!ctx || ctx.telegramPrivateChatId == null || ctx.inviteMessageId == null) return false;
  try {
    await bot.editMessageText(ctx.telegramPrivateChatId, ctx.inviteMessageId, MSG.channelAccessActive, { reply_markup: { inline_keyboard: [] } });
  } catch (e) {
    return false; // leave the reference for a later retry
  }
  try { await clearInviteMessageId(supabase, ctx.userId); } catch (e) { /* tolerate */ }
  return true;
}

async function handleStart(chatId, senderId, from, deps) {
  const supabase = deps.supabase;
  const bot = deps.bot;

  const send = async (text, replyMarkup) => {
    try { await bot.sendMessage(chatId, text, replyMarkup ? { reply_markup: replyMarkup } : undefined); } catch (e) {}
  };

  let ctx;
  try {
    ctx = await readJoinRequestContext(supabase, senderId);
  } catch (e) {
    await send(MSG.start);
    return 'start';
  }

  // Unbound / not verified / reserved / lookup error -> generic code-entry help.
  if (!ctx || ctx.outcome === 'not_found' || ctx.outcome === 'not_verified' ||
      ctx.outcome === 'reserved' || ctx.outcome === 'error') {
    await send(MSG.start);
    return 'start';
  }
  if (ctx.outcome === 'blocked') {
    // Do not disclose the block; behave like an unbound account.
    await send(MSG.start);
    return 'start_blocked';
  }
  if (ctx.outcome === 'pending_approval') {
    await send(MSG.pendingApproval);
    return 'start_pending';
  }

  // Approved. Already joined -> clean any stale invite button, then reply that
  // channel access is already complete.
  if (ctx.channelJoinedAt) {
    await cleanupApprovalButton(deps, ctx);
    await send(MSG.alreadyJoined);
    return 'start_joined';
  }

  // Approved but not joined. First reconcile: if Telegram already approved a
  // request (DB finalization may have failed), confirm membership and finalize
  // exactly once (idempotent RPC + at-least-once notification).
  const channelId = getChannelId();
  if (channelId) {
    let joined = false;
    try {
      const member = await bot.getChatMember(channelId, senderId);
      joined = classifyMembership(member);
    } catch (e) { joined = false; }
    if (joined) {
      let confirm = { outcome: 'error' };
      try { confirm = await confirmChannelJoin(supabase, senderId); } catch (e) { confirm = { outcome: 'error' }; }
      if (confirm.outcome === 'joined_now' || confirm.outcome === 'already_joined') {
        await revokeInviteBestEffort(deps, senderId, confirm.userId);
        await notifyAdminBestEffort(deps, confirm.userId, from || { id: senderId });
        await cleanupApprovalButton(deps, ctx);
        await send(MSG.alreadyJoined);
        return confirm.outcome === 'already_joined' ? 'start_joined' : 'start_reconciled';
      }
    }
  }

  // Not a member yet -> provide a valid join-request invite (reuse or refresh).
  const link = await ensureJoinRequestInvite(deps, ctx);
  if (!link) {
    await send(MSG.safeFailure);
    return 'start_invite_failed';
  }
  await send(buildApprovalInviteMessage(), requestJoinButton(link));
  return 'start_invite';
}

// Return a valid join-request invite for an approved account: reuse the stored
// one when it is not revoked and still has enough life left; otherwise revoke
// the stale link (tolerating already-expired/already-revoked) and mint a fresh
// join-request invite, persisting it. Returns null when no link can be provided.
async function ensureJoinRequestInvite(deps, ctx) {
  const supabase = deps.supabase;
  const bot = deps.bot;
  const channelId = getChannelId();
  if (!channelId || !ctx || !ctx.userId) return null;

  const reusable = ctx.dynamicInviteLink &&
    ctx.inviteRevokedAt == null &&
    ctx.inviteExpiresAt != null &&
    Date.parse(ctx.inviteExpiresAt) > Date.now() + INVITE_REUSE_MIN_REMAINING_MS;
  if (reusable) return ctx.dynamicInviteLink;

  // Revoke the stale stored invite before creating a replacement. Tolerate an
  // already-expired or already-revoked link.
  if (ctx.dynamicInviteLink) {
    try { await bot.revokeChatInviteLink(channelId, ctx.dynamicInviteLink); } catch (e) { /* tolerate */ }
    try { await revokeInviteRecord(supabase, ctx.userId); } catch (e) { /* tolerate */ }
  }

  let link = null;
  try {
    link = await bot.createChatInviteLink(channelId, { expireSeconds: INVITE_TTL_SECONDS, name: INVITE_LINK_NAME });
  } catch (e) {
    return null;
  }
  if (!link) return null;

  const expiresAt = new Date(Date.now() + INVITE_TTL_SECONDS * 1000).toISOString();
  try { await saveInvite(supabase, ctx.userId, link, expiresAt); } catch (e) { /* non-fatal */ }
  return link;
}

// ===========================================================================
// chat_join_request gate. This is the authoritative access decision.
// Identity comes ONLY from chat_join_request.from.id. We never trust username,
// bio, the request's private chat id, the invite name, or any encoded id.
// Fail closed: anything that is not an EXACT match to an approved, eligible
// account presenting the currently-stored, valid, non-revoked invite link is
// DECLINED. A wrong channel id is safely ignored.
// ===========================================================================
async function handleChatJoinRequest(cjr, deps) {
  const supabase = deps.supabase;
  const bot = deps.bot;

  const channelId = getChannelId();
  const chat = cjr && cjr.chat ? cjr.chat : {};
  const requestChatId = chat.id != null ? String(chat.id) : null;

  // Strict channel match. A request for any other chat is not ours -> ignore.
  if (!channelId || requestChatId == null || requestChatId !== String(channelId)) {
    return 'ignored_wrong_channel';
  }

  const fromObj = cjr && cjr.from ? cjr.from : {};
  const requesterId = fromObj.id;
  if (typeof requesterId !== 'number' || !Number.isFinite(requesterId)) {
    // Without a valid requester id we cannot decline a specific user; ignore.
    return 'ignored';
  }

  // The invite link the requester actually used (fail closed if absent).
  const providedInviteLink = cjr && cjr.invite_link && typeof cjr.invite_link.invite_link === 'string'
    ? cjr.invite_link.invite_link : null;

  let ctx;
  try {
    ctx = await readJoinRequestContext(supabase, requesterId);
  } catch (e) {
    ctx = { outcome: 'error', userId: null, telegramPrivateChatId: null };
  }

  const linkMatches = providedInviteLink != null &&
    ctx.dynamicInviteLink != null &&
    providedInviteLink === ctx.dynamicInviteLink;
  const inviteValid = linkMatches &&
    ctx.inviteRevokedAt == null &&
    ctx.inviteExpiresAt != null &&
    Date.parse(ctx.inviteExpiresAt) > Date.now();
  const eligible = ctx.outcome === 'eligible' && inviteValid && !ctx.channelJoinedAt;

  if (!eligible) {
    // Fail closed: decline the request. Only send a neutral message when a safe
    // stored private chat exists; never reveal account existence to the admin.
    try { await bot.declineChatJoinRequest(channelId, requesterId); } catch (e) { /* sanitized */ }
    if (ctx.telegramPrivateChatId != null) {
      try { await bot.sendMessage(ctx.telegramPrivateChatId, MSG.joinRequestDeclined); } catch (e) {}
    }
    return declineOutcomeCode(ctx, providedInviteLink, linkMatches);
  }

  // Eligible: approve on Telegram FIRST. channel_joined_at is set ONLY after
  // Telegram confirms the approval succeeds.
  try {
    await bot.approveChatJoinRequest(channelId, requesterId);
  } catch (e) {
    // Approval failed -> do NOT finalize; recoverable later via /start.
    return 'approve_failed';
  }

  // Finalize the DB state (idempotent), revoke + clear the used invite, and
  // deliver the at-least-once joined admin notification.
  let confirm = { outcome: 'error', userId: ctx.userId };
  try { confirm = await confirmChannelJoin(supabase, requesterId); } catch (e) { confirm = { outcome: 'error', userId: ctx.userId }; }
  if (confirm.outcome === 'joined_now' || confirm.outcome === 'already_joined') {
    await revokeInviteBestEffort(deps, requesterId, confirm.userId);
    await notifyAdminBestEffort(deps, confirm.userId, fromObj);
  }

  const uid = confirm.userId || ctx.userId;
  const chatId = ctx.telegramPrivateChatId;
  const messageId = ctx.inviteMessageId;

  // Remove the used "Ajukan Bergabung" button by editing the ORIGINAL approval
  // message into the completed text with NO inline keyboard. Only when that edit
  // succeeds do we clear invite_message_id and SKIP the separate success message
  // (no duplicate). If the edit fails, membership is NOT rolled back, the message
  // reference is retained (retryable), and the existing separate success message
  // is sent as a fallback.
  if (confirm.outcome === 'joined_now') {
    let edited = false;
    if (chatId != null && messageId != null) {
      try {
        await bot.editMessageText(chatId, messageId, MSG.channelAccessActive, { reply_markup: { inline_keyboard: [] } });
        edited = true;
      } catch (e) { edited = false; }
    }
    if (edited) {
      try { await clearInviteMessageId(supabase, uid); } catch (e) { /* tolerate */ }
    } else if (chatId != null) {
      try { await bot.sendMessage(chatId, MSG.joinRequestApproved); } catch (e) {}
    }
    return 'joined';
  }

  // Idempotent reprocessing of an already-joined account: if a stale button
  // reference still exists (a previous edit failed), try to clean it now WITHOUT
  // sending another completion message, so duplicate updates never notify twice.
  if (confirm.outcome === 'already_joined') {
    if (chatId != null && messageId != null) {
      try {
        await bot.editMessageText(chatId, messageId, MSG.channelAccessActive, { reply_markup: { inline_keyboard: [] } });
        try { await clearInviteMessageId(supabase, uid); } catch (e) { /* tolerate */ }
      } catch (e) { /* tolerate; leave for later cleanup */ }
    }
    return 'joined_already';
  }

  // Telegram approved but DB finalize did not confirm (rare). Do not roll back
  // membership; recovery via /start will finalize and clean up. Stay silent to
  // avoid a misleading or duplicate message.
  return 'joined';
}

// Map a declined request to a coarse, safe-to-store outcome code. NEVER encodes
// a username or any account detail; only a category of failure.
function declineOutcomeCode(ctx, providedInviteLink, linkMatches) {
  switch (ctx && ctx.outcome) {
    case 'not_found': return 'declined_unknown';
    case 'not_verified': return 'declined_not_verified';
    case 'reserved': return 'declined_reserved';
    case 'blocked': return 'declined_blocked';
    case 'pending_approval': return 'declined_pending';
    case 'error': return 'declined_error';
    default: break;
  }
  // Account is eligible; the invite itself failed the check.
  if (ctx && ctx.channelJoinedAt) return 'declined_already_joined';
  if (providedInviteLink == null) return 'declined_missing_link';
  if (!ctx || ctx.dynamicInviteLink == null) return 'declined_no_stored_invite';
  if (!linkMatches) return 'declined_link_mismatch';
  if (ctx.inviteRevokedAt != null) return 'declined_revoked';
  return 'declined_expired';
}

// Legacy compatibility handler for the old `verify_channel_join` callback button
// that may still exist on approval messages already delivered to Telegram. The
// new flow never emits this button. We answer the callback immediately (no stuck
// spinner), then REPLACE the message: an approved-but-not-joined account gets a
// fresh join-request link; otherwise the appropriate pending/error state. We do
// NOT rely on the old direct-join behavior.
async function handleCallback(cq, deps) {
  const supabase = deps.supabase;
  const bot = deps.bot;

  const data = typeof cq.data === 'string' ? cq.data : '';
  const cqId = cq.id;

  // Always answer promptly to clear Telegram's spinner (never leave it stuck).
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

  try {
    const ctx = await readJoinRequestContext(supabase, senderId);
    if (ctx.outcome === 'not_found' || ctx.outcome === 'not_verified' ||
        ctx.outcome === 'reserved' || ctx.outcome === 'error') {
      await editMsg(MSG.invalidCode);
      return ctx.outcome === 'error' ? 'error' : 'legacy_' + ctx.outcome;
    }
    if (ctx.outcome === 'blocked') { await editMsg(MSG.invalidCode); return 'legacy_blocked'; }
    if (ctx.outcome === 'pending_approval') { await editMsg(MSG.pendingApproval); return 'legacy_pending'; }

    // Approved. Already joined -> access complete.
    if (ctx.channelJoinedAt) { await editMsg(MSG.alreadyJoined); return 'legacy_joined'; }

    // Approved but not joined -> replace with a fresh join-request link.
    const link = await ensureJoinRequestInvite(deps, ctx);
    if (!link) { await editMsg(MSG.safeFailure); return 'legacy_invite_failed'; }
    await editMsg(buildApprovalInviteMessage(), requestJoinButton(link));
    return 'legacy_invite';
  } catch (e) {
    // Never leave a loading/interim message stuck.
    await editMsg(MSG.safeFailure);
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

  // Revoke any previously stored dynamic invite before creating a replacement,
  // and remove the used button from the PREVIOUS approval message first so a
  // stale "Ajukan Bergabung" button never lingers when we replace it. Tolerate
  // an already-expired/revoked link and a missing/already-edited message.
  const previousRef = await readStoredInviteRefByUserId(supabase, userId);
  if (previousRef && previousRef.link) {
    try { await bot.revokeChatInviteLink(channelId, previousRef.link); } catch (e) { /* tolerate */ }
    try { await revokeInviteRecord(supabase, userId); } catch (e) { /* tolerate */ }
  }
  if (previousRef && previousRef.messageId != null) {
    try { await bot.editMessageReplyMarkup(chatId, previousRef.messageId); } catch (e) { /* tolerate not-modified/missing */ }
    try { await clearInviteMessageId(supabase, userId); } catch (e) { /* tolerate */ }
  }

  // Create the dynamic JOIN-REQUEST invite (~30 minutes, no member_limit, safe
  // non-secret name). There is NO static fallback: if creation fails we send no
  // channel link and keep the delivery retryable.
  let inviteLink = null;
  try {
    inviteLink = await bot.createChatInviteLink(channelId, {
      expireSeconds: INVITE_TTL_SECONDS,
      name: INVITE_LINK_NAME
    });
  } catch (e) {
    try { await failInviteDelivery(supabase, userId, claim.claimToken, 'invite_create_failed'); } catch (e2) {}
    return { status: 'failed', warning: 'invite_create_failed' };
  }
  if (!inviteLink) {
    try { await failInviteDelivery(supabase, userId, claim.claimToken, 'invite_create_failed'); } catch (e2) {}
    return { status: 'failed', warning: 'invite_create_failed' };
  }

  // Persist the dynamic invite for later match/revocation.
  const expiresAt = new Date(Date.now() + INVITE_TTL_SECONDS * 1000).toISOString();
  try { await saveInvite(supabase, userId, inviteLink, expiresAt); } catch (e) { /* non-fatal */ }

  // Deliver the private approval message with the single request-link button.
  // We MUST await the send and capture the returned message_id so the webhook
  // can later edit this exact message and remove its used button.
  let sent = null;
  try {
    sent = await bot.sendMessage(chatId, buildApprovalInviteMessage(), { reply_markup: requestJoinButton(inviteLink) });
  } catch (e) {
    try { await failInviteDelivery(supabase, userId, claim.claimToken, 'invite_send_failed'); } catch (e2) {}
    return { status: 'failed', warning: 'invite_send_failed' };
  }

  // Persist the approval message_id BEFORE marking the delivery complete. Without
  // a stored message reference we could never clean the button later, so a
  // missing/failed persist keeps the delivery retryable with a safe warning
  // (never exposing the Telegram response or any token).
  const messageId = sent && sent.message_id != null ? sent.message_id : null;
  if (messageId == null) {
    try { await failInviteDelivery(supabase, userId, claim.claimToken, 'invite_message_id_missing'); } catch (e2) {}
    return { status: 'failed', warning: 'invite_message_id_missing' };
  }
  try {
    await saveInviteMessageId(supabase, userId, messageId);
  } catch (e) {
    try { await failInviteDelivery(supabase, userId, claim.claimToken, 'invite_message_id_persist_failed'); } catch (e2) {}
    return { status: 'failed', warning: 'invite_message_id_persist_failed' };
  }

  // Only now (message sent AND reference persisted) mark the delivery complete.
  try { await completeInviteDelivery(supabase, userId, claim.claimToken); } catch (e) { /* rare dup risk */ }
  return { status: 'sent' };
}

module.exports = {
  // constants
  CODE_ALPHABET,
  CODE_LENGTH,
  CODE_EXPIRY_MINUTES,
  MAX_GEN_RETRIES,
  SENDER_MAX_ATTEMPTS,
  INVITE_TTL_SECONDS,
  INVITE_LINK_NAME,
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
  requestJoinButton,
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
  saveInviteMessageId,
  clearInviteMessageId,
  cleanupApprovalButton,
  readInviteLink,
  readStoredInviteByUserId,
  readStoredInviteRefByUserId,
  readJoinEligibility,
  readJoinRequestContext,
  ensureJoinRequestInvite,
  declineOutcomeCode,
  // stage 3 delivery
  deliverApprovalInvite,
  // webhook
  processWebhookUpdate,
  handleMessage,
  handleStart,
  handleCallback,
  handleChatJoinRequest,
  notifyVerifyAdminBestEffort,
  notifyAdminBestEffort
};
