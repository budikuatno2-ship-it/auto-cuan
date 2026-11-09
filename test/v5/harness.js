'use strict';

/**
 * test/v5/harness.js
 * ============================================================================
 * INDEPENDENT NEGATIVE-TEST HARNESS — Auto-Cuan IDX V5 (anti-fake gate)
 * ============================================================================
 *
 * PURPOSE
 *   Minimal, dependency-free helpers used by `test/v5/negative.test.js` to
 *   express the mandatory negative controls from the V5 contract §20 (N1–N25)
 *   and the enumerated controls in `audit-evidence/v5/V5_CODE_TRACE_P0.md`.
 *
 * DESIGN RULES (binding)
 *   1. A control THROWS when the defect is present. A control that returns
 *      normally means the invariant held for every input it checked.
 *   2. Nothing here may weaken an assertion to make a bug look fixed.
 *   3. No network. No writes to application state. No mutation of app code.
 *   4. A control that cannot run raises `SkipControl` (→ SKIP) and never
 *      silently succeeds.
 *   5. A control whose owning module does not exist yet raises
 *      `PendingImplementation` (→ PENDING_IMPLEMENTATION) naming the module
 *      path that MUST own the logic. The assertion is never stubbed.
 *
 * Only Node built-ins are used: node:fs, node:path.
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');

/** Repository root, resolved from this file (`test/v5/harness.js`). */
const ROOT = path.resolve(__dirname, '..', '..');

/* -------------------------------------------------------------------------- */
/* Error taxonomy                                                             */
/* -------------------------------------------------------------------------- */

/** Thrown when an invariant is violated (i.e. the defect is still live). */
class AssertionFailure extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'AssertionFailure';
    this.detail = detail === undefined ? null : detail;
  }
}

/** Thrown when the module that must own the guard does not exist yet. */
class PendingImplementation extends Error {
  constructor(modulePath, expectedExports, reason) {
    super('PENDING_IMPLEMENTATION: module ' + modulePath + ' does not exist');
    this.name = 'PendingImplementation';
    this.modulePath = modulePath;
    this.expectedExports = Array.isArray(expectedExports) ? expectedExports : [];
    this.reason = reason || '';
  }
}

/** Thrown when a control genuinely cannot be executed offline. */
class SkipControl extends Error {
  constructor(reason) {
    super('SKIP: ' + reason);
    this.name = 'SkipControl';
    this.reason = reason;
  }
}

/* -------------------------------------------------------------------------- */
/* Known synthetic constants documented in V5_CODE_TRACE_P0.md                */
/* -------------------------------------------------------------------------- */

const SYNTHETIC_PRICE_CONSTANTS = Object.freeze([1550, 1420, 380, 1000, 9860, 7480, 5000]);
const DEFAULT_SCORE_VALUES = Object.freeze([82, 85, 88]);
const DEFAULT_WIN_RATE_VALUES = Object.freeze([72.5, 75]);
const DEFAULT_RSI_VALUES = Object.freeze([56.4]);
const DEFAULT_VOLUME_RATIO_VALUES = Object.freeze([2.1, 2.2]);
const DEFAULT_CHANGE_PCT_VALUES = Object.freeze([1.5, 1.8, 2.1, 2.4, 3.2, 3.5]);

/** Statuses/actions that constitute a published BUY recommendation. */
const READY_TOKENS = Object.freeze(['READY', 'BUY', 'A+', 'SIAP ENTRY']);

/** Statuses meaning "no value is available" (must never render as numeric 0). */
const MISSING_STATUSES = Object.freeze(['MISSING', 'PARTIAL', 'ABSENT', 'UNAVAILABLE', 'NO_DATA', 'EMPTY']);

/* -------------------------------------------------------------------------- */
/* Path + IO helpers                                                          */
/* -------------------------------------------------------------------------- */

function abs(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.join(ROOT, filePath);
}

