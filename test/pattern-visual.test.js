'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const visual = require('../public/pattern-visual');
const { detectAbcdPattern } = require('../lib/pattern-abcd');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

// A candle series carrying one exact bullish ABCD, built from the engine's own
// published ratio bounds so the fixture cannot drift away from the rules.
function bullishAbcdCandles() {
  const A = 1200, B = 1000;
  const ab = A - B;
  const C = B + ab * 0.70;
  const D = C - ab * 1.00;
  const pivots = [
    { index: 40, value: 880, type: 'low' },
    { index: 80, value: A, type: 'high' },
    { index: 120, value: B, type: 'low' },
    { index: 160, value: C, type: 'high' },
    { index: 220, value: D, type: 'low' }
  ];
  const n = 240;
  const path = new Array(n).fill(null);
  path[0] = 1000;
  pivots.forEach(p => { path[p.index] = p.value; });
  path[n - 1] = D + 120;
  let prev = 0;
  for (let i = 1; i < n; i += 1) {
    if (path[i] == null) continue;
    const span = i - prev;
    for (let k = 1; k < span; k += 1) path[prev + k] = path[prev] + (path[i] - path[prev]) * (k / span);
    prev = i;
  }
  const highs = new Set(pivots.filter(p => p.type === 'high').map(p => p.index));
  const lows = new Set(pivots.filter(p => p.type === 'low').map(p => p.index));
  const out = [];
  let prevClose = path[0];
  for (let i = 0; i < n; i += 1) {
    const open = prevClose;
    const close = path[i];
    let high = Math.max(open, close);
    let low = Math.min(open, close);
    high = Math.round(high + (highs.has(i) ? Math.max(2, high * 0.004) : 1));
    low = Math.round(low - (lows.has(i) ? Math.max(2, low * 0.004) : 1));
    out.push({
      time: new Date(Date.UTC(2025, 0, 6) + i * 86400000).toISOString().slice(0, 10),
      open: Math.round(open), high, low: Math.max(1, low), close: Math.round(close), volume: 1000000
    });
    prevClose = Math.round(close);
  }
  return out;
}

function bullishRow() {
  const candles = bullishAbcdCandles();
  const dataDate = candles[candles.length - 1].time;
  const detected = detectAbcdPattern(candles, { ticker: 'BBCA', dataDate });
  assert.equal(detected.reason, 'found', 'fixture must produce a real ABCD candidate');
  return {
    ticker: 'BBCA',
    candidate: detected.candidate,
    classicPatterns: [],
    context: { ticker: 'BBCA', timeframe: '1D', dataDate, candles },
    dataDate,
    currentPrice: candles[candles.length - 1].close
  };
}

