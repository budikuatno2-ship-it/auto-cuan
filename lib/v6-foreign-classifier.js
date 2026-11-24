'use strict';
/**
 * M-P0b — Foreign-flow F-status classifier with strict precedence.
 *
 * RULE (precedence, highest first):
 *   1. PROVIDER_NO_TRADE sidecar evidence (provider returned brokers:[])
 *      -> NO_FOREIGN_FLOW_PROVIDER_CONFIRMED
 *   2. ON-DISK NO_TRADE (strict-identity file whose brokers array is empty)
 *      -> NO_FOREIGN_FLOW_PROVIDER_CONFIRMED
 *   3. DERIVED schema evidence (derived payload, distinguishable rows)
 *      -> DERIVED_COMPUTED (real foreign rows with real as_of)
 *         or NO_FOREIGN_FLOW_PROVIDER_CONFIRMED (zero foreign rows / empty brokers)
 *   4. STRICT-IDENTITY ORIGINAL (file exists AND strict date identity AND
 *      schema-valid AND non-empty brokers array) -> VERIFIED_PROVIDER_ORIGINAL
 *   5. FILE-EXISTENCE-ONLY (file exists, no strict validation performed)
 *      -> NEVER VERIFIED_PROVIDER_ORIGINAL. Falls back to the strictest
 *      evidence-backed lower tier; with no other evidence it stays
 *      UNVERIFIED_FILE_PRESENCE.
 *
 * NULL-AS-ZERO BUG (fixed): the old classifier treated
 *   `cv === '' || Number(cv) === 0` as zero-volume (NO_TRADE), conflating an
 *   UNKNOWN candle (missing entry) with a proven zero-volume trade. The
 *   corrected helper distinguishes them: '' (missing) -> UNKNOWN_CANDLE;
 *   0 -> NO_TRADE_CANDIDATE; >0 -> TRADED.
 */

const RESOLUTIONS = Object.freeze({
  NO_TRADE: 'NO_FOREIGN_FLOW_PROVIDER_CONFIRMED',
  DERIVED_COMPUTED: 'DERIVED_COMPUTED',
  ORIGINAL: 'VERIFIED_PROVIDER_ORIGINAL',
  FILE_PRESENCE_ONLY: 'UNVERIFIED_FILE_PRESENCE',
});

/**
 * Classify by evidence precedence. `evidence` shape:
 * {
 *   sidecarNoTrade: boolean|null  - provider sidecar proves brokers:[]
 *   onDiskNoTrade:  boolean|null  - strict-identity provider-original file on
 *                                   disk whose brokers array is empty (proved
 *                                   from disk, no sidecar needed)
 *   derivedSchema:  boolean|null  - payload carries derived schema
 *   derivedBrokerRows: number     - foreign broker rows in derived payload
 *   derivedHasRealAsOf: boolean   - as_of present and parseable
 *   strictIdentity: boolean|null  - strict date-identity + schema + brokers>0
 *   fileExists:     boolean       - mere existence check passed
 * }
 * Returns { status, precedence } — precedence 1..4 as documented above.
 */
function classifyForeignStatus(evidence) {
  const ev = evidence || {};
  // 1. provider NO_TRADE sidecar wins over everything
  if (ev.sidecarNoTrade === true) {
    return { status: RESOLUTIONS.NO_TRADE, precedence: 1 };
  }
  // 1b. strict-identity on-disk providers=[] file (F4d NO_TRADE_PROVEN_ON_DISK)
  if (ev.onDiskNoTrade === true) {
    return { status: RESOLUTIONS.NO_TRADE, precedence: 2 };
  }
  // 3. derived-schema evidence
  if (ev.derivedSchema === true) {
    const rows = Number(ev.derivedBrokerRows) || 0;
    if (rows > 0 && ev.derivedHasRealAsOf === true) {
      return { status: RESOLUTIONS.DERIVED_COMPUTED, precedence: 3 };
    }
    return { status: RESOLUTIONS.NO_TRADE, precedence: 3 };
  }
  // 4. strict-identity original
  if (ev.strictIdentity === true) {
    return { status: RESOLUTIONS.ORIGINAL, precedence: 4 };
  }
  // 5. file-existence-only can NEVER be ORIGINAL
  if (ev.fileExists === true) {
    return { status: RESOLUTIONS.FILE_PRESENCE_ONLY, precedence: 5 };
  }
  return { status: RESOLUTIONS.FILE_PRESENCE_ONLY, precedence: 5 };
}

/**
 * CORRECTED candle-volume classifier (null-as-zero bug fixed).
 * @param {*} cv raw candle_volume cell ('' | '0' | '123' | null | undefined | number)
 * @returns {'UNKNOWN_CANDLE'|'NO_TRADE_CANDIDATE'|'TRADED'}
 */
function classifyCandleVolume(cv) {
  if (cv === null || cv === undefined || cv === '') return 'UNKNOWN_CANDLE';
  const n = Number(cv);
  if (Number.isNaN(n)) return 'UNKNOWN_CANDLE';
  if (n === 0) return 'NO_TRADE_CANDIDATE';
  return 'TRADED';
}

/**
 * LEGACY (buggy) classifier kept only for regression demonstration in tests.
 * Never use in production code paths.
 */
function legacyNullAsZeroClassify(cv) {
  if (cv === '' || Number(cv) === 0) return 'NO_TRADE';
  return 'TRADED';
}

module.exports = {
  RESOLUTIONS,
  classifyForeignStatus,
  classifyCandleVolume,
  legacyNullAsZeroClassify,
};
