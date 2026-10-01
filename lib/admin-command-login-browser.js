'use strict';

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const {
  createSessionToken,
  buildSessionCookie,
  isSameOrigin,
  parseCookies,
  isProduction
} = require('./admin-session');
const commandLogin = require('./admin-command-login');

const DEVICE_COOKIE_NAME = 'ac_admin_dev';
const DEVICE_COOKIE_MAX_AGE_SECONDS = 180 * 24 * 60 * 60; // 180 days; useless without a fresh Telegram grant.

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

function randomDeviceSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashDeviceSecret(value) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 100) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function isMobileUserAgent(value) {
  return /Mobi|Android|iPhone|iPad|iPod/i.test(String(value || ''));
}

function deviceCookieFlags() {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (isProduction()) flags.push('Secure');
  return flags;
}

function buildDeviceCookie(value) {
  return DEVICE_COOKIE_NAME + '=' + value + '; ' + deviceCookieFlags().join('; ') + '; Max-Age=' + DEVICE_COOKIE_MAX_AGE_SECONDS;
}

function setCookies(res, values) {
  try { res.setHeader('Set-Cookie', values); } catch (_) {}
}

function coarseDeviceLabel(userAgent) {
  const ua = String(userAgent || '');
  let platform = 'Laptop utama';
  if (/Windows/i.test(ua)) platform = 'Windows';
  else if (/Macintosh|Mac OS/i.test(ua)) platform = 'Mac';
  else if (/Linux/i.test(ua) && !/Android/i.test(ua)) platform = 'Linux';
  let browser = '';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/Chrome\//i.test(ua)) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua)) browser = 'Safari';
  return (browser ? platform + ' · ' + browser : platform).slice(0, 80);
}

function redirectHome(res, ok) {
  res.statusCode = 302;
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Location', ok ? '/' : '/?admin-login=expired');
  res.end();
}

async function consumeLink(req, res, db) {
  const rawToken = String(req.query && req.query.token || '').trim();
  const tokenHash = commandLogin.hashToken(rawToken);
  if (!tokenHash) return redirectHome(res, false);

  // A direct HP grant ignores the candidate device hash. A pair grant opened
  // from a mobile UA gets NULL, so Postgres returns device_required WITHOUT
  // consuming the token; the same short-lived link can still be opened on the
  // intended laptop.
  const userAgent = req.headers && req.headers['user-agent'];
  const mobile = isMobileUserAgent(userAgent);
  const deviceSecret = randomDeviceSecret();
  const deviceHash = hashDeviceSecret(deviceSecret);
  const result = await db.rpc('consume_admin_command_login_token', {
    p_token_hash: tokenHash,
    p_new_device_hash: mobile ? null : deviceHash,
    p_device_label: coarseDeviceLabel(userAgent)
  });
  if (result.error) return redirectHome(res, false);

  const row = firstRow(result.data);
  if (!row || row.result_code !== 'ok' || !row.user_id || String(row.username || '').toLowerCase() !== 'budi') {
    return redirectHome(res, false);
  }

  const session = createSessionToken({ userId: row.user_id, username: row.username, isAdmin: true });
  if (!session) return redirectHome(res, false);

  const cookies = [buildSessionCookie(session)];
  if (row.target === 'pair') cookies.push(buildDeviceCookie(deviceSecret));
  setCookies(res, cookies);
  return redirectHome(res, true);
}

async function pollDevice(req, res, db) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!isSameOrigin(req)) return res.status(403).json({ success: false, state: 'rejected' });

  const cookies = parseCookies(req);
  const deviceHash = hashDeviceSecret(cookies[DEVICE_COOKIE_NAME]);
  if (!deviceHash) return res.status(200).json({ success: false, state: 'unpaired' });

  const result = await db.rpc('consume_admin_command_device_grant', {
    p_device_hash: deviceHash
  });
  if (result.error) return res.status(200).json({ success: false, state: 'pending' });

  const row = firstRow(result.data);
  const code = row && row.result_code;
  if (code !== 'ok') {
    return res.status(200).json({ success: false, state: code === 'unpaired' ? 'unpaired' : 'pending' });
  }

  if (!row.user_id || String(row.username || '').toLowerCase() !== 'budi') {
    return res.status(200).json({ success: false, state: 'pending' });
  }

  const session = createSessionToken({ userId: row.user_id, username: row.username, isAdmin: true });
  if (!session) return res.status(200).json({ success: false, state: 'pending' });

  setCookies(res, [buildSessionCookie(session)]);
  return res.status(200).json({ success: true, state: 'approved' });
}

module.exports = async function handleAdminCommandBrowser(req, res) {
  const db = getDb();
  if (!db) {
    if (req.method === 'GET') return redirectHome(res, false);
    return res.status(503).json({ success: false, state: 'unavailable' });
  }

  try {
    if (req.method === 'GET') return await consumeLink(req, res, db);
    if (req.method === 'POST') {
      const action = String(req.body && req.body.action || '').trim();
      if (action === 'admin-command-device-poll') return await pollDevice(req, res, db);
      return res.status(400).json({ success: false, state: 'invalid_action' });
    }
    return res.status(405).json({ success: false, state: 'method_not_allowed' });
  } catch (_) {
    if (req.method === 'GET') return redirectHome(res, false);
    return res.status(200).json({ success: false, state: 'pending' });
  }
};

module.exports.__test = {
  DEVICE_COOKIE_NAME,
  DEVICE_COOKIE_MAX_AGE_SECONDS,
  randomDeviceSecret,
  hashDeviceSecret,
  isMobileUserAgent,
  coarseDeviceLabel,
  buildDeviceCookie,
  consumeLink,
  pollDevice
};
