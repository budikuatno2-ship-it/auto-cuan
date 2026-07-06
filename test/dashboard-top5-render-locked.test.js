'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Static source-level assertions verifying the frontend render logic for
// Dashboard Top 5 locked rows display in public/index.html.
// No external dependencies needed — reads source file as text.

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// ============================================================
// HELPER: extract renderDashboardTop5MonitorData function body
// ============================================================
function getRenderFnBody() {
  const fnStart = html.indexOf('function renderDashboardTop5MonitorData(data)');
  assert.ok(fnStart >= 0, 'renderDashboardTop5MonitorData must exist');
  const fnEnd = html.indexOf('\nfunction startDashboardMonitorAutoRefresh', fnStart);
  assert.ok(fnEnd > fnStart, 'function boundary found');
  return html.slice(fnStart, fnEnd);
}

function getLoadFnBody() {
  const fnStart = html.indexOf('async function loadDashboardTop5Monitor(silent, opts)');
  assert.ok(fnStart >= 0, 'loadDashboardTop5Monitor must exist');
  const fnEnd = html.indexOf('\nfunction renderDashboardTop5MonitorData', fnStart);
  assert.ok(fnEnd > fnStart, 'function boundary found');
  return html.slice(fnStart, fnEnd);
}

// ============================================================
// TEST: backend-like payload with top5_locked true + top5 rows renders Top 5 cards
// ============================================================
test('renderDashboardTop5MonitorData: top5_locked=true + top5 rows takes render path (not awaiting)', () => {
  const fnBody = getRenderFnBody();
  // isLockedFinalSource must be true when top5_locked===true && source is locked_rows
  assert.ok(fnBody.indexOf("data.top5_locked === true") >= 0, 'checks top5_locked strict equality');
  assert.ok(fnBody.indexOf("data.top5_source === 'locked_rows'") >= 0, 'checks locked_rows source');
  // When isLockedFinalSource=true and hasTop5Data=true, isAwaiting must be false
  // The condition uses !hasTop5Data (not top5Rows.length===0 alone)
  assert.ok(fnBody.indexOf('var hasTop5Data = top5Rows.length > 0') >= 0, 'hasTop5Data is derived from top5Rows.length');
  assert.ok(fnBody.indexOf('!hasTop5Data && monitorRows.length === 0') >= 0, 'awaiting requires BOTH no top5 AND no monitor');
  // The else branch calls renderDashboardTop5 (actual card render)
  assert.ok(fnBody.indexOf('renderDashboardTop5(top5Rows)') >= 0, 'else branch renders Top 5 cards');
  assert.ok(fnBody.indexOf('renderDashboardMonitor(monitorRows') >= 0, 'else branch renders monitor');
});

// ============================================================
// TEST: locked_rows_fallback + top5 rows renders Top 5 cards
// ============================================================
test('renderDashboardTop5MonitorData: locked_rows_fallback source also treated as locked/final', () => {
  const fnBody = getRenderFnBody();
  // isLockedFinalSource must accept locked_rows_fallback
  assert.ok(fnBody.indexOf("data.top5_source === 'locked_rows_fallback'") >= 0, 'accepts locked_rows_fallback as final source');
  // The isLockedFinalSource condition uses OR between locked_rows and locked_rows_fallback
  const lockedCheck = fnBody.slice(
    fnBody.indexOf('var isLockedFinalSource'),
    fnBody.indexOf('var hasTop5Data')
  );
  assert.ok(lockedCheck.indexOf("'locked_rows'") >= 0, 'locked_rows in isLockedFinalSource');
  assert.ok(lockedCheck.indexOf("'locked_rows_fallback'") >= 0, 'locked_rows_fallback in isLockedFinalSource');
});

