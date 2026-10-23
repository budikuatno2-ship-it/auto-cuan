'use strict';

// HANDOFF 5a: indices get "Potensi arah", never entry/SL/TP.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
function load() {
  const sb = { window: {}, document: { readyState: 'complete', addEventListener() {}, getElementById: () => null, querySelectorAll: () => [] }, Intl, Math, Number, String, Object, Array, Date, Promise, isFinite };
  sb.window.document = sb.document;
  vm.runInNewContext(read('public/analisis-v2.js'), sb);
  return sb.window.AutoCuanAnalisisV2;
}
// Real IHSG daily candles captured read-only from the VPS when available,
// otherwise a deterministic falling series.
function candles() {
  const fx = path.join(__dirname, '..', 'handoff-redesign', 'fixtures', 'vps', 'candles-IHSG.json');
  if (fs.existsSync(fx)) return JSON.parse(fs.readFileSync(fx, 'utf8')).candles;
  const out = []; let c = 7000;
  for (let i = 0; i < 260; i++) { c *= 1 + Math.sin(i / 7) * 0.01 - 0.002; const d = new Date(Date.UTC(2025, 9, 1) + i * 86400000); out.push({ time: d.toISOString().slice(0, 10), open: c, high: c * 1.01, low: c * 0.99, close: c }); }
  return out;
}

test('bias, scenarios and range follow the horizon table', () => {
  const a = load(), k = candles();
  ['scalp', 'swing', 'inv'].forEach((hz) => {
    const ix = a.potential(k, hz);
    assert.ok(ix && !ix.insufficient, hz);
    assert.ok(['up', 'down', 'flat'].includes(ix.bias));
    assert.ok(ix.p10 < ix.c0 && ix.c0 < ix.p90, 'range brackets the close');
    assert.ok(ix.upT.v > ix.c0 && ix.dnT.v < ix.c0, 'scenarios on both sides');
    assert.ok(ix.why.some((w) => /^RSI14 /.test(w)), 'RSI14 is part of the reason');
  });
  assert.equal(a.potential(k, 'scalp').z.d, 5);
  assert.equal(a.potential(k, 'swing').z.d, 20);
  assert.equal(a.potential(k, 'inv').z.d, 60);
  assert.equal(a.potential(k.slice(-40), 'swing'), null, 'too little history: no reading');
});

test('range is close x e^(+-1,2816 x sigma60 x sqrt(days))', () => {
  const a = load(), k = candles(), ix = a.potential(k, 'swing');
  const band = 1.2816 * ix.sd * Math.sqrt(20);
  assert.ok(Math.abs(ix.p90 - ix.c0 * Math.exp(band)) < 1e-6);
  assert.ok(Math.abs(ix.p10 - ix.c0 * Math.exp(-band)) < 1e-6);
});

test('indices drop stock-only layers and keep the market-direction copy', () => {
  const ws = require('../public/chart-workstation.js');
  assert.equal(ws.isIndexTicker('IHSG'), true);
  assert.equal(ws.isIndexTicker('BBCA'), false);
  ['trading_plan', 'signal_markers', 'bandar_lpm', 'bandar_foreign'].forEach((id) => assert.ok(ws.STOCK_ONLY_LAYERS[id], id));
  const rt = read('public/market-feature-runtime.js');
  assert.match(rt, /if \(_isIndexChart\) \{ showTradingPlan = false; showLPM = false; showForeign = false; showCMF = false; showIntensity = false; showRotation = false; \}/);
  assert.match(read('public/chart-workstation.js'), /'Tidak ada broker summary untuk indeks' : 'Khusus saham'/);
  const src = read('public/analisis-v2.js');
  assert.match(src, /Ini gambaran arah pasar, bukan sinyal beli atau jual\./);
  assert.match(src, /chip\.textContent = 'Ke mana arahnya\?'/);
  assert.ok(src.includes('>Struktur Pasar</button>') && src.includes('>Sektor Hot</button>'), 'index header links');
  assert.match(src, /api\.drawIndexOverlay = function \(\) \{/);
});

test('the chart registers before the quote request and the quote wait is bounded', () => {
  const rt = read('public/market-feature-runtime.js');
  assert.ok(rt.indexOf('_chartRegistry[chartId] = Object.assign(') < rt.indexOf("fetch('/api/quote?ticker=' + encodeURIComponent(fibTicker)"));
  assert.match(rt, /setTimeout\(function\(\) \{ _fibAbort\.abort\(\); \}, 5000\)/);
  assert.doesNotMatch(rt, /: 'Rp ' \+ cClose\.toLocaleString\('id-ID'\)\)/, 'LPM never falls back to the close price');
});
