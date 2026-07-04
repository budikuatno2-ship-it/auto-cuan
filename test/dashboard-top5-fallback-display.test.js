'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  sanitizeTop5ResponseForAudience,
  buildDashboardPickRow,
  pickWasSentToTelegram
} = require('../api/sector-hot').__test;

// ============================================================
// HELPERS
// ============================================================

function makeLockedRow(ticker, overrides) {
  return Object.assign({
    id: Math.floor(Math.random() * 1000),
    date: '2025-07-03',
    ticker: ticker,
    category: 'Swing Konglo',
    entry1: 5000,
    entry2: 5050,
    sl: 4800,
    tp1: 5500,
    tp2: 5800,
    status: 'WAITING',
    first_sent_at: '2025-07-03T01:00:00.000Z',
    last_checked_at: null,
    is_final: false,
    raw_payload: {
      ticker: ticker,
      category: 'Swing Konglo',
      entry1: 5000, entry_low: 5000,
      entry2: 5050, entry_high: 5050,
      sl: 4800, stop_loss: 4800,
      tp1: 5500, tp1n: 5500,
      tp2: 5800, tp2n: 5800,
      last_price: 5025, lastn: 5025,
      risk_reward: 2.0,
      score: 78,
      risk_label_v2: 'Medium Risk',
      confidence: 'B',
      plan_quality_status: 'VALID',
      trading_plan_valid: true,
      action_label: 'Masih dekat entry',
      signal_verdict: 'Potensi swing moderat.',
      telegram_daily_sent_at: '2025-07-03T01:00:00.000Z'
    }
  }, overrides || {});
}

// ============================================================
// TEST 1: pickWasSentToTelegram identifies sent rows correctly
// ============================================================
test('pickWasSentToTelegram: row with telegram_daily_sent_at in raw_payload is considered sent', function() {
  var row = makeLockedRow('BBRI');
  assert.equal(pickWasSentToTelegram(row), true);
});

test('pickWasSentToTelegram: row without any sent timestamp returns false', function() {
  var row = makeLockedRow('BBRI', { raw_payload: { ticker: 'BBRI' } });
  assert.equal(pickWasSentToTelegram(row), false);
});

test('pickWasSentToTelegram: row with sent_to_telegram_at returns true', function() {
  var row = makeLockedRow('BBRI', { raw_payload: { ticker: 'BBRI', sent_to_telegram_at: '2025-07-03T01:00:00.000Z' } });
  assert.equal(pickWasSentToTelegram(row), true);
});

// ============================================================
// TEST 2: Fallback response with top5_is_watchlist=true passes through for logged-in users
// ============================================================
test('sanitizeTop5ResponseForAudience: fallback watchlist response preserves top5_is_watchlist for non-admin', function() {
  var response = sanitizeTop5ResponseForAudience({
    success: true,
    date: '2025-07-03',
    top5: [{ ticker: 'BBRI', rank: 1 }],
    monitor: [{ ticker: 'BBRI' }],
    top5_source: 'latest_sent_fallback',
    top5_locked: true,
    top5_is_watchlist: true,
    top5_fallback_date: '2025-07-03',
    update_note: 'Top 5 Watchlist / Pantauan Besok (data 2025-07-03). Manual latest snapshot. Bukan sinyal entry langsung.',
    web_provisional: false,
    picks: [{ ticker: 'BBRI', rank: 1 }]
  }, { allowAdminPreview: false });

  // top5_locked=true prevents sanitizer from overriding top5_source
  assert.equal(response.top5_locked, true);
  assert.equal(response.top5_source, 'latest_sent_fallback');
  assert.equal(response.top5_is_watchlist, true);
  assert.equal(response.top5_fallback_date, '2025-07-03');
  assert.ok(response.update_note.indexOf('Watchlist') >= 0 || response.update_note.indexOf('Pantauan') >= 0);
});

// ============================================================
// TEST 3: Normal locked response (not fallback) still works unchanged
// ============================================================
test('sanitizeTop5ResponseForAudience: normal locked_rows response stays unchanged', function() {
  var response = sanitizeTop5ResponseForAudience({
    success: true,
    date: '2025-07-04',
    top5: [{ ticker: 'TLKM', rank: 1 }],
    monitor: [{ ticker: 'TLKM' }],
    top5_source: 'locked_rows',
    top5_locked: true,
    top5_is_watchlist: false,
    top5_fallback_date: null,
    update_note: 'Top 5 Radar locked. Monitor update tiap 30 menit saat jam bursa.',
    web_provisional: false,
    picks: [{ ticker: 'TLKM', rank: 1 }]
  }, { allowAdminPreview: false });

  assert.equal(response.top5_locked, true);
  assert.equal(response.top5_source, 'locked_rows');
  assert.equal(response.top5_is_watchlist, false);
  assert.equal(response.top5_fallback_date, null);
});

