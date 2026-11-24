'use strict';

/**
 * BUG10 TASK B regression tests — real VOL VS 30H ratio from canonical rows.
 * Run: node test/bug10-sector-volume-ratio.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const ratio = require('../lib/sector-volume-ratio');
const sectorRadar = require('../lib/sector-radar');
const canonical = require('../lib/canonical-daily-history-source');

function candles(volumes) {
  return volumes.map((v, i) => ({
    time: `2026-01-${String(i + 1).padStart(2, '0')}`,
    open: 100, high: 101, low: 99, close: 100, volume: v
  }));
}

test('exact 31-session canonical fixture: latest vs mean of prior 30', () => {
  const prior = Array(30).fill(100);
  const list = candles(prior.concat([200]));
  assert.equal(ratio.computeVolumeRatioFromCandles(list), 2);
});

test('fixture with 0.88x ratio formats through renderer contract', () => {
  const prior = Array(30).fill(100);
  const list = candles(prior.concat([88]));
  const r = ratio.computeVolumeRatioFromCandles(list);
  assert.equal(r, 0.88);
  assert.equal(String(r.toFixed(2)).replace('.', ',') + 'x', '0,88x');
});

test('insufficient history returns null honestly (no fabrication)', () => {
  assert.equal(ratio.computeVolumeRatioFromCandles(candles(Array(30).fill(100))), null);
  assert.equal(ratio.computeVolumeRatioFromCandles(candles(Array(5).fill(100))), null);
  assert.equal(ratio.computeVolumeRatioFromCandles(null), null);
});

test('zero or non-finite volumes return null', () => {
  const bad = candles(Array(30).fill(100).concat([0]));
  assert.equal(ratio.computeVolumeRatioFromCandles(bad), null);
  const nan = candles(Array(30).fill(100).concat([NaN]));
  assert.equal(ratio.computeVolumeRatioFromCandles(nan), null);
});

test('canonical snapshot BBCA 2026-11-20 produces a real finite ratio', () => {
  const meta = canonical.getCanonicalDailyHistoryMeta();
  assert.equal(meta.status, 'OK');
  assert.equal(meta.verified, true);
  const list = canonical.getCanonicalCandles('BBCA', 31);
  assert.equal(list.length, 31);
  assert.equal(list[30].time, '2026-11-20');
  assert.equal(list[30].close, 5550);
  assert.equal(list[30].volume, 147637100);
  const r = ratio.getTickerVolumeRatio('BBCA');
  assert.equal(typeof r, 'number');
  assert.ok(Number.isFinite(r) && r > 0);
});

test('sector radar emits real group and member ratios from canonical rows', () => {
  const groups = sectorRadar.getSectorRadarGroups();
  assert.ok(groups.length > 0);
  const withGroupRatio = groups.filter((g) => g.volume_ratio_30d != null);
  assert.ok(withGroupRatio.length > 0, 'at least one real group ratio');
  const withMemberRatio = groups.flatMap((g) => g.members || []).filter((m) => m.volume_ratio_30d != null);
  assert.ok(withMemberRatio.length > 0, 'at least one real member ratio');
  for (const g of withGroupRatio) {
    assert.ok(Number.isFinite(g.volume_ratio_30d) && g.volume_ratio_30d > 0);
    assert.equal(g.volume_ratio_30d, g.avg_volume_ratio);
  }
});
