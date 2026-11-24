'use strict';

/**
 * lib/financial-incomplete-store.js
 * ============================================================================
 * TASK C — SEPARATE, CLEAN STATE STORE FOR INCOMPLETE ISSUER-PERIODS
 * ============================================================================
 * Tracks issuers whose financial report for a TARGET PERIOD is missing,
 * incomplete or unpublished. This is a LOCAL JSON store — it NEVER writes the
 * production DB and NEVER fabricates a publication event. Every entry carries
 * source / as_of / reason. Only an explicit, verified observation may clear an
 * entry; a manual fetch with a mocked transport records the receipt honestly.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const STORE_PATH = process.env.FINANCIAL_INCOMPLETE_STATE_PATH ||
  path.join(ROOT, 'data', 'financial-publication', 'incomplete-issuers.json');
const AUDIT_PATH = process.env.FINANCIAL_INCOMPLETE_AUDIT_PATH ||
  path.join(ROOT, 'data', 'security', 'financial-incomplete-audit.log.jsonl');
const LOCK_PATH = STORE_PATH + '.lock';
const STALE_LOCK_MS = 10000;
const SCHEMA_VERSION = 1;

const STATUS = Object.freeze({
  MISSING: 'MISSING',
  INCOMPLETE: 'INCOMPLETE',
  UNPUBLISHED: 'UNPUBLISHED',
  FETCH_PENDING: 'FETCH_PENDING',
  RESOLVED: 'RESOLVED'
});
const OPEN_STATUSES = Object.freeze([STATUS.MISSING, STATUS.INCOMPLETE, STATUS.UNPUBLISHED, STATUS.FETCH_PENDING]);

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function toIso(now) {
  const d = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}
function keyOf(ticker, fiscalYear, period) {
  return `${String(ticker || '').trim().toUpperCase()}|${Number(fiscalYear)}|${String(period || '').trim().toUpperCase()}`;
}
function blankDoc() {
  return { schemaVersion: SCHEMA_VERSION, version: 0, updatedAt: null, updatedBy: null, entries: {} };
}
function normalizeDoc(doc) {
  const base = blankDoc();
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return base;
  base.version = Number.isInteger(Number(doc.version)) && Number(doc.version) >= 0 ? Number(doc.version) : 0;
  base.updatedAt = doc.updatedAt || null;
  base.updatedBy = doc.updatedBy || null;
  const entries = doc.entries && typeof doc.entries === 'object' && !Array.isArray(doc.entries) ? doc.entries : {};
  for (const k of Object.keys(entries)) {
    const e = entries[k];
    if (!e || typeof e !== 'object') continue;
    base.entries[k] = {
      ticker: String(e.ticker || '').trim().toUpperCase(),
      fiscal_year: Number(e.fiscal_year),
      period: String(e.period || '').trim().toUpperCase(),
      status: Object.values(STATUS).includes(e.status) ? e.status : STATUS.MISSING,
      source: e.source == null ? null : String(e.source),
      as_of: e.as_of == null ? null : String(e.as_of),
      reason: e.reason == null ? null : String(e.reason),
      target_period: e.target_period == null ? null : String(e.target_period),
      fetch_window: e.fetch_window && typeof e.fetch_window === 'object' ? clone(e.fetch_window) : null,
      last_attempt_at: e.last_attempt_at || null,
      last_attempt_id: e.last_attempt_at ? (e.last_attempt_id || null) : null,
      attempts: Number.isInteger(Number(e.attempts)) ? Number(e.attempts) : 0,
      resolved_at: e.resolved_at || null,
      resolution: e.resolution && typeof e.resolution === 'object' ? clone(e.resolution) : null,
      createdAt: e.createdAt || null,
      updatedAt: e.updatedAt || null
    };
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
function list(options = {}) {
  const loaded = readStore();
  if (!loaded.ok) return loaded;
  let entries = Object.values(loaded.doc.entries);
  if (options.openOnly !== false) entries = entries.filter((e) => OPEN_STATUSES.includes(e.status));
  if (options.ticker) {
    const t = String(options.ticker).trim().toUpperCase();
    entries = entries.filter((e) => e.ticker === t);
  }
  if (options.period) {
    const p = String(options.period).trim().toUpperCase();
    entries = entries.filter((e) => e.period === p);
  }
  entries.sort((a, b) => a.ticker.localeCompare(b.ticker) || a.fiscal_year - b.fiscal_year || a.period.localeCompare(b.period));
  return { ok: true, doc: loaded.doc, entries, source: loaded.source };
}
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

function validateEntry(input) {
  const errors = [];
  const e = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const ticker = String(e.ticker || '').trim().toUpperCase();
  const fiscalYear = Number(e.fiscal_year);
  const period = String(e.period || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(ticker)) errors.push('ticker tidak valid.');
  if (!Number.isInteger(fiscalYear) || fiscalYear < 1900 || fiscalYear > 2200) errors.push('fiscal_year tidak valid.');
  if (!['Q1', 'Q2', 'Q3', 'Q4', 'FY'].includes(period)) errors.push('period tidak valid.');
  if (!e.source || typeof e.source !== 'string') errors.push('source wajib (observasi nyata).');
  if (!e.as_of || typeof e.as_of !== 'string') errors.push('as_of wajib.');
  if (!e.reason || typeof e.reason !== 'string') errors.push('reason wajib.');
  if (e.status && !Object.values(STATUS).includes(e.status)) errors.push('status tidak dikenal.');
  return { ok: errors.length === 0, errors, value: { ticker, fiscal_year: fiscalYear, period } };
}

/** Upsert an observed incomplete entry. Idempotent on (ticker, FY, period). */
function upsert(input, ctx = {}) {
  const v = validateEntry(input);
  if (!v.ok) return { ok: false, reason: 'VALIDATION_FAILED', errors: v.errors };
  if (!acquireLock()) return { ok: false, reason: 'LOCK_BUSY' };
  try {
    const prevRead = readStore();
    if (!prevRead.ok) return { ok: false, reason: 'READ_FAILED', error: prevRead.error };
    const current = prevRead.doc;
    const next = normalizeDoc(current);
    const k = keyOf(v.value.ticker, v.value.fiscal_year, v.value.period);
    const nowIso = toIso(ctx.now);
    const prior = next.entries[k];
    next.entries[k] = {
      ticker: v.value.ticker,
      fiscal_year: v.value.fiscal_year,
      period: v.value.period,
      status: input.status || STATUS.MISSING,
      source: String(input.source),
      as_of: String(input.as_of),
      reason: String(input.reason),
      target_period: input.target_period == null ? null : String(input.target_period),
      fetch_window: input.fetch_window && typeof input.fetch_window === 'object' ? clone(input.fetch_window) : (prior && prior.fetch_window) || null,
      last_attempt_at: (prior && prior.last_attempt_at) || null,
      last_attempt_id: (prior && prior.last_attempt_id) || null,
      attempts: (prior && prior.attempts) || 0,
      resolved_at: null,
      resolution: null,
      createdAt: (prior && prior.createdAt) || nowIso,
      updatedAt: nowIso
    };
    next.version = current.version + 1;
    next.updatedAt = nowIso;
    next.updatedBy = String(ctx.actor || 'admin');
    if (!writeAtomic(next)) return { ok: false, reason: 'WRITE_FAILED' };
    const readback = readStore();
    const readbackOk = readback.ok === true && readback.doc.version === next.version &&
      JSON.stringify(readback.doc.entries[k]) === JSON.stringify(next.entries[k]);
    appendAudit({
      eventId: 'fi-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex'),
      eventType: 'FINANCIAL_INCOMPLETE_UPSERT',
      timestampIso: nowIso, pid: process.pid, actor: String(ctx.actor || 'admin'),
      reason: String(ctx.reason || 'observed incomplete issuer'), key: k, entry: next.entries[k]
    });
    if (!readbackOk) return { ok: false, reason: 'READBACK_FAILED', doc: next };
    return { ok: true, doc: next, entry: next.entries[k], version: next.version, readbackOk: true };
  } finally {
    releaseLock();
  }
}

