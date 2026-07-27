'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../lib/chart-t1-policy');
const handler = require('../api/candles');

function atJakarta(date, hour) {
  return new Date(date + 'T' + String(hour == null ? 12 : hour).padStart(2, '0') + ':00:00+07:00');
}

function candle(time, close) {
  return { time, open: close - 1, high: close + 2, low: close - 2, close, volume: close * 100 };
}

test('current Jakarta-date and future candles are removed; prior day and order remain', () => {
  const input = [candle('2026-07-26', 10), candle('2026-07-27', 11), candle('2026-07-28', 12)];
  const result = policy.retainCompletedCandles(input, atJakarta('2026-07-27'));
  assert.deepEqual(result.candles.map((c) => c.time), ['2026-07-26']);
  assert.equal(result.metadata.actual_data_date, '2026-07-26');
});

test('Monday excludes Monday and retains Friday without false verification', () => {
  const result = policy.retainCompletedCandles([candle('2026-07-24', 10), candle('2026-07-27', 11)], atJakarta('2026-07-27'));
  assert.equal(result.candles.at(-1).time, '2026-07-24');
  assert.equal(result.metadata.expected_t1_date, '2026-07-24');
  assert.equal(result.metadata.t1_status, 'calendar_unverified');
  assert.equal(result.metadata.t1_verified, false);
  assert.equal(result.metadata.t1_reason, 'idx_holiday_calendar_unavailable');
});

test('weekend execution uses Friday as weekday candidate and retains Friday', () => {
  const result = policy.retainCompletedCandles([candle('2026-07-24', 10)], atJakarta('2026-07-25'));
  assert.equal(result.metadata.expected_t1_date, '2026-07-24');
  assert.equal(result.metadata.t1_status, 'calendar_unverified');
});

for (const boundary of [
  ['month boundary', '2026-03-01', '2026-02-27'],
  ['year boundary', '2026-01-01', '2025-12-31'],
  ['leap-year boundary', '2024-03-01', '2024-02-29']
]) {
  test(boundary[0] + ' computes a truthful weekday candidate', () => {
    assert.equal(policy.previousWeekday(boundary[1]), boundary[2]);
  });
}

test('only-today and empty input produce explicit missing metadata', () => {
  for (const input of [[], [candle('2026-07-27', 10)]]) {
    const result = policy.retainCompletedCandles(input, atJakarta('2026-07-27'));
    assert.deepEqual(result.candles, []);
    assert.equal(result.metadata.t1_status, 'missing');
    assert.equal(result.metadata.actual_data_date, null);
    assert.equal(result.metadata.t1_verified, false);
  }
});

test('stale history is explicit', () => {
  const result = policy.retainCompletedCandles([candle('2026-07-22', 10)], atJakarta('2026-07-27'));
  assert.equal(result.metadata.expected_t1_date, '2026-07-24');
  assert.equal(result.metadata.t1_status, 'stale');
  assert.equal(result.metadata.t1_reason, 'actual_data_predates_previous_weekday_candidate');
});

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

function unixAtJakarta(date) { return Date.parse(date + 'T09:00:00+07:00') / 1000; }

