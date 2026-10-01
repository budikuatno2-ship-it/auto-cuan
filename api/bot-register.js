'use strict';

/**
 * Public BYOK bot registration form handler.
 *
 * Flow: the verification bot issues a one-time token (10 min, burn after use)
 * and sends the member a link to https://autocuan.web.id/register?token=... .
 * The member submits Nama Lengkap + Gmail here. On success the account is
 * stored as `pending` and the admin receives an instant DM with
 * [✅ Setujui] [❌ Tolak] buttons.
 *
 * Safety:
 *  - The token is consumed (burned) BEFORE any write, so a replayed/double
 *    submit is rejected and cannot create duplicate rows.
 *  - Email must be a valid Gmail address; the telegram id comes from the token
 *    row, never the body, so a caller cannot register someone else's id.
 *  - No secret is ever echoed back.
 */

const { createClient } = require('@supabase/supabase-js');
const registerToken = require('../lib/telegram-register-token');
const verifyBot = require('../lib/telegram-verify-bot');
const { createRateLimiter, clientAddress } = require('../lib/request-rate-limit');
const passwordCredential = require('../lib/password-credential');

const registrationLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 10 });
// Tighter bucket for token minting: a deep-link hand-off is rare, so a low
// ceiling stops a caller from farming tokens for many Telegram ids.
const mintLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 5 });
const GMAIL_RE = /^[a-z0-9](?:[a-z0-9._%+-]{0,62})@gmail\.com$/i;
const NAME_MAX = 80;
const TELEGRAM_ID_RE = /^\d{4,20}$/;

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '\u0026amp;')
    .replace(/</g, '\u0026lt;')
    .replace(/>/g, '\u0026gt;');
}

function wibTimestamp() {
  const wib = new Date(Date.now() + (7 * 60 * 60 * 1000));
  return wib.toISOString().slice(0, 16).replace('T', ' ');
}

async function notifyAdmin(name, username, telegramId, email) {
  const adminId = String(process.env.ADMIN_TELEGRAM_ID || '').trim();
  if (!adminId) return false;
  const text = [
    '🔔 Pendaftaran Akun Baru Masuk!',
    'Nama: ' + name + (username ? ' (@' + username + ')' : ''),
    'Email: ' + email,
    'Telegram ID: ' + telegramId,
    'Aksi: /approve_' + telegramId + ' atau tolak',
    'Waktu: ' + wibTimestamp() + ' WIB'
  ].join('\n');
  try {
    await verifyBot.sendMessage(adminId, text, {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Setujui', callback_data: 'approve:' + telegramId },
          { text: '❌ Tolak', callback_data: 'reject:' + telegramId }
        ]]
      }
    });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * GET /api/bot-register?action=mint-token&user_id=<telegramId>
 *
 * Deep-link hand-off: the group gatekeeper button carries `user_id` only, so the
 * form needs a one-time token before it can be submitted. This endpoint mints
 * one for that Telegram id.
 *
 * SECURITY MODEL
 *  - The minted token is only a *submission* credential: it authorizes writing a
 *    `pending` row for that Telegram id. Nothing is granted until an admin
 *    approves, and the admin notification carries the id, name, and email, so a
 *    forged id is visible at the approval step.
 *  - An account that is ALREADY active/approved is refused, so this endpoint can
 *    never be used to re-register or disturb an existing member.
 *  - Strictly rate-limited, and the id must look like a real Telegram id.
 */
async function handleMintToken(req, res) {
  if (!mintLimiter.check(clientAddress(req))) {
    return res.status(429).json({ success: false, error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }

  const userId = String((req.query && req.query.user_id) || '').trim();
  if (!TELEGRAM_ID_RE.test(userId)) {
    return res.status(400).json({ success: false, error: 'ID Telegram tidak valid. Minta tautan baru dari bot verifikasi.' });
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabase = (url && key) ? createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  }) : null;

  if (!supabase) {
    return res.status(503).json({ success: false, error: 'Pendaftaran sedang tidak tersedia. Coba lagi nanti.' });
  }

  // Refuse an id that already has a usable account: the form is for new members.
  try {
    const existing = await supabase.from('bot_users').select('status').eq('telegram_id', userId).maybeSingle();
    const status = existing && !existing.error && existing.data ? String(existing.data.status || '').toLowerCase() : '';
    if (status === 'active' || status === 'approved') {
      return res.status(409).json({ success: false, error: 'Akun ini sudah aktif. Buka bot verifikasi lalu kirim /akun.' });
    }
  } catch (_) {
    return res.status(503).json({ success: false, error: 'Pendaftaran sedang tidak tersedia. Coba lagi nanti.' });
  }

  let token = null;
  try {
    token = await registerToken.issueToken(supabase, userId, {});
  } catch (_) {
    token = null;
  }
  if (!token) {
    return res.status(503).json({ success: false, error: 'Gagal menyiapkan formulir. Coba lagi nanti.' });
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ success: true, token: token });
}

