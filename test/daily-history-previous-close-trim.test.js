'use strict';

// Regression coverage for previous_close at the retention-window boundary.
//
// candlesToHistoryRows() trimmed the fetched series to the retention window
// and then chained previous_close from the TRIMMED array:
//
//   var trimmed = candles.slice(-retention);
//   var priorCandle = index > 0 ? trimmed[index - 1] : null;
//
// so the oldest retained row always got previous_close: null even though its
// real prior session was still present in the fetched series. The module's own
// docstring states the intent — "chained from the prior candle in the SAME
// fetched series (a real prior trading session, never a fabricated
// placeholder)" — and for the boundary row that real prior session exists.
//
// It also silently regressed stored data: on each daily run the row that had
// just become the oldest in the window was re-upserted with previous_close
// null, overwriting the correct value written on the previous run.

const test = require('node:test');
const assert = require('node:assert/strict');

const { candlesToHistoryRows } = require('../lib/daily-history-collector');

function makeCandles(startClose, count) {
  const candles = [];
  const start = new Date('2026-01-01T00:00:00Z');
  for (let i = 0; i < count; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    candles.push({
      date: d.toISOString().slice(0, 10),
      open: startClose + i,
      high: startClose + i + 1,
      low: startClose + i - 1,
      close: startClose + i,
      volume: 1000 + i
    });
  }
  return candles;
}

test('the oldest retained row keeps the real prior session close', () => {
  const candles = makeCandles(100, 200);
  const rows = candlesToHistoryRows('BBCA', candles, { retentionSessions: 120 });

  assert.equal(rows.length, 120);
  // trimmed window starts at candles[80]; its real prior session is candles[79].
  assert.equal(rows[0].trade_date, candles[80].date);
  assert.equal(rows[0].previous_close, candles[79].close,
    'oldest retained row lost its real prior close');
});

test('every retained row chains to the session immediately before it', () => {
  const candles = makeCandles(100, 200);
  const rows = candlesToHistoryRows('BBCA', candles, { retentionSessions: 120 });
  const trimStart = candles.length - 120;

  for (let i = 0; i < rows.length; i++) {
    assert.equal(
      rows[i].previous_close,
      candles[trimStart + i - 1].close,
      'row ' + i + ' (' + rows[i].trade_date + ') is not chained to its real prior session'
    );
  }
});

test('a re-run one session later does not null out a previously correct value', () => {
  // Simulates two consecutive daily collector runs over a rolling window.
  const day1 = makeCandles(100, 200);
  const day2 = makeCandles(100, 201);

  const rows1 = candlesToHistoryRows('BBCA', day1, { retentionSessions: 120 });
  const rows2 = candlesToHistoryRows('BBCA', day2, { retentionSessions: 120 });

  // The row that was second-oldest on day 1 is oldest on day 2.
  const boundaryDate = rows2[0].trade_date;
  const day1Row = rows1.find(r => r.trade_date === boundaryDate);
  assert.ok(day1Row, 'expected the boundary date to exist in both runs');
  assert.ok(day1Row.previous_close != null, 'precondition: day 1 wrote a real value');
  assert.equal(rows2[0].previous_close, day1Row.previous_close,
    're-run overwrote a correct previous_close with null');
});

test('the very first candle of the fetched series still has no prior', () => {
  // When nothing is trimmed there genuinely is no earlier session, and null is
  // correct — this pins that the fix does not fabricate a placeholder.
  const candles = makeCandles(100, 3);
  const rows = candlesToHistoryRows('BBCA', candles, {});
  assert.equal(rows.length, 3);
  assert.equal(rows[0].previous_close, null);
  assert.equal(rows[1].previous_close, 100);
  assert.equal(rows[2].previous_close, 101);
});

test('retention larger than the fetched series behaves like no trimming', () => {
  const candles = makeCandles(100, 10);
  const rows = candlesToHistoryRows('BBCA', candles, { retentionSessions: 500 });
  assert.equal(rows.length, 10);
  assert.equal(rows[0].previous_close, null);
  assert.equal(rows[9].previous_close, candles[8].close);
});

test('a single-candle series produces one row with no prior', () => {
  const candles = makeCandles(100, 1);
  const rows = candlesToHistoryRows('BBCA', candles, { retentionSessions: 120 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].previous_close, null);
});
