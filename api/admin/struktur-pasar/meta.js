'use strict';

/**
 * api/admin/struktur-pasar/meta.js
 * Returns active KSEI / Struktur Pasar dataset metadata for Admin Console.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const adminSession = require('../../../lib/admin-session');
const kseiStore = require('../../../lib/ksei-ownership-store');

function json(res, code, body) {
  if (typeof res.status === 'function' && typeof res.json === 'function') {
    return res.status(code).json(body);
  }
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  return res.end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  try { res.setHeader('Cache-Control', 'private, no-store'); } catch (_) {}

  const auth = adminSession.requireAdminSession(req);
  if (!auth.ok) {
    return json(res, auth.status || 403, { success: false, error: auth.error || 'Akses admin ditolak.' });
  }
  if (req.method !== 'GET') {
    return json(res, 405, { success: false, error: 'Method not allowed' });
  }

  const meta = kseiStore.getActiveOwnershipMeta(ROOT);
  let backupsCount = 0;
  try {
    const bDir = path.join(ROOT, 'data', 'insider-network', 'backups');
    if (fs.existsSync(bDir)) {
      backupsCount = fs.readdirSync(bDir).filter((f) => f.endsWith('.json')).length;
    }
  } catch (_) {}

  return json(res, 200, {
    success: true,
    meta: Object.assign({}, meta, { backups_count: backupsCount })
  });
};
