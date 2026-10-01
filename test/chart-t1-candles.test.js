'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../lib/chart-t1-policy');
const adminSession = require('../lib/admin-session');
const handler = require('../api/candles');

const SESSION_SECRET = 'chart-t1-candles-admin-test-secret';

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
  return {
    code: null,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function adminCookie() {
  process.env.SESSION_SECRET = SESSION_SECRET;
  const token = adminSession.createSessionToken({
    userId: 'admin-1', username: 'budi', isAdmin: true, deviceId: 'chart-test-device'
  });
  return 'ac_sess=' + token;
}

async function callApi(ticker) {
  const res = mockResponse();
  await handler({ method: 'GET', query: { ticker: ticker || 'BBCA' }, headers: { cookie: adminCookie() } }, res);
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
  assert.equal(res.body.patternMap, null);
  assert.match(res.body.pattern_map_meta.reason, /^[a-z0-9_]{1,64}$/);
  assert.deepEqual(res.body.pattern_map_meta, { engine: 'abcd-t1-v1', status: 'none', reason: 'invalid_ohlc' });
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  assert.equal(res.headers.Vary, 'Cookie');
});

test('malformed timestamps are discarded and completed filtered result is cached', async (t) => {
  handler.__test.clearCache();
  handler.__test.clock.now = () => atJakarta('2026-07-27');
  t.after(() => { handler.__test.clock.now = () => new Date(); delete global.fetch; handler.__test.clearCache(); });
  let fetches = 0;
  const malformed = [
    null, undefined, '', '   ', '0', '1721800000', false, true, [], [0], {},
    '0x10', NaN, Infinity, -Infinity
  ];
  const rows = malformed.map((timestamp, index) => ({
    timestamp, open: 1000 + index, high: 1002 + index, low: 999 + index,
    close: 1001 + index, volume: 100000 + index
  }));
  for (let day = 5; day <= 24; day++) rows.push({
    timestamp: unixAtJakarta('2026-07-' + String(day).padStart(2, '0')),
    open: day - 1, high: day + 1, low: day - 2, close: day, volume: day * 100
  });
  rows.push(
    { timestamp: unixAtJakarta('2026-07-27'), open: 99, high: 100, low: 98, close: 99, volume: 999 }
  );
  global.fetch = async () => { fetches++; return { ok: true, json: async () => yahooPayload(rows) }; };
  const first = await callApi('TLKM');
  const second = await callApi('TLKM');
  assert.equal(fetches, 1);
  assert.equal(first.body.candles.length, 20);
  assert.equal(second.body.candles.length, 20);
  assert.equal(first.body.candles.some((c) => c.time.startsWith('1970-')), false);
  assert.deepEqual(first.body.latest, { date: '2026-07-24', last: 24, open: 23, high: 25, low: 22, volume: 2400 });
  assert.deepEqual(first.body.metrics, { ma20: 14.5, ma50: null, ma100: null, ma200: null, rsi14: 100, volumeAvg20: 1450, volumeVsAvg20: 1.66 });
  assert.equal(first.body.actual_data_date, '2026-07-24');
  assert.deepEqual(second.body.latest, first.body.latest);
  assert.deepEqual(second.body.metrics, first.body.metrics);
  assert.equal(second.body.actual_data_date, '2026-07-24');
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

test('endpoint detector receives only finalized T-1 candles and binds ticker, date and candle set', async (t) => {
  handler.__test.clearCache(); handler.__test.clock.now = () => atJakarta('2026-07-27');
  t.after(() => { handler.__test.clock.now = () => new Date(); handler.__test.resetPatternDetector(); delete global.fetch; handler.__test.clearCache(); });
  const rows = [];
  for (let day = 1; day <= 24; day++) rows.push({ timestamp: unixAtJakarta(`2026-07-${String(day).padStart(2, '0')}`), open: day + 1, high: day + 3, low: day, close: day + 2, volume: day });
  rows.push({ timestamp: unixAtJakarta('2026-07-27'), open: 900, high: 902, low: 899, close: 901, volume: 1 });
  global.fetch = async () => ({ ok: true, json: async () => yahooPayload(rows) });
  handler.__test.setPatternDetector((candles, options) => ({ candidate: { marker: true, ticker: options.ticker, dataDate: options.dataDate, candles }, reason: 'found' }));
  const res = await callApi('bbca');
  assert.equal(res.body.patternMap.ticker, 'BBCA'); assert.equal(res.body.patternMap.dataDate, '2026-07-24');
  assert.strictEqual(res.body.patternMap.candles, res.body.candles);
  assert.equal(res.body.patternMap.candles.some(c => c.time === '2026-07-27'), false);
  assert.deepEqual(res.body.pattern_map_meta, { engine: 'abcd-t1-v1', status: 'found', reason: 'found' });
});

test('detector failure is isolated and cached response stays deterministic', async (t) => {
  handler.__test.clearCache(); handler.__test.clock.now = () => atJakarta('2026-07-27');
  t.after(() => { handler.__test.clock.now = () => new Date(); handler.__test.resetPatternDetector(); delete global.fetch; handler.__test.clearCache(); });
  let fetches = 0;
  global.fetch = async () => { fetches++; return { ok: true, json: async () => yahooPayload(Array.from({ length: 20 }, (_, i) => ({
    timestamp: unixAtJakarta(`2026-07-${String(i + 1).padStart(2, '0')}`), open: 10, high: 12, low: 9, close: 11, volume: 1
  }))) }; };
  handler.__test.setPatternDetector(() => { throw new Error('private stack value'); });
  const first = await callApi('TLKM'), second = await callApi('TLKM');
  assert.equal(first.body.success, true); assert.equal(first.body.patternMap, null);
  assert.deepEqual(first.body.pattern_map_meta, { engine: 'abcd-t1-v1', status: 'none', reason: 'detector_error' });
  assert.doesNotMatch(JSON.stringify(first.body), /private stack value/); assert.deepEqual(second.body, first.body); assert.equal(fetches, 1);
});

test('Jakarta date cache binding cannot return an obsolete pattern result', async (t) => {
  handler.__test.clearCache(); let today = '2026-07-27'; handler.__test.clock.now = () => atJakarta(today);
  t.after(() => { handler.__test.clock.now = () => new Date(); handler.__test.resetPatternDetector(); delete global.fetch; handler.__test.clearCache(); });
  let fetches = 0; global.fetch = async () => { fetches++; return { ok: true, json: async () => yahooPayload([
    { timestamp: unixAtJakarta('2026-07-24'), open: 10, high: 12, low: 9, close: 11, volume: 1 },
    { timestamp: unixAtJakarta('2026-07-27'), open: 11, high: 13, low: 10, close: 12, volume: 1 }
  ]) }; };
  handler.__test.setPatternDetector((candles) => ({ candidate: null, reason: `none_${candles.at(-1).time}` }));
  const first = await callApi('ASII'); today = '2026-07-28'; const second = await callApi('ASII');
  assert.equal(first.body.actual_data_date, '2026-07-24'); assert.equal(second.body.actual_data_date, '2026-07-27');
  assert.notEqual(first.body.pattern_map_meta.reason, second.body.pattern_map_meta.reason); assert.equal(fetches, 2);
});
