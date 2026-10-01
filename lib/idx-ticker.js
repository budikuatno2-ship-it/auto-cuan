'use strict';

/**
 * Canonical IDX ticker format check.
 *
 * IDX stock codes are exactly four uppercase letters (e.g. BBCA, TLKM, ANTM).
 * Folder enumerations under `data/arjum-data/broker-summary/` must be filtered
 * with this so audit/test artifacts (AUDITSCALE5D, B4TST, DBGT4, NOACC, ...)
 * never leak into the broker universe. See FULL_REPO_BUG_FINDINGS F-036/F-055.
 */
const IDX_TICKER_RE = /^[A-Z]{4}$/;

function isValidIdxTicker(value) {
  return typeof value === 'string' && IDX_TICKER_RE.test(value.trim().toUpperCase());
}

module.exports = { IDX_TICKER_RE, isValidIdxTicker };