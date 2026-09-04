'use strict';

// Regression coverage for the 7-session volume window on a partial session.
//
// buildVolumeContext() drops the current session from the average when it is
// flagged 'partial', and to still have SEVEN settled sessions left it reaches
// one row further:
//
//   var windowRows = isTodayPartial ? rows.slice(1, 8) : rows.slice(0, 7);
//
// Its own unit test feeds it 8 rows, so the 7-session contract holds there.
// The only production caller fed it 7:
//
//   buildVolumeContext(historyRows.slice(0, DISPLAY_TRADING_SESSIONS))  // 7
//
// so on any partial session slice(1, 8) yielded only SIX rows and
// volume_avg_7d / volume_median_7d / volume_ratio_vs_7d_avg were computed over
// six sessions while still being labelled 7d. The unit test passed the whole
// time because it exercised a row count production never supplied.
//
// These tests drive the real builder entry point, so they fail if the wiring
// regresses again even while the module's own test stays green.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildContextFromRows } = require('../lib/daily-market-context-builder');
const { DISPLAY_TRADING_SESSIONS } = require('../lib/daily-market-context-constants');

// Newest-first, as the store returns them.
function historyRows(volumes, options) {
  options = options || {};
  const base = new Date('2026-08-14T00:00:00Z');
  return volumes.map((volume, index) => {
    const d = new Date(base.getTime() - index * 86400000);
    return {
      ticker: 'BBCA',
      trade_date: d.toISOString().slice(0, 10),
      open: 100, high: 101, low: 99, close: 100,
      previous_close: 100,
      volume,
      data_quality_status: index === 0 && options.todayPartial ? 'partial' : 'ok'
    };
  });
}

function volumeOf(rows) {
  return buildContextFromRows('BBCA', rows, [], null, {}).volume;
}

test('a partial session still averages seven settled sessions', () => {
  // Today is partial with a tiny intraday volume; the seven settled sessions
  // behind it are 1000, and an eighth older session is 8000. If the window is
  // six wide the eighth is never reached and the average stays 1000; if it is
  // seven wide the 8000 pulls it to 2000.
  const rows = historyRows([50, 1000, 1000, 1000, 1000, 1000, 1000, 8000], { todayPartial: true });
  const volume = volumeOf(rows);

  assert.equal(volume.is_today_partial_session, true);
  assert.equal(volume.today_session_status, 'INTRADAY_PARTIAL');
  assert.equal(volume.volume_avg_7d, 2000,
    'volume_avg_7d averaged fewer than seven settled sessions');
});

test('the partial session itself is never counted in the average', () => {
  const rows = historyRows([50, 1000, 1000, 1000, 1000, 1000, 1000, 1000], { todayPartial: true });
  const volume = volumeOf(rows);
  assert.equal(volume.volume_avg_7d, 1000, 'the partial session leaked into the average');
});

test('the median also spans seven settled sessions', () => {
  const rows = historyRows([50, 1, 2, 3, 4, 5, 6, 7], { todayPartial: true });
  const volume = volumeOf(rows);
  // Settled sessions 1..7 -> median 4. A six-wide window would see 1..6 -> 3.5.
  assert.equal(volume.volume_median_7d, 4);
});

test('volume_ratio_vs_7d_avg uses the seven-session average', () => {
  const rows = historyRows([1000, 1000, 1000, 1000, 1000, 1000, 1000, 8000], { todayPartial: true });
  const volume = volumeOf(rows);
  assert.equal(volume.volume_avg_7d, 2000);
  assert.equal(volume.volume_ratio_vs_7d_avg, 0.5);
});

// --- behaviour that must NOT change -----------------------------------------

test('a settled session still averages exactly seven sessions including today', () => {
  const rows = historyRows([100, 200, 300, 400, 500, 600, 700, 99999]);
  const volume = volumeOf(rows);
  assert.equal(volume.is_today_partial_session, false);
  assert.equal(volume.today_session_status, 'FINAL_EOD');
  // (100+200+300+400+500+600+700)/7 = 400; the eighth row must stay excluded.
  assert.equal(volume.volume_avg_7d, 400);
});

test('volume_history_7d still shows exactly seven sessions', () => {
  const rows = historyRows([100, 200, 300, 400, 500, 600, 700, 800]);
  const volume = volumeOf(rows);
  assert.equal(volume.volume_history_7d.length, DISPLAY_TRADING_SESSIONS);
  // oldest-first for chart display
  assert.equal(volume.volume_history_7d[0].volume, 700);
  assert.equal(volume.volume_history_7d[6].volume, 100);
});

test('today and previous session still come from the two newest rows', () => {
  const rows = historyRows([111, 222, 333, 444, 555, 666, 777, 888]);
  const volume = volumeOf(rows);
  assert.equal(volume.volume_today, 111);
  assert.equal(volume.volume_previous_session, 222);
});

test('a short history is handled without fabricating zeros', () => {
  const rows = historyRows([100, 200]);
  const volume = volumeOf(rows);
  assert.equal(volume.volume_today, 100);
  assert.equal(volume.volume_previous_session, 200);
  assert.equal(volume.volume_avg_7d, 150);
});

test('an empty history yields nulls, not zeros', () => {
  const volume = volumeOf([]);
  assert.equal(volume.volume_today, null);
  assert.equal(volume.volume_avg_7d, null);
  assert.equal(volume.volume_ratio_vs_7d_avg, null);
  assert.equal(volume.today_session_status, 'UNKNOWN');
});
