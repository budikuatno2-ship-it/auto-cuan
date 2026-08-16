'use strict';

// ===========================================================================
// Admin Telegram access approval.
//
// Replaces the maintenance-page admin username/password entry with a
// Telegram-approved, browser-bound, one-time challenge. Reuses:
//   - the existing 'budi' admin account and its verified Telegram binding
//     (public.app_user_telegram_verifications, from the auth-recovery-v1
//     enrollment flow) as the ONLY identity check for approval,
//   - the existing signed HttpOnly ac_sess session (lib/admin-session.js) as
//     the ONLY thing that actually grants authorization,
//   - the existing AutoCuan Verification bot client (telegram-verify-bot.js),
//   - the existing generic webhook update dedupe table via
//     claim_auth_recovery_webhook_update / complete_auth_recovery_webhook_update.
//
// This module never grants access itself: it only ever answers "was this
// specific one-time challenge approved by the bound admin's Telegram
// account". Session issuance happens in api/reset-password.js after a
// successful consume() call, through the existing admin-session helpers.
// ===========================================================================

const crypto = require('crypto');

const REQUEST_TTL_MS = 2 * 60 * 1000; // ~2 minutes, per spec
const BINDING_COOKIE_NAME = 'ac_chal';
const BINDING_COOKIE_MAX_AGE_SECONDS = 150; // covers TTL + poll/consume round trip
const CALLBACK_APPROVE_PREFIX = 'admin_ok:';
const CALLBACK_DENY_PREFIX = 'admin_no:';
const REQUEST_REF_RE = /^[A-Za-z0-9_-]{20,60}$/;

function generateRequestRef() {
  return crypto.randomBytes(24).toString('base64url');
}

