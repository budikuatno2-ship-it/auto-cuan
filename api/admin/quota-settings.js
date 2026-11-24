'use strict';

/**
 * api/admin/quota-settings.js
 * ============================================================================
 * V6 (Subtask C) — SINGLE AUTHORIZED ADMIN ENDPOINT for operational quota
 *                  configuration (GET / PUT) with CSRF + audit + readback.
 * ============================================================================
 * Corrects audit finding #2: the console used to POST to
 * `/api/admin/quota-settings` (which did not exist in source V6) and only fell
 * back to `/api/admin-users` on a NETWORK error — meaning an HTTP 404 was
 * swallowed. This is now the real, canonical handler.
 *
 * AUTH / CSRF (matches api/admin/quota-limit.js):
 *   - GET  requires a signed admin session (`requireAdminSession`).
 *   - PUT  requires `isSameOrigin(req)` AND `requireAdminSession(req)`.
 *   - The actor id is ALWAYS the server-signed `session.uid` (+ `session.un`);
 *     any client-supplied actor is ignored.
 *
 * FAIL-CLOSED field discipline:
 *   - unknown/null limits are NEVER coerced to 0/18080;
 *   - a legitimate zero (cap 0) is preserved distinctly from `null`.
 *
 * VERSIONING:
 *   - PUT accepts `version` (optimistic concurrency). A stale version yields
 *     409 CONFLICT with the current document so the console can refresh.
 * ============================================================================
 */

const path = require('path');
const { requireAdminSession, isSameOrigin } = require('../../lib/admin-session');
const store = require('../../lib/quota-config-store');
const quotaManager = require('../../lib/quota-manager');

const MAX_OVERRIDE_LIMIT = store.MAX_ADMIN_VALUE;

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

function describeReadFailure(result) {
  const text = String((result && result.error) || 'kesalahan pembacaan tidak diketahui');
  const lower = text.toLowerCase();
  if (lower.indexOf('syntaxerror') >= 0 || lower.indexOf('unexpected token') >= 0 || lower.indexOf('in json') >= 0) {
    return 'Gagal membaca konfigurasi kuota (JSON korup): ' + text;
  }
  if (lower.indexOf('eacces') >= 0 || lower.indexOf('eperm') >= 0) {
    return 'Gagal membaca konfigurasi kuota (izin ditolak): ' + text;
  }
  if (lower.indexOf('enoent') >= 0 || lower.indexOf('no such file') >= 0) {
    return 'Gagal membaca konfigurasi kuota (file hilang): ' + text;
  }
  return 'Gagal membaca konfigurasi kuota (IO error): ' + text;
}

function buildPublicDoc(doc) {
  const d = (doc && typeof doc === 'object') ? doc : {};
  return {
    schemaVersion: d.schemaVersion != null ? d.schemaVersion : 1,
    version: Number.isInteger(Number(d.version)) ? Number(d.version) : 0,
    providerComputed: null,
    configured_operating_cap: d.configuredOperatingCap != null ? d.configuredOperatingCap : (d.dailyLimitOverride != null ? d.dailyLimitOverride : null),
    configuredOperatingCap: d.configuredOperatingCap != null ? d.configuredOperatingCap : null,
    dailyLimitOverride: d.dailyLimitOverride != null ? d.dailyLimitOverride : null,
    planName: d.planName || null,
    planExpiresAt: d.planExpiresAt || null,
    reserveFloorWeekday: d.reserveFloorWeekday != null ? d.reserveFloorWeekday : null,
    dailyReserveFloor: d.reserveFloorWeekday != null ? d.reserveFloorWeekday : null,
    reserveFloorWeekend: d.reserveFloorWeekend != null ? d.reserveFloorWeekend : null,
    weekdayBackfillLimit: d.weekdayBackfillLimit != null ? d.weekdayBackfillLimit : null,
    weekendBackfillLimit: d.weekendBackfillLimit != null ? d.weekendBackfillLimit : null,
    hardStopWIB: d.hardStopWIB || '23:50',
    staleThresholdMinutes: d.staleThresholdMinutes != null ? d.staleThresholdMinutes : 120,
    lowQuotaMode: d.lowQuotaMode === true,
    holidayManualMode: d.holidayManualMode || 'normal',
    holidayManualDateWIB: d.holidayManualDateWIB || null,
    holidayBackfillRemainder: d.holidayBackfillRemainder !== false,
    concurrency: d.concurrency != null ? d.concurrency : 2,
    rateLimit: d.rateLimit != null ? d.rateLimit : 5,
    retryCount: d.retryCount != null ? d.retryCount : 3,
    backoffBaseMs: d.backoffBaseMs != null ? d.backoffBaseMs : 1000,
    priorityOrder: d.priorityOrder || ['broksum-ALL', 'broksum-Foreign', 'insider-tiered', 'candles', 'financial'],
    killSwitch: d.killSwitch === true,
    pausedServices: d.pausedServices || {},
    backfillBudget: d.backfillBudget != null ? d.backfillBudget : null,
    updatedAt: d.updatedAt || null,
    updatedBy: d.updatedBy || null
  };
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
    const audit = store.getAuditHistory(30);
    return json(res, 200, {
      success: true,
      config: buildPublicDoc(read.doc),
      auditHistory: audit && audit.ok ? audit.logs : []
    });
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

  const patch = (body && body.patch && typeof body.patch === 'object') ? body.patch : body;
  const reason = String((body && body.reason) || '').trim();
  if (!reason) return json(res, 400, { success: false, error: 'Alasan wajib diisi.' });

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
      return json(res, 400, { success: false, error: 'Patch kuota tidak valid.', details: result.errors });
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
      return json(res, 503, { success: false, error: 'Konfigurasi kuota sedang dipakai proses lain (fail-closed). Silakan coba lagi.' });
    }
    if (result.reason === 'READ_FAILED') {
      return json(res, 500, { success: false, error: describeReadFailure(result) });
    }
    return json(res, 500, { success: false, error: 'Gagal menyimpan konfigurasi kuota (fail-closed).', code: result.reason });
  }

  try {
    quotaManager.reloadConfig();
  } catch (_) {}

  return json(res, 200, {
    success: true,
    ok: true,
    version: result.version,
    readbackOk: result.readbackOk === true,
    diff: result.diff,
    config: buildPublicDoc(result.doc)
  });
}

module.exports = handler;
module.exports.handler = handler;
module.exports.buildPublicDoc = buildPublicDoc;
module.exports.describeReadFailure = describeReadFailure;
module.exports.MAX_OVERRIDE_LIMIT = MAX_OVERRIDE_LIMIT;