'use strict';

const manifest = require('../data/fca-transition-2026-09-28.json');

function normalizeTicker(value) {
  return String(value || '').trim().toUpperCase().replace(/\.JK$/, '');
}

const ALL = new Set((manifest.all_exit_tickers || []).map(normalizeTicker));
const ACTIVE = new Set((manifest.active_as_of_status_date || []).map(normalizeTicker));
const SUSPENDED = new Set((manifest.suspended_as_of_status_date || []).map(normalizeTicker));

function isTransitionTicker(ticker) {
  return ALL.has(normalizeTicker(ticker));
}

function isVerifiedActiveExit(ticker) {
  return ACTIVE.has(normalizeTicker(ticker));
}

function isSuspendedExit(ticker) {
  return SUSPENDED.has(normalizeTicker(ticker));
}

function getTransitionStatus(ticker) {
  const normalized = normalizeTicker(ticker);
  if (ACTIVE.has(normalized)) return 'ACTIVE_EXIT';
  if (SUSPENDED.has(normalized)) return 'SUSPENDED_EXIT';
  return null;
}

function isStandardContinuousBoard(board) {
  const value = String(board || '').trim().toUpperCase();
  return value === 'UTAMA' || value === 'PENGEMBANGAN';
}

function isEligibleContinuousAuctionRow(row) {
  row = row || {};
  if (row.is_active === false) return false;
  if (isVerifiedActiveExit(row.ticker)) return true;
  return isStandardContinuousBoard(row.board);
}

module.exports = {
  manifest,
  normalizeTicker,
  isTransitionTicker,
  isVerifiedActiveExit,
  isSuspendedExit,
  getTransitionStatus,
  isStandardContinuousBoard,
  isEligibleContinuousAuctionRow
};
