'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const lib = require('../lib/daytrade-intraday-observe');

const base = 1719801000; // arbitrary session timestamp
function candle(i, overrides) {
  return Object.assign({ time: base + i * 900, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: 1000 * (i + 1) }, overrides || {});
}

test('VWAP calculation uses typical price weighted by volume', () => {
  const candles = [candle(0, { high: 12, low: 9, close: 9, volume: 100 }), candle(1, { high: 24, low: 18, close: 18, volume: 300 })];
  assert.equal(lib.calculateVwap(candles), 17.5);
});

test('opening range high/low uses first 30 minutes only', () => {
  const range = lib.openingRange([candle(0, { high: 110, low: 95 }), candle(1, { high: 108, low: 96 }), candle(2, { high: 150, low: 80 })], 30);
  assert.deepEqual(range, { high: 110, low: 95, candle_count: 2 });
});

test('above/below VWAP labels are computed from latest close', () => {
  const above = lib.observeCandidate({ ticker: 'BBCA', entry: 100 }, [candle(0, { high: 100, low: 100, close: 100, volume: 100 }), candle(1, { high: 120, low: 120, close: 120, volume: 100 })], { hit: false, stale: false });
  assert.equal(above.above_vwap, true);
  assert.equal(above.below_vwap, false);
  const below = lib.observeCandidate({ ticker: 'BBCA', entry: 100 }, [candle(0, { high: 120, low: 120, close: 120, volume: 100 }), candle(1, { high: 100, low: 100, close: 100, volume: 100 })], { hit: false, stale: false });
  assert.equal(below.above_vwap, false);
  assert.equal(below.below_vwap, true);
});

test('opening range breakout/breakdown labels compare last price to range', () => {
  const common = [candle(0, { high: 105, low: 95, close: 100 }), candle(1, { high: 104, low: 96, close: 100 })];
  assert.equal(lib.observeCandidate({ ticker: 'A' }, common.concat([candle(2, { high: 110, low: 106, close: 106 })]), {}).opening_range_breakout, true);
  assert.equal(lib.observeCandidate({ ticker: 'A' }, common.concat([candle(2, { high: 94, low: 90, close: 94 })]), {}).opening_range_breakdown, true);
});

test('distance to entry and chase risk are derived without changing entry', () => {
  assert.equal(lib.distanceToEntryPct(106, 100), 6);
  const row = lib.observeCandidate({ ticker: 'A', entry: 100 }, [candle(0, { close: 104 })], {});
  assert.equal(row.distance_to_entry_pct, 4);
  assert.equal(row.chase_risk, true);
});

test('cache schema validation requires intraday namespace fields', () => {
  const valid = { version: 1, ticker: 'BBCA', source: 'yahoo', range: '1d', interval: '15m', session_date: '2026-07-08', updated_at: new Date().toISOString(), candles: [] };
  assert.equal(lib.validateCacheSchema(valid).valid, true);
  assert.equal(lib.validateCacheSchema(Object.assign({}, valid, { interval: '1d' })).valid, false);
});

test('stale cache fallback flag is surfaced in fetchWithCache cache-only mode', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'intraday-cache-'));
  await fs.mkdir(dir, { recursive: true });
  const stale = { version: 1, ticker: 'BBCA', source: 'yahoo', range: '1d', interval: '15m', session_date: '2026-07-08', updated_at: '2020-01-01T00:00:00.000Z', candles: [candle(0)] };
  await fs.writeFile(path.join(dir, 'BBCA.json'), JSON.stringify(stale));
  const stats = { cache_hit: 0, cache_miss: 0, stale_fallback: 0, fetch_success: 0, fetch_fail: 0 };
  const res = await lib.fetchWithCache('BBCA', { cacheDir: dir, ttlMinutes: 1, noFetch: true, nowMs: Date.now() }, stats);
  assert.equal(res.cache.stale, true);
  assert.equal(stats.stale_fallback, 1);
});

test('no data quality classification handles empty candles', () => {
  assert.equal(lib.classifyDataQuality([], {}), 'NO_INTRADAY_DATA');
  assert.equal(lib.observeCandidate({ ticker: 'BBCA' }, [], {}).data_quality, 'NO_INTRADAY_DATA');
});

test('report tooling remains observe-only with no production write behavior', async () => {
  const libSource = await fs.readFile(path.join(process.cwd(), 'lib', 'daytrade-intraday-observe.js'), 'utf8');
  const toolSource = await fs.readFile(path.join(process.cwd(), 'tools', 'report-daytrade-intraday-observe.js'), 'utf8');
  const source = libSource + '\n' + toolSource;
  assert.equal(/\.insert\s*\(/.test(source), false);
  assert.equal(/\.upsert\s*\(/.test(source), false);
  assert.equal(/\.delete\s*\(/.test(source), false);
  assert.equal(/sendTelegram|telegram/i.test(source), false);
});
