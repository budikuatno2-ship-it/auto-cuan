'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const ui = require('../public/ui-stability-fix');

function tickerAt(index) {
  const chars = [];
  let value = index;
  for (let i = 0; i < 4; i += 1) {
    chars.unshift(String.fromCharCode(65 + (value % 26)));
    value = Math.floor(value / 26);
  }
  return chars.join('');
}

function chartFixture() {
  const candles = Array.from({ length: 10 }, (_, index) => ({
    time: `2026-07-${String(index + 10).padStart(2, '0')}`,
    open: 100 + index,
    high: 104 + index,
    low: 98 + index,
    close: 102 + index
  }));
  const points = {};
  ['X', 'A', 'B', 'C', 'D'].forEach((name, index) => {
    const candleIndex = index * 2;
    points[name] = { candleIndex, value: candles[candleIndex].close };
  });
  return {
    candidate: {
      name: 'Bullish ABCD', points, confirmation: 114, invalidation: 99,
      tp1: 118, tp2: 122, currentPrice: 111, prz: { low: 106, high: 108 }
    },
    context: { ticker: 'BBCA', dataDate: '2026-07-19', candles }
  };
}

test('collectTickers deduplicates every screener source without a fallback or fixed cap', () => {
  const rows = Array.from({ length: 75 }, (_, index) => ({ ticker: tickerAt(index) }));
  const tickers = ui.collectTickers([
    { results: rows.slice(0, 40) },
    { radar_candidates: rows.slice(35) },
    { data: [{ ticker: rows[0].ticker + '.JK' }, { ticker: 'invalid-1' }] }
  ]);
  assert.equal(tickers.length, 75);
  assert.deepEqual(tickers.slice(0, 3), rows.slice(0, 3).map(row => row.ticker));
  assert.equal(new Set(tickers).size, 75);
  assert.equal(ui.constants.SCAN_CONCURRENCY, 4);
});

test('reliable ABCD map uses a regular line chart with close, XABCD, levels, and PRZ', () => {
  const value = chartFixture();
  const config = ui.buildReliableChartConfig(value.candidate, value.context);
  assert.equal(config.type, 'line');
  assert.equal(config.data.labels.length, value.context.candles.length);
  for (const label of ['Harga penutupan', 'X-A-B-C-D', 'Konfirmasi', 'Invalidasi', 'TP1', 'TP2', 'Harga terakhir', 'PRZ atas', 'PRZ bawah']) {
    assert.ok(config.data.datasets.some(dataset => dataset.label === label), label);
  }
  assert.ok(config.data.datasets.every(dataset => dataset.type !== 'candlestick'));
  assert.equal(config.options.scales.x.type, 'category');
});

test('visible artifact cleanup removes standalone typo punctuation without altering normal prose', () => {
  const source = 'Ringkasan risiko\n;\nData masih terbatas; keputusan tetap manual.\n---\nSelesai.';
  assert.equal(ui.cleanVisibleArtifacts(source), 'Ringkasan risiko\nData masih terbatas; keputusan tetap manual.\nSelesai.');
  assert.equal(ui.cleanVisibleArtifacts('A; B'), 'A; B');
});

test('mapBounded keeps Pattern scanning at the concurrency ceiling', async () => {
  let active = 0;
  let peak = 0;
  const result = await ui.mapBounded([1, 2, 3, 4, 5, 6, 7], 4, async value => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.equal(peak, 4);
  assert.deepEqual(result, [2, 4, 6, 8, 10, 12, 14]);
});

test('dashboard loads tab-resume guard before stable Pattern v3 and Screener extension v6', () => {
  const loader = read('public/assets/fca-stocks.js');
  const guard = read('public/pattern-tab-resume-guard.js');
  const source = read('public/pattern-stable-runtime.js');
  new vm.Script(guard, { filename:'pattern-tab-resume-guard.js' });
  new vm.Script(source, { filename:'pattern-stable-runtime.js' });
  assert.match(loader, /\/pattern-tab-resume-guard\.js\?v=20260729-pattern-tab-resume-v1/);
  assert.match(loader, /\/pattern-stable-runtime\.js\?v=20260728-pattern-stable-v3/);
  assert.match(loader, /\/pattern-screener-extension\.js\?v=20260729-pattern-screener-v6/);
  assert.ok(loader.indexOf('/pattern-tab-resume-guard.js') < loader.indexOf('/pattern-stable-runtime.js'));
  assert.doesNotMatch(loader, /pattern-radar\.js/);
  assert.match(source, /action=screener/);
  assert.match(source, /action=nk-screener-results/);
  assert.match(source, /action=daytrade-screener/);
  assert.match(source, /\/api\/candles\?ticker=/);
  assert.match(source, /PatternMap\.validateCandidate/);
  assert.match(source, /classicPatterns/);
  assert.match(source, /data-classic-only/);
  assert.match(source, /https:\/\/quickchart\.io\/chart/);
  assert.match(source, /data-ps-map/);
  assert.match(source, /root\.location\.pathname === '\/pattern'/);
  assert.doesNotMatch(source, /MAX_SCAN|FALLBACK_TICKERS|candlestick/);
});

test('Pattern results survive page re-entry and scanning no longer redraws every ticker result', () => {
  const source = read('public/pattern-stable-runtime.js');
  assert.match(source, /sessionStorage\.setItem\(cacheKey\(\)/);
  assert.match(source, /sessionStorage\.getItem\(cacheKey\(\)/);
  assert.match(source, /dateKey:jakartaDateKey\(\)/);
  assert.match(source, /if \(!hydrateCache\(\)\) scan\(false\)/);
  assert.match(source, /state\.rows = results\.filter\(Boolean\)/);
  assert.match(source, /persistCache\(\)/);
  assert.doesNotMatch(source, /state\.rows\.push\(row\);\s*render\(\)/);
});

test('every classic-only Pattern card can render an inline visual instead of a setup-only card', () => {
  const source = read('public/pattern-stable-runtime.js');
  const classicStart = source.indexOf("if (!c) {");
  const abcdStart = source.indexOf("return '<article class=\"ps-card ' + direction", classicStart + 20);
  const classicBranch = source.slice(classicStart, abcdStart);
  assert.match(classicBranch, /data-classic-only/);
  assert.match(classicBranch, /data-ps-map/);
  assert.match(classicBranch, /Lihat Pola/);
  assert.match(classicBranch, /data-ps-chart/);
  assert.match(source, /function buildClassicConfig/);
  assert.match(source, /Titik pembentuk pola/);
});
