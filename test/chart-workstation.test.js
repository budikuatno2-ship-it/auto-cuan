'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Workstation = require('../public/chart-workstation.js');

test('Chart Workstation - Layer Registry and Presets Contract', () => {
  assert.equal(typeof Workstation, 'object');
  assert.ok(Array.isArray(Workstation.LAYER_GROUPS));
  assert.equal(Workstation.LAYER_GROUPS.length, 9, 'Must have exactly 9 layer groups');

  const groupIds = Workstation.LAYER_GROUPS.map(g => g.id);
  assert.deepEqual(groupIds, [
    'level_area',
    'trend_ema',
    'struktur',
    'sinyal',
    'volume',
    'fibonacci',
    'pola_klasik',
    'osilator',
    'bandar_metrics'
  ]);

  // Presets
  const presets = Object.keys(Workstation.PRESETS);
  assert.deepEqual(presets, ['simpel', 'scalping', 'swing', 'investor', 'pro']);

  // Validate all preset layers belong to registry
  const allLayerIds = new Set();
  Workstation.LAYER_GROUPS.forEach(g => g.layers.forEach(l => allLayerIds.add(l.id)));

  presets.forEach(p => {
    Workstation.PRESETS[p].layers.forEach(l => {
      assert.ok(allLayerIds.has(l), `Layer ${l} in preset ${p} must exist in registry`);
    });
  });
});

test('Chart Workstation - State Management and Switching (<100ms)', () => {
  const state = Workstation.createWorkstationState('simpel');
  assert.equal(state.activePreset, 'simpel');
  assert.ok(state.isLayerActive('ma20'));
  assert.ok(state.isLayerActive('ma50'));
  assert.ok(!state.isLayerActive('ma200'));

  const t0 = performance.now();
  state.applyPreset('pro');
  const tDiff = performance.now() - t0;
  assert.ok(tDiff < 100, `Preset switch must be < 100ms (was ${tDiff.toFixed(2)}ms)`);

  assert.equal(state.activePreset, 'pro');
  assert.ok(state.isLayerActive('ma200'));
  assert.ok(state.isLayerActive('bandar_foreign'));

  state.setAllLayers(false);
  assert.equal(state.getActiveLayerCount(), 0);

  state.reset();
  assert.equal(state.activePreset, 'simpel');
  assert.ok(state.getActiveLayerCount() > 0);
});

test('Chart Workstation - Deterministic Weekly Aggregation (1D -> 1W)', () => {
  const dailyCandles = [
    // Week 1 (Monday to Friday, 2026-10-05 to 2026-10-09)
    { time: '2026-10-05', open: 100, high: 110, low: 95, close: 105, volume: 1000 },
    { time: '2026-10-06', open: 105, high: 115, low: 102, close: 112, volume: 1500 },
    { time: '2026-10-07', open: 112, high: 120, low: 108, close: 110, volume: 2000 },
    { time: '2026-10-08', open: 110, high: 114, low: 104, close: 106, volume: 1200 },
    { time: '2026-10-09', open: 106, high: 108, low: 100, close: 102, volume: 1300 },
    // Week 2 (Monday to Wednesday, 2026-10-12 to 2026-10-14)
    { time: '2026-10-12', open: 103, high: 118, low: 101, close: 115, volume: 3000 },
    { time: '2026-10-13', open: 115, high: 125, low: 112, close: 122, volume: 4000 },
    { time: '2026-10-14', open: 122, high: 130, low: 120, close: 128, volume: 5000 }
  ];

  const weekly = Workstation.aggregateDailyToWeekly(dailyCandles);
  assert.equal(weekly.length, 2, 'Should aggregate into exactly 2 weeks');

  // Week 1 check
  assert.equal(weekly[0].time, '2026-10-05');
  assert.equal(weekly[0].open, 100);
  assert.equal(weekly[0].high, 120);
  assert.equal(weekly[0].low, 95);
  assert.equal(weekly[0].close, 102);
  assert.equal(weekly[0].volume, 7000);
  assert.equal(weekly[0].candlesCount, 5);

  // Week 2 check
  assert.equal(weekly[1].time, '2026-10-12');
  assert.equal(weekly[1].open, 103);
  assert.equal(weekly[1].high, 130);
  assert.equal(weekly[1].low, 101);
  assert.equal(weekly[1].close, 128);
  assert.equal(weekly[1].volume, 12000);
  assert.equal(weekly[1].candlesCount, 3);
});

