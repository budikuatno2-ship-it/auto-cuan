const { createClient } = require('@supabase/supabase-js');

/**
 * POST /api/check-approval
 * Check if a logged-in user's is_approved status.
 * Used for frontend polling to detect approval changes.
 */
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const { username, passwordHash, deviceId } = req.body || {};

    if (!username || !passwordHash || !deviceId) {
      return res.status(400).json({ success: false, error: 'Data tidak lengkap.' });
    }

    const usernameLower = String(username).trim().toLowerCase();

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(500).json({ success: false, error: 'Database belum dikonfigurasi.' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    // Find user and verify credentials
    const { data: user, error: findError } = await supabase
      .from('app_users')
      .select('id, username, password_hash, device_id, is_approved, is_blocked')
      .eq('username', usernameLower)
      .maybeSingle();

    if (findError || !user) {
      return res.status(400).json({ success: false, error: 'User tidak ditemukan.' });
    }

    // Quick credential validation (prevents unauthorized polling)
    if (user.password_hash !== passwordHash) {
      return res.status(400).json({ success: false, error: 'Kredensial tidak valid.' });
    }

    if (user.is_blocked) {
      return res.status(403).json({ success: false, error: 'Akun diblokir.', is_approved: false });
    }

    return res.status(200).json({
      success: true,
      is_approved: user.is_approved === true,
      username: user.username
    });

  } catch (e) {
    console.error('check-approval exception:', e);
    return res.status(500).json({ success: false, error: 'Server error: ' + e.message });
  }
};
