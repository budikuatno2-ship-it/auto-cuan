'use strict';

// OFFLINE ONLY: actual handlers and canonical market_rows SQLite, never production data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const store = require('../lib/local-market-subset-store');
const chart = require('../api/chart');
const candlesApi = require('../api/candles');
const validation = require('../lib/ihsg-validation');
const now = new Date('2026-11-17T11:00:00Z');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'OFFLINE_chart_remediation_'));
  const dbPath = path.join(root, 'data', 'market.sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE market_rows(table_name TEXT NOT NULL,row_key TEXT NOT NULL,row_json TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(table_name,row_key))');
  const ins = db.prepare('INSERT INTO market_rows VALUES(?,?,?,?)');
  const bbca = { ticker: 'BBCA', trade_date: '2026-11-16', open: 5500, high: 5600, low: 5425, close: 5600, volume: null, source: 'yahoo_chart', source_sha256: 'offline-bbca-receipt', received_at: '2026-11-17T07:22:40Z' };
  const ihsg = { ticker: 'IHSG', trade_date: '2026-11-16', open: 5335.43701171875, high: 5355.60302734375, low: 5272.47021484375, close: 5320.98095703125, volume: 419464900, source: 'yahoo_chart', source_sha256: 'offline-ihsg-receipt', received_at: '2026-11-17T07:22:40Z' };
  for (const row of [{ ...bbca, trade_date: '2026-11-13', close: 5500, volume: 0 }, bbca, { ...bbca, trade_date: '2026-11-17', close: 5550 }, ihsg]) {
    ins.run('stock_daily_history', row.ticker + '\x1f' + row.trade_date, JSON.stringify(row), '2026-11-17T07:23:00Z');
  }
  db.close();
  fs.mkdirSync(path.join(root, 'data/ohlcv'), { recursive: true });
  for (const ticker of ['BBCA', 'IHSG']) fs.writeFileSync(path.join(root, 'data/ohlcv', ticker + '.json'), JSON.stringify({ candles: Array.from({ length: 25 }, (_, i) => ({ date: i === 24 ? '2026-11-16' : '2026-10-' + String(i + 1).padStart(2, '0'), open: 7460.5, high: 7495.8, low: 7445.1, close: 7480.25, volume: 10 })) }));
  const originalCwd = process.cwd();
  t.after(() => { if (process.cwd() === root) process.chdir(originalCwd); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, dbPath, bbca, ihsg };
}

function call(handler, ticker, query = {}) {
  let body;
  const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { body = value; return this; }, end(value) { if (value) body = JSON.parse(value); } };
  return Promise.resolve(handler({ method: 'GET', query: { ticker, ...query }, headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res)).then(() => ({ status: res.statusCode, body }));
}

function apiEnvironment(t, f) {
  const oldDb = process.env.AUTO_CUAN_MARKET_DB;
  const cwd = process.cwd();
  const fetch = global.fetch;
  process.env.AUTO_CUAN_MARKET_DB = f.dbPath;
  process.chdir(f.root);
  global.fetch = async () => { throw new Error('OFFLINE: unexpected network fallback'); };
  candlesApi.__test.clock.now = () => now;
  candlesApi.__test.clearCache();
  t.after(() => { process.chdir(cwd); if (oldDb === undefined) delete process.env.AUTO_CUAN_MARKET_DB; else process.env.AUTO_CUAN_MARKET_DB = oldDb; global.fetch = fetch; candlesApi.__test.clock.now = () => new Date(); candlesApi.__test.clearCache(); });
}

test('canonical SQLite wins by ticker/date even with fewer than 20 rows; unknown volume is not zero', t => {
  const f = fixture(t);
  const got = store.getCandles('BBCA', { root: f.root, dbPath: f.dbPath, asOf: '2026-11-16' });
  assert.equal(got.latest.date, '2026-11-16');
  assert.equal(got.latest.open, 5500);
  assert.equal(got.latest.last, 5600);
  assert.equal(got.latest.volume, null);
  assert.equal(got.candles.find(c => c.time === '2026-11-13').volume, 0);
  assert.equal(got.metrics.volumeAvg20, null);
  assert.equal(got.metrics.volumeVsAvg20, null);
  assert.equal(got.latest.provenance.storage, 'sqlite_market_rows');
  assert.equal(got.latest.provenance.row_key, 'BBCA\x1f2026-11-16');
  assert.equal(got.latest.provenance.source_sha256, f.bbca.source_sha256);
  assert.equal(got.latest.provenance.volume_status, 'UNKNOWN');
  assert.equal(got.latest.provenance.trade_date, got.latest.date);
  assert.equal(got.candles.some(c => c.time > '2026-11-16'), false);
});

