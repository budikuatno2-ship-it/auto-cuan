'use strict';

const { createClient } = require('@supabase/supabase-js');
const {
  requireAuthenticatedSession,
  isSameOrigin
} = require('../lib/admin-session');
const originalHandler = require('../lib/admin-users-handler');

async function resolveApprovedAccess(req, res) {
  if (!isSameOrigin(req)) {
    return res.status(403).json({ success: false, error: 'Permintaan ditolak.' });
  }

  const auth = requireAuthenticatedSession(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return res.status(503).json({ success: false, error: 'Status akses belum tersedia.' });
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const result = await supabase
    .from('app_users')
    .select('id, username, is_approved, is_blocked')
    .eq('id', auth.session.uid)
    .maybeSingle();

  if (result.error || !result.data) {
    return res.status(401).json({ success: false, error: 'Sesi tidak valid.' });
  }

  const account = result.data;
  const signedUsername = String(auth.session.un || '').trim().toLowerCase();
  const accountUsername = String(account.username || '').trim().toLowerCase();

  if (!signedUsername || accountUsername !== signedUsername) {
    return res.status(401).json({ success: false, error: 'Sesi tidak valid.' });
  }

  if (account.is_blocked === true) {
    return res.status(403).json({ success: false, error: 'Akun sedang diblokir.' });
  }

  if (account.is_approved !== true) {
    return res.status(403).json({ success: false, error: 'Akun belum di-approve admin.' });
  }

  return res.status(200).json({
    success: true,
    access: 'approved',
    user_id: String(account.id),
    username: accountUsername
  });
}

module.exports = async function handler(req, res) {
  const action = req && req.body && req.body.action;

  if (action === 'portfolio_access') {
    return resolveApprovedAccess(req, res);
  }

  if (action === 'analytics') {
    const auth = requireAuthenticatedSession(req);
    if (auth.ok && auth.session.adm !== true) {
      return resolveApprovedAccess(req, res);
    }
  }

  return originalHandler(req, res);
};
