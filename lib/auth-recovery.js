'use strict';

const crypto = require('crypto');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const ENROLLMENT_TTL_MS = 15 * 60 * 1000;
const RESET_REQUEST_TTL_MS = 10 * 60 * 1000;
const RESET_GRANT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_BASE_URL = 'https://autocuan.web.id';
const BOT_URL = 'https://t.me/AutoCuanVerificationBot';
const CALLBACK_APPROVE_PREFIX = 'auth_reset_ok:';
const CALLBACK_DENY_PREFIX = 'auth_reset_no:';

function getRecoverySecret() {
  const value = process.env.TELEGRAM_VERIFY_CODE_SECRET;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function hmac(kind, normalized) {
  const secret = getRecoverySecret();
  if (!secret || !normalized) return null;
  return crypto
    .createHmac('sha256', secret)
    .update('auth-recovery-v1:' + kind + ':' + normalized, 'utf8')
    .digest('hex');
}

function randomAlphabetCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return out;
}

function generateEnrollmentCode() {
  const raw = randomAlphabetCode();
  return 'AR-' + raw.slice(0, 4) + '-' + raw.slice(4);
}

function normalizeEnrollmentCode(input) {
  const compact = String(input || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (!compact.startsWith('AR')) return null;
  const code = compact.slice(2);
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) {
    if (!CODE_ALPHABET.includes(ch)) return null;
  }
  return code;
}

function hashEnrollmentCode(input) {
  return hmac('telegram-enroll', normalizeEnrollmentCode(input));
}

function generateRequestRef() {
  return crypto.randomBytes(12).toString('base64url');
}

function generateResetToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function normalizeResetToken(token) {
  const value = String(token || '').trim();
  return /^[A-Za-z0-9_-]{32,100}$/.test(value) ? value : null;
}

function hashResetToken(token) {
  return hmac('password-reset', normalizeResetToken(token));
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

function callbackButtons(requestRef) {
  return {
    inline_keyboard: [[
      { text: 'Konfirmasi Reset', callback_data: CALLBACK_APPROVE_PREFIX + requestRef },
      { text: 'Tolak', callback_data: CALLBACK_DENY_PREFIX + requestRef }
    ]]
  };
}

function resetRequestMessage(username) {
  return [
    '🔐 Permintaan reset password Auto-Cuan',
    '',
    'Akun: ' + String(username || '').trim().toLowerCase(),
    '',
    'Tekan Konfirmasi Reset hanya jika permintaan ini memang dari kamu.',
    'Permintaan berlaku 10 menit.'
  ].join('\n');
}

async function createPasswordResetRequest(db, bot, username) {
  const requestRef = generateRequestRef();
  const expiresAt = new Date(Date.now() + RESET_REQUEST_TTL_MS).toISOString();
  const row = await rpc(db, 'create_auth_password_reset_request', {
    p_username: String(username || '').trim().toLowerCase(),
    p_request_ref: requestRef,
    p_expires_at: expiresAt
  });

  if (!row || row.result_code !== 'ok' || !row.telegram_private_chat_id) {
    return { eligible: false, delivered: false };
  }

  try {
    await bot.sendMessage(
      row.telegram_private_chat_id,
      resetRequestMessage(row.username),
      { reply_markup: callbackButtons(requestRef) }
    );
    return { eligible: true, delivered: true, requestRef: requestRef };
  } catch (_) {
    try {
      await db
        .from('auth_recovery_requests')
        .update({ state: 'delivery_failed', updated_at: new Date().toISOString() })
        .eq('request_ref', requestRef);
    } catch (_) {}
    return { eligible: true, delivered: false };
  }
}

async function createAdminEnrollment(db, username) {
  const code = generateEnrollmentCode();
  const codeHash = hashEnrollmentCode(code);
  if (!codeHash) throw new Error('recovery_secret_missing');

  const requestRef = generateRequestRef();
  const expiresAt = new Date(Date.now() + ENROLLMENT_TTL_MS).toISOString();
  const row = await rpc(db, 'create_auth_telegram_enrollment_request', {
    p_username: String(username || 'budi').trim().toLowerCase(),
    p_request_ref: requestRef,
    p_code_hash: codeHash,
    p_expires_at: expiresAt
  });

  if (!row || row.result_code !== 'ok') {
    const error = new Error(row && row.result_code ? row.result_code : 'enrollment_failed');
    error.resultCode = row && row.result_code;
    throw error;
  }

  return { code: code, requestRef: requestRef, expiresAt: row.expires_at || expiresAt };
}

async function claimRecoveryUpdate(db, updateId) {
  const row = await rpc(db, 'claim_auth_recovery_webhook_update', {
    p_update_id: updateId
  });
  return !!(row && row.claimed);
}

async function completeRecoveryUpdate(db, updateId, outcome) {
  try {
    await db.rpc('complete_auth_recovery_webhook_update', {
      p_update_id: updateId,
      p_outcome_code: String(outcome || 'unknown').slice(0, 80)
    });
  } catch (_) {}
}

function safeBaseUrl(input) {
  const raw = String(input || DEFAULT_BASE_URL).trim();
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return DEFAULT_BASE_URL;
    return parsed.origin;
  } catch (_) {
    return DEFAULT_BASE_URL;
  }
}

