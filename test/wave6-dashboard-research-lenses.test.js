'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');
const uiThemeCss = fs.readFileSync(path.join(rootDir, 'public', 'ui-theme.css'), 'utf8');
const bandarRuntime = fs.readFileSync(path.join(rootDir, 'public', 'bandarmologi-runtime.js'), 'utf8');
const analisisRuntime = fs.readFileSync(path.join(rootDir, 'public', 'analisis-saham-runtime.js'), 'utf8');
const partialHtml = fs.readFileSync(path.join(rootDir, 'partials', 'analisis-saham.partial.html'), 'utf8');
const publicPartialHtml = fs.readFileSync(path.join(rootDir, 'public', 'partials', 'analisis-saham.partial.html'), 'utf8');

// ============================================================
// 1. DASHBOARD CONTRACT (DESIGN.md §15, §82)
// ============================================================

test('Dashboard: #page-dashboard carries data-ac-ui="v2"', () => {
  assert.match(indexHtml, /<div\s+id="page-dashboard"[^>]*data-ac-ui="v2"/);
});

test('Dashboard: Auto Monitor is strictly hidden/encapsulated and Top 5 panel occupies full width', () => {
  assert.match(indexHtml, /<aside[^>]*aria-label="Auto Monitor"[^>]*hidden[^>]*style="display:none\s*!important;"/);
  assert.match(indexHtml, /<section[^>]*class="radar-panel\s+w-full\s+panel"[^>]*aria-label="Top 5 Radar"/);
});

