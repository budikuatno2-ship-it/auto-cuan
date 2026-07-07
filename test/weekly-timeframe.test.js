'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const weekly = require('../lib/weekly-timeframe');

function dailyCandles(days, start, step) {
  const out = [];
  let price = start;
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.UTC(2026, 0, 5 + i));
    const close = price + step;
    out.push({
      date: d.toISOString().slice(0, 10),
      open: price,
      high: Math.max(price, close) + 1,
      low: Math.min(price, close) - 1,
      close: close,
      volume: 1000 + i
    });
    price = close;
  }
  return out;
}

test('weekly timeframe resamples daily candles into deterministic weekly candles', function() {
  const candles = dailyCandles(10, 100, 1);
  const weeks = weekly.resampleDailyToWeekly(candles);
  assert.equal(weeks.length, 2);
  assert.equal(weeks[0].week_start, '2026-01-05');
  assert.equal(weeks[0].open, 100);
  assert.equal(weeks[0].close, 107);
  assert.ok(weeks[0].high >= 107);
  assert.ok(weeks[0].volume > 0);
});

test('weekly timeframe labels supportive trend as WEEKLY_SUPPORT', function() {
  const result = weekly.evaluateWeeklyTimeframe(dailyCandles(80, 100, 1));
  assert.equal(result.weekly_tf_label, 'WEEKLY_SUPPORT');
  assert.equal(result.weekly_tf_score_adjustment, 3);
  assert.ok(result.weekly_close > result.weekly_ma10);
});

test('weekly timeframe labels close below MA10 as WEEKLY_WEAK', function() {
  const up = dailyCandles(70, 100, 1);
  const down = dailyCandles(20, 170, -4).map(function(c, i) {
    c.date = new Date(Date.UTC(2026, 2, 16 + i)).toISOString().slice(0, 10);
    return c;
  });
  const result = weekly.evaluateWeeklyTimeframe(up.concat(down));
  assert.equal(result.weekly_tf_label, 'WEEKLY_WEAK');
  assert.equal(result.weekly_tf_score_adjustment, -4);
});

test('weekly timeframe returns WEEKLY_UNKNOWN when data is insufficient', function() {
  const result = weekly.evaluateWeeklyTimeframe(dailyCandles(15, 100, 1));
  assert.equal(result.weekly_tf_label, 'WEEKLY_UNKNOWN');
  assert.equal(result.weekly_tf_score_adjustment, 0);
});

test('weekly timeframe score adjustment is light and capped 0-100', function() {
  assert.equal(weekly.applyWeeklyTimeframeScore(98, { weekly_tf_score_adjustment: 3 }), 100);
  assert.equal(weekly.applyWeeklyTimeframeScore(2, { weekly_tf_score_adjustment: -4 }), 0);
  assert.equal(weekly.applyWeeklyTimeframeScore(70, { weekly_tf_score_adjustment: 0 }), 70);
});
