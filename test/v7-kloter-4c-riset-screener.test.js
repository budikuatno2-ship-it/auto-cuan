'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const vendors = require(path.join(ROOT, 'public', 'v7-lazy-vendor.js'));
const riset = require(path.join(ROOT, 'public', 'v7-riset-screener.js'));

test('V7 4C Vendor Bundles: exact Pilot 3D files present in public/vendor with matching byte sizes', () => {
  const expected = {
    'tanstack-virtual.min.js': 35479,
    'cytoscape.min.js': 442752,
    'echarts-custom.min.js': 608659
  };
  Object.entries(expected).forEach(([file, bytes]) => {
    const full = path.join(ROOT, 'public', 'vendor', file);
    assert.ok(fs.existsSync(full), `Missing vendor bundle: ${file}`);
    assert.equal(fs.statSync(full).size, bytes, `Unexpected byte size for ${file}`);
  });
});

test('V7 4C Strict Lazy-Load: index.html must never eagerly reference Cytoscape or ECharts', () => {
  const html = read('public/index.html');
  assert.doesNotMatch(html, /<script[^>]+vendor\/cytoscape\.min\.js/i);
  assert.doesNotMatch(html, /<script[^>]+vendor\/echarts-custom\.min\.js/i);
  assert.match(html, /<script[^>]+src="\/v7-lazy-vendor\.js\?v=v7-4c"/);
  assert.match(html, /<script[^>]+src="\/v7-riset-screener\.js\?v=v7-4c"/);

  assert.equal(typeof vendors.loadTanstackVirtual, 'function');
  assert.equal(typeof vendors.loadCytoscape, 'function');
  assert.equal(typeof vendors.loadEcharts, 'function');
  assert.equal(typeof vendors.getStatus, 'function');
});

test('V7 4C Financial Formatter: converts Miliar IDR to T/M accurately with zero 0,00 T or Mrd bugs', () => {
  // Pilot 3D regression: BBCA Q1 2026 values stored in Miliar IDR
  assert.equal(riset.formatFinancialCompact(24592.25, { unit: 'miliar', withPrefix: true }), 'Rp 24,59 T');
  assert.equal(riset.formatFinancialCompact(14681.75, { unit: 'miliar', withPrefix: true }), 'Rp 14,68 T');
  assert.equal(riset.formatFinancialCompact(950, { unit: 'miliar' }), '950 M');
  assert.equal(riset.formatFinancialCompact(-1490.25, { unit: 'miliar' }), '−1,49 T');

  // Missing values stay em dash, never fabricated as 0,00 T
  assert.equal(riset.formatFinancialCompact(null, { unit: 'miliar' }), '—');
  assert.equal(riset.formatFinancialCompact(undefined, { unit: 'miliar' }), '—');
  assert.equal(riset.formatFinancialCompact(NaN, { unit: 'miliar' }), '—');

  // Raw IDR fallback works cleanly too
  assert.equal(riset.formatFinancialCompact(24592250000000, { unit: 'auto' }), '24,59 T');
  assert.doesNotMatch(riset.formatFinancialCompact(1500000000, { unit: 'auto' }), /Mrd/);
});

test('V7 4C Sanitization & IDX All-Price >= Rp 1 rules', () => {
  assert.equal(riset.sanitizePublicLabel('Sumber arjum_insiders KSEI 30 September 2026'), 'Sumber Data Kustodian KSEI KSEI 30 Okt 2026');
  assert.equal(riset.sanitizePublicLabel('120 Mrd lembar'), '120 M lembar');

  // RELF Rp 30 / Rp 36 stays eligible in IDX All-Price >= Rp 1
  assert.equal(riset.isAllPriceEligible({ ticker: 'RELF', last_price: 30 }), true);
  assert.equal(riset.isAllPriceEligible({ ticker: 'RELF', last_price: 36 }), true);
  assert.equal(riset.isAllPriceEligible({ ticker: 'ZERO', last_price: 0 }), false);
  assert.equal(riset.isAllPriceEligible({ ticker: 'MISS', last_price: null }), false);

  assert.equal(riset.computeBoundingOverlapCount([
    { x1: 0, y1: 0, x2: 40, y2: 40 },
    { x1: 60, y1: 0, x2: 100, y2: 40 }
  ]), 0);
  assert.equal(riset.computeBoundingOverlapCount([
    { x1: 0, y1: 0, x2: 40, y2: 40 },
    { x1: 20, y1: 20, x2: 60, y2: 60 }
  ]), 1);
});

