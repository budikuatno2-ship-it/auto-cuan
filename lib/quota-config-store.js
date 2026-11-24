'use strict';

/**
 * lib/quota-config-store.js
 * ============================================================================
 * V6 (Subtask C) — DURABLE, VERSIONED OPERATIONAL QUOTA CONFIG STORE
 * ============================================================================
 * WHY THIS EXISTS
 *   The admin console needs ONE authorized read/write path for operational
 *   quota configuration. The legacy path (`lib/quota-state.saveConfig`) wrote
 *   `config/quota.json` directly with an actor string that the caller supplied
 *   (in some routes a hardcoded 'budi'), had no optimistic-concurrency version,
 *   no structured prev/next diff, and no readback guarantee. Fail-closed
 *   discipline means a config change must be:
 *     1. validated server-side,
 *     2. atomically + durably persisted (temp + rename under a lockfile),
 *     3. accompanied by an append-only audit record (actor, reason, timestamp,
 *        version, full previous/next diff),
 *     4. read back from disk and compared for a torn/deceptive write.
 *
 * WHAT THIS STORE OWNS
 *   Only ADMINISTRATIVE/OPERATIONAL knobs (reserve floors, backfill caps, plan
 *   expiry metadata, hard-stop, holiday switches, ceiling overrides). It DOES
 *   NOT write provider truth (provider_limit/used/remaining): those come from
 *   `lib/quota-limit.js` (provider snapshot / manual ceiling override).
 *
 * PERSISTENCE
 *   data/quota-ops-config.json  (or QUOTA_OPS_CONFIG_PATH in tests)
 *   data/quota-ops-audit.log.jsonl (or QUOTA_OPS_AUDIT_PATH)
 *   The store NEVER writes the in-repo config/quota.json; it only READS it as a
 *   validation/schema reference so this module is safe to exercise in tests.
 *
 * FIELD DISCIPLINE (never coerce unknown -> 0)
 *   The canonical contract distinguishes MEASURED ZERO from MISSING/UNKNOWN.
 *   `null` means UNKNOWN; only a concrete finite number means KNOWN.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

function getStorePath() {
  return process.env.QUOTA_OPS_CONFIG_PATH || path.join(ROOT, 'data', 'quota-ops-config.json');
}
function getAuditPath() {
  return process.env.QUOTA_OPS_AUDIT_PATH || path.join(ROOT, 'data', 'quota-ops-audit.log.jsonl');
}
function getLockPath() {
  return getStorePath() + '.lock';
}
const STALE_LOCK_MS = 10 * 1000;

// Conservative cap for an admin-supplied ceiling / backfill / floor.
const MAX_ADMIN_VALUE = 1000000;

function toIso(now) {
  const d = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function blankDoc() {
  return {
    schemaVersion: 1,
    version: 0,
    configuredOperatingCap: null,
    dailyLimitOverride: null,
    planName: null,
    planExpiresAt: null,
    reserveFloorWeekday: null,
    reserveFloorWeekend: null,
    weekdayBackfillLimit: null,
    weekendBackfillLimit: null,
    hardStopWIB: '23:50',
    staleThresholdMinutes: 120,
    lowQuotaMode: false,
    holidayManualMode: 'normal',
    holidayManualDateWIB: null,
    holidayBackfillRemainder: true,
    concurrency: 2,
    rateLimit: 5,
    retryCount: 3,
    backoffBaseMs: 1000,
    priorityOrder: ['broksum-ALL', 'broksum-Foreign', 'insider-tiered', 'candles', 'financial'],
    killSwitch: false,
    pausedServices: {
      all: false,
      backfill: false,
      broksum: false,
      foreign: false,
      insider: false,
      candles: false,
      financial: false
    },
    backfillBudget: null,
    updatedAt: null,
    updatedBy: null
  };
}

function normalizeDoc(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return blankDoc();
  const base = blankDoc();
  for (const k of Object.keys(base)) {
    if (k === 'version') continue;
    if (Object.prototype.hasOwnProperty.call(doc, k)) base[k] = doc[k];
  }
  base.version = Number.isInteger(Number(doc.version)) && Number(doc.version) >= 0 ? Number(doc.version) : 0;
  return base;
}

/* -------------------------------------------------------------------------- */
/* Validation (server-side; reuses the battle-tested quota-state validator)    */
/* -------------------------------------------------------------------------- */

