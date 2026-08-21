'use strict';

const { createClient } = require('@supabase/supabase-js');
const {
  createSessionToken,
  buildSessionCookie,
  isSameOrigin,
  requireAdminSession
} = require('./admin-session');
const { createVerifyBot } = require('./telegram-verify-bot');
const maintenanceCode = require('./admin-maintenance-code');
const { readMaintenanceState } = require('./maintenance-state');

const CLEANUP_REF_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getDb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
}

function firstRow(data) {
  if (Array.isArray(data)) return data[0] || null;
  return data || null;
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

function coarseDeviceLabel(userAgent) {
  const ua = String(userAgent || '');
  let platform = 'Perangkat tidak dikenal';
  if (/Windows/i.test(ua)) platform = 'Windows';
  else if (/Macintosh|Mac OS/i.test(ua)) platform = 'Mac';
  else if (/Android/i.test(ua)) platform = 'Android';
  else if (/iPhone|iPad|iPod/i.test(ua)) platform = 'iPhone/iPad';
  else if (/Linux/i.test(ua)) platform = 'Linux';

  let browser = '';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/Chrome\//i.test(ua)) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua)) browser = 'Safari';
  return browser ? platform + ' · ' + browser : platform;
}

async function featureStatus(db) {
  try {
    const result = await db.rpc('get_admin_maintenance_code_status');
    if (result.error) return { available: false, row: null };
    return { available: true, row: firstRow(result.data) };
  } catch (_) {
    return { available: false, row: null };
  }
}

async function status(req, res, db) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!isSameOrigin(req)) {
    return res.status(403).json({ success: false, featureAvailable: false, state: 'rejected' });
  }

  const maintenance = await readMaintenanceState(db);
  if (!maintenance.available) {
    return res.status(503).json({ success: false, featureAvailable: true, state: 'unavailable' });
  }
  if (!maintenance.enabled) {
    return res.status(200).json({ success: true, featureAvailable: true, state: 'idle', maintenanceMode: false, expiresAt: null });
  }

  const result = await featureStatus(db);
  if (!result.available) {
    return res.status(503).json({ success: false, featureAvailable: true, state: 'unavailable', maintenanceMode: true });
  }

  const row = result.row || {};
  return res.status(200).json({
    success: true,
    featureAvailable: true,
    maintenanceMode: true,
    state: row.active === true ? 'active' : 'idle',
    expiresAt: row.expires_at || null
  });
}

async function deleteMessageSafely(bot, chatId, messageId) {
  if (!Number.isSafeInteger(Number(chatId)) || !Number.isSafeInteger(Number(messageId))) return false;
  try {
    await bot.deleteMessage(Number(chatId), Number(messageId));
    return true;
  } catch (_) {
    return false;
  }
}

async function notifySuccessfulLogin(db, row, userAgent) {
  if (Number.isSafeInteger(Number(row && row.telegram_success_message_id))) {
    return Number(row.telegram_success_message_id);
  }

  const chatId = Number(row && row.telegram_chat_id);
  if (!Number.isSafeInteger(chatId)) return null;

  const bot = createVerifyBot();
  await deleteMessageSafely(bot, chatId, row.telegram_code_message_id);

  let sent = null;
  try {
    sent = await bot.sendMessage(
      chatId,
      [
        '✅ Login administrator berhasil',
        '',
        'Waktu: ' + formatWibTimestamp(new Date()),
        'Perangkat: ' + coarseDeviceLabel(userAgent),
        '',
        'Kode sudah dinonaktifkan dan tidak dapat dipakai lagi.',
        'Pesan ini akan dibersihkan otomatis dari chat.'
      ].join('\n')
    );
  } catch (_) {}

  const grantId = row && (row.grant_id || row.id);
  if (sent && Number.isSafeInteger(Number(sent.message_id)) && grantId) {
    try {
      await db
        .from('admin_command_login_grants')
        .update({ telegram_success_message_id: Number(sent.message_id), updated_at: new Date().toISOString() })
        .eq('id', grantId)
        .eq('grant_purpose', 'maintenance_code')
        .is('telegram_success_message_id', null);
    } catch (_) {}
    return Number(sent.message_id);
  }

  return null;
}

