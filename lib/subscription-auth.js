'use strict';

// Server-only identity boundary. Browser headers, localStorage values, and
// client-claimed account metadata are never trusted for website access.

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

// Loads the current account from the signed session identity and rejects stale,
// mismatched, or blocked accounts. This is deliberately read-only.
async function requireNonBlockedUser(req, supabase) {
  const auth = requireUserSession(req);
  if (!auth.ok) return auth;
  const result = await supabase.from('app_users')
    .select('id, username, is_blocked, is_approved')
    .eq('id', auth.user.id)
    .maybeSingle();
  if (result.error || !result.data) return { ok: false, status: 401, error: 'Sesi tidak valid.' };

  const account = result.data;
  const signedUsername = String(auth.user.username || '').trim().toLowerCase();
  const storedUsername = String(account.username || '').trim().toLowerCase();
  if (!signedUsername || storedUsername !== signedUsername) {
    return { ok: false, status: 401, error: 'Sesi tidak valid.' };
  }
  if (account.is_blocked === true) {
    return { ok: false, status: 403, error: 'Akun sedang diblokir.', user: auth.user, account: account };
  }
  return { ok: true, user: auth.user, account: account };
}

// Resolve the server-owned entitlement for the current signed account. This
// returns status information even when the account is Free; callers that guard a
// paid feature must use requirePremiumEntitlement() below.
async function resolvePremiumAccess(req, supabase) {
  if (!supabase || typeof supabase.from !== 'function') {
    return { ok:false, status:503, error:'Status akses tidak tersedia.' };
  }

  let auth;
  try { auth = await requireNonBlockedUser(req, supabase); }
  catch (_) { return { ok:false, status:503, error:'Status akses tidak tersedia.' }; }
  if (!auth.ok) return auth;

  let entitlement;
  try { entitlement = await resolveEntitlements(auth.user, auth.account, supabase); }
  catch (_) { return { ok:false, status:503, error:'Status akses tidak tersedia.' }; }

  return {
    ok:true,
    user:auth.user,
    account:auth.account,
    entitlement,
    premium:entitlement && entitlement.premium === true,
    access_level:entitlement && entitlement.access_level || 'free'
  };
}

// Premium website features are authorized from the server-owned entitlement,
// never from approval state alone. Approval still remains a separate prerequisite
// for normal accounts. Admin `budi`, active trial, active paid plans, and active
// Lifetime all resolve to entitlement.premium=true in entitlements.js.
async function requirePremiumEntitlement(req, supabase) {
  const access = await resolvePremiumAccess(req, supabase);
  if (!access.ok) return access;

  if (access.account.is_approved !== true) {
    return {
      ok:false,
      status:403,
      code:'ACCOUNT_NOT_APPROVED',
      error:'Akun belum di-approve admin.',
      user:access.user,
      account:access.account,
      entitlement:access.entitlement,
      premium:false,
      access_level:access.access_level || 'free'
    };
  }

  if (access.premium !== true) {
    return {
      ok:false,
      status:402,
      code:'SUBSCRIPTION_REQUIRED',
      error:'Subscription aktif diperlukan untuk menggunakan fitur ini.',
      user:access.user,
      account:access.account,
      entitlement:access.entitlement,
      premium:false,
      access_level:access.access_level || 'free'
    };
  }

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
  if(result.error || !result.data || String(result.data.username||'').trim().toLowerCase()!==String(auth.user.username||'').trim().toLowerCase()) return {ok:false,status:401,error:'Sesi tidak valid.'};
  if(result.data.is_blocked === true) return {ok:false,status:403,error:'Akun sedang diblokir.'};
  return {ok:true,user:auth.user,account:result.data,onboarding:auth.onboarding===true};
}

module.exports = {
  getAuthenticatedUser,
  requireUserSession,
  requireNonBlockedUser,
  resolvePremiumAccess,
  requirePremiumEntitlement,
  requireSubscriptionSession,
  requireSubscriptionOnboardingUser
};