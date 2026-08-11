'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPbvContext } = require('../lib/daily-pbv');

test('PBV computed directly from book_value_per_share', () => {
  const ctx = buildPbvContext(1000, { book_value_per_share: 500, fundamental_period: 'Q2-2026', source: 'manual' });
  assert.equal(ctx.pbv, 2);
  assert.equal(ctx.data_available, true);
});

test('PBV derived from equity / shares_outstanding when BVPS absent', () => {
  const ctx = buildPbvContext(1000, { equity: 500000, shares_outstanding: 1000 });
  assert.equal(ctx.book_value_per_share, 500);
  assert.equal(ctx.pbv, 2);
});

test('missing fundamentals row returns null PBV, never fabricated', () => {
  const ctx = buildPbvContext(1000, null);
  assert.equal(ctx.pbv, null);
  assert.equal(ctx.data_available, false);
});

test('missing last price returns null PBV even with fundamentals present', () => {
  const ctx = buildPbvContext(null, { book_value_per_share: 500 });
  assert.equal(ctx.pbv, null);
});

test('fundamental period/source are surfaced separately from price freshness', () => {
  const ctx = buildPbvContext(1000, { book_value_per_share: 500, fundamental_period: 'FY2025', source: 'idx_annual_report' });
  assert.equal(ctx.fundamental_period, 'FY2025');
  assert.equal(ctx.fundamental_source, 'idx_annual_report');
});
