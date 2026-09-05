'use strict';

/**
 * Admin Device Approval via Telegram Inline Buttons
 *
 * When admin `budi` tries to login from a new device but the device limit (3/3)
 * is already reached, this module sends an inline keyboard with [Izinkan] / [Tolak]
 * buttons to the admin's Telegram.
 *
 * Tapping [Izinkan]:
 *  - Kicks the oldest device from budi's registered devices (Option C)
 *  - Binds the new device to budi
 *  - Resolves the pending approval request so the waiting browser automatically logs in
 *
 * Tapping [Tolak]:
 *  - Marks the approval request as denied
 *  - The waiting browser displays that the request was rejected
 */

const crypto = require('crypto');
const { createVerifyBot } = require('./telegram-verify-bot');
const { createSessionToken, buildSessionCookie } = require('./admin-session');

const APPROVAL_TTL_MS = 2 * 60 * 1000; // 2 minutes (Q2 decision)
const CALLBACK_APPROVE_PREFIX = 'dev_appr_';
const CALLBACK_DENY_PREFIX = 'dev_deny_';
const MAX_DEVICES = 3;

// In-memory approval store with auto-expiry
const memoryApprovalStore = new Map();

function cleanExpiredRequests() {
  const now = Date.now();
  for (const [token, req] of memoryApprovalStore.entries()) {
    if (req.expiresAt < now) {
      memoryApprovalStore.delete(token);
    }
  }
}

function formatWibTimestamp(date = new Date()) {
  try {
    return new Intl.DateTimeFormat('id-ID', {
      timeZone: 'Asia/Jakarta',
      dateStyle: 'medium',
      timeStyle: 'medium'
    }).format(date) + ' WIB';
  } catch (_) {
    return date.toISOString();
  }
}

function simplifyUserAgent(ua) {
  if (!ua) return 'Perangkat Tidak Dikenal';
  let browser = 'Browser';
  if (ua.includes('Edg/')) browser = 'Microsoft Edge';
  else if (ua.includes('Chrome/')) browser = 'Google Chrome';
  else if (ua.includes('Firefox/')) browser = 'Mozilla Firefox';
  else if (ua.includes('Safari/') && !ua.includes('Chrome/')) browser = 'Apple Safari';

  let os = 'OS';
  if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Android')) os = 'Android';
  else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';
  else if (ua.includes('Mac OS')) os = 'macOS';
  else if (ua.includes('Linux')) os = 'Linux';

  return browser + ' (' + os + ')';
}

/**
 * Creates a device approval challenge and sends Telegram notification with inline buttons.
 */
