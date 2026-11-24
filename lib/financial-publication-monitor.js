'use strict';

/**
 * lib/financial-publication-monitor.js
 * ============================================================================
 * V6 W3 — FINANCIAL PUBLICATION MONITOR (USER ANCHORS, NOT REGULATORY DEADLINES)
 * ============================================================================
 * WHY
 * ---
 * The financial pipeline (lib/financial-statements-import.js,
 * lib/financial-snapshot.js) can only publish a fundamental once the issuer has
 * ACTUALLY released the report. The user's operating rule is an
 * "end-of-next-month" check: a quarter that ends on 31 Mar is first checked on
 * 30 Apr, and so on. This module encodes THAT rule — the user's anchors — and
 * deliberately does NOT encode IDX/regulatory filing deadlines, which are a
 * different (and later) contract.
 *
 * HARD INVARIANTS (anti-slop / anti-fabrication)
 * ----------------------------------------------
 *   1. A quarter having ENDED is NEVER evidence that it was PUBLISHED.
 *      `publication_at` is only ever set from an explicit, verified observation
 *      (a real source URL + checksum). It is never inferred from a date.
 *   2. When no valid published data is found at a check, the status stays
 *      PENDING / MISSING_RETRY. No publication date is fabricated.
 *   3. FY (annual audited) is a SEPARATE track from Q4. Q4 is the preliminary
 *      quarter release; the audited annual report may publish later (Feb/Mar).
 *      They are never conflated.
 *   4. Non-calendar fiscal-year issuers derive their anchors from the issuer's
 *      actual `fiscal_year_end` (offset months), never from hardcoded dates.
 *   5. Weekend/holiday checks shift to the next supported business day and BOTH
 *      the nominal date and the actual check date are recorded.
 *   6. Retry cadence is 15 days (admin-editable). After a verified publication
 *      the retry loop STOPS. It reopens only on a formal revision, detected by
 *      a changed source checksum/version.
 *
 * This module is PURE for all anchor/state-transition math (explicit `now`,
 * explicit holiday Set) so it is trivially testable. Only the state store
 * helpers touch the filesystem, and they are atomic + backed up.
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const calendar = require('./idx-trading-calendar');

const ROOT = path.resolve(__dirname, '..');

const STATE_PATH = process.env.FINANCIAL_PUBLICATION_STATE_PATH ||
  path.join(ROOT, 'data', 'financial-publication', 'state.json');
const AUDIT_PATH = process.env.FINANCIAL_PUBLICATION_AUDIT_PATH ||
  path.join(ROOT, 'data', 'security', 'financial-publication-audit.log.jsonl');

const DEFAULT_RETRY_INTERVAL_DAYS = 15;

/** Canonical status vocabulary. */
const STATUS = Object.freeze({
  NOT_DUE: 'NOT_DUE',
  DUE: 'DUE',
  PENDING: 'PENDING',
  PUBLISHED_VERIFIED: 'PUBLISHED_VERIFIED',
  MISSING_RETRY: 'MISSING_RETRY',
  REVISION_DETECTED: 'REVISION_DETECTED',
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE'
});

const PERIODS = Object.freeze(['Q1', 'Q2', 'Q3', 'Q4', 'FY']);

// ---------------------------------------------------------------------------
// Date helpers (pure, UTC calendar math — no timezone ambiguity)
// ---------------------------------------------------------------------------

function parseKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key == null ? '' : key).trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (d > lastDayOfMonth(y, mo)) return null;
  return { y, m: mo, d };
}

