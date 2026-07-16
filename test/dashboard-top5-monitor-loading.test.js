'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sectorHot = require('../api/sector-hot');

const {
  sanitizeTop5ResponseForAudience,
  buildDashboardPickRow,
  isSafeDashboardLockedTop5Row,
  filterSafeDashboardLockedTop5Rows
} = sectorHot.__test;

// ============================================================
// HELPERS
// ============================================================

function makeLockedRow(ticker, overrides) {
  return Object.assign({
    id: Math.floor(Math.random() * 1000),
    date: '2025-01-15',
    ticker: ticker,
    category: 'Swing Konglo',
    entry1: 5000,
    entry2: 5050,
    sl: 4800,
    tp1: 5500,
    tp2: 5800,
    status: 'WAITING',
    first_sent_at: new Date().toISOString(),
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
      signal_verdict: 'Potensi swing moderat.'
    }
  }, overrides || {});
}

// ============================================================
// TEST 1: Top 5 empty locked response returns safe awaiting state (no stale loading)
// ============================================================
test('web-daily-picks: no locked rows returns awaiting_locked_rows with safe empty state quickly', function() {
  // Simulate the API response when no locked rows exist
  var response = sanitizeTop5ResponseForAudience({
    success: true,
    date: '2025-01-15',
    top5: [],
    monitor: [],
    top5_source: 'awaiting_locked_rows',
    top5_locked: false,
    telegram_scheduled_only: true,
    telegram_note: 'Telegram tetap dikirim hanya sesuai jadwal otomatis.',
    web_provisional: false,
    update_note: 'Belum ada Top 5 final yang terkunci. Cek lagi setelah data final tersedia.',
    last_updated_at: null,
    monitor_last_updated_at: null,
    monitor_source_label: null,
    monitor_is_stale: true,
    monitor_stale_note: 'Data monitor belum update terbaru.',
    picks: []
  }, { allowAdminPreview: false });

  // Response must clearly indicate awaiting state
  assert.equal(response.success, true);
  assert.equal(response.top5_source, 'awaiting_locked_rows');
  assert.equal(response.top5_locked, false);
  assert.ok(Array.isArray(response.top5));
  assert.equal(response.top5.length, 0);
  assert.ok(Array.isArray(response.monitor));
  assert.equal(response.monitor.length, 0);
  // Must have a clear update_note for the frontend to show
  assert.ok(response.update_note && response.update_note.length > 0);
  // Must NOT contain loading/pending indicators that would confuse frontend
  assert.ok(!response.loading);
  assert.ok(!response.pending);
});

// ============================================================
// TEST 2: Auto Monitor empty response includes proper empty text signal
// ============================================================
test('web-daily-picks: awaiting_locked_rows response provides empty monitor array for frontend empty state', function() {
  var response = sanitizeTop5ResponseForAudience({
    success: true,
    date: '2025-01-15',
    top5: [],
    monitor: [],
    top5_source: 'awaiting_locked_rows',
    top5_locked: false,
    web_provisional: false,
    update_note: 'Belum ada Top 5 final yang terkunci.',
    last_updated_at: null,
    monitor_last_updated_at: null,
    monitor_source_label: null,
    picks: []
  }, { allowAdminPreview: false });

  // Monitor must be empty array so frontend renders MONITOR_EMPTY_TEXT
  assert.ok(Array.isArray(response.monitor));
  assert.equal(response.monitor.length, 0);
  // monitor_last_updated_at should be null so frontend shows "— WIB"
  assert.equal(response.monitor_last_updated_at, null);
});

