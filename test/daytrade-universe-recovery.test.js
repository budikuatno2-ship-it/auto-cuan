'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../lib/daytrade-screener-engine');
const sectorHot = require('../api/sector-hot').__test;

test('Day Trade universe filters restricted, low-price, and foreign unknown-board rows', () => {
  const result = engine.filterDayTradeUniverse([
    { ticker: 'SAFE', board: 'UTAMA', last_price: 50, valuasi: 1000000000, freq: 1000 },
    { ticker: 'LOW', board: 'UTAMA', last_price: 49 },
    { ticker: 'FCA', board: 'UTAMA', last_price: 100, status: 'FCA' },
    { ticker: 'WATCH', board: 'PENGEMBANGAN', last_price: 100, watchlist_status: 'special watch' },
    { ticker: 'FOREIGN', board: null, last_price: 100, universe_source: 'foreign_latest' },
    { ticker: 'SUSP', board: 'UTAMA', last_price: 100, status: 'suspended' }
  ], { requirePrice: true, requireLiquidity: true });
  assert.deepEqual(result.tickers.map((r) => r.ticker), ['SAFE']);
  assert.equal(result.diagnostics.raw_universe_count, 6);
  assert.equal(result.diagnostics.excluded_by_reason.price_below_50, 1);
  assert.equal(result.diagnostics.excluded_by_reason.restricted_board_or_status, 3);
  assert.equal(result.diagnostics.excluded_by_reason.invalid_or_unknown_board, 1);
});

test('Day Trade permits board-validated IPOs but excludes unknown-board new listings', () => {
  const result = engine.filterDayTradeUniverse([
    { ticker: 'JECX', board: 'UTAMA', listing_status: 'NEW_LISTING', last_price: 100, valuasi: 1, freq: 1 },
    { ticker: 'WBSA', board: 'PENGEMBANGAN', listing_status: 'NEW_LISTING', last_price: 100, valuasi: 1, freq: 1 },
    { ticker: 'UNKNOWN', board: null, listing_status: 'NEW_LISTING', last_price: 100, valuasi: 1, freq: 1 },
    { ticker: 'AKS', board: 'AKSELERASI', listing_status: 'NEW_LISTING', last_price: 100, valuasi: 1, freq: 1 },
    { ticker: 'EB', board: 'EKONOMI BARU', listing_status: 'NEW_LISTING', last_price: 100, valuasi: 1, freq: 1 },
    { ticker: 'FCA', board: 'UTAMA', listing_status: 'NEW_LISTING', last_price: 100, valuasi: 1, freq: 1, status: 'FCA' },
    { ticker: 'SUSP', board: 'UTAMA', listing_status: 'NEW_LISTING', last_price: 100, valuasi: 1, freq: 1, status: 'suspended' }
  ], { requirePrice: true, requireLiquidity: true });
  assert.deepEqual(result.tickers.map((row) => row.ticker), ['JECX', 'WBSA']);
  assert.equal(result.diagnostics.board_validated_new_listing_count, 2);
  assert.equal(result.diagnostics.unknown_board_new_listing_excluded_count, 1);
  assert.equal(result.diagnostics.excluded_akselerasi_count, 1);
  assert.equal(result.diagnostics.excluded_ekonomi_baru_count, 1);
  assert.deepEqual(result.diagnostics.sample_included_new_listings.map((row) => row.ticker), ['JECX', 'WBSA']);
});

test('price 50 requires board and liquidity safety, while 49 is always excluded', () => {
  assert.equal(engine.dayTradeEligibilityReason({ board: 'UTAMA', last_price: 50, valuasi: 1, freq: 1 }, { requirePrice: true, requireLiquidity: true }), null);
  assert.equal(engine.dayTradeEligibilityReason({ board: 'UTAMA', last_price: 50 }, { requirePrice: true, requireLiquidity: true }), 'liquidity_unverified');
  assert.equal(engine.dayTradeEligibilityReason({ board: 'UTAMA', last_price: 49, valuasi: 1, freq: 1 }, { requirePrice: true, requireLiquidity: true }), 'price_below_50');
});

test('stale Day Trade scanning lock is diagnosed for recovery but a fresh lock remains running', () => {
  const stale = sectorHot.getDayTradeRunningLockDiagnostics({ status: 'scanning', updated_at: '2026-01-01T00:00:00.000Z' }, Date.parse('2026-01-01T00:31:00.000Z'));
  const fresh = sectorHot.getDayTradeRunningLockDiagnostics({ status: 'scanning', updated_at: '2026-01-01T00:00:00.000Z' }, Date.parse('2026-01-01T00:05:00.000Z'));
  assert.equal(stale.running_lock_status, 'stalled');
  assert.equal(stale.stale_running_lock_reason, 'running_lock_timeout');
  assert.equal(fresh.running_lock_status, 'running');
});
