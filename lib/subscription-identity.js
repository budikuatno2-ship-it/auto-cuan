'use strict';
// Server-only subscription Telegram identity boundary. Tokens are opaque,
// CSPRNG values shown once; only their HMAC reaches storage.
const crypto = require('crypto');
const LINK_TTL_MS = 5 * 60 * 1000;
function requiredSecret(name) { const value = process.env[name]; if (!value || value.length < 16) throw new Error(name + ' unavailable'); return value; }
function linkTokenHash(token) { return crypto.createHmac('sha256', requiredSecret('TELEGRAM_SUBSCRIPTION_LINK_PEPPER')).update(String(token), 'utf8').digest('hex'); }
function createLinkToken() { return crypto.randomBytes(32).toString('base64url'); }
function safeEventMetadata(type, metadata) {
  const fields = { subscription_telegram_link_token_created:['request_id'], subscription_telegram_linked:['telegram_user_id'], subscription_telegram_link_rejected:['reason'] }[type];
  if (!fields) throw new Error('invalid subscription event'); const out = {};
  fields.forEach(k => { const v = metadata && metadata[k]; if ((typeof v === 'number' && Number.isSafeInteger(v)) || typeof v === 'boolean') out[k] = v; else if (typeof v === 'string') out[k] = v.replace(/[\r\n\t]/g, ' ').slice(0, 80); }); return out;
}
module.exports = { LINK_TTL_MS, linkTokenHash, createLinkToken, safeEventMetadata };
