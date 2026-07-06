'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// Source-level guards for dashboard loading behavior in public/index.html.
// These are static assertions (no DOM needed) confirming the anti-stuck-loading
// and lazy-admin-preview logic is present.
const html = fs.readFileSync('public/index.html', 'utf8');

test('dashboard renders only locked/final Top 5 sources and treats preview/provisional as awaiting', () => {
  const fnStart = html.indexOf('function renderDashboardTop5MonitorData');
  assert.ok(fnStart >= 0);
  const fnBody = html.slice(fnStart, fnStart + 1400);
  assert.ok(fnBody.indexOf("top5_source === 'locked_rows'") >= 0, 'allows same-day locked rows');
  assert.ok(fnBody.indexOf("top5_source === 'locked_rows_fallback'") >= 0, 'allows previous locked fallback rows');
  assert.ok(fnBody.indexOf('data.web_provisional === true') >= 0, 'blocks provisional dashboard rendering');
  assert.ok(fnBody.indexOf('!isLockedFinalSource') >= 0, 'non-final sources must render as awaiting');
  assert.ok(fnBody.indexOf('!hasTop5Data && monitorRows.length === 0') >= 0, 'treats no-top5-data + empty-monitor as awaiting');
});

test('dashboard load has fallback timeout that clears both Top 5 and Monitor placeholders', () => {
  const fnStart = html.indexOf('async function loadDashboardTop5Monitor');
  const fnEnd = html.indexOf('function renderDashboardTop5MonitorData');
  const fnBody = html.slice(fnStart, fnEnd);
  assert.ok(fnBody.indexOf('setTimeout(') >= 0, 'has fallback timer');
  assert.ok(fnBody.indexOf("indexOf('Memuat Top 5')") >= 0, 'targets Top 5 placeholder');
  assert.ok(fnBody.indexOf("indexOf('Memuat monitor')") >= 0, 'targets Monitor placeholder');
  assert.ok(fnBody.indexOf('clearTimeout(_fallbackTimer)') >= 0, 'clears timer in finally');
  assert.ok(fnBody.indexOf('_dashboardTop5InFlight = null') >= 0, 'resets in-flight flag');
});

test('History load is deferred and independent, with its own fallback + in-flight reset', () => {
  // Deferred after first paint (2s), not blocking Top 5/Monitor
  assert.ok(html.indexOf('loadTop5History(true); }, 2000)') >= 0, 'history deferred ~2s');
  const fnStart = html.indexOf('async function loadTop5History');
  const fnEnd = html.indexOf('async function archiveTop5History');
  const fnBody = html.slice(fnStart, fnEnd);
  assert.ok(fnBody.indexOf('_histFallbackTimer') >= 0, 'history has fallback timer');
  assert.ok(fnBody.indexOf('_top5HistoryInFlight = null') >= 0, 'history resets in-flight flag');
});

test('normal dashboard fetch only requests locked web-daily-picks (no admin preview or heavy compute)', () => {
  const fnStart = html.indexOf('async function loadDashboardTop5Monitor');
  const fnEnd = html.indexOf('function renderDashboardTop5MonitorData');
  const fnBody = html.slice(fnStart, fnEnd);
  assert.ok(fnBody.indexOf('action=web-daily-picks') >= 0);
  assert.ok(fnBody.indexOf('admin_preview=1') < 0, 'dashboard load must not call admin preview');
  assert.ok(fnBody.indexOf('generate_preview=1') < 0, 'dashboard load must not request preview regeneration');
  assert.ok(fnBody.indexOf('renderAdminNextTop5Preview') < 0, 'dashboard load must not render admin preview');
});