async function loadOwnedGrant(db, cleanupRef, userId) {
  try {
    const query = await db
      .from('admin_command_login_grants')
      .select('id,user_id,state,grant_purpose,telegram_code_chat_id,telegram_code_message_id,telegram_success_message_id')
      .eq('id', cleanupRef)
      .eq('user_id', userId)
      .eq('grant_purpose', 'maintenance_code')
      .maybeSingle();
    if (query.error || !query.data) return null;
    return query.data;
  } catch (_) {
    return null;
  }
}

function requireOwnedAdmin(req, res) {
  if (!isSameOrigin(req)) {
    res.status(403).json({ success: false, state: 'rejected' });
    return null;
  }
  const auth = requireAdminSession(req);
  if (!auth.ok || String(auth.session && auth.session.un || '').toLowerCase() !== 'budi') {
    res.status(auth.status || 401).json({ success: false, state: 'unauthorized' });
    return null;
  }
  return auth;
}

async function consume(req, res, db) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!isSameOrigin(req)) return res.status(403).json({ success: false, state: 'rejected' });

  const maintenance = await readMaintenanceState(db);
  if (!maintenance.available) {
    return res.status(503).json({ success: false, state: 'unavailable', error: 'Status maintenance belum dapat diverifikasi.' });
  }
  if (!maintenance.enabled) {
    return res.status(409).json({ success: false, state: 'not_maintenance', error: 'Akses kode admin hanya tersedia saat maintenance aktif.' });
  }

  const code = String(req.body && req.body.code || '').trim();
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ success: false, state: 'invalid_code', error: 'Masukkan 6 digit kode dari Telegram.' });
  }

  const tokenHash = maintenanceCode.hashCode(code);
  if (!tokenHash) {
    return res.status(503).json({ success: false, state: 'unavailable', error: 'Login administrator sementara belum tersedia.' });
  }

  let result;
  try {
    result = await db.rpc('consume_admin_maintenance_code', { p_token_hash: tokenHash });
  } catch (_) {
    return res.status(503).json({ success: false, state: 'unavailable', error: 'Login administrator sementara belum tersedia.' });
  }
  if (result.error) {
    return res.status(503).json({ success: false, state: 'unavailable', error: 'Login administrator sementara belum tersedia.' });
  }

  const row = firstRow(result.data) || {};
  const state = String(row.result_code || 'not_found');

  if (state !== 'ok') {
    if (state === 'invalid_code') {
      return res.status(401).json({
        success: false,
        state,
        attemptsRemaining: Number(row.attempts_remaining || 0),
        error: 'Kode tidak sesuai.'
      });
    }
    if (state === 'locked') {
      return res.status(429).json({
        success: false,
        state,
        attemptsRemaining: 0,
        error: 'Kode dinonaktifkan setelah terlalu banyak percobaan. Kirim /akses lagi.'
      });
    }
    if (state === 'expired') {
      return res.status(410).json({ success: false, state, error: 'Kode sudah kedaluwarsa. Kirim /akses lagi.' });
    }
    return res.status(401).json({ success: false, state: 'not_found', error: 'Tidak ada kode admin aktif. Kirim /akses di Telegram.' });
  }

  if (!row.user_id || String(row.username || '').toLowerCase() !== 'budi') {
    return res.status(401).json({ success: false, state: 'rejected', error: 'Akses administrator ditolak.' });
  }

  const session = createSessionToken({ userId: row.user_id, username: row.username, isAdmin: true });
  if (!session) {
    return res.status(503).json({ success: false, state: 'unavailable', error: 'Sesi administrator belum dapat dibuat.' });
  }

  try {
    res.setHeader('Set-Cookie', buildSessionCookie(session));
  } catch (_) {
    return res.status(503).json({ success: false, state: 'unavailable', error: 'Sesi administrator belum dapat dibuat.' });
  }

  // Do not wait for Telegram network I/O on the browser's login critical path.
  // The newly authenticated browser immediately calls the separate idempotent
  // notify action using the signed session cookie, then cleans the chat later.
  return res.status(200).json({
    success: true,
    state: 'approved',
    username: 'budi',
    userId: String(row.user_id),
    isAdmin: true,
    cleanupRef: row.grant_id || null
  });
}

