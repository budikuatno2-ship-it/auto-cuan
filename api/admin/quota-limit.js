'use strict';

/**
 * api/admin/quota-limit.js
 * ============================================================================
 * ADMIN CONSOLE — Dynamic quota limit setter endpoint (P0-B extension)
 * ============================================================================
 * CONTRACT (fail-closed, no secrets)
 *   GET  /api/admin/quota-limit
 *     -> current quota truth (limit / used / remaining / overage / reset WIB /
 *        source / provider-verified-at / override info) WITHOUT any secret.
 *   POST /api/admin/quota-limit
 *     body: { action: 'set'|'clear', limit?, reason }
 *     - 'set'    requires a positive finite number (NaN/0/negative/absurd
 *                rejected); sets the manual CEILING override only. The
 *                effective limiter can never exceed a currently-fresh verified
 *                provider capacity (lib/quota-limit.js resolveLimit caps it).
 *     - 'clear'  removes the manual override; usage/billing are NEVER touched.
 *     -> sets/clears the override via lib/quota-limit.js and writes an
 *        append-only JSONL audit record (actor, ip, user-agent, prev/new diff,
 *        timestamp).
 *
 * TRANSACTIONALITY (findings 6 / finding 5)
 *   The override is committed to the limit blob, then the audit record is
 *   appended. If the audit append FAILS, the override is ROLLED BACK to its
 *   previous value so there is never an active config change without a
 *   consistent audit trail. If the rollback itself also fails, the request is
 *   still returned as a failure (ok:false) — never reported as success.
 *
 * AUTH / CSRF (reuses the SAME patterns as every other /api/admin/* handler):
 *   - state-changing POST requires `isSameOrigin(req)` AND
 *     `requireAdminSession(req)` (HMAC-signed `ac_sess`, `adm:true`).
 *   - GET (read) requires `requireAdminSession(req)`.
 *
 * ACTOR BINDING
 *   The actor id is ALWAYS the server-signed `session.uid` (+ `session.un`).
 *   Any client-supplied actor field is ignored.
 *
 * SAFETY
 *   An override sets the LIMIT CEILING only. It can NEVER fake usage down,
 *   clear billing, or bypass remaining<=0. Usage/remaining are resolved
 *   independently by lib/quota-limit.js `resolveTruth`.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

const quotaLimit = require('../../lib/quota-limit');
const quotaState = require('../../lib/quota-state');
const { requireAdminSession, isSameOrigin } = require('../../lib/admin-session');

const ROOT = path.resolve(__dirname, '..', '..');
// Test/deploy override: operator or test harness may redirect the audit file.
const AUDIT_LOG_PATH = process.env.QUOTA_LIMIT_AUDIT_LOG_PATH || path.join(ROOT, 'data', 'quota-limit-audit.log.jsonl');

// Absurd-value ceiling (matches config/quota.json dailyLimitOverride cap).
const MAX_OVERRIDE_LIMIT = 1000000;

/* -------------------------------------------------------------------------- */
/* Small helpers (exported for tests)                                          */
/* -------------------------------------------------------------------------- */

function clientIp(req) {
  try {
    const h = (req && req.headers) || {};
    const fwd = h['x-forwarded-for'] || h['X-Forwarded-For'];
    if (fwd) return String(fwd).split(',')[0].trim() || 'unknown';
    if (req && req.socket && req.socket.remoteAddress) return String(req.socket.remoteAddress);
    if (h['x-real-ip']) return String(h['x-real-ip']).trim();
    return 'unknown';
  } catch (_) { return 'unknown'; }
}

function userAgent(req) {
  return String((req && req.headers && req.headers['user-agent']) || '').slice(0, 200);
}

/**
 * Validate a POST body into a normalized override action.
 * Returns { ok, kind, limit } or { ok:false, error }.
 * Rejects NaN / negative / zero / absurd values / non-numeric strings.
 */
