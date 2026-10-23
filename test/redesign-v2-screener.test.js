'use strict';

// Redesign v2 Screener (canvas Screener.dc.html).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const html = read('public/index.html');

test('header carries the title, the mode text and the three-way mode switch', () => {
  const start = html.indexOf('<div id="page-screener"');
  const page = html.slice(start, html.indexOf('<!-- ===== PAGE:', start + 10));
  assert.match(page, /class="page-content ac-page[^"]*" data-premium-page="true" data-ac-ui="v2"/);
  assert.match(page, /<div class="segx n3 scr-modes" role="group" aria-label="Mode screener"><span class="ind" id="scrTypeInd"><\/span>/);
  ['scrTypeKonglo', 'scrTypeNonKonglo', 'scrTypeDayTrade', 'scrModeDesc', 'scrRrMin'].forEach((id) => assert.ok(page.includes('id="' + id + '"'), id));
  assert.doesNotMatch(page, />(Scanned|Failed|Last|Group|Plan View)</, 'labels are Indonesian');
  assert.match(html, /var SCREENER_MODE_DESC = \{/);
  assert.match(html, /ind\.className = 'ind' \+ \(type === 'nonkonglo' \? ' k1' : \(type === 'daytrade' \? ' k2' : ''\)\);/);
});

test('R/R floor is a client-side filter only (1,5 swing, 1,2 day trade)', () => {
  assert.match(html, /rrMin: !!\(typeof document !== 'undefined' && document\.getElementById\('scrRrMin'\)/);
  assert.match(html, /if \(f\.rrMin\) \{\s*var rr = Number\(normalizeDisplayLevels\(r\)\.rr\);\s*if \(!\(isFinite\(rr\) && rr >= \(type === 'daytrade' \? 1\.2 : 1\.5\)\)\) return false;/);
});

test('one detail renderer: canvas summary plus the full legacy detail', () => {
  assert.match(html, /function renderScrDetailHtml\(r, type\) \{\s*if \(!r\) return '';\s*if \(!window\.AutoCuanScreenerV2\) return renderScrDetailLegacyHtml\(r, type\);/);
  assert.match(html, /<details class="scr-more"><summary>/);
  // The docked pane follows the active mode (Non-Konglo and Day Trade used to
  // write into the hidden Konglo pane).
  assert.match(html, /document\.getElementById\(type === 'daytrade' \? 'dtDetailPane' : \(type === 'nonkonglo' \? 'nkDetailPane' : 'screenerDetailPane'\)\)/);
  // Auto-select only where the pane is docked, so no dialog opens on load.
  // Docked from 1280 px, or 1024 px with compact columns (AutoCuanScreenerV2.isDocked).
  assert.equal((html.match(/AutoCuanScreenerV2\.isDocked\(\) : window\.innerWidth >= 1280\) && filtered\.length > 0/g) || []).length, 2);
});

test('a failed screener read is not reported as "access denied"', () => {
  assert.match(html, /response\.status === 403 \? 'Akses ditolak\.' : 'Hasil screener gagal dimuat\.'/);
});

test('summary shows plan, position size and gate evidence from existing modules', () => {
  const sandbox = { window: {} };
  sandbox.window.normalizeDisplayLevels = () => ({ e1: 5950, e2: 5900, sl: 5750, t1: 6250, t2: 6500, rr: 1.2 });
  sandbox.window.swingTierShort = () => 'A+ SWING';
  sandbox.window.PositionSizing = { getSettings: () => ({ capital: 10e6, riskPct: 1 }), fmtRpCompact: () => 'Rp 10 jt', calculatePosition: () => ({ isValid: true, riskPerLotKini: 20000, lots: 5, positionValue: 2975000, profitTp1Idr: 175000 }) };
  sandbox.window.SignalGateTransparency = { evaluateGates: () => ({ passedCount: 1, totalCount: 2, gates: [{ title: 'Likuiditas Transaksi', actual: 'Rp 12 M', threshold: 'Rp 1 M', passed: true }, { title: 'Momentum RSI 14', actual: null, passed: null }] }) };
  vm.runInNewContext(read('public/screener-v2.js'), sandbox);
  const out = sandbox.window.AutoCuanScreenerV2.summaryHtml({ ticker: 'BBCA', last_price: 5950, change_pct: 1.25, score: 92, confidence: 'A+' }, 'konglo');
  assert.match(out, /<span class="tk mono">BBCA<\/span><span class="chip b">A\+ SWING · Exec A\+<\/span>/);
  assert.match(out, /Area entry<\/span><span class="num mono">5\.900 – 5\.950/);
  assert.match(out, /R\/R di bawah batas minimum 1 : 1,5/);
  assert.match(out, /Ukuran maksimal<\/span><span class="num">5 lot \(500 lembar\)/);
  assert.match(out, /Bukti gate <span class="mut">· 1 dari 2 terpenuhi/);
  assert.match(out, /belum terverifikasi/);
  assert.doesNotMatch(out, /—\s*status/);
});

test('setup meanings and gate summary use no em dash inside sentences', () => {
  const a = html.indexOf('function getSetupMeaning');
  assert.doesNotMatch(html.slice(a, html.indexOf('\n}\n', a)), / — /);
  assert.doesNotMatch(read('public/signal-gate-transparency.js'), /belum tersedia — status/);
});

// Canvas "Urutkan" and "Kolom ringkas/lengkap".
function loadView(store) {
  const sb = { window: { innerWidth: 1440, localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } } }, Number, String, Array, Object, JSON, isFinite, Event: function () {} };
  sb.window.window = sb.window;
  vm.runInNewContext(read('public/screener-v2.js'), sb);
  return sb.window;
}
test('sort is display only: default keeps the screener order, Skor and Perubahan sort, blanks last', () => {
  const w = loadView({});
  const api = w.AutoCuanScreenerV2;
  const rows = [{ ticker: 'A', score: 80, change_pct: 1 }, { ticker: 'B', score: 92, change_pct: null }, { ticker: 'C', score: 85, change_pct: 4 }, { ticker: 'D', score: null, change_pct: 2 }];
  assert.deepEqual(api.sortRows(rows, 'konglo').map((r) => r.ticker), ['A', 'B', 'C', 'D']);
  api.view.sort = 'score';
  assert.deepEqual(api.sortRows(rows, 'konglo').map((r) => r.ticker), ['B', 'C', 'A', 'D']);
  api.view.sort = 'chg';
  assert.deepEqual(api.sortRows(rows, 'konglo').map((r) => r.ticker), ['C', 'D', 'A', 'B']);
  api.view.sort = 'score';
  assert.deepEqual(api.sortRows([{ ticker: 'X', daytrade_score: 50, score: 99 }, { ticker: 'Y', daytrade_score: 70 }], 'daytrade').map((r) => r.ticker), ['Y', 'X'], 'Day Trade sorts on the score its table shows');
  assert.equal(rows[0].ticker, 'A', 'the source array is not reordered');
});
test('compact columns: dock below 1280 px only where the compact table still fits', () => {
  const w = loadView({ 'ac-scr-view': '{"sort":"chg","compact":true}' });
  const api = w.AutoCuanScreenerV2;
  assert.equal(api.view.sort, 'chg', 'choice is remembered');
  const split = (width) => { w.document = { querySelectorAll: () => [{ getBoundingClientRect: () => ({ width }) }], getElementById: () => null }; };
  w.innerWidth = 1100; split(875); assert.equal(api.isDocked(), true, '875 - 360 >= 502');
  w.innerWidth = 1100; split(779); assert.equal(api.isDocked(), false, 'wide sidebar: 779 - 360 < 502');
  w.innerWidth = 1000; split(900); assert.equal(api.isDocked(), false, 'never below 1024');
  api.view.compact = false;
  w.innerWidth = 1100; assert.equal(api.isDocked(), false);
  w.innerWidth = 1280; assert.equal(api.isDocked(), true);
  const css = read('public/ac-v2.css');
  assert.match(css, /@media \(max-width: 1279px\) \{\n\s+html #appContent #page-screener:not\(\.scr-dock\) \.ac-split-view__pane \{ display: none !important; \}/);
  assert.match(css, /#page-screener\.scr-compact #screenerTableWrap tr > :nth-child\(n\+8\)/);
  assert.equal((html.match(/data-scr-sort onclick="AutoCuanScreenerV2\.cycleSort\(\)">Urutkan: Bawaan<\/button>/g) || []).length, 3);
  assert.equal((html.match(/data-scr-cols aria-pressed="false" onclick="AutoCuanScreenerV2\.toggleCompact\(\)">Kolom: Lengkap<\/button>/g) || []).length, 3);
  assert.match(html, /return window\.AutoCuanScreenerV2 && typeof window\.AutoCuanScreenerV2\.sortRows === 'function' \? window\.AutoCuanScreenerV2\.sortRows\(rows, type\) : rows;/);
});
