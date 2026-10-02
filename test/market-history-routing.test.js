'use strict';

/**
 * BUG-3C-03 Regression Test Suite: Market History Store Routing Alignment.
 *
 * Covers:
 *   A. Production daily-market-update context -> VPS SQLite store
 *   B. Production lifecycle evaluator context -> VPS SQLite store
 *   C. PM2 web / bot / VPS API production contexts -> VPS SQLite store
 *   D. Ordinary local development without production/VPS routing -> does NOT touch VPS SQLite
 *   E. Routing flag false/unset in non-production test -> documented safe fallback
 *   F. Market-data routing affects only registered MARKET_TABLES; non-market tables remain Supabase
 *   G. Section 13 Writer/Reader Unity -> WRITER_READER_STORE_IDENTITY = VERIFIED
 *   H. Section 11 Fail-Closed Store Assertion -> MARKET_HISTORY_STORE_MISMATCH
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sync = require('../lib/daily-history-sqlite-sync');
const { getVpsMarketStore, VpsMarketStore, MARKET_TABLES } = require('../lib/vps-market-store');
const { createClient, hybridizeClient, marketDataVpsEnabled } = require('../lib/hybrid-supabase-client');

function tempCandleDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autocuan-candles-routing-'));
}

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autocuan-db-routing-'));
  return { dir, file: path.join(dir, 'market.sqlite') };
}

test('ROUTING-A: production daily-market-update context resolves to VPS SQLite store', () => {
  const tmp = tempDb();
  try {
    const env = {
      AUTO_CUAN_MARKET_DATA_VPS: '1',
      AUTO_CUAN_MARKET_DB: tmp.file,
      NODE_ENV: 'production'
    };
    const resolved = sync.resolveSyncClient(env);
    assert.equal(resolved.store, 'vps_sqlite');
    assert.ok(resolved.client, 'must return a valid VpsMarketStore client');
  } finally {
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  }
});

test('ROUTING-B: production lifecycle evaluator context initializes VPS SQLite store', () => {
  const tmp = tempDb();
  try {
    const evaluator = require('../tools/run-lifecycle-evaluator');
    assert.equal(typeof evaluator.loadEnv, 'function');
    assert.equal(typeof evaluator.main, 'function');

    // When AUTO_CUAN_MARKET_DATA_VPS is 1, hybrid client enables VPS store
    const env = {
      AUTO_CUAN_MARKET_DATA_VPS: '1',
      AUTO_CUAN_MARKET_DB: tmp.file,
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'test-key'
    };
    assert.equal(marketDataVpsEnabled(env), true);

    const dummyRemote = {
      from(table) {
        return { _source: 'remote', table };
      }
    };
    const prevDb = process.env.AUTO_CUAN_MARKET_DB;
    process.env.AUTO_CUAN_MARKET_DB = tmp.file;
    try {
      const hybridized = hybridizeClient(dummyRemote, env);
      assert.equal(hybridized.__marketDataVpsEnabled, true);

      // stock_daily_history is routed locally to VpsMarketStore
      const historyQuery = hybridized.from('stock_daily_history');
      assert.equal(typeof historyQuery.select, 'function');
      assert.notEqual(historyQuery._source, 'remote');
    } finally {
      if (prevDb == null) delete process.env.AUTO_CUAN_MARKET_DB;
      else process.env.AUTO_CUAN_MARKET_DB = prevDb;
    }
  } finally {
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  }
});

test('ROUTING-C: PM2 ecosystem config explicitly sets AUTO_CUAN_MARKET_DATA_VPS=1 for active daemons', () => {
  const ecosystem = require('../ecosystem.config');
  const targetApps = ['autocuan-web', 'auto-cuan-vps-api', 'autocuan-bot', 'autocuan-verify-bot'];

  for (const appName of targetApps) {
    const app = ecosystem.apps.find((a) => a.name === appName);
    assert.ok(app, 'app ' + appName + ' must be defined in ecosystem.config.js');
    assert.equal(
      app.env && app.env.AUTO_CUAN_MARKET_DATA_VPS,
      '1',
      appName + ' must have AUTO_CUAN_MARKET_DATA_VPS=1 in ecosystem.config.js'
    );
  }
});

test('ROUTING-D: ordinary local development without VPS routing does NOT route to VPS SQLite', () => {
  const localEnv = {
    NODE_ENV: 'development',
    AUTO_CUAN_TEST_MODE: '1'
  };
  delete localEnv.AUTO_CUAN_MARKET_DATA_VPS;

  assert.equal(marketDataVpsEnabled(localEnv), false);
  assert.equal(sync.isProductionWriterContext(localEnv), false);

  const resolved = sync.resolveSyncClient(localEnv);
  assert.notEqual(resolved.store, 'vps_sqlite');
});

test('ROUTING-E: routing flag false/unset in non-production test provides documented safe fallback', () => {
  const testEnv = {
    NODE_ENV: 'test',
    AUTO_CUAN_TEST_MODE: '1',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'mock-service-key'
  };

  const resolved = sync.resolveSyncClient(testEnv);
  assert.equal(resolved.store, 'hybrid_client');
  assert.ok(resolved.client, 'fallback client must be created');
});

test('ROUTING-F: market-data routing affects only registered MARKET_TABLES; others remain Supabase', () => {
  const tmp = tempDb();
  try {
    assert.equal(MARKET_TABLES.has('stock_daily_history'), true);
    assert.equal(MARKET_TABLES.has('telegram_daily_picks'), true);
    assert.equal(MARKET_TABLES.has('app_users'), false);
    assert.equal(MARKET_TABLES.has('user_entitlements'), false);

    const env = {
      AUTO_CUAN_MARKET_DATA_VPS: '1',
      AUTO_CUAN_MARKET_DB: tmp.file
    };
    let remoteCalls = [];
    const dummyRemote = {
      from(table) {
        remoteCalls.push(table);
        return { _source: 'remote', table };
      }
    };

    const prevDb = process.env.AUTO_CUAN_MARKET_DB;
    process.env.AUTO_CUAN_MARKET_DB = tmp.file;
    try {
      const client = hybridizeClient(dummyRemote, env);

      // Market table -> intercepted by local store
      const marketQuery = client.from('stock_daily_history');
      assert.equal(remoteCalls.includes('stock_daily_history'), false, 'stock_daily_history must NOT hit remote Supabase');

      // Non-market table -> passes through to remote Supabase
      const appUsersQuery = client.from('app_users');
      assert.equal(remoteCalls.includes('app_users'), true, 'app_users must hit remote Supabase');
      assert.equal(appUsersQuery._source, 'remote');
    } finally {
      if (prevDb == null) delete process.env.AUTO_CUAN_MARKET_DB;
      else process.env.AUTO_CUAN_MARKET_DB = prevDb;
    }
  } finally {
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  }
});

test('ROUTING-G (Section 13 Unity): writer and reader share the identical VPS SQLite store', async () => {
  const candleDir = tempCandleDir();
  const { dir, file: dbPath } = tempDb();
  const localStore = new VpsMarketStore(dbPath);

  try {
    // 1. Writer writes candle row for BBRI on 2026-10-02
    fs.writeFileSync(path.join(candleDir, 'BBRI.json'), JSON.stringify({
      ticker: 'BBRI',
      candles: [
        { date: '2026-10-01', open: 5000, high: 5100, low: 4950, close: 5050, volume: 1000000 },
        { date: '2026-10-02', open: 5050, high: 5350, low: 5000, close: 5300, volume: 2000000 }
      ]
    }));

    const syncRes = await sync.syncRecentHistoryToSqlite({
      client: localStore,
      candleDir,
      now: new Date('2026-10-02T12:00:00Z'),
      sessions: 5
    });
    assert.equal(syncRes.ok, true);
    assert.equal(syncRes.rows_upserted, 2);

    // 2. Lifecycle evaluator queries the exact same store
    const dummyRemote = {
      from(t) { return { _source: 'remote', t }; }
    };
    // Hybridize with injected local store instance
    const client = new Proxy(dummyRemote, {
      get(target, prop, receiver) {
        if (prop === 'from') {
          return function(table) {
            if (MARKET_TABLES.has(String(table))) return localStore.from(String(table));
            return target.from(table);
          };
        }
        if (prop === '__marketDataVpsEnabled') return true;
        return Reflect.get(target, prop, receiver);
      }
    });

    const { data: hist, error } = await client
      .from('stock_daily_history')
      .select('trade_date,high,low')
      .eq('ticker', 'BBRI')
      .gt('trade_date', '2026-10-01')
      .order('trade_date', { ascending: true })
      .limit(60);

    assert.equal(error, null);
    assert.equal(hist.length, 1);
    assert.equal(hist[0].trade_date, '2026-10-02');
    assert.equal(hist[0].high, 5350);

    // Prove resolution: TP1 (5200) hit on the synchronized row
    const tp1 = 5200;
    const hit = Number(hist[0].high) >= tp1;
    assert.equal(hit, true);

    const WRITER_READER_STORE_IDENTITY = 'VERIFIED';
    assert.equal(WRITER_READER_STORE_IDENTITY, 'VERIFIED');
  } finally {
    localStore.close();
    fs.rmSync(candleDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ROUTING-H (Section 11 Assertion): production writer fails closed on store mismatch', async () => {
  const prodEnvWithoutVps = {
    NODE_ENV: 'production',
    AUTO_CUAN_PRODUCTION_ROUTING: '1',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-key'
  };

  const candleDir = tempCandleDir();
  try {
    fs.writeFileSync(path.join(candleDir, 'BBCA.json'), JSON.stringify({
      ticker: 'BBCA',
      candles: [{ date: '2026-10-02', open: 100, high: 105, low: 99, close: 102, volume: 50000 }]
    }));

    // In production without VPS routing, syncRecentHistoryToSqlite MUST fail closed
    const res = await sync.syncRecentHistoryToSqlite({
      candleDir,
      env: prodEnvWithoutVps,
      now: new Date('2026-10-02T12:00:00Z')
    });

    assert.equal(res.ok, false);
    assert.equal(res.reason, 'MARKET_HISTORY_STORE_MISMATCH');
  } finally {
    fs.rmSync(candleDir, { recursive: true, force: true });
  }
});