function fmt(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function lastDayOfMonth(y, m) {
  // m is 1-based; Date.UTC(y, m, 0) is the last day of month m.
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Last calendar day of the month `monthsAhead` months after `dateKey`'s month.
 * This is the anchor primitive: "end of the month following the period end".
 */
function endOfMonthAfter(dateKey, monthsAhead) {
  const p = parseKey(dateKey);
  if (!p) return null;
  let y = p.y;
  let m = p.m + Number(monthsAhead || 0);
  while (m > 12) { m -= 12; y += 1; }
  while (m < 1) { m += 12; y -= 1; }
  return fmt(y, m, lastDayOfMonth(y, m));
}

function toDateKey(input) {
  if (input == null) return null;
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) return null;
    return input.toISOString().slice(0, 10);
  }
  const p = parseKey(input);
  if (p) return fmt(p.y, p.m, p.d);
  // Reject impossible date prefixes instead of letting Date normalize Feb 30.
  const text = String(input).trim();
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text) || !parseKey(text.slice(0, 10))) return null;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function addDays(dateKey, delta) {
  const p = parseKey(dateKey);
  if (!p) return null;
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d));
  d.setUTCDate(d.getUTCDate() + Number(delta || 0));
  return d.toISOString().slice(0, 10);
}

/**
 * Shift a nominal date forward to the next supported business day.
 * Weekend/holiday -> next trading day. Returns BOTH dates so the caller can
 * record nominal_date and actual_check_date independently.
 */
function shiftToBusinessDay(nominalDate, holidaySet) {
  const nominal = toDateKey(nominalDate);
  if (!nominal) return { nominal_date: null, actual_check_date: null, shifted: false };
  let cursor = nominal;
  let guard = 0;
  while (!calendar.isTradingDay(cursor, holidaySet) && guard < 30) {
    cursor = calendar.addDaysToKey(cursor, 1);
    guard += 1;
  }
  return {
    nominal_date: nominal,
    actual_check_date: cursor,
    shifted: cursor !== nominal
  };
}

// ---------------------------------------------------------------------------
// Anchor derivation
// ---------------------------------------------------------------------------

/**
 * Derive the user's anchor table for one fiscal year of one issuer.
 *
 * @param {object} options
 * @param {string} options.fiscalYearEnd  issuer fiscal year end, 'MM-DD' or
 *                                        'YYYY-MM-DD' (only MM-DD is used)
 * @param {number} options.fiscalYear     the fiscal year label (e.g. 2026)
 * @param {Set|Array} [options.holidaySet]
 * @returns {Array<{period, period_end, nominal_check_date, actual_check_date, shifted}>}
 */
function computeAnchors(options = {}) {
  const fyeRaw = String(options.fiscalYearEnd || '12-31').trim();
  const mmdd = /^(\d{2})-(\d{2})$/.test(fyeRaw)
    ? fyeRaw
    : (/^\d{4}-(\d{2}-\d{2})$/.exec(fyeRaw) || [])[1] || '12-31';
  const fyeMonth = Number(mmdd.slice(0, 2));
  const fyeDay = Number(mmdd.slice(3, 5));
  if (!(fyeMonth >= 1 && fyeMonth <= 12) || !(fyeDay >= 1 && fyeDay <= 31)) {
    throw new Error('invalid fiscal_year_end: ' + fyeRaw);
  }

  const fiscalYear = Number(options.fiscalYear);
  if (!Number.isInteger(fiscalYear)) throw new Error('fiscalYear is required');

  // The fiscal year END date for the labelled year.
  const fyeDate = fmt(fiscalYear, fyeMonth, Math.min(fyeDay, lastDayOfMonth(fiscalYear, fyeMonth)));
  const holidaySet = options.holidaySet;

  const anchors = [];
  for (let i = 1; i <= 4; i += 1) {
    // Q1 = FYE - 9 months, Q2 = -6, Q3 = -3, Q4 = 0.
    const periodEnd = endOfMonthAfter(fyeDate, (i - 4) * 3);
    const nominal = endOfMonthAfter(periodEnd, 1);
    const shifted = shiftToBusinessDay(nominal, holidaySet);
    anchors.push({
      period: 'Q' + i,
      period_end: periodEnd,
      nominal_check_date: shifted.nominal_date,
      actual_check_date: shifted.actual_check_date,
      shifted: shifted.shifted
    });
  }

  // FY (annual audited) is a SEPARATE track: it may publish later (Feb/Mar for
  // a Dec year-end). Nominal = end of the month 3 months after FYE.
  const fyNominal = endOfMonthAfter(fyeDate, 3);
  const fyShifted = shiftToBusinessDay(fyNominal, holidaySet);
  anchors.push({
    period: 'FY',
    period_end: fyeDate,
    nominal_check_date: fyShifted.nominal_date,
    actual_check_date: fyShifted.actual_check_date,
    shifted: fyShifted.shifted
  });

  return anchors;
}