module.exports = async function handler(req, res) {
  const action = String((req.query && req.query.action) || '').trim();
  if (req.method === 'GET' && action === 'mint-token') {
    return handleMintToken(req, res);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  if (!registrationLimiter.check(clientAddress(req))) {
    return res.status(429).json({ success: false, error: 'Terlalu banyak percobaan. Coba lagi nanti.' });
  }

  const body = req.body || {};
  const token = String(body.token || '').trim();
  const name = String(body.name || '').trim().slice(0, NAME_MAX);
  const email = String(body.email || '').trim().toLowerCase();
  const suppliedUserId = String(body.user_id || '').trim();
  const password = String(body.password || '');
  const passwordConfirm = String(body.password_confirm || body.passwordConfirm || '');
  let clientPasswordHash = passwordCredential.normalizeClientHash(body.passwordHash || body.password_hash);
  const tokenError = 'Token pendaftaran tidak valid atau sudah kedaluwarsa. Silakan ketik /start di bot Telegram untuk mendapatkan tautan baru.';

  if (!token) {
    return res.status(400).json({ success: false, error: tokenError });
  }
  if (name.length < 2) {
    return res.status(400).json({ success: false, error: 'Nama lengkap minimal 2 karakter.' });
  }
  if (!GMAIL_RE.test(email) || email.length > 100) {
    return res.status(400).json({ success: false, error: 'Gunakan alamat Gmail yang valid (@gmail.com).' });
  }
  if (!clientPasswordHash) {
    if (password.length < 6 || password.length > 128) {
      return res.status(400).json({ success: false, error: 'Password minimal 6 karakter.' });
    }
    if (passwordConfirm && passwordConfirm !== password) {
      return res.status(400).json({ success: false, error: 'Konfirmasi password tidak cocok.' });
    }
    clientPasswordHash = require('crypto').createHash('sha256').update(password, 'utf8').digest('hex');
  }
  let protectedPassword;
  try { protectedPassword = passwordCredential.protectClientHash(clientPasswordHash); }
  catch (_) { return res.status(400).json({ success: false, error: 'Password tidak valid.' }); }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabase = (req && req.supabase) || ((url && key) ? createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  }) : null);

  // Burn the token first. A failed/duplicate submit must not consume a token
  // for a valid user, but it MUST prevent replay — so consume before writing.
  const consumed = await registerToken.consumeToken(supabase, token);
  if (!consumed.ok) {
    const reason = tokenError;
    return res.status(400).json({ success: false, code: 'TOKEN_INVALID', error: reason });
  }

  const telegramId = consumed.telegramId;
  let username = null;
  if (supabase) {
    try {
      const existing = await supabase.from('bot_users').select('username').eq('telegram_id', telegramId).maybeSingle();
      if (!existing.error && existing.data) username = existing.data.username || null;
      if (suppliedUserId && suppliedUserId !== String(telegramId)) {
        return res.status(400).json({ success: false, error: tokenError });
      }
      const current = await supabase.from('bot_users').select('status').eq('telegram_id', telegramId).maybeSingle();
      const currentStatus = current && !current.error && current.data ? String(current.data.status || '').toLowerCase() : '';
      if (currentStatus === 'active' || currentStatus === 'approved') {
        return res.status(409).json({ success: false, error: 'Akun ini sudah aktif. Buka bot verifikasi lalu kirim /akun.' });
      }
      const botPayload = {
        telegram_id: telegramId,
        full_name: name,
        gmail: email,
        password_hash: protectedPassword,
        status: 'pending',
        updated_at: new Date().toISOString()
      };
      let upsert = await supabase.from('bot_users').upsert(botPayload, { onConflict: 'telegram_id' });
      if (upsert.error && upsert.error.code === 'PGRST204') {
        const compatPayload = {
          telegram_id: telegramId,
          username: username || name,
          email: email,
          status: 'pending',
          updated_at: new Date().toISOString()
        };
        upsert = await supabase.from('bot_users').upsert(compatPayload, { onConflict: 'telegram_id' });
      }
      if (upsert.error) {
        // Never leave the token burned for a failed write; the member can retry
        // with a fresh token. The old token stays consumed (no replay).
        return res.status(500).json({ success: false, error: 'Gagal menyimpan pendaftaran. Coba lagi nanti.' });
      }
      try {
        await supabase.from('app_users').upsert({
          username: username || name,
          email: email,
          password_hash: protectedPassword,
          is_approved: false,
          is_blocked: false,
          device_id: 'bot_' + telegramId,
          updated_at: new Date().toISOString()
        });
      } catch (_) {}
    } catch (_) {
      return res.status(500).json({ success: false, error: 'Gagal menyimpan pendaftaran. Coba lagi nanti.' });
    }
  }

  await notifyAdmin(name, username, telegramId, email);

  return res.status(200).json({
    success: true,
    message: 'Pendaftaran berhasil dikirim! Menunggu persetujuan admin.'
  });
};

module.exports.escapeHtml = escapeHtml;
module.exports.handleMintToken = handleMintToken;
module.exports.TELEGRAM_ID_RE = TELEGRAM_ID_RE;
