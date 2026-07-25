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
async function bindAdmin(telegramId, privateChatId, code) {
  if (!process.env.ADMIN_TELEGRAM_BIND_PEPPER) return false;
  const hash = core.voucherHash(code, process.env.ADMIN_TELEGRAM_BIND_PEPPER);
  return rpc('membership_consume_admin_bind_challenge', { p_code_hash: hash, p_telegram_user_id: String(telegramId), p_private_chat_id: String(privateChatId) });
}
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
async function recordChannelInvite(grantId, telegramId, invite) {
  if (!process.env.CHANNEL_INVITE_PEPPER) throw new Error('channel_invite_pepper_missing');
  return rpc('membership_record_channel_invite', { p_grant_id: grantId, p_telegram_user_id: String(telegramId), p_invite_hash: core.voucherHash(invite, process.env.CHANNEL_INVITE_PEPPER) });
}
async function claimChannelJoin(telegramId, invite) {
  if (!process.env.CHANNEL_INVITE_PEPPER) return null;
  return rpc('membership_claim_channel_join', { p_telegram_user_id: String(telegramId), p_invite_hash: core.voucherHash(invite, process.env.CHANNEL_INVITE_PEPPER) });
}
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
async function expiryCandidates() { return rpc('membership_channel_expiry_candidates', {}); }
async function revokeChannelGrant(grantId) { return rpc('membership_revoke_channel_grant', { p_grant_id: grantId }); }
async function runChannelExpiryEnforcement(options) {
  const opts = options || {};
  const db = opts.db || module.exports;
  const rows = await db.expiryCandidates();
  const destructive = opts.enabled === true && opts.confirm === 'REMOVE_EXPIRED_MEMBERS';
  const report = { dry_run: !destructive, candidates: rows.length, removed: 0, failures: 0 };
  if (!destructive) return report;
  for (const row of rows) {
    try {
      await opts.bot.banChatMember(opts.channelId, row.telegram_user_id);
      await opts.bot.unbanChatMember(opts.channelId, row.telegram_user_id);
      await db.revokeChannelGrant(row.grant_id);
      report.removed++;
    } catch (error) { report.failures++; }
  }
  return report;
}

module.exports = { client, rpc, claimUpdate, releaseUpdate, bindAdmin, account, packages, createPurchase, submitProof, channelGrant, recordChannelInvite, claimChannelJoin, review, pending, proof, audit, enforceExpiry, expiryCandidates, revokeChannelGrant, runChannelExpiryEnforcement };