/**
 * Guarded JSON reader. Never throws.
 * @returns {{ok:boolean, path:string, data:any, error:string|null}}
 */
function loadJson(filePath) {
  const absolute = abs(filePath);
  try {
    const raw = fs.readFileSync(absolute, 'utf8');
    return { ok: true, path: absolute, data: JSON.parse(raw), error: null };
  } catch (err) {
    return { ok: false, path: absolute, data: null, error: String((err && err.message) || err) };
  }
}

/**
 * Guarded text reader. Never throws.
 * @returns {{ok:boolean, path:string, text:string|null, lines:string[], error:string|null}}
 */
function readText(filePath) {
  const absolute = abs(filePath);
  try {
    const text = fs.readFileSync(absolute, 'utf8');
    return { ok: true, path: absolute, text, lines: text.split(/\r?\n/), error: null };
  } catch (err) {
    return { ok: false, path: absolute, text: null, lines: [], error: String((err && err.message) || err) };
  }
}

/**
 * Require a module if it exists, without throwing.
 * @returns {{ok:boolean, module:any, error:string|null}}
 */
function requireOptional(modulePath) {
  const absolute = abs(modulePath);
  if (!fs.existsSync(absolute)) return { ok: false, module: null, error: 'ENOENT ' + modulePath };
  try {
    return { ok: true, module: require(absolute), error: null };
  } catch (err) {
    return { ok: false, module: null, error: String((err && err.message) || err) };
  }
}

/**
 * Require a module or raise PendingImplementation naming the required seam.
 * The control must NOT stub the missing module.
 */
function requireOrPending(modulePath, expectedExports, reason) {
  const res = requireOptional(modulePath);
  if (!res.ok) throw new PendingImplementation(modulePath, expectedExports, reason || res.error);
  return res.module;
}

/* -------------------------------------------------------------------------- */
/* Coercion helpers                                                           */
/* -------------------------------------------------------------------------- */

