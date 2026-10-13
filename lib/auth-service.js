'use strict';

/**
 * Auto-Cuan Auth Service - Google Sign-In / Sign-Up & Session Management
 *
 * Provides:
 * - GET/POST /api/auth/google: OAuth flow initiation & credential verify (Google Identity Services)
 * - POST /api/auth/google-register: Complete Google onboarding with username
 * - POST /api/auth/logout: Revoke server session & clear cookies
 */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const { signSessionCookie, clearSessionCookie } = require('./admin-session');

let _jwksCache = { keys: [], expiresAt: 0 };

async function getGoogleJwks(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _jwksCache.keys.length > 0 && _jwksCache.expiresAt > now) {
    return _jwksCache.keys;
  }
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/certs', {
      headers: { 'User-Agent': 'Auto-Cuan-Auth-Verifier/1.0' }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data && Array.isArray(data.keys)) {
      _jwksCache = {
        keys: data.keys,
        expiresAt: now + 3600 * 1000 // 1 jam TTL
      };
      return _jwksCache.keys;
    }
  } catch (err) {
    if (_jwksCache.keys.length > 0) return _jwksCache.keys;
    throw err;
  }
  return [];
}

async function verifyGoogleIdToken(token, expectedClientId, injectedJwks = null) {
  if (!token || typeof token !== 'string') {
    throw new Error('Token Google tidak boleh kosong.');
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Format token JWT tidak valid (harus terdiri dari 3 segmen).');
  }

  let header, payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (_) {
    throw new Error('Gagal melakukan decode pada header atau payload token.');
  }

  if (header.alg !== 'RS256') {
    throw new Error('Algoritma token tidak didukung: ' + header.alg);
  }
  if (!header.kid) {
    throw new Error('Header token tidak memiliki key id (kid).');
  }

  // 1. Validasi klaim standar JWT
  const nowSec = Math.floor(Date.now() / 1000);
  if (!payload.exp || typeof payload.exp !== 'number' || payload.exp < (nowSec - 30)) {
    throw new Error('Token Google telah kedaluwarsa.');
  }

  const validIssuers = ['https://accounts.google.com', 'accounts.google.com'];
  if (!validIssuers.includes(payload.iss)) {
    throw new Error('Issuer token Google tidak sah: ' + payload.iss);
  }

  if (expectedClientId && payload.aud !== expectedClientId) {
    throw new Error('Audience (aud) token tidak sesuai dengan GOOGLE_CLIENT_ID aplikasi.');
  }

  if (payload.email_verified !== true && payload.email_verified !== 'true') {
    throw new Error('Email Google belum terverifikasi oleh Google.');
  }

  if (!payload.email || typeof payload.email !== 'string' || !payload.email.includes('@')) {
    throw new Error('Payload token tidak memiliki alamat email yang valid.');
  }
  if (!payload.sub) {
    throw new Error('Payload token tidak memiliki sub identifier.');
  }

  // 2. Verifikasi tanda tangan kriptografis dengan JWKS Google
  let keys = injectedJwks || await getGoogleJwks(false);
  let jwk = keys.find(k => k.kid === header.kid);
  if (!jwk && !injectedJwks) {
    keys = await getGoogleJwks(true);
    jwk = keys.find(k => k.kid === header.kid);
  }

  if (!jwk) {
    throw new Error('Kunci publik Google (kid: ' + header.kid + ') tidak ditemukan.');
  }

  let publicKey;
  try {
    publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  } catch (err) {
    throw new Error('Gagal mengimpor public key Google: ' + err.message);
  }

  const verify = crypto.createVerify('SHA256');
  verify.update(`${parts[0]}.${parts[1]}`);
  const isValid = verify.verify(publicKey, Buffer.from(parts[2], 'base64url'));

  if (!isValid) {
    throw new Error('Tanda tangan kriptografis token Google tidak valid.');
  }

  return {
    email: String(payload.email).trim().toLowerCase(),
    sub: String(payload.sub).trim(),
    name: String(payload.name || '').trim(),
    picture: payload.picture || null,
    email_verified: true
  };
}

function getDbClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function generateVerificationCode() {
  return 'AC-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

async function authHandler(req, res, options = {}) {
  res.setHeader('Cache-Control', 'no-store, private');
  const subPath = req._authSubPath || (req.query && req.query.action) || (req.body && req.body.action) || '';

  // 1. LOGOUT: POST /api/auth/logout
  if (req.url.includes('/logout') || subPath === 'logout') {
    if (typeof clearSessionCookie === 'function') {
      try { clearSessionCookie(res); } catch (_) {}
    }
    res.setHeader('Set-Cookie', [
      'ac_sess=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax',
      'authToken=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax'
    ]);
    return res.status(200).json({ success: true, message: 'Berhasil keluar dari sesi.' });
  }

  // 2. COMPLETE GOOGLE ONBOARDING: POST /api/auth/google-register
  if (req.url.includes('/google-register') || subPath === 'google-register') {
    if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
    const body = req.body || {};
    const email = String(body.email || '').trim().toLowerCase();
    const username = String(body.username || '').trim().toLowerCase();
    const googleId = String(body.google_id || body.sub || '').trim();

    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, error: 'Email Google tidak valid.' });
    }
    if (!username || username.length < 3 || !/^[a-z0-9_]+$/.test(username)) {
      return res.status(400).json({ success: false, error: 'Username minimal 3 karakter (hanya huruf kecil, angka, dan underscore).' });
    }
    if (username === 'budi' || username === 'admin' || username === 'root') {
      return res.status(400).json({ success: false, error: 'Username tidak tersedia.' });
    }

    const verificationCode = generateVerificationCode();
    const db = getDbClient();

    if (db) {
      try {
        const { data: existingUser } = await db.from('app_users').select('id, username').eq('username', username).maybeSingle();
        if (existingUser) {
          return res.status(409).json({ success: false, error: 'Username sudah digunakan. Silakan pilih username lain.' });
        }

        const { data: newUser, error: insertErr } = await db.from('app_users').insert({
          username: username,
          email: email,
          is_approved: false,
          is_blocked: false,
          auth_provider: 'google',
          google_id: googleId || null,
          verification_code: verificationCode,
          created_at: new Date().toISOString()
        }).select().single();

        if (insertErr) {
          return res.status(500).json({ success: false, error: 'Gagal membuat akun: ' + insertErr.message });
        }

        return res.status(200).json({
          success: true,
          status: 'PENDING_VERIFICATION',
          username: username,
          email: email,
          verification_code: verificationCode,
          telegram_bot_url: 'https://t.me/autocuan_verify_bot?start=' + encodeURIComponent(verificationCode),
          message: 'Pendaftaran Google berhasil. Silakan verifikasi akun via bot Telegram resmi.'
        });
      } catch (err) {
        return res.status(500).json({ success: false, error: 'Database error: ' + err.message });
      }
    }

    return res.status(200).json({
      success: true,
      status: 'PENDING_VERIFICATION',
      username: username,
      email: email,
      verification_code: verificationCode,
      telegram_bot_url: 'https://t.me/autocuan_verify_bot?start=' + encodeURIComponent(verificationCode),
      message: 'Pendaftaran Google berhasil. Silakan verifikasi akun via bot Telegram resmi.'
    });
  }

  // 3. GOOGLE SIGN-IN / SIGN-UP (GOOGLE IDENTITY SERVICES)
  if (req.url.includes('/google') || subPath === 'google' || !subPath) {
    const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
    const isGoogleConfigured = Boolean(clientId && clientId !== 'dummy-google-client-id');

    // FEATURE FLAG CHECK: Jika GOOGLE_CLIENT_ID belum disetel di environment, tolak dengan status 503
    if (!isGoogleConfigured) {
      return res.status(503).json({
        success: false,
        error: 'Fitur Masuk dengan Google sedang tidak aktif atau belum dikonfigurasi. Silakan masuk menggunakan nama pengguna dan kata sandi.'
      });
    }

    // Jika GET atau inisialisasi konfigurasi klien
    if (req.method === 'GET' || (!req.body || (typeof req.body === 'object' && Object.keys(req.body).length === 0))) {
      return res.status(200).json({
        success: true,
        action: 'oauth_init',
        client_id: clientId,
        scope: 'email profile openid',
        prompt_select: true
      });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    const token = req.body && (req.body.credential || req.body.id_token || req.body.token);

    // KETAT: Tolak body yang hanya mengirim email mentah tanpa token resmi Google
    if (!token) {
      return res.status(400).json({
        success: false,
        error: 'ID Token Google (JWT) wajib disertakan. Masuk dengan alamat email langsung tidak diizinkan.'
      });
    }

    // Verifikasi tanda tangan kriptografis token JWT
    let verified;
    try {
      verified = await verifyGoogleIdToken(token, clientId, options.injectedJwks || null);
    } catch (err) {
      return res.status(401).json({
        success: false,
        error: 'Verifikasi kredensial Google gagal: ' + err.message
      });
    }

    const targetEmail = verified.email;
    const db = getDbClient();

    if (db) {
      try {
        const { data: user } = await db.from('app_users').select('id, username, email, is_approved, is_blocked').eq('email', targetEmail).maybeSingle();
        if (user) {
          if (user.is_blocked) {
            return res.status(403).json({ success: false, error: 'Akun Anda sedang diblokir.' });
          }
          if (typeof signSessionCookie === 'function') {
            try {
              signSessionCookie(res, {
                uid: user.id,
                un: user.username,
                adm: user.username === 'budi'
              });
            } catch (_) {}
          }
          return res.status(200).json({
            success: true,
            registered: true,
            user: {
              id: user.id,
              username: user.username,
              email: user.email,
              is_approved: user.is_approved
            },
            redirect: '/dashboard'
          });
        } else {
          return res.status(200).json({
            success: true,
            registered: false,
            step: 'COMPLETE_PROFILE',
            email: targetEmail,
            google_id: verified.sub,
            message: 'Email Google terverifikasi. Silakan masukkan username pilihan Anda.'
          });
        }
      } catch (err) {
        return res.status(500).json({ success: false, error: 'Gagal memverifikasi akun Google: ' + err.message });
      }
    }

    // Fallback jika database belum terhubung (lingkungan uji/mock dev)
    return res.status(200).json({
      success: true,
      registered: false,
      step: 'COMPLETE_PROFILE',
      email: targetEmail,
      google_id: verified.sub,
      message: 'Email Google terverifikasi. Silakan masukkan username pilihan Anda.'
    });
  }

  return res.status(404).json({ success: false, error: 'Endpoint auth tidak ditemukan.' });
}

authHandler.verifyGoogleIdToken = verifyGoogleIdToken;
module.exports = authHandler;
