'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const write = (p, s) => fs.writeFileSync(path.join(ROOT, p), s);
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

function extractShellCss() {
  let html = read('public/index.html');
  if (html.includes('/index-shell.css?v=20260818-v1')) return;

  const tailwindAt = html.indexOf('/tailwind-build.css');
  const themeAt = html.indexOf('    <!-- Theme layer.', tailwindAt);
  const styleStart = html.indexOf('    <style>\n', tailwindAt);
  const styleEnd = html.indexOf('    </style>\n', styleStart);
  must(tailwindAt >= 0 && themeAt > tailwindAt, 'Theme marker not found after Tailwind link');
  must(styleStart > tailwindAt && styleEnd > styleStart && styleEnd < themeAt, 'Application shell style block not found in expected head position');

  let css = html.slice(styleStart + '    <style>\n'.length, styleEnd);
  css = css.split('\n').map((line) => line.startsWith('        ') ? line.slice(8) : line).join('\n');

  const oldCard = 'border-radius: 20px; background: linear-gradient(180deg, rgba(15,23,42,.78), rgba(15,23,42,.48)); box-shadow: 0 24px 70px rgba(0,0,0,.32);';
  const newCard = 'border-radius: 14px; background: #0f172a; box-shadow: 0 14px 36px rgba(0,0,0,.28);';
  must(css.includes(oldCard), 'Maintenance card visual baseline not found');
  css = css.replace(oldCard, newCard);

  const oldPrimary = '.maintenance-btn-primary { width: 100%; color: #04130d; border-color: rgba(52,211,153,.28); background: linear-gradient(135deg, #6ee7b7, #10b981); }';
  const newPrimary = '.maintenance-btn-primary { width: 100%; color: #04130d; border-color: rgba(52,211,153,.28); background: #10b981; }';
  must(css.includes(oldPrimary), 'Maintenance primary button visual baseline not found');
  css = css.replace(oldPrimary, newPrimary);

  write('public/index-shell.css', '/* Auto-Cuan application shell styles extracted from index.html for independent caching. */\n' + css.trim() + '\n');

  const afterStyle = styleEnd + '    </style>\n'.length;
  html = html.slice(0, styleStart) + '    <link rel="stylesheet" href="/index-shell.css?v=20260818-v1">\n' + html.slice(afterStyle);
  write('public/index.html', html);
}

function extractMarketRuntime() {
  let html = read('public/index.html');
  if (html.includes('/market-feature-runtime.js?v=20260818-v1')) return;

  const startMarker = '<script>\n// ===== LIGHTWEIGHT CHARTS LOADER';
  const accessMarker = '<script>\n// ===== ACCESSIBILITY:';
  const start = html.indexOf(startMarker);
  const accessAt = html.indexOf(accessMarker, start + 1);
  must(start >= 0 && accessAt > start, 'Market/accessibility script boundary not found');
  const close = html.indexOf('</script>', start);
  must(close > start && close < accessAt, 'Market feature script close tag not found before accessibility runtime');

  const body = html.slice(start + '<script>\n'.length, close).trimEnd() + '\n';
  must(body.includes('function loadLightweightCharts()'), 'Lightweight Charts loader missing from extraction candidate');
  must(body.includes('function exportDayTradePDF()'), 'Day Trade PDF export missing from extraction candidate');
  must(body.includes('window.loadPdfLibrary'), 'Lazy PDF loader missing from extraction candidate');
  write('public/market-feature-runtime.js', body);

  html = html.slice(0, start) + '<script src="/market-feature-runtime.js?v=20260818-v1"></script>\n' + html.slice(close + '</script>'.length);
  write('public/index.html', html);
}

function pauseHiddenPatternPolling() {
  let src = read('public/pattern-stable-runtime.js');
  if (src.includes("root.setInterval(function () {\n      if (doc.visibilityState === 'hidden') return;")) return;
  const old = "    root.setInterval(function () {\n      if (!state.checked || root.PatternMapAdminAccess.isAllowed()) return;";
  const next = "    root.setInterval(function () {\n      if (doc.visibilityState === 'hidden') return;\n      if (!state.checked || root.PatternMapAdminAccess.isAllowed()) return;";
  must(src.includes(old), 'Pattern access polling interval baseline not found');
  src = src.replace(old, next);
  write('public/pattern-stable-runtime.js', src);
}

