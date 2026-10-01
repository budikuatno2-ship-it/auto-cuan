'use strict';

const vouchers = require('./vouchers');
const { createVoucherAdminSender } = require('./voucher-admin-sender');

const ADMIN_TELEGRAM_ID = vouchers.VOUCHER_ADMIN_TELEGRAM_USER_ID;

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
    return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c];
  });
}

function wib(value) {
  const d = value ? new Date(value) : new Date();
  if (!Number.isFinite(d.getTime())) return '—';
  try { return d.toLocaleString('id-ID', { timeZone:'Asia/Jakarta' }) + ' WIB'; }
  catch (_) { return d.toISOString(); }
}

async function voucherByHash(db, hash) {
  if (!db || !hash) return null;
  try {
    const result = await db.from('subscription_vouchers')
      .select('id,code_hint,plan_code,voucher_type,attempt_id,redemption_count,max_redemptions,active,revoked_at')
      .eq('code_hash',hash)
      .maybeSingle();
    return result && !result.error ? result.data : null;
  } catch (_) { return null; }
}

async function usernameFor(db, userId) {
  try {
    const result = await db.from('app_users').select('username').eq('id',userId).maybeSingle();
    return result && !result.error && result.data ? String(result.data.username || 'akun') : 'akun';
  } catch (_) { return 'akun'; }
}

async function userTelegramChat(db, userId) {
  try {
    const linked = await db.from('telegram_subscription_links')
      .select('telegram_private_chat_id,telegram_user_id')
      .eq('user_id',userId)
      .eq('link_state','linked')
      .maybeSingle();
    if (linked && !linked.error && linked.data) {
      const chat = Number(linked.data.telegram_private_chat_id || linked.data.telegram_user_id);
      if (Number.isSafeInteger(chat)) return chat;
    }
  } catch (_) {}
  try {
    const legacy = await db.from('app_user_telegram_verifications')
      .select('telegram_user_id')
      .eq('user_id',userId)
      .not('telegram_verified_at','is',null)
      .maybeSingle();
    const chat = legacy && !legacy.error && legacy.data ? Number(legacy.data.telegram_user_id) : NaN;
    if (Number.isSafeInteger(chat)) return chat;
  } catch (_) {}
  return null;
}

async function activationFacts(db, userId, redeemed) {
  const fallback = {
    plan_code: redeemed.plan_code || null,
    starts_at: redeemed.starts_at || new Date().toISOString(),
    expires_at: redeemed.expires_at || null,
    lifetime: redeemed.lifetime === true
  };
  const entitlementId = String(redeemed.entitlement_id || '').trim();
  if (!entitlementId) return fallback;
  try {
    const result = await db.from('user_entitlements')
      .select('plan_code,starts_at,expires_at,lifetime,status')
      .eq('id',entitlementId)
      .eq('user_id',userId)
      .maybeSingle();
    if (!result || result.error || !result.data || result.data.status !== 'active') return fallback;
    return {
      plan_code: result.data.plan_code || fallback.plan_code,
      starts_at: result.data.starts_at || fallback.starts_at,
      expires_at: result.data.expires_at || fallback.expires_at,
      lifetime: result.data.lifetime === true
    };
  } catch (_) { return fallback; }
}

async function cleanupDeliveryIfFinished(db, voucher) {
  if (!voucher || !voucher.attempt_id) return false;
  try {
    const attempt = await db.from('voucher_batch_chunk_attempts')
      .select('telegram_message_id,delivery_method')
      .eq('id',voucher.attempt_id)
      .maybeSingle();
    if (attempt.error || !attempt.data || attempt.data.delivery_method !== 'message') return false;
    const messageId = Number(attempt.data.telegram_message_id);
    if (!Number.isSafeInteger(messageId) || messageId < 1) return false;

    const siblings = await db.from('subscription_vouchers')
      .select('redemption_count,max_redemptions,active,revoked_at')
      .eq('attempt_id',voucher.attempt_id);
    if (siblings.error || !Array.isArray(siblings.data) || !siblings.data.length) return false;
    const finished = siblings.data.every(function (item) {
      return item.active === false || Boolean(item.revoked_at) || Number(item.redemption_count) >= Number(item.max_redemptions);
    });
    if (!finished) return false;

    const sender = createVoucherAdminSender();
    await sender.deleteMessage(ADMIN_TELEGRAM_ID, messageId);
    return true;
  } catch (_) { return false; }
}

async function notifyClaim(options) {
  const opts = options || {};
  const db = opts.db;
  const userId = opts.userId;
  const voucherHash = opts.voucherHash;
  const redeemed = opts.redeemed || {};
  if (!db || !userId || !voucherHash || redeemed.redeemed !== true) return { notified:false, user_notified:false, cleaned:false };

  const voucher = await voucherByHash(db, voucherHash);
  if (!voucher) return { notified:false, user_notified:false, cleaned:false };
  const username = await usernameFor(db, userId);
  const type = voucher.voucher_type || (voucher.plan_code === 'LIFETIME' ? 'LIFETIME' : 'PERCENT_100');
  const facts = await activationFacts(db, userId, redeemed);
  const planCode = facts.plan_code || voucher.plan_code || 'Premium';
  const starts = wib(facts.starts_at);
  const expiry = facts.lifetime ? 'Lifetime' : wib(facts.expires_at);
  const source = String(opts.source || 'web');
  const text = [
    '🎟️ <b>VOUCHER DIGUNAKAN</b>',
    '',
    'User: <b>' + esc(username) + '</b>',
    'Voucher: ••••' + esc(voucher.code_hint || '—'),
    'Tipe: ' + esc(type),
    'Paket: ' + esc(planCode),
    'Mulai aktif: ' + esc(starts),
    'Berlaku sampai: ' + esc(expiry),
    'Sumber: ' + esc(source),
    'Waktu klaim: ' + esc(wib(new Date()))
  ].join('\n');

  const sender = createVoucherAdminSender();
  let notified = false;
  try {
    await sender.sendMessage(ADMIN_TELEGRAM_ID, text);
    notified = true;
  } catch (_) {}

  let userNotified = false;
  if (source === 'web') {
    const chatId = await userTelegramChat(db, userId);
    if (chatId) {
      const sourceLabel = type === 'LIFETIME' ? 'Voucher Lifetime' : 'Voucher 100%';
      const userText = [
        '✅ <b>Subscription Auto-Cuan aktif</b>',
        '',
        'Paket: <b>' + esc(planCode) + '</b>',
        'Mulai aktif: ' + esc(starts),
        'Berlaku sampai: ' + esc(expiry),
        'Sumber: ' + esc(sourceLabel),
        '',
        'Website akan memperbarui akses Premium secara otomatis.'
      ].join('\n');
      try {
        await sender.sendMessage(chatId, userText);
        userNotified = true;
      } catch (_) {}
    }
  }

  const refreshed = await voucherByHash(db, voucherHash) || voucher;
  const cleaned = await cleanupDeliveryIfFinished(db, refreshed);
  return { notified, user_notified:userNotified, cleaned, code_hint:voucher.code_hint || null, voucher_type:type, username };
}

module.exports = { voucherByHash, usernameFor, userTelegramChat, activationFacts, cleanupDeliveryIfFinished, notifyClaim };