// ---------------------------------------------------------------------------
// State record construction
// ---------------------------------------------------------------------------

function blankRecord(ticker, fiscalYear, anchor) {
  return {
    ticker: String(ticker || '').trim().toUpperCase(),
    fiscal_year: Number(fiscalYear),
    period: anchor.period,
    period_end: anchor.period_end,
    nominal_check_date: anchor.nominal_check_date,
    actual_check_date: anchor.actual_check_date,
    publication_at: null,
    retrieval_at: null,
    source_url: null,
    audited_reviewed: false,
    as_of: null,
    status: STATUS.NOT_DUE,
    checksum: null,
    last_check_at: null,
    next_check_at: null,
    retry_count: 0
  };
}

function recordKey(rec) {
  return `${rec.ticker}|${rec.fiscal_year}|${rec.period}`;
}

/**
 * Build the full set of records for one issuer/fiscal-year, preserving any
 * existing state already present in `existing` (keyed by recordKey).
 */
function buildRecordsForIssuer(options = {}) {
  const ticker = String(options.ticker || '').trim().toUpperCase();
  const fiscalYear = Number(options.fiscalYear);
  const anchors = computeAnchors({
    fiscalYearEnd: options.fiscalYearEnd,
    fiscalYear,
    holidaySet: options.holidaySet
  });
  const existing = options.existing || {};
  return anchors.map(function (anchor) {
    const fresh = blankRecord(ticker, fiscalYear, anchor);
    const prior = existing[recordKey(fresh)];
    if (!prior) return fresh;
    // Preserve observed state; refresh only the derived anchor geometry.
    return Object.assign({}, prior, {
      period_end: anchor.period_end,
      nominal_check_date: anchor.nominal_check_date,
      actual_check_date: anchor.actual_check_date
    });
  });
}

// ---------------------------------------------------------------------------
// Evaluation / transitions (pure)
// ---------------------------------------------------------------------------

function hasValidPublicationReceipt(record, today) {
  if (!record || !toDateKey(record.period_end)) return false;
  const publicationDate = toDateKey(record.publication_at);
  const retrievalDate = toDateKey(record.retrieval_at);
  const asOfDate = toDateKey(record.as_of);
  if (!publicationDate || !retrievalDate || !asOfDate || typeof record.audited_reviewed !== 'boolean' ||
      publicationDate < record.period_end || publicationDate > retrievalDate || retrievalDate > asOfDate ||
      (today && asOfDate > today)) return false;
  try {
    const sourceUrl = new URL(String(record.source_url || ''));
    return sourceUrl.protocol === 'https:' && !!sourceUrl.hostname && !sourceUrl.username && !sourceUrl.password &&
      /^[a-f0-9]{64}$/i.test(String(record.checksum || ''));
  } catch (_) {
    return false;
  }
}

/**
 * Decide whether a record is due for a check at `now`.
 *
 * @returns {{due:boolean, status:string, reason:string, next_check_at:string|null}}
 */