async function notify(req, res, db) {
  res.setHeader('Cache-Control', 'private, no-store');
  const auth = requireOwnedAdmin(req, res);
  if (!auth) return;

  const cleanupRef = String(req.body && req.body.cleanupRef || '').trim();
  if (!CLEANUP_REF_RE.test(cleanupRef)) {
    return res.status(400).json({ success: false, state: 'invalid_ref' });
  }

  const row = await loadOwnedGrant(db, cleanupRef, auth.session.uid);
  if (!row) return res.status(200).json({ success: true, state: 'nothing_to_notify' });
  if (row.state !== 'consumed') {
    return res.status(409).json({ success: false, state: 'not_consumed' });
  }
  if (Number.isSafeInteger(Number(row.telegram_success_message_id))) {
    return res.status(200).json({ success: true, state: 'already_notified' });
  }

  await notifySuccessfulLogin(db, row, req.headers && req.headers['user-agent']);
  return res.status(200).json({ success: true, state: 'notified' });
}

async function cleanup(req, res, db) {
  res.setHeader('Cache-Control', 'private, no-store');
  const auth = requireOwnedAdmin(req, res);
  if (!auth) return;

  const cleanupRef = String(req.body && req.body.cleanupRef || '').trim();
  if (!CLEANUP_REF_RE.test(cleanupRef)) {
    return res.status(400).json({ success: false, state: 'invalid_ref' });
  }

  const row = await loadOwnedGrant(db, cleanupRef, auth.session.uid);
  if (!row) return res.status(200).json({ success: true, state: 'nothing_to_clean' });

  const bot = createVerifyBot();
  const chatId = Number(row.telegram_code_chat_id);
  if (Number.isSafeInteger(chatId)) {
    await deleteMessageSafely(bot, chatId, row.telegram_code_message_id);
    await deleteMessageSafely(bot, chatId, row.telegram_success_message_id);
  }

  try {
    await db
      .from('admin_command_login_grants')
      .update({ telegram_messages_cleaned_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', cleanupRef)
      .eq('user_id', auth.session.uid);
  } catch (_) {}

  return res.status(200).json({ success: true, state: 'cleaned' });
}

module.exports = async function handleAdminMaintenanceCodeBrowser(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, state: 'method_not_allowed' });
  const action = String(req.body && req.body.action || '').trim();
  if (![
    'admin-maintenance-code-status',
    'admin-maintenance-code-consume',
    'admin-maintenance-code-notify',
    'admin-maintenance-code-cleanup'
  ].includes(action)) {
    return res.status(400).json({ success: false, state: 'invalid_action' });
  }

  const db = getDb();
  if (!db) return res.status(503).json({ success: false, featureAvailable: false, state: 'unavailable' });

  if (action === 'admin-maintenance-code-status') return status(req, res, db);
  if (action === 'admin-maintenance-code-consume') return consume(req, res, db);
  if (action === 'admin-maintenance-code-notify') return notify(req, res, db);
  return cleanup(req, res, db);
};

module.exports.__test = {
  CLEANUP_REF_RE,
  firstRow,
  formatWibTimestamp,
  coarseDeviceLabel,
  featureStatus,
  deleteMessageSafely,
  notifySuccessfulLogin,
  loadOwnedGrant,
  requireOwnedAdmin,
  status,
  consume,
  notify,
  cleanup,
  readMaintenanceState
};
