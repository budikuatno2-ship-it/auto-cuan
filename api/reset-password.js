'use strict';

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const {
  createSessionToken,
  buildSessionCookie,
  buildClearCookie,
  isSameOrigin,
  requireAuthenticatedSession
} = require('../lib/admin-session');
const securityGuard = require('../lib/security-guard');
const telegramVerification = require('../lib/telegram-verification');
const { createVerifyBot } = require('../lib/telegram-verify-bot');
const recovery = require('../lib/auth-recovery');
const { generateApprovalCode, maskUsername } = require('../lib/free-user-approval');

const GENERIC_CREDENTIAL_ERROR = 'Username atau password salah.';
const MAX_WEBHOOK_BODY_BYTES = 32 * 1024;

function getDb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });
}

function secretsMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    try { crypto.timingSafeEqual(b, b); } catch (_) {}
    return false;
  }
  try { return crypto.timingSafeEqual(a, b); } catch (_) { return false; }
}

function hashesMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    try { crypto.timingSafeEqual(right, right); } catch (_) {}
    return false;
  }
  try { return crypto.timingSafeEqual(left, right); } catch (_) { return false; }
}

function validUsername(value) {
  const username = String(value || '').trim().toLowerCase();
  return username.length >= 2 && username.length <= 30 ? username : null;
}

function validPasswordHash(value) {
  const hash = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(hash) ? hash : null;
}

function clearSession(res) {
  try { res.setHeader('Set-Cookie', buildClearCookie()); } catch (_) {}
}

async function handleVerifyWebhook(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });

  const expected = process.env.TELEGRAM_VERIFY_WEBHOOK_SECRET;
  const provided = req.headers && req.headers['x-telegram-bot-api-secret-token'];
  if (!expected || !secretsMatch(provided, expected)) {
    return res.status(401).json({ ok: false });
  }

  const contentLength = Number(req.headers && req.headers['content-length'] || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BODY_BYTES) {
    return res.status(413).json({ ok: false });
  }

  const update = req.body || {};
  try {
    if (JSON.stringify(update).length > MAX_WEBHOOK_BODY_BYTES) {
      return res.status(413).json({ ok: false });
    }
  } catch (_) {
    return res.status(400).json({ ok: false });
  }

  if (!Number.isSafeInteger(update.update_id)) {
    return res.status(200).json({ ok: true, ignored: true });
  }

  const db = getDb();
  if (!db) return res.status(200).json({ ok: true });

  try {
    const bot = createVerifyBot();
    const recoveryResult = await recovery.handleRecoveryUpdate(update, {
      db: db,
      bot: bot,
      baseUrl: process.env.AUTH_RECOVERY_BASE_URL || 'https://autocuan.web.id'
    });

    if (recoveryResult && recoveryResult.handled) {
      return res.status(200).json({ ok: true, outcome: recoveryResult.outcome });
    }

    const result = await telegramVerification.processWebhookUpdate(update, {
      supabase: db,
      bot: bot
    });
    return res.status(200).json({ ok: true, outcome: result && result.outcome });
  } catch (_) {
    return res.status(200).json({ ok: true, outcome: 'safe_failure' });
  }
}

async function login(req, res, db) {
  const username = validUsername(req.body && req.body.username);
  const passwordHash = validPasswordHash(req.body && req.body.passwordHash);
  if (!username || !passwordHash) {
    return res.status(400).json({ success: false, error: 'Data login tidak valid.' });
  }

  const loginGuard = await securityGuard.beginLogin({ req: req, db: db, username: username });
  if (loginGuard.deny) {
    if (loginGuard.retryAfterSeconds > 0) {
      res.setHeader('Retry-After', String(loginGuard.retryAfterSeconds));
    }
    return res.status(loginGuard.httpStatus || 429).json({
      success: false,
      error: loginGuard.publicError || 'Terlalu banyak percobaan login. Coba lagi nanti.'
    });
  }

  const lookup = await db
    .from('app_users')
    .select('id, username, password_hash, is_blocked, is_approved, created_at')
    .eq('username', username)
    .maybeSingle();

  if (lookup.error) {
    return res.status(503).json({ success: false, error: 'Login sementara tidak tersedia.' });
  }

  const user = lookup.data;
  if (!user || !hashesMatch(user.password_hash, passwordHash)) {
    await loginGuard.failure(user ? 'bad_password' : 'unknown_account');
    return res.status(400).json({ success: false, error: GENERIC_CREDENTIAL_ERROR });
  }

  await loginGuard.credentialAccepted('credentials_valid');

  if (user.is_blocked === true) {
    return res.status(403).json({ success: false, error: 'Akun sedang diblokir.' });
  }

  if (username !== 'review' && user.is_approved !== true) {
    const pendingResponse = {
      success: false,
      approval_status: 'pending',
      approval_code: generateApprovalCode({
        id: user.id,
        username: user.username,
        created_at: user.created_at
      }),
      masked_username: maskUsername(user.username),
      telegram_bot_url: telegramVerification.BOT_URL
    };

    try {
      if (telegramVerification.hasCodeSecret()) {
        const issued = await telegramVerification.issueChallengeForUser(db, user.id);
        if (issued) {
          pendingResponse.telegram_verification_code = issued.displayCode;
          pendingResponse.telegram_verification_expires_at = issued.expiresAt;
        }
      }
    } catch (_) {}

    return res.status(403).json(pendingResponse);
  }

  const token = createSessionToken({
    userId: user.id,
    username: username,
    isAdmin: username === 'budi'
  });

  if (!token) {
    return res.status(503).json({ success: false, error: 'Login sementara tidak tersedia.' });
  }

  try {
    res.setHeader('Set-Cookie', buildSessionCookie(token));
  } catch (_) {
    return res.status(503).json({ success: false, error: 'Login sementara tidak tersedia.' });
  }

  try {
    await db
      .from('app_users')
      .update({
        last_login_at: new Date().toISOString(),
        user_agent: String(req.body && req.body.userAgent || '').slice(0, 500)
      })
      .eq('id', user.id);
  } catch (_) {}

  return res.status(200).json({
    success: true,
    username: username,
    userId: user.id,
    isAdmin: username === 'budi',
    isReview: username === 'review'
  });
}

