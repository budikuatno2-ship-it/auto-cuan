'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function loadDrawingModule() {
  delete require.cache[require.resolve('../public/chart-drawing-tools.js')];
  return require('../public/chart-drawing-tools.js');
}

test('LWC v5.3.0 vendor bundle exposes version 5.3.0 and Native Multi-Pane primitives', () => {
  const src = read('public/vendor/lightweight-charts.standalone.production.js');
  assert.ok(Buffer.byteLength(src, 'utf8') > 180000, 'Expected LWC v5.3.0 bundle size > 180 KB');
  const ctx = {
    window: {},
    self: {},
    globalThis: {},
    document: { createElement: () => ({ style: {}, getContext: () => null }) },
    navigator: { userAgent: 'node-test' }
  };
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.globalThis = ctx;
  vm.runInNewContext(src, ctx);
  const LWC = ctx.LightweightCharts;
  assert.ok(LWC, 'LightweightCharts global must attach');
  assert.equal(LWC.version(), '5.3.0');
  assert.ok(LWC.CandlestickSeries, 'CandlestickSeries definition required');
  assert.ok(LWC.HistogramSeries, 'HistogramSeries definition required');
  assert.ok(LWC.LineSeries, 'LineSeries definition required');
  assert.equal(typeof LWC.createSeriesMarkers, 'function', 'createSeriesMarkers v5 API required');
});

test('chart-drawing-tools.js exposes 8 tools including ray, box, and gesture with IDX-guarded snap', () => {
  const DT = loadDrawingModule();
  assert.deepEqual(DT.TOOLS, ['trendline', 'hline', 'ray', 'box', 'fib', 'ruler', 'freehand', 'gesture']);

  // Right price axis & sub-pane guard
  const bounds = { width: 900, height: 620, rightAxisWidth: 64, pricePaneHeight: 420 };
  assert.equal(DT.isOutsideDataArea(400, 200, bounds), false, 'Center price area allowed');
  assert.equal(DT.isOutsideDataArea(850, 200, bounds), true, 'Right price axis area blocked');
  assert.equal(DT.isOutsideDataArea(400, 460, bounds), true, 'Lower sub-pane area blocked from Pane 0 drawing');

  // IDX BEI tick snap: BBCA (~Rp 9.450 => tick 25) and RELF (Rp 36 => tick 1)
  const bbcaCandle = { open: 9425, high: 9525, low: 9375, close: 9475 };
  const toY = (price) => 400 - ((price - 9200) / 400) * 300;
  const highY = toY(9525);
  const snappedHigh = DT.snapPriceToOhlcAndIdxTick({
    rawPrice: 9518,
    pointerY: highY + 6,
    candle: bbcaCandle,
    toY,
    magnetEnabled: true,
    shiftKey: false,
    radiusPx: 15,
    isIndex: false
  });
  assert.equal(snappedHigh.snapped, true);
  assert.equal(snappedHigh.snappedTo, 'high');
  assert.equal(snappedHigh.price, 9525);
  assert.equal(snappedHigh.tickSize, 25);

  // Shift key inverts magnet (releases OHLC magnet, still enforces IDX 25 tick)
  const shiftRelease = DT.snapPriceToOhlcAndIdxTick({
    rawPrice: 9518,
    pointerY: highY + 6,
    candle: bbcaCandle,
    toY,
    magnetEnabled: true,
    shiftKey: true,
    radiusPx: 15,
    isIndex: false
  });
  assert.equal(shiftRelease.snapped, false);
  assert.equal(shiftRelease.price, 9525); // 9518 rounded to IDX tick 25 = 9525

  const offOhlcShift = DT.snapPriceToOhlcAndIdxTick({
    rawPrice: 9411,
    pointerY: 220,
    candle: bbcaCandle,
    toY,
    magnetEnabled: true,
    shiftKey: true,
    radiusPx: 15,
    isIndex: false
  });
  assert.equal(offOhlcShift.price % 25, 0, 'BBCA shifted drawing still snaps strictly to Rp 25 tick');

  // RELF Rp 36 (<200 band => Rp 1 tick)
  const relfSnap = DT.snapPriceToOhlcAndIdxTick({
    rawPrice: 36.4,
    pointerY: 180,
    candle: { open: 35, high: 38, low: 35, close: 36 },
    toY: (p) => 300 - p * 10,
    magnetEnabled: false,
    shiftKey: false,
    isIndex: false
  });
  assert.equal(relfSnap.price, 36);
  assert.equal(relfSnap.tickSize, 1);

  // Gesture Draw & Scribble-to-Erase recognition
  const hPts = [{ x: 40, y: 150 }, { x: 120, y: 152 }, { x: 240, y: 149 }];
  assert.equal(DT.recognizeGesture(hPts).kind, 'hline');

  const tPts = [{ x: 40, y: 260 }, { x: 140, y: 190 }, { x: 240, y: 120 }];
  assert.equal(DT.recognizeGesture(tPts).kind, 'trendline');

  const boxPts = [
    { x: 60, y: 100 }, { x: 180, y: 100 }, { x: 180, y: 190 }, { x: 60, y: 190 }, { x: 62, y: 102 }
  ];
  assert.equal(DT.recognizeGesture(boxPts).kind, 'box');

  const scribble = [];
  for (let i = 0; i < 12; i++) {
    scribble.push({ x: 100 + (i % 2 === 0 ? 0 : 70), y: 120 + i * 6 });
  }
  assert.equal(DT.recognizeGesture(scribble).kind, 'erase');
});