/**
 * Canonicalize an admin patch into the store's field names.
 * Accepts both the new `configured_operating_cap` and legacy `maxQuota` /
 * `dailyLimitOverride` spellings.
 */
function canonicalizePatch(patch) {
  const src = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const out = {};
  const copy = (from, to) => { if (from in src) out[to] = src[from]; };

  if ('configured_operating_cap' in src || 'configuredOperatingCap' in src) {
    out.configuredOperatingCap = src.configured_operating_cap != null ? src.configured_operating_cap : src.configuredOperatingCap;
  }
  if ('dailyReserveFloor' in src || 'mandatoryReserveFloor' in src) {
    out.reserveFloorWeekday = src.dailyReserveFloor != null ? src.dailyReserveFloor : src.mandatoryReserveFloor;
  }
  if ('backfillBudget' in src || 'backfill_budget' in src) {
    out.backfillBudget = src.backfillBudget != null ? src.backfillBudget : src.backfill_budget;
  }
  if ('concurrency' in src) out.concurrency = src.concurrency;
  if ('rateLimit' in src || 'rate_limit' in src) out.rateLimit = src.rateLimit != null ? src.rateLimit : src.rate_limit;
  if ('retryCount' in src || 'retry_count' in src) out.retryCount = src.retryCount != null ? src.retryCount : src.retry_count;
  if ('backoffBaseMs' in src || 'backoff_base_ms' in src) out.backoffBaseMs = src.backoffBaseMs != null ? src.backoffBaseMs : src.backoff_base_ms;
  if ('priorityOrder' in src || 'priority_order' in src) out.priorityOrder = src.priorityOrder != null ? src.priorityOrder : src.priority_order;
  if ('killSwitch' in src || 'kill_switch' in src) out.killSwitch = src.killSwitch != null ? src.killSwitch : src.kill_switch;
  if ('pausedServices' in src || 'paused_services' in src) out.pausedServices = src.pausedServices != null ? src.pausedServices : src.paused_services;

  copy('dailyLimitOverride', 'dailyLimitOverride');
  copy('planName', 'planName');
  copy('planExpiresAt', 'planExpiresAt');
  copy('maxQuota', 'dailyLimitOverride');
  copy('reserveFloorWeekday', 'reserveFloorWeekday');
  copy('reserveFloorWeekend', 'reserveFloorWeekend');
  copy('weekdayBackfillLimit', 'weekdayBackfillLimit');
  copy('weekendBackfillLimit', 'weekendBackfillLimit');
  copy('hardStopWIB', 'hardStopWIB');
  copy('staleThresholdMinutes', 'staleThresholdMinutes');
  copy('lowQuotaMode', 'lowQuotaMode');
  copy('holidayManualMode', 'holidayManualMode');
  copy('holidayManualDateWIB', 'holidayManualDateWIB');
  copy('holidayBackfillRemainder', 'holidayBackfillRemainder');
  return out;
}

function isUnknown(v) { return v === null || v === undefined || v === ''; }

