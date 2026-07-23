'use strict';
const crypto = require('crypto');
const OTP_TTL_MS = 10 * 60 * 1000;
const LINK_TTL_MS = 10 * 60 * 1000;
const OTP_ATTEMPT_LIMIT = 5;
const OTP_LOCK_MS = 15 * 60 * 1000;
function normalizeEmail(value) { return String(value || '').trim().normalize('NFKC').toLowerCase(); }
function validEmail(value) { const email = normalizeEmail(value); return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null; }
function maskEmail(value) { const email = validEmail(value); if (!email) return null; const [local, domain] = email.split('@'); return (local.length <= 2 ? local[0] + '*' : local.slice(0, 2) + '*'.repeat(Math.min(6, local.length - 2))) + '@' + domain; }
function requiredSecret(name) { const value = process.env[name]; if (!value || value.length < 16) throw new Error(name + ' unavailable'); return value; }
function hmac(value, secretName) { return crypto.createHmac('sha256', requiredSecret(secretName)).update(String(value), 'utf8').digest('hex'); }
function otpHash(userId, email, otp) { return hmac(userId + ':' + normalizeEmail(email) + ':' + otp, 'EMAIL_OTP_PEPPER'); }
function linkTokenHash(token) { return hmac(token, 'TELEGRAM_SUBSCRIPTION_LINK_PEPPER'); }
function createOtp() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }
function createLinkToken() { return crypto.randomBytes(32).toString('base64url'); }
function safeEventMetadata(type, metadata) {
  const fields = { subscription_email_otp_requested:['request_id'], subscription_email_verified:['verification_version'], subscription_email_verification_failed:['reason'], subscription_telegram_link_token_created:['request_id'], subscription_telegram_linked:['telegram_user_id'], subscription_telegram_link_rejected:['reason'] }[type];
  if (!fields) throw new Error('invalid subscription event'); const out = {};
  fields.forEach(k => { const v = metadata && metadata[k]; if (typeof v === 'boolean' || (typeof v === 'number' && Number.isSafeInteger(v))) out[k] = v; else if (typeof v === 'string') out[k] = v.replace(/[\r\n\t]/g, ' ').slice(0, 80); }); return out;
}
module.exports = { OTP_TTL_MS, LINK_TTL_MS, OTP_ATTEMPT_LIMIT, OTP_LOCK_MS, normalizeEmail, validEmail, maskEmail, otpHash, linkTokenHash, createOtp, createLinkToken, safeEventMetadata };
