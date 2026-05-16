const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const { username, passwordHash, deviceId, userAgent } = req.body || {};

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

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // Find user by username
    const { data: user, error: findError } = await supabase
      .from('app_users')
      .select('id, username, password_hash, device_id, is_blocked')
      .eq('username', usernameLower)
      .maybeSingle();

    if (findError) {
      console.error('login-user find error:', findError);
      return res.status(500).json({ success: false, error: 'Gagal memeriksa akun.' });
    }

    if (!user) {
      return res.status(400).json({ success: false, error: 'Username tidak ditemukan.' });
    }

    // Check if blocked
    if (user.is_blocked) {
      return res.status(403).json({ success: false, error: 'Akun sedang diblokir.' });
    }

    // Check password
    if (user.password_hash !== passwordHash) {
      return res.status(400).json({ success: false, error: 'Password salah.' });
    }

    // Device binding check
    // If device_id is null or starts with RESET_PENDING_ => bind new device
    if (!user.device_id || user.device_id.startsWith('RESET_PENDING_')) {
      // Bind this device to the user
      const { error: updateError } = await supabase
        .from('app_users')
        .update({
          device_id: deviceId,
          user_agent: userAgent || '',
          last_login_at: new Date().toISOString()
        })
        .eq('id', user.id);

      if (updateError) {
        console.error('login-user device bind error:', updateError);
        return res.status(500).json({ success: false, error: 'Gagal memperbarui perangkat.' });
      }

      return res.status(200).json({
        success: true,
        username: usernameLower,
        isAdmin: false
      });
    }

    // If device_id exists and differs from current device
    if (user.device_id !== deviceId) {
      return res.status(400).json({ success: false, error: 'Username ini sudah terdaftar di perangkat lain.' });
    }

    // Device matches - update last_login_at
    const { error: updateError } = await supabase
      .from('app_users')
      .update({
        last_login_at: new Date().toISOString(),
        user_agent: userAgent || ''
      })
      .eq('id', user.id);

    if (updateError) {
      console.error('login-user update error:', updateError);
      // Non-fatal, still allow login
    }

    return res.status(200).json({
      success: true,
      username: usernameLower,
      isAdmin: false
    });
  } catch (e) {
    console.error('login-user exception:', e);
    return res.status(500).json({ success: false, error: 'Server error: ' + e.message });
  }
};