function validatePatch(patch) {
  const errors = [];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, errors: ['Patch harus objek.'] };
  }
  const keys = Object.keys(patch);
  if (keys.length === 0) return { ok: false, errors: ['Patch kosong.'] };

  const KNOWN = ['configuredOperatingCap', 'dailyLimitOverride', 'planName', 'planExpiresAt',
    'reserveFloorWeekday', 'reserveFloorWeekend', 'weekdayBackfillLimit', 'weekendBackfillLimit',
    'hardStopWIB', 'staleThresholdMinutes', 'lowQuotaMode', 'holidayManualMode',
    'holidayManualDateWIB', 'holidayBackfillRemainder',
    'concurrency', 'rateLimit', 'retryCount', 'backoffBaseMs', 'priorityOrder',
    'killSwitch', 'pausedServices', 'backfillBudget'];

  for (const k of keys) {
    if (!KNOWN.includes(k)) {
      errors.push('Kunci tidak dikenal: ' + k);
      continue;
    }
    const v = patch[k];
    if (isUnknown(v)) {
      // Allowed only for optional nullable fields; zero/unknown are distinct.
      if (!['configuredOperatingCap', 'dailyLimitOverride', 'planExpiresAt', 'holidayManualDateWIB', 'backfillBudget', 'weekendBackfillLimit'].includes(k)) {
        errors.push(k + ' tidak boleh null/kosong (bedakan dari missing).');
      }
      continue;
    }
    if (['configuredOperatingCap', 'dailyLimitOverride', 'reserveFloorWeekday', 'reserveFloorWeekend',
      'weekdayBackfillLimit', 'weekendBackfillLimit', 'staleThresholdMinutes', 'backfillBudget'].includes(k)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > MAX_ADMIN_VALUE) {
        errors.push(k + ' harus angka 0..' + MAX_ADMIN_VALUE + '.');
      } else if (k === 'configuredOperatingCap' && n === 0) {
        // cap 0 is legal: it hard-blocks all consumption.
      }
    }
    if (k === 'concurrency') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 50) errors.push('concurrency harus integer 1..50.');
    }
    if (k === 'rateLimit') {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0 || n > 100) errors.push('rateLimit harus angka 0.1..100 req/sec.');
    }
    if (k === 'retryCount') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 20) errors.push('retryCount harus integer 0..20.');
    }
    if (k === 'backoffBaseMs') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 100 || n > 60000) errors.push('backoffBaseMs harus integer 100..60000 ms.');
    }
    if (k === 'priorityOrder') {
      if (!Array.isArray(v) || v.length === 0 || !v.every(x => typeof x === 'string' && x.trim())) {
        errors.push('priorityOrder harus array string non-kosong.');
      }
    }
    if (k === 'pausedServices') {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        errors.push('pausedServices harus objek pemetaan layanan.');
      }
    }
    if (k === 'hardStopWIB' && !/^\d{2}:\d{2}$/.test(String(v))) errors.push('hardStopWIB harus format HH:MM.');
    if (k === 'holidayManualMode' && !['normal', 'libur', 'buka'].includes(String(v))) errors.push('holidayManualMode harus normal/libur/buka.');
    if (k === 'holidayManualDateWIB' && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) errors.push('holidayManualDateWIB harus YYYY-MM-DD.');
    if (k === 'planExpiresAt' && !Number.isFinite(Date.parse(String(v)))) errors.push('planExpiresAt harus tanggal ISO valid.');
    if (k === 'planName' && (typeof v !== 'string' || !v.trim() || v.length > 80)) errors.push('planName harus string 1..80 karakter.');
    for (const b of ['lowQuotaMode', 'holidayBackfillRemainder', 'killSwitch']) {
      if (k === b && !(v === true || v === false || v === 0 || v === 1 || v === 'true' || v === 'false')) {
        errors.push(b + ' harus boolean.');
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/* -------------------------------------------------------------------------- */
/* Persistence (atomic + lock)                                                 */
/* -------------------------------------------------------------------------- */

function readStore() {
  const storePath = getStorePath();
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    const parsed = JSON.parse(raw);
    return { ok: true, doc: normalizeDoc(parsed), error: null };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, doc: blankDoc(), error: null };
    return { ok: false, doc: blankDoc(), error: String((err && err.message) || err) };
  }
}

function writeStoreAtomic(doc) {
  const storePath = getStorePath();
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const tmp = storePath + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, storePath);
  return true;
}

function acquireLock() {
  const lockPath = getLockPath();
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (_) {
    try {
      const st = fs.statSync(lockPath);
      if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
        fs.unlinkSync(lockPath);
        const fd = fs.openSync(lockPath, 'wx');
        fs.writeFileSync(fd, String(process.pid));
        fs.closeSync(fd);
        return true;
      }
    } catch (_) {}
    return false;
  }
}

function releaseLock() {
  try { fs.unlinkSync(getLockPath()); } catch (_) {}
}

function appendAudit(record) {
  const auditPath = getAuditPath();
  try {
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.appendFileSync(auditPath, JSON.stringify(record) + '\n');
    return true;
  } catch (_) { return false; }
}

/**
 * Compute a human- + machine-friendly diff of the changed fields.
 */
