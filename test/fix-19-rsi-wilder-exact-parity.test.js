'use strict';

/**
 * FIX-19: RSI Wilder (RMA) exact parity across all engines.
 *
 * Before this fix, chart-workstation.calculateRSI, api/candles.calcRSI,
 * api/quote.calcRSI and chart-image-renderer.rsiData all used a plain SMA over
 * a `period` window, which drifts 3-5 points from TradingView / lib/daily-rsi.
 * This test locks every engine to Wilder's smoothing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const Workstation = require('../public/chart-workstation.js');
const candlesApi = require('../api/candles.js');
const quoteApi = require('../api/quote.js');
const dailyRsi = require('../lib/daily-rsi.js');
const chartImageRenderer = require('../lib/chart-image-renderer.js');

/** Deterministic pseudo-random walk so all engines see the exact same input. */
function buildCandles(n) {
  const out = [];
  let price = 1000;
  let seed = 42;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const step = ((seed % 2000) / 100) - 10; // -10 .. +10
    price = Math.max(50, Math.round(price + step));
    out.push({
      time: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      open: price - 5,
      high: price + 8,
      low: price - 8,
      close: price,
      volume: 10000 + (seed % 5000)
    });
  }
  return out;
}

const CANDLES = buildCandles(80);
const CLOSES = CANDLES.map((c) => c.close);

test('FIX-19: chart-workstation.calculateRSI uses Wilder RMA and matches lib/daily-rsi exactly', () => {
  const wsSeries = Workstation.calculateRSI(CANDLES, 14);
  assert.ok(wsSeries.length > 0, 'chart-workstation RSI series must not be empty');
  assert.equal(wsSeries.length, CLOSES.length - 14, 'Wilder series starts at index `period`');

  const reference = dailyRsi.computeLatestRsi(CLOSES, null, { period: 14 });
  const wsLatest = wsSeries[wsSeries.length - 1].value;

  assert.ok(Number.isFinite(wsLatest), 'latest chart-workstation RSI must be finite');
  assert.ok(
    Math.abs(wsLatest - reference.rsi_14) <= 0.01,
    `chart-workstation RSI (${wsLatest}) must match Wilder reference (${reference.rsi_14}) within 0.01`
  );
});

test('FIX-19: api/candles.calcRSI uses Wilder RMA and matches lib/daily-rsi exactly', () => {
  const calcRSI = candlesApi.__test.calcRSI;
  assert.equal(typeof calcRSI, 'function', 'api/candles.calcRSI must be exported');

  const value = calcRSI(CLOSES, 14);
  const reference = dailyRsi.computeLatestRsi(CLOSES, null, { period: 14 });

  assert.ok(Number.isFinite(value), 'api/candles RSI must be finite');
  assert.ok(
    Math.abs(value - reference.rsi_14) <= 0.01,
    `api/candles RSI (${value}) must match Wilder reference (${reference.rsi_14}) within 0.01`
  );
});

test('FIX-19: api/quote.calcRSI uses Wilder RMA and matches lib/daily-rsi exactly', () => {
  const calcRSI = quoteApi.calcRSI;
  assert.equal(typeof calcRSI, 'function', 'api/quote.calcRSI must be exported');

  const value = calcRSI(CLOSES, 14);
  const reference = dailyRsi.computeLatestRsi(CLOSES, null, { period: 14 });

  assert.ok(Number.isFinite(value), 'api/quote RSI must be finite');
  assert.ok(
    Math.abs(value - reference.rsi_14) <= 0.01,
    `api/quote RSI (${value}) must match Wilder reference (${reference.rsi_14}) within 0.01`
  );
});

test('FIX-19: chart-image-renderer RSI series is Wilder-smoothed (not SMA)', () => {
  const fn =
    (chartImageRenderer.__test && chartImageRenderer.__test.rsiSeries) ||
    (chartImageRenderer.__test && chartImageRenderer.__test.rsiData);
  assert.equal(typeof fn, 'function', 'chart-image-renderer must export a testable rsi series helper');

  const series = fn(CANDLES, 14);
  assert.ok(Array.isArray(series) && series.length > 0, 'renderer RSI series must not be empty');

  const last = series[series.length - 1];
  const value = typeof last === 'number' ? last : last.v;
  const reference = dailyRsi.computeLatestRsi(CLOSES, null, { period: 14 });

  assert.ok(
    Math.abs(value - reference.rsi_14) <= 0.01,
    `renderer RSI (${value}) must match Wilder reference (${reference.rsi_14}) within 0.01`
  );
});

test('FIX-19: Wilder guard behaviour — flat / up-only / down-only series', () => {
  const flat = new Array(40).fill(1000);
  const up = [];
  const down = [];
  for (let i = 0; i < 40; i++) {
    up.push(1000 + i * 10);
    down.push(2000 - i * 10);
  }

  const refFlat = dailyRsi.computeLatestRsi(flat, null, { period: 14 });
  const refUp = dailyRsi.computeLatestRsi(up, null, { period: 14 });
  const refDown = dailyRsi.computeLatestRsi(down, null, { period: 14 });

  assert.equal(refFlat.rsi_14, 50, 'flat series => 50');
  assert.equal(refUp.rsi_14, 100, 'up-only series => 100');
  assert.equal(refDown.rsi_14, 0, 'down-only series => 0');

  const wsFlat = Workstation.calculateRSI(flat.map((c, i) => ({ time: '2026-01-01', open: c, high: c, low: c, close: c, volume: 1 })), 14);
  const wsUp = Workstation.calculateRSI(up.map((c) => ({ time: '2026-01-01', open: c, high: c, low: c, close: c, volume: 1 })), 14);
  const wsDown = Workstation.calculateRSI(down.map((c) => ({ time: '2026-01-01', open: c, high: c, low: c, close: c, volume: 1 })), 14);

  assert.equal(wsFlat[wsFlat.length - 1].value, 50, 'chart-workstation flat => 50');
  assert.equal(wsUp[wsUp.length - 1].value, 100, 'chart-workstation up-only => 100');
  assert.equal(wsDown[wsDown.length - 1].value, 0, 'chart-workstation down-only => 0');

  const cFlat = candlesApi.__test.calcRSI(flat, 14);
  const cUp = candlesApi.__test.calcRSI(up, 14);
  const cDown = candlesApi.__test.calcRSI(down, 14);
  assert.equal(cFlat, 50);
  assert.equal(cUp, 100);
  assert.equal(cDown, 0);

  const qFlat = quoteApi.calcRSI(flat, 14);
  const qUp = quoteApi.calcRSI(up, 14);
  const qDown = quoteApi.calcRSI(down, 14);
  assert.equal(qFlat, 50);
  assert.equal(qUp, 100);
  assert.equal(qDown, 0);
});

test('FIX-19: non-finite closes fail closed instead of producing NaN', () => {
  const dirty = CLOSES.slice();
  dirty[5] = null;

  assert.equal(candlesApi.__test.calcRSI(dirty, 14), null, 'api/candles must fail closed to null');
  assert.equal(quoteApi.calcRSI(dirty, 14), null, 'api/quote must fail closed to null');
});
