'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Static source-level assertions: verify Dashboard Top 5 locked display behavior
// and permanent disable of admin preview compute from the Dashboard path.
// No external dependencies needed — reads source files as text.

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const sectorHotSrc = fs.readFileSync(path.join(__dirname, '..', 'api', 'sector-hot.js'), 'utf8');
const sectorHot = require('../api/sector-hot');
const {
  hasDashboardLockedFinalIndicator,
  isSafeDashboardLockedTop5Row
} = sectorHot.__test;

// ============================================================
// TEST: Dashboard HTML has no Preview Top 5 Besok
// ============================================================
test('Dashboard HTML does not contain Preview Top 5 Besok', () => {
  assert.equal(html.indexOf('Preview Top 5 Besok'), -1, 'Must not have Preview Top 5 Besok anywhere in dashboard HTML');
});

// ============================================================
// TEST: No Refresh Preview / Generate Admin Preview buttons
// ============================================================
test('Dashboard HTML does not contain Refresh Preview or Generate Admin Preview', () => {
  assert.equal(html.indexOf('Refresh Preview'), -1, 'Must not have Refresh Preview button');
  assert.equal(html.indexOf('Generate Admin Preview'), -1, 'Must not have Generate Admin Preview button');
});

// ============================================================
// TEST: Dashboard fetch URL does not include admin_preview or generate_preview
// ============================================================
test('Dashboard fetch URL does not include admin_preview or generate_preview params', () => {
  const fnStart = html.indexOf('async function loadDashboardTop5Monitor');
  const fnEnd = html.indexOf('function renderDashboardTop5MonitorData');
  assert.ok(fnStart >= 0, 'loadDashboardTop5Monitor function must exist');
  assert.ok(fnEnd > fnStart, 'renderDashboardTop5MonitorData must come after');
  const fnBody = html.slice(fnStart, fnEnd);
  assert.ok(fnBody.indexOf('action=web-daily-picks') >= 0, 'Dashboard must call web-daily-picks action');
  assert.ok(fnBody.indexOf('admin_preview=1') < 0, 'Dashboard fetch must not include admin_preview=1');
  assert.ok(fnBody.indexOf('generate_preview=1') < 0, 'Dashboard fetch must not include generate_preview=1');
  assert.ok(fnBody.indexOf('admin_preview') < 0, 'Dashboard fetch must not reference admin_preview at all');
  assert.ok(fnBody.indexOf('generate_preview') < 0, 'Dashboard fetch must not reference generate_preview at all');
});

// ============================================================
// TEST: web-daily-picks returns same-day locked rows (source code verification)
// ============================================================
test('web-daily-picks queries telegram_daily_picks for current date first', () => {
  const fnStart = sectorHotSrc.indexOf('async function handleWebDailyPicks(req, res, supabase)');
  assert.ok(fnStart >= 0, 'handleWebDailyPicks must exist');
  const fnEnd = sectorHotSrc.indexOf('\nfunction getHistoryEntryUsage', fnStart);
  assert.ok(fnEnd > fnStart, 'function boundary found');
  const fnBody = sectorHotSrc.slice(fnStart, fnEnd);
  // Must query telegram_daily_picks with current date
  assert.ok(fnBody.indexOf("from('telegram_daily_picks')") >= 0, 'must query telegram_daily_picks');
  assert.ok(fnBody.indexOf(".eq('date', date)") >= 0, 'must filter by current date');
  assert.ok(fnBody.indexOf('filterSafeDashboardLockedTop5Rows') >= 0, 'must use filterSafeDashboardLockedTop5Rows');
});

// ============================================================
// TEST: web-daily-picks falls back to previous locked rows
// ============================================================
test('web-daily-picks falls back to previous dates if current date has no rows', () => {
  const fnStart = sectorHotSrc.indexOf('async function handleWebDailyPicks(req, res, supabase)');
  const fnEnd = sectorHotSrc.indexOf('\nfunction getHistoryEntryUsage', fnStart);
  const fnBody = sectorHotSrc.slice(fnStart, fnEnd);
  // Must have fallback logic checking previous dates
  assert.ok(fnBody.indexOf(".lt('date', date)") >= 0, 'must query dates before current');
  assert.ok(fnBody.indexOf("ascending: false") >= 0, 'must sort descending to get latest first');
  assert.ok(fnBody.indexOf('usedPreviousLockedFallback = true') >= 0, 'must set fallback flag');
  assert.ok(fnBody.indexOf("'locked_rows_fallback'") >= 0, 'must set locked_rows_fallback source');
});

