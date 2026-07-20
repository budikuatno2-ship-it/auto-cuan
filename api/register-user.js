const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const {
  generateApprovalCode,
  normalizeTelegramChannelUrl
} = require('../lib/free-user-approval');

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

    // Insert new user (pending approval by default, first device stored in devices array)
    const { data, error: insertError } = await supabase
      .from('app_users')
      .insert({
        username: usernameLower,
        password_hash: passwordHash,
        device_id: normalizedDeviceId,
        devices: [normalizedDeviceId],
        user_agent: userAgent || '',
        is_blocked: false,
        is_approved: false
      })
      .select('id, username, created_at');

    if (insertError) {
      console.error('register-user insert error:', insertError);
      // Handle unique constraint violations
      if (insertError.code === '23505') {
        return res.status(400).json({ success: false, error: 'Username sudah digunakan.' });
      }
      // Never surface raw database constraint text to the user.
      return res.status(500).json({ success: false, error: 'Gagal membuat akun. Silakan coba lagi beberapa saat lagi.' });
    }

    const insertedUser = Array.isArray(data) ? data[0] : data;
    if (!insertedUser) {
      console.error('register-user insert returned no public approval source');
      return res.status(500).json({ success: false, error: 'Akun dibuat, tetapi kode approval belum tersedia. Hubungi admin.' });
    }

    const approvalCode = generateApprovalCode(insertedUser);
    const telegramChannelUrl = normalizeTelegramChannelUrl(process.env.TELEGRAM_FREE_CHANNEL_URL);

    return res.status(200).json({
      success: true,
      pending: true,
      approval_status: 'pending',
      approval_code: approvalCode,
      telegram_channel_url: telegramChannelUrl
    });
  } catch (e) {
    console.error('register-user exception:', e);
    return res.status(500).json({ success: false, error: 'Server error: ' + e.message });
  }
};

// Exposed for focused unit tests only.
module.exports.__test = { normalizeDeviceId: normalizeDeviceId };
