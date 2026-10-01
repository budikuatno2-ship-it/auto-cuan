'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectPriceScaleMismatch, applyCorporateActionPriceScaleGuard } = require('../lib/corporate-action-price-scale-guard');

function plan(overrides) { return Object.assign({ entry: 800, tp1: 850, stop_loss: 770, support: 780, resistance: 880 }, overrides); }

test('blocks stale higher-scale levels after a suspected split', () => {
  const row = applyCorporateActionPriceScaleGuard(plan({ entry: 4000, tp1: 4300, stop_loss: 3800, support: 3900, resistance: 4400 }), { latestPrice: 800 });
  assert.equal(row.corporate_action_guard, 'BLOCKED');
  assert.equal(row.corporate_action_reason, 'price_scale_mismatch');
  assert.equal(row.status, 'NEEDS_REVALIDATION');
  assert.equal(row.display_status, 'STALE_LEVEL');
  assert.equal(row.latest_price_used, 800);
});

test('blocks stale lower-scale levels after a suspected reverse split', () => {
  const row = applyCorporateActionPriceScaleGuard(plan({ entry: 800, tp1: 850, stop_loss: 760, support: 780, resistance: 880 }), { latestPrice: 4000 });
  assert.equal(row.corporate_action_guard, 'BLOCKED');
  assert.equal(row.suspected_price_scale_ratio, 0.2);
});

test('allows levels on the current 800 price scale', () => {
  assert.equal(detectPriceScaleMismatch(plan({ entry: 800, tp1: 880, stop_loss: 780 }), 800).blocked, false);
});

test('allows levels on the current 4000 price scale', () => {
  assert.equal(detectPriceScaleMismatch(plan({ entry: 4000, tp1: 4300, stop_loss: 3900, support: 3950, resistance: 4250 }), 4000).blocked, false);
});

test('missing latest price is diagnostic-only and never crashes', () => {
  const row = applyCorporateActionPriceScaleGuard(plan({ latest_price: null, current_price: null, price: null, close: null, close_price: null }), {});
  assert.equal(row.corporate_action_guard, 'NOT_EVALUATED');
  assert.equal(row.corporate_action_reason, 'latest_price_missing');
});

test('does not block a single far TP when entry and SL match current price', () => {
  const result = detectPriceScaleMismatch(plan({ entry: 800, stop_loss: 780, tp1: 2400, support: 790 }), 800);
  assert.equal(result.blocked, false);
});

test('uses generic field evidence rather than ticker-specific logic', () => {
  const result = detectPriceScaleMismatch({ ticker: 'GENERIC', entry_low: 4000, entry_high: 4100, sl: 3900, tp1: 4300 }, 800);
  assert.equal(result.blocked, true);
});
