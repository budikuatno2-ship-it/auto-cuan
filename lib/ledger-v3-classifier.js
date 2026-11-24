'use strict';
/**
 * M-P0c — Ledger V3 strict-provenance classifier.
 *
 * Fixes the V2 false-ORIGINAL bug: tmp_p0a/p0a_ledger_v2.js promoted old
 * `PRESENT` labels to VERIFIED_PROVIDER_ORIGINAL based on FILE EXISTENCE
 * (~lines 82-116), without payload verification. That inflates ORIGINAL
 * counts. V3 makes ORIGINAL evidence-based: a file that merely exists can
 * NEVER be ORIGINAL — it is UNKNOWN_SOURCE (a validation candidate).
 *
 * STATUS VOCABULARY (exact, frozen — from the master prompt).
 *
 * STRICT PRECEDENCE (highest first) — mirrors classifyForeignStatus():
 *   1.  pseudo-ticker (fixture)             -> FIXTURE_EXCLUDED
 *   2.  schema audit failures               -> INVALID_SCHEMA / WRONG_TICKER / WRONG_DATE / STALE_DATE
 *   3.  provider NO_TRADE sidecar           -> NO_FOREIGN_FLOW_PROVIDER_CONFIRMED
 *   4.  on-disk strict-identity brokers:[]  -> NO_FOREIGN_FLOW_PROVIDER_CONFIRMED
 *   5.  derived schema evidence             -> DERIVED_COMPUTED / DERIVED_PERSISTED_READBACK
 *   6.  strict-identity ORIGINAL evidence   -> ORIGINAL_PROVIDER_VALID
 *   7.  derived-computable inputs           -> DERIVED_COMPUTABLE
 *   8.  zero-volume candle                  -> NO_TRADE_TICKER_CONFIRMED / LISTED_NOT_TRADED
 *   9.  file-existence-only                 -> UNKNOWN_SOURCE (never ORIGINAL)
 *   10. roster / control-plane states       -> BLOCKED_QUOTA / NOT_LISTED / UPSTREAM_NOT_AVAILABLE / ...
 *   11. nothing                             -> UNKNOWN_CANDLE / MISSING_VERIFIED
 *
 * Candle-volume classification is DELEGATED to
 * lib/v6-foreign-classifier.js classifyCandleVolume() (''/null -> UNKNOWN_CANDLE,
 * 0 -> NO_TRADE_CANDIDATE) — the null-as-zero bug is fixed upstream and is NOT
 * duplicated here.
 */

const {
  classifyForeignStatus,
  classifyCandleVolume,
} = require('./v6-foreign-classifier');

const V3_STATUS = Object.freeze({
  ORIGINAL_PROVIDER_VALID: 'ORIGINAL_PROVIDER_VALID',
  DERIVED_COMPUTABLE: 'DERIVED_COMPUTABLE',
  DERIVED_COMPUTED: 'DERIVED_COMPUTED',
  DERIVED_PERSISTED_READBACK: 'DERIVED_PERSISTED_READBACK',
  NO_FOREIGN_FLOW_PROVIDER_CONFIRMED: 'NO_FOREIGN_FLOW_PROVIDER_CONFIRMED',
  NO_TRADE_TICKER_CONFIRMED: 'NO_TRADE_TICKER_CONFIRMED',
  UNKNOWN_CANDLE: 'UNKNOWN_CANDLE',
  UNKNOWN_SOURCE: 'UNKNOWN_SOURCE',
  SYNTHETIC_UNVERIFIED: 'SYNTHETIC_UNVERIFIED',
  FIXTURE_EXCLUDED: 'FIXTURE_EXCLUDED',
  STALE_DATE: 'STALE_DATE',
  INVALID_SCHEMA: 'INVALID_SCHEMA',
  WRONG_TICKER: 'WRONG_TICKER',
  WRONG_DATE: 'WRONG_DATE',
  MISSING_VERIFIED: 'MISSING_VERIFIED',
  UPSTREAM_NOT_AVAILABLE: 'UPSTREAM_NOT_AVAILABLE',
  BLOCKED_QUOTA: 'BLOCKED_QUOTA',
  BLOCKED_RATE_LIMIT: 'BLOCKED_RATE_LIMIT',
  NOT_LISTED: 'NOT_LISTED',
  LISTED_NOT_TRADED: 'LISTED_NOT_TRADED',
  SUSPENDED_CONFIRMED: 'SUSPENDED_CONFIRMED',
  RENAMED_CANONICALIZED: 'RENAMED_CANONICALIZED',
  DELISTED: 'DELISTED',
  NOT_ELIGIBLE: 'NOT_ELIGIBLE',
  NOT_TESTED: 'NOT_TESTED',
});

const ALL_V3_STATUSES = Object.freeze(Object.values(V3_STATUS).sort());

