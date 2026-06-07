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

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    // === LIST USERS ===
    if (action === 'list') {
      const { data, error } = await supabase
        .from('app_users')
        .select('id, username, device_id, devices, user_agent, is_blocked, is_approved, created_at, last_login_at')
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

    // === RESET PASSWORD ===
    if (action === 'reset_password') {
      const { newPasswordHash } = req.body || {};

      if (!username) {
        return res.status(400).json({ success: false, error: 'Username diperlukan.' });
      }

      if (!newPasswordHash) {
        return res.status(400).json({ success: false, error: 'Password hash diperlukan.' });
      }

      const targetUser = String(username).trim().toLowerCase();

      // Cannot reset budi password
      if (targetUser === 'budi') {
        return res.status(400).json({ success: false, error: 'Tidak dapat mereset password admin.' });
      }

      // Find user
      const { data: user, error: findError } = await supabase
        .from('app_users')
        .select('id')
        .eq('username', targetUser)
        .maybeSingle();

      if (findError) {
        console.error('admin-users reset_password find error:', findError);
        return res.status(500).json({ success: false, error: 'Gagal mencari user.' });
      }

      if (!user) {
        return res.status(400).json({ success: false, error: 'Username tidak ditemukan.' });
      }

      // Update password_hash
      const { error: updateError } = await supabase
        .from('app_users')
        .update({ password_hash: newPasswordHash })
        .eq('id', user.id);

      if (updateError) {
        console.error('admin-users reset_password update error:', updateError);
        return res.status(500).json({ success: false, error: 'Gagal mereset password: ' + updateError.message });
      }

      return res.status(200).json({ success: true, message: 'Password user ' + targetUser + ' berhasil direset.' });
    }

    // === RESET DEVICES ===
    if (action === 'reset_devices') {
      if (!username) {
        return res.status(400).json({ success: false, error: 'Username diperlukan.' });
      }

      const targetUser = String(username).trim().toLowerCase();

      // Cannot reset budi devices
      if (targetUser === 'budi') {
        return res.status(400).json({ success: false, error: 'Tidak dapat reset perangkat admin.' });
      }

      // Only update devices to empty array — do NOT touch is_approved, is_blocked, or password
      const { error } = await supabase
        .from('app_users')
        .update({ devices: [] })
        .eq('username', targetUser);

      if (error) {
        console.error('admin-users reset_devices error:', error);
        return res.status(500).json({ success: false, error: 'Gagal reset perangkat: ' + error.message });
      }

      return res.status(200).json({ success: true, message: 'Perangkat user ' + targetUser + ' berhasil di-reset. User dapat login dari perangkat baru.' });
    }

    // === APPROVE USER ===
    if (action === 'approve') {
      if (!username) {
        return res.status(400).json({ success: false, error: 'Username diperlukan.' });
      }

      const targetUser = String(username).trim().toLowerCase();

      const { error } = await supabase
        .from('app_users')
        .update({ is_approved: true })
        .eq('username', targetUser);

      if (error) {
        console.error('admin-users approve error:', error);
        return res.status(500).json({ success: false, error: 'Gagal approve user: ' + error.message });
      }

      return res.status(200).json({ success: true, message: 'User ' + targetUser + ' berhasil di-approve.' });
    }

    // === REJECT USER (set is_approved to false) ===
    if (action === 'reject') {
      if (!username) {
        return res.status(400).json({ success: false, error: 'Username diperlukan.' });
      }

      const targetUser = String(username).trim().toLowerCase();

      // Cannot reject budi
      if (targetUser === 'budi') {
        return res.status(400).json({ success: false, error: 'Tidak dapat reject admin.' });
      }

      const { error } = await supabase
        .from('app_users')
        .update({ is_approved: false })
        .eq('username', targetUser);

      if (error) {
        console.error('admin-users reject error:', error);
        return res.status(500).json({ success: false, error: 'Gagal reject user: ' + error.message });
      }

      return res.status(200).json({ success: true, message: 'User ' + targetUser + ' berhasil di-reject.' });
    }

    // Unknown action
    return res.status(400).json({ success: false, error: 'Action tidak dikenal: ' + action });

  } catch (e) {
    console.error('admin-users exception:', e);
    return res.status(500).json({ success: false, error: 'Server error: ' + e.message });
  }
};
