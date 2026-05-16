const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const { username, newPasswordHash, deviceId } = req.body || {};

    // Validate inputs
    if (!username || !newPasswordHash || !deviceId) {
      return res.status(400).json({ success: false, error: 'Data tidak lengkap.' });
    }

    const usernameLower = String(username).trim().toLowerCase();

    // Reject budi
    if (usernameLower === 'budi') {
      return res.status(400).json({ success: false, error: 'Akun admin tidak bisa direset dari halaman ini.' });
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
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { autoConnect: false }
    });

    // Find user
    const { data: user, error: findError } = await supabase
      .from('app_users')
      .select('id, username, device_id, is_blocked')
      .eq('username', usernameLower)
      .maybeSingle();

    if (findError) {
      console.error('reset-password find error:', findError);
      return res.status(500).json({ success: false, error: 'Gagal memeriksa akun.' });
    }

    if (!user) {
      return res.status(400).json({ success: false, error: 'Username tidak ditemukan.' });
    }

    // Check if blocked
    if (user.is_blocked) {
      return res.status(403).json({ success: false, error: 'Akun sedang diblokir.' });
    }

    // Check device binding
    if (!user.device_id || user.device_id !== deviceId) {
      return res.status(400).json({ success: false, error: 'Reset password hanya bisa dilakukan dari perangkat yang terdaftar. Hubungi admin jika perangkat berubah.' });
    }

    // Update password
    const { error: updateError } = await supabase
      .from('app_users')
      .update({
        password_hash: newPasswordHash,
        last_login_at: new Date().toISOString()
      })
      .eq('id', user.id);

    if (updateError) {
      console.error('reset-password update error:', updateError);
      return res.status(500).json({ success: false, error: 'Gagal mereset password.' });
    }

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('reset-password exception:', e);
    return res.status(500).json({ success: false, error: 'Server error: ' + e.message });
  }
};
