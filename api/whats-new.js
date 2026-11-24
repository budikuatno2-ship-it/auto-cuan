'use strict';

/**
 * api/whats-new.js
 * ============================================================================
 * V6 (W2a / Feature 13A) — "What's New" release notes API
 * ============================================================================
 * ROUTES (all under /api/whats-new):
 *
 *   GET  /api/whats-new
 *        Authenticated. Returns the latest PUBLISHED release plus whether THIS
 *        user has acknowledged it. Server-side truth — never localStorage.
 *        -> { success, release|null, acknowledged:boolean, version }
 *
 *   POST /api/whats-new/ack
 *        Authenticated + same-origin (CSRF). Idempotent. Body: { release_id }.
 *        -> { success, already_acknowledged:boolean, release_id }
 *
 *   GET  /api/whats-new?admin=1            (admin)
 *        -> { success, releases:[...], version }
 *
 *   POST /api/whats-new?admin=1            (admin + same-origin)
 *        Body: { action: 'draft'|'publish'|'archive'|'rollback', ... }
 *        Optimistic concurrency via `expectedVersion` -> 409 on conflict.
 *        Every action appends an audit record.
 *
 * AUTH / CSRF (matches api/admin/schedule-settings.js):
 *   - Reads require a signed session; admin reads require the admin flag.
 *   - State-changing requests require `isSameOrigin(req)`.
 *   - The actor is ALWAYS the server-signed session identity.
 * ============================================================================
 */

const { requireAuthenticatedSession, requireAdminSession, isSameOrigin } = require('../lib/admin-session');
const store = require('../lib/whats-new-store');
const crypto = require('crypto');

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
      req.on('data', function (c) { raw += String(c); if (raw.length > 131072) { try { req.destroy(); } catch (_) {} } });
      req.on('end', function () { try { resolve(raw ? JSON.parse(raw) : {}); } catch (_) { resolve({}); } });
      req.on('error', function () { resolve({}); });
    } catch (_) { resolve({}); }
  });
}

function hashIp(req) {
  try {
    const ip = (req && req.socket && req.socket.remoteAddress) || (req && req.headers && req.headers['x-forwarded-for']) || '';
    if (!ip) return null;
    return crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 32);
  } catch (_) { return null; }
}

function isAdminRequest(req) {
  const q = (req && req.query) || {};
  return q.admin === '1' || q.admin === 'true' || q.admin === true;
}

/** Public projection of a release (no internal-only fields leak). */
function publicRelease(r) {
  if (!r) return null;
  return {
    release_id: r.release_id,
    version: r.version,
    title: r.title,
    summary: r.summary,
    items: Array.isArray(r.items) ? r.items.slice() : [],
    published_at_wib: r.published_at_wib || null,
    published_by: r.published_by || null,
    status: r.status,
    rollback_of: r.rollback_of || null
  };
}

