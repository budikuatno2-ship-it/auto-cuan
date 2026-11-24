'use strict';

/**
 * lib/manual-screener.js
 * ============================================================================
 * V6 (W2b / Feature 13E) — Manual Screener rule engine.
 *
 * A validated, pure-JS rule engine over the data this repository already has on
 * disk. It NEVER builds SQL: every rule is evaluated in memory against a
 * normalised row, so string-injection is structurally impossible. Unknown
 * fields/operators and non-numeric values for numeric operators are rejected
 * at validation time.
 *
 * DATA ACCESSORS (all pre-existing, cited):
 *   - price / change_pct / volume / value_traded / atr14_pct / rsi14 /
 *     ma20_distance_pct  <- data/daily-candles/<TICKER>.json
 *        (same shape the chart engine reads: { ticker, candles:[{date,open,
 *         high,low,close,volume}] })
 *   - foreign_net / broker_concentration_cr3
 *        <- data/broker-accumulation/<TICKER>.json
 *           (latest.windows['1H'].foreign.net_val and .all.top_buyers)
 *   - free_float_pct / hsc_status
 *        <- data/insider-network/ownership_30sep2026.json (freeFloat) and
 *           data/market-structure-manual-overrides.json (verified fallbacks)
 *   - market_cap
 *        <- data/market-structure-manual-overrides.json (rows[].market_cap)
 *   - pbv / per / roe_ttm / der / eps
 *        <- optional fundamentals map (data/fundamentals/<TICKER>.json if
 *           present). This repo keeps fundamentals in the VPS SQLite/Supabase
 *           store, not on disk, so these resolve to null locally and are
 *           honestly reported as such (never fabricated).
 *
 * STALENESS: a ticker whose latest candle is older than MAX_STALE_DAYS is
 * EXCLUDED and counted in `excluded_stale`; it is never ranked with stale
 * numbers. Uses the same WIB-anchored age logic as lib/readiness-engine.js.
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');

// M-P1a Defect B: fundamentals MUST come from the canonical adapter
// (SQLite VPS store -> financial snapshot pipeline -> honest UNKNOWN),
// never from data/fundamentals/<TICKER>.json (Defect B fix).
const fundamentalsAdapter = require('./financial-fundamentals-adapter');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CANDLE_DIR = path.join(DATA_DIR, 'daily-candles');
const BROKER_DIR = path.join(DATA_DIR, 'broker-accumulation');
const OWNERSHIP_FILE = path.join(DATA_DIR, 'insider-network', 'ownership_30sep2026.json');
const OVERRIDES_FILE = path.join(DATA_DIR, 'market-structure-manual-overrides.json');
const FUNDAMENTALS_DIR = path.join(DATA_DIR, 'fundamentals');

const QUERY_VERSION = 'manual-screener-v2-full-universe';
const MAX_STALE_DAYS = 5;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
// M-P1a Defect A: the universe is NEVER truncated any more. The legacy cap
// constants stay exported for API compatibility but are REPORT-ONLY:
// runScreen() scans the full eligible universe and reports coverage.
const LEGACY_DEFAULT_UNIVERSE_CAP = 400;
const MAX_UNIVERSE_CAP = 964;
// Pseudo-tickers (synthetic fixtures) are excluded from production scans.
const PSEUDO_TICKERS = new Set(['CURR1', 'GUARD1', 'GUARD2', 'GUARD3', 'GUARD4', 'GUARD5', 'GUARD6', 'HIST1']);

const OPS = Object.freeze(['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'between', 'is_null', 'not_null']);
const NUMERIC_OPS = Object.freeze(['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'between']);
const LOGICS = Object.freeze(['AND', 'OR']);

/**
 * Field registry. `kind` is 'number' or 'enum'. `get(row)` reads the normalised
 * row produced by buildUniverseRow().
 */
