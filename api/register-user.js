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
        devices: [deviceId],
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
      return res.status(500).json({ success: false, error: 'Gagal membuat akun: ' + insertError.message });
    }

    return res.status(200).json({ success: true, pending: true });
  } catch (e) {
    console.error('register-user exception:', e);
    return res.status(500).json({ success: false, error: 'Server error: ' + e.message });
  }
};
