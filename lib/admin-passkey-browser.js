'use strict';

// Admin laptop identity backed by a discoverable WebAuthn credential (Windows
// Hello / platform passkey). The private key never leaves the authenticator.
// This layer is deliberately served through the existing reset-password gateway
// so it does not consume another Vercel Function slot.
//
// Security properties:
// - registration requires a live signed admin session AND an already-paired
//   ac_admin_dev cookie, so an arbitrary admin session cannot silently enroll a
//   new authenticator without first completing the Telegram laptop pairing;
// - authentication is challenge-bound, origin-bound, RP-ID-bound, UP+UV-bound,
//   and verifies the ES256 assertion server-side;
// - challenges live only in a short-lived signed HttpOnly SameSite=Strict cookie;
// - successful passkey login rotates/re-establishes ac_admin_dev, so normal
//   Telegram /akses auto-login keeps working after cookies were cleared once;
// - only public-key material is stored in PostgreSQL.

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const adminSession = require('./admin-session');

const CHALLENGE_COOKIE_NAME = 'ac_admin_pk_chal';
const CHALLENGE_MAX_AGE_SECONDS = 3 * 60;
const DEVICE_COOKIE_NAME = 'ac_admin_dev';
const DEVICE_COOKIE_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;
const MAX_CLIENT_DATA_BYTES = 4096;
const MAX_ATTESTATION_BYTES = 16384;
const MAX_AUTHENTICATOR_DATA_BYTES = 2048;
const MAX_SIGNATURE_BYTES = 1024;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

function getDb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
}

function b64urlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function b64urlDecode(value, maxBytes) {
  if (typeof value !== 'string' || !value || !B64URL_RE.test(value)) return null;
  try {
    const out = Buffer.from(value, 'base64url');
    if (!out.length || (maxBytes && out.length > maxBytes)) return null;
    return out;
  } catch (_) {
    return null;
  }
}

function timingSafeTextEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  try { return crypto.timingSafeEqual(left, right); } catch (_) { return false; }
}

function rpIdForRequest(req) {
  const configured = String(process.env.WEBAUTHN_RP_ID || '').trim().toLowerCase();
  if (configured) return configured;
  if (adminSession.isProduction()) return 'autocuan.web.id';
  const host = String(req && req.headers && req.headers.host || 'localhost').split(':')[0].trim().toLowerCase();
  return host || 'localhost';
}

function originForRequest(req) {
  const configured = String(process.env.WEBAUTHN_ORIGIN || '').trim();
  if (configured) return configured;
  if (adminSession.isProduction()) return 'https://autocuan.web.id';
  const headers = (req && req.headers) || {};
  const proto = String(headers['x-forwarded-proto'] || 'http').split(',')[0].trim() || 'http';
  const host = String(headers.host || 'localhost').trim() || 'localhost';
  return proto + '://' + host;
}

function cookieFlags() {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (adminSession.isProduction()) flags.push('Secure');
  return flags;
}

function challengeSign(input, secret) {
  return b64urlEncode(crypto.createHmac('sha256', secret).update('ac-admin-passkey-v1.' + input).digest());
}

function createChallengeToken(purpose, challenge, userId) {
  const secret = adminSession.getSessionSecret();
  if (!secret) return null;
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    p: String(purpose),
    c: String(challenge),
    uid: userId ? String(userId) : null,
    iat: now,
    exp: now + CHALLENGE_MAX_AGE_SECONDS
  };
  const encoded = b64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const input = 'pk1.' + encoded;
  return input + '.' + challengeSign(input, secret);
}

function verifyChallengeToken(token, purpose) {
  const secret = adminSession.getSessionSecret();
  if (!secret || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'pk1') return null;
  const input = parts[0] + '.' + parts[1];
  const expected = challengeSign(input, secret);
  if (!timingSafeTextEqual(parts[2], expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (!payload || payload.p !== purpose || typeof payload.c !== 'string' || !B64URL_RE.test(payload.c)) return null;
  if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)) return null;
  if (payload.exp <= payload.iat || payload.exp - payload.iat > CHALLENGE_MAX_AGE_SECONDS) return null;
  if (payload.iat > now + 60 || payload.exp <= now) return null;
  return payload;
}

function buildChallengeCookie(token) {
  return CHALLENGE_COOKIE_NAME + '=' + token + '; ' + cookieFlags().join('; ') + '; Max-Age=' + CHALLENGE_MAX_AGE_SECONDS;
}