// ============================================================
// TEST: Dashboard locked/final indicator behavior
// ============================================================
test('hasDashboardLockedFinalIndicator does not treat id+date alone as locked/final', () => {
  assert.equal(hasDashboardLockedFinalIndicator({ id: 123, date: '2025-01-15' }), false);
  assert.equal(hasDashboardLockedFinalIndicator({ id: 123, date: '2025-01-15', first_sent_at: '2025-01-15T09:00:00Z' }), true);
  assert.equal(hasDashboardLockedFinalIndicator({ id: 123, date: '2025-01-15', is_locked: true }), true);
  assert.equal(hasDashboardLockedFinalIndicator({ id: 123, date: '2025-01-15', locked: true }), true);
  assert.equal(hasDashboardLockedFinalIndicator({ id: 123, date: '2025-01-15', is_final: true }), true);
  assert.equal(hasDashboardLockedFinalIndicator({ id: 123, date: '2025-01-15', publication_status: 'final' }), true);
  assert.equal(hasDashboardLockedFinalIndicator({ id: 123, date: '2025-01-15', lock_status: 'locked' }), true);
});

// ============================================================
// TEST: Dashboard Top 5 Avoid/Hindari locked-row policy matrix
// ============================================================
test('isSafeDashboardLockedTop5Row enforces Avoid/Hindari policy without id+date shortcut', () => {
  assert.equal(isSafeDashboardLockedTop5Row({
    id: 1,
    date: '2025-01-15',
    ticker: 'AVOID',
    raw_payload: { grade: 'AVOID' }
  }), false, 'non-locked Avoid row must be excluded even with id+date');

  assert.equal(isSafeDashboardLockedTop5Row({
    id: 2,
    date: '2025-01-15',
    ticker: 'HINDARI',
    raw_payload: { action_label: 'Hindari dulu' }
  }), false, 'non-locked Hindari row must be excluded even with id+date');

  assert.equal(isSafeDashboardLockedTop5Row({
    id: 3,
    date: '2025-01-15',
    ticker: 'SAFE',
    raw_payload: { confidence: 'B', action_label: 'Masih dekat entry' }
  }), false, 'unlocked rows must never render as final even when otherwise safe');

  assert.equal(isSafeDashboardLockedTop5Row({
    id: 4,
    date: '2025-01-15',
    ticker: 'LOCKED_STALE',
    is_locked: true,
    raw_payload: { grade: 'AVOID', action_label: 'Hindari dulu' }
  }), false, 'locked rows with stale raw_payload Avoid/Hindari must be excluded from actionable Top 5');

  assert.equal(isSafeDashboardLockedTop5Row({
    id: 5,
    date: '2025-01-15',
    ticker: 'FINAL_STALE',
    publication_status: 'final',
    raw_payload: { signal_action: 'AVOID' }
  }), false, 'final rows with stale raw_payload Avoid must be excluded from actionable Top 5');

  assert.equal(isSafeDashboardLockedTop5Row({
    id: 6,
    date: '2025-01-15',
    ticker: 'PREVIEW_LOCKED',
    is_locked: true,
    preview: true,
    raw_payload: { confidence: 'B' }
  }), false, 'preview/provisional/admin-preview row must stay excluded');
});

test('locked dashboard rows distinguish foreign net sell notes from structured SELL', () => {
  var foreignNetSell = { id: 7, date: '2025-01-15', ticker: 'SAFESELL', is_locked: true,
    raw_payload: { action: 'WATCH', status: 'READY', foreign_notes: 'foreign net sell', notes: 'foreign net sell is analytical context' } };
  var structuredSell = { id: 8, date: '2025-01-15', ticker: 'SELL', is_locked: true,
    raw_payload: { action_label: 'SELL', status: 'READY', foreign_notes: 'foreign net buy' } };
  assert.equal(isSafeDashboardLockedTop5Row(foreignNetSell), true);
  assert.equal(isSafeDashboardLockedTop5Row(structuredSell), false);
});

// ============================================================
// TEST: Explicit preview/provisional/admin-only rows still blocked
// ============================================================
test('isDashboardExplicitPreviewOrProvisionalRow blocks preview/provisional/admin-only', () => {
  const fnStart = sectorHotSrc.indexOf('function isDashboardExplicitPreviewOrProvisionalRow(row)');
  assert.ok(fnStart >= 0, 'isDashboardExplicitPreviewOrProvisionalRow must exist');
  const fnBody = sectorHotSrc.slice(fnStart, fnStart + 500);
  // Must check persisted top-level fields
  assert.ok(fnBody.indexOf('row.web_provisional === true') >= 0, 'checks web_provisional');
  assert.ok(fnBody.indexOf('row.is_provisional === true') >= 0, 'checks is_provisional');
  assert.ok(fnBody.indexOf('row.preview === true') >= 0, 'checks preview');
  assert.ok(fnBody.indexOf('row.is_preview === true') >= 0, 'checks is_preview');
  assert.ok(fnBody.indexOf('row.admin_only === true') >= 0, 'checks admin_only');
  assert.ok(fnBody.indexOf("'provisional'") >= 0, 'checks for provisional text in indicator');
  assert.ok(fnBody.indexOf("'preview'") >= 0, 'checks for preview text in indicator');
  assert.ok(fnBody.indexOf("'admin'") >= 0, 'checks for admin text in indicator');
});

