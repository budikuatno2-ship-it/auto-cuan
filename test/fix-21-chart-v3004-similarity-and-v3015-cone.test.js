'use strict';

/**
 * FIX-21: V3_004 (Normalized Cross-Correlation Historical Similarity) and
 * V3_015 (20-Day Volatility Probability Cone) must exist as real, exported,
 * fail-closed pure functions on the Chart Workstation module.
 *
 * AntiSlop contract: when the data is too short, both functions MUST return
 * `insufficientData: true` with empty results — never a fabricated guess.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Workstation = require('../public/chart-workstation.js');

function buildCandles(n, base = 1000) {
  const out = [];
  let price = base;
  let seed = 7;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const step = ((seed % 1600) / 100) - 8;
    price = Math.max(100, Math.round(price + step));
    out.push({
      time: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      open: price - 4,
      high: price + 6,
      low: price - 6,
      close: price,
      volume: 10000 + (seed % 4000)
    });
  }
  return out;
}

test('FIX-21: calculateHistoricalSimilarity (V3_004) is exported and fails closed on short data', () => {
  assert.equal(typeof Workstation.calculateHistoricalSimilarity, 'function', 'V3_004 must be exported');

  // windowSize 20 => needs >= 20*2 + 10 = 50 candles
  const short = Workstation.calculateHistoricalSimilarity(buildCandles(40), { windowSize: 20, horizon: 10 });
  assert.equal(short.insufficientData, true, 'short history must fail closed');
  assert.deepEqual(short.matches, []);
  assert.deepEqual(short.consensusPath, []);

  assert.equal(Workstation.calculateHistoricalSimilarity(null).insufficientData, true);
  assert.equal(Workstation.calculateHistoricalSimilarity([]).insufficientData, true);
});

test('FIX-21: calculateHistoricalSimilarity returns up to 5 non-overlapping positive-correlation matches + consensus path', () => {
  const candles = buildCandles(200);
  const res = Workstation.calculateHistoricalSimilarity(candles, { windowSize: 20, horizon: 10 });

  assert.equal(res.insufficientData, false, 'sufficient history must produce a result');
  assert.ok(Array.isArray(res.matches), 'matches must be an array');
  assert.ok(res.matches.length <= 5, 'at most 5 matches are returned');
  assert.ok(res.matches.length >= 1, 'a strongly trending series must yield at least one match');

  for (const m of res.matches) {
    assert.equal(typeof m.endIndex, 'number', 'each match exposes endIndex');
    assert.ok(Number.isFinite(m.rho), 'each match exposes a finite rho');
    assert.ok(m.rho > 0, `rho must be > 0 (got ${m.rho})`);
    assert.ok(m.rho <= 1.0001, 'rho must be a bounded Pearson correlation');
  }

  // Non-maximum suppression: match windows must not overlap.
  const sorted = res.matches.slice().sort((a, b) => a.endIndex - b.endIndex);
  for (let i = 1; i < sorted.length; i++) {
    const gap = Math.abs(sorted[i].endIndex - sorted[i - 1].endIndex);
    assert.ok(gap >= Math.floor(20 / 2), `matches must be at least windowSize/2 apart (got gap ${gap})`);
  }

  // Consensus path: one projection point per horizon bar.
  assert.equal(res.consensusPath.length, 10, 'consensus path must cover the full horizon');
  for (const p of res.consensusPath) {
    assert.ok(Number.isFinite(p.value), 'each consensus point must be finite');
    assert.ok(p.weight > 0, 'each consensus point must carry a positive weight');
  }
});

test('FIX-21: calculateVolatilityCone (V3_015) is exported and fails closed below 30 valid bars', () => {
  assert.equal(typeof Workstation.calculateVolatilityCone, 'function', 'V3_015 must be exported');

  const short = Workstation.calculateVolatilityCone(buildCandles(25), { lookback: 60, days: 20 });
  assert.equal(short.insufficientData, true, 'fewer than 30 valid bars must fail closed');
  assert.equal(short.dailySigma, null);
  assert.deepEqual(short.bands, []);

  assert.equal(Workstation.calculateVolatilityCone(null).insufficientData, true);
});

test('FIX-21: calculateVolatilityCone produces monotone z-score bands snapped to IDX ticks', () => {
  const candles = buildCandles(120, 2000);
  const res = Workstation.calculateVolatilityCone(candles, { lookback: 60, days: 20 });

  assert.equal(res.insufficientData, false, '120 bars must be sufficient');
  assert.ok(Number.isFinite(res.dailySigma), 'dailySigma must be finite');
  assert.ok(res.dailySigma > 0, 'a real price series must have positive volatility');

  assert.equal(res.bands.length, 20, 'cone must cover the full horizon');

  for (const band of res.bands) {
    assert.equal(typeof band.h, 'number', 'each band exposes its horizon index h');
    assert.ok(Number.isFinite(band.p50), `p50 must be finite at h=${band.h}`);
    assert.ok(band.upper68 >= band.p50, `upper68 must be >= p50 at h=${band.h}`);
    assert.ok(band.lower68 <= band.p50, `lower68 must be <= p50 at h=${band.h}`);
    assert.ok(band.upper90 >= band.upper68, `upper90 must widen beyond upper68 at h=${band.h}`);
    assert.ok(band.upper95 >= band.upper90, `upper95 must widen beyond upper90 at h=${band.h}`);
    assert.ok(band.lower95 <= band.lower90, `lower95 must widen below lower90 at h=${band.h}`);
    assert.ok(band.lower95 <= band.lower68, `lower95 must widen below lower68 at h=${band.h}`);
    // All levels must be legal IDX prices
    for (const key of ['p50', 'upper68', 'lower68', 'upper90', 'lower90', 'upper95', 'lower95']) {
      assert.ok(band[key] >= 1, `${key} must be a legal IDX price >= 1 (got ${band[key]})`);
      assert.equal(Number.isInteger(band[key]), true, `${key} must be snapped to a whole-rupiah tick`);
    }
  }

  // The cone must widen with the horizon (sqrt-of-time scaling).
  const first = res.bands[0];
  const last = res.bands[res.bands.length - 1];
  assert.ok(
    (last.upper95 - last.lower95) >= (first.upper95 - first.lower95),
    'the 95% band must widen monotonically with the horizon'
  );
});
