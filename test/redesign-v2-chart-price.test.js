'use strict';

// HANDOFF 5a "Harga selalu terbaca": coloured last-price tag with % change,
// high/low labels in the visible range, IDX price-fraction axis steps, level
// titles without "Rp" and short tags on phones.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const runtime = read('public/market-feature-runtime.js');
function extract(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, signature);
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error('unbalanced ' + signature);
}
function helpers(extra) {
  const src = ["var AC_SHORT_TAGS = { 'Entry': 'En', 'TP1': 'T1', 'TP2': 'T2', 'Resistance': 'R', 'Support': 'S' };",
    extract(runtime, 'function acLevelTitle('), extract(runtime, 'function acLastPrice('),
    extract(runtime, 'function acVisibleHiLo('), extract(runtime, 'function acAttachHiLo(')].join('\n');
  const sb = Object.assign({ Math, Number, String, Object }, extra || {});
  vm.createContext(sb);
  vm.runInContext(src + '\nthis.acLevelTitle=acLevelTitle;this.acLastPrice=acLastPrice;this.acVisibleHiLo=acVisibleHiLo;this.acAttachHiLo=acAttachHiLo;', sb);
  return sb;
}

test('last-price tag colour and % change follow the previous close', () => {
  const h = helpers();
  const up = h.acLastPrice([{ close: 1000 }, { close: 1025 }]);
  assert.equal(up.price, 1025);
  assert.equal(up.up, true);
  assert.equal(up.title, '+2,50%');
  const down = h.acLastPrice([{ close: 1000 }, { close: 980 }]);
  assert.equal(down.up, false);
  assert.equal(down.title, '−2,00%');
  assert.equal(h.acLastPrice([{ close: 500 }]).title, '', 'no previous close: no % invented');
  assert.equal(h.acLastPrice([]), null);
  assert.equal(h.acLastPrice([{ close: 0 }]), null);
});

test('high and low come from the visible range only', () => {
  const h = helpers();
  const k = Array.from({ length: 40 }, (_, i) => ({ high: 100 + i, low: 90 + i }));
  k[3].high = 999; k[2].low = 1;
  const all = h.acVisibleHiLo(k, 0, 39);
  assert.equal(all.hi, 3); assert.equal(all.lo, 2);
  const tail = h.acVisibleHiLo(k, 20.4, 45);
  assert.equal(tail.hi, 39); assert.equal(tail.lo, 21);
  assert.equal(h.acVisibleHiLo(k, 30, 35), null, 'fewer than 10 bars: no label');
});

test('labels are placed through the chart API once per frame and hide off-pane', () => {
  const made = [], listeners = {};
  let frames = 0, rangeCb = null, priceY = { 999: 30, 1: 500 };
  const doc = { createElement: () => { const el = { style: {}, className: '', textContent: '' }; made.push(el); return el; } };
  const h = helpers({ document: doc, requestAnimationFrame: (f) => { frames++; f(); return 0; }, setTimeout });
  const chart = {
    paneSize: () => ({ width: 800, height: 400 }),
    timeScale: () => ({ getVisibleLogicalRange: () => ({ from: 0, to: 39 }), logicalToCoordinate: (i) => i * 20, subscribeVisibleLogicalRangeChange: (cb) => { rangeCb = cb; } })
  };
  const series = { priceToCoordinate: (p) => (p in priceY ? priceY[p] : 200) };
  const container = { clientWidth: 800, clientHeight: 420, appendChild() {}, addEventListener: (t, f) => { listeners[t] = f; } };
  const k = Array.from({ length: 40 }, (_, i) => ({ high: 100 + i, low: 90 + i }));
  k[3].high = 999; k[2].low = 1;
  const api = h.acAttachHiLo(chart, series, k, container, (v) => Number(v).toLocaleString('id-ID'));
  const [hi, lo] = made;
  assert.equal(hi.textContent, '▲ 999');
  assert.equal(hi.style.display, 'block');
  assert.match(hi.style.transform, /translate\(60px,13px\)/);
  assert.equal(lo.style.display, 'none', 'low below the pane is hidden');
  assert.equal(typeof rangeCb, 'function', 'follows the visible range');
  assert.ok(listeners.wheel && listeners.pointerup && listeners.pointermove, 'follows price-scale drags and wheel');
  const before = frames;
  api.refresh();
  assert.equal(frames, before + 1);
  assert.ok(!/getBoundingClientRect|offsetTop|offsetLeft/.test(extract(runtime, 'function acAttachHiLo(')), 'no layout reads in the handlers');
});

test('level titles drop "Rp" and shorten on phones', () => {
  const h = helpers();
  assert.equal(h.acLevelTitle('Entry', false), 'Entry');
  assert.equal(h.acLevelTitle('Entry', true), 'En');
  assert.equal(h.acLevelTitle('TP1', true), 'T1');
  assert.equal(h.acLevelTitle('TP2', true), 'T2');
  assert.equal(h.acLevelTitle('SL', true), 'SL');
  assert.doesNotMatch(runtime, /title: '(Resistance|Support|VP POC:|VAH \(70%\):|VAL \(70%\):) Rp/);
  assert.doesNotMatch(runtime, /'(Entry|Stop Loss|Target 1 \(50%\)|Target 2 \(50%\)) Rp '/);
  const ws = read('public/chart-workstation.js');
  assert.match(ws, /var PLAN_LINE_SHORT = \{ entry: 'En', tp1: 'T1', tp2: 'T2' \};/);
  assert.match(ws, /title: \(narrow && PLAN_LINE_SHORT\[key\]\) \|\| PLAN_LINE_LABEL\[key\]/);
});

test('candles use the IDX tick as minMove and the custom last-price line', () => {
  assert.match(runtime, /priceFormat: \{ type: 'price', precision: _isIdxTicker \? 2 : 0, minMove: _tick \}/);
  assert.match(runtime, /_wsTick\.getIdxTickSize\(_lastClose\)/);
  assert.match(runtime, /lastValueVisible: false, priceLineVisible: false/);
  assert.match(runtime, /createPriceLine\(\{ price: _lp\.price, color: _lp\.up \? _th\.up : _th\.down, lineWidth: 1, lineStyle: 2, axisLabelVisible: true/);
  assert.match(runtime, /if \(e\.lastLine\) \{ try \{ e\.lastLine\.applyOptions\(\{ color: e\.lastUp \? th\.up : th\.down \}\)/, 'theme switch recolours the tag');
  const ws = read('public/chart-workstation.js');
  assert.equal((ws.match(/if \(reg\.hiLo\) reg\.hiLo\.refresh\(\);/g) || []).length, 2, 'scale buttons move the labels');
});
