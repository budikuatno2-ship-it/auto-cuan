const { createClient } = require('@supabase/supabase-js');
const { createSessionToken, buildSessionCookie, buildClearCookie } = require('../lib/admin-session');

const MAX_DEVICES = 3;

// Generic credential error to prevent username enumeration (invalid username and
// invalid password produce the identical public response).
const GENERIC_CREDENTIAL_ERROR = 'Username atau password salah.';

// Issue the signed session cookie on a successful, DB-authenticated login.
// Admin is derived SERVER-SIDE only (never from client input). Fail-closed: if no
// SESSION_SECRET is configured, no cookie is set and admin endpoints stay locked.
function issueSessionCookie(res, user, usernameLower, deviceId) {
  const isAdmin = usernameLower === 'budi';
  try {
    const token = createSessionToken({ userId: user.id, username: usernameLower, isAdmin: isAdmin, deviceId: deviceId });
    if (token) res.setHeader('Set-Cookie', buildSessionCookie(token));
  } catch (e) {
    // Never log token/secret/device. Fail-closed: proceed without a session cookie.
  }
  return isAdmin;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const { username, passwordHash, deviceId, userAgent, action } = req.body || {};

    // === LOGOUT === (explicit; does not require a valid token or DB access)
    if (action === 'logout') {
      res.setHeader('Set-Cookie', buildClearCookie());
      return res.status(200).json({ success: true });
    }

    // Validate inputs
    if (!username || !passwordHash || !deviceId) {
      return res.status(400).json({ success: false, error: 'Data tidak lengkap.' });
    }

    const usernameLower = String(username).trim().toLowerCase();

    if (!usernameLower || usernameLower.length < 2) {
      return res.status(400).json({ success: false, error: 'Username tidak valid.' });
    }

    // Supabase setup
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(500).json({ success: false, error: 'Database belum dikonfigurasi.' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    // Find user by username
    const { data: user, error: findError } = await supabase
      .from('app_users')
      .select('id, username, password_hash, devices, is_blocked, is_approved')
      .eq('username', usernameLower)
      .maybeSingle();

    if (findError) {
      console.error('login-user find error:', findError);
      return res.status(500).json({ success: false, error: 'Gagal memeriksa akun.' });
    }

    // Verify credentials FIRST with a single generic message so an attacker cannot
    // distinguish "unknown username" from "wrong password" (anti-enumeration).
    // Account-state messages (blocked / not approved) are only revealed AFTER the
    // correct password is provided.
    if (!user) {
      console.error('login-user: authentication failed (unknown account)');
      return res.status(400).json({ success: false, error: GENERIC_CREDENTIAL_ERROR });
    }

    if (user.password_hash !== passwordHash) {
      console.error('login-user: authentication failed (bad password)');
      return res.status(400).json({ success: false, error: GENERIC_CREDENTIAL_ERROR });
    }

    // Credentials are valid from here on.

    // Check if blocked
    if (user.is_blocked) {
      return res.status(403).json({ success: false, error: 'Akun sedang diblokir.' });
    }

    // Check approval status (skip for review user — review bypasses approval)
    if (usernameLower !== 'review' && user.is_approved === false) {
      return res.status(403).json({ success: false, error: 'Akun belum di-approve oleh admin. Silakan tunggu persetujuan.' });
    }

    // === REVIEW USER: bypass device binding ===
    if (usernameLower === 'review') {
      const { error: updateError } = await supabase
        .from('app_users')
        .update({ last_login_at: new Date().toISOString() })
        .eq('id', user.id);

      if (updateError) {
        console.error('login-user review update error:', updateError);
      }

      issueSessionCookie(res, user, usernameLower, deviceId);
      return res.status(200).json({
        success: true,
        username: 'review',
        userId: user.id,
        isAdmin: false,
        isReview: true
      });
    }

    // === MULTI-DEVICE BINDING (max 3 devices) ===
    const currentDevices = Array.isArray(user.devices) ? user.devices : [];

    // Check if this device is already registered for this user
    if (currentDevices.includes(deviceId)) {
      // Device already known — just update last_login_at
      const { error: updateError } = await supabase
        .from('app_users')
        .update({
          last_login_at: new Date().toISOString(),
          user_agent: userAgent || ''
        })
        .eq('id', user.id);

      if (updateError) {
        console.error('login-user update error:', updateError);
      }

      const knownDeviceIsAdmin = issueSessionCookie(res, user, usernameLower, deviceId);
      return res.status(200).json({
        success: true,
        username: usernameLower,
        userId: user.id,
        isAdmin: knownDeviceIsAdmin
      });
    }

    // Device is new — check if there's room
    if (currentDevices.length >= MAX_DEVICES) {
      return res.status(400).json({
        success: false,
        error: 'Batas perangkat tercapai. Hubungi admin untuk reset perangkat.'
      });
    }

    // Add new device to the array
    const updatedDevices = [...currentDevices, deviceId];

    const { error: updateError } = await supabase
      .from('app_users')
      .update({
        devices: updatedDevices,
        user_agent: userAgent || '',
        last_login_at: new Date().toISOString()
      })
      .eq('id', user.id);

    if (updateError) {
      console.error('login-user device add error:', updateError);
      return res.status(500).json({ success: false, error: 'Gagal memperbarui perangkat.' });
    }

    const newDeviceIsAdmin = issueSessionCookie(res, user, usernameLower, deviceId);
    return res.status(200).json({
      success: true,
      username: usernameLower,
      userId: user.id,
      isAdmin: newDeviceIsAdmin
    });
  } catch (e) {
    console.error('login-user exception:', e);
    return res.status(500).json({ success: false, error: 'Server error: ' + e.message });
  }
};
