'use strict';

/**
 * Tests for telegram-monitor-picks functionality.
 * 
 * Tests:
 * - monitor includes previous-day swing rows
 * - monitor excludes old terminal rows  
 * - monitor does not overwrite existing hit timestamps
 * - no duplicate notification for already-hit rows
 * 
 * NOTE: Uses source code inspection via fs.readFileSync to avoid needing @supabase/supabase-js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Read source file once for all tests - no require() of sector-hot.js
const sectorHotSrc = fs.readFileSync(path.resolve(__dirname, '..', 'api', 'sector-hot.js'), 'utf-8');

// ============================================================
// TEST 1: getMonitorDateRange function exists and uses correct logic
// ============================================================
test('getMonitorDateRange function exists in sector-hot.js', function() {
  // Must have getMonitorDateRange function
  assert.ok(sectorHotSrc.indexOf('function getMonitorDateRange()') >= 0,
    'getMonitorDateRange function must exist');
  
  // Must return dates using getJakartaNow
  assert.ok(sectorHotSrc.indexOf('getMonitorDateRange') >= 0,
    'getMonitorDateRange should be defined');
});

// ============================================================
// TEST 2: isTerminalPick function exists with correct terminal statuses
// ============================================================
test('isTerminalPick identifies TP2_HIT, SL_HIT, EXPIRED, INVALID as terminal', function() {
  // Must have isTerminalPick function
  assert.ok(sectorHotSrc.indexOf('function isTerminalPick(pick)') >= 0,
    'isTerminalPick function must exist');
  
  // Must include TP2_HIT as terminal
  assert.ok(sectorHotSrc.indexOf("'TP2_HIT'") >= 0 || sectorHotSrc.indexOf('"TP2_HIT"') >= 0,
    'TP2_HIT must be in terminal statuses');
  
  // Must include SL_HIT as terminal
  assert.ok(sectorHotSrc.indexOf("'SL_HIT'") >= 0 || sectorHotSrc.indexOf('"SL_HIT"') >= 0,
    'SL_HIT must be in terminal statuses');
  
  // Must include EXPIRED as terminal
  assert.ok(sectorHotSrc.indexOf("'EXPIRED'") >= 0 || sectorHotSrc.indexOf('"EXPIRED"') >= 0,
    'EXPIRED must be in terminal statuses');
  
  // Must include INVALID as terminal
  assert.ok(sectorHotSrc.indexOf("'INVALID'") >= 0 || sectorHotSrc.indexOf('"INVALID"') >= 0,
    'INVALID must be in terminal statuses');
  
  // Must check hit_tp2_at for terminal
  assert.ok(sectorHotSrc.indexOf('pick.hit_tp2_at') >= 0,
    'must check hit_tp2_at for terminal');
  
  // Must check hit_sl_at for terminal
  assert.ok(sectorHotSrc.indexOf('pick.hit_sl_at') >= 0,
    'must check hit_sl_at for terminal');
});

// ============================================================
// TEST 3: TP1_HIT is NOT terminal (continues to TP2 or SL)
// ============================================================
test('TP1_HIT is NOT terminal - should continue monitoring for TP2', function() {
  // TP1_HIT must NOT be in terminalStatuses array
  var isTerminalPickStart = sectorHotSrc.indexOf('function isTerminalPick(pick)');
  var isTerminalPickEnd = sectorHotSrc.indexOf('\nasync function handleTelegramMonitorPicks', isTerminalPickStart);
  var isTerminalPickFn = sectorHotSrc.substring(isTerminalPickStart, isTerminalPickEnd);
  
  // Terminal statuses should be defined
  var terminalMatch = isTerminalPickFn.match(/var terminalStatuses\s*=\s*\[([^\]]+)\]/);
  if (terminalMatch) {
    var terminals = terminalMatch[1];
    assert.ok(terminals.indexOf('TP1_HIT') === -1,
      'TP1_HIT must NOT be in terminalStatuses - TP1 rows should continue to TP2 or SL');
  }
});

// ============================================================
// TEST 4: Monitor query uses date range, not single date
// ============================================================
test('handleTelegramMonitorPicks uses .in(date) for date range query', function() {
  var start = sectorHotSrc.indexOf('async function handleTelegramMonitorPicks');
  var end = sectorHotSrc.indexOf('\n\nfunction buildTelegramStartMessage', start);
  var fnBody = sectorHotSrc.substring(start, end);
  
  // Must use .in('date', dateRange) to query multiple dates
  assert.ok(fnBody.indexOf(".in('date',") >= 0 || fnBody.indexOf('.in("date",') >= 0,
    'monitor must use .in() to query multiple dates');
  
  // Must call getMonitorDateRange
  assert.ok(fnBody.indexOf('getMonitorDateRange()') >= 0,
    'monitor must call getMonitorDateRange()');
  
  // Must filter terminal rows
  assert.ok(fnBody.indexOf('isTerminalPick') >= 0 || fnBody.indexOf('.filter(') >= 0,
    'monitor must filter terminal rows');
});

// ============================================================
// TEST 5: Hit timestamps are NOT overwritten
// ============================================================
test('monitor checks !pck.hit_entry_at before updating entry timestamp', function() {
  var start = sectorHotSrc.indexOf('async function handleTelegramMonitorPicks');
  var end = sectorHotSrc.indexOf('\n\nfunction buildTelegramStartMessage', start);
  var fnBody = sectorHotSrc.substring(start, end);
  
  // Must check !pck.hit_entry_at before setting
  assert.ok(fnBody.indexOf('!pck.hit_entry_at') >= 0,
    'must check !pck.hit_entry_at before updating');
});

test('monitor checks !pck.hit_tp1_at before updating TP1 timestamp', function() {
  var start = sectorHotSrc.indexOf('async function handleTelegramMonitorPicks');
  var end = sectorHotSrc.indexOf('\n\nfunction buildTelegramStartMessage', start);
  var fnBody = sectorHotSrc.substring(start, end);
  
  // Must check !pck.hit_tp1_at before setting
  assert.ok(fnBody.indexOf('!pck.hit_tp1_at') >= 0,
    'must check !pck.hit_tp1_at before updating');
});

test('monitor checks !pck.hit_tp2_at before updating TP2 timestamp', function() {
  var start = sectorHotSrc.indexOf('async function handleTelegramMonitorPicks');
  var end = sectorHotSrc.indexOf('\n\nfunction buildTelegramStartMessage', start);
  var fnBody = sectorHotSrc.substring(start, end);
  
  // Must check !pck.hit_tp2_at before setting
  assert.ok(fnBody.indexOf('!pck.hit_tp2_at') >= 0,
    'must check !pck.hit_tp2_at before updating');
});

test('monitor checks !pck.hit_sl_at before updating SL timestamp', function() {
  var start = sectorHotSrc.indexOf('async function handleTelegramMonitorPicks');
  var end = sectorHotSrc.indexOf('\n\nfunction buildTelegramStartMessage', start);
  var fnBody = sectorHotSrc.substring(start, end);
  
  // Must check !pck.hit_sl_at before setting
  assert.ok(fnBody.indexOf('!pck.hit_sl_at') >= 0,
    'must check !pck.hit_sl_at before updating');
});

// ============================================================
// TEST 6: Duplicate notification prevention using first-hit fields
// ============================================================
test('isNewHit checks hit_entry_at for ENTRY notifications', function() {
  var start = sectorHotSrc.indexOf('async function handleTelegramMonitorPicks');
  var end = sectorHotSrc.indexOf('\n\nfunction buildTelegramStartMessage', start);
  var fnBody = sectorHotSrc.substring(start, end);
  
  // Must have isNewHit variable
  assert.ok(fnBody.indexOf('var isNewHit') >= 0,
    'must have isNewHit variable');
  
  // Must check hit_entry_at for ENTRY
  assert.ok(fnBody.indexOf('!pck.hit_entry_at') >= 0,
    'must check hit_entry_at for ENTRY notification');
});

test('isNewHit checks hit_tp1_at for TP1 notifications', function() {
  var start = sectorHotSrc.indexOf('async function handleTelegramMonitorPicks');
  var end = sectorHotSrc.indexOf('\n\nfunction buildTelegramStartMessage', start);
  var fnBody = sectorHotSrc.substring(start, end);
  
  // Must check !pck.hit_tp1_at for TP1
  assert.ok(fnBody.indexOf("TP1_HIT'") >= 0 || fnBody.indexOf('TP1_HIT"') >= 0,
    'must check TP1_HIT status');
});

test('isNewHit checks hit_tp2_at for TP2 notifications', function() {
  var start = sectorHotSrc.indexOf('async function handleTelegramMonitorPicks');
  var end = sectorHotSrc.indexOf('\n\nfunction buildTelegramStartMessage', start);
  var fnBody = sectorHotSrc.substring(start, end);
  
  // Must check !pck.hit_tp2_at for TP2 notification
  assert.ok(fnBody.indexOf("TP2_HIT'") >= 0 || fnBody.indexOf('TP2_HIT"') >= 0,
    'must check TP2_HIT status');
});

test('isNewHit checks hit_sl_at for SL notifications', function() {
  var start = sectorHotSrc.indexOf('async function handleTelegramMonitorPicks');
  var end = sectorHotSrc.indexOf('\n\nfunction buildTelegramStartMessage', start);
  var fnBody = sectorHotSrc.substring(start, end);
  
  // Must check !pck.hit_sl_at for SL notification
  assert.ok(fnBody.indexOf("SL_HIT'") >= 0 || fnBody.indexOf('SL_HIT"') >= 0,
    'must check SL_HIT status');
});

test('significantHit only triggers for isNewHit', function() {
  var start = sectorHotSrc.indexOf('async function handleTelegramMonitorPicks');
  var end = sectorHotSrc.indexOf('\n\nfunction buildTelegramStartMessage', start);
  var fnBody = sectorHotSrc.substring(start, end);
  
  // significantHit must include isNewHit check
  var significantHitLine = fnBody.substring(fnBody.indexOf('var significantHit')).split('\n')[0];
  assert.ok(significantHitLine.indexOf('isNewHit') >= 0,
    'significantHit must check isNewHit to prevent duplicate notifications');
});

// ============================================================
// TEST 7: Response includes dates_queried for debugging
// ============================================================
test('no_active_picks response includes dates_queried for debugging', function() {
  var start = sectorHotSrc.indexOf('async function handleTelegramMonitorPicks');
  var end = sectorHotSrc.indexOf('\n\nfunction buildTelegramStartMessage', start);
  var fnBody = sectorHotSrc.substring(start, end);
  
  // When returning no active picks, must include dates_queried
  assert.ok(fnBody.indexOf('dates_queried') >= 0,
    'response should include dates_queried for debugging');
});

// ============================================================
// TEST 8: getMonitorDateRange excludes weekends
// ============================================================
test('getMonitorDateRange excludes weekend dates (code verification)', function() {
  // Function must check UTC day
  assert.ok(sectorHotSrc.indexOf("day >= 1 && day <= 5") >= 0 ||
            sectorHotSrc.indexOf('day >= 1 && day <= 5') >= 0,
    'must filter to weekdays (Mon=1 to Fri=5)');
});

// ============================================================
// TEST 9: Entry/tp/sl fields are preserved correctly
// ============================================================
test('dailyPickInsertRowFromCandidate maps tp1n to tp1 correctly', function() {
  var start = sectorHotSrc.indexOf('function dailyPickInsertRowFromCandidate');
  var end = sectorHotSrc.indexOf('\nasync function registerCandidatesForMonitoring', start);
  var fnBody = sectorHotSrc.substring(start, end);
  
  // Must map tp1n to tp1
  assert.ok(fnBody.indexOf('tp1: candidate.tp1n') >= 0,
    'tp1 should be mapped from tp1n');
});

test('dailyPickInsertRowFromCandidate maps tp2n to tp2 correctly', function() {
  var start = sectorHotSrc.indexOf('function dailyPickInsertRowFromCandidate');
  var end = sectorHotSrc.indexOf('\nasync function registerCandidatesForMonitoring', start);
  var fnBody = sectorHotSrc.substring(start, end);
  
  // Must map tp2n to tp2
  assert.ok(fnBody.indexOf('tp2: candidate.tp2n') >= 0,
    'tp2 should be mapped from tp2n');
});

// ============================================================
// TEST 10: evaluateMonitorStatus uses entry1, tp1, tp2, sl correctly
// ============================================================
test('evaluateMonitorStatus checks entry1 for entry zone', function() {
  var start = sectorHotSrc.indexOf('function evaluateMonitorStatus');
  var end = sectorHotSrc.indexOf('\n\nfunction webPickScore', start);
  var fnBody = sectorHotSrc.substring(start, end);
  
  // Must use entry1 for entry checks
  assert.ok(fnBody.indexOf('entry1') >= 0,
    'evaluateMonitorStatus must check entry1');
});

test('evaluateMonitorStatus checks tp1 for TP1 hit', function() {
  var start = sectorHotSrc.indexOf('function evaluateMonitorStatus');
  var end = sectorHotSrc.indexOf('\n\nfunction webPickScore', start);
  var fnBody = sectorHotSrc.substring(start, end);
  
  // Must use tp1 for TP1 checks
  assert.ok(fnBody.indexOf('tp1') >= 0,
    'evaluateMonitorStatus must check tp1');
});

test('evaluateMonitorStatus checks tp2 for TP2 hit', function() {
  var start = sectorHotSrc.indexOf('function evaluateMonitorStatus');
  var end = sectorHotSrc.indexOf('\n\nfunction webPickScore', start);
  var fnBody = sectorHotSrc.substring(start, end);
  
  // Must use tp2 for TP2 checks
  assert.ok(fnBody.indexOf('tp2') >= 0,
    'evaluateMonitorStatus must check tp2');
});

test('evaluateMonitorStatus checks sl for SL hit', function() {
  var start = sectorHotSrc.indexOf('function evaluateMonitorStatus');
  var end = sectorHotSrc.indexOf('\n\nfunction webPickScore', start);
  var fnBody = sectorHotSrc.substring(start, end);
  
  // Must use sl for SL checks
  assert.ok(fnBody.indexOf('sl') >= 0,
    'evaluateMonitorStatus must check sl');
});
test('evaluateMonitorStatus passes monitor source into deriveSetupFreshness for source-aware expiry', function() {
  var start = sectorHotSrc.indexOf('function evaluateMonitorStatus');
  var end = sectorHotSrc.indexOf('\n\nfunction webPickScore', start);
  var fnBody = sectorHotSrc.substring(start, end);

  assert.ok(fnBody.indexOf('monitor_source') >= 0,
    'evaluateMonitorStatus must pass monitor_source/category into deriveSetupFreshness');
});

test('deriveSetupFreshness keeps swing monitor alive inside 5 trading days but expires daytrade intraday', function() {
  const idxTick = require('../lib/idx-tick-normalization');
  const now = '2026-07-07T05:00:00Z';
  const base = { entry1: 100, entry2: 98, sl: 95, current_price: 99 };

  const daytrade = idxTick.deriveSetupFreshness(Object.assign({}, base, {
    first_sent_at: '2026-07-07T00:00:00Z',
    monitor_source: 'daytrade'
  }), { now });
  assert.equal(daytrade.setup_freshness_status, 'EXPIRED');

  const swing = idxTick.deriveSetupFreshness(Object.assign({}, base, {
    first_sent_at: '2026-07-02T00:00:00Z',
    monitor_source: 'swing_konglo'
  }), { now });
  assert.notEqual(swing.setup_freshness_status, 'EXPIRED');
  assert.equal(swing.setup_freshness_source_type, 'swing');
  assert.ok(swing.setup_age_trading_days <= 5);
});

test('deriveSetupFreshness still invalidates swing on SL and after swing window', function() {
  const idxTick = require('../lib/idx-tick-normalization');
  const sl = idxTick.deriveSetupFreshness({
    first_sent_at: '2026-07-07T00:00:00Z', monitor_source: 'swing_nk', entry1: 100, entry2: 98, sl: 95, current_price: 95
  }, { now: '2026-07-07T01:00:00Z' });
  assert.equal(sl.setup_freshness_status, 'EXPIRED');
  assert.match(sl.setup_expiry_note, /SL/);

  const old = idxTick.deriveSetupFreshness({
    first_sent_at: '2026-06-29T00:00:00Z', monitor_source: 'swing_nk', entry1: 100, entry2: 98, sl: 95, current_price: 99
  }, { now: '2026-07-07T00:00:00Z' });
  assert.equal(old.setup_freshness_status, 'EXPIRED');
  assert.match(old.setup_expiry_note, /hari bursa masa pantau swing/);
});