async function handleEnrollmentMessage(update, db, bot) {
  const message = update && update.message;
  const from = message && message.from;
  const chat = message && message.chat;
  if (!message || !from || !chat || chat.type !== 'private') return null;
  if (!Number.isSafeInteger(from.id) || !Number.isSafeInteger(chat.id)) return null;

  const normalized = normalizeEnrollmentCode(message.text);
  if (!normalized) return null;
  const codeHash = hmac('telegram-enroll', normalized);
  if (!codeHash) return { handled: true, outcome: 'config_missing' };

  const row = await rpc(db, 'consume_auth_telegram_enrollment', {
    p_code_hash: codeHash,
    p_telegram_user_id: from.id,
    p_private_chat_id: chat.id
  });

  if (row && row.result_code === 'ok') {
    await bot.sendMessage(chat.id, [
      '✅ Telegram berhasil dihubungkan',
      '',
      'Akun Auto-Cuan: ' + String(row.username || 'budi'),
      'Sekarang kamu bisa meminta reset password dari website.'
    ].join('\n'));
    return { handled: true, outcome: 'enrollment_ok' };
  }

  await bot.sendMessage(chat.id, [
    'Kode penghubung tidak valid atau sudah kedaluwarsa.',
    '',
    'Buat kode baru dari server Auto-Cuan lalu coba lagi.'
  ].join('\n'));
  return { handled: true, outcome: 'enrollment_rejected' };
}

