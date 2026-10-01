'use strict';

const manifest = require('../data/fca-transition-2026-09-28.json');
const suspensionGuard = require('./idx-suspension-guard');

function normalizeTicker(value) {
  return String(value || '').trim().toUpperCase().replace(/\.JK$/, '');
}

function normalizeBoolean(value) {
  if (value === true || value === false) return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  var text = String(value == null ? '' : value).trim().toLowerCase();
  if (text === 'true' || text === 'yes' || text === 'y') return true;
  if (text === 'false' || text === 'no' || text === 'n') return false;
  return null;
}

const ALL = new Set((manifest.all_exit_tickers || []).map(normalizeTicker));
const ACTIVE = new Set((manifest.active_as_of_status_date || []).map(normalizeTicker));
const SUSPENDED = new Set((manifest.suspended_as_of_status_date || []).map(normalizeTicker));
const REACTIVATED = new Set((manifest.reactivated_after_status_date || []).map(normalizeTicker));
const SUSPENSION_MARKERS = /\bsuspend(?:ed|sion)?\b|\bhalt(?:ed)?\b|trading\s+halt|penghentian\s+sementara|dihentikan\s+sementara|suspensi/i;
const RESTRICTED_CONTINUOUS_AUCTION_MARKERS = /\bFCA\b|FULL\s*CALL\s*AUCTION|CALL\s*AUCTION|PEMANTAUAN(?:[\s_-])*KHUSUS|SPECIAL\s*WATCH|PROBLEM\s*BOARD|WATCHLIST\s*BOARD/i;

function isTransitionTicker(ticker) {
  return ALL.has(normalizeTicker(ticker));
}

function isVerifiedActiveExit(ticker) {
  return ACTIVE.has(normalizeTicker(ticker));
}

function isAuthoritativelyReactivated(ticker) {
  const normalized = normalizeTicker(ticker);
  return REACTIVATED.has(normalized) || suspensionGuard.isAuthoritativelyActive(normalized);
}

function hasExplicitSuspensionSignal(row) {
  row = row || {};
  if (suspensionGuard.isSuspended(row.ticker)) return true;
  var text = [
    row.market_status,
    row.status,
    row.watchlist_status,
    row.board_status,
    row.suspension_status,
    row.trading_status,
    row.note,
    row.notes
  ].join(' ');
  return SUSPENSION_MARKERS.test(text);
}

function hasRestrictedContinuousAuctionSignal(row) {
  row = row || {};
  if (normalizeBoolean(row.is_fca) === true) return true;
  var text = [
    row.board,
    row.market_status,
    row.status,
    row.watchlist_status,
    row.board_status,
    row.trading_status,
    row.note,
    row.notes
  ].join(' ');
  return RESTRICTED_CONTINUOUS_AUCTION_MARKERS.test(text);
}

function isStandardContinuousBoard(board) {
  const value = String(board || '').trim().toUpperCase();
  return value === 'UTAMA' || value === 'PENGEMBANGAN';
}

function rowProvesCurrentTradability(row) {
  row = row || {};
  if (!normalizeTicker(row.ticker)) return false;
  if (hasExplicitSuspensionSignal(row)) return false;
  if (normalizeBoolean(row.is_active) !== true) return false;
  if (!isStandardContinuousBoard(row.board)) return false;
  return normalizeBoolean(row.is_fca) === false;
}

function isSuspendedExit(ticker, currentRow) {
  const normalized = normalizeTicker(ticker);
  if (suspensionGuard.isSuspended(normalized)) return true;
  if (!SUSPENDED.has(normalized)) return false;

  // IMPORTANT: stock_boards describes the listing/FCA board, not the live
  // suspension state. A ticker can be PENGEMBANGAN + is_fca=false while its
  // trading remains suspended (DPNS was a production example on 2026-09-30).
  // Therefore board metadata alone must never erase the 2026-09-25 suspension
  // snapshot. Re-entry needs BOTH a newer authoritative IDX suspension-opening
  // update recorded in the manifest and a current row that is otherwise
  // tradable. Until then this is intentionally fail-closed.
  if (!isAuthoritativelyReactivated(normalized)) return true;
  if (currentRow && rowProvesCurrentTradability(Object.assign({}, currentRow, { ticker: normalized }))) return false;
  return true;
}

function shouldBlockTransitionTicker(ticker, currentRow) {
  const normalized = normalizeTicker(ticker);
  if (suspensionGuard.isSuspended(normalized)) return true;
  if (!ALL.has(normalized)) return false;

  if (currentRow) {
    if (hasExplicitSuspensionSignal(currentRow)) return true;
    if (normalizeBoolean(currentRow.is_active) === false) return true;
  }

  return isSuspendedExit(normalized, currentRow);
}

function getTransitionStatus(ticker, currentRow) {
  const normalized = normalizeTicker(ticker);
  if (shouldBlockTransitionTicker(normalized, currentRow)) return 'SUSPENDED_EXIT';
  if (ACTIVE.has(normalized)) return 'ACTIVE_EXIT';
  if (SUSPENDED.has(normalized) && isAuthoritativelyReactivated(normalized) && currentRow && rowProvesCurrentTradability(Object.assign({}, currentRow, { ticker: normalized }))) return 'REACTIVATED_EXIT';
  return null;
}

function isEligibleContinuousAuctionRow(row) {
  row = row || {};
  if (normalizeBoolean(row.is_active) === false) return false;
  if (hasExplicitSuspensionSignal(row)) return false;
  if (shouldBlockTransitionTicker(row.ticker, row)) return false;

  // The dated 44 verified-active FCA exits are the only exception to stale
  // FCA/board metadata after 28 Sep 2026. Ordinary names must still prove they
  // are on the continuous-auction universe now; a PENGEMBANGAN row with
  // is_fca=true / "Pemantauan Khusus / FCA" is not sufficient.
  if (isVerifiedActiveExit(row.ticker)) return true;
  if (hasRestrictedContinuousAuctionSignal(row)) return false;
  return isStandardContinuousBoard(row.board);
}

module.exports = {
  manifest,
  normalizeTicker,
  normalizeBoolean,
  isTransitionTicker,
  isVerifiedActiveExit,
  isAuthoritativelyReactivated,
  isDynamicallySuspended: suspensionGuard.isSuspended,
  isSuspendedExit,
  shouldBlockTransitionTicker,
  hasExplicitSuspensionSignal,
  hasRestrictedContinuousAuctionSignal,
  rowProvesCurrentTradability,
  getTransitionStatus,
  isStandardContinuousBoard,
  isEligibleContinuousAuctionRow
};
