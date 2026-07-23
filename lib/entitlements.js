'use strict';

// This module is intentionally read-only. Entitlement activation, revocation,
// and trial issuance belong to later, service-only workflows.
const TRIAL_DURATION_HOURS = 10 * 24;
const TRIAL_DURATION_MS = TRIAL_DURATION_HOURS * 60 * 60 * 1000;

function noEntitlement(overrides) {
  return Object.assign({
    access_level: 'free', entitlement_status: 'none', entitlement_source: null,
    trial_state: 'not_started', current_plan: null, starts_at: null,
    expires_at: null, lifetime_state: 'none', premium: false, expiry_reason: null
  }, overrides || {});
}

function iso(value) { return value == null ? null : new Date(value).toISOString(); }
function isActive(row, now) {
  const start = new Date(row.starts_at).getTime();
  const end = row.expires_at == null ? null : new Date(row.expires_at).getTime();
  return row.status === 'active' && Number.isFinite(start) && start <= now &&
    (row.lifetime === true ? end === null : Number.isFinite(end) && now < end);
}
function pick(rows, predicate) {
  return rows.filter(predicate).sort((a, b) => new Date(b.starts_at) - new Date(a.starts_at))[0] || null;
}
function safeEntitlement(row, trialState) {
  return noEntitlement({
    access_level: 'premium', entitlement_status: 'active', entitlement_source: row.source,
    trial_state: trialState || 'not_started', current_plan: row.plan_code,
    starts_at: iso(row.starts_at), expires_at: iso(row.expires_at),
    lifetime_state: row.lifetime ? 'active' : 'none', premium: true
  });
}

function getEntitlements(user, account, rows, nowValue) {
  const username = String((account && account.username) || (user && user.username) || '').trim().toLowerCase();
  if (username === 'budi') return noEntitlement({
    access_level: 'admin', entitlement_status: 'active', entitlement_source: 'protected_admin',
    current_plan: 'admin', lifetime_state: 'lifetime', premium: true
  });
  if (account && account.is_blocked === true) return noEntitlement({
    entitlement_status: 'blocked', entitlement_source: 'account_block', expiry_reason: 'account_blocked'
  });
  const all = Array.isArray(rows) ? rows : [];
  const now = nowValue instanceof Date ? nowValue.getTime() : (nowValue || Date.now());
  const lifetime = pick(all, r => r.lifetime === true && isActive(r, now));
  if (lifetime) return safeEntitlement(lifetime);
  const term = pick(all, r => r.lifetime !== true && r.source !== 'trial' && isActive(r, now));
  if (term) return safeEntitlement(term);
  const trial = pick(all, r => r.source === 'trial' && isActive(r, now));
  if (trial) return safeEntitlement(trial, 'active');
  const anyTrial = pick(all, r => r.source === 'trial');
  return noEntitlement({ trial_state: anyTrial ? 'expired' : 'not_started', expiry_reason: anyTrial ? 'trial_expired' : null });
}

async function resolveEntitlements(user, account, supabase, nowValue) {
  // Compatibility fallback is free-only if Phase 2 has not been migrated. Never
  // turn a storage error into premium access.
  // Old unit-test/local fixtures commonly use non-UUID ids; app_users uses UUID
  // in production, so retain the Phase 1 free-only compatibility path there.
  if (!supabase || !account || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(account.id || ''))) return getEntitlements(user, account);
  const result = await supabase.from('user_entitlements')
    .select('plan_code, source, status, starts_at, expires_at, lifetime')
    .eq('user_id', account.id);
  return getEntitlements(user, account, result && !result.error ? result.data : [], nowValue);
}

module.exports = { TRIAL_DURATION_HOURS, TRIAL_DURATION_MS, noEntitlement, getEntitlements, resolveEntitlements };
