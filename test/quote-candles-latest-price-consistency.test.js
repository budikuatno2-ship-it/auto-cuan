'use strict';

// ===========================================================================
// Regression: /api/quote and /api/candles must agree on "last price".
//
// Pre-fix, /api/quote (fetchYahooQuote) kept the LAST candle Yahoo returned —
// during a trading session that is today's still-open Jakarta bar. /api/candles
// applies the completed-daily-candle (T-1) policy and drops that bar. So the two
// endpoints on the same page reported different prices, and quote's pivot was
// derived from an intraday bar while its comment claimed "T-1 completed candle".
//
// /api/quote also labelled candles with the naive UTC slice
// (`new Date(ts*1000).toISOString().slice(0,10)`), which is a day early for bars
// at/after 17:00 UTC — the same class of bug already fixed elsewhere with a WIB
// date key (lib/chart-t1-policy.js / lib/latest-price-resolver.js).
//
// LOCAL / STATIC ONLY. global.fetch is mocked; no network.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../lib/chart-t1-policy');
const quoteHandler = require('../api/quote');
const candlesHandler = require('../api/candles');

function jakartaToday() { return policy.formatJakartaDate(new Date()); }

function shift(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00.000Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// A normal IDX session opens ~09:00 WIB = 02:00 UTC.
function unixAtJakarta(date, time) {
  return Date.parse(date + 'T' + (time || '09:00:00') + '+07:00') / 1000;
}

function yahooPayload(rows) {
  return { chart: { result: [{
    timestamp: rows.map((r) => r.timestamp),
    indicators: { quote: [{
      open: rows.map((r) => r.open), high: rows.map((r) => r.high),
      low: rows.map((r) => r.low), close: rows.map((r) => r.close),
      volume: rows.map((r) => r.volume)
    }] }
  }] } };
}

function mockResponse() {
  return { code: null, body: null, headers: {},
    setHeader(n, v) { this.headers[n] = v; },
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; } };
}

async function callQuote(ticker) {
  const res = mockResponse();
  await quoteHandler({ method: 'GET', query: { ticker }, headers: {} }, res);
  return res;
}

async function callCandles(ticker) {
  candlesHandler.__test.clearCache();
  candlesHandler.__test.clock.now = () => new Date();
  const res = mockResponse();
  await candlesHandler({ method: 'GET', query: { ticker }, headers: {} }, res);
  return res;
}

function flatRow(date, close) {
  return { timestamp: unixAtJakarta(date), open: close, high: close, low: close, close, volume: 1000 };
}

test('quote and candles report the same last price, both from the T-1 close', async (t) => {
  const today = jakartaToday();
  const t1 = shift(today, -1);
  const rows = [];
  for (let i = 20; i >= 1; i--) rows.push(flatRow(shift(today, -i), 100));
  // Today's open bar carries a wildly different price: pre-fix quote used it.
  rows.push({ timestamp: unixAtJakarta(today), open: 500, high: 510, low: 490, close: 505, volume: 999999 });
  global.fetch = async () => ({ ok: true, json: async () => yahooPayload(rows) });
  t.after(() => { delete global.fetch; candlesHandler.__test.clearCache(); });

  const quote = await callQuote('BBCA');
  const candles = await callCandles('BBCA');

  assert.equal(quote.code, 200);
  assert.equal(quote.body.success, true);
  assert.equal(quote.body.last, 100, 'quote must not use the in-progress bar');
  assert.equal(candles.body.latest.last, 100);

  assert.equal(quote.body.last, candles.body.latest.last, 'endpoints must agree on last price');
  assert.equal(quote.body.latestBarDate, candles.body.latest.date, 'endpoints must agree on the bar date');
  assert.equal(quote.body.pivot.pivotSourceDate, t1, 'pivot must come from the T-1 close');
  assert.equal(quote.body.actual_data_date, t1);
  assert.equal(quote.body.jakarta_today, today);
});

test('quote labels candles with the WIB date, not the naive UTC slice', async (t) => {
  const today = jakartaToday();
  const t0 = shift(today, -2);
  const t1 = shift(today, -1);
  const rows = [];
  for (let i = 6; i >= 2; i--) rows.push(flatRow(shift(today, -i), 100));
  // Final completed bar: 18:00 UTC of t0 == 01:00 WIB of t1. Its WIB date is t1;
  // the old UTC slice would have labelled it t0.
  rows.push({ timestamp: Date.parse(t0 + 'T18:00:00Z') / 1000, open: 777, high: 777, low: 777, close: 777, volume: 5000 });
  global.fetch = async () => ({ ok: true, json: async () => yahooPayload(rows) });
  t.after(() => { delete global.fetch; candlesHandler.__test.clearCache(); });

  const quote = await callQuote('TLKM');

  assert.equal(quote.body.last, 777);
  assert.equal(quote.body.latestBarDate, t1, 'bar must be labelled with its WIB session date');
  assert.notEqual(quote.body.latestBarDate, t0, 'bar must not use the naive UTC slice');
  assert.equal(quote.body.pivot.pivotSourceDate, t1);
});

test('when only today is available both endpoints report no completed candle', async (t) => {
  const today = jakartaToday();
  global.fetch = async () => ({ ok: true, json: async () => yahooPayload([
    { timestamp: unixAtJakarta(today), open: 500, high: 510, low: 490, close: 505, volume: 999999 }
  ]) });
  t.after(() => { delete global.fetch; candlesHandler.__test.clearCache(); });

  const quote = await callQuote('ANTM');
  const candles = await callCandles('ANTM');

  assert.equal(quote.body.success, false);
  assert.equal(candles.body.success, false);
});