// ============================================================
// TEST: empty monitor but non-empty top5 still renders
// ============================================================
test('renderDashboardTop5MonitorData: empty monitor + non-empty top5 does NOT trigger awaiting', () => {
  const fnBody = getRenderFnBody();
  // The awaiting condition for empty data is: (!hasTop5Data && monitorRows.length === 0)
  // This means if top5 has data (hasTop5Data=true), the empty monitor alone does NOT trigger awaiting
  assert.ok(fnBody.indexOf('!hasTop5Data && monitorRows.length === 0') >= 0,
    'awaiting empty check requires BOTH top5 empty AND monitor empty');
  // Confirm the old bug pattern is NOT present
  assert.equal(fnBody.indexOf('top5Rows.length === 0 && monitorRows.length === 0'), -1,
    'old bug pattern (top5Rows.length===0 && monitorRows.length===0) must be removed');
});

// ============================================================
// TEST: stale awaiting cache does not block fresh locked response
// ============================================================
test('loadDashboardTop5Monitor: stale awaiting_locked_rows cache is NOT served from cache', () => {
  const fnBody = getLoadFnBody();
  // Cache check must include a guard against awaiting_locked_rows source
  assert.ok(fnBody.indexOf("top5_source !== 'awaiting_locked_rows'") >= 0,
    'cache check must reject awaiting_locked_rows cached responses');
  // The cache line should have all three conditions: data exists + fresh + not awaiting
  const cacheLine = fnBody.split('\n').find(line => line.indexOf('_dashboardTop5Cache.data') >= 0 && line.indexOf('renderDashboardTop5MonitorData') >= 0);
  assert.ok(cacheLine, 'cache render line must exist');
  assert.ok(cacheLine.indexOf('Date.now() - _dashboardTop5Cache.at < 45000') >= 0, 'cache freshness check present');
  assert.ok(cacheLine.indexOf("top5_source !== 'awaiting_locked_rows'") >= 0, 'cache awaiting guard present');
});

// ============================================================
// TEST: Preview Top 5 Besok remains absent
// ============================================================
test('Dashboard HTML still has no Preview Top 5 Besok or admin preview UI', () => {
  assert.equal(html.indexOf('Preview Top 5 Besok'), -1, 'Preview Top 5 Besok must not exist');
  assert.equal(html.indexOf('Refresh Preview'), -1, 'Refresh Preview button must not exist');
  assert.equal(html.indexOf('Generate Admin Preview'), -1, 'Generate Admin Preview button must not exist');
  assert.equal(html.indexOf('adminNextTop5PreviewSection'), -1, 'preview section element must not exist');
  assert.equal(html.indexOf('loadAdminNextTop5Preview'), -1, 'preview loader function must not exist');
});

// ============================================================
// TEST: Dashboard fetch URL remains clean (no admin_preview/generate_preview)
// ============================================================
test('Dashboard fetch still uses clean web-daily-picks URL without preview params', () => {
  const fnBody = getLoadFnBody();
  assert.ok(fnBody.indexOf('action=web-daily-picks') >= 0, 'fetches web-daily-picks action');
  assert.equal(fnBody.indexOf('admin_preview'), -1, 'no admin_preview in fetch URL');
  assert.equal(fnBody.indexOf('generate_preview'), -1, 'no generate_preview in fetch URL');
});

// ============================================================
// TEST: renderDashboardTop5MonitorData does not depend on monitor rows for locked render
// ============================================================
test('renderDashboardTop5MonitorData: render branch does not require monitorRows > 0', () => {
  const fnBody = getRenderFnBody();
  // The render branch (else) must call renderDashboardTop5 regardless of monitorRows
  // The isAwaiting condition only checks monitor in conjunction with top5 being empty
  const awaitingCondition = fnBody.slice(
    fnBody.indexOf('var isAwaiting'),
    fnBody.indexOf('if (isAwaiting)')
  );
  // monitorRows.length appears only in the (!hasTop5Data && monitorRows.length === 0) check
  // NOT as a standalone condition
  const monitorRefs = awaitingCondition.match(/monitorRows\.length/g) || [];
  assert.equal(monitorRefs.length, 1, 'monitorRows.length checked only once (in conjunction with !hasTop5Data)');
});

