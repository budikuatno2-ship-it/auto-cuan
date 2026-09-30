'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function loadFresh(root, dataRoot) {
  process.env.AUTO_CUAN_MARKET_DATA_BACKEND = 'vps';
  process.env.AUTO_CUAN_ROOT = root;
  process.env.AUTO_CUAN_DATA_ROOT = dataRoot;

  for (const rel of [
    '../lib/vps-market-data-store',
    '../lib/stock-daily-history-store',
    '../lib/foreign-flow-store'
  ]) {
    try { delete require.cache[require.resolve(rel)]; } catch (_) {}
  }
  return {
    vps: require('../lib/vps-market-data-store'),
    history: require('../lib/stock-daily-history-store'),
    foreign: require('../lib/foreign-flow-store')
  };
}

test('VPS daily history reads local candles and never trims historical source rows', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autocuan-vps-data-'));
  const root = path.join(tmp, 'repo');
  const dataRoot = path.join(tmp, 'data-plane');
  const candleDir = path.join(root, 'data', 'daily-candles');
  fs.mkdirSync(candleDir, { recursive: true });
  fs.writeFileSync(path.join(candleDir, 'BBCA.json'), JSON.stringify({
    ticker: 'BBCA',
    candles: [
      { date: '2020-01-02', open: 100, high: 110, low: 90, close: 105, volume: 1000 },
      { date: '2026-09-28', open: 9000, high: 9200, low: 8950, close: 9100, volume: 2000 },
      { date: '2026-09-29', open: 9100, high: 9300, low: 9050, close: 9250, volume: 2200 }
    ]
  }));

  const { history } = loadFresh(root, dataRoot);
  const map = await history.getLatestSessionsForTickers(null, ['BBCA'], 2);
  assert.equal(map.get('BBCA').length, 2);
  assert.equal(map.get('BBCA')[0].trade_date, '2026-09-29');

  await history.upsertDailyHistory(null, [{
    ticker: 'BBCA', trade_date: '2026-09-30',
    open: 9250, high: 9400, low: 9200, close: 9350, volume: 2500,
    data_source: 'test'
  }]);
  assert.equal(await history.enforceRetention(null, ['BBCA'], 120), 0);

  const payload = JSON.parse(fs.readFileSync(path.join(candleDir, 'BBCA.json'), 'utf8'));
  assert.equal(payload.candles.some((r) => r.date === '2020-01-02'), true);
  assert.equal(payload.candles.some((r) => r.date === '2026-09-30'), true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('foreign flow reads and writes VPS local file without calling Supabase', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autocuan-vps-foreign-'));
  const root = path.join(tmp, 'repo');
  const dataRoot = path.join(tmp, 'data-plane');
  fs.mkdirSync(root, { recursive: true });
  const { vps, foreign } = loadFresh(root, dataRoot);

  vps.upsertForeignRows([
    { ticker: 'BBCA', trade_date: '2026-09-29', foreign_net: 10, close: 9000 },
    { ticker: 'BBCA', trade_date: '2026-09-30', foreign_net: 20, close: 9100 },
    { ticker: 'BBRI', trade_date: '2026-09-30', foreign_net: -5, close: 5000 }
  ]);

  const map = await foreign.getLatestForeignForTickers(null, ['BBCA'], 2);
  assert.deepEqual(map.get('BBCA').map((r) => r.foreign_net), [20, 10]);

  let delegated = 0;
  const raw = { from(table) { delegated += 1; return { table }; } };
  const hybrid = vps.wrapSupabaseClient(raw);
  const res = await hybrid.from('foreign_watchlist_daily')
    .select('ticker,trade_date,foreign_net')
    .eq('ticker', 'BBCA')
    .order('trade_date', { ascending: false })
    .limit(1);
  assert.equal(res.error, null);
  assert.equal(res.data[0].trade_date, '2026-09-30');
  assert.equal(delegated, 0);

  const control = hybrid.from('app_users');
  assert.equal(control.table, 'app_users');
  assert.equal(delegated, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('one-time migration snapshots heavy market tables and never deletes Supabase rows', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'migrate-market-data-to-vps.js'), 'utf8');
  for (const table of [
    'foreign_watchlist_daily',
    'daytrade_screener_latest',
    'swing_screener_latest',
    'swing_screener_non_konglo_staging',
    'telegram_daily_picks',
    'sector_hot_latest'
  ]) assert.equal(src.includes("'" + table + "'"), true, 'missing migration table ' + table);
  assert.equal(src.includes('.delete()'), false);
  assert.match(src, /row-count mismatch/);
  assert.match(src, /No Supabase rows were deleted/);
});


test('generic local table adapter supports screener upsert/update/delete and Telegram OR queries', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autocuan-vps-tables-'));
  const previousBackend = process.env.AUTO_CUAN_MARKET_DATA_BACKEND;
  const previousRoot = process.env.AUTO_CUAN_DATA_ROOT;
  process.env.AUTO_CUAN_MARKET_DATA_BACKEND = 'vps';
  process.env.AUTO_CUAN_DATA_ROOT = tmp;

  try {
    delete require.cache[require.resolve('../lib/vps-local-table-query')];
    delete require.cache[require.resolve('../lib/vps-market-data-store')];
    const tables = require('../lib/vps-local-table-query');
    const vps = require('../lib/vps-market-data-store');

    tables.writeTableRows('daytrade_screener_latest', [
      { ticker: 'BBCA', daytrade_score: 80, status: 'WATCHING' },
      { ticker: 'BBRI', daytrade_score: 70, status: 'WATCHING' }
    ], 'test');

    tables.writeTableRows('telegram_daily_picks', [
      { id: 1, date: '2026-09-30', ticker: 'BBCA', monitor_source: 'daily_top5', status: 'WAITING' },
      { id: 2, date: '2026-09-30', ticker: 'BBRI', monitor_source: null, status: 'WAITING' },
      { id: 3, date: '2026-09-30', ticker: 'TLKM', monitor_source: 'daytrade_signal', status: 'WAITING' }
    ], 'test');

    let delegated = 0;
    const raw = { from(table) { delegated += 1; return { table }; } };
    const hybrid = vps.wrapSupabaseClient(raw);

    const up = await hybrid.from('daytrade_screener_latest')
      .upsert([{ ticker: 'BBCA', daytrade_score: 91, status: 'READY_BREAKOUT' }], { onConflict: 'ticker' })
      .select('ticker,daytrade_score,status');
    assert.equal(up.error, null);
    assert.equal(up.data[0].daytrade_score, 91);

    const sorted = await hybrid.from('daytrade_screener_latest')
      .select('ticker,daytrade_score')
      .order('daytrade_score', { ascending: false });
    assert.deepEqual(sorted.data.map((r) => r.ticker), ['BBCA', 'BBRI']);

    const tg = await hybrid.from('telegram_daily_picks')
      .select('id,ticker,monitor_source')
      .eq('date', '2026-09-30')
      .or('monitor_source.in.(daily_top5,top5),monitor_source.is.null')
      .order('id', { ascending: true });
    assert.deepEqual(tg.data.map((r) => r.ticker), ['BBCA', 'BBRI']);

    const updated = await hybrid.from('daytrade_screener_latest')
      .update({ status: 'PAUSED' })
      .eq('ticker', 'BBRI')
      .select('ticker,status');
    assert.equal(updated.data[0].status, 'PAUSED');

    const removed = await hybrid.from('daytrade_screener_latest')
      .delete()
      .eq('ticker', 'BBRI')
      .select('ticker');
    assert.deepEqual(removed.data.map((r) => r.ticker), ['BBRI']);

    const left = await hybrid.from('daytrade_screener_latest').select('ticker');
    assert.deepEqual(left.data.map((r) => r.ticker), ['BBCA']);
    assert.equal(delegated, 0);

    const control = hybrid.from('app_users');
    assert.equal(control.table, 'app_users');
    assert.equal(delegated, 1);
  } finally {
    if (previousBackend === undefined) delete process.env.AUTO_CUAN_MARKET_DATA_BACKEND;
    else process.env.AUTO_CUAN_MARKET_DATA_BACKEND = previousBackend;
    if (previousRoot === undefined) delete process.env.AUTO_CUAN_DATA_ROOT;
    else process.env.AUTO_CUAN_DATA_ROOT = previousRoot;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('migration seeds active local table files only for approved cutover tables', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'migrate-market-data-to-vps.js'), 'utf8');
  assert.match(src, /localTables\.writeTableRows\(table, result\.rows, 'supabase_cutover_snapshot'\)/);
  const tableSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'vps-local-table-query.js'), 'utf8');
  assert.match(tableSrc, /'daytrade_screener_latest'/);
  assert.match(tableSrc, /'telegram_daily_picks'/);
  assert.match(tableSrc, /'sector_hot_latest'/);
  assert.doesNotMatch(tableSrc, /LOCAL_TABLES[\s\S]*'app_users'/);
});
