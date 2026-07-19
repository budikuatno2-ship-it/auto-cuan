'use strict';

// Focused, presentation-only tests for the Chart page + chart PNG export.
// These are static/vm tests over public/index.html (matching the repo's existing
// no-dependency testing style). They assert the export architecture, DPR handling,
// responsive heights, cleanup, and touch behavior WITHOUT touching backend, APIs,
// stock data, calculations, indicators, auth, cron, or Telegram.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'public', 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

// Extract a top-level function body by brace matching (same approach as sibling tests).
function extractFunction(signature) {
  const start = html.indexOf(signature);
  assert.ok(start >= 0, 'function must exist: ' + signature);
  const i = html.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}') { depth--; if (depth === 0) return html.slice(start, j + 1); }
  }
  throw new Error('unbalanced braces for ' + signature);
}

// Run a set of standalone pure helpers in a sandbox and return them.
function loadPureHelpers() {
  const src = [
    extractFunction('function chartDims('),
    extractFunction('function computeExportBitmapSize('),
    extractFunction('function buildChartExportFilename('),
    extractFunction('function formatWibStamp(')
  ].join('\n');
  const sandbox = { Math, Number, String, Date, Object };
  vm.createContext(sandbox);
  vm.runInContext(src + '\nthis.chartDims=chartDims;this.computeExportBitmapSize=computeExportBitmapSize;this.buildChartExportFilename=buildChartExportFilename;this.formatWibStamp=formatWibStamp;', sandbox);
  return sandbox;
}

const H = loadPureHelpers();

// Convenience slices of the functions we assert against.
const loadChartPageSrc = extractFunction('async function loadChartPage(');
const renderSrc = extractFunction('async function renderLightweightChart(');
const exportSrc = extractFunction('async function exportChartPng(');
const downloadAliasSrc = extractFunction('function downloadChartPng(');
const disposeSrc = extractFunction('function disposeChart(');
const toggleSrc = extractFunction('async function toggleYahooChart(');