/** Record a manual fetch attempt (idempotent by attemptId). */
function recordAttempt(ticker, fiscalYear, period, attempt, ctx = {}) {
  const k = keyOf(ticker, fiscalYear, period);
  if (!attempt || typeof attempt !== 'object' || !attempt.id) return { ok: false, reason: 'VALIDATION_FAILED', errors: ['attempt.id wajib.'] };
  if (!acquireLock()) return { ok: false, reason: 'LOCK_BUSY' };
  try {
    const prevRead = readStore();
    if (!prevRead.ok) return { ok: false, reason: 'READ_FAILED', error: prevRead.error };
    const current = prevRead.doc;
    const next = normalizeDoc(current);
    const entry = next.entries[k];
    if (!entry) return { ok: false, reason: 'NOT_FOUND' };
    if (entry.last_attempt_id === attempt.id) {
      return { ok: true, idempotent: true, entry, version: current.version, readbackOk: true };
    }
    const nowIso = toIso(ctx.now);
    entry.last_attempt_at = nowIso;
    entry.last_attempt_id = String(attempt.id);
    entry.attempts = (entry.attempts || 0) + 1;
    entry.updatedAt = nowIso;
    if (attempt.status === STATUS.RESOLVED || attempt.resolved === true) {
      entry.status = STATUS.RESOLVED;
      entry.resolved_at = nowIso;
      entry.resolution = attempt.resolution && typeof attempt.resolution === 'object' ? clone(attempt.resolution) : null;
    } else if (Object.values(STATUS).includes(attempt.status)) {
      entry.status = attempt.status;
    }
    next.version = current.version + 1;
    next.updatedAt = nowIso;
    next.updatedBy = String(ctx.actor || 'admin');
    if (!writeAtomic(next)) return { ok: false, reason: 'WRITE_FAILED' };
    const readback = readStore();
    const readbackOk = readback.ok === true && readback.doc.version === next.version &&
      JSON.stringify(readback.doc.entries[k]) === JSON.stringify(entry);
    appendAudit({
      eventId: 'fi-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex'),
      eventType: 'FINANCIAL_INCOMPLETE_FETCH_ATTEMPT',
      timestampIso: nowIso, pid: process.pid, actor: String(ctx.actor || 'admin'),
      key: k, attempt: { id: attempt.id, outcome: attempt.outcome || null, status: entry.status, transport: attempt.transport || null }
    });
    if (!readbackOk) return { ok: false, reason: 'READBACK_FAILED', doc: next };
    return { ok: true, idempotent: false, entry, version: next.version, readbackOk: true };
  } finally {
    releaseLock();
  }
}

module.exports = {
  STORE_PATH, AUDIT_PATH, SCHEMA_VERSION, STATUS, OPEN_STATUSES,
  keyOf, blankDoc, normalizeDoc, get, list, upsert, recordAttempt, validateEntry
};
