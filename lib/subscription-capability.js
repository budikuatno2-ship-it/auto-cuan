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
async function getVoucherAdminCapability(db, env) {
  if (!isVoucherAdminBotEnabled(env)) return { enabled: false, ready: false, reason: 'disabled' };
  if (!db || typeof db.from !== 'function') return { enabled: true, ready: false, reason: 'unavailable' };
  try {
    const result = await db.from('voucher_admin_sessions').select('telegram_user_id').limit(1);
    if (result && !result.error) return { enabled: true, ready: true };
  } catch (_) { /* fail closed */ }
  return { enabled: true, ready: false, reason: 'unavailable' };
}
module.exports = { isSubscriptionFeatureEnabled, getSubscriptionCapability, isVoucherAdminBotEnabled, getVoucherAdminCapability };