// ---- 1. Chart page renders a Download PNG button ----
test('Chart page header renders an accessible Download PNG button', () => {
  assert.match(loadChartPageSrc, /Download PNG/);
  assert.match(loadChartPageSrc, /_dl/);
  assert.match(loadChartPageSrc, /aria-label="Download chart/);
  assert.match(loadChartPageSrc, /onclick="downloadChartPng\(/);
});

// ---- 2. Inline + Chart-page buttons call the SAME exporter ----
test('both inline and Chart-page buttons call downloadChartPng, which delegates to exportChartPng', () => {
  assert.match(loadChartPageSrc, /downloadChartPng\(\\'/); // page button
  assert.match(toggleSrc, /downloadChartPng\(\\'/);         // inline button
  // single shared implementation
  assert.match(downloadAliasSrc, /return exportChartPng\(chartId, ticker, btn\)/);
});

// ---- 3. Exporter no longer uses only querySelector('canvas') ----
test('exporter does not scrape a single canvas via querySelector', () => {
  assert.doesNotMatch(exportSrc, /querySelector\(\s*['"]canvas['"]\s*\)/);
  assert.match(exportSrc, /takeScreenshot\(\)/);
});

// ---- 4. Main chart screenshot AND RSI screenshot are both included ----
test('exporter captures both the main chart and the RSI chart', () => {
  assert.match(exportSrc, /entry\.mainChart\.takeScreenshot\(\)/);
  assert.match(exportSrc, /entry\.rsiChart[\s\S]*takeScreenshot\(\)/);
  const count = (exportSrc.match(/takeScreenshot\(\)/g) || []).length;
  assert.ok(count >= 2, 'expected at least two takeScreenshot() calls, got ' + count);
  // both screenshots are composited
  const draws = (exportSrc.match(/drawImage\(/g) || []).length;
  assert.ok(draws >= 2, 'expected main + RSI drawImage calls, got ' + draws);
});

// ---- 5. Metrics are not truncated at 200 characters ----
test('exporter builds full metrics and never slices to 200 chars', () => {
  assert.doesNotMatch(exportSrc, /\.slice\(0,\s*200\)/);
  for (const label of ['Last', 'Vol', 'AvgVol20', 'Vol/Avg', 'RSI14', 'MA20', 'MA50', 'MA200']) {
    assert.ok(exportSrc.indexOf("'" + label + "'") >= 0, 'metrics must include ' + label);
  }
});

// ---- 6 & 7. DPR=1 and DPR=2 output dimensions are correct ----
// (compare fields, not object identity: the helper runs in a separate vm realm)
function assertSize(actual, w, h, msg) {
  assert.equal(actual.width, w, (msg || '') + ' width');
  assert.equal(actual.height, h, (msg || '') + ' height');
}
test('computeExportBitmapSize is correct at DPR=1', () => {
  assertSize(H.computeExportBitmapSize(800, 600, 1), 800, 600, 'dpr1');
});
test('computeExportBitmapSize is correct at DPR=2', () => {
  assertSize(H.computeExportBitmapSize(800, 600, 2), 1600, 1200, 'dpr2');
  assertSize(H.computeExportBitmapSize(375, 500, 3), 1125, 1500, 'dpr3');
});
test('computeExportBitmapSize falls back to DPR=1 for invalid dpr', () => {
  assertSize(H.computeExportBitmapSize(100, 100, 0), 100, 100, 'dpr0');
  assertSize(H.computeExportBitmapSize(100, 100, undefined), 100, 100, 'dprUndef');
});

// ---- 8. Canvas context scaling is applied once, consistently ----
test('exporter scales the 2D context by DPR exactly once', () => {
  assert.match(exportSrc, /ctx\.scale\(dpr,\s*dpr\)/);
  const scales = (exportSrc.match(/ctx\.scale\(/g) || []).length;
  assert.equal(scales, 1, 'context should be scaled exactly once');
  assert.match(exportSrc, /window\.devicePixelRatio/);
  // CSS sizes derived from screenshot bitmap / dpr (no raw bitmap-px text mixing)
  assert.match(exportSrc, /mainShot\.width\s*\/\s*dpr/);
  assert.match(exportSrc, /mainShot\.height\s*\/\s*dpr/);
});

// ---- 9. Export waits for chart instances to exist ----
test('exporter guards on a ready chart instance and waits for frames before screenshotting', () => {
  assert.match(exportSrc, /if\s*\(!entry\s*\|\|\s*!entry\.mainChart/);
  assert.match(exportSrc, /requestAnimationFrame/);
  // the ready guard appears before any screenshot is taken
  const guardIdx = exportSrc.indexOf('!entry.mainChart');
  const shotIdx = exportSrc.indexOf('takeScreenshot()');
  assert.ok(guardIdx >= 0 && shotIdx > guardIdx, 'guard must precede screenshot');
});

// ---- 10. Export failure produces a friendly error and never a blank download ----
test('exporter shows a friendly toast on failure and only downloads after compositing', () => {
  assert.match(exportSrc, /showToast/);
  const failGuardIdx = exportSrc.indexOf('return fail(');
  const toDataUrlIdx = exportSrc.indexOf('toDataURL');
  assert.ok(failGuardIdx >= 0, 'must have an early fail() guard');
  assert.ok(toDataUrlIdx > failGuardIdx, 'download (toDataURL) must come after the ready guard');
  // link.click only happens inside the try, after drawImage/compose
  const drawIdx = exportSrc.indexOf('drawImage(');
  const clickIdx = exportSrc.indexOf('link.click()');
  assert.ok(clickIdx > drawIdx, 'click must occur after drawing the chart');
});

// ---- 11. Re-render cleans up old chart instances + observers ----
test('render disposes prior + stale charts; disposeChart tears down observers and chart instances', () => {
  assert.match(renderSrc, /disposeChart\(chartId\)/);
  assert.match(renderSrc, /disposeStaleCharts\(\)/);
  assert.match(disposeSrc, /observers[\s\S]*disconnect/);
  assert.match(disposeSrc, /mainChart[\s\S]*remove\(\)/);
  assert.match(disposeSrc, /rsiChart[\s\S]*remove\(\)/);
  // registry entry is populated with both instances + metadata for export
  assert.match(renderSrc, /_chartRegistry\[chartId\]\s*=/);
  assert.match(renderSrc, /mainChart:\s*chart/);
  assert.match(renderSrc, /observers:\s*_observers/);
});

// ---- 12. Chart-page height mismatch (350 vs 280) is gone ----
test('no hardcoded 350px container / 280px chart mismatch; height is a single responsive source', () => {
  assert.doesNotMatch(loadChartPageSrc, /height:350px/);
  assert.match(loadChartPageSrc, /chartDims\(\s*['"]page['"]\s*\)/);
  // render uses dims.main (not a hardcoded 280) and syncs the container height
  assert.doesNotMatch(renderSrc, /height:\s*280\b/);
  assert.match(renderSrc, /height:\s*dims\.main/);
  assert.match(renderSrc, /container\.style\.height\s*=\s*dims\.main/);
});

// ---- 13. Mobile chart dimensions fit a 320px-wide container ----
test('chartDims keeps the chart within a 320px container and stays positive', () => {
  const page320 = H.chartDims('page', 320);
  const inline320 = H.chartDims('inline', 320);
  assert.ok(page320.main > 0 && page320.main <= 320, 'page main height sane on mobile: ' + page320.main);
  assert.ok(inline320.main > 0 && inline320.main <= 320, 'inline main height sane on mobile');
  // desktop is taller than mobile (responsive), and RSI stays proportionate
  assert.ok(H.chartDims('page', 1440).main > page320.main, 'desktop taller than mobile');
  assert.ok(page320.rsi > 0 && page320.rsi <= page320.main);
  // width always driven by the container (never a fixed width => no horizontal overflow)
  assert.match(renderSrc, /width:\s*container\.clientWidth/);
});

// ---- 14. Mobile vertical touch scrolling is not trapped ----
test('main chart allows vertical page scroll (vertTouchDrag:false) while keeping horizontal pan', () => {
  assert.match(renderSrc, /vertTouchDrag:\s*false/);
  assert.match(renderSrc, /horzTouchDrag:\s*true/);
  assert.match(renderSrc, /handleScroll:/);
  assert.match(renderSrc, /handleScale:/);
});

// ---- 15. Orientation / ResizeObserver updates main AND RSI widths ----
test('both charts use rAF-batched resize observers that update width (and responsive height)', () => {
  assert.match(renderSrc, /observeChartResize\(container/);
  assert.match(renderSrc, /observeChartResize\(rsiContainer/);
  // each resize callback updates chart width
  const applyWidths = (renderSrc.match(/applyOptions\(\{\s*width:\s*w/g) || []).length;
  assert.ok(applyWidths >= 2, 'both charts update width on resize, got ' + applyWidths);
  assert.match(extractFunction('function observeChartResize('), /requestAnimationFrame/);
});

// ---- 16. Data / calculation isolation: stock inputs and formulas unchanged ----
test('data + indicator calculations are untouched (RSI/MA formulas + API calls intact)', () => {
  // RSI formula unchanged
  assert.match(renderSrc, /100\s*-\s*100\s*\/\s*\(1\s*\+\s*ag\s*\/\s*al\)/);
  // MA computed as simple moving average sum/period
  assert.match(renderSrc, /sum\s*\/\s*period/);
  // candles fed as-is, order preserved
  assert.match(renderSrc, /candleSeries\.setData\(candles\)/);
  // endpoints unchanged
  assert.match(loadChartPageSrc, /\/api\/candles\?ticker=/);
  assert.match(renderSrc, /\/api\/quote\?ticker=/);
});

// ---- 17. Deterministic, sanitized export filename (WIB) ----
test('buildChartExportFilename is deterministic, WIB-based, and sanitized', () => {
  // 2026-07-19 14:39 UTC -> 21:39 WIB
  const fixed = new Date(Date.UTC(2026, 6, 19, 14, 39, 0));
  assert.equal(H.buildChartExportFilename('DEWA', fixed), 'auto-cuan-DEWA-chart-2026-07-19-2139-WIB.png');
  // sanitize unsafe characters + spaces, uppercase
  assert.equal(H.buildChartExportFilename('bb ca/#!', fixed), 'auto-cuan-BBCA-chart-2026-07-19-2139-WIB.png');
  // empty ticker falls back
  assert.equal(H.buildChartExportFilename('', fixed), 'auto-cuan-CHART-chart-2026-07-19-2139-WIB.png');
  // no spaces / unsafe chars in the final name
  assert.doesNotMatch(H.buildChartExportFilename('X Y', fixed), /[^A-Za-z0-9.\-]/);
  // WIB display stamp
  assert.equal(H.formatWibStamp(fixed), '2026-07-19 21:39 WIB');
});

// ---- 18. API endpoint count remains exactly 12 ----
test('api/ still exposes exactly 12 endpoint JS files (no backend added/removed)', () => {
  const files = fs.readdirSync(path.join(ROOT, 'api')).filter((f) => f.endsWith('.js'));
  assert.equal(files.length, 12, 'expected 12 API endpoints, found ' + files.length + ': ' + files.join(', '));
});

// ---- Extra: every inline <script> block still parses (guards against syntax breakage) ----
test('all inline <script> blocks in index.html parse without syntax errors', () => {
  const re = /<script(\b[^>]*)>([\s\S]*?)<\/script>/gi;
  let m, checked = 0;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;
    if (/type\s*=\s*["'](?!text\/javascript|module|application\/javascript)/.test(attrs)) continue;
    checked++;
    assert.doesNotThrow(() => new vm.Script(m[2]), 'inline script block #' + checked + ' should parse');
  }
  assert.ok(checked >= 1);
});
