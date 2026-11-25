'use strict';

/**
 * api/admin/struktur-pasar/upload.js
 * Admin-only, same-origin CSRF-checked endpoint to upload updated KSEI
 * Struktur Pasar JSON releases (up to 15 MB), create backup, and invalidate
 * live Struktur Pasar & Insider Network caches.
 */

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

    return json(res, 200, {
      success: true,
      message: 'Data Struktur Pasar KSEI berhasil diperbarui (' + meta.ticker_count + ' emiten).',
      meta
    });
  } catch (err) {
    return json(res, 400, {
      success: false,
      error: (err && err.message) ? err.message : 'Gagal memproses file JSON KSEI.'
    });
  }
};
