'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveLatestPrice } = require('../lib/latest-price-resolver');
const now = '2026-07-16T12:00:00Z';
test('prefers fresh daytrade latest over stale manual/current price and lower-priority sources', () => {
  const resolved = resolveLatestPrice({
    daytrade_screener_latest: { last_price: 123, calculated_at: '2026-07-16T10:00:00Z' },
    swing_screener_latest: { last_price: 120, calculated_at: '2026-07-16T11:00:00Z' }
  }, { now });
  assert.equal(resolved.price, 123);
  assert.equal(resolved.price_source, 'daytrade_screener_latest');
});
test('stale latest data never resolves to a replacement portfolio price', () => {
  const resolved = resolveLatestPrice({ daytrade_screener_latest: { last_price: 999, calculated_at: '2026-07-07T09:00:00Z' } }, { now });
  assert.equal(resolved.price, null);
  assert.equal(resolved.stale, true);
});
