'use strict';

const crypto = require('crypto');
const identity = require('./subscription-identity');
const vouchers = require('./vouchers');
const voucherAdminBot = require('./voucher-admin-bot');
const { createVoucherAdminSender } = require('./voucher-admin-sender');
const {
  isSubscriptionFeatureEnabled,
  isVoucherAdminBotEnabled,
  getVoucherAdminCapability
} = require('./subscription-capability');

const SUB_START_RE = /^\/start(?:@[\w_]+)?\s+(sub_[A-Za-z0-9_-]{20,180})$/i;
const USER_COMMAND_RE = /^\/(?:langganan|subscription|beli|status|trial|voucher)(?:@[\w_]+)?(?:\s+(.+))?\s*$/i;
const ADMIN_COMMAND_RE = /^\/(?:voucheradmin|buatvoucher|daftarvoucher|detailvoucher|nonaktifkanvoucher|auditvoucher|statistiklifetime|batal)(?:@[\w_]+)?(?:\s+([A-Za-z0-9-]+))?\s*$/i;
const ADMIN_CALLBACK_RE = /^v:/;

function privateMessage(update) {
  const q = update && update.callback_query;
  const message = update && (update.message || (q && q.message));
  const from = (q && q.from) || (message && message.from);
  const chat = message && message.chat;
  if (!message || !from || !chat || chat.type !== 'private') return null;
  if (!Number.isSafeInteger(from.id) || !Number.isSafeInteger(chat.id) || chat.id !== from.id) return null;
  return { q: q || null, message, from, chat };
}

function classifyUpdate(update) {
  const input = privateMessage(update);
  if (!input) return { kind: 'none', input: null };
  const callbackData = input.q && input.q.data;
  if (typeof callbackData === 'string' && ADMIN_CALLBACK_RE.test(callbackData)) {
    return { kind: 'voucher_admin', input };
  }
  const text = typeof input.message.text === 'string' ? input.message.text.trim() : '';
  if (SUB_START_RE.test(text)) return { kind: 'subscription_link', input };
  if (ADMIN_COMMAND_RE.test(text)) return { kind: 'voucher_admin', input };
  if (USER_COMMAND_RE.test(text)) return { kind: 'subscription_user', input };
  return { kind: 'none', input };
}

function deterministicUuid(updateId, namespace) {
  const hex = crypto.createHash('sha256')
    .update(String(namespace || 'subscription') + ':' + String(updateId), 'utf8')
    .digest('hex')
    .slice(0, 32);
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20, 32);
}

async function safeDelete(bot, chatId, messageId) {
  if (!bot || typeof bot.deleteMessage !== 'function' || !Number.isSafeInteger(Number(chatId)) || !Number.isSafeInteger(Number(messageId))) return false;
  try {
    await bot.deleteMessage(Number(chatId), Number(messageId));
    return true;
  } catch (_) {
    return false;
  }
}

async function cleanupOrigin(bot, input) {
  if (!input) return false;
  return safeDelete(bot, input.chat.id, input.message.message_id);
}

async function linkedUser(db, telegramUserId) {
  const result = await db.from('telegram_subscription_links')
    .select('user_id')
    .eq('telegram_user_id', telegramUserId)
    .eq('link_state', 'linked')
    .maybeSingle();
  if (!result || result.error || !result.data) return null;
  return String(result.data.user_id || '') || null;
}

async function sendPlain(bot, chatId, text) {
  if (!bot || typeof bot.sendMessage !== 'function') return null;
  try { return await bot.sendMessage(chatId, text); } catch (_) { return null; }
}

