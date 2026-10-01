'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const rsiLib = require('../lib/daily-rsi');

test('insufficient history returns null with insufficient_history flag', () => {
  const closes = [100, 101, 102]; // needs period+1 = 15 for RSI14
  const result = rsiLib.computeLatestRsi(closes, ['d1', 'd2', 'd3']);
  assert.equal(result.rsi_14, null);
  assert.equal(result.rsi_state, null);
  assert.equal(result.insufficient_history, true);
});

test('deterministic known series: all gains -> RSI 100', () => {
  // 15 strictly increasing closes -> avgLoss = 0 -> RSI = 100
  const closes = [];
  for (let i = 0; i < 15; i++) closes.push(100 + i);
  const result = rsiLib.computeLatestRsi(closes, closes.map((_, i) => 'd' + i));
  assert.equal(result.rsi_14, 100);
  assert.equal(result.rsi_state, 'OVERBOUGHT');
});

test('deterministic known series: all losses -> RSI 0 -> OVERSOLD', () => {
  const closes = [];
  for (let i = 0; i < 15; i++) closes.push(200 - i);
  const result = rsiLib.computeLatestRsi(closes, closes.map((_, i) => 'd' + i));
  assert.equal(result.rsi_14, 0);
  assert.equal(result.rsi_state, 'OVERSOLD');
});

test('flat series (no change) -> RSI 50 -> NEUTRAL', () => {
  const closes = new Array(15).fill(100);
  const result = rsiLib.computeLatestRsi(closes, closes.map((_, i) => 'd' + i));
  assert.equal(result.rsi_14, 50);
  assert.equal(result.rsi_state, 'NEUTRAL');
});

test('mixed series produces a mid-range RSI classified NEUTRAL', () => {
  const closes = [100, 102, 101, 103, 102, 104, 103, 105, 104, 106, 105, 107, 106, 108, 107];
  const result = rsiLib.computeLatestRsi(closes, closes.map((_, i) => 'd' + i));
  assert.ok(result.rsi_14 > 30 && result.rsi_14 < 70, 'expected RSI in neutral band, got ' + result.rsi_14);
  assert.equal(result.rsi_state, 'NEUTRAL');
});

test('as_of_trade_date reflects the last date in the input', () => {
  const closes = new Array(16).fill(0).map((_, i) => 100 + i);
  const dates = closes.map((_, i) => '2026-01-' + String(i + 1).padStart(2, '0'));
  const result = rsiLib.computeLatestRsi(closes, dates);
  assert.equal(result.as_of_trade_date, dates[dates.length - 1]);
});

test('rsiState respects centralized thresholds override', () => {
  assert.equal(rsiLib.rsiState(25, { oversoldMax: 30, overboughtMin: 70 }), 'OVERSOLD');
  assert.equal(rsiLib.rsiState(75, { oversoldMax: 30, overboughtMin: 70 }), 'OVERBOUGHT');
  assert.equal(rsiLib.rsiState(50, { oversoldMax: 30, overboughtMin: 70 }), 'NEUTRAL');
  assert.equal(rsiLib.rsiState(null), null);
});
