'use strict';

/**
 * Tests for report-helpers.js
 * Pure helper functions for outcome report generation
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('../lib/report-helpers');

// === getScoreBucket tests ===

test('getScoreBucket returns correct bucket for scores', () => {
  assert.equal(helpers.getScoreBucket({ raw_payload: { score: 45 } }), '<50');
  assert.equal(helpers.getScoreBucket({ raw_payload: { score: 50 } }), '50-59');
  assert.equal(helpers.getScoreBucket({ raw_payload: { score: 59 } }), '50-59');
  assert.equal(helpers.getScoreBucket({ raw_payload: { score: 60 } }), '60-69');
  assert.equal(helpers.getScoreBucket({ raw_payload: { score: 69 } }), '60-69');
  assert.equal(helpers.getScoreBucket({ raw_payload: { score: 70 } }), '70-79');
  assert.equal(helpers.getScoreBucket({ raw_payload: { score: 79 } }), '70-79');
  assert.equal(helpers.getScoreBucket({ raw_payload: { score: 80 } }), '80+');
  assert.equal(helpers.getScoreBucket({ raw_payload: { score: 100 } }), '80+');
});

test('getScoreBucket uses row.score as fallback', () => {
  assert.equal(helpers.getScoreBucket({ score: 75 }), '70-79');
});

test('getScoreBucket returns null for missing/invalid scores', () => {
  assert.equal(helpers.getScoreBucket({}), null);
  assert.equal(helpers.getScoreBucket({ raw_payload: {} }), null);
  assert.equal(helpers.getScoreBucket({ raw_payload: { score: null } }), null);
  assert.equal(helpers.getScoreBucket({ raw_payload: { score: undefined } }), null);
  assert.equal(helpers.getScoreBucket({ raw_payload: { score: NaN } }), null);
  assert.equal(helpers.getScoreBucket(null), null);
});

// === calculateRate tests ===

test('calculateRate computes correct percentage', () => {
  assert.equal(helpers.calculateRate(50, 100), '50.0%');
  assert.equal(helpers.calculateRate(1, 3), '33.3%');
  assert.equal(helpers.calculateRate(0, 10), '0.0%');
  assert.equal(helpers.calculateRate(100, 100), '100.0%');
  assert.equal(helpers.calculateRate(7, 9), '77.8%');
});

test('calculateRate returns null for invalid inputs', () => {
  assert.equal(helpers.calculateRate(10, 0), null);
  assert.equal(helpers.calculateRate(10, null), null);
  assert.equal(helpers.calculateRate(null, 10), null);
  assert.equal(helpers.calculateRate(NaN, 10), null);
  assert.equal(helpers.calculateRate(10, NaN), null);
  // 0 is a valid rate, not null
  assert.equal(helpers.calculateRate(0, 10), '0.0%');
});

// === classifyOutcome tests ===

test('classifyOutcome returns TP2_HIT when hit_tp2_at exists', () => {
  const row = { hit_tp2_at: '2026-07-01T10:00:00Z' };
  assert.equal(helpers.classifyOutcome(row), 'TP2_HIT');
});

test('classifyOutcome returns SL_HIT when hit_sl_at exists', () => {
  const row = { hit_sl_at: '2026-07-01T10:00:00Z' };
  assert.equal(helpers.classifyOutcome(row), 'SL_HIT');
});

test('classifyOutcome returns TP1_HIT when hit_tp1_at exists', () => {
  const row = { hit_tp1_at: '2026-07-01T10:00:00Z' };
  assert.equal(helpers.classifyOutcome(row), 'TP1_HIT');
});

test('classifyOutcome returns WAITING for WAITING status', () => {
  const row = { status: 'WAITING' };
  assert.equal(helpers.classifyOutcome(row), 'WAITING');
});

test('classifyOutcome returns RUNNING for RUNNING/ACTIVE status', () => {
  assert.equal(helpers.classifyOutcome({ status: 'RUNNING' }), 'RUNNING');
  assert.equal(helpers.classifyOutcome({ status: 'ACTIVE' }), 'RUNNING');
});

test('classifyOutcome returns EXPIRED for expired statuses', () => {
  assert.equal(helpers.classifyOutcome({ status: 'EXPIRED' }), 'EXPIRED');
  assert.equal(helpers.classifyOutcome({ status: 'NEEDS_REVALIDATION' }), 'EXPIRED');
});

test('classifyOutcome returns TP2_HIT for status TP2_HIT', () => {
  assert.equal(helpers.classifyOutcome({ status: 'TP2_HIT' }), 'TP2_HIT');
  assert.equal(helpers.classifyOutcome({ status: 'SL_HIT' }), 'SL_HIT');
  assert.equal(helpers.classifyOutcome({ status: 'TP1_HIT' }), 'TP1_HIT');
});

test('classifyOutcome returns UNKNOWN for null/undefined', () => {
  assert.equal(helpers.classifyOutcome(null), 'UNKNOWN');
  assert.equal(helpers.classifyOutcome({}), 'UNKNOWN');
});

// === getMonitorSource tests ===

test('getMonitorSource extracts from raw_payload.monitor_source', () => {
  assert.equal(helpers.getMonitorSource({ raw_payload: { monitor_source: 'daytrade' } }), 'daytrade');
  assert.equal(helpers.getMonitorSource({ raw_payload: { monitor_source: 'daytrade_signal' } }), 'daytrade');
  assert.equal(helpers.getMonitorSource({ raw_payload: { monitor_source: 'swing_konglo' } }), 'swing_konglo');
  assert.equal(helpers.getMonitorSource({ raw_payload: { monitor_source: 'swing_nk' } }), 'swing_nk');
  assert.equal(helpers.getMonitorSource({ raw_payload: { monitor_source: 'top5' } }), 'top5');
  assert.equal(helpers.getMonitorSource({ raw_payload: { monitor_source: 'watchlist' } }), 'watchlist');
});

test('getMonitorSource falls back to category', () => {
  assert.equal(helpers.getMonitorSource({ category: 'Day Trade' }), 'daytrade');
  assert.equal(helpers.getMonitorSource({ category: 'Swing Konglo' }), 'swing_konglo');
  assert.equal(helpers.getMonitorSource({ category: 'Swing Non-Konglo' }), 'swing_nk');
  assert.equal(helpers.getMonitorSource({ raw_payload: { category: 'Top 5' } }), 'top5');
});

test('getMonitorSource returns null for unknown source', () => {
  assert.equal(helpers.getMonitorSource({ raw_payload: { monitor_source: 'unknown_type' } }), null);
  assert.equal(helpers.getMonitorSource({ category: 'Unknown Category' }), null);
});

// === calculateTimeDiffHours tests ===

test('calculateTimeDiffHours computes correct hours', () => {
  const result = helpers.calculateTimeDiffHours('2026-07-01T10:00:00Z', '2026-07-01T14:30:00Z');
  assert.equal(result, 4.5);
});

test('calculateTimeDiffHours handles same timestamp', () => {
  const result = helpers.calculateTimeDiffHours('2026-07-01T10:00:00Z', '2026-07-01T10:00:00Z');
  assert.equal(result, 0);
});

test('calculateTimeDiffHours handles reverse order', () => {
  const result = helpers.calculateTimeDiffHours('2026-07-01T14:00:00Z', '2026-07-01T10:00:00Z');
  assert.equal(result, 4);
});

test('calculateTimeDiffHours returns null for invalid timestamps', () => {
  assert.equal(helpers.calculateTimeDiffHours(null, '2026-07-01T10:00:00Z'), null);
  assert.equal(helpers.calculateTimeDiffHours('2026-07-01T10:00:00Z', null), null);
  assert.equal(helpers.calculateTimeDiffHours('invalid', '2026-07-01T10:00:00Z'), null);
});

// === calculateAverage tests ===

test('calculateAverage computes correct average', () => {
  assert.equal(helpers.calculateAverage([10, 20, 30]), 20);
  assert.equal(helpers.calculateAverage([100]), 100);
  assert.equal(helpers.calculateAverage([1.5, 2.5, 3.0]), 2.3);
});

test('calculateAverage returns null for empty/invalid arrays', () => {
  assert.equal(helpers.calculateAverage([]), null);
  assert.equal(helpers.calculateAverage(null), null);
  assert.equal(helpers.calculateAverage([null, NaN, undefined]), null);
});

// === groupBy tests ===

test('groupBy groups items correctly', () => {
  const items = [
    { type: 'a', val: 1 },
    { type: 'b', val: 2 },
    { type: 'a', val: 3 },
  ];
  const grouped = helpers.groupBy(items, i => i.type);
  
  assert.equal(grouped.a.length, 2);
  assert.equal(grouped.b.length, 1);
  assert.equal(grouped.a[0].val, 1);
  assert.equal(grouped.a[1].val, 3);
});

test('groupBy handles null/undefined items', () => {
  const grouped = helpers.groupBy(null, i => i.type);
  assert.deepEqual(grouped, {});
});

// === countWhere tests ===

test('countWhere counts matching items', () => {
  const items = [1, 2, 3, 4, 5];
  assert.equal(helpers.countWhere(items, x => x > 3), 2);
  assert.equal(helpers.countWhere(items, x => x % 2 === 0), 2);
  assert.equal(helpers.countWhere(items, x => x > 10), 0);
});

test('countWhere handles null/undefined', () => {
  assert.equal(helpers.countWhere(null, x => x > 0), 0);
});

// === safeGet tests ===

test('safeGet retrieves nested values', () => {
  const obj = { a: { b: { c: 42 } } };
  assert.equal(helpers.safeGet(obj, 'a.b.c'), 42);
  assert.deepStrictEqual(helpers.safeGet(obj, 'a.b'), { c: 42 });
});

test('safeGet returns null for missing paths', () => {
  const obj = { a: 1 };
  assert.equal(helpers.safeGet(obj, 'b.c'), null);
  assert.equal(helpers.safeGet(null, 'a.b'), null);
  assert.equal(helpers.safeGet(obj, ''), null);
});

// === generateObservations tests ===

test('generateObservations creates observations from stats', () => {
  const stats = {
    entryRate: '85.0%',
    tp1Count: 10,
    tp2Count: 7,
    slRate: '5.0%',
    waitingCount: 3,
    runningCount: 2,
    scoreBuckets: { '80+': [1, 2], '<50': [3] },
    avgTimeToTp2: 8.5
  };
  
  const obs = helpers.generateObservations(stats);
  assert.ok(Array.isArray(obs));
  assert.ok(obs.length > 0);
  // Should contain entry rate observation
  assert.ok(obs.some(o => o.includes('85.0%')));
});

test('generateObservations handles missing data', () => {
  const obs = helpers.generateObservations({});
  assert.ok(Array.isArray(obs));
  assert.ok(obs.some(o => o.includes('data tidak tersedia')));
});

console.log('Report helpers tests loaded.');