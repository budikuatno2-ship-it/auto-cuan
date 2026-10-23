'use strict';

// HANDOFF 5a "Kursor" and "Navigasi": info box near the cursor that switches
// side near the edge, legend and box written once per frame, wheel zoom only
// with Ctrl/Cmd (or in "Satu layar"), touch gestures, year on the date axis,
// default range per chart mode.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const runtime = read('public/market-feature-runtime.js');
function extract(signature) {
  const start = runtime.indexOf(signature);
  assert.ok(start >= 0, signature);
  let depth = 0;
  for (let j = runtime.indexOf('{', start); j < runtime.length; j++) {
    if (runtime[j] === '{') depth++;
    else if (runtime[j] === '}') { depth--; if (depth === 0) return runtime.slice(start, j + 1); }
  }
  throw new Error('unbalanced ' + signature);
}
const NAMES = ['acTimeParts', 'acTickMark', 'acCrosshairDate', 'acDefaultBars', 'acCandleIndex', 'acDateIndex', 'acAttachCursorBox', 'acAttachWheelZoom'];
function helpers(extra) {
  const src = ["var AC_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];"]
    .concat(NAMES.map((n) => extract('function ' + n + '('))).join('\n');
  const sb = Object.assign({ Math, Number, String, Object, Date }, extra || {});
  vm.createContext(sb);
  vm.runInContext(src + '\n' + NAMES.map((n) => 'this.' + n + '=' + n + ';').join(''), sb);
  return sb;
}
const candles = Array.from({ length: 30 }, (_, i) => {
  const d = new Date(Date.UTC(2025, 11, 10) + i * 86400000).toISOString().slice(0, 10);
  return { time: d, open: 1000 + i, high: 1010 + i, low: 990 + i, close: 1000 + i * 5, volume: i ? 1e6 * i : 0 };
});

