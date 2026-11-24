'use strict';

/**
 * lib/financial-window-store.js
 * ============================================================================
 * TASK C — ADMIN-EDITABLE, VERSIONED QUARTERLY FETCH-WINDOW CONFIG
 * ============================================================================
 * The operating contract (owner supplied):
 *   Q1  deadline 30 Apr -> fetch window 05 May..15 May
 *   Q2  deadline 31 Jul -> fetch window 05 Aug..15 Aug
 *   Q3  deadline 31 Oct -> fetch window 05 Nov..15 Nov
 *   Q4  deadline 31 Jan (un-audited, separate track) -> 05 Feb..15 Feb
 *   FY  deadline 31 Mar (audited annual) -> 05 Apr..15 Apr
 *
 * Only the DAY-OF-MONTH is stored. The MONTH is derived from each issuer's
 * own deadline (end of the month following the period end), so non-calendar
 * fiscal years get the same 5th..15th cadence shifted to their real deadline.
 * No quota values live here. Every write is versioned, audited and read back.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const STORE_PATH = process.env.FINANCIAL_WINDOW_CONFIG_PATH ||
  path.join(ROOT, 'data', 'financial-publication', 'window-config.json');
const AUDIT_PATH = process.env.FINANCIAL_WINDOW_AUDIT_PATH ||
  path.join(ROOT, 'data', 'security', 'financial-window-audit.log.jsonl');
const LOCK_PATH = STORE_PATH + '.lock';
const STALE_LOCK_MS = 10000;
const SCHEMA_VERSION = 1;

const PERIODS = Object.freeze(['Q1', 'Q2', 'Q3', 'Q4', 'FY']);

/** Canonical owner defaults: 5th..15th of the month after each deadline. */
const DEFAULT_PERIOD_CONFIG = Object.freeze({
  Q1: Object.freeze({ startDay: 5, endDay: 15 }),
  Q2: Object.freeze({ startDay: 5, endDay: 15 }),
  Q3: Object.freeze({ startDay: 5, endDay: 15 }),
  Q4: Object.freeze({ startDay: 5, endDay: 15 }),
  FY: Object.freeze({ startDay: 5, endDay: 15 })
});

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function toIso(now) {
  const d = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function blankDoc() {
  return {
    schemaVersion: SCHEMA_VERSION,
    version: 0,
    updatedAt: null,
    updatedBy: null,
    periods: clone(DEFAULT_PERIOD_CONFIG)
  };
}

function normalizeDoc(doc) {
  const base = blankDoc();
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return base;
  base.version = Number.isInteger(Number(doc.version)) && Number(doc.version) >= 0 ? Number(doc.version) : 0;
  base.updatedAt = doc.updatedAt || null;
  base.updatedBy = doc.updatedBy || null;
  const periods = doc.periods && typeof doc.periods === 'object' ? doc.periods : {};
  for (const p of PERIODS) {
    const src = periods[p] || {};
    const startDay = Number(src.startDay);
    const endDay = Number(src.endDay);
    base.periods[p] = {
      startDay: Number.isInteger(startDay) && startDay >= 1 && startDay <= 28 ? startDay : DEFAULT_PERIOD_CONFIG[p].startDay,
      endDay: Number.isInteger(endDay) && endDay >= 1 && endDay <= 28 ? endDay : DEFAULT_PERIOD_CONFIG[p].endDay
    };
    if (base.periods[p].startDay > base.periods[p].endDay) base.periods[p] = clone(DEFAULT_PERIOD_CONFIG[p]);
  }
  return base;
}

function readStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return { ok: true, doc: blankDoc(), source: 'default' };
    return { ok: true, doc: normalizeDoc(JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))), source: 'file' };
  } catch (err) {
    return { ok: false, doc: blankDoc(), error: String((err && err.message) || err) };
  }
}

function get() { return readStore(); }

function acquireLock() {
  try {
    fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
    const fd = fs.openSync(LOCK_PATH, 'wx');
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (_) {
    try {
      const st = fs.statSync(LOCK_PATH);
      if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
        fs.unlinkSync(LOCK_PATH);
        const fd = fs.openSync(LOCK_PATH, 'wx');
        fs.writeFileSync(fd, String(process.pid));
        fs.closeSync(fd);
        return true;
      }
    } catch (_) {}
    return false;
  }
}
function releaseLock() { try { fs.unlinkSync(LOCK_PATH); } catch (_) {} }

