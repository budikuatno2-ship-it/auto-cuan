'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeRolling52WeekMetrics
} = require('../lib/daily-history-collector');

test('computes high and distance from full Yahoo candle set', () => {
  const candles = [
    { high: 100, close: 95 },
    { high: 120, close: 110 },
    { high: 115, close: 90 }
  ];

  const result = computeRolling52WeekMetrics(candles);

  assert.equal(result.high_52w, 120);
  assert.equal(result.distance_to_high_52w_pct, -25);
  assert.equal(result.sessions_available, 3);
});

test('returns zero distance when latest close equals 52W high', () => {
  const result = computeRolling52WeekMetrics([
    { high: 100, close: 90 },
    { high: 125, close: 125 }
  ]);

  assert.equal(result.high_52w, 125);
  assert.equal(result.distance_to_high_52w_pct, 0);
});

test('returns null metrics for empty candles', () => {
  const result = computeRolling52WeekMetrics([]);

  assert.equal(result.high_52w, null);
  assert.equal(result.distance_to_high_52w_pct, null);
  assert.equal(result.sessions_available, 0);
});
