'use strict';

// HANDOFF 5a "Rencana per horizon": levels only from the server engines.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function load() {
  const sb = { window: {}, document: { readyState: 'complete', addEventListener() {}, getElementById: () => null }, Intl, Math, Number, String, Object, Array, Date, Promise, isFinite };
  sb.window.document = sb.document;
  vm.runInNewContext(read('public/analisis-v2.js'), sb);
  return sb.window.AutoCuanAnalisisV2;
}

test('horizon mapping follows the chart mode; Scalping forces daily candles', () => {
  const a = load();
  assert.equal(a.MODE_HZ.simpel, 'swing');
  assert.equal(a.MODE_HZ.scalping, 'scalp');
  assert.equal(a.MODE_HZ.investor, 'inv');
  assert.equal(a.MODE_HZ.pro, undefined, 'Pro keeps the last horizon');
  assert.match(read('public/chart-workstation.js'), /if \(presetName === 'scalping'\) inst\.state\.setTimeframe\('1D'\);/);
});

test('plans come from the Day Trade and Swing screener rows; Investor stays empty', () => {
  const src = read('public/analisis-v2.js');
  assert.match(src, /fetchRows\('\/api\/sector-hot\?action=screener'\)/);
  assert.match(src, /fetchRows\('\/api\/sector-hot\?action=nk-screener-results'\)/);
  assert.match(src, /fetchRows\('\/api\/sector-hot\?action=daytrade-screener'\)/);
  assert.match(src, /plans = \{ scalp: levelsOf\(findRow\(all\[2\], t, 'Day Trade'\)\), swing: levelsOf\(swingRow\), inv: null \}/);
  assert.match(src, /Belum ada rencana Investor dari server\. Level tidak dihitung di layar ini\./);
  const a = load();
  assert.equal(a.levelsOf(null), null);
  assert.equal(a.levelsOf({ ticker: 'X', entry1: 100 }), null, 'no SL/TP from the server means no plan');
});

test('the chart no longer derives a plan from candles unless a server plan was handed over', () => {
  const rt = read('public/market-feature-runtime.js');
  assert.match(rt, /if \(showTradingPlan && ws && customPlan && customPlan\.entry && customPlan\.sl\) \{\s*plan = ws\.calculateTradingPlan/);
  ["'68,4%'", "'2,35'", "'42 Trade'", "'-5,8%'", "'5,2 Hari'", "'+Rp 845.000'"].forEach((fake) => assert.ok(!rt.includes(': ' + fake + ')'), 'backtest fallback ' + fake + ' removed'));
});

test('lot arithmetic: half at TP1, rest at TP2, buy 0,15% and sell 0,25%', () => {
  const c = load().calc({ entry: 5900, sl: 5750, tp1: 6250, tp2: 6500 }, 10);
  assert.equal(c.l1, 5); assert.equal(c.l2, 5);
  assert.equal(Math.round(c.g1), 162763);
  assert.equal(Math.round(c.g2), 287450);
  assert.equal(Math.round(c.total), 450213);
  assert.equal(Math.round(c.risk), 173225, 'buy 10 lot at entry incl. fee minus sell at SL incl. fee')
  const none = load().calc({ entry: 100, sl: 90, tp1: 110, tp2: null }, 4);
  assert.equal(none.total, null, 'no TP2 from the server means no total');
});

test('10-day range check is a volatility band and is not used for Investor', () => {
  const a = load();
  assert.equal(a.range10(new Array(30).fill({ close: 100 })), null);
  const candles = []; let px = 1000; for (let i = 0; i < 80; i++) { px *= i % 2 ? 1.01 : 0.995; candles.push({ close: px }); }
  const r = a.range10(candles);
  assert.ok(r.p10 < px && r.p90 > px);
  assert.equal(a.rangeCheck('inv', { tp1: 1, sl: 1 }, r).v, 'Tidak dipakai');
  assert.equal(a.rangeCheck('swing', { tp1: px, tp2: r.p90 * 1.1, sl: px * 0.9 }, r).v, 'TP2 di luar rentang');
  assert.equal(a.rangeCheck('swing', { tp1: px, sl: px }, null).v, '—');
});

test('plan sheet is mounted in all three copies of the Analisis markup', () => {
  const block = '<section id="anaPlanSheet" class="sheet ana-plan" data-ac-ui="v2" aria-label="Rencana per horizon"></section>';
  ['public/index.html', 'public/partials/analisis-saham.partial.html', 'partials/analisis-saham.partial.html'].forEach((f) => assert.ok(read(f).includes(block), f));
  assert.match(read('public/index.html'), /<script src="\/analisis-v2\.js\?v=/);
});
