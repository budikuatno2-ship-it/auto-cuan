const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { createSessionToken, buildSessionCookie, buildClearCookie, getSessionSecret } = require('../lib/admin-session');
const { requireUserSession } = require('../lib/subscription-auth');
const { getEntitlements } = require('../lib/entitlements');
const { generateApprovalCode, maskUsername } = require('../lib/free-user-approval');
const telegramVerification = require('../lib/telegram-verification');
const { createVerifyBot } = require('../lib/telegram-verify-bot');

const MAX_DEVICES = 3;

// Max accepted webhook body size (bytes). A normal Telegram update is well under
// this; anything larger is rejected before parsing/processing.
const MAX_WEBHOOK_BODY_BYTES = 32 * 1024;

// Constant-time secret comparison that never short-circuits on length.
function secretsMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || expected.length === 0) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // Compare against itself to keep timing roughly constant, then fail.
    try { crypto.timingSafeEqual(b, b); } catch (e) {}
    return false;
  }
  try { return crypto.timingSafeEqual(a, b); } catch (e) { return false; }
}

// Isolated Telegram verification webhook handler. It runs BEFORE any login /
// logout / session logic, validates its own secret, and never touches cookies,
// sessions, or CRON_SECRET. It uses TELEGRAM_VERIFY_BOT_TOKEN only (via the
// verify bot) and never imports the recommendation notifier.
async function handleVerifyWebhook(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false });
  }

  // Fail-closed secret validation BEFORE parsing/processing the update.
  const expectedSecret = process.env.TELEGRAM_VERIFY_WEBHOOK_SECRET;
  const providedSecret = req.headers['x-telegram-bot-api-secret-token'];
  if (!expectedSecret || !secretsMatch(providedSecret, expectedSecret)) {
    return res.status(401).json({ ok: false });
  }

  // Strict request-size limit (header-based, then serialized-body based).
  const contentLength = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BODY_BYTES) {
    return res.status(413).json({ ok: false });
  }
  const update = req.body || {};
  try {
    if (JSON.stringify(update).length > MAX_WEBHOOK_BODY_BYTES) {
      return res.status(413).json({ ok: false });
    }
  } catch (e) {
    return res.status(400).json({ ok: false });
  }

  // Require a numeric update_id (needed for durable idempotency).
  if (typeof update.update_id !== 'number' || !Number.isFinite(update.update_id)) {
    return res.status(200).json({ ok: true, ignored: true });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    // Cannot process without the DB; ack so Telegram does not hammer retries.
    return res.status(200).json({ ok: true });
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  try {
    const bot = createVerifyBot();
    const result = await telegramVerification.processWebhookUpdate(update, { supabase, bot });
    // Only a coarse outcome code is returned/logged — never raw user input.
    return res.status(200).json({ ok: true, outcome: result && result.outcome });
  } catch (e) {
    // Never leak internals; still ack to avoid unbounded Telegram retries.
    return res.status(200).json({ ok: true });
  }
}
const LEGACY_BUDI_PASSWORD_HASH = crypto
  .createHash('sha256')
  .update('._autocuan_salt_2024', 'utf8')
  .digest('hex');