test('Chart Workstation - Visual Trading Plan & Strict R/R Gate < 1.5', () => {
  const dummyCandles = [
    { time: '2026-10-01', open: 1000, high: 1020, low: 980, close: 1000, volume: 100 },
    { time: '2026-10-02', open: 1000, high: 1040, low: 990, close: 1030, volume: 100 },
    { time: '2026-10-05', open: 1030, high: 1050, low: 1010, close: 1040, volume: 100 },
    { time: '2026-10-06', open: 1040, high: 1060, low: 1020, close: 1050, volume: 100 },
    { time: '2026-10-07', open: 1050, high: 1070, low: 1030, close: 1060, volume: 100 }
  ];

  // Unsafe R/R scenario: Entry 1000, SL 950 (Risk 50), TP1 1050 (Reward 50) -> R/R = 1.0 < 1.5
  const unsafePlan = Workstation.calculateTradingPlan(dummyCandles, { entry: 1000, sl: 950, tp1: 1050, tp2: 1100, lots: 100 });
  assert.equal(unsafePlan.rrRatio, 1.0);
  assert.equal(unsafePlan.isSafeRR, false);
  assert.match(unsafePlan.warningMessage, /PERINGATAN KETAT/);
  assert.match(unsafePlan.warningMessage, /Ditolak Risk Gate/);

  // Safe R/R scenario: Entry 1000, SL 950 (Risk 50), TP1 1100 (Reward 100) -> R/R = 2.0 >= 1.5
  const safePlan = Workstation.calculateTradingPlan(dummyCandles, { entry: 1000, sl: 950, tp1: 1100, tp2: 1150, lots: 100 });
  assert.equal(safePlan.rrRatio, 2.0);
  assert.equal(safePlan.isSafeRR, true);
  assert.match(safePlan.warningMessage, /memenuhi Risk Gate/);

  // Scale-out calculation check (100 lots total -> 50 lots TP1, 50 lots TP2)
  assert.equal(safePlan.scaleOut.totalLots, 100);
  assert.equal(safePlan.scaleOut.tp1Lots, 50);
  assert.equal(safePlan.scaleOut.tp2Lots, 50);
  assert.equal(safePlan.scaleOut.breakevenStop, 1000);
  assert.ok(safePlan.scaleOut.netProfit > 0);
  assert.ok(safePlan.scaleOut.totalFees > 0);
});

test('Chart Workstation - Indicators Math (SMA, EMA, Bollinger, MACD, RSI)', () => {
  const candles = [];
  for (let i = 1; i <= 60; i++) {
    candles.push({
      time: `2026-01-${String(i).padStart(2, '0')}`,
      open: 100 + i,
      high: 105 + i,
      low: 95 + i,
      close: 100 + i,
      volume: 1000 * i
    });
  }

  const sma20 = Workstation.calculateSMA(candles, 20);
  assert.equal(sma20.length, 41);
  assert.ok(sma20[0].value > 0);

  const ema20 = Workstation.calculateEMA(candles, 20);
  assert.equal(ema20.length, 41);
  assert.ok(ema20[0].value > 0);

  const bb = Workstation.calculateBollinger(candles, 20, 2);
  assert.equal(bb.upper.length, 41);
  assert.ok(bb.upper[0].value > bb.middle[0].value);
  assert.ok(bb.middle[0].value > bb.lower[0].value);

  const rsi = Workstation.calculateRSI(candles, 14);
  assert.ok(rsi.length > 0);
  assert.ok(rsi[0].value >= 0 && rsi[0].value <= 100);

  const macd = Workstation.calculateMACD(candles, 12, 26, 9);
  assert.ok(macd.macd.length > 0);
  assert.ok(macd.signal.length > 0);
  assert.ok(macd.hist.length > 0);
});