function validateOverrideInput(body) {
  const b = body && typeof body === 'object' ? body : {};
  const action = String(b.action || '').trim().toLowerCase();

  let kind = null;
  if (action === 'set' || action === 'set_override') kind = 'set';
  else if (action === 'clear' || action === 'clear_override') kind = 'clear';
  else if (b.limit === null && (b.clear === true || b.clear === 'true' || b.clear === '1')) kind = 'clear';
  else if (!action && Object.prototype.hasOwnProperty.call(b, 'limit')) kind = 'set';

  if (!kind) {
    return { ok: false, error: 'Aksi tidak dikenal: gunakan action set/clear.' };
  }

  if (kind === 'set') {
    const raw = b.limit;
    if (raw === null || raw === undefined || raw === '') {
      return { ok: false, error: 'limit harus angka positif.' };
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      return { ok: false, error: 'limit harus angka positif (NaN/negatif/nol ditolak).' };
    }
    if (n > MAX_OVERRIDE_LIMIT) {
      return { ok: false, error: 'limit melebihi batas wajar (' + MAX_OVERRIDE_LIMIT + ').' };
    }
    return { ok: true, kind: 'set', limit: Math.floor(n) };
  }

  return { ok: true, kind: 'clear', limit: null };
}

/** Require a non-empty reason for BOTH set and clear. */
function validateReason(body) {
  const reason = String((body && body.reason) || '').trim();
  if (!reason) return { ok: false, error: 'Alasan wajib diisi.' };
  return { ok: true, reason: reason.slice(0, 300) };
}

/**
 * Build the public (secret-free) truth payload for GET.
 * Deliberately omits env keys, provider credentials, and any secret-shaped key.
 */
function buildPublicTruth(truth, blob) {
  const b = (blob && typeof blob === 'object') ? blob : {};
  return {
    limit: truth.limit,
    used: truth.used,
    remaining: truth.remaining,
    overage: truth.overage,
    limitKnown: truth.limitKnown === true,
    usageKnown: truth.usageKnown === true,
    measuredZero: truth.measuredZero === true,
    failClosed: truth.ok !== true,
    source: truth.limitSource || truth.source || 'unknown',
    reason: truth.reason || null,
    resetHourWib: truth.resetHourWib != null ? truth.resetHourWib : 0,
    reset: '00:00 WIB',
    tz: truth.tz || 'Asia/Jakarta',
    providerLimitVerifiedAt: b.providerLimitVerifiedAt || null,
    providerLimitSource: b.providerLimitSource || null,
    planExpiresAt: b.planExpiresAt || null,
    override: {
      limit: (b.override && b.override.limit != null) ? b.override.limit : null,
      actor: (b.override && b.override.actor) || null,
      reason: (b.override && b.override.reason) || null,
      setAt: (b.override && b.override.setAt) || null
    }
  };
}

function buildAuditRecord(input) {
  return {
    eventId: 'qlimit-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10),
    eventType: input.kind === 'clear' ? 'QUOTA_LIMIT_OVERRIDE_CLEAR' : 'QUOTA_LIMIT_OVERRIDE_SET',
    timestampIso: new Date(input.now != null ? input.now : Date.now()).toISOString(),
    pid: process.pid,
    actorId: input.actorId || null,
    actorUsername: input.actorUsername || null,
    ip: input.ip || 'unknown',
    userAgent: input.userAgent || '',
    previous: input.previous || null,
    next: input.next || null,
    reason: input.reason || ''
  };
}

function appendAuditRecord(record) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_LOG_PATH), { recursive: true });
    fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(record) + '\n');
    return { ok: true, path: AUDIT_LOG_PATH };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/**
 * V5 FIX 1 — build a fail-closed, operator-actionable read-failure message from
 * a `readLimitBlob()` result whose `ok !== true`. The library only surfaces the
 * original error as a normalized message string, so the kind is classified from
 * that text. Any non-ok read is a hard rejection — never a silent reset to a
 * blank config, and never reported as `success:true`.
 */
function describeReadFailure(result) {
  const text = String((result && result.error) || 'kesalahan pembacaan tidak diketahui');
  const lower = text.toLowerCase();
  if (lower.indexOf('syntaxerror') >= 0 || lower.indexOf('unexpected token') >= 0 ||
      lower.indexOf('in json') >= 0 || lower.indexOf('json.parse') >= 0) {
    return 'Gagal membaca konfigurasi kuota (JSON korup): ' + text;
  }
  if (lower.indexOf('eacces') >= 0 || lower.indexOf('eperm') >= 0 ||
      lower.indexOf('permission denied') >= 0 || lower.indexOf('access is denied') >= 0) {
    return 'Gagal membaca konfigurasi kuota (izin ditolak): ' + text;
  }
  if (lower.indexOf('enoent') >= 0 || lower.indexOf('no such file') >= 0 ||
      lower.indexOf('cannot find') >= 0) {
    return 'Gagal membaca konfigurasi kuota (file hilang): ' + text;
  }
  return 'Gagal membaca konfigurasi kuota (IO error): ' + text;
}

