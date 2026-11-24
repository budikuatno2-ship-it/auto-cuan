'use strict';

/**
 * lib/broksum-provenance.js
 * ===========================
 * V6-F5b — SHARED PROVENANCE GUARD for the broker-summary datasets.
 *
 * WHY
 * ---
 * The `data/arjum-data/broker-summary{,-F,-D}/<TICKER>/<DATE>.json` family has
 * accumulated several classes of payload that MUST NOT reach a signal:
 *
 *   STALE            the payload's own session window is not the requested
 *                    date (broker_start_date / broker_end_date point at an
 *                    earlier session). F4b repaired 617 such files; the guard
 *                    makes the class detectable instead of implicit.
 *   SYNTHETIC        the payload was NOT produced by the provider but derived
 *                    locally (scripts/domestic-compile.js writes
 *                    `provenance: 'DERIVED_LOCAL'` + `computed_from:` into
 *                    broker-summary-F/ when it filters ALL by a hardcoded
 *                    16-code FOREIGN_SET).
 *   NO_TRADE_FOR_FLOW the provider legitimately released the session with zero
 *                    broker rows (a real, provable non-trade). Usable as a
 *                    "no trade" fact; NOT usable as a flow magnitude.
 *   FIXTURE          a hand-made test/demo payload.
 *   DATE_MISMATCH    the payload covers a different session than requested.
 *
 * The contract is fail-closed: `isActionableBrokerDataset` returns false unless
 * the payload is a genuine provider original for the exact session asked for
 * AND carries a non-degenerate flow.
 *
 * This module is PURE (no I/O, no network, no clock dependency other than an
 * explicit `now` argument) so it is trivially testable and safe to call from
 * any consumer.
 */

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Dataset identifiers understood by this module. */
const DATASETS = Object.freeze({
  ALL: 'ALL',
  FOREIGN: 'F',
  DOMESTIC: 'D'
});

/** Reasons `isActionableBrokerDataset` can refuse a payload. */
const REJECT_REASONS = Object.freeze({
  MISSING_PAYLOAD: 'MISSING_PAYLOAD',
  NOT_AN_OBJECT: 'NOT_AN_OBJECT',
  FIXTURE: 'FIXTURE',
  SYNTHETIC: 'SYNTHETIC',
  DERIVED_LOCAL: 'DERIVED_LOCAL',
  DATE_MISMATCH: 'DATE_MISMATCH',
  DATE_ABSENT: 'DATE_ABSENT',
  NO_TRADE_FOR_FLOW: 'NO_TRADE_FOR_FLOW',
  ZERO_VOLUME: 'ZERO_VOLUME',
  INCOMPLETE: 'INCOMPLETE',
  FOREIGN_NOT_RELEASED: 'FOREIGN_NOT_RELEASED',
  DATASET_MISMATCH: 'DATASET_MISMATCH'
});

const STATUS_NOT_RELEASED = new Set([
  'foreign_missing',
  'FOREIGN_NOT_RELEASED',
  'NO_ALL_DATA',
  'ALL_CLIPPED_INCOMPLETE'
]);

/**
 * `computed_from` values that are ACCEPTABLE.
 *
 * 'all_minus_foreign' is the documented, canonical Domestic identity
 * (`lib/broksum-flow.js :: computeDomestic` and
 * `lib/broker-accumulation-local.js :: computeDomesticBroksum` both emit it).
 * A Domestic payload computed that way is a legitimate derivation and must
 * NOT be rejected as synthetic.
 *
 * Any OTHER `computed_from` value denotes a locally-derived file that the
 * consumer cannot treat as a provider original — most importantly
 * 'broker_code_heuristic_from_all', which
 * `scripts/domestic-compile.js` writes into `broker-summary-F/` when it
 * filters ALL by a hardcoded 16-code FOREIGN_SET. That file is a SUBSET of
 * ALL, not the provider's foreign feed.
 */
