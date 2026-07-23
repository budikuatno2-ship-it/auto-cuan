'use strict';
// Fail closed: subscription capabilities are unavailable unless explicitly enabled.
// This module intentionally reads no other configuration and has no side effects.
function isSubscriptionFeatureEnabled() {
  return process.env.SUBSCRIPTION_FEATURE_ENABLED === 'true';
}
module.exports = { isSubscriptionFeatureEnabled };
