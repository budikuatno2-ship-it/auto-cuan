const { createClient } = require('@supabase/supabase-js');

/**
 * POST /api/admin-approve-user
 * Admin-only endpoint to approve or revoke user approval.
 * Actions: list, approve, revoke
 */
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

    // === LIST USERS FOR APPROVAL ===
    if (action === 'list') {
      const { data, error } = await supabase
        .from('app_users')
        .select('id, username, is_approved, is_blocked, created_at, last_login_at, updated_at')
        .neq('username', 'budi')
        .order('created_at', { ascending: false })
        .limit(200);

      if (error) {
        console.error('admin-approve-user list error:', error);
        return res.status(500).json({ success: false, error: 'Gagal memuat daftar user: ' + error.message });
      }

      return res.status(200).json({ success: true, users: data || [] });
    }

    // === APPROVE USER ===
    if (action === 'approve') {
      if (!username) {
        return res.status(400).json({ success: false, error: 'Username diperlukan.' });
      }

      const targetUser = String(username).trim().toLowerCase();

      if (targetUser === 'budi') {
        return res.status(400).json({ success: false, error: 'Admin tidak perlu di-approve.' });
      }

      const { error } = await supabase
        .from('app_users')
        .update({ is_approved: true, updated_at: new Date().toISOString() })
        .eq('username', targetUser);

      if (error) {
        console.error('admin-approve-user approve error:', error);
        return res.status(500).json({ success: false, error: 'Gagal approve user: ' + error.message });
      }

      return res.status(200).json({ success: true, message: 'User ' + targetUser + ' berhasil di-approve.' });
    }

    // === REVOKE APPROVAL ===
    if (action === 'revoke') {
      if (!username) {
        return res.status(400).json({ success: false, error: 'Username diperlukan.' });
      }

      const targetUser = String(username).trim().toLowerCase();

      if (targetUser === 'budi') {
        return res.status(400).json({ success: false, error: 'Tidak dapat mencabut approval admin.' });
      }

      const { error } = await supabase
        .from('app_users')
        .update({ is_approved: false, updated_at: new Date().toISOString() })
        .eq('username', targetUser);

      if (error) {
        console.error('admin-approve-user revoke error:', error);
        return res.status(500).json({ success: false, error: 'Gagal mencabut approval: ' + error.message });
      }

      return res.status(200).json({ success: true, message: 'Approval user ' + targetUser + ' berhasil dicabut.' });
    }

    return res.status(400).json({ success: false, error: 'Action tidak dikenal: ' + action });

  } catch (e) {
    console.error('admin-approve-user exception:', e);
    return res.status(500).json({ success: false, error: 'Server error: ' + e.message });
  }
};
