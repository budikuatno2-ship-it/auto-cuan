const { createClient } = require('@supabase/supabase-js');
const { requireAdminSession, isSameOrigin } = require('../lib/admin-session');
const telegramNotifier = require('../lib/telegram-notifier');
const { generateApprovalCode, maskUsername } = require('../lib/free-user-approval');

const CANONICAL_LOGIN_URL = 'https://autocuan.web.id';

function buildApprovalNotificationMessage(user) {
  return [
    '✅ AKUN DISETUJUI',
    '',
    'Username: ' + maskUsername(user && user.username),
    'Kode: ' + generateApprovalCode(user),
    'Status: Aktif',
    '',
    'Silakan login:',
    CANONICAL_LOGIN_URL
  ].join('\n');
}

async function sendApprovalNotification(user) {
  if (process.env.TELEGRAM_APPROVAL_NOTIFICATIONS_ENABLED !== '1') {
    return { status: 'skipped', reason: 'approval_notifications_disabled' };
  }

  // Approval announcements MUST target a dedicated approval chat and must never
  // fall back to the operational recommendation/monitor chat (TELEGRAM_CHAT_ID).
  // If the dedicated chat is not configured, skip WITHOUT calling the notifier so
  // the notifier's own TELEGRAM_CHAT_ID fallback can never be reached.
  var approvalChatId = process.env.TELEGRAM_APPROVAL_CHAT_ID;
  if (!approvalChatId || String(approvalChatId).trim() === '') {
    return { status: 'skipped', reason: 'missing_approval_chat_id' };
  }

  try {
    var result = await telegramNotifier.sendTelegramMessage(
      buildApprovalNotificationMessage(user),
      { chat_id: String(approvalChatId).trim() }
    );
    if (result && result.sent === true) {
      return { status: 'sent' };
    }
    if (result && result.skipped === true) {
      return { status: 'skipped', reason: 'telegram_disabled_or_misconfigured' };
    }
    return { status: 'failed' };
  } catch (e) {
    console.error('admin-users approval notification failed');
    return { status: 'failed' };
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    // Authorization is derived from the server-signed session ONLY. Any `adminName`
    // supplied in the request body is intentionally ignored.
    if (!isSameOrigin(req)) {
      return res.status(403).json({ success: false, error: 'Permintaan ditolak.' });
    }
    const auth = requireAdminSession(req);
    if (!auth.ok) {
      return res.status(auth.status).json({ success: false, error: auth.error });
    }

    const { action, username } = req.body || {};

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

      // The status predicate makes the update itself the idempotency gate. Only
      // the request that actually changes false -> true receives a row back and
      // is allowed to notify Telegram.
      const { data: transitionedUser, error } = await supabase
        .from('app_users')
        .update({ is_approved: true })
        .eq('username', targetUser)
        .eq('is_approved', false)
        .select('id, username, created_at')
        .maybeSingle();

      if (error) {
        console.error('admin-users approve error:', error);
        return res.status(500).json({ success: false, error: 'Gagal approve user: ' + error.message });
      }

      if (!transitionedUser) {
        return res.status(200).json({
          success: true,
          approval_transitioned: false,
          message: 'Tidak ada perubahan status approval.',
          approval_notification: { status: 'skipped', reason: 'no_approval_transition' }
        });
      }

      const approvalNotification = await sendApprovalNotification(transitionedUser);
      return res.status(200).json({
        success: true,
        approval_transitioned: true,
        message: 'User ' + targetUser + ' berhasil di-approve.',
        approval_notification: approvalNotification
      });
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
