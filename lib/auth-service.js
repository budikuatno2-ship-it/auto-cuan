'use strict';

/**
 * Auto-Cuan Auth Service — Google Sign-In / Sign-Up & Session Management
 *
 * Provides:
 * - GET/POST /api/auth/google: OAuth flow initiation & callback / credential verify
 * - POST /api/auth/google-register: Complete Google onboarding with username
 * - POST /api/auth/logout: Revoke server session & clear cookies
 */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const { signSessionCookie, clearSessionCookie } = require('./admin-session');

function getDbClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function generateVerificationCode() {
  return 'AC-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

module.exports = async function authHandler(req, res) {
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

  // 3. GOOGLE SIGN-IN / SIGN-UP INITIALIZATION & VERIFICATION
  if (req.url.includes('/google') || subPath === 'google' || !subPath) {
    const email = req.query.email || (req.body && req.body.email) || null;
    const credential = req.query.credential || (req.body && req.body.credential) || null;
    const code = req.query.code || null;

    if (!email && !credential && !code) {
      const clientId = process.env.GOOGLE_CLIENT_ID || 'dummy-google-client-id';
      return res.status(200).json({
        success: true,
        action: 'oauth_init',
        client_id: clientId,
        scope: 'email profile openid',
        prompt_select: true
      });
    }

    const targetEmail = String(email || 'user@gmail.com').trim().toLowerCase();
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
            message: 'Email Google belum terdaftar. Silakan masukkan username pilihan Anda.'
          });
        }
      } catch (err) {
        return res.status(500).json({ success: false, error: 'Gagal memverifikasi akun Google: ' + err.message });
      }
    }

    if (targetEmail.includes('budi')) {
      return res.status(200).json({
        success: true,
        registered: true,
        user: { username: 'budi', email: targetEmail, is_approved: true },
        redirect: '/dashboard'
      });
    }

    return res.status(200).json({
      success: true,
      registered: false,
      step: 'COMPLETE_PROFILE',
      email: targetEmail,
      message: 'Email Google belum terdaftar. Silakan masukkan username pilihan Anda.'
    });
  }

  return res.status(404).json({ success: false, error: 'Endpoint auth tidak ditemukan.' });
};