function num(value) {
  if (value === null || value === undefined || value === '') return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function isReadyRow(row) {
  if (!row || typeof row !== 'object') return false;
  const tokens = [row.status, row.action, row.action_label, row.grade, row.quality_grade, row.setup];
  return tokens.some((t) => {
    const s = String(t == null ? '' : t).toUpperCase();
    return s.length > 0 && READY_TOKENS.some((tok) => s.indexOf(tok) >= 0);
  });
}

function priceOf(row) {
  if (!row || typeof row !== 'object') return NaN;
  return num(row.last_price != null ? row.last_price : (row.current_price != null ? row.current_price : row.close));
}

function rrOf(row) {
  if (!row || typeof row !== 'object') return NaN;
  return num(row.rr != null ? row.rr : row.risk_reward);
}

/* -------------------------------------------------------------------------- */
/* Mandatory assertion helpers                                                */
/* -------------------------------------------------------------------------- */

/**
 * Fails if any row's published price equals a forbidden synthetic constant.
 * @param {Array<object>} rows
 * @param {Array<number>} [forbiddenValues]
 */
function assertNoConstantPrice(rows, forbiddenValues) {
  const list = Array.isArray(rows) ? rows : [];
  const forbidden = (Array.isArray(forbiddenValues) && forbiddenValues.length
    ? forbiddenValues
    : SYNTHETIC_PRICE_CONSTANTS).map(Number);
  const forbiddenSet = new Set(forbidden);
  const hits = [];
  for (const row of list) {
    const p = priceOf(row);
    if (Number.isFinite(p) && forbiddenSet.has(p)) {
      hits.push({ ticker: row && row.ticker, last_price: p });
    }
  }
  if (hits.length > 0) {
    throw new AssertionFailure(
      hits.length + '/' + list.length + ' published rows carry a synthetic price constant',
      { forbidden, hitCount: hits.length, sample: hits.slice(0, 12) }
    );
  }
  return { checked: list.length, forbidden };
}

/**
 * Fails if a group of rows is byte-identical across the given metric fields.
 * The default threshold only fires on the fallback-clone pattern (a majority
 * of the rows sharing one tuple), so coincidental pairs do not false-positive.
 *
 * @param {Array<object>} rows
 * @param {{fields?:string[], minCount?:number}} [options]
 */
function assertDistinctRows(rows, options) {
  const list = Array.isArray(rows) ? rows : [];
  const opts = options || {};
  const fields = Array.isArray(opts.fields) && opts.fields.length
    ? opts.fields
    : ['last_price', 'change_pct', 'score', 'volume_ratio'];
  const minCount = Number.isFinite(opts.minCount) && opts.minCount > 0
    ? opts.minCount
    : Math.max(2, Math.ceil(list.length / 2));

  const groups = new Map();
  for (const row of list) {
    const signature = fields.map((f) => String(row ? row[f] : '')).join('|');
    if (!groups.has(signature)) groups.set(signature, []);
    groups.get(signature).push(row);
  }

  const offenders = [];
  for (const [signature, members] of groups.entries()) {
    if (members.length >= minCount) {
      offenders.push({
        signature,
        count: members.length,
        tickers: members.map((m) => (m && m.ticker) || '(no ticker)')
      });
    }
  }

  if (offenders.length > 0) {
    throw new AssertionFailure(
      'identical metric tuples across ' + offenders.length + ' group(s) of ' + list.length + ' rows',
      { fields, minCount, distinctSignatures: groups.size, offenders }
    );
  }
  return { checked: list.length, distinct: groups.size, fields };
}

/**
 * Fails if a row is published as READY/BUY/A+/Siap Entry while rr < minRr.
 * A non-numeric or absent R/R on a ready row is also a failure (fail-closed).
 *
 * @param {Array<object>} rows
 * @param {number} [minRr=1.5]
 */
function assertRrGate(rows, minRr) {
  const list = Array.isArray(rows) ? rows : [];
  const threshold = Number.isFinite(minRr) ? Number(minRr) : 1.5;
  const violations = [];
  let readyCount = 0;
  for (const row of list) {
    if (!isReadyRow(row)) continue;
    readyCount += 1;
    const rr = rrOf(row);
    if (!Number.isFinite(rr) || rr < threshold) {
      violations.push({
        ticker: row && row.ticker,
        status: row && row.status,
        action: row && row.action,
        grade: row && (row.quality_grade || row.grade),
        rr: Number.isFinite(rr) ? rr : null
      });
    }
  }
  if (violations.length > 0) {
    throw new AssertionFailure(
      violations.length + '/' + readyCount + ' ready rows publish rr < ' + threshold,
      { threshold, readyCount, violations: violations.slice(0, 12) }
    );
  }
  return { checked: list.length, readyCount, threshold };
}

/**
 * Fails if a row is published READY/BUY while its price, score or win rate is
 * one of the known literal defaults (i.e. the verdict was not derived).
 *
 * @param {object} row
 */
function assertNoReadyFromDefaults(row) {
  if (!row || typeof row !== 'object') {
    throw new AssertionFailure('assertNoReadyFromDefaults received no row');
  }
  if (!isReadyRow(row)) return { skipped: true, reason: 'row is not a ready/BUY row' };

  const reasons = [];
  const price = priceOf(row);
  if (Number.isFinite(price) && SYNTHETIC_PRICE_CONSTANTS.indexOf(price) >= 0) {
    reasons.push('price=' + price + ' is a synthetic default constant');
  }
  const score = num(row.score != null ? row.score : row.conviction_score);
  if (Number.isFinite(score) && DEFAULT_SCORE_VALUES.indexOf(score) >= 0) {
    reasons.push('score=' + score + ' is a literal default');
  }
  const winRate = num(row.win_rate_pct != null ? row.win_rate_pct : row.winRatePct);
  if (Number.isFinite(winRate) && DEFAULT_WIN_RATE_VALUES.indexOf(winRate) >= 0) {
    reasons.push('win_rate_pct=' + winRate + ' is a literal default');
  }
  if (reasons.length > 0) {
    throw new AssertionFailure(
      'ready verdict derived from defaults for ' + (row.ticker || '(no ticker)'),
      { ticker: row.ticker, reasons }
    );
  }
  return { ticker: row.ticker };
}

/**
 * Fails if a dataset declared MISSING/PARTIAL renders a numeric 0 instead of an
 * explicit absence marker.
 *
 * @param {*} value rendered or raw value
 * @param {string} status dataset status (MISSING / PARTIAL / …)
 */
function assertMissingNotZero(value, status) {
  const st = String(status == null ? '' : status).toUpperCase();
  const isMissing = MISSING_STATUSES.some((s) => st.indexOf(s) >= 0);
  if (!isMissing) return { checked: false, status: st };
  const numericZero = (typeof value === 'number' && value === 0)
    || (typeof value === 'string' && /^\s*(rp\s*)?0([.,]0+)?\s*$/i.test(value));
  if (numericZero) {
    throw new AssertionFailure(
      'dataset status ' + st + ' rendered a numeric zero instead of an explicit absence marker',
      { status: st, value }
    );
  }
  return { checked: true, status: st, value };
}

/* -------------------------------------------------------------------------- */
/* Result collector                                                           */
/* -------------------------------------------------------------------------- */

/** Canonical status vocabulary (contract: never report PASS for a skip). */
const STATUS = Object.freeze({
  DETECTED: 'DETECTED',
  PASSED: 'PASSED',
  PENDING: 'PENDING_IMPLEMENTATION',
  SKIP: 'SKIP',
  BROKEN: 'BROKEN_CONTROL',
  REGRESSION: 'REGRESSION'
});

/**
 * Create an isolated reporter.
 * `report(name, status, detail)` appends and returns the record; `toJSON()`
 * returns the full collected array for machine-readable evidence.
 */
function createReporter(options) {
  const opts = options || {};
  const results = [];
  function report(name, status, detail) {
    const record = {
      name: String(name),
      status: String(status),
      detail: detail === undefined ? null : detail,
      at: new Date().toISOString()
    };
    results.push(record);
    if (opts.echo === true) process.stdout.write(JSON.stringify(record) + '\n');
    return record;
  }
  function toJSON() {
    return results.slice();
  }
  return { report, toJSON, results };
}

/** Default module-level collector (used when no reporter is passed). */
const _defaultReporter = createReporter({ echo: false });

/**
 * `report(name, status, detail)` collector emitting JSON.
 * @returns the collected record
 */
function report(name, status, detail) {
  return _defaultReporter.report(name, status, detail);
}

/** Machine-readable dump of everything reported through the default collector. */
function reportToJSON() {
  return { generatedAt: new Date().toISOString(), root: ROOT, results: _defaultReporter.toJSON() };
}

module.exports = {
  ROOT,
  // errors
  AssertionFailure,
  PendingImplementation,
  SkipControl,
  STATUS,
  // constants
  SYNTHETIC_PRICE_CONSTANTS,
  DEFAULT_SCORE_VALUES,
  DEFAULT_WIN_RATE_VALUES,
  DEFAULT_RSI_VALUES,
  DEFAULT_VOLUME_RATIO_VALUES,
  DEFAULT_CHANGE_PCT_VALUES,
  READY_TOKENS,
  MISSING_STATUSES,
  // io
  abs,
  loadJson,
  readText,
  requireOptional,
  requireOrPending,
  // coercion
  num,
  isReadyRow,
  priceOf,
  rrOf,
  // assertions
  assertNoConstantPrice,
  assertDistinctRows,
  assertRrGate,
  assertNoReadyFromDefaults,
  assertMissingNotZero,
  // reporting
  createReporter,
  report,
  reportToJSON
};