async function createDeviceApprovalRequest(deps, { userId, username, deviceId, userAgent }) {
  cleanExpiredRequests();

  const supabase = deps && deps.supabase;
  const bot = (deps && deps.bot) || createVerifyBot();

  const token = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  const expiresAt = now + APPROVAL_TTL_MS;

  const approvalData = {
    token,
    userId,
    username: String(username).toLowerCase(),
    deviceId,
    userAgent: userAgent || '',
    status: 'pending', // 'pending' | 'approved' | 'denied' | 'expired'
    createdAt: now,
    expiresAt,
    telegramChatId: null,
    telegramMessageId: null,
    sessionCookie: null
  };

  memoryApprovalStore.set(token, approvalData);

  // Optional persist to database if table exists
  if (supabase) {
    try {
      await supabase.from('admin_device_approvals').insert({
        token,
        user_id: userId,
        username: approvalData.username,
        device_id: deviceId,
        user_agent: userAgent || '',
        status: 'pending',
        expires_at: new Date(expiresAt).toISOString()
      });
    } catch (_) {}
  }

  // Find admin's Telegram chat ID
  let adminChatId = null;
  if (supabase) {
    try {
      const { data } = await supabase
        .from('app_user_telegram_verifications')
        .select('telegram_private_chat_id, telegram_user_id')
        .eq('user_id', userId)
        .maybeSingle();

      if (data && data.telegram_private_chat_id) {
        adminChatId = data.telegram_private_chat_id;
      } else if (data && data.telegram_user_id) {
        adminChatId = data.telegram_user_id;
      }
    } catch (_) {}
  }

  if (!adminChatId && process.env.ADMIN_TELEGRAM_ID) {
    adminChatId = process.env.ADMIN_TELEGRAM_ID;
  }
  if (!adminChatId && process.env.TELEGRAM_ADMIN_CHAT_ID) {
    adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
  }

  if (adminChatId && bot && typeof bot.sendMessage === 'function') {
    const deviceDesc = simplifyUserAgent(userAgent);
    const timeStr = formatWibTimestamp(new Date(now));

    const messageText = [
      '🔐 *Konfirmasi Login Perangkat Baru (Admin)*',
      '',
      '👤 Akun: *' + username + '*',
      '📱 Perangkat: *' + deviceDesc + '*',
      '⏰ Waktu: ' + timeStr,
      '📊 Status Slot: *3/3 (Penuh)*',
      '',
      'Perangkat ini mencoba login tetapi slot sudah penuh.',
      'Jika kamu menekan *Izinkan*, perangkat terlama akan otomatis dikeluarkan dari slot (3/3) dan perangkat baru ini akan langsung masuk.',
      '',
      'Waktu respon: *2 menit*.'
    ].join('\n');

    const replyMarkup = {
      inline_keyboard: [[
        { text: '✅ Izinkan', callback_data: CALLBACK_APPROVE_PREFIX + token },
        { text: '❌ Tolak', callback_data: CALLBACK_DENY_PREFIX + token }
      ]]
    };

    try {
      const sent = await bot.sendMessage(adminChatId, messageText, {
        reply_markup: replyMarkup,
        parse_mode: 'Markdown'
      });
      if (sent && sent.message_id) {
        approvalData.telegramMessageId = sent.message_id;
        approvalData.telegramChatId = adminChatId;
      }
    } catch (err) {
      console.error('Failed to send device approval notification to Telegram:', err && err.message);
    }
  }

  return {
    token,
    expiresAt,
    expiresInSeconds: Math.round(APPROVAL_TTL_MS / 1000)
  };
}

/**
 * Handles Telegram callback query for device approval ([Izinkan] or [Tolak]).
 */
