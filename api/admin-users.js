const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const { adminName, action, username } = req.body || {};

    // Only budi can access
    if (!adminName || String(adminName).trim().toLowerCase() !== 'budi') {
      return res.status(403).json({ success: false, error: 'Unauthorized. Admin only.' });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(500).json({ success: false, error: 'Database belum dikonfigurasi.' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // === LIST USERS ===
    if (action === 'list') {
      const { data, error } = await supabase
        .from('app_users')
        .select('id, username, device_id, user_agent, is_blocked, created_at, last_login_at')
        .order('created_at', { ascending: false })
        .limit(200);

      if (error) {
        console.error('admin-users list error:', error);
        return res.status(500).json({ success: false, error: 'Gagal memuat daftar user: ' + error.message });
      }

      return res.status(200).json({ success: true, users: data || [] });
    }

    // === BLOCK USER ===
    if (action === 'block') {
      if (!username) {
        return res.status(400).json({ success: false, error: 'Username diperlukan.' });
      }

      const targetUser = String(username).trim().toLowerCase();

      // Cannot block budi
      if (targetUser === 'budi') {
        return res.status(400).json({ success: false, error: 'Tidak dapat memblokir admin.' });
      }

      const { error } = await supabase
        .from('app_users')
        .update({ is_blocked: true })
        .eq('username', targetUser);

      if (error) {
        console.error('admin-users block error:', error);
        return res.status(500).json({ success: false, error: 'Gagal memblokir user: ' + error.message });
      }

      return res.status(200).json({ success: true, message: 'User ' + targetUser + ' berhasil diblokir.' });
    }

    // === UNBLOCK USER ===
    if (action === 'unblock') {
      if (!username) {
        return res.status(400).json({ success: false, error: 'Username diperlukan.' });
      }

      const targetUser = String(username).trim().toLowerCase();

      const { error } = await supabase
        .from('app_users')
        .update({ is_blocked: false })
        .eq('username', targetUser);

      if (error) {
        console.error('admin-users unblock error:', error);
        return res.status(500).json({ success: false, error: 'Gagal unblock user: ' + error.message });
      }

      return res.status(200).json({ success: true, message: 'User ' + targetUser + ' berhasil di-unblock.' });
    }

    // === RESET DEVICE BINDING ===
    if (action === 'reset_device') {
      if (!username) {
        return res.status(400).json({ success: false, error: 'Username diperlukan.' });
      }

      const targetUser = String(username).trim().toLowerCase();

      // Cannot reset budi
      if (targetUser === 'budi') {
        return res.status(400).json({ success: false, error: 'Tidak dapat mereset device admin.' });
      }

      // Find user first to get their id
      const { data: user, error: findError } = await supabase
        .from('app_users')
        .select('id')
        .eq('username', targetUser)
        .maybeSingle();

      if (findError) {
        console.error('admin-users reset_device find error:', findError);
        return res.status(500).json({ success: false, error: 'Gagal mencari user.' });
      }

      if (!user) {
        return res.status(400).json({ success: false, error: 'Username tidak ditemukan.' });
      }

      // Set device_id to RESET_PENDING_ + user id
      const resetValue = 'RESET_PENDING_' + user.id;

      const { error: updateError } = await supabase
        .from('app_users')
        .update({ device_id: resetValue })
        .eq('id', user.id);

      if (updateError) {
        console.error('admin-users reset_device update error:', updateError);
        return res.status(500).json({ success: false, error: 'Gagal mereset device: ' + updateError.message });
      }

      return res.status(200).json({ success: true, message: 'Device binding untuk ' + targetUser + ' berhasil direset.' });
    }

    // Unknown action
    return res.status(400).json({ success: false, error: 'Action tidak dikenal: ' + action });

  } catch (e) {
    console.error('admin-users exception:', e);
    return res.status(500).json({ success: false, error: 'Server error: ' + e.message });
  }
};
