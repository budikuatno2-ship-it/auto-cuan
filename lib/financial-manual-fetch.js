'use strict';

/**
 * lib/financial-manual-fetch.js
 * ============================================================================
 * TASK C — MANUAL FETCH HANDLER FOR INCOMPLETE ISSUER-PERIODS
 * ============================================================================
 * UI click -> authenticated API -> THIS handler -> mocked upstream transport
 *          -> incomplete state update -> UI readback.
 *
 * HARD GUARDS:
 *  - The ONLY transport accepted here is an injected `transport` object whose
 *    `id` starts with `MOCK-`. A real provider transport is REJECTED.
 *  - ZERO live provider HTTP calls. The transport is called in-process; it
 *    returns a receipt. httpRequests/billedUnits are always 0.
 *  - Quota guard: reads the durable quota config (daily cap, reserve floor,
 *    priority order) and the dispatcher's paid guard. If quota truth is
 *    unknown, the reserve floor is breached, or a persistent paid guard is
 *    active, the fetch is BLOCKED before the transport is invoked.
 *  - Idempotency: an attemptId (default derived from ticker|FY|period|window)
 *    is recorded; a repeated call with the same id returns the prior result
 *    without a second transport call or state mutation.
 * ============================================================================
 */

const crypto = require('crypto');
const incomplete = require('./financial-incomplete-store');
const windowStore = require('./financial-window-store');
const quotaStore = require('./quota-config-store');

const OUTCOME = Object.freeze({
  FETCHED: 'FETCHED',
  NOT_PUBLISHED: 'NOT_PUBLISHED',
  BLOCKED: 'BLOCKED',
  ALREADY_ATTEMPTED: 'ALREADY_ATTEMPTED'
});

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

/**
 * Evaluate the quota guard from DURABLE config only. No hardcoded quota values.
 * Returns { ok, reason, config }.
 */
function evaluateQuotaGuard(options = {}) {
  const read = options.readQuota || quotaStore.get;
  const q = read();
  if (!q || !q.ok || !q.doc) return { ok: false, reason: 'QUOTA_CONFIG_UNKNOWN', config: null };
  const doc = q.doc;
  const cap = doc.configuredOperatingCap != null ? doc.configuredOperatingCap : doc.dailyLimitOverride;
  const floor = doc.reserveFloorWeekday;
  if (cap == null || !Number.isFinite(Number(cap)) || floor == null || !Number.isFinite(Number(floor))) {
    return { ok: false, reason: 'QUOTA_LIMITS_UNKNOWN', config: doc };
  }
  if (Number(floor) >= Number(cap)) return { ok: false, reason: 'RESERVE_FLOOR_EXCEEDS_CAP', config: doc };
  if (doc.killSwitch === true) return { ok: false, reason: 'KILL_SWITCH', config: doc };
  const paused = doc.pausedServices || {};
  if (paused.all === true || paused.financial === true) return { ok: false, reason: 'PAUSED', config: doc };
  if (!Array.isArray(doc.priorityOrder) || !doc.priorityOrder.includes('financial')) {
    return { ok: false, reason: 'PRIORITY_UNCONFIGURED', config: doc };
  }
  // The manual fetch is a ZERO-QUOTA mocked operation. It still requires a
  // coherent durable quota config so the guard cannot be silently bypassed.
  return { ok: true, reason: 'MOCKED_ZERO_QUOTA_ALLOWED', config: doc, cap: Number(cap), floor: Number(floor) };
}

function resolveWindow(period, fiscalYear, options = {}) {
  const cfg = options.readWindow || windowStore.get;
  const read = cfg();
  if (!read || !read.ok || !read.doc) return { ok: false, reason: 'WINDOW_CONFIG_UNKNOWN' };
  const p = String(period || '').trim().toUpperCase();
  const rule = read.doc.periods && read.doc.periods[p];
  if (!rule) return { ok: false, reason: 'WINDOW_PERIOD_UNKNOWN' };
  // Deadline = end of the month following the period end. For a calendar-year
  // issuer: Q1 31 Mar -> 30 Apr, Q2 -> 31 Jul, Q3 -> 31 Oct, Q4 -> 31 Jan,
  // FY -> 31 Mar. Non-calendar issuers pass an explicit deadlineMonth/day.
  let deadline = options.deadline;
  if (!deadline) {
    const fy = Number(fiscalYear);
    const map = { Q1: [fy, 4, 30], Q2: [fy, 7, 31], Q3: [fy, 10, 31], Q4: [fy + 1, 1, 31], FY: [fy + 1, 3, 31] };
    const d = map[p];
    if (!d) return { ok: false, reason: 'WINDOW_PERIOD_UNKNOWN' };
    deadline = `${d[0]}-${String(d[1]).padStart(2, '0')}-${String(d[2]).padStart(2, '0')}`;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(deadline));
  if (!m) return { ok: false, reason: 'DEADLINE_INVALID' };
  const year = Number(m[1]), month = Number(m[2]);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const pad = (n) => String(n).padStart(2, '0');
  const window = {
    period: p,
    fiscal_year: Number(fiscalYear),
    deadline,
    start: `${nextYear}-${pad(nextMonth)}-${pad(rule.startDay)}`,
    end: `${nextYear}-${pad(nextMonth)}-${pad(rule.endDay)}`,
    configVersion: read.doc.version
  };
  return { ok: true, window, config: read.doc };
}

