'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('application shell CSS is externalized before the theme layer', () => {
  const html = read('public/index.html');
  const css = read('public/index-shell.css');
  const shellAt = html.indexOf('/index-shell.css?v=20260818-v1');
  const themeAt = html.indexOf('/ui-theme.css');
  assert.ok(shellAt > 0 && themeAt > shellAt);
  const head = html.slice(0, html.indexOf('</head>'));
  assert.doesNotMatch(head, /<style>/i);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.maintenance-card \{/);
  assert.match(css, /border-radius: 14px/);
  assert.match(css, /background: #0f172a/);
});

test('market chart and export runtime preserves classic global contracts', () => {
  const html = read('public/index.html');
  const runtime = read('public/market-feature-runtime.js');
  const refAt = html.indexOf('/market-feature-runtime.js?v=20260818-v1');
  const accessibilityAt = html.indexOf('// ===== ACCESSIBILITY:');
  assert.ok(refAt > 0 && accessibilityAt > refAt);
  assert.equal((html.match(/market-feature-runtime\.js\?v=20260818-v1/g) || []).length, 1);
  for (const name of ['loadLightweightCharts', 'toggleNewsPanel', 'exportAnalisisPDF', 'exportDayTradePDF']) {
    assert.ok(runtime.includes('function ' + name + '('), name + ' contract missing');
  }
  assert.match(runtime, /var _lwcLoadPromise = null/);
  assert.match(runtime, /if \(_lwcLoadPromise\) return _lwcLoadPromise/);
  assert.match(runtime, /window\.loadPdfLibrary\(\)\.then/);
});

test('Pattern access polling exits before hidden-tab access work', () => {
  const src = read('public/pattern-stable-runtime.js');
  const intervalAt = src.indexOf('root.setInterval(function () {');
  const hiddenAt = src.indexOf("if (doc.visibilityState === 'hidden') return;", intervalAt);
  const accessAt = src.indexOf('root.PatternMapAdminAccess.isAllowed()', intervalAt);
  assert.ok(intervalAt >= 0 && hiddenAt > intervalAt && accessAt > hiddenAt);
});

test('public extracted assets are cacheable while APIs stay no-store', () => {
  const config = JSON.parse(read('vercel.json'));
  const bySource = new Map(config.headers.map((entry) => [entry.source, entry]));
  const api = bySource.get('/api/(.*)');
  assert.ok(api);
  assert.match(api.headers.find((h) => h.key.toLowerCase() === 'cache-control').value, /no-store/);
  for (const source of ['/assets/(.*)', '/index-shell.css', '/market-feature-runtime.js']) {
    const entry = bySource.get(source);
    assert.ok(entry, source + ' cache rule missing');
    const value = entry.headers.find((h) => h.key.toLowerCase() === 'cache-control').value;
    assert.match(value, /public/);
    assert.doesNotMatch(value, /no-store/);
  }
});
