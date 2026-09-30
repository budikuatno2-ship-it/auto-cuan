'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const storeModule = require('../lib/vps-market-store');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autocuan-market-'));
  return { dir, file: path.join(dir, 'market.sqlite') };
}

test('VPS market store upserts, filters, orders and counts rows', async () => {
  const tmp = tempDb();
  const store = new storeModule.VpsMarketStore(tmp.file);
  try {
    let res = await store.from('foreign_watchlist_daily').upsert([
      { trade_date: '2026-09-29', ticker: 'BBCA', foreign_net: 10 },
      { trade_date: '2026-09-30', ticker: 'BBCA', foreign_net: 20 },
      { trade_date: '2026-09-30', ticker: 'BBRI', foreign_net: -5 }
    ], { onConflict: 'trade_date,ticker' });
    assert.equal(res.error, null);
    assert.equal(store.count('foreign_watchlist_daily'), 3);

    res = await store.from('foreign_watchlist_daily')
      .select('ticker,trade_date,foreign_net')
      .eq('ticker', 'BBCA')
      .order('trade_date', { ascending: false })
      .limit(1);
    assert.equal(res.error, null);
    assert.deepEqual(res.data, [{ ticker: 'BBCA', trade_date: '2026-09-30', foreign_net: 20 }]);

    const count = await store.from('foreign_watchlist_daily')
      .select('*', { count: 'exact', head: true })
      .eq('trade_date', '2026-09-30');
    assert.equal(count.count, 2);
  } finally {
    store.close();
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  }
});

test('VPS market store preserves control-plane separation', () => {
  assert.equal(storeModule.MARKET_TABLES.has('stock_daily_history'), true);
  assert.equal(storeModule.MARKET_TABLES.has('telegram_daily_picks'), true);
  assert.equal(storeModule.MARKET_TABLES.has('app_users'), false);
  assert.equal(storeModule.MARKET_TABLES.has('user_entitlements'), false);
  assert.equal(storeModule.MARKET_TABLES.has('subscription_vouchers'), false);
});

test('migration tool includes the heavy Supabase tables', () => {
  const migration = require('../tools/migrate-market-data-to-vps');
  for (const name of [
    'stock_daily_history',
    'foreign_watchlist_daily',
    'telegram_daily_picks',
    'swing_screener_non_konglo_staging',
    'swing_screener_non_konglo_jobs',
    'daytrade_screener_latest',
    'sector_hot_latest'
  ]) assert.equal(migration.DEFAULT_TABLES.includes(name), true, name);
});

test('hybrid client source routes only registered market tables locally', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/hybrid-supabase-client.js'), 'utf8');
  assert.match(source, /AUTO_CUAN_MARKET_DATA_VPS/);
  assert.match(source, /MARKET_TABLES\.has/);
  assert.match(source, /return target\.from\(table\)/);
});