function mockResponse() {
  return { code: null, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}

async function callApi(ticker) {
  const res = mockResponse();
  await handler({ method: 'GET', query: { ticker: ticker || 'BBCA' } }, res);
  return res;
}

test('endpoint filters before latest and every indicator, and preserves response compatibility', async (t) => {
  handler.__test.clearCache();
  handler.__test.clock.now = () => atJakarta('2026-07-27');
  t.after(() => { handler.__test.clock.now = () => new Date(); delete global.fetch; handler.__test.clearCache(); });
  const rows = [];
  for (let day = 1; day <= 24; day++) rows.push({ timestamp: unixAtJakarta('2026-07-' + String(day).padStart(2, '0')), open: day, high: day + 1, low: day - 1, close: day, volume: day * 100 });
  rows.push({ timestamp: unixAtJakarta('2026-07-27'), open: 999, high: 1000, low: 998, close: 999, volume: 999999 });
  rows.push({ timestamp: unixAtJakarta('2026-07-28'), open: 1001, high: 1002, low: 1000, close: 1001, volume: 1000000 });
  global.fetch = async () => ({ ok: true, json: async () => yahooPayload(rows) });
  const res = await callApi();
  assert.equal(res.code, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.ticker, 'BBCA');
  assert.equal(res.body.source, 'Data Historis T-1');
  assert.equal(res.body.totalCandles, 24);
  assert.equal(res.body.latest.date, '2026-07-24');
  assert.equal(res.body.latest.last, 24);
  assert.equal(res.body.metrics.ma20, 14.5);
  assert.equal(res.body.metrics.rsi14, 100);
  assert.equal(res.body.metrics.volumeAvg20, 1450);
  assert.equal(res.body.metrics.volumeVsAvg20, 1.66);
  assert.equal(res.body.actual_data_date, '2026-07-24');
  assert.equal(res.body.jakarta_today, '2026-07-27');
  assert.equal(res.body.t1_status, 'calendar_unverified');
  assert.equal(res.body.t1_verified, false);
  assert.ok(Array.isArray(res.body.candles));
  assert.deepEqual(res.body.candles.map((c) => c.time), rows.slice(0, 24).map((r) => policy.formatJakartaDate(new Date(r.timestamp * 1000))));
});

test('malformed timestamps are discarded and completed filtered result is cached', async (t) => {
  handler.__test.clearCache();
  handler.__test.clock.now = () => atJakarta('2026-07-27');
  t.after(() => { handler.__test.clock.now = () => new Date(); delete global.fetch; handler.__test.clearCache(); });
  let fetches = 0;
  const rows = [
    { timestamp: 'bad', open: 1, high: 2, low: 0, close: 1, volume: 10 },
    { timestamp: unixAtJakarta('2026-07-24'), open: 10, high: 12, low: 9, close: 11, volume: 100 },
    { timestamp: unixAtJakarta('2026-07-27'), open: 99, high: 100, low: 98, close: 99, volume: 999 }
  ];
  global.fetch = async () => { fetches++; return { ok: true, json: async () => yahooPayload(rows) }; };
  const first = await callApi('TLKM');
  const second = await callApi('TLKM');
  assert.equal(fetches, 1);
  assert.deepEqual(first.body.candles.map((c) => c.time), ['2026-07-24']);
  assert.deepEqual(second.body.candles.map((c) => c.time), ['2026-07-24']);
  assert.equal(second.body.jakarta_today, '2026-07-27');
});

test('endpoint returns missing metadata when upstream contains only today', async (t) => {
  handler.__test.clearCache();
  handler.__test.clock.now = () => atJakarta('2026-07-27');
  t.after(() => { handler.__test.clock.now = () => new Date(); delete global.fetch; handler.__test.clearCache(); });
  global.fetch = async () => ({ ok: true, json: async () => yahooPayload([
    { timestamp: unixAtJakarta('2026-07-27'), open: 1, high: 2, low: 0, close: 1, volume: 10 }
  ]) });
  const res = await callApi('ASII');
  assert.equal(res.body.success, false);
  assert.equal(res.body.t1_status, 'missing');
  assert.equal(res.body.actual_data_date, null);
});

test('empty upstream result returns explicit missing metadata', async (t) => {
  handler.__test.clearCache();
  handler.__test.clock.now = () => atJakarta('2026-07-27');
  t.after(() => { handler.__test.clock.now = () => new Date(); delete global.fetch; handler.__test.clearCache(); });
  global.fetch = async () => ({ ok: true, json: async () => ({ chart: { result: [] } }) });
  const res = await callApi('BBRI');
  assert.equal(res.body.success, false);
  assert.equal(res.body.t1_status, 'missing');
  assert.equal(res.body.t1_reason, 'no_completed_candle_before_jakarta_today');
});