function matchesLegacyBudiPassword(passwordHash) {
  if (typeof passwordHash !== 'string') return false;
  const supplied = Buffer.from(passwordHash, 'utf8');
  const expected = Buffer.from(LEGACY_BUDI_PASSWORD_HASH, 'utf8');
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function isRegisteredDevice(user, deviceId) {
  if (typeof deviceId !== 'string' || !deviceId) return false;
  const currentDevices = Array.isArray(user.devices) ? user.devices : [];
  return user.device_id === deviceId || currentDevices.includes(deviceId);
}

// Generic credential error to prevent username enumeration (invalid username and
// invalid password produce the identical public response).
const GENERIC_CREDENTIAL_ERROR = 'Username atau password salah.';

// Issue the signed session cookie on a successful, DB-authenticated login.
// Admin is derived SERVER-SIDE only (never from client input). Fail-closed: if no
// SESSION_SECRET is configured, no cookie is set and admin endpoints stay locked.
function issueSessionCookie(res, user, usernameLower, deviceId) {
  const result = { isAdmin: usernameLower === 'budi', issued: false };
  try {
    const token = createSessionToken({ userId: user.id, username: usernameLower, isAdmin: result.isAdmin, deviceId: deviceId });
    if (token) {
      res.setHeader('Set-Cookie', buildSessionCookie(token));
      result.issued = true;
    }
  } catch (e) {
    // Never log token/secret/device. Fail-closed: no session is considered issued.
  }
  return result;
}

module.exports = async function handler(req, res) {
  // === TELEGRAM VERIFICATION WEBHOOK ===
  // This isolated action runs FIRST, before logout / password / session / normal
  // login handling. It validates its own secret, never issues or reads browser
  // sessions, never touches CRON_SECRET, and uses TELEGRAM_VERIFY_BOT_TOKEN only.
  if (req.query && req.query.action === 'telegram-verify-webhook') {
    return await handleVerifyWebhook(req, res);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const { username, passwordHash, deviceId, userAgent, action } = req.body || {};

    // Read-only Phase 1 entitlement endpoint. The identity comes only from the
    // signed HttpOnly session; request headers and body claims are ignored.
    if ((req.query && req.query.action === 'subscription-status') || action === 'subscription-status') {
      const auth = requireUserSession(req);
      if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error });

      const SUPABASE_URL = process.env.SUPABASE_URL;
      const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(503).json({ success: false, error: 'Status akun tidak tersedia.' });
      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data: account, error } = await supabase.from('app_users')
        .select('id, username, is_blocked, is_approved')
        .eq('id', auth.user.id)
        .maybeSingle();
      if (error || !account || String(account.username || '').trim().toLowerCase() !== auth.user.username) {
        return res.status(401).json({ success: false, error: 'Sesi tidak valid.' });
      }
      const entitlement = getEntitlements(auth.user, account);
      return res.status(200).json({
        success: true,
        account: { username: account.username, approved: account.is_approved === true, blocked: account.is_blocked === true },
        entitlement: entitlement
      });
    }

    // === LOGOUT === (explicit; does not require a valid token or DB access)
    if (action === 'logout') {
      res.setHeader('Set-Cookie', buildClearCookie());
      return res.status(200).json({ success: true });
    }

    // Validate inputs. A legacy-shaped budi request with no device must fail with
    // the same generic credential response as every other compatibility failure.
    if (!username || !passwordHash) {
      return res.status(400).json({ success: false, error: 'Data tidak lengkap.' });
    }

    const usernameLower = String(username).trim().toLowerCase();

    if (!deviceId) {
      if (usernameLower === 'budi' && matchesLegacyBudiPassword(passwordHash)) {
        return res.status(400).json({ success: false, error: GENERIC_CREDENTIAL_ERROR });
      }
      return res.status(400).json({ success: false, error: 'Data tidak lengkap.' });
    }

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
      .select('id, username, password_hash, device_id, devices, is_blocked, is_approved')
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

    const databasePasswordMatches = user.password_hash === passwordHash;

    if (!databasePasswordMatches) {
      // Narrow compatibility for the historical budi + "." login. The browser
      // still hashes the entered password through the shared client algorithm;
      // the legacy hash alone is insufficient and never bypasses device binding.
      const legacyBudiPasswordMatches = usernameLower === 'budi' && matchesLegacyBudiPassword(passwordHash);
      const legacyBudiMayLogin = legacyBudiPasswordMatches &&
        Boolean(getSessionSecret()) &&
        user.is_blocked === false &&
        user.is_approved === true &&
        isRegisteredDevice(user, deviceId);

      if (!legacyBudiMayLogin) {
        console.error('login-user: authentication failed (bad password)');
        return res.status(400).json({ success: false, error: GENERIC_CREDENTIAL_ERROR });
      }

      // Compatibility success is deliberately read-only: do not update login
      // metadata and never append/trust a device. Admin is derived server-side.
      const legacySession = issueSessionCookie(res, user, usernameLower, deviceId);
      if (!legacySession.issued) {
        return res.status(400).json({ success: false, error: GENERIC_CREDENTIAL_ERROR });
      }
      return res.status(200).json({
        success: true,
        username: usernameLower,
        userId: user.id,
        isAdmin: legacySession.isAdmin
      });
    }

    // Database credentials are valid from here on; preserve the existing normal
    // login, account-state, and device-registration behavior unchanged.

    // Check if blocked
    if (user.is_blocked) {
      return res.status(403).json({ success: false, error: 'Akun sedang diblokir.' });
    }

    // Check approval status (skip for review user — review bypasses approval).
    // Reaching here guarantees the submitted password already matched, so it is
    // safe to reveal pending-approval details. Users who registered before this
    // feature never received their recognition code; surface it now WITHOUT
    // issuing a session or logging them in. The AC-XXXXXX value is a public
    // recognition code, not an authentication credential.
    if (usernameLower !== 'review' && user.is_approved === false) {
      // v2: issue a FRESH one-time verification code (rotating/revoking any prior
      // active challenge) for this pending user. No session is issued and no
      // channel link is exposed. The raw code is returned only after the RPC
      // commits. If issuance is unavailable (e.g. secret not configured), we
      // still surface the recognition code without a verification code.
      const pendingResponse = {
        success: false,
        approval_status: 'pending',
        approval_code: generateApprovalCode({ id: user.id, username: user.username, created_at: user.created_at }),
        masked_username: maskUsername(user.username),
        telegram_bot_url: telegramVerification.BOT_URL
      };
      try {
        if (telegramVerification.hasCodeSecret()) {
          const issued = await telegramVerification.issueChallengeForUser(supabase, user.id);
          if (issued) {
            pendingResponse.telegram_verification_code = issued.displayCode;
            pendingResponse.telegram_verification_expires_at = issued.expiresAt;
          }
        }
      } catch (e) {
        console.error('login-user: pending challenge issuance failed');
      }
      return res.status(403).json(pendingResponse);
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

      const knownDeviceSession = issueSessionCookie(res, user, usernameLower, deviceId);
      return res.status(200).json({
        success: true,
        username: usernameLower,
        userId: user.id,
        isAdmin: knownDeviceSession.isAdmin
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

    const newDeviceSession = issueSessionCookie(res, user, usernameLower, deviceId);
    return res.status(200).json({
      success: true,
      username: usernameLower,
      userId: user.id,
      isAdmin: newDeviceSession.isAdmin
    });
  } catch (e) {
    console.error('login-user exception:', e);
    return res.status(500).json({ success: false, error: 'Server error: ' + e.message });
  }
};