function writeAtomic(doc) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tmp = STORE_PATH + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
  fs.renameSync(tmp, STORE_PATH);
  return true;
}

function appendAudit(record) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
    fs.appendFileSync(AUDIT_PATH, JSON.stringify(record) + '\n', 'utf8');
    return true;
  } catch (_) { return false; }
}

function validatePatch(raw) {
  const errors = [];
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const periods = src.periods && typeof src.periods === 'object' && !Array.isArray(src.periods) ? src.periods : src;
  const keys = Object.keys(periods).filter((k) => PERIODS.includes(k));
  if (!keys.length) errors.push('Minimal satu periode Q1/Q2/Q3/Q4/FY wajib.');
  for (const k of Object.keys(periods)) {
    if (!PERIODS.includes(k)) { errors.push('Periode tidak dikenal: ' + k); continue; }
    const v = periods[k] || {};
    for (const f of Object.keys(v)) {
      if (!['startDay', 'endDay'].includes(f)) errors.push(k + '.' + f + ' tidak dikenal.');
    }
    const a = Number(v.startDay), b = Number(v.endDay);
    if (!Number.isInteger(a) || a < 1 || a > 28) errors.push(k + '.startDay harus integer 1..28.');
    if (!Number.isInteger(b) || b < 1 || b > 28) errors.push(k + '.endDay harus integer 1..28.');
    if (Number.isInteger(a) && Number.isInteger(b) && a > b) errors.push(k + '.startDay tidak boleh > endDay.');
  }
  return { ok: errors.length === 0, errors, periods };
}

/**
 * put({ periods: { Q1: {startDay,endDay}, ... } }, { actor, reason, expectedVersion, now })
 */
function put(rawPatch, ctx) {
  const o = ctx || {};
  const v = validatePatch(rawPatch);
  if (!v.ok) return { ok: false, reason: 'VALIDATION_FAILED', errors: v.errors };
  if (!acquireLock()) return { ok: false, reason: 'LOCK_BUSY' };
  try {
    const prevRead = readStore();
    if (!prevRead.ok) return { ok: false, reason: 'READ_FAILED', error: prevRead.error };
    const current = prevRead.doc;
    if (o.expectedVersion != null && Number(o.expectedVersion) !== current.version) {
      return { ok: false, reason: 'CONFLICT', expectedVersion: Number(o.expectedVersion), currentVersion: current.version, doc: current };
    }
    const next = normalizeDoc(current);
    for (const k of Object.keys(v.periods)) {
      const p = v.periods[k];
      next.periods[k] = {
        startDay: Number(p.startDay),
        endDay: Number(p.endDay)
      };
    }
    next.version = current.version + 1;
    next.updatedAt = toIso(o.now);
    next.updatedBy = String(o.actor || 'admin');
    if (!writeAtomic(next)) return { ok: false, reason: 'WRITE_FAILED' };
    const readback = readStore();
    const readbackOk = readback.ok === true && readback.doc.version === next.version &&
      JSON.stringify(readback.doc.periods) === JSON.stringify(next.periods);
    const audit = {
      eventId: 'fw-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex'),
      eventType: 'FINANCIAL_WINDOW_CONFIG_SAVE',
      timestampIso: toIso(o.now),
      pid: process.pid,
      actor: String(o.actor || 'admin'),
      reason: String(o.reason || '').slice(0, 300),
      version: next.version,
      previousVersion: current.version,
      previous: current.periods,
      next: next.periods
    };
    if (!appendAudit(audit)) {
      try { writeAtomic(current); } catch (_) {}
      return { ok: false, reason: 'AUDIT_FAILED', doc: current };
    }
    if (!readbackOk) return { ok: false, reason: 'READBACK_FAILED', doc: next };
    return { ok: true, doc: next, version: next.version, readbackOk: true, previous: current };
  } finally {
    releaseLock();
  }
}

module.exports = {
  STORE_PATH,
  AUDIT_PATH,
  SCHEMA_VERSION,
  PERIODS,
  DEFAULT_PERIOD_CONFIG,
  blankDoc,
  normalizeDoc,
  get,
  put,
  validatePatch
};