async function sessionStatus(req, res, db) {
  res.setHeader('Cache-Control', 'private, no-store');
  const auth = requireAuthenticatedSession(req);
  if (!auth.ok) {
    clearSession(res);
    return res.status(401).json({ success: false, error: 'Sesi tidak valid.' });
  }

  const lookup = await db
    .from('app_users')
    .select('id, username, is_blocked, is_approved')
    .eq('id', auth.session.uid)
    .maybeSingle();

  if (lookup.error) {
    return res.status(503).json({ success: false, error: 'Status sesi belum tersedia.' });
  }

  const account = lookup.data;
  const signedUsername = String(auth.session.un || '').trim().toLowerCase();
  const databaseUsername = String(account && account.username || '').trim().toLowerCase();

  if (!account || !signedUsername || signedUsername !== databaseUsername) {
    clearSession(res);
    return res.status(401).json({ success: false, error: 'Sesi tidak valid.' });
  }

  if (account.is_blocked === true) {
    clearSession(res);
    return res.status(403).json({ success: false, error: 'Akun sedang diblokir.' });
  }

  if (databaseUsername !== 'review' && account.is_approved !== true) {
    clearSession(res);
    return res.status(403).json({ success: false, error: 'Akun belum di-approve admin.' });
  }

  return res.status(200).json({
    success: true,
    userId: String(account.id),
    username: databaseUsername,
    isAdmin: auth.session.adm === true && databaseUsername === 'budi',
    isReview: databaseUsername === 'review'
  });
}

async function requestPasswordReset(req, res, db) {
  const username = validUsername(req.body && req.body.username);
  if (!username) {
    return res.status(200).json({
      success: true,
      message: 'Jika akun terhubung ke Telegram, permintaan konfirmasi akan dikirim.'
    });
  }

  try {
    const bot = createVerifyBot();
    await recovery.createPasswordResetRequest(db, bot, username);
  } catch (_) {
    return res.status(503).json({
      success: false,
      error: 'Pemulihan password sementara belum tersedia.'
    });
  }

  return res.status(200).json({
    success: true,
    message: 'Jika akun terhubung ke Telegram, permintaan konfirmasi akan dikirim.',
    telegram_bot_url: recovery.BOT_URL
  });
}

async function completePasswordReset(req, res, db) {
  const resetTokenHash = recovery.hashResetToken(req.body && req.body.resetToken);
  const newPasswordHash = validPasswordHash(req.body && req.body.newPasswordHash);
  if (!resetTokenHash || !newPasswordHash) {
    return res.status(400).json({
      success: false,
      error: 'Tautan reset tidak valid atau password baru tidak memenuhi ketentuan.'
    });
  }

  const result = await db.rpc('consume_auth_password_reset_v2', {
    p_reset_token_hash: resetTokenHash,
    p_new_password_hash: newPasswordHash
  });

  if (result.error) {
    return res.status(503).json({ success: false, error: 'Reset password sementara belum tersedia.' });
  }

  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  if (!row || row.result_code !== 'ok') {
    return res.status(400).json({
      success: false,
      error: 'Tautan reset tidak valid, sudah dipakai, atau sudah kedaluwarsa.'
    });
  }

  let telegramNotice = { updated: false, fallbackSent: false };
  try {
    telegramNotice = await recovery.notifyPasswordResetCompleted(
      createVerifyBot(),
      row.reset_message_chat_id,
      row.reset_message_id,
      row.username
    );
  } catch (_) {}

  if (telegramNotice.updated || telegramNotice.fallbackSent) {
    try {
      await db
        .from('auth_recovery_requests')
        .update({ telegram_completion_notified_at: new Date().toISOString() })
        .eq('id', row.request_id);
    } catch (_) {}
  }

  clearSession(res);
  return res.status(200).json({
    success: true,
    username: row.username,
    telegram_confirmation_updated: telegramNotice.updated === true,
    message: 'Password berhasil diperbarui. Silakan login menggunakan password baru.'
  });
}

module.exports = async function handler(req, res) {
  const queryAction = req.query && req.query.action;
  if (queryAction === 'telegram-verify-webhook-v3') {
    return handleVerifyWebhook(req, res);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  if (!isSameOrigin(req)) {
    return res.status(403).json({ success: false, error: 'Permintaan ditolak.' });
  }

  const action = String(req.body && req.body.action || '').trim();

  if (action === 'logout') {
    clearSession(res);
    return res.status(200).json({ success: true });
  }

  const db = getDb();
  if (!db) {
    return res.status(503).json({ success: false, error: 'Layanan akun belum tersedia.' });
  }

  try {
    if (action === 'login') return await login(req, res, db);
    if (action === 'session-status') return await sessionStatus(req, res, db);
    if (action === 'request-password-reset') return await requestPasswordReset(req, res, db);
    if (action === 'complete-password-reset') return await completePasswordReset(req, res, db);

    return res.status(400).json({
      success: false,
      error: 'Gunakan alur pemulihan password melalui Telegram.'
    });
  } catch (_) {
    return res.status(500).json({ success: false, error: 'Terjadi gangguan pada layanan akun.' });
  }
};

module.exports.__test = {
  secretsMatch,
  hashesMatch,
  validUsername,
  validPasswordHash
};
