'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const dtEngine = require('../lib/daytrade-screener-engine');
const sectorHot = require('../api/sector-hot');

test('BUG-014: analyzeDayTrade returns null (not 0) when 20D average volume is unknown', () => {
  // 10 candles (< 20 required for 20D MA)
  const shortCandles = [];
  for (let i = 0; i < 10; i++) {
    shortCandles.push({
      date: '2026-01-' + String(i + 1).padStart(2, '0'),
      open: 1000,
      high: 1010,
      low: 990,
      close: 1005,
      volume: 50000
    });
  }

  const analysis = dtEngine.analyzeDayTrade(shortCandles, 'TEST');
  assert.equal(analysis.avg_volume_20d, null, 'avg_volume_20d should be null when fewer than 20 candles exist');
  assert.equal(analysis.volume_ratio_20d, null, 'volume_ratio_20d should be null when avg is unknown');
});

test('BUG-014: analyzeDayTrade preserves 0 for volume_ratio_20d when volume_today is genuinely 0 and avg is known', () => {
  // 25 candles (>= 20 required)
  const candles = [];
  for (let i = 0; i < 25; i++) {
    candles.push({
      date: '2026-01-' + String(i + 1).padStart(2, '0'),
      open: 1000,
      high: 1010,
      low: 990,
      close: 1005,
      volume: i === 24 ? 0 : 50000 // today volume is 0
    });
  }

  const analysis = dtEngine.analyzeDayTrade(candles, 'TEST');
  assert.ok(analysis.avg_volume_20d > 0, 'avg_volume_20d should be positive');
  assert.equal(analysis.volume_ratio_20d, 0, 'volume_ratio_20d should be 0 when volume is genuinely zero');
});

test('BUG-014: deriveDayTradeTimeframeContext respects range_position = 0 (closed at low) rather than defaulting to 50', () => {
  const deriveTf = sectorHot.__test.deriveDayTradeTimeframeContext;
  assert.equal(typeof deriveTf, 'function', 'deriveDayTradeTimeframeContext should be exported in __test');

  // Case 1: Closed at exact low (range_position = 0) with chg = -2.5%
  // Before fix: 0 || 50 turned rp into 50, resulting in 'Netral / sideways' or 'Bearish' instead of 'Bearish close near low'
  const rowBearishAtLow = {
    change_pct: -2.5,
    volume_ratio_20d: 1.0,
    range_position: 0
  };
  const tf1 = deriveTf(rowBearishAtLow);
  assert.equal(tf1.tf_1d, 'Bearish close near low');

  // Case 2: Closed at exact low (range_position = 0) with chg = 0%
  // Before fix: 0 || 50 turned rp into 50, missing 'Close near low'
  const rowFlatAtLow = {
    change_pct: 0,
    volume_ratio_20d: 1.0,
    range_position: 0
  };
  const tf2 = deriveTf(rowFlatAtLow);
  assert.equal(tf2.tf_1d, 'Close near low');

  // Case 3: range_position is null -> should fall back to 50
  const rowNull = {
    change_pct: 0,
    volume_ratio_20d: 1.0,
    range_position: null
  };
  const tf3 = deriveTf(rowNull);
  assert.equal(tf3.tf_1d, 'Netral / sideways');
});
