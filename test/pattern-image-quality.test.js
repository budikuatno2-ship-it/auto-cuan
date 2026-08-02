'use strict';

// ===========================================================================
// Tests for the generated Pattern PNG.
//
// The old request was fixed at 1200x700 with devicePixelRatio 1. Two problems:
//   - a phone scales that canvas down by ~3.4x, so 10px axis labels land at
//     under 3 effective pixels and the image is unreadable;
//   - devicePixelRatio 1 is soft on every retina screen, phone or laptop.
//
// The fix picks the LOGICAL canvas from the viewport (narrower on phones, so
// type stays legible after downscaling) and pins the output bitmap at 2x.
//
// LOCAL / STATIC + MOCKED ONLY. No network call is made; the QuickChart
// integration test remains separately opt-in behind RUN_QUICKCHART_INTEGRATION.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const PatternMap = require('../public/pattern-map');
const Ui = require('../public/ui-stability-fix');

// ---------------------------------------------------------------------------
// 1. Resolution spec
// ---------------------------------------------------------------------------
test('every viewport renders the PNG at retina scale', () => {
  [320, 390, 430, 768, 1024, 1440, 2560].forEach(width => {
    assert.equal(PatternMap.patternImageSpec(width).devicePixelRatio, 2, 'width ' + width);
  });
});

test('phones get a narrower logical canvas so labels survive downscaling', () => {
  const phone = PatternMap.patternImageSpec(390);
  const desktop = PatternMap.patternImageSpec(1440);
  assert.equal(phone.narrow, true);
  assert.equal(desktop.narrow, false);
  assert.ok(phone.width < desktop.width);
  // A 390px viewport shows the image at roughly 356 CSS px. Keeping the logical
  // canvas near that width keeps the downscale factor under ~2x.
  assert.ok(phone.width / 356 < 2, 'phone downscale factor must stay small');
});

test('the spec is bounded and never degenerate', () => {
  [undefined, null, 0, -50, NaN, 'wide'].forEach(input => {
    const spec = PatternMap.patternImageSpec(input);
    assert.equal(spec.width, 1200, String(input));
    assert.equal(spec.height, 700);
  });
  [320, 640, 1024, 4000].forEach(width => {
    const spec = PatternMap.patternImageSpec(width);
    assert.ok(spec.width >= 600 && spec.width <= 1200);
    assert.ok(spec.height >= 480 && spec.height <= 700);
    assert.ok(spec.width * spec.devicePixelRatio <= 2400, 'bitmap stays bounded for mobile data');
  });
});

test('a tablet sits between the phone and desktop canvases', () => {
  const tablet = PatternMap.patternImageSpec(800);
  assert.ok(tablet.width > PatternMap.patternImageSpec(390).width);
  assert.ok(tablet.width < PatternMap.patternImageSpec(1440).width);
});

// ---------------------------------------------------------------------------
// 2. Annotation legibility
// ---------------------------------------------------------------------------
test('level lines carry their price so the legend is self-describing', () => {
  assert.equal(Ui.levelLabel('TP1', 9500), 'TP1  9.500');
  assert.equal(PatternMap.levelLabel('TP1', 9500), 'TP1  9,500');
  ['', null, undefined, 'abc'].forEach(value => {
    assert.equal(Ui.levelLabel('TP1', value), 'TP1', String(value));
    assert.equal(PatternMap.levelLabel('TP1', value), 'TP1', String(value));
  });
  assert.equal(Ui.formatPrice(null), null);
  assert.equal(Ui.formatPrice(9075), '9.075');
});

test('type never drops below a readable floor on any variant', () => {
  ['narrow', 'wide'].forEach(variant => {
    const look = Ui.chartPresentation({ narrow: variant === 'narrow' });
    assert.ok(look.tick >= 12, variant + ' ticks');
    assert.ok(look.legend >= 11, variant + ' legend');
    assert.ok(look.title >= 16, variant + ' title');
    assert.ok(look.point >= 5, variant + ' pivot markers');
  });
});

test('the narrow variant thins x ticks rather than shrinking them', () => {
  const narrow = Ui.chartPresentation({ narrow: true });
  const wide = Ui.chartPresentation({ narrow: false });
  assert.ok(narrow.maxTicks < wide.maxTicks);
  assert.ok(narrow.tick >= 12);
});

