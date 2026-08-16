'use strict';

const { createClient } = require('@supabase/supabase-js');
const { requireAuthenticatedSession, isSameOrigin } = require('./admin-session');
const { resolveEntitlements } = require('./entitlements');
const { getSubscriptionCapability } = require('./subscription-capability');
const accountTerms = require('./account-terms');

function dbClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function iso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

async function optionalSingle(query) {
  try {
    const result = await query.maybeSingle();
    if (!result || result.error) return null;
    return result.data || null;
  } catch (_) {
    return null;
  }
}

async function termsAcceptance(db, userId) {
  try {
    const result = await db.from('account_terms_acceptances')
      .select('terms_version, acceptance_source, accepted_at')
      .eq('user_id', userId)
      .order('accepted_at', { ascending: false })
      .limit(1);
    if (!result || result.error || !Array.isArray(result.data) || !result.data.length) return null;
    const row = result.data[0];
    return {
      version: String(row.terms_version || ''),
      source: String(row.acceptance_source || ''),
      accepted_at: iso(row.accepted_at)
    };
  } catch (_) {
    return null;
  }
}

async function telegramProfile(db, userId) {
  const verification = await optionalSingle(
    db.from('app_user_telegram_verifications')
      .select('telegram_user_id, telegram_verified_at, channel_joined_at')
      .eq('user_id', userId)
  );
  return {
    verified: Boolean(verification && verification.telegram_verified_at),
    telegram_user_id: verification && verification.telegram_user_id != null
      ? String(verification.telegram_user_id)
      : null,
    verified_at: iso(verification && verification.telegram_verified_at),
    channel_joined: Boolean(verification && verification.channel_joined_at),
    channel_joined_at: iso(verification && verification.channel_joined_at)
  };
}

async function subscriptionProfile(db, signedUser, account) {
  let capability = { enabled: false, ready: false };
  try { capability = await getSubscriptionCapability(db); } catch (_) {}

  let entitlement = null;
  if (capability.ready) {
    try { entitlement = await resolveEntitlements(signedUser, account, db); } catch (_) {}
  }

  return {
    enabled: capability.enabled === true,
    ready: capability.ready === true,
    entitlement: entitlement ? {
      access_level: entitlement.access_level || 'free',
      status: entitlement.entitlement_status || 'none',
      source: entitlement.entitlement_source || null,
      current_plan: entitlement.current_plan || null,
      starts_at: iso(entitlement.starts_at),
      expires_at: iso(entitlement.expires_at),
      lifetime: entitlement.lifetime_state === 'active' || entitlement.lifetime_state === 'lifetime',
      trial_state: entitlement.trial_state || 'not_started',
      premium: entitlement.premium === true
    } : null
  };
}

module.exports = async function accountProfileHandler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
  if (!isSameOrigin(req)) return res.status(403).json({ success: false, error: 'Permintaan ditolak.' });

  const auth = requireAuthenticatedSession(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ success: false, error: auth.error || 'Sesi tidak valid.' });

  const db = dbClient();
  if (!db) return res.status(503).json({ success: false, error: 'Profil akun belum tersedia.' });

  const result = await db.from('app_users')
    .select('id, username, is_approved, is_blocked, created_at, last_login_at')
    .eq('id', auth.session.uid)
    .maybeSingle();

  if (result.error || !result.data) return res.status(401).json({ success: false, error: 'Sesi tidak valid.' });
  const account = result.data;
  const signedUsername = String(auth.session.un || '').trim().toLowerCase();
  const storedUsername = String(account.username || '').trim().toLowerCase();
  if (!signedUsername || storedUsername !== signedUsername) {
    return res.status(401).json({ success: false, error: 'Sesi tidak valid.' });
  }
  if (account.is_blocked === true) return res.status(403).json({ success: false, error: 'Akun sedang diblokir.' });

  const signedUser = { id: String(account.id), username: storedUsername, isAdmin: auth.session.adm === true };
  const [terms, telegram, subscription] = await Promise.all([
    termsAcceptance(db, account.id),
    telegramProfile(db, account.id),
    subscriptionProfile(db, signedUser, account)
  ]);

  return res.status(200).json({
    success: true,
    profile: {
      user_id: String(account.id),
      username: storedUsername,
      is_admin: auth.session.adm === true && storedUsername === 'budi',
      approval_status: account.is_approved === true ? 'approved' : 'pending',
      is_approved: account.is_approved === true,
      created_at: iso(account.created_at),
      last_login_at: iso(account.last_login_at),
      telegram,
      terms: {
        current: accountTerms.publicTermsMetadata(),
        accepted: terms
      },
      subscription
    }
  });
};

module.exports.__test = {
  iso,
  termsAcceptance,
  telegramProfile,
  subscriptionProfile
};