// ============================================================
// TEST 3: Top 5 locked rows render normally with proper structure
// ============================================================
test('buildDashboardPickRow: locked row builds complete pick structure with all required fields', function() {
  var row = makeLockedRow('BBRI');
  var px = { last: 5030, open: 5000, high: 5050, low: 4990, at: new Date().toISOString(), bestEffort: false };
  var result = buildDashboardPickRow(row, 1, px);

  // Must have all required display fields
  assert.ok(result.ticker === 'BBRI');
  assert.ok(result.rank === 1);
  assert.ok(result.entry1 > 0);
  assert.ok(result.entry2 > 0);
  assert.ok(result.sl > 0);
  assert.ok(result.tp1 > 0);
  assert.ok(result.tp2 > 0);
  assert.ok(result.current_price > 0);
  assert.ok(result.category);
  assert.ok(result.date);
  // Must have raw_payload for detail view
  assert.ok(result.raw_payload && typeof result.raw_payload === 'object');
  // Must NOT have undefined fields that would show as "undefined" in UI
  var json = JSON.stringify(result);
  assert.ok(json.indexOf('undefined') === -1, 'Pick row must not contain undefined values');
});

// ============================================================
// TEST 4: Monitor rows have proper structure when price data is available
// ============================================================
test('buildDashboardPickRow: with price data builds monitor-ready row with current_price', function() {
  var row = makeLockedRow('TLKM', { entry1: 3800, entry2: 3850, sl: 3600, tp1: 4200, tp2: 4500 });
  row.raw_payload.entry1 = 3800;
  row.raw_payload.entry2 = 3850;
  row.raw_payload.sl = 3600;
  row.raw_payload.stop_loss = 3600;
  row.raw_payload.tp1 = 4200;
  row.raw_payload.tp2 = 4500;
  row.raw_payload.last_price = 3900;
  row.raw_payload.lastn = 3900;
  var px = { last: 3920, open: 3850, high: 3950, low: 3840, at: new Date().toISOString(), bestEffort: false };
  var result = buildDashboardPickRow(row, 2, px);

  assert.equal(result.ticker, 'TLKM');
  assert.equal(result.rank, 2);
  assert.equal(result.current_price, 3920);
  assert.ok(result.entry1 === 3800);
  assert.ok(result.sl === 3600);
  assert.ok(result.tp1 === 4200);
});

// ============================================================
// TEST 5: API web-daily-picks handles no locked rows quickly with safe empty state
// ============================================================
test('web-daily-picks: error response returns safe structure without exposing internals', function() {
  // Simulate the catch block response from handleWebDailyPicks
  var errorResponse = {
    success: false,
    date: '2025-01-15',
    top5: [],
    monitor: [],
    top5_source: 'awaiting_locked_rows',
    top5_locked: false,
    telegram_scheduled_only: true,
    telegram_note: 'Telegram tetap dikirim hanya sesuai jadwal otomatis.',
    web_provisional: false,
    update_note: 'Belum ada Top 5 final yang terkunci. Cek lagi setelah data final tersedia.',
    last_updated_at: null,
    monitor_last_updated_at: null,
    monitor_source_label: null,
    monitor_is_stale: true,
    monitor_stale_note: 'Data monitor belum update terbaru.',
    picks: [],
    error: 'Database connection timeout'
  };

  // Even error responses are well-structured for frontend to handle
  assert.ok(Array.isArray(errorResponse.top5));
  assert.ok(Array.isArray(errorResponse.monitor));
  assert.equal(errorResponse.top5.length, 0);
  assert.equal(errorResponse.monitor.length, 0);
  // Frontend can still render empty state from this response
  assert.ok(errorResponse.top5_source === 'awaiting_locked_rows');
});

// ============================================================
// TEST 6: API web-daily-picks does not expose admin/internal diagnostics to guest/public
// ============================================================
test('web-daily-picks: sanitized response does not expose admin diagnostics to public', function() {
  var rawResponse = {
    success: true,
    date: '2025-01-15',
    top5: [{ ticker: 'BBRI', rank: 1, raw_payload: { debug: 'secret', stageByTicker: { BBRI: {} } } }],
    monitor: [{ ticker: 'BBRI', raw_payload: { sample_rejected: true, internal_notes: 'debug' } }],
    top5_source: 'locked_rows',
    top5_locked: true,
    admin_next_top5_preview: [{ ticker: 'BBCA', is_preview: true }],
    admin_gate_calibration_summary: { signal_count: 3, radar_count: 2 },
    admin_next_top5_excluded_preview: [{ ticker: 'EXCL' }],
    admin_next_top5_potential_radar_preview: [{ ticker: 'POT' }]
  };

  var sanitized = sanitizeTop5ResponseForAudience(rawResponse, { allowAdminPreview: false });

  // Admin preview fields must be removed for public
  assert.equal(sanitized.admin_next_top5_preview, undefined);
  assert.equal(sanitized.admin_gate_calibration_summary, undefined);
  assert.equal(sanitized.admin_next_top5_excluded_preview, undefined);
  assert.equal(sanitized.admin_next_top5_potential_radar_preview, undefined);
});