const FIELDS = Object.freeze({
  price: { kind: 'number', get: (r) => r.price },
  change_pct: { kind: 'number', get: (r) => r.change_pct },
  volume: { kind: 'number', get: (r) => r.volume },
  value_traded: { kind: 'number', get: (r) => r.value_traded },
  market_cap: { kind: 'number', get: (r) => r.market_cap },
  pbv: { kind: 'number', get: (r) => r.pbv },
  per: { kind: 'number', get: (r) => r.per },
  roe_ttm: { kind: 'number', get: (r) => r.roe_ttm },
  der: { kind: 'number', get: (r) => r.der },
  eps: { kind: 'number', get: (r) => r.eps },
  foreign_net: { kind: 'number', get: (r) => r.foreign_net },
  broker_concentration_cr3: { kind: 'number', get: (r) => r.broker_concentration_cr3 },
  hsc_status: { kind: 'enum', get: (r) => r.hsc_status },
  free_float_pct: { kind: 'number', get: (r) => r.free_float_pct },
  atr14_pct: { kind: 'number', get: (r) => r.atr14_pct },
  rsi14: { kind: 'number', get: (r) => r.rsi14 },
  ma20_distance_pct: { kind: 'number', get: (r) => r.ma20_distance_pct }
});

const FIELD_NAMES = Object.freeze(Object.keys(FIELDS));

/* -------------------------------------------------------------------------- */
/* Small numeric helpers                                                      */
/* -------------------------------------------------------------------------- */

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(v, d) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return null;
  const f = Math.pow(10, d == null ? 2 : d);
  return Math.round(Number(v) * f) / f;
}

function readJsonSafe(p, def) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return def === undefined ? null : def;
  }
}

/* -------------------------------------------------------------------------- */
/* Derived indicators (pure)                                                  */
/* -------------------------------------------------------------------------- */

function computeAtr14(candles) {
  if (!Array.isArray(candles) || candles.length < 15) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const tr = Math.max(
      Number(c.high) - Number(c.low),
      Math.abs(Number(c.high) - Number(p.close)),
      Math.abs(Number(c.low) - Number(p.close))
    );
    if (Number.isFinite(tr)) trs.push(tr);
  }
  if (trs.length < 14) return null;
  const last14 = trs.slice(-14);
  return last14.reduce((a, b) => a + b, 0) / 14;
}