// ============================================================
// TEST 4: Admin diagnostics are stripped for non-admin users
// ============================================================
test('sanitizeTop5ResponseForAudience: _admin_fallback_diagnostics stripped for non-admin', function() {
  var response = sanitizeTop5ResponseForAudience({
    success: true,
    date: '2025-07-03',
    top5: [{ ticker: 'BBRI', rank: 1 }],
    monitor: [],
    top5_source: 'latest_sent_fallback',
    top5_locked: true,
    top5_is_watchlist: true,
    top5_fallback_date: '2025-07-03',
    update_note: 'Top 5 Watchlist.',
    web_provisional: false,
    picks: [{ ticker: 'BBRI', rank: 1 }],
    _admin_fallback_diagnostics: {
      today_date: '2025-07-04',
      today_locked_count: 0,
      fallback_date: '2025-07-03',
      fallback_sent_count: 3,
      fallback_is_watchlist: true,
      reason_no_today: 'fallback_to_latest_sent'
    }
  }, { allowAdminPreview: false });

  // _admin_fallback_diagnostics must be stripped for non-admin
  assert.equal(response._admin_fallback_diagnostics, undefined);
});

// ============================================================
// TEST 5: Admin diagnostics are preserved when admin_preview is allowed
// ============================================================
test('sanitizeTop5ResponseForAudience: _admin_fallback_diagnostics preserved for admin', function() {
  var response = sanitizeTop5ResponseForAudience({
    success: true,
    date: '2025-07-03',
    top5: [{ ticker: 'BBRI', rank: 1 }],
    monitor: [],
    top5_source: 'latest_sent_fallback',
    top5_locked: true,
    top5_is_watchlist: true,
    top5_fallback_date: '2025-07-03',
    update_note: 'Top 5 Watchlist.',
    web_provisional: false,
    picks: [{ ticker: 'BBRI', rank: 1 }],
    _admin_fallback_diagnostics: {
      today_date: '2025-07-04',
      today_locked_count: 0,
      fallback_date: '2025-07-03',
      fallback_sent_count: 3,
      fallback_is_watchlist: true,
      reason_no_today: 'fallback_to_latest_sent'
    }
  }, { allowAdminPreview: true });

  // _admin_fallback_diagnostics preserved when admin
  assert.ok(response._admin_fallback_diagnostics);
  assert.equal(response._admin_fallback_diagnostics.today_date, '2025-07-04');
  assert.equal(response._admin_fallback_diagnostics.fallback_date, '2025-07-03');
  assert.equal(response._admin_fallback_diagnostics.reason_no_today, 'fallback_to_latest_sent');
});

// ============================================================
// TEST 6: Empty Top 5 still shows awaiting state (no fallback found)
// ============================================================
test('sanitizeTop5ResponseForAudience: no records found still shows awaiting for non-admin', function() {
  var response = sanitizeTop5ResponseForAudience({
    success: true,
    date: '2025-07-04',
    top5: [],
    monitor: [],
    top5_source: 'awaiting_locked_rows',
    top5_locked: false,
    top5_is_watchlist: false,
    top5_fallback_date: null,
    update_note: 'Top 5 belum locked.',
    web_provisional: false,
    picks: []
  }, { allowAdminPreview: false });

  assert.equal(response.top5_locked, false);
  assert.equal(response.top5_source, 'awaiting_locked_rows');
  assert.ok(response.update_note.length > 0);
});

// ============================================================
// TEST 7: Dashboard does not call generate_preview by default (source code check)
// ============================================================
test('dashboard normal load does NOT pass generate_preview=1', function() {
  var html = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'index.html'), 'utf-8');
  var fnStart = html.indexOf('async function loadDashboardTop5Monitor');
  var fnEnd = html.indexOf('function renderDashboardTop5MonitorData');
  var fnBody = html.slice(fnStart, fnEnd);

  // The default dashboard fetch URL must NOT include generate_preview
  var fetchLine = fnBody.match(/var _dashFetchUrl = [^;]+;/);
  assert.ok(fetchLine, 'dashboard fetch URL line found');
  assert.ok(fetchLine[0].indexOf('generate_preview') === -1,
    'Default dashboard load must not pass generate_preview=1 (only admin explicit button does)');
});

