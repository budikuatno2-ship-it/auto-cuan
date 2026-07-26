'use strict';

const { createClient } = require('@supabase/supabase-js');
const core = require('./telegram-membership');
const env = require('./runtime-env');

const SAFE_REASONS = new Set([
  'membership_database_unavailable','membership_operation_failed','package_unavailable',
  'bank_instructions_missing','bank_instructions_unavailable','verified_unblocked_account_required',
  'verified_approved_account_required','voucher_unavailable','checkout_session_expired',
  'channel_addon_requires_90_day','channel_already_covered','channel_addon_purchase_pending',
  'channel_extension_required','channel_not_included','entitlement_required','purchase_state_conflict',
  'purchase_pending','voucher_pepper_missing'
]);

function client() {
  const url = env.optional('SUPABASE_URL');
  const key = env.optional('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('membership_database_unavailable');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function safeReason(error) {
  const text = [error && error.message, error && error.details, error && error.hint]
    .filter(Boolean).join(' ');
  for (const reason of SAFE_REASONS) if (text.includes(reason)) return reason;
  return 'membership_operation_failed';
}

async function rpc(name, args) {
  const { data, error } = await client().rpc(name, args || {});
  if (error) {
    const e = new Error('membership_operation_failed');
    e.code = error.code;
    e.reason = safeReason(error);
    throw e;
  }
  return data;
}

async function claimUpdate(updateId) { return rpc('membership_claim_telegram_update', { p_update_id: String(updateId) }); }
async function releaseUpdate(updateId) { return rpc('membership_release_telegram_update', { p_update_id: String(updateId) }); }

async function bindAdmin(telegramId, privateChatId, code) {
  const pepper = env.optional('ADMIN_TELEGRAM_BIND_PEPPER');
  if (!pepper) return false;
  return rpc('membership_consume_admin_bind_challenge', {
    p_code_hash: core.voucherHash(code, pepper),
    p_telegram_user_id: String(telegramId),
    p_private_chat_id: String(privateChatId)
  });
}

async function account(telegramId) {
  return rpc('membership_account_for_telegram', { p_telegram_user_id: String(telegramId) });
}

async function packages() {
  const { data, error } = await client().from('membership_packages')
    .select('id,slug,name,description,duration_days,lifetime,price_idr,product_type')
    .eq('active', true)
    .eq('product_type', 'membership')
    .order('sort_order');
  if (error) {
    const e = new Error('membership_operation_failed');
    e.reason = safeReason(error);
    throw e;
  }
  return data;
}

async function packageBySlug(slug) {
  const { data, error } = await client().from('membership_packages')
    .select('id,slug,name,description,duration_days,lifetime,price_idr,product_type')
    .eq('slug', String(slug || '').toLowerCase())
    .eq('active', true)
    .single();
  if (error) {
    const e = new Error('package_unavailable');
    e.reason = 'package_unavailable';
    throw e;
  }
  return data;
}

function bankInstructions() {
  const instructions = env.optional('MEMBERSHIP_BANK_INSTRUCTIONS');
  if (!instructions) {
    const e = new Error('bank_instructions_missing');
    e.reason = 'bank_instructions_missing';
    throw e;
  }
  return instructions;
}

function voucherHashOrNull(voucherCode) {
  if (!voucherCode) return null;
  const pepper = env.optional('VOUCHER_CODE_PEPPER');
  if (!pepper) {
    const e = new Error('voucher_pepper_missing');
    e.reason = 'voucher_pepper_missing';
    throw e;
  }
  return core.voucherHash(voucherCode, pepper);
}

async function createPurchase(telegramId, packageId, voucherCode) {
  return rpc('membership_create_purchase', {
    p_telegram_user_id: String(telegramId),
    p_package_id: packageId,
    p_voucher_hash: voucherHashOrNull(voucherCode),
    p_bank_instructions: bankInstructions()
  });
}

async function beginCheckout(telegramId, packageSlug) {
  return rpc('membership_begin_checkout', {
    p_telegram_user_id: String(telegramId),
    p_package_slug: packageSlug
  });
}

async function checkoutSession(telegramId) {
  return rpc('membership_checkout_session', { p_telegram_user_id: String(telegramId) });
}

async function cancelCheckout(telegramId) {
  return rpc('membership_cancel_checkout', { p_telegram_user_id: String(telegramId) });
}

async function prepareCheckout(telegramId, voucherCode) {
  const result = await rpc('membership_prepare_checkout', {
    p_telegram_user_id: String(telegramId),
    p_voucher_hash: voucherHashOrNull(voucherCode)
  });
  return Object.assign({}, result || {}, { bankInstructions: bankInstructions() });
}

async function confirmCheckout(telegramId) {
  return rpc('membership_checkout_purchase_confirmed', {
    p_telegram_user_id: String(telegramId),
    p_bank_instructions: bankInstructions()
  });
}

async function checkoutPurchase(telegramId, voucherCode) {
  return rpc('membership_checkout_purchase', {
    p_telegram_user_id: String(telegramId),
    p_voucher_hash: voucherHashOrNull(voucherCode),
    p_bank_instructions: bankInstructions()
  });
}

async function currentPurchase(telegramId) {
  return rpc('membership_current_purchase_for_telegram', {
    p_telegram_user_id: String(telegramId)
  });
}

async function beginProofUpload(telegramId, purchaseId) {
  return rpc('membership_begin_proof_upload', {
    p_telegram_user_id: String(telegramId),
    p_purchase_id: purchaseId
  });
}

async function cancelPurchase(telegramId, purchaseId) {
  return rpc('membership_cancel_purchase', {
    p_telegram_user_id: String(telegramId),
    p_purchase_id: purchaseId
  });
}

async function submitProof(telegramId, purchaseId, metadata) {
  return rpc('membership_admin_bot_submit_payment_proof', {
    p_telegram_user_id: String(telegramId),
    p_purchase_id: purchaseId,
    p_file_id: metadata.fileId,
    p_file_unique_id: metadata.uniqueId,
    p_mime_type: metadata.mimeType,
    p_file_size: metadata.size
  });
}

async function notifyAdminsOfProof(submitted, metadata, deps) {
  if (!submitted || !submitted.purchaseId) return false;
  const adminService = deps && deps.adminService || require('./telegram-admin-service');
  const adminBot = deps && deps.adminBot || require('./telegram-admin-bot');
  const verifyBot = deps && deps.verifyBot || require('./telegram-verify-bot');
  const targets = await adminService.notificationTargets(submitted.purchaseId);
  if (!Array.isArray(targets) || !targets.length) return false;

  let bytes = null;
  try { bytes = await verifyBot.downloadFile(metadata.fileId, core.MAX_PROOF_BYTES); } catch (_) {}

  const caption = String(submitted.notificationText ||
    'Bukti pembayaran baru #' + String(submitted.purchaseId).slice(0, 8));
  const markup = { inline_keyboard: [[
    { text: '✅ Setujui', callback_data: 'approve:' + submitted.purchaseId },
    { text: '❌ Tolak', callback_data: 'reject:' + submitted.purchaseId }
  ]] };

  let delivered = false;
  for (const target of targets) {
    try {
      if (bytes) {
        await adminBot.sendBytes(
          target.private_chat_id,
          bytes,
          metadata.mimeType,
          metadata.mimeType === 'application/pdf'
            ? 'bukti.pdf'
            : 'bukti.' + (metadata.mimeType === 'image/png' ? 'png' : 'jpg'),
          caption,
          markup
        );
      } else {
        await adminBot.sendMessage(target.private_chat_id, caption, { reply_markup: markup });
      }
      delivered = true;
    } catch (_) {
      try {
        await adminBot.sendMessage(target.private_chat_id, caption, { reply_markup: markup });
        delivered = true;
      } catch (_) {}
    }
  }

  if (!delivered) await adminService.releaseNotification(submitted.purchaseId).catch(function () {});
  return delivered;
}

async function channelGrant(telegramId) {
  return rpc('membership_issue_channel_grant', { p_telegram_user_id: String(telegramId) });
}

async function recordChannelInvite(grantId, telegramId, invite) {
  const pepper = env.optional('CHANNEL_INVITE_PEPPER');
  if (!pepper) throw new Error('channel_invite_pepper_missing');
  return rpc('membership_record_channel_invite', {
    p_grant_id: grantId,
    p_telegram_user_id: String(telegramId),
    p_invite_hash: core.voucherHash(invite, pepper)
  });
}

async function claimChannelJoin(telegramId, invite) {
  const pepper = env.optional('CHANNEL_INVITE_PEPPER');
  if (!pepper) return null;
  return rpc('membership_claim_channel_join', {
    p_telegram_user_id: String(telegramId),
    p_invite_hash: core.voucherHash(invite, pepper)
  });
}

async function finalizeChannelJoin(grantId, claimToken) {
  return rpc('membership_finalize_channel_join', { p_grant_id: grantId, p_claim_token: claimToken });
}

async function releaseChannelJoin(grantId, claimToken) {
  return rpc('membership_release_channel_join', { p_grant_id: grantId, p_claim_token: claimToken });
}

async function review(purchaseId, approve, reason, adminId, idempotencyKey) {
  return rpc('membership_admin_bot_review_purchase', {
    p_purchase_id: purchaseId,
    p_approve: approve,
    p_reason: reason || null,
    p_admin_user_id: adminId,
    p_idempotency_key: idempotencyKey
  });
}

async function pending() {
  const { data, error } = await client().from('membership_admin_payment_queue').select('*').limit(100);
  if (error) throw new Error('membership_operation_failed');
  return data;
}

async function proof(proofId) {
  const { data, error } = await client().from('membership_payment_proofs')
    .select('id,telegram_file_id,mime_type,file_size,purchase_id')
    .eq('id', proofId).single();
  if (error) throw new Error('membership_operation_failed');
  return data;
}

async function audit(purchaseId) {
  const { data, error } = await client().from('membership_audit_events')
    .select('id,event_type,created_at,metadata')
    .eq('purchase_id', purchaseId)
    .order('created_at');
  if (error) throw new Error('membership_operation_failed');
  return data;
}

async function enforceExpiry(dryRun) {
  return rpc('membership_enforce_channel_expiry', { p_dry_run: dryRun !== false });
}
async function expiryCandidates() { return rpc('membership_channel_expiry_candidates', {}); }
async function revokeChannelGrant(grantId) {
  return rpc('membership_revoke_channel_grant', { p_grant_id: grantId });
}

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
    } catch (_) { report.failures++; }
  }
  return report;
}

module.exports = {
  client, rpc, claimUpdate, releaseUpdate, bindAdmin, account, packages, packageBySlug,
  createPurchase, beginCheckout, checkoutSession, cancelCheckout, prepareCheckout,
  confirmCheckout, checkoutPurchase, currentPurchase, beginProofUpload, cancelPurchase,
  submitProof, notifyAdminsOfProof, channelGrant, recordChannelInvite, claimChannelJoin,
  finalizeChannelJoin, releaseChannelJoin, review, pending, proof, audit, enforceExpiry,
  expiryCandidates, revokeChannelGrant, runChannelExpiryEnforcement
};