// ============================================================
// TEST: No Dashboard path calls selectDailyTop5/heavy preview generation
// ============================================================
test('handleWebDailyPicks never calls selectDailyTop5 or heavy preview generation', () => {
  const fnStart = sectorHotSrc.indexOf('async function handleWebDailyPicks(req, res, supabase)');
  const fnEnd = sectorHotSrc.indexOf('\nfunction getHistoryEntryUsage', fnStart);
  const fnBody = sectorHotSrc.slice(fnStart, fnEnd);

  // allowProvisional must be hardcoded to false
  assert.ok(fnBody.indexOf('var allowProvisional = false;') >= 0, 'allowProvisional must be hardcoded false');
  assert.ok(fnBody.indexOf('var webProvisional = false;') >= 0, 'webProvisional must be hardcoded false');

  // Must not have active selectDailyTop5 call (only in disabled comments)
  const activeLines = fnBody.split('\n').filter(line => {
    const trimmed = line.trim();
    return !trimmed.startsWith('//') && !trimmed.startsWith('*');
  });
  const hasActiveSelectCall = activeLines.some(line => line.indexOf('await selectDailyTop5(') >= 0);
  assert.ok(!hasActiveSelectCall, 'handleWebDailyPicks must not call selectDailyTop5 in active code');

  // Must not have active fetchCombinedScreenerCandidates call
  const hasActiveScreenerCall = activeLines.some(line => line.indexOf('await fetchCombinedScreenerCandidates(') >= 0);
  assert.ok(!hasActiveScreenerCall, 'handleWebDailyPicks must not call fetchCombinedScreenerCandidates');

  // Admin preview compute block must be disabled
  assert.ok(fnBody.indexOf('Admin preview compute is permanently disabled') >= 0, 'Admin preview disabled comment must be present');
  assert.ok(fnBody.indexOf('allowAdminPreview: false') >= 0, 'sanitizeTop5ResponseForAudience must be called with allowAdminPreview: false');
});

// ============================================================
// TEST: Response includes requested_date and locked snapshot date
// ============================================================
test('handleWebDailyPicks response includes requested_date and actual locked date', () => {
  const fnStart = sectorHotSrc.indexOf('async function handleWebDailyPicks(req, res, supabase)');
  const fnEnd = sectorHotSrc.indexOf('\nfunction getHistoryEntryUsage', fnStart);
  const fnBody = sectorHotSrc.slice(fnStart, fnEnd);
  assert.ok(fnBody.indexOf('requested_date: date') >= 0, 'response must include requested_date');
  assert.ok(fnBody.indexOf('date: lockedDate') >= 0, 'response must include actual locked date');
  assert.ok(fnBody.indexOf("top5_source: top5Source") >= 0, 'response must include top5_source');
  assert.ok(fnBody.indexOf('top5_locked: locked') >= 0, 'response must include top5_locked boolean');
});

// ============================================================
// TEST: Dashboard auto-refresh does not trigger heavy compute
// ============================================================
test('Dashboard auto-refresh interval does not include admin_preview or generate_preview', () => {
  const refreshStart = html.indexOf('function startDashboardMonitorAutoRefresh');
  assert.ok(refreshStart >= 0, 'startDashboardMonitorAutoRefresh must exist');
  const refreshBody = html.slice(refreshStart, refreshStart + 500);
  assert.ok(refreshBody.indexOf('loadDashboardTop5Monitor') >= 0, 'auto-refresh calls loadDashboardTop5Monitor');
  assert.ok(refreshBody.indexOf('admin_preview') < 0, 'auto-refresh must not reference admin_preview');
  assert.ok(refreshBody.indexOf('generate_preview') < 0, 'auto-refresh must not reference generate_preview');
  assert.ok(refreshBody.indexOf('selectDailyTop5') < 0, 'auto-refresh must not reference selectDailyTop5');
});

// ============================================================
// TEST: Speed requirement - no Yahoo fetch, no screener run
// ============================================================
test('handleWebDailyPicks has no Yahoo Finance fetch or heavy screener in locked path', () => {
  const fnStart = sectorHotSrc.indexOf('async function handleWebDailyPicks(req, res, supabase)');
  const fnEnd = sectorHotSrc.indexOf('\nfunction getHistoryEntryUsage', fnStart);
  const fnBody = sectorHotSrc.slice(fnStart, fnEnd);
  const activeLines = fnBody.split('\n').filter(line => {
    const trimmed = line.trim();
    return !trimmed.startsWith('//') && !trimmed.startsWith('*');
  });
  // Must not call Yahoo/external APIs directly in the main flow
  const hasYahooCall = activeLines.some(line => /yahoo|finance\.yahoo|query[12]\.finance/i.test(line));
  assert.ok(!hasYahooCall, 'handleWebDailyPicks must not call Yahoo Finance API');
  // The only heavy operation allowed is fetchLatestPriceForMonitor (for real-time prices of locked rows)
  // which is bounded to max 5 rows and uses Promise.allSettled for parallelism
  assert.ok(fnBody.indexOf('Promise.allSettled(priceFetches)') >= 0, 'Price fetches are parallelized and bounded');
});