// Cryptographically random, high-entropy, never sent anywhere but this
// browser's HttpOnly cookie. Only its hash is ever stored server-side.
function generateBrowserBinding() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashBrowserBinding(value) {
  if (typeof value !== 'string' || value.length < 16) return null;
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

// Rate-limiting key only (never used for identity/authorization). Hashed so
// no raw IP is ever persisted; ips that never resolve (missing/blank) yield
// null and simply opt out of the per-IP layer for that request.
function hashIp(value) {
  if (typeof value !== 'string' || !value) return null;
  return crypto.createHash('sha256').update('admin-access-ip:' + value, 'utf8').digest('hex');
}

function firstRow(data) {
  if (Array.isArray(data)) return data[0] || null;
  return data || null;
}

async function rpc(db, name, args) {
  const result = await db.rpc(name, args);
  if (result && result.error) {
    const error = new Error('rpc_error');
    error.rpc = name;
    error.code = result.error.code || null;
    throw error;
  }
  return firstRow(result && result.data);
}

// Coarse, non-identifying context line shown to the admin in Telegram. Never
// a full user-agent string, never an IP.
function summarizeContext(userAgent) {
  const ua = String(userAgent || '');
  let label = 'Perangkat tidak dikenal';
  if (/Mobi|Android/i.test(ua)) label = 'Perangkat mobile';
  else if (/Macintosh/i.test(ua)) label = 'Mac';
  else if (/Windows/i.test(ua)) label = 'Windows';
  else if (/Linux/i.test(ua)) label = 'Linux';
  let browser = '';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/Chrome\//i.test(ua)) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua)) browser = 'Safari';
  return browser ? label + ' · ' + browser : label;
}

function formatWibTimestamp(date) {
  try {
    return new Intl.DateTimeFormat('id-ID', {
      timeZone: 'Asia/Jakarta',
      dateStyle: 'medium',
      timeStyle: 'medium'
    }).format(date) + ' WIB';
  } catch (_) {
    return date.toISOString();
  }
}

function accessRequestMessage(context) {
  return [
    '🔐 Permintaan akses administrator Auto-Cuan',
    '',
    'Waktu: ' + formatWibTimestamp(new Date()),
    'Konteks: ' + summarizeContext(context),
    '',
    'Tekan Izinkan Akses hanya jika permintaan ini memang dari kamu.',
    'Permintaan berlaku singkat dan hanya berlaku sekali pakai.'
  ].join('\n');
}

function callbackButtons(requestRef) {
  return {
    inline_keyboard: [[
      { text: 'Izinkan Akses', callback_data: CALLBACK_APPROVE_PREFIX + requestRef },
      { text: 'Tolak', callback_data: CALLBACK_DENY_PREFIX + requestRef }
    ]]
  };
}

// Creates a new challenge, sends the Telegram approval message, and records
// the sent message's identity so it can later be disabled/deleted.
// Returns: { eligible, delivered, requestRef, expiresAt, browserBinding }
async function requestAccess(db, bot, opts) {
  const username = 'budi';
  const requestRef = generateRequestRef();
  const browserBinding = generateBrowserBinding();
  const browserBindingHash = hashBrowserBinding(browserBinding);
  const expiresAt = new Date(Date.now() + REQUEST_TTL_MS).toISOString();

  const row = await rpc(db, 'create_admin_access_request', {
    p_username: username,
    p_request_ref: requestRef,
    p_browser_binding_hash: browserBindingHash,
    p_expires_at: expiresAt,
    p_context: (opts && opts.context) || '',
    p_ip_hash: hashIp(opts && opts.ip)
  });

  if (!row || row.result_code !== 'ok' || !row.telegram_chat_id) {
    return { eligible: false, delivered: false, reason: row && row.result_code, expiresAt: row && row.expires_at };
  }

  try {
    const sent = await bot.sendMessage(
      row.telegram_chat_id,
      accessRequestMessage(opts && opts.context),
      { reply_markup: callbackButtons(requestRef) }
    );
    if (sent && sent.message_id) {
      try {
        await rpc(db, 'record_admin_access_message', {
          p_request_ref: requestRef,
          p_telegram_chat_id: row.telegram_chat_id,
          p_telegram_message_id: sent.message_id
        });
      } catch (_) {}
    }
    return {
      eligible: true,
      delivered: true,
      requestRef: requestRef,
      expiresAt: row.expires_at || expiresAt,
      browserBinding: browserBinding
    };
  } catch (_) {
    return { eligible: true, delivered: false };
  }
}

// Browser poll/consume. On 'ok' the caller (api/reset-password.js) is
// responsible for issuing the actual ac_sess session — this function only
// reports whether the challenge was approved by the bound admin's Telegram.
async function consumeAccess(db, requestRef, browserBindingRaw) {
  if (typeof requestRef !== 'string' || !REQUEST_REF_RE.test(requestRef)) {
    return { result_code: 'not_found' };
  }
  const hash = hashBrowserBinding(browserBindingRaw);
  if (!hash) return { result_code: 'not_found' };

  const row = await rpc(db, 'consume_admin_access_request', {
    p_request_ref: requestRef,
    p_browser_binding_hash: hash
  });
  return row || { result_code: 'not_found' };
}

// Best-effort cleanup of the Telegram message after a successful consume.
// Deletion failure must never affect security: the challenge is already
// 'consumed' server-side by the time this runs, so the message existing or
// not existing cannot revalidate it.
async function cleanupMessage(bot, chatId, messageId) {
  if (!bot || !Number.isSafeInteger(Number(chatId)) || !Number.isSafeInteger(Number(messageId))) return;
  try {
    if (typeof bot.deleteMessage === 'function') {
      await bot.deleteMessage(chatId, messageId);
      return;
    }
  } catch (_) {}
  try { await bot.editMessageReplyMarkup(chatId, messageId); } catch (_) {}
}

async function claimWebhookUpdate(db, updateId) {
  const row = await rpc(db, 'claim_auth_recovery_webhook_update', { p_update_id: updateId });
  return !!(row && row.claimed);
}

async function completeWebhookUpdate(db, updateId, outcome) {
  try {
    await db.rpc('complete_auth_recovery_webhook_update', {
      p_update_id: updateId,
      p_outcome_code: String(outcome || 'unknown').slice(0, 80)
    });
  } catch (_) {}
}

async function answerCallbackSafely(bot, callbackId, text) {
  try { await bot.answerCallbackQuery(callbackId, { text: text }); } catch (_) {}
}

async function disableMessageControls(bot, chatId, messageId, text) {
  if (!bot || chatId == null || messageId == null) return;
  try {
    await bot.editMessageText(chatId, messageId, text, { reply_markup: { inline_keyboard: [] } });
  } catch (_) {
    try { await bot.editMessageReplyMarkup(chatId, messageId); } catch (_) {}
  }
}

async function handleApproveCallback(callback, db, bot, requestRef) {
  const from = callback.from || {};
  const message = callback.message || {};
  const chat = message.chat || {};

  const row = await rpc(db, 'approve_admin_access_request', {
    p_request_ref: requestRef,
    p_telegram_user_id: from.id
  });

  const code = (row && row.result_code) || 'not_found';
  if (code === 'ok') {
    await answerCallbackSafely(bot, callback.id, 'Akses disetujui.');
    await disableMessageControls(bot, chat.id, message.message_id,
      '✅ Akses disetujui. Menunggu browser menyelesaikan proses masuk.');
    return { handled: true, outcome: 'admin_access_approved' };
  }
  if (code === 'identity_mismatch') {
    await answerCallbackSafely(bot, callback.id, 'Akun Telegram ini bukan admin terverifikasi.');
    return { handled: true, outcome: 'admin_access_identity_mismatch' };
  }
  if (code === 'expired') {
    await answerCallbackSafely(bot, callback.id, 'Permintaan sudah kedaluwarsa.');
    await disableMessageControls(bot, chat.id, message.message_id, '⏱️ Permintaan sudah kedaluwarsa.');
    return { handled: true, outcome: 'admin_access_expired' };
  }
  if (code.indexOf('already_') === 0) {
    await answerCallbackSafely(bot, callback.id, 'Permintaan ini sudah diproses.');
    return { handled: true, outcome: 'admin_access_already_processed' };
  }
  await answerCallbackSafely(bot, callback.id, 'Permintaan tidak ditemukan.');
  return { handled: true, outcome: 'admin_access_not_found' };
}

async function handleDenyCallback(callback, db, bot, requestRef) {
  const from = callback.from || {};
  const message = callback.message || {};
  const chat = message.chat || {};

  const row = await rpc(db, 'deny_admin_access_request', {
    p_request_ref: requestRef,
    p_telegram_user_id: from.id
  });

  const code = (row && row.result_code) || 'not_found';
  if (code === 'ok') {
    await answerCallbackSafely(bot, callback.id, 'Permintaan ditolak.');
    await disableMessageControls(bot, chat.id, message.message_id, '❌ Akses ditolak dari Telegram.');
    return { handled: true, outcome: 'admin_access_denied' };
  }
  if (code === 'identity_mismatch') {
    await answerCallbackSafely(bot, callback.id, 'Akun Telegram ini bukan admin terverifikasi.');
    return { handled: true, outcome: 'admin_access_identity_mismatch' };
  }
  if (code === 'expired') {
    await answerCallbackSafely(bot, callback.id, 'Permintaan sudah kedaluwarsa.');
    await disableMessageControls(bot, chat.id, message.message_id, '⏱️ Permintaan sudah kedaluwarsa.');
    return { handled: true, outcome: 'admin_access_expired' };
  }
  if (code.indexOf('already_') === 0) {
    await answerCallbackSafely(bot, callback.id, 'Permintaan ini sudah diproses.');
    return { handled: true, outcome: 'admin_access_already_processed' };
  }
  await answerCallbackSafely(bot, callback.id, 'Permintaan tidak ditemukan.');
  return { handled: true, outcome: 'admin_access_not_found' };
}

// Dispatches an incoming Telegram webhook update if (and only if) it is an
// admin-access approve/deny callback. Returns { handled:false } for anything
// else so the caller can fall through to other handlers untouched.
async function handleAdminAccessUpdate(update, options) {
  const db = options && options.db;
  const bot = options && options.bot;
  if (!db || !bot || !update || !Number.isSafeInteger(update.update_id)) {
    return { handled: false, outcome: 'invalid_update' };
  }

  const callback = update.callback_query;
  if (!callback || typeof callback.data !== 'string') return { handled: false, outcome: 'not_admin_access' };

  const approve = callback.data.startsWith(CALLBACK_APPROVE_PREFIX);
  const deny = callback.data.startsWith(CALLBACK_DENY_PREFIX);
  if (!approve && !deny) return { handled: false, outcome: 'not_admin_access' };

  const from = callback.from || {};
  const message = callback.message || {};
  const chat = message.chat || {};
  if (!Number.isSafeInteger(from.id) || !Number.isSafeInteger(chat.id) || !Number.isSafeInteger(message.message_id)) {
    return { handled: false, outcome: 'not_admin_access' };
  }

  const requestRef = callback.data.slice((approve ? CALLBACK_APPROVE_PREFIX : CALLBACK_DENY_PREFIX).length);
  if (!REQUEST_REF_RE.test(requestRef)) {
    await answerCallbackSafely(bot, callback.id, 'Permintaan tidak valid.');
    return { handled: true, outcome: 'admin_access_invalid_ref' };
  }

  const claimed = await claimWebhookUpdate(db, update.update_id);
  if (!claimed) {
    // Duplicate delivery of an update we already processed. Telegram still
    // needs the spinner cleared, so answer harmlessly without touching state.
    await answerCallbackSafely(bot, callback.id, 'Permintaan sudah diproses.');
    return { handled: true, outcome: 'duplicate' };
  }

  let result;
  try {
    result = approve
      ? await handleApproveCallback(callback, db, bot, requestRef)
      : await handleDenyCallback(callback, db, bot, requestRef);
    return result;
  } catch (_) {
    await answerCallbackSafely(bot, callback.id, 'Terjadi kesalahan. Coba lagi.');
    result = { handled: true, outcome: 'admin_access_failed' };
    return result;
  } finally {
    await completeWebhookUpdate(db, update.update_id, (result && result.outcome) || 'admin_access_failed');
  }
}

module.exports = {
  REQUEST_TTL_MS,
  BINDING_COOKIE_NAME,
  BINDING_COOKIE_MAX_AGE_SECONDS,
  CALLBACK_APPROVE_PREFIX,
  CALLBACK_DENY_PREFIX,
  generateRequestRef,
  generateBrowserBinding,
  hashBrowserBinding,
  hashIp,
  requestAccess,
  consumeAccess,
  cleanupMessage,
  handleAdminAccessUpdate,
  __test: {
    accessRequestMessage,
    callbackButtons,
    summarizeContext
  }
};