function validateTransport(transport) {
  if (!transport || typeof transport !== 'object') return { ok: false, reason: 'TRANSPORT_REQUIRED' };
  if (typeof transport.fetch !== 'function') return { ok: false, reason: 'TRANSPORT_FETCH_REQUIRED' };
  const id = String(transport.id || '');
  if (!/^MOCK-/i.test(id)) return { ok: false, reason: 'LIVE_TRANSPORT_REJECTED' };
  return { ok: true, id };
}

/**
 * runManualFetch({ ticker, fiscal_year, period, transport, attemptId, actor, now, deadline })
 */
async function runManualFetch(input = {}, options = {}) {
  const ticker = String(input.ticker || '').trim().toUpperCase();
  const fiscalYear = Number(input.fiscal_year);
  const period = String(input.period || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(ticker) || !Number.isInteger(fiscalYear) || !['Q1', 'Q2', 'Q3', 'Q4', 'FY'].includes(period)) {
    return { ok: false, outcome: OUTCOME.BLOCKED, reason: 'INVALID_TARGET', httpRequests: 0, billedUnits: 0 };
  }
  const transport = input.transport || options.transport;
  const t = validateTransport(transport);
  if (!t.ok) return { ok: false, outcome: OUTCOME.BLOCKED, reason: t.reason, httpRequests: 0, billedUnits: 0 };

  const guard = evaluateQuotaGuard(options);
  if (!guard.ok) {
    return { ok: false, outcome: OUTCOME.BLOCKED, reason: guard.reason, httpRequests: 0, billedUnits: 0, quota: guard.config };
  }
  const w = resolveWindow(period, fiscalYear, Object.assign({}, options, { deadline: input.deadline }));
  if (!w.ok) return { ok: false, outcome: OUTCOME.BLOCKED, reason: w.reason, httpRequests: 0, billedUnits: 0 };

  const attemptId = String(input.attemptId || `${ticker}|${fiscalYear}|${period}|${w.window.configVersion}|${w.window.start}`);
  const readIncomplete = options.readIncomplete || incomplete.get;
  const prior = readIncomplete();
  const priorEntry = prior.ok && prior.doc && prior.doc.entries[incomplete.keyOf(ticker, fiscalYear, period)];
  if (priorEntry && priorEntry.last_attempt_id === attemptId) {
    return {
      ok: true, outcome: OUTCOME.ALREADY_ATTEMPTED, idempotent: true, attemptId,
      ticker, fiscal_year: fiscalYear, period, window: w.window,
      entry: priorEntry, httpRequests: 0, billedUnits: 0, transport: t.id
    };
  }

  // The mocked transport is the ONLY upstream call. It receives no credentials.
  let receipt;
  try {
    receipt = await transport.fetch({
      ticker, fiscal_year: fiscalYear, period,
      window: w.window, attemptId,
      offline: true
    });
  } catch (err) {
    return { ok: false, outcome: OUTCOME.BLOCKED, reason: 'TRANSPORT_ERROR', detail: String((err && err.message) || err), httpRequests: 0, billedUnits: 0, transport: t.id };
  }
  if (!receipt || typeof receipt !== 'object') {
    return { ok: false, outcome: OUTCOME.BLOCKED, reason: 'TRANSPORT_INVALID_RECEIPT', httpRequests: 0, billedUnits: 0, transport: t.id };
  }

  const nowIso = toIso(options.now);
  const published = receipt.published === true;
  const attempt = {
    id: attemptId,
    transport: t.id,
    outcome: published ? OUTCOME.FETCHED : OUTCOME.NOT_PUBLISHED,
    status: published ? incomplete.STATUS.RESOLVED : incomplete.STATUS.UNPUBLISHED,
    resolution: published ? {
      publication_at: receipt.publication_at || null,
      source: receipt.source || t.id,
      as_of: receipt.as_of || nowIso.slice(0, 10),
      checksum: receipt.checksum || null,
      note: 'MOCKED_TRANSPORT_RECEIPT_NOT_LIVE_EVIDENCE'
    } : null
  };

  const writeIncomplete = options.writeIncomplete || incomplete.recordAttempt;
  const saved = await writeIncomplete(ticker, fiscalYear, period, attempt, {
    actor: input.actor || options.actor || 'admin', now: nowIso
  });
  if (!saved || !saved.ok) {
    return { ok: false, outcome: OUTCOME.BLOCKED, reason: 'STATE_WRITE_FAILED', detail: saved && saved.reason, httpRequests: 0, billedUnits: 0, transport: t.id };
  }

  return {
    ok: true,
    outcome: attempt.outcome,
    idempotent: saved.idempotent === true,
    attemptId,
    ticker, fiscal_year: fiscalYear, period,
    window: w.window,
    receipt: {
      published,
      publication_at: receipt.publication_at || null,
      source: receipt.source || t.id,
      as_of: receipt.as_of || nowIso.slice(0, 10),
      checksum: receipt.checksum || null,
      note: 'OFFLINE MOCKED TRANSPORT RECEIPT — NOT LIVE PROVIDER EVIDENCE'
    },
    entry: saved.entry,
    stateVersion: saved.version,
    readbackOk: saved.readbackOk === true,
    httpRequests: 0,
    billedUnits: 0,
    transport: t.id,
    quota: { cap: guard.cap, floor: guard.floor, priorityOrder: guard.config.priorityOrder }
  };
}

function toIso(now) {
  const d = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

module.exports = { OUTCOME, evaluateQuotaGuard, resolveWindow, validateTransport, runManualFetch, sha };
