'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const weekly = require('../lib/weekly-timeframe');
const atr = require('../lib/atr-report-helpers');

function pattern(label, bias, status, score) {
  return { label, bias, status, score_adjustment: score };
}

function dailyCandles(gapDirection) {
  const rows = [];
  const start = Date.UTC(2026, 0, 1);
  for (let index = 0; index < 75; index += 1) {
    const base = 100 + index * 0.12;
    rows.push({
      time: new Date(start + index * 86400000).toISOString(),
      open: base,
      high: base + 2,
      low: base - 2,
      close: base + 0.5,
      volume: 1_000_000
    });
  }
  const previous = rows[rows.length - 3];
  if (gapDirection === 'up') {
    rows[rows.length - 2] = {
      time: rows[rows.length - 2].time,
      open: previous.high * 1.025,
      high: previous.high * 1.055,
      low: previous.high * 1.02,
      close: previous.high * 1.045,
      volume: 1_800_000
    };
  } else if (gapDirection === 'down') {
    rows[rows.length - 2] = {
      time: rows[rows.length - 2].time,
      open: previous.low * 0.975,
      high: previous.low * 0.98,
      low: previous.low * 0.945,
      close: previous.low * 0.955,
      volume: 1_800_000
    };
  }
  return rows;
}

test('Swing classic context is capped at +2/-4 and added after weekly score', () => {
  assert.equal(weekly.deriveSwingClassicPatternAdjustment({
    primary_pattern: pattern('Cup and Handle', 'Bullish', 'confirmed', 4)
  }, 'WEEKLY_SUPPORT'), 2);
  assert.equal(weekly.deriveSwingClassicPatternAdjustment({
    primary_pattern: pattern('Head and Shoulders', 'Bearish', 'confirmed', -4)
  }, 'WEEKLY_SUPPORT'), -4);
  assert.equal(weekly.deriveSwingClassicPatternAdjustment({
    primary_pattern: pattern('Double Bottom', 'Bullish', 'confirmed', 4)
  }, 'WEEKLY_WEAK'), 0);
  assert.equal(weekly.applyWeeklyTimeframeScore(70, {
    weekly_tf_score_adjustment: 3,
    classic_pattern_score_adjustment: 2
  }), 75);
});

test('Swing evaluator detects classic context from completed T-1 candles', () => {
  const context = weekly.evaluateWeeklyTimeframe(dailyCandles('up'));
  assert.ok(context.classic_chart_patterns.some(row => row.label === 'Gap Up'));
  assert.ok(context.classic_pattern_score_adjustment >= 0);
  assert.ok(context.classic_pattern_score_adjustment <= 2);
  assert.equal(context.classic_pattern_score_version, 'swing-classic-pattern-score-v1');
});

test('Day Trade classic adjustment is smaller and confirmation-aware', () => {
  const row = {
    status: 'EARLY_RADAR',
    daytrade_score: 70,
    volume_ratio_20d: 1.3,
    change_pct: 2,
    entry_distance_pct: 2,
    trading_plan_valid: true,
    data_quality_valid: true
  };
  assert.equal(atr.deriveDayTradeClassicPatternAdjustment(row, {
    primary_pattern: pattern('Bull Flag', 'Bullish', 'breakout', 3)
  }), 2);
  assert.equal(atr.deriveDayTradeClassicPatternAdjustment(row, {
    primary_pattern: pattern('Bull Flag', 'Bullish', 'candidate', 3)
  }), 1);
  assert.equal(atr.deriveDayTradeClassicPatternAdjustment(row, {
    primary_pattern: pattern('Double Top', 'Bearish', 'confirmed', -4)
  }), -3);
});

test('Day Trade positive pattern cannot bypass safety or chase guards', () => {
  const bullish = { primary_pattern: pattern('Double Bottom', 'Bullish', 'confirmed', 4) };
  assert.equal(atr.deriveDayTradeClassicPatternAdjustment({
    status: 'AVOID', daytrade_score: 70, volume_ratio_20d: 2, change_pct: 1
  }, bullish), 0);
  assert.equal(atr.deriveDayTradeClassicPatternAdjustment({
    status: 'EARLY_RADAR', daytrade_score: 70, volume_ratio_20d: 2,
    change_pct: 6, entry_distance_pct: 5
  }, bullish), 0);
  assert.equal(atr.deriveDayTradeClassicPatternAdjustment({
    status: 'EARLY_RADAR', daytrade_score: 70, volume_ratio_20d: 2,
    change_pct: 1, false_breakout_risk: true
  }, bullish), 0);
});

test('ATR attachment adjusts Day Trade ranking once without changing status', () => {
  const row = {
    ticker: 'TEST',
    status: 'EARLY_RADAR',
    daytrade_score: 70,
    entry_low: 100,
    entry_high: 101,
    stop_loss: 97,
    tp1: 106,
    tp2: 110,
    volume_ratio_20d: 1.3,
    change_pct: 2,
    entry_distance_pct: 2,
    trading_plan_valid: true,
    data_quality_valid: true
  };
  atr.attachAtrWarningMetadata(row, dailyCandles('up'));
  assert.equal(row.status, 'EARLY_RADAR');
  assert.equal(row.score_before_classic_pattern_adjustment, 70);
  assert.equal(row.daytrade_score, 71);
  assert.equal(row.classic_pattern_score_adjustment, 1);
  assert.ok(row.classic_chart_patterns.some(item => item.label === 'Gap Up'));
  atr.attachAtrWarningMetadata(row, dailyCandles('up'));
  assert.equal(row.daytrade_score, 71);
});
