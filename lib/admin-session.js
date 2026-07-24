'use strict';

// Server-side signed-session helper for admin authorization.
//
// Uses ONLY Node's built-in `crypto` (no dependency). Sessions are stateless,
// HMAC-SHA256 signed tokens delivered via an HttpOnly cookie. The token is
// versioned so the format can be rotated later.
//
// SECURITY NOTES:
// - The signing key comes exclusively from process.env.SESSION_SECRET and is
//   never exposed to the client or logged.
// - Missing SESSION_SECRET => no session can be created or verified (fail-closed):
//   admin endpoints will reject with 401. There is NO insecure fallback secret.
// - This module never logs the cookie, token, signature, password, device id,
//   or the secret.

const crypto = require('crypto');

const SESSION_COOKIE_NAME = 'ac_sess';
const TOKEN_VERSION = 'v1';
// ~10 hours (within the required 8-12h window).
const SESSION_MAX_AGE_SECONDS = 10 * 60 * 60;

function isProduction() {
  return process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
}

// Returns the configured secret, or null when unset (fail-closed).
function getSessionSecret() {
  const s = process.env.SESSION_SECRET;
  return (typeof s === 'string' && s.length > 0) ? s : null;
}

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecodeToString(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
}

// Non-reversible representation of a device id (used only as an optional signal).
function hashDeviceId(deviceId) {
  if (!deviceId) return null;
  return crypto.createHash('sha256').update(String(deviceId)).digest('hex').slice(0, 32);
}

function sign(signingInput, secret) {
  return b64urlEncode(crypto.createHmac('sha256', secret).update(signingInput).digest());
}

// Create a signed session token. Returns null when no secret is configured
// (caller must treat this as "no session issued" — fail-closed).
function createSessionToken(input, opts) {
  const secret = getSessionSecret();
  if (!secret) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  const maxAge = (opts && opts.maxAgeSeconds) || SESSION_MAX_AGE_SECONDS;
  const payload = {
    uid: String(input.userId),
    un: String(input.username || '').toLowerCase(),
    adm: input.isAdmin === true,
    iat: nowSec,
    exp: nowSec + maxAge
  };
  const dvh = hashDeviceId(input.deviceId);
  if (dvh) payload.dvh = dvh;

  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const signingInput = TOKEN_VERSION + '.' + payloadB64;
  const sig = sign(signingInput, secret);
  return TOKEN_VERSION + '.' + payloadB64 + '.' + sig;
}

// Verify a token. Returns { valid:true, payload } or { valid:false, reason }.
// Reasons are coarse and safe to log server-side; the token itself is never logged.
function verifySessionToken(token) {
  const secret = getSessionSecret();
  if (!secret) return { valid: false, reason: 'no_secret' };
  if (!token || typeof token !== 'string') return { valid: false, reason: 'missing' };

  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'malformed' };
  const [version, payloadB64, sig] = parts;
  if (version !== TOKEN_VERSION) return { valid: false, reason: 'bad_version' };

  const expectedSig = sign(version + '.' + payloadB64, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  // timingSafeEqual requires equal lengths; unequal length => tampered.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { valid: false, reason: 'bad_signature' };
  }

  let payload;
  try {
    payload = JSON.parse(b64urlDecodeToString(payloadB64));
  } catch (e) {
    return { valid: false, reason: 'bad_payload' };
  }

  if (!payload || typeof payload !== 'object') return { valid: false, reason: 'bad_payload' };
  if (typeof payload.uid !== 'string' || payload.uid.length === 0) return { valid: false, reason: 'bad_fields' };
  if (typeof payload.un !== 'string') return { valid: false, reason: 'bad_fields' };
  if (typeof payload.adm !== 'boolean') return { valid: false, reason: 'bad_fields' };
  if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') return { valid: false, reason: 'bad_fields' };

  const nowSec = Math.floor(Date.now() / 1000);
  // A token may never outlive the server's normal session window. This also
  // rejects structurally valid, signed-but-malformed payloads if the format is
  // ever used by another issuer incorrectly.
  if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) ||
      payload.iat > nowSec + 60 ||
      payload.exp - payload.iat > SESSION_MAX_AGE_SECONDS) {
    return { valid: false, reason: 'bad_times' };
  }
  if (payload.exp <= nowSec) return { valid: false, reason: 'expired' };
  if (payload.exp <= payload.iat) return { valid: false, reason: 'bad_times' };

  return { valid: true, payload };
}

// Parse the Cookie header into a plain object. Never logs the header.
function parseCookies(req) {
  const header = req && req.headers && req.headers.cookie;
  const out = {};
  if (!header || typeof header !== 'string') return out;
  header.split(';').forEach(function (pair) {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = v;
  });
  return out;
}

function getSession(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE_NAME];
  const result = verifySessionToken(token);
  return result.valid ? result.payload : null;
}

// Require any authenticated session. Returns { ok, session } or { ok:false, status, error }.
function requireAuthenticatedSession(req) {
  const session = getSession(req);
  if (!session) return { ok: false, status: 401, error: 'Autentikasi diperlukan.' };
  return { ok: true, session };
}

// Require a session whose server-signed admin flag is true.
function requireAdminSession(req) {
  const session = getSession(req);
  if (!session) return { ok: false, status: 401, error: 'Autentikasi diperlukan.' };
  if (session.adm !== true) return { ok: false, status: 403, error: 'Akses admin ditolak.' };
  return { ok: true, session };
}

// Same-origin protection for state-changing requests. Rejects only when an
// Origin/Referer is present AND its host differs from the request Host. When
// neither header is available we do not block (SameSite=Strict still applies).
function isSameOrigin(req) {
  const headers = (req && req.headers) || {};
  const host = headers.host;
  if (!host) return true; // cannot determine; rely on SameSite cookie
  const candidate = headers.origin || headers.referer || headers.referrer;
  if (!candidate) return true; // no cross-origin signal; rely on SameSite cookie
  try {
    const u = new URL(candidate);
    return u.host === host;
  } catch (e) {
    return false; // malformed origin/referer on a state-changing request => reject
  }
}

function cookieFlags() {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (isProduction()) flags.push('Secure');
  return flags;
}

// Build the Set-Cookie value carrying the session token.
function buildSessionCookie(token, opts) {
  const maxAge = (opts && opts.maxAgeSeconds) || SESSION_MAX_AGE_SECONDS;
  return SESSION_COOKIE_NAME + '=' + token + '; ' + cookieFlags().join('; ') + '; Max-Age=' + maxAge;
}

// Build the Set-Cookie value that clears the session (Max-Age=0).
function buildClearCookie() {
  return SESSION_COOKIE_NAME + '=; ' + cookieFlags().join('; ') + '; Max-Age=0';
}

module.exports = {
  SESSION_COOKIE_NAME,
  TOKEN_VERSION,
  SESSION_MAX_AGE_SECONDS,
  isProduction,
  getSessionSecret,
  hashDeviceId,
  createSessionToken,
  verifySessionToken,
  parseCookies,
  getSession,
  requireAuthenticatedSession,
  requireAdminSession,
  isSameOrigin,
  buildSessionCookie,
  buildClearCookie
};
