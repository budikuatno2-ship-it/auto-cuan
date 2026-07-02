'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// Source-level guards for dashboard loading behavior in public/index.html.
// These are static assertions (no DOM needed) confirming the anti-stuck-loading
// and lazy-admin-preview logic is present.
const html = fs.readFileSync('public/index.html', 'utf8');

test('robust empty detection handles top5_locked=false + empty arrays (not only awaiting_locked_rows)', () => {
  const fnStart = html.indexOf('function renderDashboardTop5MonitorData');
  assert.ok(fnStart >= 0);
  const fnBody = html.slice(fnStart, fnStart + 1200);
  assert.ok(fnBody.indexOf("top5_source === 'awaiting_locked_rows'") >= 0, 'keeps awaiting_locked_rows check');
  assert.ok(fnBody.indexOf('top5_locked === false') >= 0, 'adds top5_locked=false empty detection');
  assert.ok(/top5Rows\.length === 0 && monitorRows\.length === 0/.test(fnBody), 'treats both-empty arrays as awaiting');
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

test('normal dashboard fetch does NOT pass generate_preview (no heavy compute on load)', () => {
  const fnStart = html.indexOf('async function loadDashboardTop5Monitor');
  const fnEnd = html.indexOf('function renderDashboardTop5MonitorData');
  const fnBody = html.slice(fnStart, fnEnd);
  assert.ok(fnBody.indexOf('action=web-daily-picks') >= 0);
  assert.ok(fnBody.indexOf('generate_preview=1') < 0, 'normal dashboard load must not request generate_preview');
});

test('admin generate preview uses explicit generate_preview=1 and longer timeout', () => {
  const fnStart = html.indexOf('async function loadAdminNextTop5Preview');
  const fnBody = html.slice(fnStart, fnStart + 1400);
  assert.ok(fnBody.indexOf('generate_preview=1') >= 0, 'generate uses explicit flag');
  assert.ok(/,\s*45000\)/.test(fnBody) || /,\s*60000\)/.test(fnBody), 'admin preview uses longer (>=45s) timeout');
});

test('admin preview cache stores only sanitized fields (no raw_payload/debug/internal)', () => {
  const fnStart = html.indexOf('function _setAdminPreviewCache');
  const fnBody = html.slice(fnStart, fnStart + 1400);
  assert.ok(fnBody.indexOf('delete c.raw_payload') >= 0, 'strips raw_payload');
  assert.ok(fnBody.indexOf('delete c.detail') >= 0, 'strips detail');
});