// Production pseudo-tickers (synthetic fixtures; excluded from denominators).
// 8 pseudo tickers x 217 hari bursa x 3 jenis flow = 5.208 total baris dieksklusi konsisten.
const PSEUDO_TICKER_COUNT = 8;
const CANONICAL_TRADING_DAYS = 217;
const CANONICAL_FLOW_TYPES = 3;
const TOTAL_PSEUDO_EXCLUDED_ROWS = PSEUDO_TICKER_COUNT * CANONICAL_TRADING_DAYS * CANONICAL_FLOW_TYPES; // 5208

const PSEUDO_TICKERS = new Set([
  'CURR1', 'GUARD1', 'GUARD2', 'GUARD3', 'GUARD4', 'GUARD5', 'GUARD6', 'HIST1',
]);

function isPseudoTicker(ticker) {
  const t = String(ticker || '').toUpperCase();
  return PSEUDO_TICKERS.has(t) || /^GUARD[1-6]$/.test(t);
}

function getPseudoTickerMetrics() {
  return {
    pseudoTickerCount: PSEUDO_TICKER_COUNT,
    tradingDaysCount: CANONICAL_TRADING_DAYS,
    flowTypesCount: CANONICAL_FLOW_TYPES,
    totalExcludedRows: TOTAL_PSEUDO_EXCLUDED_ROWS,
    pseudoTickers: Array.from(PSEUDO_TICKERS).sort()
  };
}

const SHA256_RE = /^[0-9a-f]{64}$/i;

/**
 * Strict-provenance classifier. See module doc for precedence.
 * @param {object} evidence evidence bag (all fields optional, evaluated defensively)
 * @returns {{status: string, precedence: number, reason: string}}
 */
