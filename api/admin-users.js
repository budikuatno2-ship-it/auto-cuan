const { createClient } = require('@supabase/supabase-js');
const { requireAdminSession, isSameOrigin } = require('../lib/admin-session');
const telegramNotifier = require('../lib/telegram-notifier');
const telegramVerification = require('../lib/telegram-verification');
const { createVerifyBot } = require('../lib/telegram-verify-bot');
const { generateApprovalCode, maskUsername } = require('../lib/free-user-approval');

const CANONICAL_LOGIN_URL = 'https://autocuan.web.id';

const RESERVED_USERNAMES = { budi: true, review: true };

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

      const users = data || [];

      // Merge Telegram verification status (best-effort). We read the whole
      // verification set and join in memory (no `.in()` needed) so this degrades
      // gracefully when the table is empty or unavailable.
      let verifications = [];
      try {
        const vres = await supabase
          .from('app_user_telegram_verifications')
          .select('user_id, telegram_user_id, telegram_verified_at, telegram_private_chat_id, channel_joined_at')
          .limit(1000);
        if (vres && !vres.error && Array.isArray(vres.data)) verifications = vres.data;
      } catch (e) { /* verification status is optional for the list */ }

      const byUserId = {};
      verifications.forEach(function (v) { if (v && v.user_id != null) byUserId[String(v.user_id)] = v; });

      const enriched = users.map(function (u) {
        const v = byUserId[String(u.id)] || null;
        const verified = !!(v && v.telegram_verified_at);
        const joined = !!(v && v.channel_joined_at);
        let telegramStatus = 'unverified';
        if (joined) telegramStatus = 'joined';
        else if (verified) telegramStatus = 'verified';
        return Object.assign({}, u, {
          telegram_verified_at: v ? v.telegram_verified_at : null,
          telegram_user_id: v ? v.telegram_user_id : null,
          telegram_private_chat_id: v ? v.telegram_private_chat_id : null,
          channel_joined_at: v ? v.channel_joined_at : null,
          telegram_status: telegramStatus
        });
      });

      return res.status(200).json({ success: true, users: enriched });
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

    // === APPROVE USER (approval-gated) ===
    // A pending account may be approved ONLY when its Telegram identity is bound
    // and verified, a private chat is known, it is not blocked, and it is not a
    // reserved account. Existing already-approved accounts (including budi) are
    // left untouched. On a genuine false->true transition we create + deliver a
    // dynamic single-use channel invite; a delivery failure NEVER rolls back the
    // approval (it is persisted as retryable and surfaced as a warning).
    if (action === 'approve') {
      if (!username) {
        return res.status(400).json({ success: false, error: 'Username diperlukan.' });
      }

      const targetUser = String(username).trim().toLowerCase();

      // Load the account and its verification snapshot to gate the approval.
      const { data: acct, error: acctErr } = await supabase
        .from('app_users')
        .select('id, username, is_blocked, is_approved')
        .eq('username', targetUser)
        .maybeSingle();

      if (acctErr) {
        console.error('admin-users approve lookup error:', acctErr);
        return res.status(500).json({ success: false, error: 'Gagal approve user.' });
      }
      if (!acct) {
        return res.status(400).json({ success: false, error: 'Username tidak ditemukan.' });
      }

      // Already approved -> idempotent no-op. Existing approved accounts (including
      // budi/review) are left completely untouched: no transition, no notification.
      if (acct.is_approved !== false) {
        return res.status(200).json({
          success: true,
          approval_transitioned: false,
          message: 'Tidak ada perubahan status approval.',
          approval_notification: { status: 'skipped', reason: 'no_approval_transition' }
        });
      }
      // A still-pending reserved account never enters the approval gate.
      if (RESERVED_USERNAMES[targetUser]) {
        return res.status(400).json({ success: false, error: 'Akun ini tidak melewati alur approval.' });
      }
      if (acct.is_blocked === true) {
        return res.status(400).json({ success: false, error: 'Akun sedang diblokir dan tidak bisa di-approve.' });
      }

      let verification = null;
      try {
        const vres = await supabase
          .from('app_user_telegram_verifications')
          .select('user_id, telegram_user_id, telegram_verified_at, telegram_private_chat_id')
          .eq('user_id', acct.id)
          .maybeSingle();
        if (vres && !vres.error) verification = vres.data;
      } catch (e) { verification = null; }

      const isVerified = !!(verification && verification.telegram_verified_at &&
        verification.telegram_user_id != null && verification.telegram_private_chat_id != null);
      if (!isVerified) {
        return res.status(400).json({
          success: false,
          approval_transitioned: false,
          eligibility: 'not_verified',
          error: 'User belum memverifikasi Telegram. Approve hanya untuk akun yang sudah Terverifikasi.'
        });
      }

      // The status predicate makes the update itself the idempotency gate. Only
      // the request that actually changes false -> true receives a row back and
      // is allowed to notify / deliver the invite.
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

      // Legacy approval announcement (dedicated approval chat; unchanged).
      const approvalNotification = await sendApprovalNotification(transitionedUser);

      // Stage 3: create + deliver the dynamic single-use channel invite. Fully
      // guarded — the account stays approved even if delivery fails.
      let inviteDelivery = { status: 'skipped' };
      try {
        inviteDelivery = await telegramVerification.deliverApprovalInvite(
          { supabase: supabase, bot: createVerifyBot() },
          transitionedUser.id
        );
      } catch (e) {
        inviteDelivery = { status: 'error', warning: 'invite_delivery_exception' };
      }

      const inviteOk = inviteDelivery && inviteDelivery.status === 'sent';
      const response = {
        success: true,
        approval_transitioned: true,
        message: 'User ' + targetUser + ' berhasil di-approve.',
        approval_notification: approvalNotification,
        invite_delivery: { status: inviteDelivery ? inviteDelivery.status : 'unknown' }
      };
      if (!inviteOk) {
        response.warning = 'Akun sudah di-approve, tetapi pengiriman link channel belum berhasil. Gunakan "Kirim Ulang Invite" untuk mencoba lagi.';
        response.invite_delivery.retryable = true;
      }
      return res.status(200).json(response);
    }

    // === RETRY INVITE DELIVERY ===
    // Safe retry for an approved+verified account whose invite delivery failed.
    if (action === 'retry_invite') {
      if (!username) {
        return res.status(400).json({ success: false, error: 'Username diperlukan.' });
      }
      const targetUser = String(username).trim().toLowerCase();
      if (RESERVED_USERNAMES[targetUser]) {
        return res.status(400).json({ success: false, error: 'Akun ini tidak memiliki alur invite.' });
      }

      const { data: acct, error: acctErr } = await supabase
        .from('app_users')
        .select('id, username, is_approved, is_blocked')
        .eq('username', targetUser)
        .maybeSingle();
      if (acctErr) {
        console.error('admin-users retry_invite lookup error:', acctErr);
        return res.status(500).json({ success: false, error: 'Gagal mengirim ulang invite.' });
      }
      if (!acct) {
        return res.status(400).json({ success: false, error: 'Username tidak ditemukan.' });
      }
      if (acct.is_approved !== true || acct.is_blocked === true) {
        return res.status(400).json({ success: false, error: 'Invite hanya bisa dikirim untuk akun yang sudah disetujui dan tidak diblokir.' });
      }

      let inviteDelivery = { status: 'skipped' };
      try {
        inviteDelivery = await telegramVerification.deliverApprovalInvite(
          { supabase: supabase, bot: createVerifyBot() },
          acct.id
        );
      } catch (e) {
        inviteDelivery = { status: 'error', warning: 'invite_delivery_exception' };
      }

      const inviteOk = inviteDelivery && inviteDelivery.status === 'sent';
      return res.status(200).json({
        success: true,
        invite_delivery: { status: inviteDelivery ? inviteDelivery.status : 'unknown', retryable: !inviteOk },
        message: inviteOk ? 'Link channel berhasil dikirim ulang.' : 'Pengiriman link channel belum berhasil. Coba lagi nanti.'
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