function evaluateRecord(record, options = {}) {
  const today = toDateKey(options.now || new Date());
  const retryDays = Number.isFinite(Number(options.retryIntervalDays))
    ? Number(options.retryIntervalDays)
    : DEFAULT_RETRY_INTERVAL_DAYS;

  if (!record || !record.actual_check_date) {
    return { due: false, status: STATUS.NOT_DUE, reason: 'no_anchor', next_check_at: null };
  }

  // Do not run a check before the first configured anchor, even when old state
  // contains an invalid VERIFIED marker.
  if (today < record.actual_check_date) {
    return { due: false, status: STATUS.NOT_DUE, reason: 'before_first_check', next_check_at: record.actual_check_date };
  }

  // Only a complete, syntactically valid persisted receipt stops retries.
  // Historical authenticity/source binding still requires external evidence.
  if (record.status === STATUS.PUBLISHED_VERIFIED) {
    if (!hasValidPublicationReceipt(record, today) || (record.period === 'FY' && record.audited_reviewed !== true)) {
      return { due: true, status: STATUS.DUE, reason: 'invalid_verified_evidence', next_check_at: today };
    }
    return {
      due: false,
      status: STATUS.PUBLISHED_VERIFIED,
      reason: 'already_published_verified',
      next_check_at: null
    };
  }

  // In a retry window: wait until next_check_at.
  if ([STATUS.MISSING_RETRY, STATUS.PENDING, STATUS.UPSTREAM_UNAVAILABLE].includes(record.status) && record.next_check_at && today < record.next_check_at) {
    return {
      due: false,
      status: record.status,
      reason: 'waiting_retry',
      next_check_at: record.next_check_at
    };
  }

  // A detected revision reopens immediately.
  if (record.status === STATUS.REVISION_DETECTED) {
    return { due: true, status: STATUS.REVISION_DETECTED, reason: 'revision_reopen', next_check_at: today };
  }

  return {
    due: true,
    status: STATUS.DUE,
    reason: record.retry_count > 0 ? 'retry_due' : 'first_check_due',
    next_check_at: today
  };
}

/**
 * Apply the outcome of a check to a record. NEVER fabricates a publication
 * date: `publication_at` is only set when `published === true` AND a real
 * `publicationAt` observation is supplied.
 *
 * @param {object} record
 * @param {object} outcome
 * @param {boolean} outcome.published        verified publication observed?
 * @param {string} [outcome.publicationAt]   the OBSERVED publication date
 * @param {string} [outcome.sourceUrl]
 * @param {string} [outcome.checksum]
 * @param {boolean} [outcome.auditedReviewed]
 * @param {boolean} [outcome.upstreamUnavailable]
 * @param {string} [outcome.now]
 * @param {number} [outcome.retryIntervalDays]
 * @returns {object} a NEW record (input is not mutated)
 */
function applyCheckOutcome(record, outcome = {}) {
  const now = toDateKey(outcome.now || new Date());
  const retryDays = Number.isFinite(Number(outcome.retryIntervalDays))
    ? Number(outcome.retryIntervalDays)
    : DEFAULT_RETRY_INTERVAL_DAYS;
  const next = Object.assign({}, record);
  next.last_check_at = now;

  if (outcome.upstreamUnavailable === true) {
    next.status = STATUS.UPSTREAM_UNAVAILABLE;
    next.next_check_at = addDays(now, retryDays);
    return next;
  }

  if (outcome.published === true) {
    // Require an explicit observed publication date. A missing date is NOT a
    // licence to invent one — the record stays PENDING.
    const observed = toDateKey(outcome.publicationAt);
    const sourceUrl = typeof outcome.sourceUrl === 'string' ? outcome.sourceUrl.trim() : '';
    const checksum = typeof outcome.checksum === 'string' ? outcome.checksum.trim() : '';
    let validSourceUrl = false;
    try {
      const parsed = new URL(sourceUrl);
      validSourceUrl = parsed.protocol === 'https:' && !!parsed.hostname && !parsed.username && !parsed.password;
    } catch (_) {}
    const validChecksum = /^[a-f0-9]{64}$/i.test(checksum);
    if (!observed || !now || observed > now ||
        (record.period_end && observed < record.period_end) ||
        !validSourceUrl || !validChecksum ||
        (record.period === 'FY' && outcome.auditedReviewed !== true)) {
      next.status = STATUS.PENDING;
      next.next_check_at = addDays(now, retryDays);
      return next;
    }
    next.status = STATUS.PUBLISHED_VERIFIED;
    next.publication_at = observed;
    next.retrieval_at = now;
    next.source_url = sourceUrl || null;
    next.checksum = checksum || null;
    next.audited_reviewed = outcome.auditedReviewed === true;
    next.as_of = now;
    next.next_check_at = null;
    return next;
  }

  // No valid published data at this check.
  next.status = STATUS.MISSING_RETRY;
  next.retry_count = Number(record.retry_count || 0) + 1;
  next.next_check_at = addDays(now, retryDays);
  return next;
}

