'use strict';

const crypto = require('crypto');

const PURCHASE_STATES = Object.freeze(['draft', 'awaiting_payment', 'proof_submitted', 'awaiting_admin_review', 'approved', 'rejected', 'expired', 'cancelled']);
const TRANSITIONS = Object.freeze({
  draft: ['awaiting_payment', 'cancelled'],
  awaiting_payment: ['proof_submitted', 'expired', 'cancelled'],
  proof_submitted: ['awaiting_admin_review'],
  awaiting_admin_review: ['approved', 'rejected'],
  rejected: ['proof_submitted', 'cancelled'],
  approved: [], expired: [], cancelled: []
});
const MENU = Object.freeze([
  'Verifikasi Akun', 'Akun Saya', 'Paket', 'Beli / Perpanjang',
  'Akses Channel', 'Cara Pakai', 'Hubungi Admin'
]);
const MAX_UPDATE_BYTES = 256 * 1024;
const MAX_PROOF_BYTES = 8 * 1024 * 1024;
const PROOF_MIME = new Set(['image/jpeg', 'image/png', 'application/pdf']);

function normalizeVoucher(code) {
  return String(code || '').normalize('NFKC').trim().toUpperCase().replace(/[\s-]+/g, '');
}
function voucherHash(code, pepper) {
  if (!pepper) throw new Error('voucher_pepper_missing');
  return crypto.createHmac('sha256', pepper).update(normalizeVoucher(code), 'utf8').digest('hex');
}
function generateVoucherCode(bytes) {
  return crypto.randomBytes(bytes || 16).toString('base64url').toUpperCase();
}
function maskVoucher(code) {
  const c = normalizeVoucher(code);
  return c.length < 8 ? '****' : c.slice(0, 4) + '…' + c.slice(-4);
}
function calculatePrice(packageRow, voucher, now) {
  const price = Number(packageRow && packageRow.price_idr);
  if (!Number.isSafeInteger(price) || price < 0) throw new Error('invalid_package_price');
  if (!voucher) return { subtotal: price, discount: 0, finalAmount: price };
  const at = now || new Date();
  if (voucher.valid_from && at < new Date(voucher.valid_from)) throw new Error('voucher_not_started');
  if (voucher.valid_until && at >= new Date(voucher.valid_until)) throw new Error('voucher_expired');
  if (voucher.package_ids && !voucher.package_ids.includes(packageRow.id)) throw new Error('voucher_ineligible');
  let discount = voucher.discount_type === 'percent'
    ? Math.floor(price * Number(voucher.discount_value) / 100)
    : Number(voucher.discount_value);
  if (voucher.max_discount_idr != null) discount = Math.min(discount, Number(voucher.max_discount_idr));
  discount = Math.max(0, Math.min(price, Math.floor(discount)));
  return { subtotal: price, discount, finalAmount: price - discount };
}
function canTransition(from, to) { return Boolean(TRANSITIONS[from] && TRANSITIONS[from].includes(to)); }
function purchaseAllowsProof(purchase, now) { return Boolean(purchase && ['awaiting_payment', 'rejected'].includes(purchase.status) && new Date(purchase.expiresAt) > (now || new Date())); }
function purchaseAllowsApproval(purchase, now) { return Boolean(purchase && purchase.status === 'awaiting_admin_review' && new Date(purchase.expiresAt) > (now || new Date()) && !purchase.approvedAt); }
function voucherReservationAfter(purchaseStatus) { return purchaseStatus === 'approved' ? 'finalized' : ['expired', 'cancelled'].includes(purchaseStatus) ? 'released' : 'reserved'; }
function canPurchase(input) { return Boolean(input && input.verified === true && input.blocked !== true && input.accountStatus !== 'blocked'); }
function dashboardEligible(input) {
  const e = input && input.entitlement;
  return Boolean(input && input.approved === true && input.blocked !== true && input.verified === true && e &&
    e.status === 'active' && e.lifetime === true && !e.revokedAt && (!e.endsAt || new Date(e.endsAt) > (input.now || new Date())));
}
function isEnforcementCandidate(input) {
  if (!input || input.isAdmin === true || input.configuredExemption === true) return false;
  if (input.grantRevoked === true || input.blocked === true || input.approved !== true) return true;
  if (input.channelAccess === false) return true;
  return Boolean(input.channelCoverageEndsAt && new Date(input.channelCoverageEndsAt) <= (input.now || new Date()));
}
function accessFor(input) {
  if (input && input.isAdmin === true) return { bot: true, channel: true, dashboard: true, reason: 'admin' };
  if (!input || input.verified !== true) return { bot: false, channel: false, dashboard: false, reason: 'unverified' };
  if (input.blocked === true || input.accountStatus === 'blocked') return { bot: false, channel: false, dashboard: false, reason: 'blocked' };
  if (input.accountStatus === 'pending') return { bot: false, channel: false, dashboard: false, reason: 'pending' };
  if (!input.entitlement || input.entitlement.status !== 'active') return { bot: false, channel: false, dashboard: false, reason: 'unpaid' };
  const live = input.entitlement.lifetime === true || new Date(input.entitlement.endsAt) > (input.now || new Date());
  if (!live) return { bot: false, channel: false, dashboard: false, reason: 'expired' };
  return {
    bot: input.botAccess !== false,
    channel: input.channelAccess === true,
    dashboard: input.dashboardAccess === true,
    reason: input.entitlement.lifetime ? 'lifetime' : 'term'
  };
}
function extendEntitlement(existingEnd, days, now) {
  const current = now || new Date();
  const base = existingEnd && new Date(existingEnd) > current ? new Date(existingEnd) : current;
  const out = new Date(base);
  out.setUTCDate(out.getUTCDate() + Number(days));
  return out;
}
function validateProof(file) {
  if (!file || !PROOF_MIME.has(file.mime_type)) return { ok: false, reason: 'mime' };
  if (!Number.isSafeInteger(file.file_size) || file.file_size <= 0 || file.file_size > MAX_PROOF_BYTES) return { ok: false, reason: 'size' };
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(String(file.file_id || ''))) return { ok: false, reason: 'file_id' };
  return { ok: true, metadata: { fileId: file.file_id, uniqueId: String(file.file_unique_id || '').slice(0, 256), mimeType: file.mime_type, size: file.file_size } };
}
function isPrivate(update) {
  const chat = update && (update.message && update.message.chat || update.callback_query && update.callback_query.message && update.callback_query.message.chat);
  return Boolean(chat && chat.type === 'private');
}
function validCallback(data) {
  return typeof data === 'string' && /^(?:menu|package|checkout|novoucher|voucher|channel|nav|cancel):[a-z0-9_-]{1,48}$/.test(data);
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) return false;
  try {
    const x = Buffer.from(a); const y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  } catch (error) { return false; }
}
function menuFor(input) {
  const access = accessFor(input);
  if (!input || input.verified !== true) return ['Verifikasi Akun', 'Paket', 'Hubungi Admin'];
  if (input.blocked === true || input.accountStatus === 'blocked') return ['Akun Saya', 'Hubungi Admin'];
  if (!access.bot) return ['Akun Saya', 'Paket', 'Beli Paket', 'Hubungi Admin'];
  const out = ['Akun Saya', 'Paket Aktif', 'Beli / Perpanjang'];
  if (access.channel || input.channelAddonAvailable === true) out.push('Akses Channel');
  out.push('Cara Pakai', 'Hubungi Admin');
  return out;
}
function menuKeyboard(input) {
  const items = menuFor(input);
  const rows = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2).map(text => ({ text })));
  return { keyboard: rows, resize_keyboard: true };
}

module.exports = { PURCHASE_STATES, TRANSITIONS, MENU, MAX_UPDATE_BYTES, MAX_PROOF_BYTES, normalizeVoucher, voucherHash, generateVoucherCode, maskVoucher, calculatePrice, canTransition, purchaseAllowsProof, purchaseAllowsApproval, voucherReservationAfter, canPurchase, dashboardEligible, isEnforcementCandidate, accessFor, extendEntitlement, validateProof, isPrivate, validCallback, safeEqual, menuFor, menuKeyboard };
