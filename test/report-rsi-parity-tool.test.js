'use strict';

// Basic correctness coverage for the RSI parity diagnostic tool
// (tools/report-rsi-parity.js), built for Task 1/15 of the 12 Aug 2026
// correctness audit. This tool needs real network (Yahoo Finance) and
// Supabase access to produce real numbers, neither of which are available
// in this sandbox — these tests only cover its pure, network-free helper
// functions, and that it degrades gracefully (never throws) when Yahoo is
// unreachable.

const test = require('node:test');
const assert = require('node:assert/strict');

const tool = require('../tools/report-rsi-parity');
const rsiLib = require('../lib/daily-rsi');

function makeCloses(count, seed) {
  const closes = [];
  let price = seed || 1000;
  for (let i = 0; i < count; i++) {
    price = Math.max(1, price * (1 + (i % 3 === 0 ? -0.02 : 0.012)));
    closes.push(Math.round(price * 100) / 100);
  }
  return closes;
}

test('referenceWilderRsi (independent reimplementation) matches lib/daily-rsi.js on the same input', () => {
  const closes = makeCloses(120, 1000);
  const dates = closes.map((_, i) => 'd' + i);
  const reference = tool.referenceWilderRsi(closes, 14);
  const production = rsiLib.computeLatestRsi(closes, dates, { period: 14 }).rsi_14;
  assert.ok(reference != null && production != null);
  assert.ok(Math.abs(reference - production) < 0.01, 'expected the independent reference implementation to match the production formula, got ref=' + reference + ' prod=' + production);
});

test('referenceWilderRsi returns null for insufficient history', () => {
  assert.equal(tool.referenceWilderRsi([100, 101, 102], 14), null);
});

test('rsiOverWindow slices to exactly the requested trailing window and matches a direct computeLatestRsi call on that slice', () => {
  const closes = makeCloses(120, 500);
  const dates = closes.map((_, i) => 'd' + i);
  const win = tool.rsiOverWindow(closes, dates, 30);
  assert.equal(win.history_length, 30);
  const expected = rsiLib.computeLatestRsi(closes.slice(-30), dates.slice(-30), { period: 14 });
  assert.equal(win.rsi_14, expected.rsi_14);
});

test('rsiOverWindow reports insufficient_history rather than fabricating a value when the series is shorter than the window', () => {
  const closes = makeCloses(10, 500);
  const dates = closes.map((_, i) => 'd' + i);
  const win = tool.rsiOverWindow(closes, dates, 30);
  assert.equal(win.rsi_14, null);
  assert.equal(win.insufficient_history, true);
});

test('analyzeTicker never throws when Yahoo Finance is unreachable (this sandbox blocks it) — degrades to a warning, not a crash', async () => {
  const row = await tool.analyzeTicker('BELL', { supabase: null, noDb: true, timeoutMs: 5000 });
  assert.equal(row.ticker, 'BELL');
  assert.ok(row.error, 'expected an error field to be set when the fetch fails');
  assert.ok(Array.isArray(row.warnings) && row.warnings.length > 0);
});

test('DEFAULT_TICKERS includes both tickers named in the original bug report', () => {
  assert.ok(tool.DEFAULT_TICKERS.includes('BELL'));
  assert.ok(tool.DEFAULT_TICKERS.includes('TIRA'));
});