function computeDiff(prevDoc, nextDoc) {
  const prev = normalizeDoc(prevDoc);
  const next = normalizeDoc(nextDoc);
  const fields = [
    'configuredOperatingCap', 'dailyLimitOverride', 'planName', 'planExpiresAt',
    'reserveFloorWeekday', 'reserveFloorWeekend', 'weekdayBackfillLimit',
    'weekendBackfillLimit', 'hardStopWIB', 'staleThresholdMinutes', 'lowQuotaMode',
    'holidayManualMode', 'holidayManualDateWIB', 'holidayBackfillRemainder',
    'concurrency', 'rateLimit', 'retryCount', 'backoffBaseMs', 'priorityOrder',
    'killSwitch', 'pausedServices', 'backfillBudget'
  ];
  const changed = [];
  for (const f of fields) {
    if (JSON.stringify(prev[f]) !== JSON.stringify(next[f])) {
      changed.push({ field: f, previous: prev[f], next: next[f] });
    }
  }
  return changed;
}

/**
 * Get the current document + version WITHOUT mutating anything.
 */
function get() {
  const r = readStore();
  return r;
}

/**
 * Durable, versioned, audited, read-back config write.
 * put(patch, { actor, reason, expectedVersion, now })
 *   -> { ok:true, doc, previous, diff, readbackOk } or
 *      { ok:false, reason:'CONFLICT'|'VALIDATION_FAILED'|'READ_FAILED'|
 *                              'LOCK_BUSY'|'WRITE_FAILED'|'AUDIT_FAILED'
 *                              |'READBACK_FAILED', ... }
 *
 * `expectedVersion` enforces optimistic concurrency (null => unconditional).
 */
function put(rawPatch, ctx) {
  const o = ctx || {};
  const patch = canonicalizePatch(rawPatch);
  const v = validatePatch(patch);
  if (!v.ok) return { ok: false, reason: 'VALIDATION_FAILED', errors: v.errors };

  if (!acquireLock()) return { ok: false, reason: 'LOCK_BUSY' };

  try {
    const prevRead = readStore();
    if (!prevRead.ok) return { ok: false, reason: 'READ_FAILED', error: prevRead.error };

    const current = prevRead.doc;
    if (o.expectedVersion != null && Number(o.expectedVersion) !== current.version) {
      return {
        ok: false,
        reason: 'CONFLICT',
        expectedVersion: Number(o.expectedVersion),
        currentVersion: current.version,
        doc: current
      };
    }

    // Build the next document (full copy; never lossy).
    const next = normalizeDoc(current);
    for (const k of Object.keys(patch)) {
      if (isUnknown(patch[k]) && ['configuredOperatingCap', 'dailyLimitOverride', 'planExpiresAt', 'holidayManualDateWIB', 'backfillBudget', 'weekendBackfillLimit'].includes(k)) {
        next[k] = null;
      } else if (['configuredOperatingCap', 'dailyLimitOverride', 'reserveFloorWeekday', 'reserveFloorWeekend',
        'weekdayBackfillLimit', 'weekendBackfillLimit', 'staleThresholdMinutes', 'backfillBudget'].includes(k)) {
        next[k] = patch[k] == null ? null : Math.floor(Number(patch[k]));
      } else if (k === 'concurrency' || k === 'retryCount' || k === 'backoffBaseMs') {
        next[k] = Math.floor(Number(patch[k]));
      } else if (k === 'rateLimit') {
        next[k] = Number(patch[k]);
      } else if (k === 'killSwitch') {
        next[k] = Boolean(patch[k] === true || patch[k] === 'true');
      } else if (k === 'priorityOrder' && Array.isArray(patch[k])) {
        next[k] = patch[k].map(function (s) { return String(s).trim(); });
      } else if (k === 'pausedServices' && typeof patch[k] === 'object' && patch[k]) {
        next[k] = Object.assign({}, next.pausedServices || {}, patch[k]);
      } else {
        next[k] = patch[k];
      }
    }
    next.version = current.version + 1;
    next.updatedAt = toIso(o.now);
    next.updatedBy = String(o.actor || 'admin');

    let wrote = false;
    try { wrote = writeStoreAtomic(next); } catch (_) { wrote = false; }
    if (!wrote) return { ok: false, reason: 'WRITE_FAILED' };

    // Durability read-back: re-read the file and confirm the version matches.
    const readback = readStore();
    const readbackOk = readback.ok === true && readback.doc.version === next.version;

    const diff = computeDiff(current, next);
    const nowMs = o.now ? (o.now instanceof Date ? o.now.getTime() : Number(o.now)) : Date.now();
    const wibShifted = new Date(nowMs + 7 * 3600 * 1000);
    const timestampWIB = wibShifted.toISOString().replace('T', ' ').slice(0, 19) + ' WIB';

    const auditRecord = {
      eventId: 'qops-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex'),
      eventType: 'QUOTA_OPS_CONFIG_SAVE',
      timestampIso: toIso(o.now),
      timestampWIB: timestampWIB,
      pid: process.pid,
      actor: String(o.actor || 'admin'),
      reason: String(o.reason || '').slice(0, 300),
      version: next.version,
      previousVersion: current.version,
      previous: {
        configuredOperatingCap: current.configuredOperatingCap,
        dailyLimitOverride: current.dailyLimitOverride,
        planName: current.planName,
        planExpiresAt: current.planExpiresAt,
        reserveFloorWeekday: current.reserveFloorWeekday,
        reserveFloorWeekend: current.reserveFloorWeekend,
        weekdayBackfillLimit: current.weekdayBackfillLimit,
        weekendBackfillLimit: current.weekendBackfillLimit,
        hardStopWIB: current.hardStopWIB,
        concurrency: current.concurrency,
        rateLimit: current.rateLimit,
        retryCount: current.retryCount,
        backoffBaseMs: current.backoffBaseMs,
        priorityOrder: current.priorityOrder,
        killSwitch: current.killSwitch,
        pausedServices: current.pausedServices,
        backfillBudget: current.backfillBudget
      },
      next: {
        configuredOperatingCap: next.configuredOperatingCap,
        dailyLimitOverride: next.dailyLimitOverride,
        planName: next.planName,
        planExpiresAt: next.planExpiresAt,
        reserveFloorWeekday: next.reserveFloorWeekday,
        reserveFloorWeekend: next.reserveFloorWeekend,
        weekdayBackfillLimit: next.weekdayBackfillLimit,
        weekendBackfillLimit: next.weekendBackfillLimit,
        hardStopWIB: next.hardStopWIB,
        concurrency: next.concurrency,
        rateLimit: next.rateLimit,
        retryCount: next.retryCount,
        backoffBaseMs: next.backoffBaseMs,
        priorityOrder: next.priorityOrder,
        killSwitch: next.killSwitch,
        pausedServices: next.pausedServices,
        backfillBudget: next.backfillBudget
      },
      diff
    };

    if (!appendAudit(auditRecord)) {
      // Fail-closed: unauditable durable write is rolled back.
      try { writeStoreAtomic(current); } catch (_) {}
      return { ok: false, reason: 'AUDIT_FAILED', doc: current, diff };
    }

    if (!readbackOk) {
      return { ok: false, reason: 'READBACK_FAILED', doc: next, diff };
    }

    return { ok: true, doc: next, previous: current, diff, readbackOk: true, version: next.version };
  } finally {
    releaseLock();
  }
}

