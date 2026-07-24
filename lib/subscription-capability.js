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
  return typeof source.VOUCHER_ADMIN_TELEGRAM_BOT_TOKEN === 'string' && source.VOUCHER_ADMIN_TELEGRAM_BOT_TOKEN.length >= 16 &&
    typeof source.VOUCHER_CODE_PEPPER === 'string' && source.VOUCHER_CODE_PEPPER.length >= 16;
}

async function getVoucherAdminCapability(db, env) {
  if (!isVoucherAdminBotEnabled(env)) return { enabled: false, ready: false, reason: 'disabled' };
  if (!hasVoucherAdminConfiguration(env)) return { enabled: true, ready: false, reason: 'configuration' };
  if (!db || typeof db.rpc !== 'function') return { enabled: true, ready: false, reason: 'unavailable' };
  try {
    // The version RPC exists only after the lifecycle correction is applied. A
    // table-only probe could incorrectly enable the bot against the incomplete
    // Phase 5C foundation migration.
    const result = await db.rpc('voucher_admin_schema_version');
    if (result && !result.error && result.data === 'phase5c-lifecycle-v2') return { enabled: true, ready: true };
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