function computeRsi14(candles) {
  if (!Array.isArray(candles) || candles.length < 15) return null;
  let gain = 0;
  let loss = 0;
  for (let i = candles.length - 14; i < candles.length; i++) {
    const diff = Number(candles[i].close) - Number(candles[i - 1].close);
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  const avgGain = gain / 14;
  const avgLoss = loss / 14;
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function computeMa20(candles) {
  if (!Array.isArray(candles) || candles.length < 20) return null;
  const last20 = candles.slice(-20);
  return last20.reduce((a, c) => a + Number(c.close), 0) / 20;
}

/* -------------------------------------------------------------------------- */
/* Universe loading                                                           */
/* -------------------------------------------------------------------------- */

let _ownershipCache = null;
function loadOwnershipMap() {
  if (_ownershipCache) return _ownershipCache;
  const map = new Map();
  const arr = readJsonSafe(OWNERSHIP_FILE, []);
  if (Array.isArray(arr)) {
    for (const item of arr) {
      if (item && item.ticker) map.set(String(item.ticker).toUpperCase(), item);
    }
  }
  _ownershipCache = map;
  return map;
}

let _overridesCache = null;
function loadOverridesMap() {
  if (_overridesCache) return _overridesCache;
  const map = new Map();
  const doc = readJsonSafe(OVERRIDES_FILE, null);
  const rows = doc && Array.isArray(doc.rows) ? doc.rows : [];
  for (const r of rows) {
    if (r && r.ticker) map.set(String(r.ticker).toUpperCase(), r);
  }
  _overridesCache = map;
  return map;
}

/**
 * M-P1a Defect B: canonical fundamentals resolution.
 * Injection seam (tests): opts.fundamentals may be
 *   - an adapter result { values, source, as_of } (preferred), or
 *   - a legacy raw doc { pbv, per, ... } (treated as values, source
 *     LEGACY_INJECTION).
 * Production: fundamentalsAdapter.getFundamentals(ticker) — canonical
 * sources only; absent values stay null with source 'UNKNOWN' (never a
 * fabricated 0). Cites which source produced the values.
 */
function resolveFundamentals(ticker, opts) {
  const o = opts || {};
  if (o.fundamentals !== undefined) {
    const f = o.fundamentals;
    if (f && f.values) return f;
    return { values: f || {}, source: 'LEGACY_INJECTION', as_of: null };
  }
  return fundamentalsAdapter.getFundamentals(ticker);
}

function loadBrokerSummary(ticker) {
  const p = path.join(BROKER_DIR, String(ticker).toUpperCase() + '.json');
  if (!fs.existsSync(p)) return null;
  return readJsonSafe(p, null);
}

function computeCr3(allWindow) {
  if (!allWindow || !Array.isArray(allWindow.top_buyers) || !allWindow.top_buyers.length) return null;
  const positives = allWindow.top_buyers
    .map((b) => numOrNull(b.net_val))
    .filter((v) => v !== null && v > 0)
    .sort((a, b) => b - a);
  const total = positives.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const top3 = positives.slice(0, 3).reduce((a, b) => a + b, 0);
  return round((top3 / total) * 100, 2);
}

/**
 * Build a normalised universe row for one ticker from on-disk data.
 * Returns null when there is no usable candle series.
 */
function buildUniverseRow(ticker, opts) {
  const options = opts || {};
  const t = String(ticker).toUpperCase();
  const candleDoc = options.candleDoc || readJsonSafe(path.join(CANDLE_DIR, t + '.json'), null);
  if (!candleDoc || !Array.isArray(candleDoc.candles) || candleDoc.candles.length < 2) return null;
  const candles = candleDoc.candles;
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const price = numOrNull(last.close);
  if (price === null || price <= 0) return null;

  const prevClose = numOrNull(prev.close);
  const changePct = prevClose && prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : null;
  const volume = numOrNull(last.volume);
  const valueTraded = volume !== null ? price * volume : null;

  const atr = computeAtr14(candles);
  const atrPct = atr !== null ? (atr / price) * 100 : null;
  const rsi = computeRsi14(candles);
  const ma20 = computeMa20(candles);
  const ma20Dist = ma20 && ma20 > 0 ? ((price - ma20) / ma20) * 100 : null;

  const ownership = loadOwnershipMap().get(t) || null;
  const override = loadOverridesMap().get(t) || null;

  let freeFloat = null;
  if (override && numOrNull(override.free_float_pct) !== null) freeFloat = numOrNull(override.free_float_pct);
  else if (ownership && numOrNull(ownership.freeFloat) !== null) freeFloat = numOrNull(ownership.freeFloat);

  let hscStatus = null;
  if (override && override.hsc_flag === true) hscStatus = 'HSC';
  else if (override && override.hsc_flag === false) hscStatus = 'NON_HSC';
  else if (ownership && ownership.hsc_flag === true) hscStatus = 'HSC';
  else if (ownership && ownership.hsc_flag === false) hscStatus = 'NON_HSC';

  const marketCap = override ? numOrNull(override.market_cap) : null;

  const broker = options.brokerDoc !== undefined ? options.brokerDoc : loadBrokerSummary(t);
  let foreignNet = null;
  let cr3 = null;
  if (broker && broker.latest && broker.latest.windows && broker.latest.windows['1H']) {
    const w = broker.latest.windows['1H'];
    if (w.foreign) foreignNet = numOrNull(w.foreign.net_val);
    cr3 = computeCr3(w.all);
  }

  const fund = resolveFundamentals(t, options);
  const fv = (fund && fund.values) ? fund.values : (fund || {});

  return {
    ticker: t,
    price: round(price, 2),
    change_pct: round(changePct, 2),
    volume: volume,
    value_traded: valueTraded,
    market_cap: marketCap,
    pbv: numOrNull(fv.pbv),
    per: numOrNull(fv.per),
    roe_ttm: numOrNull(fv.roe_ttm),
    der: numOrNull(fv.der),
    eps: numOrNull(fv.eps),
    foreign_net: foreignNet,
    broker_concentration_cr3: cr3,
    hsc_status: hscStatus,
    free_float_pct: freeFloat,
    atr14_pct: round(atrPct, 2),
    rsi14: round(rsi, 2),
    ma20_distance_pct: round(ma20Dist, 2),
    // M-P1a Defect B: cite which canonical source produced the values.
    values_source: (fund && fund.source) || 'UNKNOWN',
    values_as_of: (fund && fund.as_of) || null,
    _as_of: last.date || null
  };
}

/* -------------------------------------------------------------------------- */
/* Staleness                                                                  */
/* -------------------------------------------------------------------------- */

function wibToday(nowMs) {
  const d = new Date(nowMs == null ? Date.now() : nowMs);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}

function ageDays(asOf, nowMs) {
  if (!asOf || !/^\d{4}-\d{2}-\d{2}$/.test(String(asOf))) return null;
  const a = new Date(String(asOf) + 'T00:00:00+07:00').getTime();
  const b = new Date(wibToday(nowMs) + 'T00:00:00+07:00').getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.floor((b - a) / 86400000);
}

function isStale(asOf, nowMs, maxDays) {
  const age = ageDays(asOf, nowMs);
  if (age === null) return true; // unknown date is treated as stale (fail-closed)
  return age > (maxDays == null ? MAX_STALE_DAYS : maxDays);
}

/* -------------------------------------------------------------------------- */
/* Rule validation                                                            */
/* -------------------------------------------------------------------------- */

function validateRule(rule) {
  const errors = [];
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    return { ok: false, errors: ['RULE_NOT_OBJECT'] };
  }
  const field = String(rule.field || '');
  if (!Object.prototype.hasOwnProperty.call(FIELDS, field)) errors.push('UNKNOWN_FIELD:' + field);
  const op = String(rule.op || '');
  if (OPS.indexOf(op) === -1) errors.push('UNKNOWN_OP:' + op);

  if (errors.length) return { ok: false, errors };

  const kind = FIELDS[field].kind;

  if (op === 'is_null' || op === 'not_null') {
    return { ok: true, rule: { field, op } };
  }

  if (op === 'between') {
    if (!Array.isArray(rule.value) || rule.value.length !== 2) {
      return { ok: false, errors: ['BETWEEN_REQUIRES_TWO_VALUES'] };
    }
    const lo = numOrNull(rule.value[0]);
    const hi = numOrNull(rule.value[1]);
    if (lo === null || hi === null) return { ok: false, errors: ['BETWEEN_VALUES_NOT_NUMERIC'] };
    if (lo > hi) return { ok: false, errors: ['BETWEEN_LOW_GT_HIGH'] };
    return { ok: true, rule: { field, op, value: [lo, hi] } };
  }

  if (kind === 'number') {
    const v = numOrNull(rule.value);
    if (v === null) return { ok: false, errors: ['VALUE_NOT_NUMERIC'] };
    return { ok: true, rule: { field, op, value: v } };
  }

  // enum field
  const v = String(rule.value == null ? '' : rule.value).trim().toUpperCase();
  if (!v) return { ok: false, errors: ['VALUE_EMPTY'] };
  if (!/^[A-Z_]{1,32}$/.test(v)) return { ok: false, errors: ['VALUE_NOT_ALLOWED'] };
  return { ok: true, rule: { field, op, value: v } };
}

/**
 * Validate a rule group. Supports exactly one level of nesting:
 *   { logic:'AND'|'OR', rules:[ {field,op,value} | {logic,rules:[...]} ] }
 */
function validateGroup(group, depth) {
  const d = depth || 0;
  if (d > 1) return { ok: false, errors: ['NESTING_TOO_DEEP'] };
  if (!group || typeof group !== 'object' || Array.isArray(group)) {
    return { ok: false, errors: ['GROUP_NOT_OBJECT'] };
  }
  const logic = String(group.logic || 'AND').toUpperCase();
  if (LOGICS.indexOf(logic) === -1) return { ok: false, errors: ['UNKNOWN_LOGIC:' + logic] };
  if (!Array.isArray(group.rules)) return { ok: false, errors: ['RULES_NOT_ARRAY'] };

  const out = [];
  const errors = [];
  for (const item of group.rules) {
    if (item && typeof item === 'object' && Array.isArray(item.rules)) {
      const sub = validateGroup(item, d + 1);
      if (!sub.ok) errors.push(...sub.errors);
      else out.push(sub.group);
    } else {
      const r = validateRule(item);
      if (!r.ok) errors.push(...r.errors);
      else out.push(r.rule);
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, group: { logic, rules: out } };
}

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                 */
/* -------------------------------------------------------------------------- */

function compare(value, op, target) {
  switch (op) {
    case 'gt': return value > target;
    case 'gte': return value >= target;
    case 'lt': return value < target;
    case 'lte': return value <= target;
    case 'eq': return value === target;
    case 'neq': return value !== target;
    case 'between': return value >= target[0] && value <= target[1];
    default: return false;
  }
}

/**
 * M-P1a Defect C — three-valued (TRUE/FALSE/UNKNOWN) rule evaluation.
 * Returns { pass: boolean, unknown: boolean, explanation: string }:
 *   pass===true, unknown=false => TRUE
 *   pass===false, unknown=false => FALSE
 *   pass===false, unknown=true  => UNKNOWN (a compared field was null)
 * A null field NEVER counts as FALSE — it is UNKNOWN so that
 *   TRUE OR UNKNOWN  folds to TRUE  (ticker matched),
 *   FALSE OR UNKNOWN folds to UNKNOWN (excluded_unknown),
 *   TRUE AND UNKNOWN folds to UNKNOWN,
 *   FALSE AND UNKNOWN folds to FALSE.
 */
function evaluateRule(rule, row) {
  const def = FIELDS[rule.field];
  const value = def.get(row);
  const raw = def.kind === 'number' ? numOrNull(value) : value;
  const label = rule.field;

  if (rule.op === 'is_null') {
    const isNull = raw === null || raw === undefined;
    return { pass: isNull, unknown: false, explanation: label + ' is_null=' + isNull };
  }
  if (rule.op === 'not_null') {
    const notNull = raw !== null && raw !== undefined;
    return { pass: notNull, unknown: false, explanation: label + ' not_null=' + notNull };
  }

  if (raw === null || raw === undefined) {
    // UNKNOWN, not FALSE: distinguishes "no data yet" from a proven mismatch.
    return { pass: false, unknown: true, explanation: label + ' = null (unknown)' };
  }

  if (def.kind === 'enum') {
    const pass = compare(String(raw).toUpperCase(), rule.op, String(rule.value).toUpperCase());
    return { pass, unknown: false, explanation: label + ' ' + rule.op + ' ' + rule.value + ' = ' + pass };
  }

  const pass = compare(Number(raw), rule.op, rule.value);
  const shown = rule.op === 'between' ? '[' + rule.value[0] + ',' + rule.value[1] + ']' : rule.value;
  return { pass, unknown: false, explanation: label + ' ' + rule.op + ' ' + shown + ' (=' + raw + ') = ' + pass };
}

/** Three-valued fold: TRUE=1, UNKNOWN=0, FALSE=-1 semantics over pass/unknown. */
function foldResults(results, logic) {
  const anyTrue = results.some((r) => r.pass === true);
  const anyUnknown = results.some((r) => r.unknown === true);
  if (logic === 'OR') {
    // TRUE OR UNKNOWN = TRUE; FALSE OR UNKNOWN = UNKNOWN; TRUE OR x = TRUE;
    // all-FALSE = FALSE.
    return { pass: anyTrue, unknown: !anyTrue && anyUnknown };
  }
  // AND: FALSE AND x = FALSE; TRUE AND UNKNOWN = UNKNOWN; all-TRUE = TRUE.
  return { pass: !results.some((r) => r.pass === false && r.unknown !== true) && results.every((r) => r.pass === true), unknown: anyUnknown && !results.some((r) => r.pass === false && r.unknown !== true) };
}

function evaluateGroup(group, row) {
  const results = [];
  for (const item of group.rules) {
    if (item.rules) {
      const sub = evaluateGroup(item, row);
      results.push({ pass: sub.pass, unknown: sub.unknown, explanation: '(' + sub.explanation + ')' });
    } else {
      results.push(evaluateRule(item, row));
    }
  }
  const folded = foldResults(results, group.logic);
  return {
    pass: folded.pass,
    unknown: folded.unknown,
    explanation: results.map((r) => r.explanation).join(group.logic === 'OR' ? ' OR ' : ' AND ')
  };
}

/* -------------------------------------------------------------------------- */
/* Universe enumeration                                                       */
/* -------------------------------------------------------------------------- */

function listUniverseTickers() {
  try {
    return fs.readdirSync(CANDLE_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, '').toUpperCase())
      .sort();
  } catch (_) {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Run a manual screen.
 *
 * @param {object} input
 *   rules   — a rule group (or null/empty for "no filter")
 *   limit   — max results (capped at MAX_LIMIT)
 *   sort    — { field, dir:'asc'|'desc' }
 *   universeCap — max tickers scanned (capped at MAX_UNIVERSE_CAP)
 *   nowMs   — injectable clock for tests
 *   rows    — injectable pre-built rows for tests (bypasses disk)
 * @returns {object} result envelope
 */
function runScreen(input) {
  const opts = input || {};
  const nowMs = opts.nowMs == null ? Date.now() : opts.nowMs;
  const limit = Math.min(Math.max(Number(opts.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  // M-P1a Defect A: universeCap is REPORT-ONLY. The full eligible universe is
  // ALWAYS scanned; no silent truncation. (Kept for result-shape compat.)
  const universeCap = Math.min(Math.max(Number(opts.universeCap) || MAX_UNIVERSE_CAP, 1), MAX_UNIVERSE_CAP);

  // Validate rules. Empty/absent rules => no filter (default), still capped.
  let group = null;
  if (opts.rules && (Array.isArray(opts.rules) ? opts.rules.length : true)) {
    const v = validateGroup(opts.rules, 0);
    if (!v.ok) {
      return {
        ok: false,
        error: 'INVALID_RULES',
        details: v.errors,
        query_version: QUERY_VERSION
      };
    }
    group = v.group;
  }

  // Historical data values are not yet versioned. Offer an eligibility preflight,
  // never pass today's fundamentals/ownership as historically known values.
  if (opts.strictAsOf === true || opts.asOf != null) {
    const {validDay} = require('./insider-source-visibility');
    if (!validDay(opts.asOf)) return {ok:false,error:'INVALID_ASOF_DATE',query_version:QUERY_VERSION};
    const candidates = Array.isArray(opts.rows) ? opts.rows.map(r => r.ticker) : listUniverseTickers();
    const preflight = require('./historical-ticker-eligibility').preflightEligibility(candidates,opts.asOf,opts.eligibilityReference);
    return {ok:true,matched:[],matched_count:0,returned_count:0,total_universe:candidates.length,
      scanned:0,excluded_null:0,excluded_stale:0,excluded_synthetic:0,excluded_unknown:preflight.rows.filter(r=>r.status==='UNKNOWN').length,
      eligibility:preflight.rows,eligibility_status:preflight.status,historical_status:'NOT_VERIFIABLE',
      historical_reason:'POINT_IN_TIME_SCREEN_VALUES_NOT_VERIFIED',historical_denominator:null,
      source_as_of:null,query_version:QUERY_VERSION,limit,universe_cap:universeCap,universe_truncated:false,rules_applied:group ? group.rules.length : 0};
  }

  // M-P1a Defect A: build the FULL universe — every ticker on disk is
  // scanned; no silent alphabetical truncation.
  let rows;
  if (Array.isArray(opts.rows)) {
    rows = opts.rows.slice();
  } else {
    const tickers = listUniverseTickers();
    rows = [];
    for (const t of tickers) {
      if (PSEUDO_TICKERS.has(t)) continue; // synthetic fixtures never screened
      const row = buildUniverseRow(t, {});
      if (row) rows.push(row);
    }
  }

  const totalUniverse = rows.length;
  let excludedStale = 0;
  let excludedNull = 0;
  let excludedSynthetic = 0;
  let excludedUnknown = 0;
  const matched = [];
  let sourceAsOf = null;

  for (const row of rows) {
    if (isStale(row._as_of, nowMs, MAX_STALE_DAYS)) {
      excludedStale += 1;
      continue;
    }
    if (row._as_of && (!sourceAsOf || row._as_of > sourceAsOf)) sourceAsOf = row._as_of;

    if (!group) {
      matched.push({ ticker: row.ticker, values: publicValues(row), matched_rules_explanation: 'no filter (default)' });
      continue;
    }

    // M-P1a Defect C: three-valued (TRUE/FALSE/UNKNOWN) group folding.
    // TRUE OR UNKNOWN => TRUE (matched); FALSE OR UNKNOWN => UNKNOWN;
    // TRUE AND UNKNOWN => UNKNOWN; FALSE AND UNKNOWN => FALSE.
    const ev = evaluateGroup(group, row);
    if (ev.pass === true) {
      matched.push({ ticker: row.ticker, values: publicValues(row), matched_rules_explanation: ev.explanation });
    } else if (ev.unknown === true) {
      // "Not matched yet" but distinguishable from a hard FALSE — counted,
      // never silently dropped from the semantics.
      excludedUnknown += 1;
    } else {
      excludedNull += 1;
    }
  }

  // Sort.
  const sort = opts.sort && opts.sort.field && FIELDS[opts.sort.field] ? opts.sort : null;
  if (sort) {
    const dir = String(sort.dir || 'desc').toLowerCase() === 'asc' ? 1 : -1;
    const getter = FIELDS[sort.field].get;
    matched.sort((a, b) => {
      const av = getter(a.values);
      const bv = getter(b.values);
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return (av - bv) * dir;
    });
  }

  const capped = matched.slice(0, limit);

  return {
    ok: true,
    matched: capped,
    matched_count: matched.length,
    returned_count: capped.length,
    // M-P1a Defect A coverage — honest, no silent truncation:
    total_universe: totalUniverse,     // full eligible universe size
    scanned: totalUniverse,           // equals total_universe: full scan
    excluded_null: excludedNull,      // hard FALSE (incl. null-compare fails)
    excluded_stale: excludedStale,
    excluded_synthetic: excludedSynthetic,
    excluded_unknown: excludedUnknown, // three-valued UNKNOWN ("not matched yet")
    source_as_of: sourceAsOf,
    query_version: QUERY_VERSION,
    limit,
    universe_cap: universeCap,        // report-only legacy field
    universe_truncated: false,        // explicit contract: never truncated
    rules_applied: group ? group.rules.length : 0
  };
}

function publicValues(row) {
  const out = {};
  for (const f of FIELD_NAMES) out[f] = FIELDS[f].get(row);
  out.ticker = row.ticker;
  out.as_of = row._as_of || null;
  // M-P1a Defect B: cite which canonical source produced the fundamentals.
  out.values_source = row.values_source || 'UNKNOWN';
  out.values_as_of = row.values_as_of || null;
  return out;
}

module.exports = {
  QUERY_VERSION,
  MAX_STALE_DAYS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  DEFAULT_UNIVERSE_CAP: LEGACY_DEFAULT_UNIVERSE_CAP,
  LEGACY_DEFAULT_UNIVERSE_CAP,
  PSEUDO_TICKERS,
  MAX_UNIVERSE_CAP,
  OPS,
  LOGICS,
  FIELDS,
  FIELD_NAMES,
  validateRule,
  validateGroup,
  evaluateRule,
  evaluateGroup,
  buildUniverseRow,
  listUniverseTickers,
  isStale,
  ageDays,
  computeAtr14,
  computeRsi14,
  computeMa20,
  computeCr3,
  runScreen
};
