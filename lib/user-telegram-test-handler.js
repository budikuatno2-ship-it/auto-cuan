'use strict';

// V3-F06: POST /api/user/telegram/test — uji kirim pesan Telegram nyata.
// - Verifikasi sesi via lib/admin-session (fail-closed 401).
// - chatId = req.user.telegram_id || body.chat_id || '6396446903' (ID Pusat Akun).
// - Baca TELEGRAM_BOT_TOKEN, kirim HTTPS nyata ke
//   https://api.telegram.org/bot<token>/sendMessage via lib/telegram-notifier
//   (skip_market_guard:true agar uji manual tidak diblokir guard intraday).
// - Teks: "Auto-Cuan Test Alert ... username (ID: chatId)".
// - Token aktif di VPS: /home/ubuntu/auto-cuan/.env TELEGRAM_BOT_TOKEN +
//   `pm2 restart all --update-env` (operator VPS; lokal memakai .env/runner .env).
// - Tidak pernah melempar; selalu JSON {ok:true} / {ok:false, error}.

const { requireAuthenticatedSession } = require('./admin-session');

const FALLBACK_CHAT_ID = '6396446903';

function isPlaceholderToken(v) {
  if (typeof v !== 'string') return true;
  const t = v.trim();
  if (!t) return true;
  if (/^\[(sensitive|redacted|secret|placeholder|todo)\]$/i.test(t)) return true;
  if (/^(CHANGEME|TODO|REDACTED|\[SENSITIVE\]|\[REDACTED\])$/i.test(t)) return true;
  return false;
}

function resolveChatId(req, session) {
  const fromUser = req && req.user && (req.user.telegram_id || req.user.telegramId || req.user.telegram_user_id);
  if (fromUser != null && String(fromUser).trim() !== '') return String(fromUser).trim();
  const body = (req && req.body) || {};
  const fromBody = body.chat_id || body.chatId || body.telegram_id || body.telegramId;
  if (fromBody != null && String(fromBody).trim() !== '') return String(fromBody).trim();
  const fromQuery = req && req.query && (req.query.chat_id || req.query.chatId);
  if (fromQuery != null && String(fromQuery).trim() !== '') return String(fromQuery).trim();
  const fromSession = session && (session.telegram_id || session.telegramId);
  if (fromSession != null && String(fromSession).trim() !== '') return String(fromSession).trim();
  return FALLBACK_CHAT_ID;
}

function resolveUsername(req, session) {
  const body = (req && req.body) || {};
  const cand = (req && req.user && (req.user.username || req.user.un))
    || body.username
    || (session && (session.un || session.username));
  const s = String(cand == null ? '' : cand).trim();
  return s || 'user';
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, success: false, error: 'Method not allowed' });

  const auth = requireAuthenticatedSession(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, success: false, error: auth.error || 'Sesi tidak valid.' });

  // Bentuk req.user ala kontrak V3-F06 agar chatId = req.user.telegram_id || '6396446903'.
  const session = auth.session || {};
  const chatId = resolveChatId(req, session);
  const username = resolveUsername(req, session);
  try {
    req.user = Object.assign({}, req.user || {}, {
      id: session.uid || (req.user && req.user.id) || null,
      username,
      telegram_id: chatId
    });
  } catch (_) {}

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || isPlaceholderToken(token)) {
    return res.status(503).json({ ok: false, success: false, error: 'TELEGRAM_BOT_TOKEN belum dikonfigurasi di server.' });
  }

  const text = 'Auto-Cuan Test Alert ✅\n'
    + 'Uji kirim pesan Telegram berhasil.\n'
    + 'Akun: ' + username + ' (ID: ' + chatId + ')\n'
    + 'Waktu: ' + new Date().toISOString();

  try {
    const notifier = require('./telegram-notifier');
    const result = await notifier.sendTelegramMessage(text, { chat_id: chatId, skip_market_guard: true });
    if (result && (result.sent === true || result.ok === true)) {
      return res.status(200).json({ ok: true, success: true, chat_id: chatId, username });
    }
    const reason = (result && (result.reason || result.error_message)) || 'telegram_send_failed';
    return res.status(502).json({ ok: false, success: false, error: 'Gagal mengirim uji pesan: ' + reason });
  } catch (e) {
    return res.status(502).json({ ok: false, success: false, error: 'Gagal mengirim uji pesan: ' + String((e && e.message) || e).slice(0, 200) });
  }
}

module.exports = handler;
module.exports.__test = { FALLBACK_CHAT_ID, resolveChatId, resolveUsername, isPlaceholderToken };
