'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const radar = require('../public/pattern-radar');

test('collectTickers deduplicates screener payloads and preserves source order', () => {
  const tickers = radar.collectTickers([
    { results: [{ ticker: 'bbca' }, { ticker: 'BBRI.JK' }, { ticker: 'invalid-1' }] },
    { rows: [{ symbol: 'BBCA' }, { code: 'TLKM' }] }
  ], 3, []);
  assert.deepEqual(tickers, ['BBCA', 'BBRI', 'TLKM']);
});

test('patternRowFromResponse only accepts a validated candidate', () => {
  const data = {
    success: true,
    ticker: 'BBCA',
    actual_data_date: '2026-07-27',
    candles: [{ time: '2026-07-27', open: 1, high: 2, low: 1, close: 2 }],
    patternMap: { ticker: 'BBCA', dataDate: '2026-07-27', status: 'candidate' }
  };
  assert.equal(radar.patternRowFromResponse(data, () => ({ valid: false })), null);
  const row = radar.patternRowFromResponse(data, () => ({ valid: true }));
  assert.equal(row.ticker, 'BBCA');
  assert.equal(row.dataDate, '2026-07-27');
});

test('sortPatternRows prioritizes confirmed patterns then newest date', () => {
  const rows = radar.sortPatternRows([
    { ticker: 'BBRI', dataDate: '2026-07-27', candidate: { status: 'candidate' } },
    { ticker: 'TLKM', dataDate: '2026-07-25', candidate: { status: 'confirmed' } },
    { ticker: 'BBCA', dataDate: '2026-07-26', candidate: { status: 'confirmed' } }
  ]);
  assert.deepEqual(rows.map(row => row.ticker), ['BBCA', 'TLKM', 'BBRI']);
});

test('mapBounded respects the concurrency ceiling', async () => {
  let active = 0;
  let peak = 0;
  const results = await radar.mapBounded([1, 2, 3, 4, 5, 6], 2, async value => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.equal(peak, 2);
  assert.deepEqual(results, [2, 4, 6, 8, 10, 12]);
});

test('browser source separates Pattern from manual Chart and keeps rendering lazy', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'pattern-radar.js'), 'utf8');
  assert.match(source, /#patternChartTab,#patternPageContainer\{display:none!important\}/);
  assert.match(source, /Tidak ada pencarian ticker manual/);
  assert.doesNotMatch(source, /<input[^>]+pattern/i);
  assert.match(source, /action=screener/);
  assert.match(source, /action=nk-screener-results/);
  assert.match(source, /action=daytrade-screener/);
  assert.match(source, /\/api\/candles\?ticker=/);
  assert.match(source, /data-pattern-render/);
  assert.match(source, /manager\.render\(row\.candidate, row\.context\)/);
});

test('deferred loader and exact-expiry watcher are installed without a new API endpoint', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', 'fca-stocks.js'), 'utf8');
  assert.match(source, /\/pattern-radar\.js\?v=20260728-radar2/);
  assert.match(source, /data-pattern-radar-loader/);
  assert.match(source, /watchPatternRadarAccess/);
  assert.match(source, /gate\.isAllowed\(\)/);
  assert.match(source, /window\.navigateTo\('chart'\)/);
});
