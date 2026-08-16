'use strict';

const COMMAND_RE = /^\/(?:akun|help)(?:@[\w_]+)?\s*$/i;

function privateMessage(update) {
  const message = update && update.message;
  const from = message && message.from;
  const chat = message && message.chat;
  if (!message || !from || !chat || chat.type !== 'private') return null;
  if (!Number.isSafeInteger(from.id) || !Number.isSafeInteger(chat.id) || from.id !== chat.id) return null;
  if (typeof message.text !== 'string' || !COMMAND_RE.test(message.text.trim())) return null;
  return { message, from, chat };
}

function matchesUpdate(update) {
  return privateMessage(update) !== null;
}

async function safeDelete(bot, chatId, messageId) {
  if (!bot || typeof bot.deleteMessage !== 'function') return false;
  if (!Number.isSafeInteger(Number(chatId)) || !Number.isSafeInteger(Number(messageId))) return false;
  try {
    await bot.deleteMessage(Number(chatId), Number(messageId));
    return true;
  } catch (_) {
    return false;
  }
}

async function sendPlain(bot, chatId, text) {
  if (!bot || typeof bot.sendMessage !== 'function') return null;
  try {
    return await bot.sendMessage(chatId, text);
  } catch (_) {
    return null;
  }
}

async function optionalSingle(query) {
  try {
    const result = await query.maybeSingle();
    if (!result || result.error) return null;
    return result.data || null;
  } catch (_) {
    return null;
  }
}

async function verificationBinding(db, telegramUserId) {
  const row = await optionalSingle(
    db.from('app_user_telegram_verifications')
      .select('user_id, telegram_verified_at, channel_joined_at')
      .eq('telegram_user_id', telegramUserId)
  );
  if (!row || !row.user_id || !row.telegram_verified_at) return null;
  return {
    userId: String(row.user_id),
    telegramVerified: true,
    channelJoined: Boolean(row.channel_joined_at)
  };
}

async function subscriptionBinding(db, telegramUserId) {
  const row = await optionalSingle(
    db.from('telegram_subscription_links')
      .select('user_id')
      .eq('telegram_user_id', telegramUserId)
      .eq('link_state', 'linked')
  );
  if (!row || !row.user_id) return null;
  return {
    userId: String(row.user_id),
    telegramVerified: false,
    channelJoined: false
  };
}

async function resolveBinding(db, telegramUserId) {
  const verified = await verificationBinding(db, telegramUserId);
  if (verified) return verified;
  return subscriptionBinding(db, telegramUserId);
}

function formatWib(value) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    return date.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB';
  } catch (_) {
    return date.toISOString();
  }
}

async function currentEntitlement(db, userId) {
  try {
    const result = await db.from('user_entitlements')
      .select('plan_code, source, status, starts_at, expires_at, lifetime')
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('starts_at', { ascending: false });
    if (!result || result.error || !Array.isArray(result.data)) return null;
    const now = Date.now();
    const active = result.data.filter(function (row) {
      const starts = row.starts_at ? Date.parse(row.starts_at) : -Infinity;
      const expires = row.expires_at ? Date.parse(row.expires_at) : Infinity;
      return starts <= now && now < expires;
    });
    const lifetime = active.find(function (row) { return row.lifetime === true; });
    if (lifetime) return lifetime;
    return active.sort(function (a, b) {
      return Date.parse(b.expires_at || '9999-12-31') - Date.parse(a.expires_at || '9999-12-31');
    })[0] || null;
  } catch (_) {
    return null;
  }
}

function entitlementLabel(row) {
  if (!row) return { name: 'Belum aktif', expiry: null };
  const name = row.plan_code || (row.source === 'trial' ? 'TRIAL 10 HARI' : 'Premium');
  const expiry = row.lifetime === true ? 'Lifetime' : formatWib(row.expires_at);
  return { name: String(name), expiry: expiry || '—' };
}

async function accountMessage(db, telegramUserId) {
  if (!db || typeof db.from !== 'function') return 'Informasi akun sementara belum tersedia.';
  const binding = await resolveBinding(db, telegramUserId);
  if (!binding) {
    return [
      '👤 Akun Auto-Cuan',
      '',
      'Telegram ini belum terhubung ke akun Auto-Cuan.',
      'Untuk verifikasi akun, gunakan /start lalu kirim kode verifikasi dari website.'
    ].join('\n');
  }

  const account = await optionalSingle(
    db.from('app_users')
      .select('username, is_approved, is_blocked, created_at')
      .eq('id', binding.userId)
  );
  if (!account || account.is_blocked === true) return 'Informasi akun sementara tidak tersedia.';

  const entitlement = entitlementLabel(await currentEntitlement(db, binding.userId));
  const lines = [
    '👤 Akun Auto-Cuan',
    '',
    'Username: ' + String(account.username || '—'),
    'Status akun: ' + (account.is_approved === true ? 'Disetujui ✅' : 'Menunggu persetujuan ⏳'),
    'Telegram: ' + (binding.telegramVerified ? 'Terverifikasi ✅' : 'Terhubung ✅'),
    'Akses channel: ' + (binding.channelJoined ? 'Aktif ✅' : (binding.telegramVerified ? 'Belum aktif' : 'Belum terverifikasi')),
    'Subscription: ' + entitlement.name
  ];
  if (entitlement.expiry) lines.push('Berlaku sampai: ' + entitlement.expiry);
  const created = formatWib(account.created_at);
  if (created) lines.push('Akun dibuat: ' + created);
  return lines.join('\n');
}

function helpMessage() {
  return [
    '🤖 AutoCuan Verification',
    '',
    'Verifikasi akun',
    '/start — Mulai atau lanjutkan verifikasi akun.',
    'Kirim kode verifikasi dari website langsung ke chat ini.',
    '',
    'Akun',
    '/akun — Lihat status akun, Telegram, channel, dan subscription.',
    '',
    'Langganan',
    '/langganan — Lihat paket dan harga.',
    '/status — Cek status subscription.',
    '/trial — Aktifkan trial 10 hari jika memenuhi syarat.',
    '/voucher KODE — Gunakan kode voucher.',
    '/beli — Lihat pilihan paket dan cara berlangganan.',
    '',
    'Reset password dimulai dari website. Bot akan mengirim konfirmasi jika akun sudah terhubung.',
    '⭐ Penilaian 1–5 dikirim otomatis setelah 30 hari; tidak perlu command khusus.'
  ].join('\n');
}

async function handleUpdate(update, options) {
  const input = privateMessage(update);
  if (!input) return { handled: false, outcome: 'not_general_command' };
  const bot = options && options.bot;
  const db = options && options.db;
  if (!bot) return { handled: false, outcome: 'general_command_unavailable' };

  const command = input.message.text.trim().split('@')[0].toLowerCase();
  if (command === '/help') {
    await sendPlain(bot, input.chat.id, helpMessage());
    await safeDelete(bot, input.chat.id, input.message.message_id);
    return { handled: true, outcome: 'help' };
  }

  await sendPlain(bot, input.chat.id, await accountMessage(db, input.from.id));
  await safeDelete(bot, input.chat.id, input.message.message_id);
  return { handled: true, outcome: 'account_info' };
}

module.exports = {
  matchesUpdate,
  handleUpdate,
  __test: {
    COMMAND_RE,
    privateMessage,
    resolveBinding,
    currentEntitlement,
    accountMessage,
    helpMessage,
    entitlementLabel,
    formatWib
  }
};
