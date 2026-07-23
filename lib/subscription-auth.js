'use strict';

// Server-only identity boundary for subscription work. The browser's headers,
// localStorage values, and any claimed account metadata are intentionally not
// consulted here: only the existing signed HttpOnly session cookie is trusted.

const { requireAuthenticatedSession } = require('./admin-session');

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

module.exports = { getAuthenticatedUser, requireUserSession, requireNonBlockedUser };
