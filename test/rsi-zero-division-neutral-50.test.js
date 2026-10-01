'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const dailyRsi = require('../lib/daily-rsi');
const quoteApi = require('../api/quote');
const candlesApi = require('../api/candles');
const dtEngine = require('../lib/daytrade-screener-engine');
const sectorHot = require('../api/sector-hot');

test('BUG-015: flat series (15 identical closes) returns neutral 50 across all RSI implementations', () => {
  const flatCloses = new Array(15).fill(1000);
  const flatDates = flatCloses.map((_, i) => '2026-01-' + String(i + 1).padStart(2, '0'));

  // 1. Reference: lib/daily-rsi.js (already returned 50)
  const libResult = dailyRsi.computeLatestRsi(flatCloses, flatDates, { period: 14 });
  assert.equal(libResult.rsi_14, 50, 'lib/daily-rsi should return 50');

  // 2. api/quote.js calcRSI
  assert.equal(typeof quoteApi.__test.calcRSI, 'function');
  const quoteRsi = quoteApi.__test.calcRSI(flatCloses, 14);
  assert.equal(quoteRsi, 50, 'api/quote.js calcRSI should return 50, not 100');

  // 3. api/candles.js calcRSI
  assert.equal(typeof candlesApi.__test.calcRSI, 'function');
  const candlesRsi = candlesApi.__test.calcRSI(flatCloses, 14);
  assert.equal(candlesRsi, 50, 'api/candles.js calcRSI should return 50, not 100');

  // 4. lib/daytrade-screener-engine.js calcRSI
  assert.equal(typeof dtEngine.calcRSI, 'function');
  const dtRsi = dtEngine.calcRSI(flatCloses, 14);
  assert.equal(dtRsi, 50, 'lib/daytrade-screener-engine.js calcRSI should return 50, not 100');

  // 5. api/sector-hot.js calcScreenerRSI
  assert.equal(typeof sectorHot.__test.calcScreenerRSI, 'function');
  const hotScreenerRsi = sectorHot.__test.calcScreenerRSI(flatCloses, 14);
  assert.equal(hotScreenerRsi, 50, 'api/sector-hot.js calcScreenerRSI should return 50, not 100');

  // 6. api/sector-hot.js nkCalcRSI
  assert.equal(typeof sectorHot.__test.nkCalcRSI, 'function');
  const nkRsi = sectorHot.__test.nkCalcRSI(flatCloses, 14);
  assert.equal(nkRsi, 50, 'api/sector-hot.js nkCalcRSI should return 50, not 100');
});

test('BUG-015: uptrend series (strictly increasing) still returns 100', () => {
  const uptrendCloses = [];
  for (let i = 0; i < 15; i++) uptrendCloses.push(1000 + i * 10);

  assert.equal(quoteApi.__test.calcRSI(uptrendCloses, 14), 100);
  assert.equal(candlesApi.__test.calcRSI(uptrendCloses, 14), 100);
  assert.equal(dtEngine.calcRSI(uptrendCloses, 14), 100);
  assert.equal(sectorHot.__test.calcScreenerRSI(uptrendCloses, 14), 100);
  assert.equal(sectorHot.__test.nkCalcRSI(uptrendCloses, 14), 100);
});

test('BUG-015: downtrend series (strictly decreasing) still returns 0', () => {
  const downtrendCloses = [];
  for (let i = 0; i < 15; i++) downtrendCloses.push(1000 - i * 10);

  assert.equal(quoteApi.__test.calcRSI(downtrendCloses, 14), 0);
  assert.equal(candlesApi.__test.calcRSI(downtrendCloses, 14), 0);
  assert.equal(dtEngine.calcRSI(downtrendCloses, 14), 0);
  assert.equal(sectorHot.__test.calcScreenerRSI(downtrendCloses, 14), 0);
  assert.equal(sectorHot.__test.nkCalcRSI(downtrendCloses, 14), 0);
});