test('the pattern figure is produced locally, with no network reference of any kind', () => {
  // Comments are stripped first: the module documents the third-party service it
  // replaced, and that explanation must not trip its own guard.
  const source = read('public/pattern-visual.js').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(source, /fetch\(|XMLHttpRequest|quickchart|https?:\/\/(?!www\.w3\.org)/i);

  const svg = visual.buildPatternSvg(bullishRow(), { width: 420, height: 208 });
  assert.match(svg, /^<svg /);
  assert.match(svg, /<\/svg>$/);
  assert.doesNotMatch(svg, /https?:\/\/(?!www\.w3\.org)/);
});

test('the figure marks every ABCD point, each named level, and where price is now', () => {
  const svg = visual.buildPatternSvg(bullishRow(), { width: 420, height: 208 });
  ['X', 'A', 'B', 'C', 'D'].forEach(name => {
    assert.match(svg, new RegExp('>' + name + '</text>'), 'missing structure point ' + name);
  });
  ['Konfirmasi', 'Invalidasi', 'Target 1', 'Target 2', 'PRZ', 'Kini'].forEach(label => {
    assert.ok(svg.includes('>' + label + '</text>'), 'missing gutter label ' + label);
  });
  assert.match(svg, /<polyline points="[^"]+"/);
  assert.match(svg, /role="img"/);
  assert.match(svg, /aria-label="[^"]+"/);
  assert.match(svg, /<title>/);
});

test('the direction of the pattern decides the confirmation wording', () => {
  const row = bullishRow();
  const bullish = visual.buildPatternSvg(row, { width: 420, height: 208 });
  assert.ok(bullish.includes('>Konfirmasi</text>'));
  assert.ok(!bullish.includes('>Konfirmasi turun</text>'));

  const bearish = visual.buildPatternSvg(
    Object.assign({}, row, { candidate: Object.assign({}, row.candidate, { name: 'Bearish ABCD' }) }),
    { width: 420, height: 208 }
  );
  assert.ok(bearish.includes('>Konfirmasi turun</text>'));
});

test('too little data draws nothing rather than an empty or invented chart', () => {
  assert.equal(visual.buildPatternSvg(null, {}), '');
  assert.equal(visual.buildPatternSvg({ ticker: 'AAAA', context: { candles: [] } }, {}), '');
  const short = { ticker: 'AAAA', context: { candles: bullishAbcdCandles().slice(0, 4) } };
  assert.equal(visual.buildPatternSvg(short, {}), '');
});

test('overlapping level labels are separated instead of stacked on one another', () => {
  const placed = visual.__test.placeGutterLabels([
    { y: 50, text: 'a', priority: 1 },
    { y: 51, text: 'b', priority: 1 },
    { y: 52, text: 'c', priority: 1 }
  ], 10, 200);
  assert.equal(placed.length, 3);
  for (let i = 1; i < placed.length; i += 1) {
    assert.ok(placed[i].y - placed[i - 1].y >= 10, 'labels must not overlap');
  }
});

test('a label pushed past the bottom of the plot is dropped, never drawn over the axis', () => {
  const placed = visual.__test.placeGutterLabels([
    { y: 190, text: 'a', priority: 1 },
    { y: 191, text: 'b', priority: 1 },
    { y: 192, text: 'c', priority: 1 }
  ], 10, 200);
  assert.ok(placed.length < 3, 'labels that no longer fit must be dropped');
  placed.forEach(label => assert.ok(label.y <= 200));
});

test('prices keep the precision they actually carry and no more', () => {
  assert.equal(visual.priceText(1060), '1.060');
  assert.equal(visual.priceText(933.21), '933,21');
  assert.equal(visual.priceText(1015.8437), '1.015,84');
  // Missing must never render as a real number — least of all as zero.
  assert.equal(visual.priceText(null), '—');
  assert.equal(visual.priceText(undefined), '—');
  assert.equal(visual.priceText(''), '—');
  assert.equal(visual.priceText('nope'), '—');
  assert.equal(visual.priceText(0), '0');
});

test('a double top outline includes the trough between both peaks', () => {
  const series = [];
  const shape = [100, 104, 112, 126, 118, 108, 100, 96, 104, 116, 128, 120, 110, 102, 98];
  shape.forEach((close, i) => series.push({ time: 't' + i, close, high: close + 2, low: close - 2 }));
  const points = visual.__test.classicPoints(series, 'DOUBLE_TOP');
  assert.ok(points.length >= 3, 'expected peak, trough, peak');
  assert.ok(points[1].value < points[0].value && points[1].value < points[2].value, 'middle point must be the trough');
});

// Moved here from the retired pattern-image-quality suite: the price-annotated
// level label is still what makes a drawn level self-describing.
test('a level label carries its price, and drops the number when there is none', () => {
  const PatternMap = require('../public/pattern-map');
  const Ui = require('../public/ui-stability-fix');
  assert.equal(Ui.levelLabel('TP1', 9500), 'TP1  9.500');
  assert.equal(PatternMap.levelLabel('TP1', 9500), 'TP1  9,500');
  ['', null, undefined, 'abc'].forEach(value => {
    assert.equal(Ui.levelLabel('TP1', value), 'TP1', String(value));
    assert.equal(PatternMap.levelLabel('TP1', value), 'TP1', String(value));
  });
  assert.equal(Ui.formatPrice(null), null);
  assert.equal(Ui.formatPrice(9075), '9.075');
});