test('chart builder and actual handler keep exact recovered OHLC and date, never double/substitute', async t => {
  const f = fixture(t);
  apiEnvironment(t, f);
  for (const ticker of ['BBCA', 'IHSG']) {
    const expected = ticker === 'BBCA' ? f.bbca : f.ihsg;
    const built = chart.buildChartResponse(ticker, now, { root: f.root, dbPath: f.dbPath });
    // Historical recovery proof must stay bound to its date after the wall clock advances.
    const response = await call(chart, ticker, { as_of: '2026-11-16' });
    for (const got of [built.payload, response.body]) {
      assert.equal(got.success, true);
      assert.equal(got.actual_data_date, '2026-11-16');
      assert.equal(got.latest.open, expected.open);
      assert.equal(got.latest.close, expected.close);
      assert.equal(got.latest.volume, expected.volume);
      assert.equal(got.candles.at(-1).provenance.storage, 'sqlite_market_rows');
    }
  }
});

test('actual candles API uses canonical short series; exact index decimals and true zero survive', async t => {
  const f = fixture(t);
  apiEnvironment(t, f);
  for (const ticker of ['BBCA', 'IHSG']) {
    const got = await call(candlesApi, ticker);
    const expected = ticker === 'BBCA' ? f.bbca : f.ihsg;
    assert.equal(got.status, 200);
    assert.equal(got.body.latest.date, '2026-11-16');
    assert.equal(got.body.latest.open, expected.open);
    assert.equal(got.body.latest.last, expected.close);
    assert.equal(got.body.latest.volume, expected.volume);
    assert.equal(got.body.latest.provenance.trade_date, '2026-11-16');
    if (ticker === 'BBCA') {
      assert.equal(got.body.candles.find(c => c.time === '2026-11-13').volume, 0);
      assert.equal(got.body.metrics.volumeVsAvg20, null);
    }
  }
});

test('short positive-volume history keeps unavailable average and ratio unknown', async t => {
  const f = fixture(t);
  apiEnvironment(t, f);
  const db = new DatabaseSync(f.dbPath);
  db.prepare('DELETE FROM market_rows WHERE table_name = ? AND row_key = ?').run('stock_daily_history', 'IHSG\x1f2026-11-16');
  db.prepare('UPDATE market_rows SET row_json = ? WHERE table_name = ? AND row_key = ?').run(JSON.stringify({ ...f.bbca, trade_date: '2026-11-13', volume: 10 }), 'stock_daily_history', 'BBCA\x1f2026-11-13');
  db.prepare('UPDATE market_rows SET row_json = ? WHERE table_name = ? AND row_key = ?').run(JSON.stringify({ ...f.bbca, volume: 20 }), 'stock_daily_history', 'BBCA\x1f2026-11-16');
  db.close();

  const response = await call(candlesApi, 'BBCA');
  assert.equal(response.body.metrics.volumeAvg20, null);
  assert.equal(response.body.metrics.volumeVsAvg20, null);
});

test('historical API requests bind price/volume/provenance to as_of and cannot share current cache', async t => {
  const f = fixture(t);
  apiEnvironment(t, f);
  await call(candlesApi, 'BBCA');
  const older = await call(candlesApi, 'BBCA', { as_of: '2026-11-13', interval: '1d' });
  assert.equal(older.body.latest.date, '2026-11-13');
  assert.equal(older.body.latest.last, 5500);
  assert.equal(older.body.latest.volume, 0);
  assert.equal(older.body.latest.provenance.row_key, 'BBCA\x1f2026-11-13');
  assert.equal(older.body.latest.provenance.volume_status, 'OBSERVED_ZERO');
  const chartOlder = await call(chart, 'BBCA', { as_of: '2026-11-13' });
  assert.equal(chartOlder.body.latest.date, '2026-11-13');
  assert.equal(chartOlder.body.latest.last, 5500);
});