test('the candlestick config scales with the same spec', () => {
  const candles = [20, 21, 22, 23, 24, 25, 26].map((day, index) => ({
    time: `2026-07-${day}`, open: 9000 + index * 25, high: 9150 + index * 25,
    low: 8900 + index * 25, close: 9050 + index * 25
  }));
  const point = (index, priceField) => ({
    time: candles[index].time, value: candles[index][priceField], candleIndex: index, priceField
  });
  const candidate = {
    id: 'image-quality-fixture', ruleVersion: 'audit-v1', name: 'Trusted ABCD', status: 'confirmed',
    provenance: 'test:pattern-image-quality', ticker: 'BBCA', timeframe: '1D', dataDate: '2026-07-26', candles,
    points: { X: point(0, 'low'), A: point(1, 'high'), B: point(2, 'low'), C: point(3, 'high'), D: point(4, 'low') },
    prz: { low: 9075, high: 9150 }, confirmation: 9300, invalidation: 9000, tp1: 9500, tp2: 9700,
    currentPrice: candles.at(-1).close, confirmationEvidence: { type: 'daily-close', date: '2026-07-26' }
  };
  const context = { ticker: 'BBCA', timeframe: '1D', dataDate: '2026-07-26', candles: JSON.parse(JSON.stringify(candles)) };

  const narrow = PatternMap.buildQuickChartConfig(candidate, context, PatternMap.patternImageSpec(390));
  const wide = PatternMap.buildQuickChartConfig(candidate, context, PatternMap.patternImageSpec(1440));
  assert.ok(narrow.options.scales.x.ticks.maxTicksLimit < wide.options.scales.x.ticks.maxTicksLimit);
  assert.ok(narrow.options.scales.y.ticks.font.size >= 12);
  assert.ok(wide.options.plugins.title.font.size >= narrow.options.plugins.title.font.size);
  assert.ok(narrow.data.datasets.some(dataset => String(dataset.label).startsWith('TP1  ')));
});

// ---------------------------------------------------------------------------
// 3. Wiring in the Pattern Radar page
// ---------------------------------------------------------------------------
test('Pattern Radar requests the viewport-aware spec and no longer pins DPR 1', () => {
  const source = read('public/pattern-stable-runtime.js');
  assert.match(source, /PatternMap\.patternImageSpec\(root\.innerWidth\)/);
  assert.match(source, /width:spec\.width, height:spec\.height, devicePixelRatio:spec\.devicePixelRatio/);
  assert.doesNotMatch(source, /devicePixelRatio:\s*1\b/);
  // The only remaining literal size is the defensive fallback for a stale
  // cached pattern-map.js, and it is still retina scale.
  assert.match(source, /\{ width:1200, height:700, devicePixelRatio:2, narrow:false \}/);
  assert.equal((source.match(/width:\s*1200/g) || []).length, 1);
});

test('the rendered image reserves its aspect ratio and can be saved at full resolution', () => {
  const source = read('public/pattern-stable-runtime.js');
  // Intrinsic width/height from the spec means no layout shift while decoding.
  assert.match(source, /width="' \+ spec\.width \+ '" height="' \+ spec\.height \+ '"/);
  assert.match(source, /decoding="async"/);
  // The download href is the already-fetched blob URL, so the saved PNG keeps
  // the full 2x bitmap rather than the downscaled on-screen copy.
  assert.match(source, /function mapTools\(ticker, url\)/);
  assert.match(source, /download="' \+ esc\(saveName\(ticker\)\) \+ '"/);
  assert.match(source, /-WIB\.png/);
});

test('a cached image is discarded when the viewport class changes', () => {
  const source = read('public/pattern-stable-runtime.js');
  assert.match(source, /cached\.spec\.width === spec\.width/);
  assert.match(source, /revokeObjectURL\(cached\.url\)/);
  assert.match(source, /revokeObjectURL\(state\.urls\[key\]\.url\)/);
});

test('the Chart-page Pattern preview uses the same spec for its <img>', () => {
  const html = read('public/index.html');
  assert.match(html, /_patternMapManager\.render\(candidate, renderContext, \{ viewportWidth: window\.innerWidth \}\)/);
  assert.match(html, /var spec = result\.spec \|\| \{ width: 1200, height: 700 \}/);
});

// The old frame combined min-height:250px, overflow:hidden and a 700px
// max-height with object-fit:contain, which letterboxed and cropped the image
// on a phone. The new frame lets it size to its own aspect ratio.
test('the Pattern image frame can no longer crop the generated chart', () => {
  const source = read('public/pattern-stable-runtime.js');
  assert.match(source, /\.ps-map\{[^']*overflow:auto/);
  assert.doesNotMatch(source, /\.ps-map\{[^']*overflow:hidden/);
  assert.doesNotMatch(source, /\.ps-map img\{[^']*max-height/);
  assert.match(source, /\.ps-map img\{[^']*width:100%;height:auto/);
});
