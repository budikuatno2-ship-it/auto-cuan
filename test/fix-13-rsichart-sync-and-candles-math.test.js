'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const candlesModule = require('../api/candles.js');

test('FIX-13: public/market-feature-runtime.js synchronizes rsiChart timescale with main chart', () => {
  const code = fs.readFileSync(require.resolve('../public/market-feature-runtime.js'), 'utf8');
  assert.match(code, /subscribeVisibleLogicalRangeChange/, 'Must subscribe to visible logical range change');
  assert.match(code, /if\s*\(\s*rsiChart\s*\)\s*rsiChart\.timeScale\(\)\.setVisibleLogicalRange\(range\)/, 'Must synchronize rsiChart timescale range');
});

test('FIX-13: api/candles.js calcMA returns null when non-finite elements exist in slice', () => {
  const calcMA = candlesModule.__test.calcMA;
  assert.equal(typeof calcMA, 'function', 'calcMA must be exported in __test');

  // Valid series
  const valid = [10, 20, 30, 40, 50];
  assert.equal(calcMA(valid, 5), 30);

  // Series containing NaN or null in period slice
  const withNaN = [10, 20, NaN, 40, 50];
  assert.equal(calcMA(withNaN, 5), null, 'Must fail-closed to null when element is NaN');

  const withNull = [10, 20, null, 40, 50];
  assert.equal(calcMA(withNull, 5), null, 'Must fail-closed to null when element is null');

  const withInf = [10, 20, Infinity, 40, 50];
  assert.equal(calcMA(withInf, 5), null, 'Must fail-closed to null when element is Infinity');
});

test('FIX-13: api/candles.js calcRSI handles neutral and extreme cases reliably', () => {
  const calcRSI = candlesModule.__test.calcRSI;
  assert.equal(typeof calcRSI, 'function');

  // Flat prices -> no change -> 50 neutral
  const flat = new Array(15).fill(100);
  assert.equal(calcRSI(flat, 14), 50);

  // Strictly increasing prices -> 100
  const up = [];
  for (let i = 0; i < 20; i++) up.push(100 + i * 5);
  assert.equal(calcRSI(up, 14), 100);
});
