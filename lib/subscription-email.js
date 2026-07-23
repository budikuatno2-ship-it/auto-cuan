'use strict';
// Server-only, provider-agnostic delivery boundary. A provider is intentionally
// not selected in Phase 4. Future configuration names: EMAIL_PROVIDER,
// EMAIL_FROM, EMAIL_PROVIDER_API_KEY. No provider response is exposed.
let injectedSender = null;
function setEmailSenderForTests(sender) { injectedSender = sender || null; }
function configuredSender() { return injectedSender; }
async function deliverVerificationOtp(message) {
  const sender = configuredSender();
  if (!sender || typeof sender.sendVerificationOtp !== 'function') return { ok: false, code: 'delivery_unavailable' };
  try { const result = await sender.sendVerificationOtp({ to: message.to, otp: message.otp, expiresAt: message.expiresAt }); return result && result.ok !== false ? { ok: true } : { ok: false, code: 'delivery_unavailable' }; }
  catch (_) { return { ok: false, code: 'delivery_unavailable' }; }
}
module.exports = { deliverVerificationOtp, setEmailSenderForTests };
