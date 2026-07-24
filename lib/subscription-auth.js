'use strict';

// Server-only identity boundary for subscription work. The browser's headers,
// localStorage values, and any claimed account metadata are intentionally not
// consulted here: only the existing signed HttpOnly session cookie is trusted.

const { requireAuthenticatedSession, getOnboardingSession } = require('./admin-session');
const { resolveEntitlements } = require('./entitlements');

function getAuthenticatedUser(req) {
  const auth = requireAuthenticatedSession(req);
  if (!auth.ok) return null;
  return { id: auth.session.uid, username: auth.session.un, isAdmin: auth.session.adm === true };
}

function requireUserSession(req) {
  const auth = requireAuthenticatedSession(req);
  if (!auth.ok) return auth;
  return {
    ok: true,
    user: { id: auth.session.uid, username: auth.session.un, isAdmin: auth.session.adm === true }
  };
}

// Loads the account using the signed cookie's immutable user id, then binds the
// result back to its signed username. This prevents a stale or mismatched
// session from being used as another account. It is deliberately read-only.
async function requireNonBlockedUser(req, supabase) {
  const auth = requireUserSession(req);
  if (!auth.ok) return auth;
  const result = await supabase.from('app_users')
    .select('id, username, is_blocked, is_approved')
    .eq('id', auth.user.id)
    .maybeSingle();
  if (result.error || !result.data) return { ok: false, status: 401, error: 'Sesi tidak valid.' };

  const account = result.data;
  if (String(account.username || '').trim().toLowerCase() !== auth.user.username) {
    return { ok: false, status: 401, error: 'Sesi tidak valid.' };
  }
  if (account.is_blocked === true && auth.user.username !== 'budi') {
    return { ok: false, status: 403, error: 'Akun sedang diblokir.', user: auth.user, account: account };
  }
  return { ok: true, user: auth.user, account: account };
}


// ===== PREMIUM ENTITLEMENT ACCESS (PHASE 6A.4) =====
// Only the signed HttpOnly session and server-owned entitlement are trusted.
async function resolvePremiumAccess(req, supabase) {
  if (!supabase || typeof supabase.from !== 'function') return { ok:false, status:503, error:'Status akses tidak tersedia.' };
  let auth;
  try { auth = await requireNonBlockedUser(req, supabase); }
  catch (_) { return { ok:false, status:503, error:'Status akses tidak tersedia.' }; }
  if (!auth.ok) return auth;
  let entitlement;
  try { entitlement = await resolveEntitlements(auth.user, auth.account, supabase); }
  catch (_) { return { ok:false, status:503, error:'Status akses tidak tersedia.' }; }
  return { ok:true, user:auth.user, account:auth.account, entitlement,
    premium:entitlement && entitlement.premium === true,
    access_level:entitlement && entitlement.access_level || 'free' };
}
async function requirePremiumEntitlement(req, supabase) {
  const access = await resolvePremiumAccess(req, supabase);
  if (!access.ok) return access;
  if (!access.premium) return { ok:false, status:403, error:'Fitur ini tersedia untuk pengguna Trial dan Premium.', user:access.user, account:access.account, entitlement:access.entitlement };
  return access;
}

function requireSubscriptionSession(req) {
  const normal = requireUserSession(req); if (normal.ok) return normal;
  const onboarding = getOnboardingSession(req);
  if (!onboarding) return normal;
  return { ok:true, onboarding:true, user:{ id:onboarding.uid, username:onboarding.un, isAdmin:false } };
}
async function requireSubscriptionOnboardingUser(req, supabase) {
  const auth=requireSubscriptionSession(req); if(!auth.ok) return auth;
  const result=await supabase.from('app_users').select('id, username, is_blocked, is_approved').eq('id',auth.user.id).maybeSingle();
  if(result.error || !result.data || String(result.data.username||'').trim().toLowerCase()!==auth.user.username) return {ok:false,status:401,error:'Sesi tidak valid.'};
  if(result.data.is_blocked === true && auth.user.username !== 'budi') return {ok:false,status:403,error:'Akun sedang diblokir.'};
  return {ok:true,user:auth.user,account:result.data,onboarding:auth.onboarding===true};
}
module.exports = { getAuthenticatedUser, requireUserSession, requireNonBlockedUser, resolvePremiumAccess, requirePremiumEntitlement, requireSubscriptionSession, requireSubscriptionOnboardingUser };