async function handleDeviceApprovalCallback(cq, deps) {
  const data = typeof (cq && cq.data) === 'string' ? cq.data : '';
  const isApprove = data.startsWith(CALLBACK_APPROVE_PREFIX);
  const isDeny = data.startsWith(CALLBACK_DENY_PREFIX);

  if (!isApprove && !isDeny) return null;

  const bot = (deps && deps.bot) || createVerifyBot();
  const supabase = deps && deps.supabase;

  const token = isApprove
    ? data.slice(CALLBACK_APPROVE_PREFIX.length)
    : data.slice(CALLBACK_DENY_PREFIX.length);

  // Acknowledge callback immediately
  try {
    if (bot && typeof bot.answerCallbackQuery === 'function') {
      await bot.answerCallbackQuery(cq.id, {
        text: isApprove ? 'Memproses persetujuan...' : 'Memproses penolakan...'
      });
    }
  } catch (_) {}

  const req = memoryApprovalStore.get(token);

  const chatId = (cq.message && cq.message.chat && cq.message.chat.id) || (cq.from && cq.from.id);
  const messageId = cq.message && cq.message.message_id;

  if (!req) {
    if (messageId && bot && typeof bot.editMessageText === 'function') {
      try {
        await bot.editMessageText(
          chatId,
          messageId,
          '⚠️ Permintaan login perangkat ini sudah kedaluwarsa atau tidak ditemukan.',
          { reply_markup: { inline_keyboard: [] } }
        );
      } catch (_) {}
    }
    return 'device_approval_not_found';
  }

  if (req.expiresAt < Date.now()) {
    req.status = 'expired';
    if (messageId && bot && typeof bot.editMessageText === 'function') {
      try {
        await bot.editMessageText(
          chatId,
          messageId,
          '⌛ Waktu konfirmasi login perangkat telah habis (kedaluwarsa).',
          { reply_markup: { inline_keyboard: [] } }
        );
      } catch (_) {}
    }
    return 'device_approval_expired';
  }

  if (isDeny) {
    req.status = 'denied';
    if (supabase) {
      try {
        await supabase.from('admin_device_approvals').update({ status: 'denied' }).eq('token', token);
      } catch (_) {}
    }
    if (messageId && bot && typeof bot.editMessageText === 'function') {
      try {
        await bot.editMessageText(
          chatId,
          messageId,
          '❌ Permintaan login perangkat baru telah DITOLAK.',
          { reply_markup: { inline_keyboard: [] } }
        );
      } catch (_) {}
    }
    return 'device_approval_denied';
  }

  // --- APPROVE FLOW ---
  // Option C: Kick oldest device, add new device
  if (supabase && req.userId) {
    try {
      const { data: user } = await supabase
        .from('app_users')
        .select('id, username, devices')
        .eq('id', req.userId)
        .maybeSingle();

      if (user) {
        const currentDevices = Array.isArray(user.devices) ? user.devices.slice() : [];
        let updatedDevices = currentDevices.filter(d => d !== req.deviceId);
        while (updatedDevices.length >= MAX_DEVICES) {
          updatedDevices.shift(); // Remove oldest device
        }
        updatedDevices.push(req.deviceId);

        await supabase
          .from('app_users')
          .update({
            devices: updatedDevices,
            device_id: req.deviceId,
            last_login_at: new Date().toISOString(),
            user_agent: req.userAgent || ''
          })
          .eq('id', user.id);
      }
    } catch (err) {
      console.error('Failed to update devices in DB during approval:', err);
    }
  }

  // Generate session token so polling endpoint can immediately set cookie and login
  try {
    const sessionToken = createSessionToken({
      userId: req.userId,
      username: req.username,
      isAdmin: true,
      deviceId: req.deviceId
    });
    if (sessionToken) {
      req.sessionCookie = buildSessionCookie(sessionToken);
      req.sessionToken = sessionToken;
    }
  } catch (_) {}

  req.status = 'approved';

  if (supabase) {
    try {
      await supabase.from('admin_device_approvals').update({ status: 'approved' }).eq('token', token);
    } catch (_) {}
  }

  if (messageId && bot && typeof bot.editMessageText === 'function') {
    try {
      await bot.editMessageText(
        chatId,
        messageId,
        '✅ Perangkat baru BERHASIL DIIZINKAN.\n\nPerangkat terlama telah dikeluarkan dari slot (3/3). Halaman login admin yang menunggu otomatis masuk.',
        { reply_markup: { inline_keyboard: [] } }
      );
    } catch (_) {}
  }

  return 'device_approval_approved';
}

/**
 * Checks approval status for browser polling.
 * If approved, attaches Set-Cookie header to res and returns success.
 */
function checkDeviceApprovalStatus(token, res) {
  if (!token) {
    return { ok: false, status: 'invalid_token', error: 'Token tidak valid.' };
  }

  const req = memoryApprovalStore.get(token);
  if (!req) {
    return { ok: false, status: 'expired', error: 'Permintaan tidak ditemukan atau sudah kedaluwarsa.' };
  }

  if (req.expiresAt < Date.now()) {
    req.status = 'expired';
    return { ok: false, status: 'expired', error: 'Waktu konfirmasi telah habis.' };
  }

  if (req.status === 'denied') {
    return { ok: false, status: 'denied', error: 'Permintaan login ditolak dari Telegram.' };
  }

  if (req.status === 'approved') {
    if (res && req.sessionCookie) {
      res.setHeader('Set-Cookie', req.sessionCookie);
    }
    return {
      ok: true,
      success: true,
      status: 'approved',
      username: req.username,
      userId: req.userId,
      isAdmin: true,
      deviceId: req.deviceId
    };
  }

  return { ok: true, status: 'pending' };
}

function clearMemoryStoreForTesting() {
  memoryApprovalStore.clear();
}

module.exports = {
  APPROVAL_TTL_MS,
  CALLBACK_APPROVE_PREFIX,
  CALLBACK_DENY_PREFIX,
  createDeviceApprovalRequest,
  handleDeviceApprovalCallback,
  checkDeviceApprovalStatus,
  clearMemoryStoreForTesting,
  simplifyUserAgent,
  formatWibTimestamp
};
