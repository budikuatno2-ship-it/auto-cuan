'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Workstation = require('../public/chart-workstation.js');

test('FIX-01 AntiSlop: Backtest returns honest insufficientData when count < 20', () => {
  const candles = [];
  for (let i = 0; i < 10; i++) {
    candles.push({
      time: `2026-01-0${i + 1}`,
      open: 1000,
      high: 1050,
      low: 950,
      close: 1000,
      volume: 1000
    });
  }

  const result = Workstation.calculateHistoricalBacktest(candles, 'BBCA');
  assert.equal(result.insufficientData, true, 'Must flag insufficientData: true');
  assert.equal(result.totalTrades, '0 Trade');
  assert.equal(result.winRate, '—');
  assert.equal(result.profitFactor, '—');
  assert.equal(result.maxDrawdown, '—');
  assert.equal(result.avgHoldingDays, '—');
  assert.equal(result.expectancy, '—');
});

test('FIX-01 AntiSlop: Backtest returns honest insufficientData without hash-seed fabrication when trades < 3', () => {
  const candles = [];
  // 30 flat candles that will not trigger MA20 breakout
  for (let i = 0; i < 30; i++) {
    candles.push({
      time: `2026-01-${String(i + 1).padStart(2, '0')}`,
      open: 1000,
      high: 1005,
      low: 995,
      close: 1000,
      volume: 100
    });
  }

  const result = Workstation.calculateHistoricalBacktest(candles, 'BBCA');
  assert.equal(result.insufficientData, true, 'Must flag insufficientData: true when trades < 3');
  assert.equal(result.winRate, '—', 'Must NOT return fabricated winRate from ticker seed');
  assert.equal(result.profitFactor, '—', 'Must NOT return fabricated profitFactor');
  assert.equal(result.maxDrawdown, '—', 'Must NOT return fabricated maxDrawdown');
  assert.equal(result.avgHoldingDays, '—');
  assert.equal(result.expectancy, '—');
});

test('FIX-01 AntiSlop: Foreign flow functions do not fabricate numbers when data is absent', () => {
  const candles = [
    { time: '2026-01-01', open: 1000, high: 1050, low: 950, close: 1020, volume: 10000 },
    { time: '2026-01-02', open: 1020, high: 1060, low: 1010, close: 1050, volume: 12000 },
    { time: '2026-01-03', open: 1050, high: 1070, low: 1030, close: 1060, volume: 11000 },
    { time: '2026-01-04', open: 1060, high: 1080, low: 1050, close: 1070, volume: 13000 }
  ];

  // 1. calculateForeignFlowCumulative with no foreign net
  const cum = Workstation.calculateForeignFlowCumulative(candles, []);
  assert.equal(cum.length, 4);
  assert.equal(cum[0].net, 0, 'Foreign net must be 0 when data missing, not 0.12 * vol * close');
  assert.equal(cum[3].value, 0, 'Cumulative value must be 0');

  // 2. calculateCorrF with no foreign net
  const corr = Workstation.calculateCorrF(candles, [], 20);
  assert.equal(corr, 0.0, 'Correlation must be 0.0 when foreign net is missing');

  // 3. calculateParF with no foreign net
  const par = Workstation.calculateParF(candles, null, 20);
  assert.equal(par, 0.0, 'Foreign participation must be 0.0, NOT synthetic 28.5');

  // 4. getLatestForeignNet with no foreign net
  const latestNet = Workstation.getLatestForeignNet(candles, []);
  assert.equal(latestNet, 0, 'Latest foreign net must be 0, not 0.12 * vol * close');
});
