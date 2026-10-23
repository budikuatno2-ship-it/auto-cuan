'use strict';

// Redesign v2 Analisis & Chart (canvas Analisis.dc.html, HANDOFF §5a subset).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const partial = read('public/partials/analisis-saham.partial.html');
const runtime = read('public/market-feature-runtime.js');
const cockpit = read('public/unified-cockpit-runtime.js');
const workstation = require('../public/chart-workstation.js');

test('ticker context sheet keeps the cockpit ids and the three copies stay in sync', () => {
  assert.match(partial, /<div id="analisisChartHeader" class="analisis-saham-controls ticker-search-container sheet ana-ctx" data-ac-ui="v2">/);
  ['unifiedActiveTickerBadge', 'unifiedActiveCompanyName', 'unifiedActiveCompanySector', 'unifiedActiveTickerQuote', 'analisisInput', 'btnJalankanAnalisis', 'tabAnalisisText', 'tabChartWorkstationLens', 'analisisLensesNav']
    .forEach((id) => assert.ok(partial.includes('id="' + id + '"'), id));
  const html = read('public/index.html');
  const s = partial.indexOf('<h1 id="analysisWorkspaceTitle"');
  const e = partial.indexOf('<!-- ===== TAB 1:');
  assert.ok(html.includes(partial.slice(s, e)), 'index.html carries the same header block');
  assert.match(html, /<div id="page-analisis" class="page-content ac-page[^"]*"[^>]*data-ac-ui="v2">/);
});

test('header price never prints an invented change', () => {
  assert.doesNotMatch(cockpit, /' \(0\.00%\)'/);
  assert.doesNotMatch(read('public/analisis-saham-runtime.js'), /' \(0\.00%\)'/);
  assert.match(cockpit, /quoteEl\.className = 'ana-quote num mono ' \+ \(diff > 0 \? 'is-up'/);
});

test('chart follows the theme tokens and repaints on a theme switch', () => {
  assert.match(runtime, /function acChartTheme\(el\) \{/);
  assert.match(runtime, /window\.addEventListener\('ac-theme', function\(\) \{/);
  assert.doesNotMatch(runtime, /background: \{ color: '#0f1319' \}/);
  assert.doesNotMatch(runtime, /background: \{ color: '#0b0e14' \}/);
  assert.match(runtime, /localization: \{ locale: 'id-ID', timeFormatter: acCrosshairDate, priceFormatter:/);
});

test('no leaked resize listener and no invented legend values', () => {
  assert.match(runtime, /if \(!reg \|\| reg\.mainChart !== chart\) \{ window\.removeEventListener\('resize', _onWinResize\); return; \}/);
  assert.doesNotMatch(runtime, /calculateCorrF\(candles\) : 0\.72/);
  assert.doesNotMatch(runtime, /calculateParF\(candles\) : 34\.2/);
});

test('default view is about six months and double-click returns to it', () => {
  // Per-mode lengths (Scalping 3 months, Investor 1 year) are in redesign-v2-chart-cursor.
  assert.match(runtime, /var _bars = acDefaultBars\(wsState && wsState\.activePreset, _span > 3\);/);
  assert.match(runtime, /container\.addEventListener\('dblclick', function\(\) \{ try \{ chart\.timeScale\(\)\.setVisibleLogicalRange\(_defaultRange\);/);
});

test('toolbar offers Satu layar and the price-scale buttons', () => {
  const bar = workstation.renderToolbarHtml('c1');
  assert.match(bar, /AutoCuanChartWorkstation\.toggleOneScreen\('c1'\)/);
  ['out', 'in', 'auto'].forEach((d) => assert.match(bar, new RegExp("AutoCuanChartWorkstation\\.scalePrice\\('c1', '" + d + "'\\)")));
  assert.match(bar, /aria-label="Pilih Preset Chart"/);
  assert.match(bar, /id="c1_layer_badge"/);
  assert.equal(typeof workstation.scalePrice, 'function');
  assert.equal(typeof workstation.toggleOneScreen, 'function');
});
