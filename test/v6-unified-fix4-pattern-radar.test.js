'use strict';

/**
 * FIX 4 regression: Pattern Radar canonical data, IDX ticks, and SVG renderer.
 * No network, no DB writes, no paid provider calls.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const api = require('../api/pattern-radar.js');
const tick = require('../lib/idx-tick.js');
const canonical = require('../lib/canonical-daily-history-source.js');
const visual = require('../public/pattern-visual.js');

const result = api.scanAllPatterns();

test('Pattern Radar reads the canonical snapshot, not the stale flat-file cache', () => {
  assert.equal(result.success, true);
  assert.equal(result.canonical_status, 'OK');
  assert.equal(result.as_of, '2026-11-20');
  assert.equal(result.snapshot_verified, true);
  assert.match(result.snapshot_sha256, /^c2128eb8/);
  assert.match(result.data_source, /stock_daily_history/);
  assert.ok(result.total_scanned >= 963);
  assert.ok(result.count > 0);
  const source = read('api/pattern-radar.js');
  assert.doesNotMatch(source, /pattern-radar-cache\.json/);
  assert.doesNotMatch(source, /daily-candles/);
  assert.match(source, /canonical-daily-history-source/);
});

test('BBCA uses canonical 5550 / 2026-11-20 and never the stale 9860 / 2026-11-04', () => {
  const bbca = result.patterns.find((p) => p.ticker === 'BBCA');
  assert.ok(bbca, 'BBCA pattern must be published');
  assert.equal(bbca.currentPrice, 5550);
  assert.equal(bbca.dataDate, '2026-11-20');
  assert.equal(bbca.candles.length, 100);
  assert.equal(bbca.candles[bbca.candles.length - 1].close, 5550);
  assert.equal(bbca.candles[bbca.candles.length - 1].volume, 147637100);
  // Assert on published price fields, not raw JSON: a volume such as
  // 986000000 legitimately contains the digits 9860.
  const priceFields = ['currentPrice', 'breakout', 'confirmation', 'tp1', 'tp2', 'sl', 'invalidation'];
  for (const row of result.patterns) {
    for (const field of priceFields) {
      assert.notEqual(row[field], 9860, `${row.ticker}.${field}`);
      assert.notEqual(row[field], 11031, `${row.ticker}.${field}`);
      assert.notEqual(row[field], 8981, `${row.ticker}.${field}`);
      assert.notEqual(row[field], 9391, `${row.ticker}.${field}`);
    }
    assert.notEqual(row.dataDate, '2026-11-04');
  }
});

test('every published price level sits on the official IDX tick fraction', () => {
  const fields = ['currentPrice', 'breakout', 'confirmation', 'tp1', 'tp2', 'sl', 'invalidation'];
  let checked = 0;
  for (const row of result.patterns) {
    for (const field of fields) {
      const value = row[field];
      if (value == null) continue;
      assert.equal(tick.isIdxTickValid(value), true, `${row.ticker}.${field}=${value}`);
      checked += 1;
    }
    for (const field of ['low', 'high']) {
      const value = row.prz && row.prz[field];
      if (value == null) continue;
      assert.equal(tick.isIdxTickValid(value), true, `${row.ticker}.prz.${field}=${value}`);
      checked += 1;
    }
  }
  assert.ok(checked > 1000);
});

test('canonical source is strictly read-only and reports real freshness metadata', () => {
  const meta = canonical.getCanonicalDailyHistoryMeta();
  assert.equal(meta.status, 'OK');
  assert.equal(meta.max_date, '2026-11-20');
  assert.equal(meta.verified, true);
  assert.ok(meta.rows > 200000);
  assert.ok(meta.tickers >= 963);
  const source = read('lib/canonical-daily-history-source.js');
  assert.match(source, /readOnly: true, fileMustExist: true/);
  assert.doesNotMatch(source, /writeFileSync|\.exec\(|fetch\(/);
  const candles = canonical.getCanonicalCandles('BBCA', 1);
  assert.deepEqual(candles, [{
    time: '2026-11-20', open: 5600, high: 5675, low: 5525,
    close: 5550, volume: 147637100
  }]);
});

test('the renderer draws an inline SVG from canonical candles and emits no empty-box message', () => {
  const bbca = result.patterns.find((p) => p.ticker === 'BBCA');
  const row = {
    ticker: bbca.ticker,
    candidate: {
      name: bbca.pattern, status: bbca.status, confirmation: bbca.confirmation,
      tp1: bbca.tp1, tp2: bbca.tp2, invalidation: bbca.invalidation,
      currentPrice: bbca.currentPrice, prz: bbca.prz
    },
    classicPatterns: [{ label: bbca.pattern, bias: bbca.bias, confidence: bbca.confidence / 100 }],
    context: { ticker: bbca.ticker, timeframe: '1D', dataDate: bbca.dataDate, candles: bbca.candles },
    dataDate: bbca.dataDate,
    currentPrice: bbca.currentPrice
  };
  const svg = visual.buildPatternSvg(row, { width: 420, height: 208 });
  assert.match(svg, /^<svg /);
  // SMC formations have no XABCD polyline; the real close path and the
  // confirmation/invalidation level lines must still be drawn.
  assert.match(svg, /<path d="M[\d.]+ [\d.]+L/);
  assert.match(svg, /stroke-dasharray="4 3"/);
  assert.match(svg, /viewBox="0 0 420 208"/);
  for (const label of ['Konfirmasi', 'Invalidasi', 'Target 1', 'Target 2', 'PRZ', 'Kini']) {
    assert.ok(svg.includes('>' + label + '</text>'), label);
  }
  const runtime = read('public/pattern-stable-runtime.js');
  new vm.Script(runtime, { filename: 'pattern-stable-runtime.js' });
  assert.doesNotMatch(runtime, /Bentuk pola belum bisa digambar/);
  assert.match(runtime, /candles: p\.candles \|\| \[\]/);
  assert.match(runtime, /Visual\.buildPatternSvg\(row/);
});

test('the multi-card list renders every canonical pattern row', () => {
  const runtime = read('public/pattern-stable-runtime.js');
  assert.match(runtime, /state\.rows = radarData\.patterns\.map\(function\(p\)/);
  assert.match(runtime, /displayRows\.map\(card\)\.join\(''\)/);
  assert.match(runtime, /data-classic-only/);
  assert.equal(result.patterns.length, result.count);
  assert.equal(new Set(result.patterns.map((p) => p.ticker)).size, result.count);
});
