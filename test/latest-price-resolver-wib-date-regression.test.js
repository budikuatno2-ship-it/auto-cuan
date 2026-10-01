'use strict';

// Regression coverage for a confirmed UTC-vs-WIB date bug in
// lib/latest-price-resolver.js: dateOnly() used a naive
// `date.toISOString().slice(0, 10)` on rowDate(row), which can resolve to a
// real timestamp field (calculated_at/published_at/updated_at, per
// DATE_FIELDS). For any instant between UTC 17:00-23:59 (= Asia/Jakarta
// 00:00-06:59 the FOLLOWING calendar day), that naive slice reports the
// WRONG (previous) WIB date — the same anti-pattern class already fixed
// elsewhere in this audit (RSI/T-1 label), on a different file/field here.
// api/quote.js surfaces resolveLatestPrice()'s price_date directly to the
// live quote API, so this wrong date was live-user-visible.

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveLatestPrice } = require('../lib/latest-price-resolver');

test('REGRESSION: a calculated_at timestamp in the UTC 17:00-23:59 danger window resolves to the correct WIB trading date, not the UTC calendar date', () => {
  // 2026-08-12T19:00:00Z = 2026-08-13 02:00 WIB (Asia/Jakarta, UTC+7) — early
  // WIB morning of the 13th. The old naive UTC slice would report
  // '2026-08-12' (one day behind); the correct WIB date is '2026-08-13'.
  const resolved = resolveLatestPrice({
    daytrade_screener_latest: { last_price: 500, calculated_at: '2026-08-12T19:00:00Z' }
  }, { now: '2026-08-12T20:00:00Z' });

  assert.equal(resolved.price, 500);
  assert.equal(resolved.price_date, '2026-08-13', 'expected the WIB trading date, not the UTC calendar date (2026-08-12)');
});

test('a calculated_at timestamp OUTSIDE the danger window (mid-WIB-day) is unaffected either way', () => {
  // 2026-08-12T05:00:00Z = 2026-08-12 12:00 WIB — comfortably mid-day, UTC
  // and WIB calendar dates agree regardless of conversion method.
  const resolved = resolveLatestPrice({
    daytrade_screener_latest: { last_price: 500, calculated_at: '2026-08-12T05:00:00Z' }
  }, { now: '2026-08-12T06:00:00Z' });

  assert.equal(resolved.price_date, '2026-08-12');
});

test('an already-date-only field (e.g. trade_date/run_date, no time component) is passed through literally, not reinterpreted', () => {
  const resolved = resolveLatestPrice({
    foreign_watchlist_daily: { last_price: 700, trade_date: '2026-08-11' }
  }, { now: '2026-08-11T10:00:00Z' });

  assert.equal(resolved.price_date, '2026-08-11');
});