// ============================================================
// TEST 8: Frontend shows watchlist banner when top5_is_watchlist is true (source check)
// ============================================================
test('renderDashboardTop5 includes watchlist banner logic', function() {
  var html = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'index.html'), 'utf-8');
  var fnStart = html.indexOf('function renderDashboardTop5(picks');
  assert.ok(fnStart >= 0, 'renderDashboardTop5 function exists');
  var fnBody = html.slice(fnStart, fnStart + 1500);

  assert.ok(fnBody.indexOf('top5_is_watchlist') >= 0, 'checks top5_is_watchlist flag');
  assert.ok(fnBody.indexOf('Watchlist') >= 0, 'shows Watchlist label');
  assert.ok(fnBody.indexOf('Pantauan Besok') >= 0, 'shows Pantauan Besok label');
  assert.ok(fnBody.indexOf('Bukan sinyal entry langsung') >= 0, 'shows disclaimer');
});

// ============================================================
// TEST 9: Backend handleWebDailyPicks has fallback query for latest sent records (source check)
// ============================================================
test('handleWebDailyPicks: contains fallback query for latest sent/locked records', function() {
  var src = fs.readFileSync(path.resolve(__dirname, '..', 'api', 'sector-hot.js'), 'utf-8');
  var handleStart = src.indexOf('async function handleWebDailyPicks');
  var handleEnd = src.indexOf('\nasync function', handleStart + 10);
  if (handleEnd === -1) handleEnd = src.indexOf('\nfunction ', handleStart + 100);
  var handlerCode = src.substring(handleStart, handleEnd);

  // Must have fallback query when today has no rows
  assert.ok(handlerCode.indexOf('_fallbackDate') >= 0, 'tracks fallback date');
  assert.ok(handlerCode.indexOf('_fallbackIsWatchlist') >= 0, 'detects watchlist mode in fallback');
  assert.ok(handlerCode.indexOf("not('first_sent_at', 'is', null)") >= 0, 'queries sent rows only');
  assert.ok(handlerCode.indexOf('latest_sent_fallback') >= 0, 'uses latest_sent_fallback source label');
  assert.ok(handlerCode.indexOf('pickWasSentToTelegram') >= 0, 'verifies rows are actually sent');
});

// ============================================================
// TEST 10: Monitor only activates for today's records (not fallback)
// ============================================================
test('handleTelegramMonitorPicks: only queries today date (does not use fallback records)', function() {
  var src = fs.readFileSync(path.resolve(__dirname, '..', 'api', 'sector-hot.js'), 'utf-8');
  var monitorStart = src.indexOf('async function handleTelegramMonitorPicks');
  var monitorEnd = src.indexOf('\nasync function', monitorStart + 10);
  if (monitorEnd === -1) monitorEnd = src.indexOf('\nfunction ', monitorStart + 100);
  var monitorCode = src.substring(monitorStart, monitorEnd);

  // Must query by today's date and return early if no rows
  assert.ok(monitorCode.indexOf("eq('date', date)") >= 0, 'monitor queries by today date');
  assert.ok(monitorCode.indexOf('daily_picks_not_found') >= 0, 'returns early if no today rows');
  // Must NOT contain fallback logic
  assert.ok(monitorCode.indexOf('_fallbackDate') === -1, 'monitor does NOT use fallback');
});

// ============================================================
// TEST 11: Watchlist mode is saved to raw_payload when inserting picks
// ============================================================
test('handleTelegramDailyPicks: saves watchlist_mode to raw_payload on insert', function() {
  var src = fs.readFileSync(path.resolve(__dirname, '..', 'api', 'sector-hot.js'), 'utf-8');
  var handleStart = src.indexOf('async function handleTelegramDailyPicks');
  var handleEnd = src.indexOf('\nasync function', handleStart + 10);
  if (handleEnd === -1) handleEnd = src.indexOf('\nfunction ', handleStart + 100);
  var handlerCode = src.substring(handleStart, handleEnd);

  assert.ok(handlerCode.indexOf("raw_payload.watchlist_mode = true") >= 0,
    'marks raw_payload.watchlist_mode=true when in watchlist mode');
  assert.ok(handlerCode.indexOf("raw_payload.manual_latest_snapshot = true") >= 0,
    'marks raw_payload.manual_latest_snapshot=true for manual snapshot sends');
});

// ============================================================
// TEST 12: Frontend note logic handles all cases (source check)
// ============================================================
test('renderDashboardTop5MonitorData: note shows correct text for all states', function() {
  var html = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'index.html'), 'utf-8');
  var fnStart = html.indexOf('function renderDashboardTop5MonitorData');
  var fnBody = html.slice(fnStart, fnStart + 1200);

  // All note cases are handled
  assert.ok(fnBody.indexOf('top5_is_watchlist') >= 0, 'handles watchlist note');
  assert.ok(fnBody.indexOf('top5_fallback_date') >= 0, 'handles fallback date in note');
  assert.ok(fnBody.indexOf('top5_locked') >= 0, 'handles locked state');
  assert.ok(fnBody.indexOf('web_provisional') >= 0, 'handles provisional state');
});