const ALLOWED_COMPUTED_FROM = new Set(['all_minus_foreign']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function cleanNumber(val) {
  if (val == null || val === '') return 0;
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Broker rows of a broksum payload, in the canonical preference order used by
 * `lib/broker-accumulation-local.js :: parseDailyBroksumLevels`.
 */
function brokerRows(payload) {
  if (!isPlainObject(payload)) return [];
  if (Array.isArray(payload.brokers) && payload.brokers.length) return payload.brokers;
  if (Array.isArray(payload.data) && payload.data.length) return payload.data;
  const out = [];
  if (Array.isArray(payload.broker_levels)) {
    for (const lvl of payload.broker_levels) {
      if (!lvl) continue;
      if (lvl.buy) out.push(lvl.buy);
      if (lvl.sell) out.push(lvl.sell);
    }
  }
  return out;
}

/** Aggregate volume/value of a payload's broker rows. */
function flowTotals(payload) {
  let buyVal = 0, sellVal = 0, buyVol = 0, sellVol = 0;
  for (const b of brokerRows(payload)) {
    if (!b) continue;
    buyVal += cleanNumber(b.bval != null ? b.bval : b.buy_val);
    sellVal += cleanNumber(b.sval != null ? b.sval : b.sell_val);
    buyVol += cleanNumber(b.bvol != null ? b.bvol : b.buy_vol);
    sellVol += cleanNumber(b.svol != null ? b.svol : b.sell_vol);
  }
  return { buyVal, sellVal, buyVol, sellVol, totalVol: buyVol + sellVol, rowCount: brokerRows(payload).length };
}

/**
 * Session window of a payload. The canonical shape carries
 * broker_start_date / broker_end_date; the modern shape carries `date`.
 */
function sessionWindow(payload) {
  if (!isPlainObject(payload)) return { start: null, end: null };
  const start = payload.broker_start_date || payload.date || payload.trade_date || null;
  const end = payload.broker_end_date || payload.date || payload.trade_date || null;
  return { start: start || null, end: end || null };
}

/** Normalise a dataset identifier. Accepts 'all' | 'ALL' | 'F' | 'foreign' | 'D' | 'domestic'. */
function normalizeDataset(dataset) {
  if (dataset == null) return null;
  const s = String(dataset).trim().toUpperCase();
  if (s === 'ALL' || s === 'ALL_DATA') return DATASETS.ALL;
  if (s === 'F' || s === 'FOREIGN' || s === 'FOREIGN_FLOW') return DATASETS.FOREIGN;
  if (s === 'D' || s === 'DOMESTIC' || s === 'DOMESTIC_FLOW') return DATASETS.DOMESTIC;
  return null;
}

// ---------------------------------------------------------------------------
// Core predicate
// ---------------------------------------------------------------------------

/**
 * Decide whether a broker-summary payload may be used as an actionable flow.
 *
 * @param {object} options
 * @param {object|null} options.dataset    the payload (ALL / F / D record)
 * @param {string} [options.date]          the session the caller asked for
 * @param {string} [options.ticker]        the ticker the caller asked for
 * @param {string} [options.flow]          expected dataset id ('ALL'|'F'|'D')
 * @param {boolean} [options.allowNoTrade] treat a proven NO_TRADE session as
 *                                         actionable (default false)
 * @param {boolean} [options.allowFixture] accept fixture payloads (default false)
 * @param {boolean} [options.requireVolume] require a non-zero flow (default true)
 * @returns {{actionable:boolean, reason:string, detail:string, flow:object}}
 */
function isActionableBrokerDataset(options = {}) {
  const {
    dataset,
    date,
    ticker,
    flow,
    allowNoTrade = false,
    allowFixture = false,
    requireVolume = true
  } = options || {};

  const deny = (reason, detail) => ({
    actionable: false,
    reason,
    detail: detail || '',
    flow: { buyVal: 0, sellVal: 0, buyVol: 0, sellVol: 0, totalVol: 0, rowCount: 0 }
  });

  if (dataset === null || dataset === undefined) {
    return deny(REJECT_REASONS.MISSING_PAYLOAD, 'dataset is null/undefined');
  }
  if (!isPlainObject(dataset)) {
    return deny(REJECT_REASONS.NOT_AN_OBJECT, typeof dataset);
  }

  // --- FIXTURE -------------------------------------------------------------
  const fixtureFlag = dataset.is_fixture === true ||
    dataset.fixture === true ||
    String(dataset.data_status || '').toUpperCase() === 'FIXTURE' ||
    String(dataset.provenance || '').toUpperCase() === 'FIXTURE';
  if (fixtureFlag && !allowFixture) {
    return deny(REJECT_REASONS.FIXTURE, 'fixture payload');
  }

  // --- SYNTHETIC / DERIVED -------------------------------------------------
  const provenance = String(dataset.provenance || '').toUpperCase();
  if (provenance === 'DERIVED_LOCAL') {
    return deny(REJECT_REASONS.DERIVED_LOCAL, 'provenance=DERIVED_LOCAL');
  }
  if (dataset.computed_from) {
    const cf = String(dataset.computed_from);
    const isDomesticIdentity = normalizeDataset(dataset.flow) === DATASETS.DOMESTIC &&
      ALLOWED_COMPUTED_FROM.has(cf);
    if (!isDomesticIdentity) {
      return deny(REJECT_REASONS.SYNTHETIC, 'computed_from=' + cf);
    }
  }
  if (String(dataset.status || '').toUpperCase() === 'LEGACY') {
    return deny(REJECT_REASONS.SYNTHETIC, 'status=LEGACY');
  }
  if (String(dataset.data_status || '').toUpperCase() === 'DERIVED') {
    return deny(REJECT_REASONS.SYNTHETIC, 'data_status=DERIVED');
  }

  // --- DATASET IDENTITY ----------------------------------------------------
  const expectedFlow = normalizeDataset(flow);
  if (expectedFlow) {
    const actualFlow = normalizeDataset(dataset.flow);
    if (actualFlow && actualFlow !== expectedFlow) {
      return deny(REJECT_REASONS.DATASET_MISMATCH, 'expected=' + expectedFlow + ' actual=' + actualFlow);
    }
  }

  // --- STATUS --------------------------------------------------------------
  const status = String(dataset.status || '').toUpperCase();
  if (status === 'FOREIGN_NOT_RELEASED') {
    return deny(REJECT_REASONS.FOREIGN_NOT_RELEASED, dataset.status);
  }
  if (status && STATUS_NOT_RELEASED.has(status)) {
    return deny(REJECT_REASONS.INCOMPLETE, dataset.status);
  }
  // `is_complete: false` is the repo's own fail-closed marker (see
  // lib/broksum-flow.js, which refuses a foreign side with is_complete false).
  if (dataset.is_complete === false) {
    return deny(REJECT_REASONS.INCOMPLETE, 'is_complete=false');
  }

  // --- DATE IDENTITY -------------------------------------------------------
  const win = sessionWindow(dataset);
  if (date) {
    const want = String(date).trim();
    if (!win.start || !win.end) {
      return deny(REJECT_REASONS.DATE_ABSENT, 'no session window on payload');
    }
    if (win.start !== want || win.end !== want) {
      return deny(REJECT_REASONS.DATE_MISMATCH, 'want=' + want + ' got=' + win.start + '/' + win.end);
    }
  }

  // --- TICKER IDENTITY -----------------------------------------------------
  if (ticker) {
    const want = String(ticker).trim().toUpperCase();
    const got = String(dataset.stock_code || dataset.ticker || '').trim().toUpperCase();
    if (got && got !== want) {
      return deny(REJECT_REASONS.DATE_MISMATCH, 'ticker expected=' + want + ' got=' + got);
    }
  }

  // --- FLOW MAGNITUDE ------------------------------------------------------
  const totals = flowTotals(dataset);
  if (totals.rowCount === 0) {
    // A provider-released session with zero broker rows is a real NO_TRADE
    // fact. It is usable only when the caller explicitly accepts it.
    if (allowNoTrade) {
      return { actionable: true, reason: 'NO_TRADE_ACCEPTED', detail: 'zero broker rows', flow: totals };
    }
    return deny(REJECT_REASONS.NO_TRADE_FOR_FLOW, 'zero broker rows');
  }
  if (requireVolume && totals.totalVol <= 0 && totals.buyVal <= 0 && totals.sellVal <= 0) {
    return deny(REJECT_REASONS.ZERO_VOLUME, 'rows present but no volume/value');
  }

  return { actionable: true, reason: 'OK', detail: '', flow: totals };
}

/**
 * Convenience wrapper: is this payload usable as an actionable FOREIGN flow?
 * A foreign payload with no foreign rows is NOT actionable for flow purposes.
 */
function isActionableForeignFlow(dataset, options = {}) {
  return isActionableBrokerDataset(Object.assign({}, options, { dataset, flow: DATASETS.FOREIGN }));
}

/**
 * Convenience wrapper: is this payload usable as an actionable DOMESTIC flow?
 */
function isActionableDomesticFlow(dataset, options = {}) {
  return isActionableBrokerDataset(Object.assign({}, options, { dataset, flow: DATASETS.DOMESTIC }));
}

module.exports = {
  DATASETS,
  REJECT_REASONS,
  isActionableBrokerDataset,
  isActionableForeignFlow,
  isActionableDomesticFlow,
  normalizeDataset,
  sessionWindow,
  flowTotals,
  brokerRows
};