test('date axis shows the year where it changes; crosshair date carries the year', () => {
  const h = helpers();
  assert.equal(h.acTickMark({ year: 2026, month: 1, day: 2 }, 0), "Jan '26");
  assert.equal(h.acTickMark('2026-05-04', 1), 'Mei');
  assert.equal(h.acTickMark(Date.UTC(2026, 9, 16) / 1000, 2), '16');
  assert.equal(h.acCrosshairDate('2026-10-16'), "16 Okt '26");
  assert.match(runtime, /timeScale: \{ borderColor: _th\.border, timeVisible: false, tickMarkFormatter: acTickMark \}/);
  assert.match(runtime, /localization: \{ locale: 'id-ID', timeFormatter: acCrosshairDate,/);
});

test('default range per mode: Scalping 3 months, Investor 1 year, others 6 months', () => {
  const h = helpers();
  assert.equal(h.acDefaultBars('scalping', false), 63);
  assert.equal(h.acDefaultBars('investor', false), 250);
  assert.equal(h.acDefaultBars('swing', false), 126);
  assert.equal(h.acDefaultBars('simpel', false), 126);
  assert.equal(h.acDefaultBars('pro', false), 126);
  assert.equal(h.acDefaultBars('scalping', true), 13);
  assert.equal(h.acDefaultBars('investor', true), 52);
  assert.equal(h.acDefaultBars('swing', true), 26);
  assert.match(runtime, /var _bars = acDefaultBars\(wsState && wsState\.activePreset, _span > 3\);/);
});

test('candle under the cursor by logical index, falling back to the date', () => {
  const h = helpers();
  const byDate = h.acDateIndex(candles);
  assert.equal(h.acCandleIndex(candles, { time: candles[7].time, logical: 7.2 }, byDate), 7);
  assert.equal(h.acCandleIndex(candles, { time: { year: 2025, month: 12, day: 15 }, logical: 99 }, byDate), 5);
  assert.equal(h.acCandleIndex(candles, { time: null }, byDate), -1);
  assert.equal(h.acCandleIndex(candles, {}, byDate), -1);
});

function cursorRig(paneW) {
  const made = [];
  let cb = null, frames = 0;
  const doc = { createElement: () => { const el = { style: {}, setAttribute() {}, innerHTML: '' }; made.push(el); return el; } };
  const h = helpers({ document: doc, requestAnimationFrame: (f) => { frames++; f(); return 0; }, setTimeout });
  const chart = { paneSize: () => ({ width: paneW, height: 380 }), subscribeCrosshairMove: (f) => { cb = f; } };
  const container = { clientWidth: paneW, clientHeight: 400, appendChild() {} };
  const fmt = (v) => Number(v).toLocaleString('id-ID');
  h.acAttachCursorBox(chart, candles, container, fmt, (v) => fmt(v) + ' lbr', h.acDateIndex(candles));
  return { box: made[0], move: (p) => cb(p), frames: () => frames };
}

test('info box: rows, colours, side switch near the right edge, hide on leave', () => {
  const r = cursorRig(800);
  r.move({ time: candles[10].time, logical: 10, point: { x: 100, y: 50 } });
  assert.equal(r.box.style.display, 'grid');
  assert.match(r.box.innerHTML, /20 Des 2025/);
  ['Buka', 'Tertinggi', 'Terendah', 'Tutup', 'Perubahan', 'Volume'].forEach((k) => assert.match(r.box.innerHTML, new RegExp('<span>' + k + '</span>')));
  assert.match(r.box.innerHTML, /\+0,48%/);
  assert.match(r.box.innerHTML, /var\(--ac-pos/);
  assert.match(r.box.style.transform, /translate3d\(116px,64px,0\)/);
  r.move({ time: candles[25].time, logical: 25, point: { x: 760, y: 50 } });
  assert.match(r.box.style.transform, /translate3d\(566px,/, 'box flips to the left of the cursor');
  r.move({ time: candles[0].time, logical: 0, point: { x: 10, y: 50 } });
  assert.match(r.box.innerHTML, /<span>Perubahan<\/span><b[^>]*>—<\/b>/, 'first bar: no change invented');
  assert.match(r.box.innerHTML, /<span>Volume<\/span><b[^>]*>—<\/b>/, 'zero volume shows a dash');
  r.move({ time: undefined, point: undefined });
  assert.equal(r.box.style.display, 'none');
});

test('info box narrows on phones and only rewrites when the bar changes', () => {
  const r = cursorRig(360);
  r.move({ time: candles[3].time, logical: 3, point: { x: 40, y: 40 } });
  assert.equal(r.box.style.width, '150px');
  const html = r.box.innerHTML;
  r.box.innerHTML = 'marker';
  r.move({ time: candles[3].time, logical: 3, point: { x: 44, y: 41 } });
  assert.equal(r.box.innerHTML, 'marker', 'same bar: contents untouched, only moved');
  assert.ok(html.length > 50);
  assert.ok(!/getBoundingClientRect|offsetWidth|offsetHeight/.test(extract('function acAttachCursorBox(')), 'no layout reads while the cursor moves');
});

test('wheel zooms only with Ctrl/Cmd or in "Satu layar"; plain wheel scrolls the page', () => {
  let handler = null, set = null, oneScreen = false;
  const doc = { documentElement: { classList: { contains: () => oneScreen } } };
  const h = helpers({ document: doc, window: { addEventListener() {} } });
  const chart = { timeScale: () => ({ getVisibleLogicalRange: () => ({ from: 100, to: 200 }), coordinateToLogical: () => 150, setVisibleLogicalRange: (r) => { set = r; } }) };
  const container = { addEventListener: (t, f) => { if (t === 'wheel') handler = f; }, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  h.acAttachWheelZoom(chart, container);
  let prevented = false;
  const ev = (o) => Object.assign({ deltaY: -100, deltaMode: 0, clientX: 300, preventDefault: () => { prevented = true; } }, o);
  handler(ev({}));
  assert.equal(set, null); assert.equal(prevented, false);
  handler(ev({ ctrlKey: true }));
  assert.ok(prevented);
  assert.ok(set.to - set.from < 100, 'zoomed in');
  assert.ok(Math.abs((150 - set.from) / (set.to - set.from) - 0.5) < 1e-9, 'bar under the cursor stays put');
  set = null; prevented = false; oneScreen = true;
  handler(ev({ deltaY: 100 }));
  assert.ok(prevented && set.to - set.from > 100, 'plain wheel zooms out in "Satu layar"');
});

test('chart options: touch gestures and no wheel capture by the library', () => {
  assert.match(runtime, /handleScroll: \{ mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false \}/);
  assert.match(runtime, /handleScale: \{ axisPressedMouseMove: \{ time: true, price: true \}, mouseWheel: false, pinch: true \}/);
  assert.match(runtime, /kineticScroll: \{ touch: true, mouse: false \}/);
  assert.match(runtime, /trackingMode: \{ exitMode: LightweightCharts\.TrackingModeExitMode \? LightweightCharts\.TrackingModeExitMode\.OnNextTap : 1 \}/);
  assert.match(runtime, /container\.style\.touchAction = 'pan-y';/);
});

test('legend: written once per frame, heavy values computed once per render', () => {
  assert.match(runtime, /_hdrRaf = \(typeof requestAnimationFrame === 'function' \? requestAnimationFrame : setTimeout\)\(function\(\) \{ _hdrRaf = 0; updateCanvasHeader\(_hdrNext\); \}\);/);
  assert.match(runtime, /if \(c === _hdrShown && _mob === _hdrMobile\) return;/);
  const hdr = extract('function updateCanvasHeader(');
  assert.doesNotMatch(hdr, /calculateCorrF|calculateParF|calculateLPM|calculateForeignFlowCumulative|getLatestMoneyFlow/);
  assert.doesNotMatch(hdr, /candles\.find\(/);
});
