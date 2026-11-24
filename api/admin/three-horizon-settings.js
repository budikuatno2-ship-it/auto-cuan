'use strict';

const { requireAdminSession, isSameOrigin } = require('../../lib/admin-session');
const store = require('../../lib/three-horizon-config-store');

function json(res, code, body) {
  try {
    res.statusCode = code;
    if (res && typeof res === 'object') res.body = body;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(JSON.stringify(body));
  } catch (_) {}
}

function readJsonBody(req) {
  return new Promise(function (resolve) {
    try {
      if (req.body && typeof req.body === 'object') return resolve(req.body);
      let raw = '';
      req.on('data', function (c) { raw += String(c); if (raw.length > 65536) { try { req.destroy(); } catch (_) {} } });
      req.on('end', function () { try { resolve(raw ? JSON.parse(raw) : {}); } catch (_) { resolve({}); } });
      req.on('error', function () { resolve({}); });
    } catch (_) { resolve({}); }
  });
}

async function handler(req, res) {
  if (typeof res.setHeader === 'function') res.setHeader('Cache-Control', 'private, no-store');
  const method = String((req && req.method) || 'GET').toUpperCase();

  if (method === 'GET') {
    const auth = requireAdminSession(req);
    if (!auth.ok) return json(res, auth.status || 403, { success: false, error: auth.error || 'Akses admin ditolak.' });
    const read = store.get();
    if (!read.ok) return json(res, 500, { success: false, error: read.error || 'Gagal membaca konfigurasi Three-Horizon.' });
    return json(res, 200, { success: true, config: read.doc });
  }

  if (method !== 'PUT' && method !== 'POST') {
    return json(res, 405, { success: false, error: 'Method not allowed' });
  }

  if (!isSameOrigin(req)) {
    return json(res, 403, { success: false, error: 'Permintaan ditolak (origin berbeda).' });
  }
  const auth = requireAdminSession(req);
  if (!auth.ok) return json(res, auth.status || 403, { success: false, error: auth.error || 'Akses admin ditolak.' });

  let body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    body = await readJsonBody(req);
  }
  const patch = (body && body.patch && typeof body.patch === 'object') ? body.patch : body;
  const reason = String((body && body.reason) || 'Pembaruan bobot Three-Horizon Admin Console').trim();

  let expectedVersion = null;
  if (body && body.expectedVersion != null) expectedVersion = Number(body.expectedVersion);
  else if (body && body.version != null) expectedVersion = Number(body.version);
  if (expectedVersion != null && !Number.isInteger(expectedVersion)) {
    return json(res, 400, { success: false, error: 'version harus integer.' });
  }

  const actor = String((auth.session && (auth.session.un || auth.session.uid)) || 'admin').toLowerCase();
  const result = store.put(patch, { actor, reason, expectedVersion, now: new Date() });

  if (!result.ok) {
    if (result.reason === 'VALIDATION_FAILED') {
      return json(res, 400, { success: false, error: 'Konfigurasi Three-Horizon tidak valid.', details: result.errors });
    }
    if (result.reason === 'CONFLICT') {
      return json(res, 409, {
        success: false,
        code: 'CONFIG_VERSION_CONFLICT',
        error: 'Versi konfigurasi berubah di tempat lain. Muat ulang lalu simpan lagi.',
        version: result.currentVersion,
        config: result.doc
      });
    }
    return json(res, 500, { success: false, error: result.error || 'Gagal menyimpan konfigurasi Three-Horizon.' });
  }

  return json(res, 200, {
    success: true,
    ok: true,
    version: result.version,
    readbackOk: result.readbackOk,
    config: result.config
  });
}

module.exports = handler;
module.exports.handler = handler;