test('Dashboard: Continuous calm market-condition strip CSS with internal hairline dividers', () => {
  assert.match(uiThemeCss, /#page-dashboard\[data-ac-ui="v2"\]\s+\.market-band-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(uiThemeCss, /#page-dashboard\[data-ac-ui="v2"\]\s+\.market-tile\s*\{[^}]*border-right:\s*1px\s+solid/);
});

test('Dashboard: renderDashboardTop5 renders compact decision rows with rank, ticker, setup, price, score, grade, risk, R/R, action', () => {
  const fnMatch = indexHtml.match(/function renderDashboardTop5\(picks\)[\s\S]*?^}/m);
  assert.ok(fnMatch, 'renderDashboardTop5 must exist');
  const body = fnMatch[0];

  assert.match(body, /dashboard-decision-row/);
  assert.match(body, /dash-rank/);
  assert.match(body, /dashFmtPrice\(r\.last_price\)/);
  assert.match(body, /getSignalQualityGrade/);
  assert.match(body, /getRiskLabel/);
  assert.match(body, /openDashboardPickDetail\(/);
  assert.match(body, /_dashboardPickData\[r\.ticker\]\s*=\s*r/);
});

test('Dashboard: dashboardExcludedHtml renders subtle low-noise footnote disclosure', () => {
  assert.match(indexHtml, /function dashboardExcludedHtml\(excluded\)\s*\{[\s\S]*?dashboard-excluded-disclosure/);
});

test('Dashboard: renderTop5History renders compact audit table with tabular numerals', () => {
  const fnMatch = indexHtml.match(/function renderTop5History\(activeRows,\s*tpRows\)[\s\S]*?^}/m);
  assert.ok(fnMatch, 'renderTop5History must exist');
  const body = fnMatch[0];

  assert.match(body, /<table[^>]*tabular-nums/);
  assert.match(body, /<thead[^>]*sticky/);
  assert.match(body, /Tanggal/);
  assert.match(body, /Ticker/);
  assert.match(body, /Entry Aktif/);
  assert.match(body, /TP1/);
  assert.match(body, /Stop Loss/);
  assert.match(body, /Gain \/ Distance/);
  assert.match(body, /openDashboardPickDetail\(/);
});

// ============================================================
// 2. ANALISIS & CHART CONTRACT (DESIGN.md §19, §82)
// ============================================================

test('Analisis & Chart: Sub-tabs Analisis AI and Chart & AI Vision exist and match across partials and inline template', () => {
  const inlineTemplateMatch = indexHtml.match(/<template id="tpl-analisis-saham">([\s\S]*?)<\/template>/);
  assert.ok(inlineTemplateMatch, 'tpl-analisis-saham must be present');
  const inline = inlineTemplateMatch[1].trim();

  assert.equal(inline, partialHtml.trim(), 'canonical partial and embedded template must be identical');
  assert.equal(partialHtml.trim(), publicPartialHtml.trim(), 'public partial and canonical partial must be identical');

  assert.match(partialHtml, /data-subtab="ai"[^>]*>[\s\S]*?Analisis AI/);
  assert.match(partialHtml, /data-subtab="chart"[^>]*>[\s\S]*?Chart &amp; AI Vision/);
});

test('Analisis & Chart: Standalone page-chart compatibility surface remains preserved', () => {
  assert.match(indexHtml, /id="page-chart"/, 'page-chart compatibility surface must remain in DOM');
});

// ============================================================
// 3. BANDARMOLOGI MOTION RESTRAINT (DESIGN.md §18.1, §21, §82)
// ============================================================

test('Bandarmologi: continuous floating bubble physics acBubbleFloat1-4 eliminated', () => {
  assert.equal(bandarRuntime.indexOf('@keyframes acBubbleFloat1'), -1, 'acBubbleFloat1 keyframe must be removed');
  assert.equal(bandarRuntime.indexOf('@keyframes acBubbleFloat2'), -1, 'acBubbleFloat2 keyframe must be removed');
  assert.equal(bandarRuntime.indexOf('@keyframes acBubbleFloat3'), -1, 'acBubbleFloat3 keyframe must be removed');
  assert.equal(bandarRuntime.indexOf('@keyframes acBubbleFloat4'), -1, 'acBubbleFloat4 keyframe must be removed');
  assert.equal(bandarRuntime.indexOf('acBubbleFloat'), -1, 'no references to acBubbleFloat in bandarmologi-runtime.js');
});

test('Bandarmologi: prefers-reduced-motion respected in bubble styles and theme css', () => {
  assert.match(bandarRuntime, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.ac-broker-bubble\s*\{[\s\S]*?animation:\s*none\s*!important/);
  assert.match(uiThemeCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.ac-broker-bubble/);
});

// ============================================================
// 4. SINYAL INTELIJEN SCANNER (DESIGN.md §22, §82)
// ============================================================

test('Sinyal Intelijen: table-first scanner mode and local error handling present', () => {
  assert.match(bandarRuntime, /id="panel-intel-scanner"/);
  assert.match(bandarRuntime, /<table class="w-full text-left text-xs">/);
  assert.match(bandarRuntime, /Data intelijen emiten belum tersedia/);
});

// ============================================================
// 5. BROKER HUNTER LAYOUT (DESIGN.md §23, §82)
// ============================================================

test('Broker Hunter: broker-first primary context and denser tables', () => {
  assert.match(bandarRuntime, /Broker Hunter — Top 10 Saham per Broker/);
  assert.match(bandarRuntime, /Top 10 Akumulasi \(Net Buy\)/);
  assert.match(bandarRuntime, /Top 10 Distribusi \(Net Sell\)/);
  assert.match(bandarRuntime, /overflow-x-auto/);
});

// ============================================================
// 6. INSIDER NETWORK DETERMINISTIC GRAPH (DESIGN.md §18.1, §24, §82)
// ============================================================

test('Insider Network: spinning orbit loops and neon blur filters eliminated', () => {
  assert.equal(bandarRuntime.indexOf('animation: solarOrbit'), -1, 'solarOrbit animation must be removed');
  assert.equal(bandarRuntime.indexOf('animation: satelliteOrbit'), -1, 'satelliteOrbit animation must be removed');
  assert.equal(bandarRuntime.indexOf('animation: sunPulse'), -1, 'sunPulse animation must be removed');
  assert.equal(bandarRuntime.indexOf('animation: sunCoronaRotate'), -1, 'sunCoronaRotate animation must be removed');
  assert.equal(bandarRuntime.indexOf('feGaussianBlur'), -1, 'feGaussianBlur filter must be removed');
});

// ============================================================
// 7. RANKING SPREADSHEET TABLE (DESIGN.md §25, §82)
// ============================================================

test('Ranking: # rank index column, tabular numerals, and em-dash fallback for missing data', () => {
  assert.match(analisisRuntime, /<th[^>]*>#<\/th>/, 'Ranking table must have # rank index header column');
  assert.match(analisisRuntime, /<td[^>]*>\'\s*\+\s*\(idx\s*\+\s*1\)\s*\+\s*\'<\/td>/, 'Ranking rows must have 1-based rank number');
  assert.match(analisisRuntime, /<table[^>]*tabular-nums\s+lining-nums/, 'Ranking table must use tabular-nums lining-nums');

  // Verify missing value fallback is '—' and NOT 'N/A'
  const cellFnMatch = analisisRuntime.match(/function rankingCellHtml\(row,\s*col\)[\s\S]*?^  }/m);
  assert.ok(cellFnMatch, 'rankingCellHtml must exist');
  assert.match(cellFnMatch[0], /<span class="text-gray-500">—<\/span>/, 'Missing data fallback must be em-dash');
  assert.equal(cellFnMatch[0].indexOf('>N/A<'), -1, 'No N/A fallback in rankingCellHtml');
});

// ============================================================
// 8. PATTERN RADAR ISOLATION (DESIGN.md §18, §82)
// ============================================================

test('Pattern Radar: strictly admin-only and isolated from normal navigation', () => {
  const patternStableJs = fs.readFileSync(path.join(rootDir, 'public', 'pattern-stable-runtime.js'), 'utf8');
  assert.match(patternStableJs, /isBudiAdmin\(\)/);
  assert.match(patternStableJs, /tabPattern\.classList\.add\('hidden'\)/);
  assert.match(patternStableJs, /tabPattern\.style\.display\s*=\s*'none'/);
});
