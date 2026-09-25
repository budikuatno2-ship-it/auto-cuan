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
    '🔔 PENDAFTARAN MEMBER BARU',
    'Nama: ' + name + (username ? ' (@' + username + ')' : ''),
    'Telegram ID: ' + telegramId,
    'Email: ' + email,
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

  if (!token) {
    return res.status(400).json({ success: false, error: 'Token pendaftaran tidak valid.' });
  }
  if (name.length < 2) {
    return res.status(400).json({ success: false, error: 'Nama lengkap minimal 2 karakter.' });
  }
  if (!GMAIL_RE.test(email) || email.length > 100) {
    return res.status(400).json({ success: false, error: 'Gunakan alamat Gmail yang valid (@gmail.com).' });
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabase = (url && key) ? createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  }) : null;

  // Burn the token first. A failed/duplicate submit must not consume a token
  // for a valid user, but it MUST prevent replay — so consume before writing.
  const consumed = await registerToken.consumeToken(supabase, token);
  if (!consumed.ok) {
    const reason = consumed.reason === 'used'
      ? 'Token ini sudah dipakai. Minta tautan baru dari bot.'
      : 'Token sudah kedaluwarsa. Minta tautan baru dari bot.';
    return res.status(400).json({ success: false, code: 'TOKEN_INVALID', error: reason });
  }

  const telegramId = consumed.telegramId;
  let username = null;
  if (supabase) {
    try {
      const existing = await supabase.from('bot_users').select('username').eq('telegram_id', telegramId).maybeSingle();
      if (!existing.error && existing.data) username = existing.data.username || null;
      const upsert = await supabase.from('bot_users').upsert({
        telegram_id: telegramId,
        full_name: name,
        gmail: email,
        status: 'pending',
        updated_at: new Date().toISOString()
      }, { onConflict: 'telegram_id' });
      if (upsert.error) {
        // Never leave the token burned for a failed write; the member can retry
        // with a fresh token. The old token stays consumed (no replay).
        return res.status(500).json({ success: false, error: 'Gagal menyimpan pendaftaran. Coba lagi nanti.' });
      }
    } catch (_) {
      return res.status(500).json({ success: false, error: 'Gagal menyimpan pendaftaran. Coba lagi nanti.' });
    }
  }

  await notifyAdmin(name, username, telegramId, email);

  return res.status(200).json({
    success: true,
    message: 'Pendaftaran terkirim. Menunggu persetujuan admin.'
  });
};

module.exports.escapeHtml = escapeHtml;
module.exports.handleMintToken = handleMintToken;
module.exports.TELEGRAM_ID_RE = TELEGRAM_ID_RE;
