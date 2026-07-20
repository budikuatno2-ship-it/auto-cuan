const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const {
  generateApprovalCode,
  maskUsername
} = require('../lib/free-user-approval');
const telegramVerification = require('../lib/telegram-verification');

// Normalize a client-provided device ID and generate a secure server-side
// fallback when an older client omits it. Keeps the NOT NULL `device_id`
// column satisfied without exposing device ID as a required user input.
function normalizeDeviceId(rawDeviceId) {
  var id = typeof rawDeviceId === 'string' ? rawDeviceId.trim() : '';
  // Strip control characters and cap length so the value is storage-safe.
  id = id.replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 128);
  if (!id) {
    id = 'srv_' + crypto.randomUUID();
  }
  return id;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const { username, passwordHash, deviceId, userAgent } = req.body || {};

    // Validate required inputs. Device ID is auto-managed by the client and
    // backfilled server-side, so it is NOT a required user input.
    if (!username || !passwordHash) {
      return res.status(400).json({ success: false, error: 'Data tidak lengkap.' });
    }

    // Ensure we always have a non-null device ID for the NOT NULL column.
    const normalizedDeviceId = normalizeDeviceId(deviceId);

    const usernameLower = String(username).trim().toLowerCase();

    // Reject empty or too long
    if (!usernameLower || usernameLower.length < 2) {
      return res.status(400).json({ success: false, error: 'Username minimal 2 karakter.' });
    }
    if (usernameLower.length > 30) {
      return res.status(400).json({ success: false, error: 'Username maksimal 30 karakter.' });
    }

    // Reject reserved usernames
    if (usernameLower === 'budi' || usernameLower === 'review') {
      return res.status(400).json({ success: false, error: 'Username tidak tersedia.' });
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

    // Check if username already exists
    const { data: existingUser, error: findError } = await supabase
      .from('app_users')
      .select('id, username')
      .eq('username', usernameLower)
      .maybeSingle();

    if (findError) {
      console.error('register-user find error:', findError);
      return res.status(500).json({ success: false, error: 'Gagal memeriksa username.' });
    }

    if (existingUser) {
      return res.status(400).json({ success: false, error: 'Username sudah digunakan.' });
    }

    // v2: Atomically create the pending user AND its first one-time verification
    // challenge. The raw code is generated in Node; ONLY its HMAC is passed to
    // SQL. Fail closed if the code secret is not configured — no user is created.
    if (!telegramVerification.hasCodeSecret()) {
      return res.status(500).json({ success: false, error: 'Verifikasi belum dikonfigurasi. Coba lagi nanti.' });
    }

    let registration;
    try {
      registration = await telegramVerification.registerPendingUser(supabase, {
        username: usernameLower,
        passwordHash: passwordHash,
        deviceId: normalizedDeviceId,
        userAgent: userAgent || ''
      });
    } catch (rpcError) {
      // Never surface raw database constraint text. A username/device duplicate
      // arrives as SQLSTATE 23505 (active-hash collisions are retried internally).
      if (rpcError && rpcError.pgcode === '23505') {
        return res.status(400).json({ success: false, error: 'Username sudah digunakan.' });
      }
      console.error('register-user rpc failed');
      return res.status(500).json({ success: false, error: 'Gagal membuat akun. Silakan coba lagi beberapa saat lagi.' });
    }

    if (!registration || !registration.id) {
      console.error('register-user rpc returned no public approval source');
      return res.status(500).json({ success: false, error: 'Akun dibuat, tetapi kode verifikasi belum tersedia. Hubungi admin.' });
    }

    // The raw one-time code is returned to the client ONLY after the RPC committed.
    // The private channel invite link is NEVER exposed by the website.
    return res.status(200).json({
      success: true,
      pending: true,
      approval_status: 'pending',
      masked_username: maskUsername(registration.username),
      approval_code: generateApprovalCode({ id: registration.id, username: registration.username, created_at: registration.createdAt }),
      telegram_verification_code: registration.displayCode,
      telegram_verification_expires_at: registration.expiresAt,
      telegram_bot_url: telegramVerification.BOT_URL
    });
  } catch (e) {
    console.error('register-user exception:', e);
    return res.status(500).json({ success: false, error: 'Server error: ' + e.message });
  }
};

// Exposed for focused unit tests only.
module.exports.__test = { normalizeDeviceId: normalizeDeviceId };