test('V7 4C ECharts Options: Breadth, Sektor Hot, & Financial 8Q build valid tokenized options', () => {
  const breadthOpt = riset.buildBreadthEChartOption({ advancers: 320, unchanged: 90, decliners: 410 }, false);
  assert.equal(breadthOpt.series[0].data.length, 3);

  const sektorOpt = riset.buildSektorEChartOption([
    { group_code: 'PRAJOGO', group_name: 'Grup Prajogo Pangestu', avg_change_pct: 2.34, ticker_count: 6, top_ticker: 'BRPT' },
    { group_code: 'SALIM', group_name: 'Grup Salim', avg_change_pct: -0.82, ticker_count: 8, top_ticker: 'INDF' }
  ], true);
  assert.equal(sektorOpt.grid.left, 96);
  assert.equal(sektorOpt.yAxis.data.length, 2);

  const finOpt = riset.buildFinancial8QEChartOption(
    { unit: 'miliar' },
    { l: 'Pendapatan Usaha', k: 'm', vals: [24592.25, 23100, 22400, 21800, 21000, 20500, 19800, 19200] },
    [{ lab: 'Q1 2026' }, { lab: 'Q4 2025' }, { lab: 'Q3 2025' }, { lab: 'Q2 2025' }, { lab: 'Q1 2025' }, { lab: 'Q4 2024' }, { lab: 'Q3 2024' }, { lab: 'Q2 2024' }],
    0,
    false
  );
  assert.equal(finOpt.xAxis.data[0], 'Q2 2024');
  assert.equal(finOpt.xAxis.data[7], 'Q1 2026');
  assert.equal(finOpt.series[0].data[7].value, 24592.25);
});

test('V7 4C Production Runtime Integration & NOTICE Attribution Contracts', () => {
  const dash = read('public/dashboard-v2.js');
  const analisis = read('public/analisis-saham-runtime.js');
  const bandar = read('public/bandarmologi-runtime.js');
  const pattern = read('public/pattern-stable-runtime.js');
  const shellCss = read('public/v7-shell.css');
  const notice = read('NOTICE');

  assert.match(dash, /AutoCuanV7Riset\.renderDashboardBreadthEChart/);
  assert.match(analisis, /AutoCuanV7Riset\.renderVirtualRankingGrid/);
  assert.match(analisis, /AutoCuanV7Riset\.renderFinancialEChart/);
  assert.match(analisis, /AutoCuanV7Riset\.renderVirtualMarketStructureGrid/);
  assert.match(bandar, /AutoCuanV7Riset\.mountInsiderCytoscape/);
  assert.match(bandar, /AutoCuanV7Riset\.mountBrokerHunterCytoscape/);
  assert.doesNotMatch(bandar, /KSEI · 30 Sep 2026/);
  assert.match(bandar, /KSEI · 30 Okt 2026/);

  // Pattern Radar & Shell CSS must use semantic tokens cleanly without pure black #000000
  assert.match(pattern, /var\(--ac-surface-raised/);
  assert.match(pattern, /var\(--ac-ink/);
  assert.match(shellCss, /#msDetailNote/);
  assert.match(shellCss, /\.v7-vgrid-scroll/);
  assert.doesNotMatch(shellCss, /#000000\b/);

  // Attribution updated for @tanstack/virtual-core v3.19.13, Cytoscape.js v3.35.0, Apache ECharts v6.1.0
  assert.match(notice, /@tanstack\/virtual-core v3\.19\.13/);
  assert.match(notice, /Cytoscape\.js v3\.35\.0/);
  assert.match(notice, /Apache ECharts v6\.1\.0/);
});
