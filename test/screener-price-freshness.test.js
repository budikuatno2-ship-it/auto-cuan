'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sectorHot = require('../api/sector-hot');

const { validateScreenerPriceFreshness, attachPriceFreshness } = sectorHot.__test;

test('rejects candidate whose last price matches open while latest close differs', () => {
  const result = validateScreenerPriceFreshness({
    ticker: 'KOTA',
    last_price: 100,
    open_price: 100,
    close_price: 93,
    price_date: '2026-07-08',
    price_source: 'fixture'
  }, { expected_date: '2026-07-08' });
  assert.equal(result.is_price_stale, true);
  assert.match(result.stale_price_reason, /last_price_matches_open_not_close/);
});

test('rejects old price date from Telegram and Top 5 freshness helper', () => {
  const candidate = attachPriceFreshness({ ticker: 'OLD', last_price: 100, price_date: '2026-07-07' }, { expected_date: '2026-07-08' });
  assert.equal(candidate.is_price_stale, true);
  assert.equal(candidate.setup_freshness_status, 'NEEDS_REVALIDATION');
  assert.match(candidate.stale_price_reason, /old_price_date/);
});

test('missing price date is unknown even with same-day run_date', () => {
  const candidate = attachPriceFreshness({ ticker: 'RUN', last_price: 100, run_date: '2026-07-08' }, { expected_date: '2026-07-08' });
  assert.equal(candidate.is_price_stale, true);
  assert.equal(candidate.price_freshness_status, 'UNKNOWN');
  assert.match(candidate.stale_price_reason, /unknown_price_date/);
});

test('missing price date is unknown even with same-day calculated_at', () => {
  const candidate = attachPriceFreshness({ ticker: 'CALC', last_price: 100, calculated_at: '2026-07-08T09:00:00Z' }, { expected_date: '2026-07-08' });
  assert.equal(candidate.is_price_stale, true);
  assert.equal(candidate.price_freshness_status, 'UNKNOWN');
  assert.match(candidate.stale_price_reason, /unknown_price_date/);
});

test('last price equal to open with missing close is blocked without verified close source', () => {
  const result = validateScreenerPriceFreshness({
    ticker: 'OPEN',
    last_price: 100,
    open_price: 100,
    price_date: '2026-07-08',
    price_source: 'screener_latest.swing'
  }, { expected_date: '2026-07-08' });
  assert.equal(result.is_price_stale, true);
  assert.match(result.stale_price_reason, /last_price_matches_open_without_close_verification/);
});

test('last price equal to open can pass with verified latest-close source and same-day price date', () => {
  const result = validateScreenerPriceFreshness({
    ticker: 'VERIFY',
    last_price: 100,
    open_price: 100,
    price_date: '2026-07-08',
    price_source: 'yahoo_chart_1d_close'
  }, { expected_date: '2026-07-08' });
  assert.equal(result.is_price_stale, false);
  assert.equal(result.price_freshness_status, 'FRESH');
});

test('locked row diagnostics are computed from locked rows only', () => {
  const lockedRows = [
    attachPriceFreshness({ ticker: 'LOCK', last_price: 100, open_price: 100, price_date: '2026-07-08', price_source: 'telegram_daily_picks.locked_rows' }, { expected_date: '2026-07-08' })
  ];
  const globalRows = [
    attachPriceFreshness({ ticker: 'GLOBAL', last_price: 50, price_date: '2026-07-07', price_source: 'global_pool' }, { expected_date: '2026-07-08' })
  ];
  const lockedDiag = sectorHot.__test.buildPriceFreshnessDiagnostics(lockedRows);
  const globalDiag = sectorHot.__test.buildPriceFreshnessDiagnostics(globalRows);
  assert.deepEqual(lockedDiag.sample_stale_price_rejected.map((r) => r.ticker), ['LOCK']);
  assert.deepEqual(globalDiag.sample_stale_price_rejected.map((r) => r.ticker), ['GLOBAL']);
});

test('allows valid latest close price with known same-day date', () => {
  const result = validateScreenerPriceFreshness({
    ticker: 'GOOD',
    last_price: 93,
    open_price: 100,
    close_price: 93,
    previous_close: 100,
    price_date: '2026-07-08',
    price_source: 'yahoo_chart_1d_close'
  }, { expected_date: '2026-07-08' });
  assert.equal(result.is_price_stale, false);
  assert.equal(result.price_freshness_status, 'FRESH');
});