test('chart accepts the literal Yahoo index symbol without changing prices', async t => {
  const f = fixture(t);
  apiEnvironment(t, f);
  const response = await call(chart, '^JKSE', { as_of: '2026-11-16' });
  assert.equal(response.body.success, true);
  assert.equal(response.body.latest.close, f.ihsg.close);
  assert.equal(response.body.latest.date, f.ihsg.trade_date);
  assert.equal(response.body.latest.volume, f.ihsg.volume);
});

test('IHSG price validation has no unsupported modern/historical range', () => {
  for (const [date, close] of [['2026-11-16', 5320.98095703125], ['2026-11-13', 9000], ['1984-01-03', 100]]) assert.equal(validation.isValidIhsgCandle({ date, close }), true);
  for (const close of [null, '', NaN, Infinity, -1, 0]) assert.equal(validation.isValidIhsgCandle({ date: '2026-11-16', close }), false);
});

test('historical canonical absence and invalid rows never substitute flat files or trigger fallback', async t => {
  const f = fixture(t);
  apiEnvironment(t, f);
  const absent = store.readCandleSeries('BBCA', { root: f.root, dbPath: f.dbPath, asOf: '2026-10-01' });
  assert.deepEqual(absent.candles, []);
  const response = await call(candlesApi, 'BBCA', { as_of: '2026-10-01' });
  assert.equal(response.body.success, false);
  assert.equal(response.body.data_status, 'unavailable');
  const db = new DatabaseSync(f.dbPath);
  db.prepare('UPDATE market_rows SET row_json = ? WHERE row_key = ?').run(JSON.stringify({ ...f.bbca, high: 1 }), 'BBCA\x1f2026-11-16');
  db.close();
  const invalid = store.readCandleSeries('BBCA', { root: f.root, dbPath: f.dbPath, asOf: '2026-11-16' });
  assert.deepEqual(invalid.candles.map(c => c.time), ['2026-11-13']);
});

test('same-day canonical updates refresh API cache and retain actual recovery provenance', async t => {
  const f = fixture(t);
  apiEnvironment(t, f);
  const before = await call(candlesApi, 'BBCA');
  assert.equal(before.body.latest.last, 5600);
  const recovered = JSON.parse(fs.readFileSync(path.join(__dirname, '../audit-evidence/v6_recovery_17nov/yahoo_a/evidence/canary/applied.json'))).readbacks[0].row;
  const db = new DatabaseSync(f.dbPath);
  db.prepare('UPDATE market_rows SET row_json = ? WHERE row_key = ?').run(JSON.stringify({ ...recovered, close: 5550 }), 'BBCA\x1f2026-11-16');
  db.close();
  const after = await call(candlesApi, 'BBCA');
  assert.equal(after.body.latest.last, 5550);
  assert.equal(after.body.latest.provenance.source_sha256, recovered.source_provenance.raw_sha256);
  assert.equal(after.body.latest.provenance.source_bar_timestamp, recovered.source_bar_timestamp);
  assert.equal(after.body.latest.provenance.received_at, recovered.response_received_at);
  assert.equal(after.body.latest.provenance.source_published_at, null);
});

test('saved deployed snapshot still reproduces original corruption (offline virtual files)', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../audit-evidence/v6_recovery_17nov/independent_review/deployed_chart.js'), 'utf8');
  for (const [ticker, close, expected, date] of [['BBCA', 5600, 11200, '2026-11-16'], ['IHSG', 5320.98095703125, 7480.25, '2026-11-04']]) {
    const module = { exports: {} };
    vm.runInNewContext(source, { module, exports: module.exports, __dirname: path.join(__dirname, '../api'), require(name) { if (name === 'path') return path; if (name === 'fs') return { existsSync: () => true, readFileSync: () => JSON.stringify({ candles: [{ date: '2026-11-16', open: close, high: close, low: close, close, volume: null }] }) }; throw Error('unexpected import'); } });
    const got = await call(module.exports, ticker);
    assert.equal(got.body.latest.close, expected);
    assert.equal(got.body.latest.date, date);
  }
});