/**
 * Detect a formal revision: a changed source checksum/version on an already
 * verified record reopens it.
 *
 * @returns {{revision:boolean, record:object}}
 */
function detectRevision(record, newChecksum, options = {}) {
  if (!record || record.status !== STATUS.PUBLISHED_VERIFIED) {
    return { revision: false, record };
  }
  if (!newChecksum || !record.checksum) {
    return { revision: false, record };
  }
  if (String(newChecksum) === String(record.checksum)) {
    return { revision: false, record };
  }
  const now = toDateKey(options.now || new Date());
  const reopened = Object.assign({}, record, {
    status: STATUS.REVISION_DETECTED,
    next_check_at: now,
    as_of: now
  });
  return { revision: true, record: reopened };
}

/**
 * Compute the set of records that are due at `now`.
 */
function computeDueItems(records, options = {}) {
  const list = Array.isArray(records) ? records : [];
  const due = [];
  for (const rec of list) {
    const verdict = evaluateRecord(rec, options);
    if (verdict.due) due.push({ record: rec, verdict });
  }
  return due;
}

// ---------------------------------------------------------------------------
// State store (atomic write + backup)
// ---------------------------------------------------------------------------

function blankState() {
  return {
    schemaVersion: 1,
    updatedAt: null,
    retryIntervalDays: DEFAULT_RETRY_INTERVAL_DAYS,
    issuers: {}
  };
}

function loadState(statePath) {
  const p = statePath || STATE_PATH;
  try {
    if (!fs.existsSync(p)) return { ok: true, state: blankState(), source: 'default' };
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'state is not an object', state: blankState() };
    if (!parsed.issuers || typeof parsed.issuers !== 'object') parsed.issuers = {};
    if (!Number.isFinite(Number(parsed.retryIntervalDays))) parsed.retryIntervalDays = DEFAULT_RETRY_INTERVAL_DAYS;
    return { ok: true, state: parsed, source: 'file' };
  } catch (e) {
    return { ok: false, error: e && e.message, state: blankState() };
  }
}

function saveState(state, statePath) {
  const p = statePath || STATE_PATH;
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const doc = Object.assign({}, state, { updatedAt: new Date().toISOString() });
  const tmp = p + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
  // Backup the previous good state before replacing it.
  if (fs.existsSync(p)) {
    try { fs.copyFileSync(p, p + '.bak'); } catch (_) { /* best effort */ }
  }
  fs.renameSync(tmp, p);
  return { ok: true, path: p };
}

function appendAudit(entry, auditPath) {
  const p = auditPath || AUDIT_PATH;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const record = Object.assign({
      eventId: crypto.randomUUID(),
      timestampIso: new Date().toISOString(),
      processId: process.pid
    }, entry || {});
    fs.appendFileSync(p, JSON.stringify(record) + '\n', 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  STATUS,
  PERIODS,
  DEFAULT_RETRY_INTERVAL_DAYS,
  STATE_PATH,
  AUDIT_PATH,
  // date helpers
  parseKey,
  endOfMonthAfter,
  toDateKey,
  addDays,
  shiftToBusinessDay,
  // anchors
  computeAnchors,
  // records
  blankRecord,
  recordKey,
  buildRecordsForIssuer,
  // transitions
  evaluateRecord,
  hasValidPublicationReceipt,
  applyCheckOutcome,
  detectRevision,
  computeDueItems,
  // store
  blankState,
  loadState,
  saveState,
  appendAudit
};
