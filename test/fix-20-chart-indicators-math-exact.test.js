'use strict';

/**
 * FIX-20: Chart Workstation indicator math purity.
 *
 * Locks five behaviours:
 *  1. calculateCMF must not fabricate a 0.0 line on warmup bars.
 *  2. getIdxTickSize / roundToIdxTick must honour FCA/Akselerasi Rp1 tick and
 *     never return < 1 for a positive price.
 *  3. calculateTradingPlan must exclude the still-open last bar from the
 *     20-day support scan and must not carry a forceUnsafeRR backdoor.
 *  4. SMA/EMA/Bollinger/MACD must skip non-finite closes consistently.
 *  5. calculateParF must not use the magic `* 1.5` gross-up on foreign_net.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Workstation = require('../public/chart-workstation.js');

function mkCandles(n, base = 1000) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = base + i;
    out.push({ time: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, open: c - 2, high: c + 5, low: c - 5, close: c, volume: 1000 + i * 10 });
  }
  return out;
}

test('FIX-20: calculateCMF emits no fabricated 0.0 warmup values', () => {
  const candles = mkCandles(30);
  const cmf = Workstation.calculateCMF(candles, 20);

  assert.ok(Array.isArray(cmf), 'CMF must return an array');

  // The canonical contract: the series starts at index period-1, exactly like
  // SMA/EMA/Bollinger. Previously the code pushed 20 fake 0.0 warmup points,
  // so the series ended at candles.length (30) instead of 11.
  assert.equal(cmf.length, candles.length - 20 + 1, 'CMF series must start at index period-1 (same as SMA/Bollinger)');
  assert.equal(cmf[0].time, candles[19].time, 'first CMF point must be anchored at candle index 19');
  assert.equal(cmf[cmf.length - 1].time, candles[29].time, 'last CMF point must be the newest candle');
});

test('FIX-20: getIdxTickSize honours FCA/Akselerasi Rp1 tick and never returns 0', () => {
  // Standard IDX fractional ladder
  assert.equal(Workstation.getIdxTickSize(100), 1);
  assert.equal(Workstation.getIdxTickSize(300), 2);
  assert.equal(Workstation.getIdxTickSize(1000), 5);
  assert.equal(Workstation.getIdxTickSize(3000), 10);
  assert.equal(Workstation.getIdxTickSize(6000), 25);

  // FCA / Akselerasi boards trade at Rp1 regardless of the price ladder
  assert.equal(Workstation.getIdxTickSize(6000, null, true), 1, 'isFca=true => Rp1 tick');
  assert.equal(Workstation.getIdxTickSize(6000, 'AKSELERASI', false), 1, 'board AKSELERASI => Rp1 tick');
  assert.equal(Workstation.getIdxTickSize(6000, 'PEMANTAUAN KHUSUS', false), 1, 'board PEMANTAUAN => Rp1 tick');

  // Invalid / sub-Rp1 input must never return 0
  assert.equal(Workstation.getIdxTickSize(0), 1, 'zero price falls back to tick 1');
  assert.equal(Workstation.getIdxTickSize(-5), 1, 'negative price falls back to tick 1');
  assert.equal(Workstation.getIdxTickSize(NaN), 1, 'NaN falls back to tick 1');
  assert.equal(Workstation.getIdxTickSize(null), 1, 'null falls back to tick 1');
});

test('FIX-20: roundToIdxTick never yields a value below 1 for a positive price', () => {
  assert.equal(Workstation.roundToIdxTick(0.4), 1, 'sub-tick positive price rounds up to 1');
  assert.equal(Workstation.roundToIdxTick(0.4, 'down'), 1, 'even a down-round cannot produce 0');
  assert.ok(Workstation.roundToIdxTick(0.4) >= 1);
  assert.ok(Workstation.roundToIdxTick(0.9, 'down') >= 1);
  // FCA board always snaps to whole rupiah
  assert.equal(Workstation.roundToIdxTick(1003, 'down', 'AKSELERASI', true), 1003);
  assert.equal(Workstation.roundToIdxTick(NaN), 0, 'non-finite input still fails closed to 0');
});

test('FIX-20: calculateTradingPlan excludes the live last bar and drops the forceUnsafeRR backdoor', () => {
  const candles = mkCandles(25, 1000);
  // Make the live last bar's low artificially deep — it must NOT become support.
  candles[candles.length - 1].low = 1;

  const plan = Workstation.calculateTradingPlan(candles, { entry: 1024, lots: 10 });
  assert.ok(plan, 'plan must be produced');
  assert.ok(plan.sl > 1, 'SL must not be derived from the live bar low of 1');

  // forceUnsafeRR must no longer be honoured. With an explicit caller-supplied
  // tp1 of 1100 the plan legitimately has R/R 2.0; the removed backdoor used to
  // overwrite tp1 down to ~1.49 R/R regardless of what the caller asked for.
  const forced = Workstation.calculateTradingPlan(candles, {
    entry: 1000, sl: 950, tp1: 1100, tp2: 1150, lots: 10, forceUnsafeRR: true
  });
  assert.equal(forced.tp1, 1100, 'forceUnsafeRR must NOT overwrite the caller-supplied TP1');
  assert.equal(forced.rrRatio, 2.0, 'R/R must reflect the honest levels, not an injected 1.49');
  assert.equal(forced.isSafeRR, true);
});

test('FIX-20: SMA/EMA/Bollinger/MACD skip non-finite closes instead of poisoning the accumulator', () => {
  // Corrupt bars are placed BEFORE the trailing 20-bar window so genuine
  // windows still exist. Any window that contains a corrupt bar is dropped
  // (fail-closed) rather than silently emitting NaN.
  const candles = mkCandles(60);
  candles[2].close = null;
  candles[5].close = NaN;

  const sma = Workstation.calculateSMA(candles, 20);
  assert.ok(sma.length > 0, 'SMA must still produce points for clean windows');
  for (const p of sma) {
    assert.ok(Number.isFinite(p.value), `SMA value at ${p.time} must be finite, got ${p.value}`);
  }

  const ema = Workstation.calculateEMA(candles, 20);
  for (const p of ema) assert.ok(Number.isFinite(p.value), `EMA value at ${p.time} must be finite`);

  const bb = Workstation.calculateBollinger(candles, 20, 2);
  for (const p of bb.middle) assert.ok(Number.isFinite(p.value), `Bollinger middle at ${p.time} must be finite`);
  for (const p of bb.upper) assert.ok(Number.isFinite(p.value), `Bollinger upper at ${p.time} must be finite`);

  const macd = Workstation.calculateMACD(candles, 12, 26, 9);
  for (const p of macd.macd) assert.ok(Number.isFinite(p.value), `MACD line at ${p.time} must be finite`);
});

test('FIX-20: calculateParF does not apply the magic 1.5 multiplier to foreign_net', () => {
  const candles = [
    { time: '2026-01-01', open: 100, high: 105, low: 95, close: 100, volume: 1000, foreign_net: -500 },
    { time: '2026-01-02', open: 100, high: 105, low: 95, close: 100, volume: 1000, foreign_net: 500 }
  ];

  const par = Workstation.calculateParF(candles, null, 20);
  // foreignVol = |−500| + |500| = 1000 (no 1.5 gross-up)
  // totalVol = 2000; ratio = 1000 / (2000 * 2) * 100 = 25.0
  assert.equal(par, 25.0, 'ParF must use |foreign_net| directly, not |foreign_net| * 1.5');

  // Absent foreign data must remain an honest 0.0 (FIX-01 contract preserved).
  const bare = candles.map((c) => ({ ...c, foreign_net: undefined }));
  assert.equal(Workstation.calculateParF(bare, null, 20), 0.0);
});
