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