async function handleLink(update, db, bot, input) {
  const match = SUB_START_RE.exec(String(input.message.text || '').trim());
  if (!match) return { handled: false, outcome: 'not_subscription_link' };
  let tokenHash;
  try { tokenHash = identity.linkTokenHash(match[1]); } catch (_) {
    await sendPlain(bot, input.chat.id, 'Tautan subscription tidak valid atau sudah tidak tersedia.');
    await cleanupOrigin(bot, input);
    return { handled: true, outcome: 'subscription_link_invalid' };
  }
  const result = await db.rpc('consume_subscription_telegram_link', {
    p_token_hash: tokenHash,
    p_telegram_user_id: input.from.id,
    p_chat_id: input.chat.id,
    p_update_id: update.update_id
  });
  const code = result && !result.error ? String(result.data || '') : 'rejected';
  if (code === 'linked' || code === 'duplicate') {
    await sendPlain(bot, input.chat.id, '✅ Telegram berhasil terhubung ke akun Auto-Cuan.\n\nKetik /langganan untuk melihat status dan paket.');
    await cleanupOrigin(bot, input);
    return { handled: true, outcome: 'subscription_linked' };
  }
  await sendPlain(bot, input.chat.id, 'Tautan subscription sudah tidak berlaku. Buat tautan baru dari Profil → Subscription di website.');
  await cleanupOrigin(bot, input);
  return { handled: true, outcome: 'subscription_link_rejected' };
}

async function activeCatalog(db) {
  const result = await db.from('subscription_plans')
    .select('code, display_name, kind, duration_months, subscription_plan_prices!inner(normal_price_idr, promo_price_idr, promo_enabled, promo_starts_at, promo_ends_at, active)')
    .eq('active', true)
    .eq('subscription_plan_prices.active', true)
    .order('sort_order');
  if (!result || result.error) return [];
  const now = Date.now();
  return (result.data || []).map(function (plan) {
    const raw = Array.isArray(plan.subscription_plan_prices) ? plan.subscription_plan_prices[0] : plan.subscription_plan_prices;
    const promo = Boolean(raw && raw.promo_enabled && raw.promo_price_idr != null && raw.promo_starts_at && Date.parse(raw.promo_starts_at) <= now && (!raw.promo_ends_at || now < Date.parse(raw.promo_ends_at)));
    return {
      code: plan.code,
      name: plan.display_name,
      price: promo ? Number(raw.promo_price_idr) : Number(raw.normal_price_idr),
      normal: Number(raw.normal_price_idr),
      promo
    };
  });
}

function rupiah(value) {
  const n = Number(value);
  return Number.isFinite(n) ? 'Rp ' + Math.round(n).toLocaleString('id-ID') : '—';
}

