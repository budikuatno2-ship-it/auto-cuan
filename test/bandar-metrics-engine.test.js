'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../lib/bandar-metrics-engine');

test('Bandar Metrics: Pearson Correlation works for positive, negative, and edge cases', () => {
  const pos = engine.calculatePearsonCorrelation([1, 2, 3, 4, 5], [10, 20, 30, 40, 50]);
  assert.equal(pos, 1.0);

  const neg = engine.calculatePearsonCorrelation([1, 2, 3, 4, 5], [50, 40, 30, 20, 10]);
  assert.equal(neg, -1.0);

  const flat = engine.calculatePearsonCorrelation([5, 5, 5, 5], [10, 20, 30, 40]);
  assert.equal(flat, 0.0);

  const tooShort = engine.calculatePearsonCorrelation([1, 2], [10, 20]);
  assert.equal(tooShort, null);
});

test('Bandar Metrics: Corr F handles missing feed honestly without synthetic figures', () => {
  const candles = [
    { time: '2026-10-01', open: 1000, high: 1020, low: 990, close: 1010, volume: 50000 },
    { time: '2026-10-02', open: 1010, high: 1050, low: 1000, close: 1040, volume: 60000 },
    { time: '2026-10-05', open: 1040, high: 1060, low: 1030, close: 1050, volume: 70000 },
    { time: '2026-10-06', open: 1050, high: 1080, low: 1040, close: 1070, volume: 80000 },
    { time: '2026-10-07', open: 1070, high: 1100, low: 1060, close: 1090, volume: 90000 }
  ];

  const resEmpty = engine.calculateCorrForeign(candles, []);
  assert.equal(resEmpty.value, null);
  assert.equal(resEmpty.status, 'NETRAL_ATAU_BELUM_ADA_FEED');

  const foreignFlow = [
    { date: '2026-10-01', foreign_net: 1000000 },
    { date: '2026-10-02', foreign_net: 5000000 },
    { date: '2026-10-05', foreign_net: 8000000 },
    { date: '2026-10-06', foreign_net: 12000000 },
    { date: '2026-10-07', foreign_net: 15000000 }
  ];

  const resValid = engine.calculateCorrForeign(candles, foreignFlow, 5);
  assert.ok(resValid.value !== null);
  assert.ok(resValid.value >= -1.0 && resValid.value <= 1.0);
  assert.ok(!JSON.stringify(resValid).includes('\u2014'), 'Zero em-dashes allowed');
});

test('Bandar Metrics: Par F calculates foreign participation ratio accurately', () => {
  const res = engine.calculateParForeign(40000000000, 100000000000);
  assert.equal(res.percentage, 40.0);
  assert.equal(res.status, 'SANGAT_TINGGI');

  const zeroTurnover = engine.calculateParForeign(1000, 0);
  assert.equal(zeroTurnover.percentage, null);
  assert.equal(zeroTurnover.status, 'DATA_TIDAK_TERSEDIA');
});

test('Bandar Metrics: LPM derives major buyer level and volume cluster', () => {
  const candles = [
    { time: '2026-10-01', open: 5000, high: 5100, low: 4950, close: 5050, volume: 100000 },
    { time: '2026-10-02', open: 5050, high: 5200, low: 5000, close: 5150, volume: 300000 },
    { time: '2026-10-05', open: 5150, high: 5250, low: 5100, close: 5200, volume: 150000 }
  ];

  const brokerSummary = {
    top_buyers: [
      { broker: 'ZP', avg_buy: 5120, bval: 50000000000 }
    ]
  };

  const lpm = engine.calculateLPM(candles, brokerSummary);
  assert.equal(lpm.major_level, 5120);
  assert.equal(lpm.top_buyer_broker, 'ZP');
  assert.ok(lpm.vwap_20 > 5000);
});

test('Bandar Metrics: Chaikin Money Flow (CMF) produces valid signals', () => {
  const candles = [];
  for (let i = 0; i < 25; i++) {
    candles.push({
      time: `2026-09-${String(i + 1).padStart(2, '0')}`,
      open: 1000 + i * 10,
      high: 1020 + i * 10,
      low: 990 + i * 10,
      close: 1015 + i * 10, // Close near high -> positive MFV
      volume: 100000
    });
  }

  const mf = engine.calculateMoneyFlow(candles, 20);
  assert.equal(mf.length, 25);
  const latest = mf[mf.length - 1];
  assert.ok(latest.value > 0);
  assert.ok(['INFLOW', 'INFLOW_KUAT'].includes(latest.signal));
});

test('Bandar Metrics: Intensity and Volume Rotation histograms format cleanly', () => {
  const candles = [
    { time: '2026-10-01', open: 1000, high: 1050, low: 990, close: 1040, volume: 50000 },
    { time: '2026-10-02', open: 1040, high: 1050, low: 980, close: 990, volume: 120000 }, // heavy red dump
    { time: '2026-10-05', open: 990, high: 1080, low: 980, close: 1070, volume: 150000 }   // heavy green pump
  ];

  const intensity = engine.calculateIntensityHistogram(candles, 3);
  assert.equal(intensity.length, 3);
  assert.ok(intensity[1].value < 0, 'Dump day must have negative intensity');
  assert.ok(intensity[2].value > 0, 'Pump day must have positive intensity');

  const rotation = engine.calculateVolumeRotation(candles, 3);
  assert.equal(rotation.length, 3);
  assert.ok(rotation[2].value > 1.0);
});

test('Bandar Metrics: calculateBandarMetrics runs on real BBCA candles', () => {
  const store = require('../lib/local-market-subset-store');
  const candleData = store.getCandles('BBCA');
  assert.ok(candleData && candleData.candles.length > 50);

  const metrics = engine.calculateBandarMetrics({
    candles: candleData.candles,
    brokerSummary: {
      top_buyers: [{ broker: 'ZP', avg_buy: 5993 }]
    }
  });

  assert.equal(metrics.success, true);
  assert.ok(metrics.indicators.lpm.major_level > 0);
  assert.ok(metrics.series.money_flow.length === candleData.candles.length);
  assert.ok(metrics.series.intensity.length === candleData.candles.length);
  assert.ok(metrics.series.volume_rotation.length === candleData.candles.length);
});
