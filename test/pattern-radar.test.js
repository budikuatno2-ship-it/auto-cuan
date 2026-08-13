'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const ui = require('../public/ui-stability-fix');
const visual = require('../public/pattern-visual');

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

test('the ABCD figure draws close, X-A-B-C-D, every level and the PRZ band', () => {
  const value = chartFixture();
  const svg = visual.buildPatternSvg({ ticker: value.context.ticker, candidate: value.candidate,
    classicPatterns: [], context: value.context, dataDate: value.context.dataDate,
    currentPrice: value.candidate.currentPrice }, { width: 420, height: 208 });
  // The close series, the structure polyline and the PRZ band are all present.
  assert.equal((svg.match(/<path d="M/g) || []).length >= 1, true);
  assert.match(svg, /<polyline points=/);
  assert.match(svg, /<rect [^>]*fill="#c084fc"/);
  for (const name of ['X', 'A', 'B', 'C', 'D']) assert.ok(svg.includes('>' + name + '</text>'), name);
  for (const label of ['Konfirmasi', 'Invalidasi', 'Target 1', 'Target 2', 'PRZ', 'Kini']) {
    assert.ok(svg.includes('>' + label + '</text>'), label);
  }
});

test('the figure scales with the card instead of being rendered at a fixed raster size', () => {
  const value = chartFixture();
  const row = { ticker: value.context.ticker, candidate: value.candidate, classicPatterns: [],
    context: value.context, dataDate: value.context.dataDate, currentPrice: value.candidate.currentPrice };
  const card = visual.buildPatternSvg(row, { width: 420, height: 208 });
  const full = visual.buildPatternSvg(row, { width: 1100, height: 520 });
  assert.match(card, /viewBox="0 0 420 208"/);
  assert.match(full, /viewBox="0 0 1100 520"/);
  // No width/height attribute: CSS owns the box, so the same markup is crisp at
  // any device pixel ratio without a per-viewport raster spec.
  assert.doesNotMatch(card, /<svg[^>]*\s(?:width|height)=/);
  assert.equal(ui.levelLabel('Konfirmasi', 9300), 'Konfirmasi  9.300');
  assert.equal(ui.levelLabel('Konfirmasi', null), 'Konfirmasi');
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

test('dashboard loads tab-resume guard before stable Pattern v5 and cache-busted Screener extension v6', () => {
  const loader = read('public/assets/fca-stocks.js');
  const guard = read('public/pattern-tab-resume-guard.js');
  const source = read('public/pattern-stable-runtime.js');
  new vm.Script(guard, { filename:'pattern-tab-resume-guard.js' });
  new vm.Script(source, { filename:'pattern-stable-runtime.js' });
  assert.match(loader, /\/pattern-tab-resume-guard\.js\?v=20260802-pattern-tab-resume-v2/);
  assert.match(loader, /\/pattern-stable-runtime\.js\?v=20260813-pattern-stable-v6/);
  assert.match(loader, /\/pattern-screener-extension\.js\?v=20260813-pattern-screener-v7/);
  assert.match(loader, /\/pattern-visual\.js\?v=20260813-pattern-visual-v1/);
  assert.doesNotMatch(loader, /pattern-radar\.js/);
  assert.match(source, /action=screener/);
  assert.match(source, /action=nk-screener-results/);
  assert.match(source, /action=daytrade-screener/);
  assert.match(source, /\/api\/candles\?ticker=/);
  assert.match(source, /PatternMap\.validateCandidate/);
  assert.match(source, /classicPatterns/);
  assert.match(source, /data-classic-only/);
  assert.doesNotMatch(source.replace(/^\s*\/\/.*$/gm, ''), /quickchart/i);
  assert.match(source, /Visual\.buildPatternSvg/);
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
  // The figure is part of the card, not something behind a button.
  assert.match(classicBranch, /figureHtml\(row\)/);
  // Both branches share one action row, so zoom and chart exist on every card.
  assert.match(classicBranch, /\+ actions \+/);
  assert.match(source, /data-ps-zoom/);
  assert.match(source, /data-ps-chart/);
  assert.match(source, /function figureHtml/);
  assert.match(source, /Visual\.buildPatternSvg/);
});
