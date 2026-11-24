'use strict';

/**
 * api/admin/schedule-settings.js
 * ============================================================================
 * V6 (Subtask D) — SINGLE AUTHORIZED ADMIN ENDPOINT for the durable scheduler
 *                  config (GET/PUT) with CSRF + validation + audit + version
 *                  conflict (409).
 * ============================================================================
 * AUTH / CSRF (matches api/admin/quota-settings.js):
 *   - GET  requires a signed admin session (`requireAdminSession`).
 *   - PUT  requires `isSameOrigin(req)` AND `requireAdminSession(req)`.
 *   - The actor is ALWAYS the server-signed `session.uid` (+ `session.un`);
 *     any client-supplied actor is ignored.
 *
 * VERSIONING:
 *   - PUT accepts `version`/`expectedVersion` (optimistic concurrency). A stale
 *     version yields 409 CONFLICT with the current doc so the console refreshes.
 *   - A save that would introduce a job-overlap collision is rejected with 409
 *     and a `code: 'SCHEDULE_COLLISION'` plus a `collisions` list.
 *
 * SECRETS:
 *   - CRON_SECRET and provider tokens are NEVER returned to the browser.
 * ============================================================================
 */

const path = require('path');
const { requireAdminSession, isSameOrigin } = require('../../lib/admin-session');
const store = require('../../lib/admin-schedule-store');
const engine = require('../../lib/admin-schedule-engine');

const ROOT = path.resolve(__dirname, '..', '..');

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

function describeReadFailure(result) {
  const text = String((result && result.error) || 'kesalahan pembacaan tidak diketahui');
  return 'Gagal membaca konfigurasi jadwal: ' + text;
}

/**
 * Public projection of the doc + computed next-run preview. NEVER carries
 * secret fields (there are none), but this boundary remains explicit so future
 * secret fields in the store cannot leak through a future blind spread.
 */
function buildPublicDoc(doc, nowOpt) {
  const now = nowOpt instanceof Date ? nowOpt : new Date();
  const extra = {
    collisions: engine.detectCollisions(doc),
    nextRuns: store.JOB_CATALOG.reduce(function (acc, def) {
      const job = doc.jobs[def.key];
      const runs = engine.computeNextRuns(job, now, 5);
      acc[def.key] = runs.map(function (d) { return engine.formatWibIso(d.toISOString()); });
      return acc;
    }, {}),
    nowWIB: engine.wibNowLabel(now),
    catalog: store.JOB_CATALOG.map(function (def) {
      return {
        key: def.key,
        name: def.name,
        category: def.category,
        editable: def.editable === true,
        lockedDefault: def.lockedDefault === true,
        marketDaysOnly: def.marketDaysOnly === true,
        legacy_inactive: def.legacy_inactive === true,
        dependsOn: (def.dependsOn || []).slice(),
        costClass: def.defaultCostClass
      };
    })
  };
  return store.getPublicDoc(doc, extra);
}