async function statusMessage(db, telegramUserId) {
  const userId = await linkedUser(db, telegramUserId);
  if (!userId) return 'Telegram ini belum terhubung ke akun Auto-Cuan. Hubungkan dari Profil → Subscription di website.';
  const accountResult = await db.from('app_users').select('username,is_blocked,is_approved').eq('id', userId).maybeSingle();
  if (!accountResult || accountResult.error || !accountResult.data || accountResult.data.is_blocked) return 'Status akun tidak tersedia.';
  const rows = await db.from('user_entitlements')
    .select('plan_code,source,status,starts_at,expires_at,lifetime')
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('starts_at', { ascending: false });
  const now = Date.now();
  const active = (rows.data || []).filter(function (row) {
    const starts = Date.parse(row.starts_at || 0);
    const expires = row.expires_at ? Date.parse(row.expires_at) : Infinity;
    return starts <= now && now < expires;
  });
  const lifetime = active.find(function (row) { return row.lifetime === true; });
  const best = lifetime || active.sort(function (a, b) {
    return Date.parse(b.expires_at || 0) - Date.parse(a.expires_at || 0);
  })[0];
  if (!best) return 'Akun: ' + accountResult.data.username + '\nSubscription: belum aktif.\n\nKetik /langganan untuk melihat paket.';
  const expiry = best.lifetime ? 'Lifetime' : new Date(best.expires_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB';
  return '✅ Subscription aktif\nAkun: ' + accountResult.data.username + '\nPaket: ' + (best.plan_code || (best.source === 'trial' ? 'TRIAL 10 HARI' : 'Premium')) + '\nBerlaku sampai: ' + expiry;
}

async function catalogMessage(db) {
  const plans = await activeCatalog(db);
  if (!plans.length) return 'Katalog subscription sedang tidak tersedia.';
  const lines = plans.map(function (plan) {
    const price = plan.promo && plan.normal !== plan.price
      ? rupiah(plan.price) + ' (normal ' + rupiah(plan.normal) + ')'
      : rupiah(plan.price);
    return '• ' + plan.name + ' — ' + price;
  });
  return [
    '💎 Auto-Cuan Subscription',
    '',
    ...lines,
    '',
    'Aktivasi trial: /trial',
    'Cek status: /status',
    'Pakai voucher: /voucher KODE',
    '',
    'Pembelian paket berbayar dilakukan dari Profil → Subscription di autocuan.web.id. Bot yang sama akan dipakai untuk verifikasi subscription.'
  ].join('\n');
}

async function handleTrial(update, db, bot, input) {
  const userId = await linkedUser(db, input.from.id);
  if (!userId) {
    await sendPlain(bot, input.chat.id, 'Hubungkan Telegram ke akun Auto-Cuan dulu dari Profil → Subscription di website.');
    await cleanupOrigin(bot, input);
    return { handled: true, outcome: 'trial_not_linked' };
  }
  const result = await db.rpc('activate_subscription_trial', {
    p_user_id: userId,
    p_activation_idempotency_key: deterministicUuid(update.update_id, 'trial'),
    p_activation_time: new Date().toISOString()
  });
  if (!result || result.error || !result.data || result.data.active !== true) {
    await sendPlain(bot, input.chat.id, 'Trial tidak dapat diaktifkan. Trial mungkin sudah pernah digunakan atau akun belum memenuhi syarat.');
    await cleanupOrigin(bot, input);
    return { handled: true, outcome: 'trial_rejected' };
  }
  const expiry = result.data.expires_at ? new Date(result.data.expires_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB' : '—';
  await sendPlain(bot, input.chat.id, '✅ Trial Auto-Cuan aktif selama 10 hari.\nBerlaku sampai: ' + expiry);
  await cleanupOrigin(bot, input);
  return { handled: true, outcome: 'trial_activated' };
}

async function handleVoucher(update, db, bot, input, rawCode) {
  const userId = await linkedUser(db, input.from.id);
  if (!userId) {
    await sendPlain(bot, input.chat.id, 'Hubungkan Telegram ke akun Auto-Cuan dulu sebelum memakai voucher.');
    await cleanupOrigin(bot, input);
    return { handled: true, outcome: 'voucher_not_linked' };
  }
  let hash;
  try { hash = vouchers.voucherCodeHash(rawCode); } catch (_) {
    await sendPlain(bot, input.chat.id, 'Voucher tidak valid. Format contoh: /voucher AC-XXXXXXXXXXXX');
    await cleanupOrigin(bot, input);
    return { handled: true, outcome: 'voucher_invalid' };
  }
  const quote = await db.rpc('quote_subscription_voucher', {
    p_user_id: userId,
    p_voucher_code_hash: hash,
    p_redemption_idempotency_key: deterministicUuid(update.update_id, 'voucher-quote')
  });
  if (!quote || quote.error || !quote.data) {
    await sendPlain(bot, input.chat.id, 'Voucher tidak dapat digunakan atau sudah tidak berlaku.');
    await cleanupOrigin(bot, input);
    return { handled: true, outcome: 'voucher_unavailable' };
  }
  if (quote.data.voucher_type === 'PERCENT_30' || quote.data.voucher_type === 'PERCENT_50') {
    await sendPlain(bot, input.chat.id, '✅ Voucher diskon ' + String(quote.data.discount_percent || '') + '% valid.\nGunakan kode yang sama di Account Center saat checkout pembayaran tersedia.');
    await cleanupOrigin(bot, input);
    return { handled: true, outcome: 'voucher_payment_required' };
  }
  const redeemed = await db.rpc('redeem_subscription_voucher', {
    p_user_id: userId,
    p_voucher_code_hash: hash,
    p_redemption_idempotency_key: deterministicUuid(update.update_id, 'voucher-redeem')
  });
  if (!redeemed || redeemed.error || !redeemed.data || redeemed.data.redeemed !== true) {
    await sendPlain(bot, input.chat.id, 'Voucher tidak dapat diaktifkan.');
    await cleanupOrigin(bot, input);
    return { handled: true, outcome: 'voucher_redeem_failed' };
  }
  const expiry = redeemed.data.lifetime ? 'Lifetime' : (redeemed.data.expires_at ? new Date(redeemed.data.expires_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB' : '—');
  await sendPlain(bot, input.chat.id, '✅ Voucher berhasil diaktifkan.\nPaket: ' + String(redeemed.data.plan_code || 'Premium') + '\nBerlaku sampai: ' + expiry);
  await cleanupOrigin(bot, input);
  return { handled: true, outcome: 'voucher_redeemed' };
}

async function handleUserCommand(update, db, bot, input) {
  const text = String(input.message.text || '').trim();
  const match = USER_COMMAND_RE.exec(text);
  if (!match) return { handled: false, outcome: 'not_subscription_command' };
  const command = text.split(/\s+/)[0].replace(/^\//, '').split('@')[0].toLowerCase();
  if (command === 'trial') return handleTrial(update, db, bot, input);
  if (command === 'voucher') return handleVoucher(update, db, bot, input, match[1]);
  if (command === 'status') {
    await sendPlain(bot, input.chat.id, await statusMessage(db, input.from.id));
    await cleanupOrigin(bot, input);
    return { handled: true, outcome: 'subscription_status' };
  }
  await sendPlain(bot, input.chat.id, await catalogMessage(db));
  await cleanupOrigin(bot, input);
  return { handled: true, outcome: command === 'beli' ? 'subscription_buy_menu' : 'subscription_menu' };
}

function normalizeAdminUpdate(update) {
  const copy = Object.assign({}, update);
  if (update && update.message && typeof update.message.text === 'string' && /^\/voucheradmin(?:@[\w_]+)?\s*$/i.test(update.message.text.trim())) {
    copy.message = Object.assign({}, update.message, { text: '/menu' });
  }
  return copy;
}

async function handleVoucherAdmin(update, options, input) {
  if (!vouchers.isVoucherAdminTelegramUser(input.from.id)) return { handled: false, outcome: 'not_voucher_admin' };
  if (!isVoucherAdminBotEnabled(options && options.env)) return { handled: true, outcome: 'voucher_admin_disabled' };
  const capability = await getVoucherAdminCapability(options.db, options && options.env);
  if (!capability.ready) return { handled: true, outcome: 'voucher_admin_unavailable' };
  const sender = createVoucherAdminSender({ env: options && options.env });
  const result = await voucherAdminBot.processVoucherAdminUpdate(normalizeAdminUpdate(update), {
    db: options.db,
    capability,
    env: options && options.env,
    sender
  });
  if (input.q || (input.message && typeof input.message.text === 'string')) {
    await cleanupOrigin(options.bot, input);
  }
  return { handled: true, outcome: result && result.outcome || 'voucher_admin' };
}

async function handleUpdate(update, options) {
  const opts = options || {};
  const db = opts.db;
  const bot = opts.bot;
  if (!db || !bot || !update || !Number.isSafeInteger(update.update_id)) return { handled: false, outcome: 'invalid_update' };
  if (!isSubscriptionFeatureEnabled(opts.env)) return { handled: false, outcome: 'subscription_disabled' };
  const classified = classifyUpdate(update);
  if (classified.kind === 'none') return { handled: false, outcome: 'not_subscription' };
  if (classified.kind === 'voucher_admin') return handleVoucherAdmin(update, opts, classified.input);
  if (classified.kind === 'subscription_link') return handleLink(update, db, bot, classified.input);
  return handleUserCommand(update, db, bot, classified.input);
}

module.exports = {
  handleUpdate,
  __test: {
    SUB_START_RE,
    USER_COMMAND_RE,
    ADMIN_COMMAND_RE,
    classifyUpdate,
    deterministicUuid,
    privateMessage,
    cleanupOrigin,
    rupiah
  }
};