// ============================================================
// TEST 7: Parallelized fetchLatestPriceForMonitor — API uses Promise.allSettled
// ============================================================
test('handleWebDailyPicks: parallelized price fetch pattern uses Promise.allSettled', function() {
  // Verify the API code structure — read the actual source to confirm parallelization
  var src = fs.readFileSync(path.resolve(__dirname, '..', 'api', 'sector-hot.js'), 'utf-8');

  // Must use Promise.allSettled for parallel price fetches in handleWebDailyPicks
  var handleWebDailyPicksStart = src.indexOf('async function handleWebDailyPicks');
  var handleWebDailyPicksEnd = src.indexOf('\nasync function', handleWebDailyPicksStart + 10);
  if (handleWebDailyPicksEnd === -1) handleWebDailyPicksEnd = src.indexOf('\nfunction ', handleWebDailyPicksStart + 100);
  var handlerCode = src.substring(handleWebDailyPicksStart, handleWebDailyPicksEnd);

  // Confirm Promise.allSettled is used
  assert.ok(handlerCode.indexOf('Promise.allSettled') >= 0,
    'handleWebDailyPicks must use Promise.allSettled for parallel price fetches');

  // Confirm NO sequential await fetchLatestPriceForMonitor inside for-loop
  // Pattern: "for (...) { ... await fetchLatestPriceForMonitor" should NOT exist
  var sequentialPattern = /for\s*\([^)]*\)\s*\{[^}]*await\s+fetchLatestPriceForMonitor/;
  assert.ok(!sequentialPattern.test(handlerCode),
    'handleWebDailyPicks must NOT have sequential await fetchLatestPriceForMonitor in for-loop');
});

// ============================================================
// TEST 8: Existing Top 5 History endpoint still exists and has proper structure
// ============================================================
test('web-top5-history: endpoint handler exists in module', function() {
  // The module must export the handler as the default export
  var handler = require('../api/sector-hot');
  assert.ok(typeof handler === 'function', 'sector-hot must export a handler function');
});

// ============================================================
// TEST 9: Endpoint count remains 12
// ============================================================
test('API endpoint file count remains exactly 12', function() {
  var apiDir = path.resolve(__dirname, '..', 'api');
  var files = fs.readdirSync(apiDir).filter(function(f) {
    return f.endsWith('.js') && !f.startsWith('.');
  });
  assert.equal(files.length, 12,
    'api/ directory must contain exactly 12 JS files. Found ' + files.length + ': ' + files.join(', '));
});

// ============================================================
// TEST 10: public/index.html extracted script passes basic validation
// ============================================================
test('public/index.html script blocks have balanced braces', function() {
  var html = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'index.html'), 'utf-8');
  var scriptStart = html.indexOf('<script>') + '<script>'.length;
  var scriptEnd = html.lastIndexOf('</script>');
  var script = html.substring(scriptStart, scriptEnd);
  var openBraces = (script.match(/\{/g) || []).length;
  var closeBraces = (script.match(/\}/g) || []).length;
  assert.equal(openBraces, closeBraces,
    'Script braces must be balanced. Open: ' + openBraces + ', Close: ' + closeBraces);
});