function classifyLedgerV3(evidence) {
  const ev = evidence || {};
  const requestedDate = String(ev.requestedDate || '');

  // 1. pseudo-tickers are fixtures — excluded from production denominators.
  if (isPseudoTicker(ev.ticker)) {
    return { status: V3_STATUS.FIXTURE_EXCLUDED, precedence: 1, reason: 'pseudo_ticker_fixture' };
  }

  // 2. schema audit failures
  if (ev.wrongTicker === true) {
    return { status: V3_STATUS.WRONG_TICKER, precedence: 2, reason: 'payload_stock_code_mismatch' };
  }
  if (ev.wrongDate === true) {
    return { status: V3_STATUS.WRONG_DATE, precedence: 2, reason: 'payload_date_mismatch' };
  }
  if (ev.invalidSchema === true) {
    return { status: V3_STATUS.INVALID_SCHEMA, precedence: 2, reason: 'schema_violation' };
  }
  if (ev.staleDate === true) {
    return { status: V3_STATUS.STALE_DATE, precedence: 2, reason: 'date_outside_requested_window' };
  }

  // Strict-identity evidence may arrive either as an explicit flag or as the
  // payload identity fields themselves (payload dates present => a strict
  // scan was performed and recorded them).
  const strictEvidence =
    ev.strictIdentity === true ||
    (String(ev.payloadStartDate || '') !== '' && String(ev.payloadEndDate || '') !== '');

  // 3/4/5 flow-status precedence delegated to the M-P0b classifier.
  const foreign = classifyForeignStatus({
    sidecarNoTrade: ev.sidecarNoTrade,
    onDiskNoTrade: ev.onDiskNoTrade,
    derivedSchema: ev.derivedSchema,
    derivedBrokerRows: ev.derivedBrokerRows,
    derivedHasRealAsOf: ev.derivedHasRealAsOf,
    strictIdentity: strictEvidence,
    fileExists: ev.fileExists,
  });

  if (foreign.status === 'NO_FOREIGN_FLOW_PROVIDER_CONFIRMED') {
    const fromSidecar = foreign.precedence === 1;
    return {
      status: V3_STATUS.NO_FOREIGN_FLOW_PROVIDER_CONFIRMED,
      precedence: fromSidecar ? 3 : 4,
      reason: fromSidecar ? 'provider_sidecar_brokers_empty' : 'on_disk_brokers_empty',
    };
  }
  if (foreign.status === 'DERIVED_COMPUTED') {
    if (ev.derivedPersistedReadback === true) {
      return { status: V3_STATUS.DERIVED_PERSISTED_READBACK, precedence: 5, reason: 'derived_persisted_readback_ok' };
    }
    return { status: V3_STATUS.DERIVED_COMPUTED, precedence: 5, reason: 'derived_payload_real_rows_asof' };
  }

  // 6. STRICT-IDENTITY ORIGINAL — evidence-based, NOT existence-based.
  // Gates: strict date identity (broker_start_date||broker_end_date == requested
  // date), flow/stock_code match, non-empty brokers array, recorded sha256.
  if (strictEvidence) {
    const datesIdentical =
      String(ev.payloadStartDate || '') === requestedDate &&
      String(ev.payloadEndDate || '') === requestedDate;
    const brokersNonEmpty = Array.isArray(ev.brokers) ? ev.brokers.length > 0 : false;
    const shaRecorded = typeof ev.sha256 === 'string' && SHA256_RE.test(ev.sha256);
    const tickerMatch = !ev.payloadStockCode || String(ev.payloadStockCode) === String(ev.ticker);
    if (datesIdentical && brokersNonEmpty && shaRecorded && tickerMatch) {
      return { status: V3_STATUS.ORIGINAL_PROVIDER_VALID, precedence: 6, reason: 'strict_identity_sha256_verified' };
    }
    if (!datesIdentical) return { status: V3_STATUS.WRONG_DATE, precedence: 6, reason: 'strict_scan_date_mismatch' };
    if (!tickerMatch) return { status: V3_STATUS.WRONG_TICKER, precedence: 6, reason: 'strict_scan_code_mismatch' };
    if (!shaRecorded) return { status: V3_STATUS.UNKNOWN_SOURCE, precedence: 9, reason: 'strict_scan_no_sha256_recorded' };
    if (!brokersNonEmpty) {
      return { status: V3_STATUS.NO_FOREIGN_FLOW_PROVIDER_CONFIRMED, precedence: 4, reason: 'brokers_empty_strict_scan' };
    }
  }

  // 7. derived-computable: ALL + F inputs both valid/derivable
  if (ev.derivedComputable === true) {
    return { status: V3_STATUS.DERIVED_COMPUTABLE, precedence: 7, reason: 'all_and_f_inputs_valid' };
  }

  // 8. candle-volume evidence (delegates ''/null -> UNKNOWN_CANDLE,
  //    0 -> NO_TRADE_CANDIDATE — null-as-zero bug fixed upstream).
  const candle = classifyCandleVolume(ev.candleVolume);
  if (candle === 'NO_TRADE_CANDIDATE') {
    const confirmed = ev.noTradeConfirmed === true;
    return {
      status: confirmed ? V3_STATUS.NO_TRADE_TICKER_CONFIRMED : V3_STATUS.LISTED_NOT_TRADED,
      precedence: 8,
      reason: confirmed ? 'zero_volume_confirmed_notrade' : 'zero_volume_candidate_unconfirmed',
    };
  }
  if (candle === 'UNKNOWN_CANDLE') {
    // Existence-only beats candle-unknown: an unvalidated on-disk file is
    // a validation candidate (UNKNOWN_SOURCE), never an ORIGINAL.
    if (ev.fileExists === true) {
      return { status: V3_STATUS.UNKNOWN_SOURCE, precedence: 9, reason: 'file_existence_only_never_original' };
    }
    if (ev.upstreamAvailable === 'N') {
      return { status: V3_STATUS.UPSTREAM_NOT_AVAILABLE, precedence: 10, reason: 'upstream_unreachable_no_candle' };
    }
    return { status: V3_STATUS.UNKNOWN_CANDLE, precedence: 10, reason: 'candle_entry_missing_or_null' };
  }
  // candle === 'TRADED': fall through to existence / roster / control-plane.

  // 9. FILE-EXISTENCE-ONLY can NEVER be ORIGINAL -> UNKNOWN_SOURCE.
  if (ev.fileExists === true) {
    return { status: V3_STATUS.UNKNOWN_SOURCE, precedence: 9, reason: 'file_existence_only_never_original' };
  }

  // 10. roster / control-plane states
  if (ev.blocked === 'quota') {
    return { status: V3_STATUS.BLOCKED_QUOTA, precedence: 10, reason: 'quota_reserve_floor' };
  }
  if (ev.blocked === 'rate_limit') {
    return { status: V3_STATUS.BLOCKED_RATE_LIMIT, precedence: 10, reason: 'provider_rate_limited' };
  }
  switch (ev.rosterStatus) {
    case 'NOT_LISTED':
      return { status: V3_STATUS.NOT_LISTED, precedence: 10, reason: 'not_in_provider_roster' };
    case 'SUSPENDED':
      return { status: V3_STATUS.SUSPENDED_CONFIRMED, precedence: 10, reason: 'suspended_confirmed' };
    case 'DELISTED':
      return { status: V3_STATUS.DELISTED, precedence: 10, reason: 'delisted_confirmed' };
    case 'NOT_ELIGIBLE':
      return { status: V3_STATUS.NOT_ELIGIBLE, precedence: 10, reason: 'screen_universe_ineligible' };
    case 'RENAMED':
      return { status: V3_STATUS.RENAMED_CANONICALIZED, precedence: 10, reason: 'renamed_ticker_canonicalized' };
    default:
      break;
  }
  if (ev.upstreamAvailable === 'N') {
    return { status: V3_STATUS.UPSTREAM_NOT_AVAILABLE, precedence: 10, reason: 'upstream_unreachable' };
  }

  // 11. traded candle but no broker-file evidence: pending verification.
  return { status: V3_STATUS.MISSING_VERIFIED, precedence: 11, reason: 'traded_candle_no_broker_file_evidence' };
}

