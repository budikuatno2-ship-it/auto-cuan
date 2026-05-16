const { createClient } = require('@supabase/supabase-js');

/**
 * Seed the "review" testing account.
 * POST /api/seed-review
 *
 * If review user does not exist → create it.
 * If review user already exists → ensure is_blocked=false, device_id=REVIEW_ANY_DEVICE,
 *   and update password_hash only if needed.
 *
 * Password: Review12345
 * Hashed with SHA-256( "Review12345" + "_autocuan_salt_2024" )
 */
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
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

    // Check if review user already exists
    const { data: existingUser, error: findError } = await supabase
      .from('app_users')
      .select('id, username, password_hash, device_id, is_blocked')
      .eq('username', REVIEW_USERNAME)
      .maybeSingle();

    if (findError) {
      console.error('seed-review find error:', findError);
      return res.status(500).json({ success: false, error: 'Gagal memeriksa user review.' });
    }

    if (existingUser) {
      // User exists - ensure correct state
      const updates = {};
      if (existingUser.is_blocked !== false) updates.is_blocked = false;
      if (existingUser.device_id !== REVIEW_DEVICE_ID) updates.device_id = REVIEW_DEVICE_ID;
      if (existingUser.password_hash !== REVIEW_PASSWORD_HASH) updates.password_hash = REVIEW_PASSWORD_HASH;

      if (Object.keys(updates).length > 0) {
        const { error: updateError } = await supabase
          .from('app_users')
          .update(updates)
          .eq('id', existingUser.id);

        if (updateError) {
          console.error('seed-review update error:', updateError);
          return res.status(500).json({ success: false, error: 'Gagal memperbarui user review: ' + updateError.message });
        }

        return res.status(200).json({ success: true, action: 'updated', updates: Object.keys(updates) });
      }

      return res.status(200).json({ success: true, action: 'no_change', message: 'Review user sudah dalam kondisi benar.' });
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
      console.error('seed-review insert error:', insertError);
      return res.status(500).json({ success: false, error: 'Gagal membuat user review: ' + insertError.message });
    }

    return res.status(200).json({ success: true, action: 'created', message: 'Review user berhasil dibuat.' });

  } catch (e) {
    console.error('seed-review exception:', e);
    return res.status(500).json({ success: false, error: 'Server error: ' + e.message });
  }
};