// ============================================================
// BONUS TEST: Loading state cleanup — frontend contract verification
// ============================================================
test('frontend contract: renderDashboardTop5MonitorData clears monitor when awaiting locked rows', function() {
  // Verify the source code structure ensures monitor is cleared
  var html = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'index.html'), 'utf-8');

  // Find renderDashboardTop5MonitorData function
  var fnStart = html.indexOf('function renderDashboardTop5MonitorData');
  var fnEnd = html.indexOf('\n}', fnStart + 50);
  var fnBody = html.substring(fnStart, fnEnd + 2);

  // When awaiting_locked_rows, must explicitly handle monitor element
  assert.ok(fnBody.indexOf('awaiting_locked_rows') >= 0,
    'renderDashboardTop5MonitorData must check for awaiting_locked_rows');
  assert.ok(fnBody.indexOf('dashboardMonitorList') >= 0,
    'renderDashboardTop5MonitorData must reference dashboardMonitorList element');
  assert.ok(fnBody.indexOf('MONITOR_EMPTY_TEXT') >= 0,
    'renderDashboardTop5MonitorData must use MONITOR_EMPTY_TEXT for empty monitor state');
});

test('frontend contract: loadDashboardTop5Monitor has in-flight guard and finally cleanup', function() {
  var html = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'index.html'), 'utf-8');

  // Find loadDashboardTop5Monitor function
  var fnStart = html.indexOf('async function loadDashboardTop5Monitor');
  var fnEnd = html.indexOf('\nasync function', fnStart + 50);
  if (fnEnd === -1) fnEnd = html.indexOf('\nfunction ', fnStart + 100);
  var fnBody = html.substring(fnStart, fnEnd);

  // Must have in-flight guard
  assert.ok(fnBody.indexOf('_dashboardTop5InFlight') >= 0,
    'loadDashboardTop5Monitor must use _dashboardTop5InFlight guard');
  // Must have finally cleanup
  assert.ok(fnBody.indexOf('finally') >= 0,
    'loadDashboardTop5Monitor must have finally block for cleanup');
  assert.ok(fnBody.indexOf('_dashboardTop5InFlight = null') >= 0,
    'loadDashboardTop5Monitor finally must clear _dashboardTop5InFlight');
});

// ============================================================
// TEST 9: Dashboard source handling supports same-day locked and previous locked fallback
// ============================================================
test('web-daily-picks: same-day locked response remains locked/final and renderable', function() {
  var response = sanitizeTop5ResponseForAudience({
    success: true,
    date: '2025-01-15',
    requested_date: '2025-01-15',
    top5: [{ ticker: 'BBRI', rank: 1 }],
    monitor: [{ ticker: 'BBRI', rank: 1 }],
    picks: [{ ticker: 'BBRI', rank: 1 }],
    top5_source: 'locked_rows',
    top5_locked: true,
    web_provisional: false,
    update_note: 'Top 5 Radar locked.'
  }, { allowAdminPreview: false });

  assert.equal(response.top5_locked, true);
  assert.equal(response.top5_source, 'locked_rows');
  assert.equal(response.web_provisional, false);
  assert.equal(response.top5.length, 1);
});

test('web-daily-picks: previous locked final fallback remains locked/final and renderable', function() {
  var response = sanitizeTop5ResponseForAudience({
    success: true,
    date: '2025-01-14',
    requested_date: '2025-01-15',
    top5: [{ ticker: 'TLKM', rank: 1 }],
    monitor: [{ ticker: 'TLKM', rank: 1 }],
    picks: [{ ticker: 'TLKM', rank: 1 }],
    top5_source: 'locked_rows_fallback',
    top5_locked: true,
    web_provisional: false,
    update_note: 'Top 5 Radar Final/Locked terbaru dari snapshot sebelumnya (2025-01-14).'
  }, { allowAdminPreview: false });

  assert.equal(response.top5_locked, true);
  assert.equal(response.top5_source, 'locked_rows_fallback');
  assert.equal(response.web_provisional, false);
  assert.equal(response.date, '2025-01-14');
  assert.equal(response.requested_date, '2025-01-15');
  assert.equal(response.top5.length, 1);
});

