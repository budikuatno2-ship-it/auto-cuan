'use strict';

// This is deliberately server-owned. Only the exact string "true" opts in;
// absent, blank, false-like, and arbitrary values remain disabled.
function isSubscriptionFeatureEnabled(env) {
  const source = env || process.env;
  return source.SUBSCRIPTION_FEATURE_ENABLED === 'true';
}

async function getSubscriptionCapability(db, env) {
  if (!isSubscriptionFeatureEnabled(env)) return { enabled: false, ready: false, reason: 'disabled' };
  if (!db || typeof db.from !== 'function') return { enabled: true, ready: false, reason: 'unavailable' };
  try {
    // A narrow read is a readiness probe only. It must succeed before any UI or
    // mutation is exposed; database errors are intentionally not propagated.
    const result = await db.from('subscription_plans').select('code').limit(1);
    if (result && !result.error) return { enabled: true, ready: true };
  } catch (_) { /* unavailable */ }
  return { enabled: true, ready: false, reason: 'unavailable' };
}

function isVoucherAdminBotEnabled(env) {
  const source = env || process.env;
  return source.VOUCHER_ADMIN_BOT_ENABLED === 'true' && isSubscriptionFeatureEnabled(source);
}

function hasVoucherAdminConfiguration(env) {
  const source = env || process.env;
  // Voucher administration deliberately shares the existing AutoCuan
  // Verification bot. There is no second Telegram bot/token to protect or keep
  // in sync; authorization still comes from the verified admin Telegram ID and
  // service-role-only RPCs, not from knowing the bot token.
  return typeof source.TELEGRAM_VERIFY_BOT_TOKEN === 'string' && source.TELEGRAM_VERIFY_BOT_TOKEN.length >= 16 &&
    typeof source.VOUCHER_CODE_PEPPER === 'string' && source.VOUCHER_CODE_PEPPER.length >= 16;
}

async function getVoucherAdminCapability(db, env) {
  if (!isVoucherAdminBotEnabled(env)) return { enabled: false, ready: false, reason: 'disabled' };
  if (!hasVoucherAdminConfiguration(env)) return { enabled: true, ready: false, reason: 'configuration' };
  if (!db || typeof db.rpc !== 'function') return { enabled: true, ready: false, reason: 'unavailable' };
  try {
    // This marker is installed only by the final Phase 5C redemption correction,
    // after the foundation, lifecycle, and admin-command corrections. Anything
    // older remains fail-closed even when the tables happen to exist.
    const result = await db.rpc('voucher_admin_schema_version');
    if (result && !result.error && result.data === 'phase5c-complete-v4') return { enabled: true, ready: true };
  } catch (_) { /* fail closed */ }
  return { enabled: true, ready: false, reason: 'unavailable' };
}

module.exports = {
  isSubscriptionFeatureEnabled,
  getSubscriptionCapability,
  isVoucherAdminBotEnabled,
  hasVoucherAdminConfiguration,
  getVoucherAdminCapability
};
