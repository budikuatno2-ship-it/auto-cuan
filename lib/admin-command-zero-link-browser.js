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

const DEVICE_COOKIE_NAME = 'ac_admin_dev';
const PAIR_COOKIE_NAME = 'ac_admin_pair';
const DEVICE_COOKIE_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;
const PAIR_COOKIE_MAX_AGE_SECONDS = 180;
const PAIR_TTL_MS = 2 * 60 * 1000;
const SECRET_RE = /^[A-Za-z0-9_-]{32,100}$/;

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

function randomSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function randomRequestRef() {
  return crypto.randomBytes(18).toString('base64url');
}

function randomDisplayTag() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function hashSecret(value) {
  if (typeof value !== 'string' || !SECRET_RE.test(value)) return null;
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashIp(value) {
  if (typeof value !== 'string' || !value) return null;
  return crypto.createHash('sha256').update('admin-zero-link-pair-ip:' + value, 'utf8').digest('hex');
}

function trustedRequestIp(req) {
  const value = req && req.headers && req.headers['x-vercel-forwarded-for'];
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.split(',')[0].trim().slice(0, 80) || null;
}

function isMobileUserAgent(value) {
  return /Mobi|Android|iPhone|iPad|iPod/i.test(String(value || ''));
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

function cookieFlags() {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (isProduction()) flags.push('Secure');
  return flags;
}

function buildCookie(name, value, maxAge) {
  return name + '=' + value + '; ' + cookieFlags().join('; ') + '; Max-Age=' + maxAge;
}

function clearCookie(name) {
  return name + '=; ' + cookieFlags().join('; ') + '; Max-Age=0';
}

function setCookies(res, values) {
  try { res.setHeader('Set-Cookie', values); } catch (_) {}
}

async function existingDeviceState(db, deviceHash) {
  if (!deviceHash) return { known: false, error: false };
  const result = await db
    .from('app_user_telegram_verifications')
    .select('user_id, telegram_user_id, telegram_verified_at, admin_device_hash')
    .eq('admin_device_hash', deviceHash)
    .not('telegram_verified_at', 'is', null)
    .maybeSingle();
  if (result.error) return { known: false, error: true };
  return { known: !!result.data, error: false };
}

async function pollPairing(req, res, db) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!isSameOrigin(req)) return res.status(403).json({ success: false, state: 'rejected' });

  const pagePath = String(req.body && req.body.pagePath || '');
  if (pagePath !== '/dashboard' && pagePath !== '/dashboard/') {
    return res.status(200).json({ success: false, state: 'idle' });
  }

  const userAgent = String(req.headers && req.headers['user-agent'] || '');
  if (isMobileUserAgent(userAgent)) {
    return res.status(200).json({ success: false, state: 'desktop_required' });
  }

  const cookies = parseCookies(req);
  const currentDeviceHash = hashSecret(cookies[DEVICE_COOKIE_NAME]);
  const deviceState = await existingDeviceState(db, currentDeviceHash);
  if (deviceState.error) return res.status(200).json({ success: false, state: 'pending' });
  if (deviceState.known) return res.status(200).json({ success: false, state: 'already_paired' });

  const responseCookies = [];
  if (cookies[DEVICE_COOKIE_NAME] && !deviceState.known) {
    responseCookies.push(clearCookie(DEVICE_COOKIE_NAME));
  }

  let pairSecret = String(cookies[PAIR_COOKIE_NAME] || '');
  if (!hashSecret(pairSecret)) pairSecret = randomSecret();
  const pairHash = hashSecret(pairSecret);

  const deviceSecret = randomSecret();
  const newDeviceHash = hashSecret(deviceSecret);
  const requestRef = randomRequestRef();
  const displayTag = randomDisplayTag();
  const expiresAt = new Date(Date.now() + PAIR_TTL_MS).toISOString();

  const result = await db.rpc('poll_admin_command_pair_request', {
    p_pair_hash: pairHash,
    p_request_ref: requestRef,
    p_display_tag: displayTag,
    p_device_label: coarseDeviceLabel(userAgent),
    p_requester_ip_hash: hashIp(trustedRequestIp(req)),
    p_new_device_hash: newDeviceHash,
    p_expires_at: expiresAt
  });

  if (result.error) return res.status(200).json({ success: false, state: 'pending' });
  const row = firstRow(result.data);
  const code = row && row.result_code;

  if (code === 'ok' && row.user_id && String(row.username || '').toLowerCase() === 'budi') {
    const session = createSessionToken({ userId: row.user_id, username: row.username, isAdmin: true });
    if (!session) return res.status(200).json({ success: false, state: 'pending' });

    responseCookies.push(buildSessionCookie(session));
    responseCookies.push(buildCookie(DEVICE_COOKIE_NAME, deviceSecret, DEVICE_COOKIE_MAX_AGE_SECONDS));
    responseCookies.push(clearCookie(PAIR_COOKIE_NAME));
    setCookies(res, responseCookies);
    return res.status(200).json({ success: true, state: 'approved' });
  }

  if (code === 'pending') {
    responseCookies.push(buildCookie(PAIR_COOKIE_NAME, pairSecret, PAIR_COOKIE_MAX_AGE_SECONDS));
    setCookies(res, responseCookies);
    return res.status(200).json({
      success: false,
      state: 'pair_pending',
      displayTag: String(row.display_tag || '').slice(0, 6),
      deviceLabel: coarseDeviceLabel(userAgent)
    });
  }

  if (responseCookies.length) setCookies(res, responseCookies);
  return res.status(200).json({ success: false, state: code === 'rate_limited' ? 'rate_limited' : 'pending' });
}

module.exports = async function handleZeroLinkPairing(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, state: 'method_not_allowed' });
  const action = String(req.body && req.body.action || '').trim();
  if (action !== 'admin-command-pair-poll') return res.status(400).json({ success: false, state: 'invalid_action' });

  const db = getDb();
  if (!db) return res.status(503).json({ success: false, state: 'unavailable' });

  try {
    return await pollPairing(req, res, db);
  } catch (_) {
    return res.status(200).json({ success: false, state: 'pending' });
  }
};

module.exports.__test = {
  DEVICE_COOKIE_NAME,
  PAIR_COOKIE_NAME,
  DEVICE_COOKIE_MAX_AGE_SECONDS,
  PAIR_COOKIE_MAX_AGE_SECONDS,
  PAIR_TTL_MS,
  randomSecret,
  randomRequestRef,
  randomDisplayTag,
  hashSecret,
  hashIp,
  trustedRequestIp,
  isMobileUserAgent,
  coarseDeviceLabel,
  buildCookie,
  clearCookie,
  pollPairing
};