async function handler(req, res) {
  if (typeof res.setHeader === 'function') res.setHeader('Cache-Control', 'private, no-store');
  const method = String((req && req.method) || 'GET').toUpperCase();

  // GET — read-only, signed admin session required.
  if (method === 'GET') {
    const auth = requireAdminSession(req);
    if (!auth.ok) return json(res, auth.status || 403, { success: false, error: auth.error || 'Akses admin ditolak.' });
    const read = store.get();
    if (!read.ok) return json(res, 500, { success: false, error: describeReadFailure(read) });
    return json(res, 200, { success: true, config: buildPublicDoc(read.doc) });
  }

  if (method !== 'PUT' && method !== 'POST') {
    return json(res, 405, { success: false, error: 'Method not allowed' });
  }

  // State-changing: same-origin + signed admin session.
  if (!isSameOrigin(req)) {
    return json(res, 403, { success: false, error: 'Permintaan ditolak (origin berbeda).' });
  }
  const auth = requireAdminSession(req);
  if (!auth.ok) return json(res, auth.status || 403, { success: false, error: auth.error || 'Akses admin ditolak.' });

  let body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    body = await readJsonBody(req);
  }

  const patch = (body && body.patch && typeof body.patch === 'object' && !Array.isArray(body.patch)) ? body.patch : body;
  const reason = String((body && body.reason) || '').trim();
  if (!reason) return json(res, 400, { success: false, error: 'Alasan wajib diisi.' });

  // action: 'restore' -> rollback to a previous version (history preserved).
  const action = String((body && body.action) || 'save').trim().toLowerCase();
  if (action === 'restore') {
    const targetVersion = Number(body.targetVersion);
    if (!Number.isInteger(targetVersion) || targetVersion < 0) {
      return json(res, 400, { success: false, error: 'targetVersion harus integer >= 0.' });
    }
    const actorId = String((auth.session && auth.session.uid) || '');
    const actorUsername = String((auth.session && auth.session.un) || '').toLowerCase();
    const actor = actorUsername || actorId || 'admin';
    const result = store.restoreVersion(targetVersion);
    if (!result.ok) {
      if (result.reason === 'NOT_FOUND') return json(res, 404, { success: false, error: result.error });
      if (result.reason === 'LOCK_BUSY') return json(res, 503, { success: false, error: 'Konfigurasi jadwal sedang dipakai proses lain (fail-closed).' });
      return json(res, 500, { success: false, error: 'Gagal restore (fail-closed).', code: result.reason });
    }
    return json(res, 200, {
      success: true,
      ok: true,
      restoredFromVersion: targetVersion,
      version: result.doc.version,
      readbackOk: result.readbackOk === true,
      config: buildPublicDoc(result.doc)
    });
  }

  // Optimistic concurrency: accept `version` or `expectedVersion`.
  let expectedVersion = null;
  if (body && body.expectedVersion != null) expectedVersion = Number(body.expectedVersion);
  else if (body && body.version != null) expectedVersion = Number(body.version);
  if (expectedVersion != null && !Number.isInteger(expectedVersion)) {
    return json(res, 400, { success: false, error: 'version harus integer.' });
  }

  const actorId = String((auth.session && auth.session.uid) || '');
  const actorUsername = String((auth.session && auth.session.un) || '').toLowerCase();
  const actor = actorUsername || actorId || 'admin';

  const result = store.put(patch, { actor, reason, expectedVersion, now: new Date() });

  if (!result.ok) {
    if (result.reason === 'VALIDATION_FAILED') {
      return json(res, 400, { success: false, error: 'Patch jadwal tidak valid.', details: result.errors });
    }
    if (result.reason === 'COLLISION') {
      return json(res, 409, {
        success: false,
        error: 'Jadwal bentrok (overlap) dengan job lain. Kurangi durasi atau geser jam.',
        code: 'SCHEDULE_COLLISION',
        collisions: result.collisions,
        config: buildPublicDoc(result.doc)
      });
    }
    if (result.reason === 'LEGACY_DUPLICATE') {
      // V6 (Subtask F) P0-07: patch would duplicate an ACTIVE legacy executor
      // (cron/PM2/systemd) of the same side-effect class => double broker-API
      // burn / double publish. Rejected until the approved cutover retires the
      // legacy slot (see lib/schedule-control-plane.js CUTOVER_PLAN_MD).
      return json(res, 409, {
        success: false,
        error: 'Jadwal menduplikasi executor lama (cron/PM2) yang masih ACTIVE. Cutover butuh approval.',
        code: 'LEGACY_DUPLICATE',
        legacyDuplicates: result.legacyDuplicates,
        config: buildPublicDoc(result.doc)
      });
    }
    if (result.reason === 'CONFLICT') {
      return json(res, 409, {
        success: false,
        error: 'Versi konfigurasi berubah di tempat lain. Muat ulang lalu coba lagi.',
        code: 'CONFIG_VERSION_CONFLICT',
        version: result.currentVersion,
        config: buildPublicDoc(result.doc)
      });
    }
    if (result.reason === 'LOCK_BUSY') {
      return json(res, 503, { success: false, error: 'Konfigurasi jadwal sedang dipakai proses lain (fail-closed). Silakan coba lagi.' });
    }
    if (result.reason === 'READ_FAILED') {
      return json(res, 500, { success: false, error: describeReadFailure(result) });
    }
    return json(res, 500, { success: false, error: 'Gagal menyimpan konfigurasi jadwal (fail-closed).', code: result.reason });
  }

  const preview = engine.detectCollisions(result.doc);
  return json(res, 200, {
    success: true,
    ok: true,
    version: result.version,
    readbackOk: result.readbackOk === true,
    diff: result.diff,
    collisions: preview,
    nextRuns: store.JOB_CATALOG.reduce(function (acc, def) {
      const job = result.doc.jobs[def.key];
      const runs = engine.computeNextRuns(job, new Date(), 5);
      acc[def.key] = runs.map(function (d) { return engine.formatWibIso(d.toISOString()); });
      return acc;
    }, {}),
    config: buildPublicDoc(result.doc)
  });
}

module.exports = handler;
module.exports.handler = handler;
module.exports.buildPublicDoc = buildPublicDoc;
module.exports.describeReadFailure = describeReadFailure;
module.exports.ROOT = ROOT;