test('chart-drawing-tools store serializes/deserializes new ray and box drawings per ticker & TF', () => {
  const DT = loadDrawingModule();
  const map = new Map();
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k)
  };
  const store = DT.createStore(storage);
  const ray = DT.createDrawing('ray', [{ logical: 10, price: 9300 }, { logical: 35, price: 9600 }]);
  const box = DT.createDrawing('box', [{ logical: 20, price: 9200 }, { logical: 40, price: 9400 }]);
  assert.ok(ray && box);
  assert.equal(store.save('bbca', '1d', [ray, box]), true);
  const loaded = store.load('BBCA', '1D');
  assert.equal(loaded.length, 2);
  assert.deepEqual(loaded.map((d) => d.type), ['ray', 'box']);
});

test('AutoCuanRightAxisGuard enforces pixel-gap fallback even before layout & 0 Mrd', () => {
  const src = read('public/market-feature-runtime.js');
  assert.match(src, /function acAttachV5Shims\(/);
  assert.match(src, /function acSetSeriesMarkers\(/);
  assert.match(src, /chart\.addSeries\(LightweightCharts\.HistogramSeries/);
  assert.match(src, /_livePanes\[_pi\]\.setHeight\(_sp\.height\)/);
  assert.match(src, /estPxGap\s*=\s*\(Math\.abs\(p - item\.price\)\s*\/\s*\(meta\.max - meta\.min\)\)\s*\*\s*meta\.paneHeight/);
  assert.match(src, /_lwc_attribution/);
  assert.match(src, /acApplyHeaderThemeColors/);
  assert.doesNotMatch(src, /getAdaptiveTickSize/);
});

test('chart-workstation DRAWER_TOOLS covers all AutoCuanChartDrawing.TOOLS & native multi-pane resize', () => {
  const DT = loadDrawingModule();
  const cwSrc = read('public/chart-workstation.js');
  for (const tool of DT.TOOLS) {
    assert.ok(cwSrc.includes("'" + tool + "'"), 'DRAWER_TOOLS must include tool ' + tool);
  }
  assert.match(cwSrc, /reg\.nativeMultiPane/);
  assert.match(cwSrc, /fullscreen_btn/);
});

test('Apache-2.0 NOTICE & landing accessibility token fixes comply with guardrails', () => {
  const notice = read('NOTICE');
  assert.match(notice, /Lightweight Charts v5\.3\.0/i);
  assert.match(notice, /Based on trawangan \(https:\/\/github\.com\/KaleksananBarqi\/trawangan\), Created by Kaleksanan Barqi Aji Massani/);
  const lpCss = read('public/landing-experience.css');
  assert.match(lpCss, /#landingPage \.text-positive\s*\{\s*color:\s*var\(--ac-positive,\s*#146E42\)/);
  assert.doesNotMatch(lpCss, /#landingPage \.text-positive[^}]*!important/);
  const dtSrc = read('public/chart-drawing-tools.js');
  assert.doesNotMatch(dtSrc, /getAdaptiveTickSize/);
  assert.doesNotMatch(dtSrc, /@luxalgo\/vela-pinets/);
});