/**
 * Map a V2 per-key ledger row to V3.
 * Evidence-insufficient V2 promotions (VERIFIED_PROVIDER_ORIGINAL granted on
 * file existence, without recorded sha256/date-identity proof) are DOWNGRADED
 * to UNKNOWN_SOURCE with reason V2_PROMOTION_UNVERIFIED.
 *
 * Evidence that IS sufficient:
 *   - corrected F statuses from v6-ledger-v2-f-status-corrected.csv /
 *     V6_FOREIGN_397_CONFLICT_RESOLUTION.csv (hints.fCorrected)
 *   - Nov 02-13 rows re-derived from the F4d strict-identity scan (evidence
 *     based; encoded via hints.f4dStrict)
 *
 * @param {object} row V2 row {ticker, trade_date, dataset, status, reason}
 * @param {object} [hints] { f4dStrict:Set<string>, fCorrected:Map<string,string> }
 * @returns {{status: string, reason: string, downgraded: boolean}}
 */
function mapV2RowToV3(row, hints) {
  const r = row || {};
  const ticker = r.ticker || r.symbol;
  const key = `${ticker}|${r.trade_date}|${r.dataset}`;
  const h = hints || {};

  // Precedence 1 (P0-DATA-01): Pseudo-ticker fixtures must be isolated FIRST
  // before checking any physical scan or correction hints.
  if (isPseudoTicker(ticker)) {
    return { status: V3_STATUS.FIXTURE_EXCLUDED, reason: 'pseudo_ticker_fixture', downgraded: false };
  }

  // corrected F-status evidence wins
  if (h.fCorrected && h.fCorrected.has(key)) {
    return { status: h.fCorrected.get(key), reason: 'f_status_corrected_evidence', downgraded: false };
  }
  // F4d strict-identity scan = real evidence (Nov 02-13)
  if (h.f4dStrict && h.f4dStrict.has(key)) {
    return { status: V3_STATUS.ORIGINAL_PROVIDER_VALID, reason: 'f4d_strict_identity_scan_evidence', downgraded: false };
  }

  switch (r.status) {
    case 'VERIFIED_PROVIDER_ORIGINAL':
      // V2 granted this on FILE EXISTENCE, no sha256 / date-identity proof
      // recorded in the v2 evidence columns -> downgrade.
      return { status: V3_STATUS.UNKNOWN_SOURCE, reason: 'V2_PROMOTION_UNVERIFIED', downgraded: true };
    case 'VALID_DERIVED':
      return { status: V3_STATUS.DERIVED_COMPUTED, reason: 'v2_derived_from_valid_all_f', downgraded: false };
    case 'NO_TRADE_FOR_FLOW_PROVEN':
      return { status: V3_STATUS.NO_FOREIGN_FLOW_PROVIDER_CONFIRMED, reason: String(r.reason || 'v2_notrade_proven'), downgraded: false };
    case 'UNKNOWN_CANDLE':
      return { status: V3_STATUS.UNKNOWN_CANDLE, reason: 'no_candle_entry_undecidable', downgraded: false };
    case 'SYNTHETIC_UNVERIFIED':
      return { status: V3_STATUS.SYNTHETIC_UNVERIFIED, reason: 'synthetic_payload_unverified', downgraded: false };
    case 'PENDING':
      return { status: V3_STATUS.MISSING_VERIFIED, reason: 'v2_pending_traded_no_file', downgraded: false };
    case 'DATA_MISSING':
      return { status: V3_STATUS.MISSING_VERIFIED, reason: 'v2_key_absent_from_source_ledger', downgraded: false };
    default:
      return { status: V3_STATUS.UNKNOWN_SOURCE, reason: `v2_unmapped_status_${r.status}`, downgraded: false };
  }
}

module.exports = {
  V3_STATUS,
  ALL_V3_STATUSES,
  PSEUDO_TICKERS,
  PSEUDO_TICKER_COUNT,
  CANONICAL_TRADING_DAYS,
  CANONICAL_FLOW_TYPES,
  TOTAL_PSEUDO_EXCLUDED_ROWS,
  getPseudoTickerMetrics,
  isPseudoTicker,
  classifyLedgerV3,
  mapV2RowToV3,
  // re-exports so callers have a single import surface
  classifyForeignStatus,
  classifyCandleVolume,
};