/* -------------------------------------------------------------------------- */
/* Handler                                                                     */
/* -------------------------------------------------------------------------- */

async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');

  const method = String((req && req.method) || 'GET').toUpperCase();

  // GET — read-only truth, admin session required.
  if (method === 'GET') {
    const auth = requireAdminSession(req);
    if (!auth.ok) {
      return res.status(auth.status || 403).json({ success: false, error: auth.error || 'Akses admin ditolak.' });
    }
    try {
      const now = new Date();
      const state = quotaState.readState(now);
      const cfg = quotaState.loadConfig();
      // V5 FIX 1 (fail-closed): read the limit blob ONCE and honor `.ok`. A
      // corrupt/unreadable config must yield an explicit HTTP error, never a
      // blank 200 or `success:true`.
      const read = quotaLimit.readLimitBlob();
      if (read.ok !== true) {
        return res.status(500).json({ success: false, error: describeReadFailure(read) });
      }
      const blob = read.blob;
      // FIX (finding 4): use the REAL quota authority accessor. quota-state.js
      // exposes resolveQuotaTruth() which wraps quota-limit.resolveTruth().
      const truth = quotaState.resolveQuotaTruth({ now, state, config: cfg });
      return res.status(200).json({
        success: true,
        ok: truth.ok === true,
        ...buildPublicTruth(truth, blob)
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: 'Gagal membaca batas kuota.' });
    }
  }

  if (method !== 'POST' && method !== 'PUT') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // State-changing: same-origin + signed admin session.
  if (!isSameOrigin(req)) {
    return res.status(403).json({ success: false, error: 'Permintaan ditolak.' });
  }
  const auth = requireAdminSession(req);
  if (!auth.ok) {
    return res.status(auth.status || 403).json({ success: false, error: auth.error || 'Akses admin ditolak.' });
  }

  let body = req.body;
  if (!body || typeof body !== 'object') {
    body = await readJsonBody(req);
  }

  const parsed = validateOverrideInput(body);
  if (!parsed.ok) {
    return res.status(400).json({ success: false, error: parsed.error });
  }
  const reasonCheck = validateReason(body);
  if (!reasonCheck.ok) {
    return res.status(400).json({ success: false, error: reasonCheck.error });
  }

  const actorId = String((auth.session && auth.session.uid) || '');
  const actorUsername = String((auth.session && auth.session.un) || '').toLowerCase();
  const ip = clientIp(req);
  const ua = userAgent(req);

  // S2 (admin concurrency): the entire override transaction (read previous ->
  // stage in memory -> persist -> append audit -> rollback on failure) runs
  // inside the SAME lockfile critical section used by worker snapshot sync
  // (lib/quota-limit.setProviderLimit). An admin SET/CLEAR can therefore never
  // lose an update to — nor be clobbered by — a concurrent worker snapshot, and
  // the audit rollback restores the exact prior snapshot under the lock.
  const now = new Date();
  let nextBlob = null;

  if (!quotaLimit.acquireLimitLock()) {
    return res.status(503).json({ success: false, error: 'Konfigurasi kuota sedang dipakai proses lain (fail-closed). Silakan coba lagi.' });
  }
  try {
    // Capture the PREVIOUS full configuration for the diff + transactional
    // rollback (P1-03). A full deep copy is kept so the ENTIRE prior config
    // (override limit, actor, reason, setAt) can be restored byte-for-byte.
    //
    // V5 FIX 1 (fail-closed): read the limit blob ONCE and honor `.ok`. Any
    // non-ok read is a hard rejection BEFORE any write / overwrite / delete /
    // audit append. `result.blob` is only used when `ok === true`. We must
    // NEVER silently treat a corrupt prior config as "no prior override" and
    // overwrite it.
    const readResult = quotaLimit.readLimitBlob();
    if (readResult.ok !== true) {
      return res.status(500).json({ success: false, error: describeReadFailure(readResult) });
    }
    const previousBlob = readResult.blob;
    const prevOverrideLimit = previousBlob && previousBlob.override && previousBlob.override.limit != null
      ? previousBlob.override.limit
      : null;
    const previous = { overrideLimit: prevOverrideLimit, effectiveLimit: quotaLimit.resolveLimit({ now }).limit || null };

    // Stage the mutation IN-MEMORY (deep copy) so nothing persists until the
    // whole transaction is durable: persist the new config FIRST, audit SECOND.
    // If either step fails, the previous blob is left or restored intact.
    const candidateBlob = JSON.parse(JSON.stringify(previousBlob));
    let setResult;
    if (parsed.kind === 'clear') {
      setResult = quotaLimit.clearOverride({ now, actor: actorId, reason: reasonCheck.reason, blob: candidateBlob });
    } else {
      setResult = quotaLimit.setOverride({ now, limit: parsed.limit, actor: actorId, reason: reasonCheck.reason, blob: candidateBlob });
    }

    if (!setResult || setResult.ok !== true) {
      return res.status(500).json({ success: false, error: 'Gagal menyimpan override kuota (fail-closed).' });
    }

    // Persistence step. Failure => the previous blob is untouched on disk.
    const persisted = quotaLimit.writeLimitBlob(setResult.blob);
    if (!persisted || persisted.ok !== true) {
      return res.status(500).json({ success: false, error: 'Gagal menyimpan override kuota (fail-closed).' });
    }

    nextBlob = persisted.blob || setResult.blob;
    const next = {
      overrideLimit: (nextBlob && nextBlob.override && nextBlob.override.limit != null) ? nextBlob.override.limit : null,
      effectiveLimit: quotaLimit.resolveLimit({ now }).limit || null
    };

    // Append-only audit. Failure => ROLLBACK to the FULL previous config
    // (P1-03: restoring the prior override value — never re-applying the CLEAR).
    const audit = appendAuditRecord(buildAuditRecord({
      kind: parsed.kind,
      now,
      actorId,
      actorUsername,
      ip,
      userAgent: ua,
      previous,
      next,
      reason: reasonCheck.reason
    }));
    if (!audit.ok) {
      const rollback = quotaLimit.writeLimitBlob(previousBlob);
      // Regardless of rollback success, an unauditable request is a failure.
      return res.status(500).json({
        success: false,
        error: 'Override tersimpan tetapi audit gagal dan telah di-rollback (fail-closed).',
        rolledBack: rollback && rollback.ok === true
      });
    }
  } finally {
    quotaLimit.releaseLimitLock();
  }

  // Re-resolve the truth so the response reflects the new limit.
  let truth;
  try {
    const freshState = quotaState.readState(now);
    const cfg = quotaState.loadConfig();
    truth = quotaLimit.resolveTruth({ now, state: freshState, config: cfg });
  } catch (_) {
    truth = { ok: false, limitSource: 'unknown' };
  }

  return res.status(200).json({
    success: true,
    ok: truth.ok === true,
    action: parsed.kind,
    actor: actorUsername,
    ...buildPublicTruth(truth, nextBlob)
  });
}

function readJsonBody(req) {
  return new Promise(function (resolve) {
    try {
      if (req.body && typeof req.body === 'object') return resolve(req.body);
      let raw = '';
      req.on('data', function (c) { raw += String(c); if (raw.length > 65536) { try { req.destroy(); } catch (_) {} } });
      req.on('end', function () {
        try { resolve(raw ? JSON.parse(raw) : {}); } catch (_) { resolve({}); }
      });
      req.on('error', function () { resolve({}); });
    } catch (_) { resolve({}); }
  });
}

module.exports = handler;
module.exports.handler = handler;
module.exports.validateOverrideInput = validateOverrideInput;
module.exports.validateReason = validateReason;
module.exports.buildPublicTruth = buildPublicTruth;
module.exports.buildAuditRecord = buildAuditRecord;
module.exports.appendAuditRecord = appendAuditRecord;
module.exports.describeReadFailure = describeReadFailure;
module.exports.AUDIT_LOG_PATH = AUDIT_LOG_PATH;
module.exports.MAX_OVERRIDE_LIMIT = MAX_OVERRIDE_LIMIT;