test('dashboard detail onclick handlers reference an existing openDashboardPickDetail function', () => {
  assert.ok(html.indexOf('function openDashboardPickDetail(ticker)') >= 0, 'openDashboardPickDetail must exist');
  assert.ok(html.indexOf("openScrDetail(r, /Day Trade/i.test(r.category || '') ? 'daytrade' : 'konglo')") >= 0,
    'openDashboardPickDetail must route to screener detail with daytrade/konglo type');
  const dashboardStart = html.indexOf('<!-- Compact Top 5 + Monitor -->');
  const dashboardEnd = html.indexOf('<!-- Modal Detail Screener -->');
  const dashboardHtml = html.slice(dashboardStart, dashboardEnd > dashboardStart ? dashboardEnd : undefined);
  const detailRefs = dashboardHtml.match(/openDashboardPickDetail\(/g) || [];
  assert.ok(detailRefs.length > 0, 'dashboard should have detail click handlers');
  assert.ok(detailRefs.every(() => html.indexOf('function openDashboardPickDetail(ticker)') >= 0),
    'dashboard detail handlers must not reference a missing function');
});

test('Preview Top 5 Besok panel and preview buttons are not rendered in dashboard HTML', () => {
  assert.equal(html.indexOf('Preview Top 5 Besok'), -1, 'preview panel title must stay removed');
  assert.equal(html.indexOf('Refresh Preview'), -1, 'refresh preview button must stay removed');
  assert.equal(html.indexOf('Generate Admin Preview'), -1, 'generate preview button must stay removed');
  assert.equal(html.indexOf('adminNextTop5PreviewSection'), -1, 'preview section element must stay removed');
  assert.equal(html.indexOf('loadAdminNextTop5Preview'), -1, 'preview loader must not be callable from dashboard');
});

test('global watchdog function clearStuckDashboardLoadingPlaceholders exists', () => {
  assert.ok(html.indexOf('function clearStuckDashboardLoadingPlaceholders()') >= 0, 'watchdog function defined');
  // Must check both Top 5 and Monitor textContent for loading text
  const fnStart = html.indexOf('function clearStuckDashboardLoadingPlaceholders()');
  const fnBody = html.slice(fnStart, fnStart + 800);
  assert.ok(fnBody.indexOf('dashboardTop5List') >= 0, 'checks Top 5 element');
  assert.ok(fnBody.indexOf('dashboardMonitorList') >= 0, 'checks Monitor element');
  assert.ok(fnBody.indexOf("Memuat Top 5") >= 0, 'detects Top 5 loading text');
  assert.ok(fnBody.indexOf("Memuat monitor") >= 0, 'detects Monitor loading text');
  assert.ok(fnBody.indexOf('dashboardAwaitingLockedHtml') >= 0, 'replaces Top 5 with awaiting state');
  assert.ok(fnBody.indexOf('dashboardEmptyHtml') >= 0, 'replaces Monitor with empty state');
});

test('global 8s watchdog setTimeout fires unconditionally (not inside loadDashboardTop5Monitor)', () => {
  // The setTimeout(clearStuckDashboardLoadingPlaceholders, 8000) must exist at global scope
  assert.ok(html.indexOf('setTimeout(clearStuckDashboardLoadingPlaceholders, 8000)') >= 0, 'global 8s timer exists');
  // Must NOT be inside the loadDashboardTop5Monitor function
  const loadFnStart = html.indexOf('async function loadDashboardTop5Monitor');
  const loadFnEnd = html.indexOf('function renderDashboardTop5MonitorData');
  const loadFnBody = html.slice(loadFnStart, loadFnEnd);
  assert.ok(loadFnBody.indexOf('setTimeout(clearStuckDashboardLoadingPlaceholders') < 0, 'global timer must not be inside loadDashboardTop5Monitor');
});

test('static HTML does NOT show "Memuat Top 5..." or "Memuat monitor..." as default (safe fallback from page load)', () => {
  // The static HTML within the dashboard section should use safe fallback, not loading text
  const top5Static = html.slice(html.indexOf('id="dashboardTop5List"'), html.indexOf('id="dashboardTop5List"') + 200);
  const monStatic = html.slice(html.indexOf('id="dashboardMonitorList"'), html.indexOf('id="dashboardMonitorList"') + 200);
  assert.ok(top5Static.indexOf('Memuat Top 5') < 0, 'static Top 5 must not show loading text');
  assert.ok(monStatic.indexOf('Memuat monitor') < 0, 'static Monitor must not show loading text');
});