function addPublicCacheRules() {
  const p = 'vercel.json';
  const config = JSON.parse(read(p));
  must(Array.isArray(config.headers), 'vercel.json headers array missing');
  const cacheValue = 'public, max-age=86400, stale-while-revalidate=604800';

  function ensure(source) {
    if (config.headers.some((entry) => entry.source === source)) return;
    config.headers.push({ source, headers: [{ key: 'Cache-Control', value: cacheValue }] });
  }

  ensure('/assets/(.*)');
  ensure('/index-shell.css');
  ensure('/market-feature-runtime.js');
  write(p, JSON.stringify(config, null, 2) + '\n');
}

function updateBuildValidator() {
  const p = 'tools/apply-production-hotfixes.js';
  let src = read(p);

  if (!src.includes("'public/market-feature-runtime.js'")) {
    const anchor = "  'public/stock-analysis-ai.js',\n";
    must(src.includes(anchor), 'SYNTAX_CHECKED anchor missing');
    src = src.replace(anchor, anchor + "  'public/market-feature-runtime.js',\n");
  }

  if (!src.includes("const marketFeatureRuntime = read('public/market-feature-runtime.js');")) {
    const anchor = "const indexHtml = read('public/index.html');\n";
    must(src.includes(anchor), 'indexHtml validator anchor missing');
    src = src.replace(anchor, anchor + "const marketFeatureRuntime = read('public/market-feature-runtime.js');\n");
  }

  src = src.replace(
    "assertOk(indexHtml.includes('window.loadPdfLibrary'), 'On-demand PDF loader is missing.');",
    "assertOk(marketFeatureRuntime.includes('window.loadPdfLibrary'), 'On-demand PDF loader is missing.');"
  );
  src = src.replace(
    "assertOk(!/loadScript\\(jspdfUrls, 0, function\\(ok1\\) \\{\\s*\\n\\s*if \\(!ok1\\)/.test(indexHtml) || indexHtml.indexOf('window.loadPdfLibrary') < indexHtml.indexOf('jspdfUrls, 0'), 'PDF libraries are fetched at page load again.');",
    "assertOk(!/loadScript\\(jspdfUrls, 0, function\\(ok1\\) \\{\\s*\\n\\s*if \\(!ok1\\)/.test(marketFeatureRuntime) || marketFeatureRuntime.indexOf('window.loadPdfLibrary') < marketFeatureRuntime.indexOf('jspdfUrls, 0'), 'PDF libraries are fetched at page load again.');"
  );
  src = src.replace(
    "assertOk(indexHtml.includes('_ensureJsPdf') && indexHtml.includes('window.loadPdfLibrary().then'), 'PDF export no longer triggers its own library load.');",
    "assertOk(marketFeatureRuntime.includes('_ensureJsPdf') && marketFeatureRuntime.includes('window.loadPdfLibrary().then'), 'PDF export no longer triggers its own library load.');"
  );

  src = src.replace(/indexHtml\.includes\('function (loadLightweightCharts|toggleNewsPanel|openChartPageFullscreen|exportAnalisisPDF|exportDayTradePDF)\(/g,
    "marketFeatureRuntime.includes('function $1(");
  src = src.replace(/index\.includes\('function (loadLightweightCharts|toggleNewsPanel|openChartPageFullscreen|exportAnalisisPDF|exportDayTradePDF)\(/g,
    "marketFeatureRuntime.includes('function $1(");

  write(p, src);
}

function writeRegressionTest() {
  const p = 'test/frontend-runtime-decomposition.test.js';
  const test = `'use strict';\n\n` +
`const test = require('node:test');\n` +
`const assert = require('node:assert/strict');\n` +
`const fs = require('node:fs');\n` +
`const path = require('node:path');\n\n` +
`const ROOT = path.join(__dirname, '..');\n` +
`const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');\n\n` +
`test('application shell CSS is externalized before the theme layer', () => {\n` +
`  const html = read('public/index.html');\n` +
`  const css = read('public/index-shell.css');\n` +
`  const shellAt = html.indexOf('/index-shell.css?v=20260818-v1');\n` +
`  const themeAt = html.indexOf('/ui-theme.css');\n` +
`  assert.ok(shellAt > 0 && themeAt > shellAt);\n` +
`  const head = html.slice(0, html.indexOf('</head>'));\n` +
`  assert.doesNotMatch(head, /<style>/i);\n` +
`  assert.match(css, /@media \\(prefers-reduced-motion: reduce\\)/);\n` +
`  assert.match(css, /\\.maintenance-card \\{/);\n` +
`  assert.match(css, /border-radius: 14px/);\n` +
`  assert.match(css, /background: #0f172a/);\n` +
`});\n\n` +
`test('market chart and export runtime preserves classic global contracts', () => {\n` +
`  const html = read('public/index.html');\n` +
`  const runtime = read('public/market-feature-runtime.js');\n` +
`  const refAt = html.indexOf('/market-feature-runtime.js?v=20260818-v1');\n` +
`  const accessibilityAt = html.indexOf('// ===== ACCESSIBILITY:');\n` +
`  assert.ok(refAt > 0 && accessibilityAt > refAt);\n` +
`  assert.equal((html.match(/market-feature-runtime\\.js\\?v=20260818-v1/g) || []).length, 1);\n` +
`  for (const name of ['loadLightweightCharts', 'toggleNewsPanel', 'openChartPageFullscreen', 'exportAnalisisPDF', 'exportDayTradePDF']) {\n` +
`    assert.ok(runtime.includes('function ' + name + '('), name + ' contract missing');\n` +
`  }\n` +
`  assert.match(runtime, /var _lwcLoadPromise = null/);\n` +
`  assert.match(runtime, /if \\(_lwcLoadPromise\\) return _lwcLoadPromise/);\n` +
`  assert.match(runtime, /window\\.loadPdfLibrary\\(\\)\\.then/);\n` +
`});\n\n` +
`test('Pattern access polling exits before hidden-tab access work', () => {\n` +
`  const src = read('public/pattern-stable-runtime.js');\n` +
`  const intervalAt = src.indexOf('root.setInterval(function () {');\n` +
`  const hiddenAt = src.indexOf("if (doc.visibilityState === 'hidden') return;", intervalAt);\n` +
`  const accessAt = src.indexOf('root.PatternMapAdminAccess.isAllowed()', intervalAt);\n` +
`  assert.ok(intervalAt >= 0 && hiddenAt > intervalAt && accessAt > hiddenAt);\n` +
`});\n\n` +
`test('public extracted assets are cacheable while APIs stay no-store', () => {\n` +
`  const config = JSON.parse(read('vercel.json'));\n` +
`  const bySource = new Map(config.headers.map((entry) => [entry.source, entry]));\n` +
`  const api = bySource.get('/api/(.*)');\n` +
`  assert.ok(api);\n` +
`  assert.match(api.headers.find((h) => h.key.toLowerCase() === 'cache-control').value, /no-store/);\n` +
`  for (const source of ['/assets/(.*)', '/index-shell.css', '/market-feature-runtime.js']) {\n` +
`    const entry = bySource.get(source);\n` +
`    assert.ok(entry, source + ' cache rule missing');\n` +
`    const value = entry.headers.find((h) => h.key.toLowerCase() === 'cache-control').value;\n` +
`    assert.match(value, /public/);\n` +
`    assert.doesNotMatch(value, /no-store/);\n` +
`  }\n` +
`});\n`;
  write(p, test);
}

extractShellCss();
extractMarketRuntime();
pauseHiddenPatternPolling();
addPublicCacheRules();
updateBuildValidator();
writeRegressionTest();

console.log('Reconstructed audited frontend optimizations successfully.');
