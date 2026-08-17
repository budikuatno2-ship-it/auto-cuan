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
  if (!db || !userId || !voucherHash || redeemed.redeemed !== true) return { notified:false, cleaned:false };

  const voucher = await voucherByHash(db, voucherHash);
  if (!voucher) return { notified:false, cleaned:false };
  const username = await usernameFor(db, userId);
  const type = voucher.voucher_type || (voucher.plan_code === 'LIFETIME' ? 'LIFETIME' : 'PERCENT_100');
  const expiry = redeemed.lifetime ? 'Lifetime' : wib(redeemed.expires_at);
  const text = [
    '🎟️ <b>VOUCHER DIGUNAKAN</b>',
    '',
    'User: <b>' + esc(username) + '</b>',
    'Voucher: ••••' + esc(voucher.code_hint || '—'),
    'Tipe: ' + esc(type),
    'Paket: ' + esc(redeemed.plan_code || voucher.plan_code || 'Premium'),
    'Berlaku sampai: ' + esc(expiry),
    'Sumber: ' + esc(opts.source || 'web'),
    'Waktu: ' + esc(wib(new Date()))
  ].join('\n');

  let notified = false;
  try {
    const sender = createVoucherAdminSender();
    await sender.sendMessage(ADMIN_TELEGRAM_ID, text);
    notified = true;
  } catch (_) {}

  const refreshed = await voucherByHash(db, voucherHash) || voucher;
  const cleaned = await cleanupDeliveryIfFinished(db, refreshed);
  return { notified, cleaned, code_hint:voucher.code_hint || null, voucher_type:type, username };
}

module.exports = { voucherByHash, usernameFor, cleanupDeliveryIfFinished, notifyClaim };
