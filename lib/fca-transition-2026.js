'use strict';

const manifest = require('../data/fca-transition-2026-09-28.json');

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
const SUSPENSION_MARKERS = /\bsuspend(?:ed|sion)?\b|\bhalt(?:ed)?\b|trading\s+halt|penghentian\s+sementara|dihentikan\s+sementara|suspensi/i;

function isTransitionTicker(ticker) {
  return ALL.has(normalizeTicker(ticker));
}

function isVerifiedActiveExit(ticker) {
  return ACTIVE.has(normalizeTicker(ticker));
}

function hasExplicitSuspensionSignal(row) {
  row = row || {};
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
  if (!SUSPENDED.has(normalized)) return false;
  if (currentRow && rowProvesCurrentTradability(Object.assign({}, currentRow, { ticker: normalized }))) return false;
  return true;
}

function shouldBlockTransitionTicker(ticker, currentRow) {
  const normalized = normalizeTicker(ticker);
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
  if (SUSPENDED.has(normalized) && currentRow && rowProvesCurrentTradability(Object.assign({}, currentRow, { ticker: normalized }))) return 'REACTIVATED_EXIT';
  return null;
}

function isEligibleContinuousAuctionRow(row) {
  row = row || {};
  if (normalizeBoolean(row.is_active) === false) return false;
  if (hasExplicitSuspensionSignal(row)) return false;
  if (shouldBlockTransitionTicker(row.ticker, row)) return false;
  if (isVerifiedActiveExit(row.ticker)) return true;
  return isStandardContinuousBoard(row.board);
}

module.exports = {
  manifest,
  normalizeTicker,
  normalizeBoolean,
  isTransitionTicker,
  isVerifiedActiveExit,
  isSuspendedExit,
  shouldBlockTransitionTicker,
  hasExplicitSuspensionSignal,
  rowProvesCurrentTradability,
  getTransitionStatus,
  isStandardContinuousBoard,
  isEligibleContinuousAuctionRow
};
