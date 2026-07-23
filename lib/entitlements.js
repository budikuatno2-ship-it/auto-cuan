'use strict';

// Phase 1 is deliberately read-only: subscription tables do not exist yet.
// Keep this shape stable so future billing storage can replace only this module.
function noEntitlement(overrides) {
  return Object.assign({
    access_level: 'free',
    entitlement_status: 'none',
    entitlement_source: 'phase1_default',
    trial_state: 'not_started',
    current_plan: null,
    starts_at: null,
    expires_at: null,
    lifetime_state: 'none',
    premium: false,
    expiry_reason: null
  }, overrides || {});
}

function getEntitlements(user, account) {
  const username = String((account && account.username) || (user && user.username) || '').trim().toLowerCase();
  // This protected account is explicitly owner-approved and wins over all
  // account flags until the entitlement model is introduced.
  if (username === 'budi') {
    return noEntitlement({
      access_level: 'admin', entitlement_status: 'active', entitlement_source: 'protected_admin',
      current_plan: 'admin', lifetime_state: 'lifetime', premium: true
    });
  }
  if (account && account.is_blocked === true) {
    return noEntitlement({ entitlement_status: 'blocked', entitlement_source: 'account_block', expiry_reason: 'account_blocked' });
  }
  return noEntitlement();
}

module.exports = { getEntitlements };
