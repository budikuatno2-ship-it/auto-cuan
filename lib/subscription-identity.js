'use strict';
// Server-only subscription Telegram identity boundary. Tokens are opaque,
// CSPRNG values shown once; only their HMAC reaches storage.
const crypto = require('crypto');
const LINK_TTL_MS = 5 * 60 * 1000;
function requiredSecret(name) { const value = process.env[name]; if (!value || value.length < 16) throw new Error(name + ' unavailable'); return value; }
function linkTokenHash(token) { return crypto.createHmac('sha256', requiredSecret('TELEGRAM_SUBSCRIPTION_LINK_PEPPER')).update(String(token), 'utf8').digest('hex'); }
function createLinkToken() { return crypto.randomBytes(32).toString('base64url'); }
function safeEventMetadata(type, metadata) {
  const fields = { subscription_telegram_link_token_created:['request_id'], subscription_telegram_linked:['result_code'], subscription_telegram_link_rejected:['reason'], subscription_onboarding_session_issued:['result_code'], subscription_trial_activation_requested:['request_id','source_channel'], subscription_trial_activated:['request_id','duration_days','starts_at','expires_at','source_channel'], subscription_trial_activation_rejected:['request_id','result_code','source_channel'], account_auto_approved_by_trial:['previous_approval_state','new_approval_state'] }[type];
  if (!fields) throw new Error('invalid subscription event'); const out = {};
  fields.forEach(k => { const v = metadata && metadata[k]; if ((typeof v === 'number' && Number.isSafeInteger(v)) || typeof v === 'boolean') out[k] = v; else if (typeof v === 'string') out[k] = v.replace(/[\r\n\t]/g, ' ').slice(0, 80); }); return out;
}
module.exports = { LINK_TTL_MS, linkTokenHash, createLinkToken, safeEventMetadata };
