'use strict';

const { createClient } = require('@supabase/supabase-js');
const {
  requireAuthenticatedSession,
  requireAdminSession,
  isSameOrigin
} = require('../lib/admin-session');
const originalHandler = require('../lib/admin-users-handler');

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

async function resolveApprovedAccess(req, res) {
  if (!isSameOrigin(req)) {
    return res.status(403).json({ success: false, error: 'Permintaan ditolak.' });
  }

  const auth = requireAuthenticatedSession(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ success: false, error: 'Status akses belum tersedia.' });
  }

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

function resolvePatternMapAccess(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, allowed: false, error: 'Method not allowed' });
  }

  if (!isSameOrigin(req)) {
    return res.status(403).json({ success: false, allowed: false, error: 'Permintaan ditolak.' });
  }

  const auth = requireAdminSession(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ success: false, allowed: false, error: auth.error });
  }

  if (String(auth.session.un || '').trim().toLowerCase() !== 'budi') {
    return res.status(403).json({ success: false, allowed: false, error: 'Akses admin ditolak.' });
  }

  return res.status(200).json({
    success: true,
    allowed: true,
    access: 'admin',
    username: 'budi',
    expires_at: new Date(auth.session.exp * 1000).toISOString()
  });
}

async function deleteUser(req, res) {
  if (!isSameOrigin(req)) {
    return res.status(403).json({ success: false, error: 'Permintaan ditolak.' });
  }

  const auth = requireAdminSession(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  const targetUsername = String(req.body && req.body.username || '').trim().toLowerCase();
  if (!targetUsername) {
    return res.status(400).json({ success: false, error: 'Username diperlukan.' });
  }
  if (targetUsername === 'budi' || targetUsername === 'review') {
    return res.status(400).json({ success: false, error: 'Akun sistem tidak dapat dihapus.' });
  }

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ success: false, error: 'Database belum dikonfigurasi.' });
  }

  const lookup = await supabase
    .from('app_users')
    .select('id, username')
    .eq('username', targetUsername)
    .maybeSingle();

  if (lookup.error) {
    return res.status(500).json({ success: false, error: 'Gagal mencari akun.' });
  }
  if (!lookup.data) {
    return res.status(404).json({ success: false, error: 'Akun tidak ditemukan.' });
  }

  const userId = lookup.data.id;

  // Remove optional account-linked records first. Missing optional tables are
  // tolerated; the authoritative account row is removed last.
  const optionalTables = [
    'app_user_telegram_verifications',
    'app_user_devices',
    'app_user_sessions'
  ];
  for (const table of optionalTables) {
    try {
      await supabase.from(table).delete().eq('user_id', userId);
    } catch (_) {}
  }

  const removed = await supabase
    .from('app_users')
    .delete()
    .eq('id', userId)
    .select('id, username');

  if (removed.error) {
    console.error('admin delete user error:', removed.error);
    return res.status(409).json({
      success: false,
      error: 'Akun belum bisa dihapus karena masih memiliki data terkait.'
    });
  }

  if (!removed.data || removed.data.length !== 1) {
    return res.status(409).json({ success: false, error: 'Penghapusan akun tidak terkonfirmasi.' });
  }

  return res.status(200).json({
    success: true,
    username: targetUsername,
    message: 'Akun, device ID, dan data verifikasi terkait berhasil dihapus.'
  });
}

module.exports = async function handler(req, res) {
  const action = req && req.body && req.body.action;

  if (action === 'portfolio_access') {
    return resolveApprovedAccess(req, res);
  }

  if (action === 'pattern_map_access') {
    return resolvePatternMapAccess(req, res);
  }

  if (action === 'delete_user') {
    return deleteUser(req, res);
  }

  if (action === 'analytics') {
    const auth = requireAuthenticatedSession(req);
    if (auth.ok && auth.session.adm !== true) {
      return resolveApprovedAccess(req, res);
    }
  }

  return originalHandler(req, res);
};
