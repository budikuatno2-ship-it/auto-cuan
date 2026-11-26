'use strict';

/**
 * api/admin/struktur-pasar/upload.js
 * Admin-only, same-origin CSRF-checked endpoint to upload updated KSEI
 * Struktur Pasar JSON releases (up to 15 MB), create backup, and invalidate
 * live Struktur Pasar & Insider Network caches.
 */

const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const adminSession = require('../../../lib/admin-session');
const kseiStore = require('../../../lib/ksei-ownership-store');

function triggerPostUploadRefresh() {
  try {
    const strukturPasar = require('../../struktur-pasar');
    if (typeof strukturPasar.invalidateCache === 'function') strukturPasar.invalidateCache();
  } catch (_) {}
  try {
    const caches = require('../../../lib/in-memory-ttl-cache');
    if (caches.hotMarketStructureCache) caches.hotMarketStructureCache.clear();
    if (caches.hotSectorCache) caches.hotSectorCache.clear();
  } catch (_) {}
  if (process.env.NODE_ENV === 'test' || process.env.AUTO_CUAN_SKIP_BG_REFRESH === '1') return false;
  try {
    const cmd = 'node tools/regenerate-local-snapshots.js && node tools/prewarm-daily-cache.js';
    const child = spawn('sh', ['-c', cmd], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      env: process.env
    });
    if (child && typeof child.unref === 'function') child.unref();
    return true;
  } catch (_) {
    return false;
  }
}

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
  if (!adminSession.isSameOrigin(req)) {
    return json(res, 403, { success: false, error: 'Permintaan lintas origin ditolak.' });
  }
  if (req.method !== 'POST') {
    return json(res, 405, { success: false, error: 'Method not allowed' });
  }

  const body = req.body;
  if (!body || (typeof body === 'string' && !body.trim())) {
    return json(res, 400, { success: false, error: 'Payload JSON tidak boleh kosong.' });
  }

  try {
    const rawPayload = (body && typeof body === 'object' && !Array.isArray(body) && body.payload !== undefined)
      ? body.payload
      : body;
    const filename = (body && typeof body === 'object' && body.filename) ? String(body.filename) : 'ksei_upload.json';
    const asOf = (body && typeof body === 'object' && (body.as_of || body.asOf)) ? String(body.as_of || body.asOf).trim() : null;
    const source = (body && typeof body === 'object' && body.source) ? String(body.source).trim() : null;

    const meta = kseiStore.saveUploadedOwnership(rawPayload, {
      filename,
      asOf,
      source,
      uploadedBy: (auth.session && auth.session.un) || 'admin'
    }, ROOT);
    const snapshotRefreshTriggered = triggerPostUploadRefresh();

    return json(res, 200, {
      success: true,
      message: 'Data Struktur Pasar KSEI berhasil diperbarui (' + meta.ticker_count + ' emiten).',
      snapshot_refresh_triggered: snapshotRefreshTriggered,
      meta
    });
  } catch (err) {
    return json(res, 400, {
      success: false,
      error: (err && err.message) ? err.message : 'Gagal memproses file JSON KSEI.'
    });
  }
};