function getAuditHistory(limitOpt) {
  const limit = Number.isInteger(Number(limitOpt)) && Number(limitOpt) > 0 ? Number(limitOpt) : 50;
  const auditPath = getAuditPath();
  try {
    if (!fs.existsSync(auditPath)) return { ok: true, logs: [] };
    const content = fs.readFileSync(auditPath, 'utf8');
    const lines = content.split(/\r?\n/).filter(Boolean);
    const parsed = [];
    for (let i = lines.length - 1; i >= 0 && parsed.length < limit; i--) {
      try {
        const item = JSON.parse(lines[i]);
        if (!item.timestampWIB && item.timestampIso) {
          const d = new Date(item.timestampIso);
          const wibD = new Date(d.getTime() + 7 * 3600 * 1000);
          item.timestampWIB = wibD.toISOString().replace('T', ' ').slice(0, 19) + ' WIB';
        }
        parsed.push(item);
      } catch (_) {}
    }
    return { ok: true, logs: parsed };
  } catch (err) {
    return { ok: false, logs: [], error: String((err && err.message) || err) };
  }
}

module.exports = {
  get STORE_PATH() { return getStorePath(); },
  get AUDIT_PATH() { return getAuditPath(); },
  get LOCK_PATH() { return getLockPath(); },
  getStorePath,
  getAuditPath,
  getLockPath,
  MAX_ADMIN_VALUE,
  blankDoc,
  normalizeDoc,
  canonicalizePatch,
  validatePatch,
  computeDiff,
  get,
  put,
  getAuditHistory,
  readStore,
  acquireLock,
  releaseLock,
  appendAudit
};