function clearChallengeCookie() {
  return CHALLENGE_COOKIE_NAME + '=; ' + cookieFlags().join('; ') + '; Max-Age=0';
}

function buildDeviceCookie(secret) {
  return DEVICE_COOKIE_NAME + '=' + secret + '; ' + cookieFlags().join('; ') + '; Max-Age=' + DEVICE_COOKIE_MAX_AGE_SECONDS;
}

function hashDeviceSecret(value) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 100 || !B64URL_RE.test(value)) return null;
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function randomSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function randomChallenge() {
  return crypto.randomBytes(32).toString('base64url');
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

function isMobileUserAgent(value) {
  return /Mobi|Android|iPhone|iPad|iPod/i.test(String(value || ''));
}

function parseCredentialId(credential) {
  if (!credential || credential.type !== 'public-key') return null;
  const raw = b64urlDecode(credential.rawId, 1024);
  if (!raw) return null;
  const canonical = b64urlEncode(raw);
  if (credential.id && !timingSafeTextEqual(String(credential.id), canonical)) return null;
  return canonical;
}

function readCborLength(buffer, offset, additional) {
  if (additional < 24) return { value: additional, offset: offset };
  if (additional === 24) {
    if (offset + 1 > buffer.length) throw new Error('cbor_truncated');
    return { value: buffer.readUInt8(offset), offset: offset + 1 };
  }
  if (additional === 25) {
    if (offset + 2 > buffer.length) throw new Error('cbor_truncated');
    return { value: buffer.readUInt16BE(offset), offset: offset + 2 };
  }
  if (additional === 26) {
    if (offset + 4 > buffer.length) throw new Error('cbor_truncated');
    return { value: buffer.readUInt32BE(offset), offset: offset + 4 };
  }
  if (additional === 27) {
    if (offset + 8 > buffer.length) throw new Error('cbor_truncated');
    const value = buffer.readBigUInt64BE(offset);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('cbor_too_large');
    return { value: Number(value), offset: offset + 8 };
  }
  throw new Error('cbor_indefinite_unsupported');
}

function decodeCborAt(buffer, startOffset, depth) {
  const level = depth || 0;
  if (level > 16) throw new Error('cbor_depth');
  let offset = startOffset || 0;
  if (offset >= buffer.length) throw new Error('cbor_truncated');
  const first = buffer[offset++];
  const major = first >> 5;
  const additional = first & 31;

  if (major === 7) {
    if (additional === 20) return { value: false, offset };
    if (additional === 21) return { value: true, offset };
    if (additional === 22) return { value: null, offset };
    throw new Error('cbor_simple_unsupported');
  }

  const lengthInfo = readCborLength(buffer, offset, additional);
  const length = lengthInfo.value;
  offset = lengthInfo.offset;

  if (major === 0) return { value: length, offset };
  if (major === 1) return { value: -1 - length, offset };
  if (major === 2) {
    if (offset + length > buffer.length) throw new Error('cbor_truncated');
    return { value: buffer.subarray(offset, offset + length), offset: offset + length };
  }
  if (major === 3) {
    if (offset + length > buffer.length) throw new Error('cbor_truncated');
    return { value: buffer.subarray(offset, offset + length).toString('utf8'), offset: offset + length };
  }
  if (major === 4) {
    const arr = [];
    for (let i = 0; i < length; i += 1) {
      const item = decodeCborAt(buffer, offset, level + 1);
      arr.push(item.value);
      offset = item.offset;
    }
    return { value: arr, offset };
  }
  if (major === 5) {
    const map = new Map();
    for (let i = 0; i < length; i += 1) {
      const key = decodeCborAt(buffer, offset, level + 1);
      offset = key.offset;
      const value = decodeCborAt(buffer, offset, level + 1);
      offset = value.offset;
      map.set(key.value, value.value);
    }
    return { value: map, offset };
  }
  if (major === 6) {
    // Ignore the semantic tag itself and decode its single wrapped value.
    return decodeCborAt(buffer, offset, level + 1);
  }
  throw new Error('cbor_major_unsupported');
}

function parseClientData(encoded, expectedType, expectedChallenge, expectedOrigin) {
  const raw = b64urlDecode(encoded, MAX_CLIENT_DATA_BYTES);
  if (!raw) throw new Error('client_data_invalid');
  let data;
  try { data = JSON.parse(raw.toString('utf8')); } catch (_) { throw new Error('client_data_json'); }
  if (!data || data.type !== expectedType) throw new Error('client_data_type');
  if (!timingSafeTextEqual(String(data.challenge || ''), expectedChallenge)) throw new Error('client_data_challenge');
  if (!timingSafeTextEqual(String(data.origin || ''), expectedOrigin)) throw new Error('client_data_origin');
  if (data.crossOrigin === true) throw new Error('client_data_cross_origin');
  return { raw, data };
}

function verifyRpAndFlags(authData, rpId, requireAttestedData) {
  if (!Buffer.isBuffer(authData) || authData.length < 37 || authData.length > MAX_AUTHENTICATOR_DATA_BYTES) {
    throw new Error('auth_data_invalid');
  }
  const expectedRpHash = crypto.createHash('sha256').update(rpId, 'utf8').digest();
  if (!crypto.timingSafeEqual(authData.subarray(0, 32), expectedRpHash)) throw new Error('rp_id_hash');
  const flags = authData[32];
  if ((flags & 0x01) === 0) throw new Error('user_presence_required');
  if ((flags & 0x04) === 0) throw new Error('user_verification_required');
  if (requireAttestedData && (flags & 0x40) === 0) throw new Error('attested_data_required');
  return { flags, signCount: authData.readUInt32BE(33) };
}

function coseEc2ToJwk(cose) {
  if (!(cose instanceof Map)) throw new Error('cose_invalid');
  if (cose.get(1) !== 2 || cose.get(3) !== -7 || cose.get(-1) !== 1) throw new Error('cose_algorithm');
  const x = cose.get(-2);
  const y = cose.get(-3);
  if (!Buffer.isBuffer(x) || x.length !== 32 || !Buffer.isBuffer(y) || y.length !== 32) throw new Error('cose_point');
  return { kty: 'EC', crv: 'P-256', x: b64urlEncode(x), y: b64urlEncode(y) };
}

function verifyRegistrationCredential(credential, challengePayload, req) {
  const credentialId = parseCredentialId(credential);
  if (!credentialId || !credential.response) throw new Error('credential_invalid');
  parseClientData(
    credential.response.clientDataJSON,
    'webauthn.create',
    challengePayload.c,
    originForRequest(req)
  );

  const attestation = b64urlDecode(credential.response.attestationObject, MAX_ATTESTATION_BYTES);
  if (!attestation) throw new Error('attestation_invalid');
  const decoded = decodeCborAt(attestation, 0, 0);
  if (!(decoded.value instanceof Map) || decoded.offset !== attestation.length) throw new Error('attestation_cbor');
  const fmt = decoded.value.get('fmt');
  const authData = decoded.value.get('authData');
  if (fmt !== 'none' || !Buffer.isBuffer(authData)) throw new Error('attestation_format');

  const rpId = rpIdForRequest(req);
  const meta = verifyRpAndFlags(authData, rpId, true);
  let offset = 37;
  if (offset + 18 > authData.length) throw new Error('attested_data_truncated');
  offset += 16; // AAGUID
  const credentialIdLength = authData.readUInt16BE(offset);
  offset += 2;
  if (credentialIdLength < 16 || credentialIdLength > 1024 || offset + credentialIdLength > authData.length) {
    throw new Error('attested_credential_id');
  }
  const authCredentialId = b64urlEncode(authData.subarray(offset, offset + credentialIdLength));
  if (!timingSafeTextEqual(authCredentialId, credentialId)) throw new Error('credential_id_mismatch');
  offset += credentialIdLength;
  const cose = decodeCborAt(authData, offset, 0);
  const publicKeyJwk = coseEc2ToJwk(cose.value);

  let publicKey;
  try { publicKey = crypto.createPublicKey({ key: publicKeyJwk, format: 'jwk' }); } catch (_) { throw new Error('public_key_invalid'); }
  if (!publicKey || publicKey.asymmetricKeyType !== 'ec') throw new Error('public_key_invalid');

  const transports = Array.isArray(credential.response.transports)
    ? credential.response.transports.map(function (v) { return String(v).slice(0, 32); }).filter(Boolean).slice(0, 8)
    : [];

  return {
    credentialId,
    publicKeyJwk,
    signCount: meta.signCount,
    transports
  };
}

function verifyAssertionCredential(credential, storedJwk, storedSignCount, challengePayload, req) {
  const credentialId = parseCredentialId(credential);
  if (!credentialId || !credential.response) throw new Error('credential_invalid');
  const clientData = parseClientData(
    credential.response.clientDataJSON,
    'webauthn.get',
    challengePayload.c,
    originForRequest(req)
  );
  const authData = b64urlDecode(credential.response.authenticatorData, MAX_AUTHENTICATOR_DATA_BYTES);
  const signature = b64urlDecode(credential.response.signature, MAX_SIGNATURE_BYTES);
  if (!authData || !signature) throw new Error('assertion_invalid');
  const meta = verifyRpAndFlags(authData, rpIdForRequest(req), false);

  const signedData = Buffer.concat([
    authData,
    crypto.createHash('sha256').update(clientData.raw).digest()
  ]);
  let publicKey;
  try { publicKey = crypto.createPublicKey({ key: storedJwk, format: 'jwk' }); } catch (_) { throw new Error('stored_key_invalid'); }
  let valid = false;
  try { valid = crypto.verify('sha256', signedData, publicKey, signature); } catch (_) { valid = false; }
  if (!valid) throw new Error('assertion_signature');

  const oldCount = Number(storedSignCount || 0);
  const newCount = Number(meta.signCount || 0);
  if (oldCount > 0 && newCount > 0 && newCount <= oldCount) throw new Error('sign_count_replay');
  return { credentialId, signCount: newCount };
}

async function eligibleAdminAccount(db, userId) {
  const result = await db
    .from('app_users')
    .select('id, username, is_blocked, is_approved')
    .eq('id', String(userId || ''))
    .maybeSingle();
  if (result.error || !result.data) return null;
  const row = result.data;
  if (String(row.username || '').toLowerCase() !== 'budi' || row.is_blocked === true || row.is_approved !== true) return null;
  return row;
}

async function verifiedTelegramRow(db, userId) {
  const result = await db
    .from('app_user_telegram_verifications')
    .select('user_id, telegram_user_id, telegram_verified_at, admin_device_hash, admin_device_label')
    .eq('user_id', String(userId || ''))
    .not('telegram_verified_at', 'is', null)
    .maybeSingle();
  if (result.error) return null;
  return result.data || null;
}

async function pairedAdminDevice(db, req, userId) {
  const cookies = adminSession.parseCookies(req);
  const deviceHash = hashDeviceSecret(cookies[DEVICE_COOKIE_NAME]);
  if (!deviceHash) return null;
  const result = await db
    .from('app_user_telegram_verifications')
    .select('user_id, telegram_verified_at, admin_device_hash, admin_device_label')
    .eq('user_id', String(userId || ''))
    .eq('admin_device_hash', deviceHash)
    .not('telegram_verified_at', 'is', null)
    .maybeSingle();
  if (result.error) return null;
  return result.data || null;
}

function requireAdmin(req) {
  const auth = adminSession.requireAdminSession(req);
  if (!auth.ok || String(auth.session && auth.session.un || '').toLowerCase() !== 'budi') return null;
  return auth.session;
}

function setCookies(res, cookies) {
  try { res.setHeader('Set-Cookie', cookies); } catch (_) {}
}

async function status(req, res, db) {
  const session = requireAdmin(req);
  if (!session) return res.status(401).json({ success: false, state: 'unauthorized' });
  const account = await eligibleAdminAccount(db, session.uid);
  if (!account) return res.status(403).json({ success: false, state: 'not_eligible' });
  const result = await db
    .from('admin_webauthn_credentials')
    .select('credential_id, device_label, created_at, last_used_at')
    .eq('user_id', account.id)
    .is('revoked_at', null);
  if (result.error) return res.status(503).json({ success: false, state: 'unavailable' });
  const credentials = Array.isArray(result.data) ? result.data : [];
  return res.status(200).json({
    success: true,
    hasCredential: credentials.length > 0,
    credentialCount: credentials.length,
    credentials: credentials.map(function (row) {
      return {
        deviceLabel: String(row.device_label || 'Windows Hello').slice(0, 80),
        createdAt: row.created_at || null,
        lastUsedAt: row.last_used_at || null
      };
    })
  });
}

async function registerOptions(req, res, db) {
  const session = requireAdmin(req);
  if (!session) return res.status(401).json({ success: false, state: 'unauthorized' });
  const account = await eligibleAdminAccount(db, session.uid);
  if (!account) return res.status(403).json({ success: false, state: 'not_eligible' });
  const paired = await pairedAdminDevice(db, req, account.id);
  if (!paired) {
    return res.status(403).json({
      success: false,
      state: 'device_pair_required',
      error: 'Hubungkan laptop lewat /akses Telegram terlebih dahulu.'
    });
  }

  const existing = await db
    .from('admin_webauthn_credentials')
    .select('credential_id, transports')
    .eq('user_id', account.id)
    .is('revoked_at', null);
  if (existing.error) return res.status(503).json({ success: false, state: 'unavailable' });

  const challenge = randomChallenge();
  const token = createChallengeToken('register', challenge, account.id);
  if (!token) return res.status(503).json({ success: false, state: 'unavailable' });
  setCookies(res, [buildChallengeCookie(token)]);

  const userId = b64urlEncode(crypto.createHash('sha256').update('autocuan-passkey-user:' + account.id).digest());
  return res.status(200).json({
    success: true,
    publicKey: {
      challenge,
      rp: { id: rpIdForRequest(req), name: 'Auto-Cuan' },
      user: { id: userId, name: 'budi', displayName: 'Auto-Cuan Administrator' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      timeout: 60000,
      attestation: 'none',
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'required'
      },
      excludeCredentials: (existing.data || []).map(function (row) {
        return {
          type: 'public-key',
          id: row.credential_id,
          transports: Array.isArray(row.transports) ? row.transports : undefined
        };
      })
    }
  });
}

async function registerFinish(req, res, db) {
  const session = requireAdmin(req);
  if (!session) return res.status(401).json({ success: false, state: 'unauthorized' });
  const account = await eligibleAdminAccount(db, session.uid);
  if (!account) return res.status(403).json({ success: false, state: 'not_eligible' });
  const paired = await pairedAdminDevice(db, req, account.id);
  if (!paired) return res.status(403).json({ success: false, state: 'device_pair_required' });

  const token = adminSession.parseCookies(req)[CHALLENGE_COOKIE_NAME];
  const challenge = verifyChallengeToken(token, 'register');
  setCookies(res, [clearChallengeCookie()]);
  if (!challenge || String(challenge.uid || '') !== String(account.id)) {
    return res.status(400).json({ success: false, state: 'challenge_invalid' });
  }

  let verified;
  try {
    verified = verifyRegistrationCredential(req.body && req.body.credential, challenge, req);
  } catch (_) {
    return res.status(400).json({ success: false, state: 'credential_invalid', error: 'Windows Hello tidak dapat diverifikasi.' });
  }

  const insert = await db
    .from('admin_webauthn_credentials')
    .insert({
      user_id: account.id,
      credential_id: verified.credentialId,
      public_key_jwk: verified.publicKeyJwk,
      sign_count: verified.signCount,
      transports: verified.transports,
      device_label: coarseDeviceLabel(req.headers && req.headers['user-agent'])
    });
  if (insert.error) {
    const duplicate = String(insert.error.code || '') === '23505';
    return res.status(duplicate ? 409 : 503).json({
      success: false,
      state: duplicate ? 'already_registered' : 'unavailable',
      error: duplicate ? 'Windows Hello ini sudah terdaftar.' : 'Penyimpanan Windows Hello sementara gagal.'
    });
  }

  return res.status(200).json({ success: true, state: 'registered' });
}

async function loginOptions(req, res, db) {
  if (isMobileUserAgent(req.headers && req.headers['user-agent'])) {
    return res.status(400).json({ success: false, state: 'desktop_required' });
  }
  const existing = await db
    .from('admin_webauthn_credentials')
    .select('credential_id')
    .is('revoked_at', null)
    .limit(1);
  if (existing.error) return res.status(503).json({ success: false, state: 'unavailable' });
  if (!Array.isArray(existing.data) || existing.data.length === 0) {
    return res.status(404).json({
      success: false,
      state: 'not_enrolled',
      error: 'Windows Hello belum diaktifkan untuk Auto-Cuan.'
    });
  }

  const challenge = randomChallenge();
  const token = createChallengeToken('login', challenge, null);
  if (!token) return res.status(503).json({ success: false, state: 'unavailable' });
  setCookies(res, [buildChallengeCookie(token)]);
  return res.status(200).json({
    success: true,
    publicKey: {
      challenge,
      rpId: rpIdForRequest(req),
      timeout: 60000,
      userVerification: 'required'
      // allowCredentials intentionally omitted: the platform authenticator must
      // discover the resident Auto-Cuan credential even after browser data was cleared.
    }
  });
}

async function loginFinish(req, res, db) {
  const token = adminSession.parseCookies(req)[CHALLENGE_COOKIE_NAME];
  const challenge = verifyChallengeToken(token, 'login');
  setCookies(res, [clearChallengeCookie()]);
  if (!challenge) return res.status(400).json({ success: false, state: 'challenge_invalid' });

  const credential = req.body && req.body.credential;
  const credentialId = parseCredentialId(credential);
  if (!credentialId) return res.status(400).json({ success: false, state: 'credential_invalid' });

  const lookup = await db
    .from('admin_webauthn_credentials')
    .select('id, user_id, credential_id, public_key_jwk, sign_count, revoked_at')
    .eq('credential_id', credentialId)
    .is('revoked_at', null)
    .maybeSingle();
  if (lookup.error || !lookup.data) return res.status(401).json({ success: false, state: 'credential_unknown' });
  const stored = lookup.data;
  const account = await eligibleAdminAccount(db, stored.user_id);
  if (!account) return res.status(403).json({ success: false, state: 'not_eligible' });
  const telegram = await verifiedTelegramRow(db, account.id);
  if (!telegram) return res.status(403).json({ success: false, state: 'telegram_verification_required' });

  let assertion;
  try {
    assertion = verifyAssertionCredential(credential, stored.public_key_jwk, stored.sign_count, challenge, req);
  } catch (_) {
    return res.status(401).json({ success: false, state: 'assertion_invalid', error: 'Windows Hello tidak dapat diverifikasi.' });
  }

  const deviceSecret = randomSecret();
  const deviceHash = hashDeviceSecret(deviceSecret);
  const deviceLabel = coarseDeviceLabel(req.headers && req.headers['user-agent']);
  const rebound = await db
    .from('app_user_telegram_verifications')
    .update({
      admin_device_hash: deviceHash,
      admin_device_label: deviceLabel,
      admin_device_bound_at: new Date().toISOString()
    })
    .eq('user_id', account.id)
    .not('telegram_verified_at', 'is', null);
  if (rebound.error) return res.status(503).json({ success: false, state: 'device_rebind_failed' });

  try {
    await db
      .from('admin_webauthn_credentials')
      .update({ sign_count: assertion.signCount, last_used_at: new Date().toISOString() })
      .eq('id', stored.id);
  } catch (_) {}

  const session = adminSession.createSessionToken({ userId: account.id, username: 'budi', isAdmin: true });
  if (!session) return res.status(503).json({ success: false, state: 'session_unavailable' });
  setCookies(res, [
    adminSession.buildSessionCookie(session),
    buildDeviceCookie(deviceSecret),
    clearChallengeCookie()
  ]);
  return res.status(200).json({ success: true, state: 'approved', username: 'budi', userId: account.id, isAdmin: true });
}

module.exports = async function handleAdminPasskey(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') return res.status(405).json({ success: false, state: 'method_not_allowed' });
  if (!adminSession.isSameOrigin(req)) return res.status(403).json({ success: false, state: 'rejected' });

  const db = getDb();
  if (!db) return res.status(503).json({ success: false, state: 'unavailable' });
  const action = String(req.body && req.body.action || '').trim();
  try {
    if (action === 'admin-passkey-status') return await status(req, res, db);
    if (action === 'admin-passkey-register-options') return await registerOptions(req, res, db);
    if (action === 'admin-passkey-register-finish') return await registerFinish(req, res, db);
    if (action === 'admin-passkey-login-options') return await loginOptions(req, res, db);
    if (action === 'admin-passkey-login-finish') return await loginFinish(req, res, db);
    return res.status(400).json({ success: false, state: 'invalid_action' });
  } catch (_) {
    return res.status(503).json({ success: false, state: 'unavailable' });
  }
};

module.exports.__test = {
  CHALLENGE_COOKIE_NAME,
  CHALLENGE_MAX_AGE_SECONDS,
  DEVICE_COOKIE_NAME,
  DEVICE_COOKIE_MAX_AGE_SECONDS,
  b64urlEncode,
  b64urlDecode,
  timingSafeTextEqual,
  rpIdForRequest,
  originForRequest,
  createChallengeToken,
  verifyChallengeToken,
  buildChallengeCookie,
  clearChallengeCookie,
  buildDeviceCookie,
  hashDeviceSecret,
  randomSecret,
  randomChallenge,
  coarseDeviceLabel,
  isMobileUserAgent,
  parseCredentialId,
  decodeCborAt,
  parseClientData,
  verifyRpAndFlags,
  coseEc2ToJwk,
  verifyRegistrationCredential,
  verifyAssertionCredential
};