async function handleResetCallback(update, db, bot, baseUrl) {
  const callback = update && update.callback_query;
  if (!callback || typeof callback.data !== 'string') return null;
  const from = callback.from || {};
  const message = callback.message || {};
  const chat = message.chat || {};
  if (!Number.isSafeInteger(from.id) || !Number.isSafeInteger(chat.id)) return null;

  const approve = callback.data.startsWith(CALLBACK_APPROVE_PREFIX);
  const deny = callback.data.startsWith(CALLBACK_DENY_PREFIX);
  if (!approve && !deny) return null;

  const requestRef = callback.data.slice(
    approve ? CALLBACK_APPROVE_PREFIX.length : CALLBACK_DENY_PREFIX.length
  );
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(requestRef)) {
    try { await bot.answerCallbackQuery(callback.id, { text: 'Permintaan tidak valid.' }); } catch (_) {}
    return { handled: true, outcome: 'callback_invalid' };
  }

  if (deny) {
    const row = await rpc(db, 'deny_auth_password_reset_request', {
      p_request_ref: requestRef,
      p_telegram_user_id: from.id
    });
    try { await bot.answerCallbackQuery(callback.id, { text: 'Permintaan ditolak.' }); } catch (_) {}
    if (row && row.result_code === 'ok') {
      try {
        await bot.editMessageText(chat.id, message.message_id, [
          '❌ Permintaan reset password ditolak',
          '',
          'Tidak ada perubahan pada password akun Auto-Cuan.'
        ].join('\n'), { reply_markup: { inline_keyboard: [] } });
      } catch (_) {}
      return { handled: true, outcome: 'reset_denied' };
    }
    return { handled: true, outcome: 'reset_deny_not_found' };
  }

  const resetToken = generateResetToken();
  const resetTokenHash = hashResetToken(resetToken);
  if (!resetTokenHash) {
    try { await bot.answerCallbackQuery(callback.id, { text: 'Recovery belum tersedia.' }); } catch (_) {}
    return { handled: true, outcome: 'config_missing' };
  }

  const resetExpiresAt = new Date(Date.now() + RESET_GRANT_TTL_MS).toISOString();
  const row = await rpc(db, 'approve_auth_password_reset_request', {
    p_request_ref: requestRef,
    p_telegram_user_id: from.id,
    p_reset_token_hash: resetTokenHash,
    p_reset_expires_at: resetExpiresAt
  });

  if (!row || row.result_code !== 'ok') {
    try { await bot.answerCallbackQuery(callback.id, { text: 'Permintaan sudah tidak berlaku.' }); } catch (_) {}
    return { handled: true, outcome: 'reset_approve_rejected' };
  }

  const resetUrl = safeBaseUrl(baseUrl) + '/?reset_token=' + encodeURIComponent(resetToken);
  try { await bot.answerCallbackQuery(callback.id, { text: 'Reset dikonfirmasi.' }); } catch (_) {}
  try {
    await bot.editMessageText(chat.id, message.message_id, [
      '✅ Reset password dikonfirmasi',
      '',
      'Buka tautan sekali pakai berikut untuk membuat password baru:',
      resetUrl,
      '',
      'Tautan berlaku 10 menit dan hanya dapat digunakan satu kali.'
    ].join('\n'), { reply_markup: { inline_keyboard: [] } });
  } catch (_) {
    await bot.sendMessage(chat.id, [
      '✅ Reset password dikonfirmasi',
      '',
      resetUrl,
      '',
      'Tautan berlaku 10 menit dan hanya dapat digunakan satu kali.'
    ].join('\n'));
  }
  return { handled: true, outcome: 'reset_approved' };
}

async function handleRecoveryUpdate(update, options) {
  const db = options && options.db;
  const bot = options && options.bot;
  if (!db || !bot || !update || !Number.isSafeInteger(update.update_id)) {
    return { handled: false, outcome: 'invalid_update' };
  }

  let recoveryShape = false;
  if (update.callback_query && typeof update.callback_query.data === 'string') {
    recoveryShape = update.callback_query.data.startsWith(CALLBACK_APPROVE_PREFIX) ||
      update.callback_query.data.startsWith(CALLBACK_DENY_PREFIX);
  }
  if (!recoveryShape && update.message && typeof update.message.text === 'string') {
    recoveryShape = normalizeEnrollmentCode(update.message.text) !== null;
  }
  if (!recoveryShape) return { handled: false, outcome: 'not_recovery' };

  const claimed = await claimRecoveryUpdate(db, update.update_id);
  if (!claimed) return { handled: true, outcome: 'duplicate' };

  let result;
  try {
    result = await handleResetCallback(update, db, bot, options && options.baseUrl);
    if (!result) result = await handleEnrollmentMessage(update, db, bot);
    if (!result) result = { handled: false, outcome: 'not_recovery' };
    return result;
  } catch (_) {
    return { handled: true, outcome: 'recovery_failed' };
  } finally {
    await completeRecoveryUpdate(db, update.update_id, result && result.outcome || 'recovery_failed');
  }
}

module.exports = {
  BOT_URL,
  ENROLLMENT_TTL_MS,
  RESET_REQUEST_TTL_MS,
  RESET_GRANT_TTL_MS,
  CALLBACK_APPROVE_PREFIX,
  CALLBACK_DENY_PREFIX,
  getRecoverySecret,
  generateEnrollmentCode,
  normalizeEnrollmentCode,
  hashEnrollmentCode,
  generateRequestRef,
  generateResetToken,
  normalizeResetToken,
  hashResetToken,
  createPasswordResetRequest,
  createAdminEnrollment,
  handleRecoveryUpdate,
  __test: {
    callbackButtons,
    resetRequestMessage,
    safeBaseUrl,
    hmac
  }
};