async function handler(req, res) {
  if (typeof res.setHeader === 'function') res.setHeader('Cache-Control', 'private, no-store');
  const method = String((req && req.method) || 'GET').toUpperCase();
  const q = (req && req.query) || {};
  const sub = String(q.sub || q.action || '').trim().toLowerCase();

  // ---- Admin surface -----------------------------------------------------
  if (isAdminRequest(req)) {
    if (method === 'GET') {
      const auth = requireAdminSession(req);
      if (!auth.ok) return json(res, auth.status || 403, { success: false, error: auth.error || 'Akses admin ditolak.' });
      const list = store.listReleases();
      if (!list.ok) return json(res, 500, { success: false, error: 'Gagal membaca data rilis.' });
      return json(res, 200, { success: true, releases: list.releases.map(publicRelease), version: list.version });
    }

    if (method !== 'POST') return json(res, 405, { success: false, error: 'Method not allowed' });

    if (!isSameOrigin(req)) return json(res, 403, { success: false, error: 'Permintaan ditolak (origin berbeda).' });
    const auth = requireAdminSession(req);
    if (!auth.ok) return json(res, auth.status || 403, { success: false, error: auth.error || 'Akses admin ditolak.' });

    let body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) body = await readJsonBody(req);

    const action = String((body && body.action) || '').trim().toLowerCase();
    const actor = String((auth.session && (auth.session.un || auth.session.uid)) || 'admin');
    const expectedVersion = (body && body.expectedVersion != null) ? Number(body.expectedVersion) : null;
    const now = new Date();

    let result;
    if (action === 'draft' || action === 'create') {
      result = store.createDraft(body, { actor, expectedVersion, now });
    } else if (action === 'publish') {
      result = store.publish(String(body.release_id || ''), { actor, expectedVersion, now });
    } else if (action === 'archive') {
      result = store.archive(String(body.release_id || ''), { actor, expectedVersion, now });
    } else if (action === 'rollback') {
      result = store.rollback(String(body.release_id || body.targetReleaseId || ''), { actor, expectedVersion, now });
    } else {
      return json(res, 400, { success: false, error: 'Aksi admin tidak dikenal: ' + (action || '(kosong)') });
    }

    if (!result.ok) {
      if (result.reason === 'VALIDATION_FAILED') return json(res, 400, { success: false, error: 'Data rilis tidak valid.', details: result.errors });
      if (result.reason === 'CONFLICT') return json(res, 409, { success: false, error: 'Versi rilis berubah di tempat lain. Muat ulang lalu coba lagi.', code: 'VERSION_CONFLICT', version: result.currentVersion });
      if (result.reason === 'NOT_FOUND') return json(res, 404, { success: false, error: 'Rilis tidak ditemukan.' });
      if (result.reason === 'ALREADY_PUBLISHED') return json(res, 409, { success: false, error: 'Rilis sudah berstatus published.' });
      if (result.reason === 'ALREADY_ARCHIVED') return json(res, 409, { success: false, error: 'Rilis sudah berstatus archived.' });
      return json(res, 500, { success: false, error: 'Gagal memproses aksi rilis.', code: result.reason });
    }

    return json(res, 200, { success: true, action, release: publicRelease(result.release), version: result.version });
  }

  // ---- Acknowledgement ---------------------------------------------------
  if (sub === 'ack') {
    if (method !== 'POST') return json(res, 405, { success: false, error: 'Method not allowed' });
    if (!isSameOrigin(req)) return json(res, 403, { success: false, error: 'Permintaan ditolak (origin berbeda).' });
    const auth = requireAuthenticatedSession(req);
    if (!auth.ok) return json(res, auth.status || 401, { success: false, error: auth.error || 'Autentikasi diperlukan.' });

    let body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) body = await readJsonBody(req);

    const releaseId = String((body && body.release_id) || '').trim();
    if (!releaseId) return json(res, 400, { success: false, error: 'release_id wajib diisi.' });

    const result = store.recordAck({
      userId: String(auth.session.uid),
      releaseId,
      deviceHint: (body && body.device_hint) || (req.headers && req.headers['user-agent']) || null,
      ipHash: hashIp(req),
      now: new Date()
    });
    if (!result.ok) return json(res, 400, { success: false, error: 'Gagal mencatat acknowledgement.', code: result.reason });
    return json(res, 200, { success: true, already_acknowledged: result.already_acknowledged === true, release_id: releaseId });
  }

  // ---- Default: latest published release for this user -------------------
  if (method !== 'GET') return json(res, 405, { success: false, error: 'Method not allowed' });
  const auth = requireAuthenticatedSession(req);
  if (!auth.ok) return json(res, auth.status || 401, { success: false, error: auth.error || 'Autentikasi diperlukan.' });

  const latest = store.getLatestPublished();
  if (!latest.ok) return json(res, 500, { success: false, error: 'Gagal membaca data rilis.' });
  if (!latest.release) {
    return json(res, 200, { success: true, release: null, acknowledged: false, version: latest.version });
  }
  const acknowledged = store.hasAck(String(auth.session.uid), latest.release.release_id);
  return json(res, 200, {
    success: true,
    release: publicRelease(latest.release),
    acknowledged,
    version: latest.version
  });
}

module.exports = handler;
module.exports.__test = { publicRelease, isAdminRequest };