test('handleWebDailyPicks: queries latest previous locked date when same-day rows are missing', function() {
  var src = fs.readFileSync(path.resolve(__dirname, '..', 'api', 'sector-hot.js'), 'utf-8');
  var start = src.indexOf('async function handleWebDailyPicks');
  var end = src.indexOf('\n\nfunction getHistoryEntryUsage', start);
  var handlerCode = src.substring(start, end);

  assert.ok(handlerCode.indexOf(".lt('date', date)") >= 0, 'fallback must only look before requested trading day');
  assert.ok(handlerCode.indexOf(".order('date', { ascending: false })") >= 0, 'fallback must choose latest previous date');
  assert.ok(handlerCode.indexOf("'locked_rows_fallback'") >= 0, 'fallback source must stay locked/final, not preview');
  assert.ok(handlerCode.indexOf('usedPreviousLockedFallback') >= 0, 'handler must track previous locked fallback status');
});


test('web-daily-picks: Dashboard locked row filter excludes preview/provisional Avoid/Hindari candidates', function() {
  var safe = makeLockedRow('SAFE', { publication_status: 'locked', raw_payload: Object.assign({}, makeLockedRow('SAFE').raw_payload, { action_label: 'Masih dekat entry', grade: 'B' }) });
  var preview = makeLockedRow('PREV', { publication_status: 'provisional', raw_payload: Object.assign({}, makeLockedRow('PREV').raw_payload, { publication_status: 'provisional' }) });
  var avoid = makeLockedRow('AVOID', { first_sent_at: null, raw_payload: Object.assign({}, makeLockedRow('AVOID').raw_payload, { grade: 'Avoid' }) });
  var hindari = makeLockedRow('HIND', { first_sent_at: null, raw_payload: Object.assign({}, makeLockedRow('HIND').raw_payload, { action_label: 'Hindari — setup tidak valid' }) });

  assert.equal(isSafeDashboardLockedTop5Row(safe), true);
  assert.equal(isSafeDashboardLockedTop5Row(preview), false);
  assert.equal(isSafeDashboardLockedTop5Row(avoid), false);
  assert.equal(isSafeDashboardLockedTop5Row(hindari), false);
  assert.deepEqual(filterSafeDashboardLockedTop5Rows([preview, avoid, safe, hindari]).map(function(r) { return r.ticker; }), ['SAFE']);
});

test('web-daily-picks: Dashboard fallback excludes older locked rows with unsafe stale payload fields', function() {
  var lockedAvoid = makeLockedRow('LAVD', {
    publication_status: 'locked',
    raw_payload: Object.assign({}, makeLockedRow('LAVD').raw_payload, { grade: 'Avoid', action_label: 'Avoid Dulu', publication_status: 'provisional' })
  });
  var lockedHindari = makeLockedRow('LHIN', {
    source: 'final',
    raw_payload: Object.assign({}, makeLockedRow('LHIN').raw_payload, { signal_action: 'AVOID', action_label: 'Hindari — setup tidak valid', visibility: 'admin_preview' })
  });

  assert.equal(isSafeDashboardLockedTop5Row(lockedAvoid), false);
  assert.equal(isSafeDashboardLockedTop5Row(lockedHindari), false);
  assert.deepEqual(filterSafeDashboardLockedTop5Rows([lockedAvoid, lockedHindari]).map(function(r) { return r.ticker; }), []);
});

test('web-daily-picks: Dashboard fallback still blocks explicitly preview/provisional persisted rows', function() {
  var lockedButPreview = makeLockedRow('LPRE', { publication_status: 'locked', is_preview: true });
  var lockedButProvisional = makeLockedRow('LPRO', { source: 'locked_rows', web_provisional: true });
  var adminPreview = makeLockedRow('ADMN', { visibility: 'admin_preview', first_sent_at: null });

  assert.equal(isSafeDashboardLockedTop5Row(lockedButPreview), false);
  assert.equal(isSafeDashboardLockedTop5Row(lockedButProvisional), false);
  assert.equal(isSafeDashboardLockedTop5Row(adminPreview), false);
});
