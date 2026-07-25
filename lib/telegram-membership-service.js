'use strict';

const { createClient } = require('@supabase/supabase-js');
const core = require('./telegram-membership');

function client() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('membership_database_unavailable');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}
async function rpc(name, args) {
  const { data, error } = await client().rpc(name, args || {});
  if (error) { const e = new Error('membership_operation_failed'); e.code = error.code; throw e; }
  return data;
}
async function claimUpdate(updateId) { return rpc('membership_claim_telegram_update', { p_update_id: String(updateId) }); }
async function releaseUpdate(updateId) { return rpc('membership_release_telegram_update', { p_update_id: String(updateId) }); }
async function account(telegramId) { return rpc('membership_account_for_telegram', { p_telegram_user_id: String(telegramId) }); }
async function packages() {
  const { data, error } = await client().from('membership_packages').select('id,slug,name,description,duration_days,lifetime,price_idr').eq('active', true).order('sort_order');
  if (error) throw new Error('membership_operation_failed'); return data;
}
async function createPurchase(telegramId, packageId, voucherCode) {
  if (!process.env.MEMBERSHIP_BANK_INSTRUCTIONS) throw new Error('bank_instructions_missing');
  return rpc('membership_create_purchase', { p_telegram_user_id: String(telegramId), p_package_id: packageId, p_voucher_hash: voucherCode ? core.voucherHash(voucherCode, process.env.VOUCHER_CODE_PEPPER) : null, p_bank_instructions: process.env.MEMBERSHIP_BANK_INSTRUCTIONS });
}
async function submitProof(telegramId, purchaseId, metadata) {
  return rpc('membership_submit_payment_proof', { p_telegram_user_id: String(telegramId), p_purchase_id: purchaseId, p_file_id: metadata.fileId, p_file_unique_id: metadata.uniqueId, p_mime_type: metadata.mimeType, p_file_size: metadata.size });
}
async function channelGrant(telegramId) { return rpc('membership_issue_channel_grant', { p_telegram_user_id: String(telegramId) }); }
async function review(purchaseId, approve, reason, adminId, idempotencyKey) {
  return rpc('membership_review_purchase', { p_purchase_id: purchaseId, p_approve: approve, p_reason: reason || null, p_admin_user_id: adminId, p_idempotency_key: idempotencyKey });
}
async function pending() {
  const { data, error } = await client().from('membership_admin_payment_queue').select('*').limit(100);
  if (error) throw new Error('membership_operation_failed'); return data;
}
async function proof(proofId) {
  const { data, error } = await client().from('membership_payment_proofs').select('id,telegram_file_id,mime_type,file_size,purchase_id').eq('id', proofId).single();
  if (error) throw new Error('membership_operation_failed'); return data;
}
async function audit(purchaseId) {
  const { data, error } = await client().from('membership_audit_events').select('id,event_type,created_at,metadata').eq('purchase_id', purchaseId).order('created_at');
  if (error) throw new Error('membership_operation_failed'); return data;
}
async function enforceExpiry(dryRun) { return rpc('membership_enforce_channel_expiry', { p_dry_run: dryRun !== false }); }

module.exports = { client, rpc, claimUpdate, releaseUpdate, account, packages, createPurchase, submitProof, channelGrant, review, pending, proof, audit, enforceExpiry };
