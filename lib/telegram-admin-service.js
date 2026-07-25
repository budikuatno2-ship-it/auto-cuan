'use strict';

const membership = require('./telegram-membership-service');
const core = require('./telegram-membership');
const env = require('./runtime-env');

const rpc = membership.rpc;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function authorize(telegramId) { return rpc('membership_admin_bot_context', { p_telegram_user_id: String(telegramId) }); }
function claimUpdate(updateId) { return rpc('membership_admin_bot_claim_update', { p_update_id: String(updateId) }); }
function releaseUpdate(updateId) { return rpc('membership_admin_bot_release_update', { p_update_id: String(updateId) }); }
function pending() { return rpc('membership_admin_bot_pending_payments'); }
function vouchers() { return rpc('membership_admin_bot_list_vouchers'); }
function voucherDetail(identifier) { return rpc('membership_admin_bot_voucher_detail', { p_identifier: identifier }); }
function deactivateVoucher(id, adminId) { return rpc('membership_admin_bot_deactivate_voucher', { p_voucher_id: id, p_admin_user_id: adminId }); }
function userLookup(query) { return rpc('membership_admin_bot_user_lookup', { p_query: query }); }
function audit(purchaseId) { return rpc('membership_admin_bot_audit', { p_purchase_id: purchaseId || null }); }
function notificationTargets(purchaseId) { return rpc('membership_admin_bot_claim_proof_notification', { p_purchase_id: purchaseId }); }
function releaseNotification(purchaseId) { return rpc('membership_admin_bot_release_proof_notification', { p_purchase_id: purchaseId }); }
async function createVoucher(input, adminId, rpcOverride) {
  const pepper = env.optional('VOUCHER_CODE_PEPPER');
  const hash = core.voucherHash(input.code, pepper); const hint = core.maskVoucher(input.code);
  return (rpcOverride || rpc)('membership_admin_bot_create_voucher', {
    p_code_hash: hash, p_code_hint: hint, p_discount_type: input.type, p_discount_value: input.value,
    p_package_slug: input.package, p_total_limit: input.limit || null, p_valid_days: input.days || null,
    p_admin_user_id: adminId
  });
}
module.exports = { UUID, authorize, claimUpdate, releaseUpdate, pending, vouchers, voucherDetail, deactivateVoucher, userLookup, audit, notificationTargets, releaseNotification, createVoucher, review: membership.review };