// ============================================================
// TEST: hasTop5Data variable is properly computed from data.top5 || data.picks
// ============================================================
test('renderDashboardTop5MonitorData: top5Rows derived from data.top5 || data.picks', () => {
  const fnBody = getRenderFnBody();
  assert.ok(fnBody.indexOf('var top5Rows = data.top5 || data.picks || []') >= 0,
    'top5Rows falls back from data.top5 to data.picks to empty array');
  assert.ok(fnBody.indexOf('var hasTop5Data = top5Rows.length > 0') >= 0,
    'hasTop5Data checks top5Rows has at least one element');
});


// ============================================================
// TEST: Dashboard fetch uses getAuthHeaders() (not raw localStorage)
// ============================================================
test('loadDashboardTop5Monitor uses getAuthHeaders() for fetch headers', () => {
  const fnBody = getLoadFnBody();
  // Must use getAuthHeaders() which sends proper X-Username from getUsername()
  assert.ok(fnBody.indexOf('headers: getAuthHeaders()') >= 0,
    'fetch must use getAuthHeaders() for proper username/user-id headers');
  // Must NOT use getDashboardAuthHeaders() directly for fetch (it should delegate)
  const fetchLines = fnBody.split('\n').filter(line => line.indexOf('fetchDashboardJson') >= 0 && line.indexOf('headers:') >= 0);
  assert.ok(fetchLines.length >= 1, 'at least one fetchDashboardJson call with headers');
  assert.ok(fetchLines[0].indexOf('getAuthHeaders()') >= 0, 'first fetch uses getAuthHeaders()');
});

// ============================================================
// TEST: getDashboardAuthHeaders delegates to getAuthHeaders
// ============================================================
test('getDashboardAuthHeaders delegates to getAuthHeaders', () => {
  assert.ok(html.indexOf('function getDashboardAuthHeaders() { return getAuthHeaders(); }') >= 0,
    'getDashboardAuthHeaders must delegate to getAuthHeaders');
});

// ============================================================
// TEST: awaiting_locked_rows retry for logged-in users
// ============================================================
test('loadDashboardTop5Monitor retries with explicit headers when awaiting_locked_rows and logged in', () => {
  const fnBody = getLoadFnBody();
  // Must detect awaiting_locked_rows + isLoggedInUser() and retry
  assert.ok(fnBody.indexOf("data.top5_source === 'awaiting_locked_rows' && isLoggedInUser()") >= 0,
    'must check for awaiting_locked_rows + logged-in before retry');
  // Retry must use explicit headers with getUsername()
  assert.ok(fnBody.indexOf("'X-Username': getUsername()") >= 0,
    'retry must send explicit X-Username from getUsername()');
  assert.ok(fnBody.indexOf("'X-User-Id': localStorage.getItem('autocuan_user_id')") >= 0,
    'retry must send explicit X-User-Id');
  // Retry must only accept non-awaiting response
  assert.ok(fnBody.indexOf("retryFetched.data.top5_source !== 'awaiting_locked_rows'") >= 0,
    'retry must only use response if it is not awaiting_locked_rows');
});

// ============================================================
// TEST: awaiting_locked_rows is not cached for logged-in users
// ============================================================
test('loadDashboardTop5Monitor does not cache awaiting_locked_rows for logged-in users', () => {
  const fnBody = getLoadFnBody();
  // Cache write must be conditional — skip awaiting_locked_rows when logged in
  assert.ok(fnBody.indexOf("data.top5_source === 'awaiting_locked_rows' && isLoggedInUser()") >= 0,
    'cache condition checks awaiting + logged-in');
  // Must NOT unconditionally set _dashboardTop5Cache
  const cacheWrites = fnBody.split('\n').filter(line => line.indexOf('_dashboardTop5Cache = {') >= 0);
  assert.equal(cacheWrites.length, 1, 'only one cache write location');
  // The cache write must be inside a conditional that excludes awaiting_locked_rows
  const cacheWriteIdx = fnBody.indexOf('_dashboardTop5Cache = { at:');
  const precedingCode = fnBody.slice(Math.max(0, cacheWriteIdx - 100), cacheWriteIdx);
  assert.ok(precedingCode.indexOf("awaiting_locked_rows") >= 0,
    'cache write must be guarded by awaiting_locked_rows check');
});
