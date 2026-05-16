const { createClient } = require('@supabase/supabase-js');

/**
 * POST /api/review-access
 * Validates review token, seeds review user if needed, checks blocked status.
 */
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const { token } = req.body || {};

    // Validate token
    if (!token || token !== 'autocuan-review-2026') {
      return res.status(403).json({ success: false, error: 'Token review tidak valid.' });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(500).json({ success: false, error: 'Database belum dikonfigurasi.' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { autoConnect: false }
    });

    // SHA-256 hash of "Review12345_autocuan_salt_2024"
    const REVIEW_PASSWORD_HASH = '42f38b0fcf1e35d9d2f82c462376f33145d1f450aeb216900db3356338686f2b';
    const REVIEW_DEVICE_ID = 'REVIEW_ANY_DEVICE';
    const REVIEW_USERNAME = 'review';

    // Check if review user exists
    const { data: existingUser, error: findError } = await supabase
      .from('app_users')
      .select('id, username, is_blocked, device_id, password_hash')
      .eq('username', REVIEW_USERNAME)
      .maybeSingle();

    if (findError) {
      console.error('review-access find error:', findError);
      return res.status(500).json({ success: false, error: 'Gagal memeriksa user review.' });
    }

    if (existingUser) {
      // User exists - check if blocked
      if (existingUser.is_blocked) {
        return res.status(403).json({ success: false, error: 'Akun review sedang diblokir.' });
      }

      // Ensure device_id is correct (don't change password or is_blocked)
      if (existingUser.device_id !== REVIEW_DEVICE_ID) {
        await supabase
          .from('app_users')
          .update({ device_id: REVIEW_DEVICE_ID })
          .eq('id', existingUser.id);
      }

      return res.status(200).json({ success: true, username: REVIEW_USERNAME, isReview: true });
    }

    // User does not exist - create it
    const { error: insertError } = await supabase
      .from('app_users')
      .insert({
        username: REVIEW_USERNAME,
        password_hash: REVIEW_PASSWORD_HASH,
        device_id: REVIEW_DEVICE_ID,
        user_agent: 'review_seed',
        is_blocked: false
      });

    if (insertError) {
      console.error('review-access insert error:', insertError);
      return res.status(500).json({ success: false, error: 'Gagal membuat user review: ' + insertError.message });
    }

    return res.status(200).json({ success: true, username: REVIEW_USERNAME, isReview: true });

  } catch (e) {
    console.error('review-access exception:', e);
    return res.status(500).json({ success: false, error: 'Server error: ' + e.message });
  }
};
