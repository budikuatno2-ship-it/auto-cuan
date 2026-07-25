'use strict';

const { requireAuthenticatedSession } = require('../../lib/admin-session');
const service = require('../../lib/telegram-membership-service');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  const auth = requireAuthenticatedSession(req);
  if (!auth.ok) return res.status(auth.status).json({ allowed: false, message: 'Silakan masuk terlebih dahulu.' });
  if (auth.session.adm) return res.status(200).json({ allowed: true, reason: 'admin' });
  const result = await service.rpc('membership_dashboard_access', { p_user_id: auth.session.uid });
  if (!result || result.allowed !== true) return res.status(403).json({ allowed: false, message: 'Dashboard terkunci. Verifikasi dan aktifkan paket Lifetime melalui bot utama Auto-Cuan.' });
  return res.status(200).json({ allowed: true, reason: 'lifetime' });
};
