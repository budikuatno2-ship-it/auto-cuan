'use strict';

/**
 * Kloter 3 (v6.5.5-final-release) regression contracts:
 *   1. Zombie lock & dead-PID reaper + SIGTERM/SIGINT trap + concurrent market-context collector
 *   2. yahoo-ohlcv PARTIAL_OK (>=75% coverage + IHSG OK) & fail-closed (<75% or IHSG/SQLite fail)
 *   3. SQLite-first 0-API-call Arjum hydration (space/pipe row keys + Foreign provenance guard)
 *   4. End-of-pipeline auto-sync chaining & mtimeMs cache invalidation + quota-burn --dry-run safety
 *   5. Supporter expiry 2026-12-18 & Watchdog midnight rollover / unstable_restarts checks
 *   6. Track Record single-table deduplication & Three-Horizon backtest category filtering
 *   7. Kelola Keuangan non-404 production routing & topbar CSS padding
 *   8. Portfolio SQLite canonical EOD priority & checkAccess auto price sync
 *   9. Struktur Pasar high-contrast #msDetailNote, web-top5-history & admin-users list TTL caches
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const adapters = require('../lib/v6-production-job-adapters.cjs');
const fetchCandles = require('../tools/fetch-daily-candles.js');
const historyCollector = require('../lib/daily-history-collector.js');
const sqliteHydrate = require('../lib/arjum-sqlite-hydrate.js');
const mtimeGuard = require('../lib/snapshot-mtime-guard.js');
const watchdog = require('../scripts/watchdog.js');
const adminConsoleSvc = require('../lib/admin-console-service.js');
const backtest = require('../public/track-record-backtest.js');

test('K3-1: Zombie lock reaper marks stale >10m or dead-PID RUNNING jobs as TIMED_OUT/FAILED and keeps live PID', () => {
  const nowMs = Date.UTC(2026, 10, 26, 1, 0, 0);
  const state = {
    jobs: {
      staleOld: {
        status: 'RUNNING',
        startedAt: new Date(nowMs - adapters.STALE_RUNNING_MAX_MS - 30_000).toISOString(),
        pid: process.pid
      },
      deadPidRecent: {
        status: 'RUNNING',
        startedAt: new Date(nowMs - 60_000).toISOString(),
        pid: 999999999
      },
      healthyLive: {
        status: 'RUNNING',
        startedAt: new Date(nowMs - 30_000).toISOString(),
        pid: process.pid
      }
    }
  };

  assert.equal(adapters.isPidAlive(process.pid), true);
  assert.equal(adapters.isPidAlive(999999999), false);

  const reaped = adapters.reapStaleRunningJobs(state, { nowMs });
  assert.equal(reaped.length, 2);
  assert.equal(state.jobs.staleOld.status, 'TIMED_OUT');
  assert.equal(state.jobs.deadPidRecent.status, 'FAILED');
  assert.equal(state.jobs.healthyLive.status, 'RUNNING');

  const src = read('lib/v6-production-job-adapters.cjs');
  assert.match(src, /process\.on\('SIGTERM'/);
  assert.match(src, /process\.on\('SIGINT'/);
  assert.match(src, /process\.removeListener\('SIGTERM'/);
});

test('K3-1b: collectDailyHistoryForTickers bounds concurrency cleanly', async () => {
  const sampleBars = Array.from({ length: 25 }, (_, idx) => ({
    date: new Date(Date.UTC(2026, 9, 1 + idx)).toISOString().slice(0, 10),
    open: 100 + idx,
    high: 105 + idx,
    low: 99 + idx,
    close: 104 + idx,
    volume: 1000000 + idx * 10000
  }));
  const res = await historyCollector.collectDailyHistoryForTickers(null, ['BBCA', 'BBRI'], {
    concurrency: 99,
    fetchFn: async () => sampleBars
  });
  assert.equal(res.failed.length, 0);
  assert.equal(res.tickers_collected, 2);
});

test('K3-2: yahoo-ohlcv classifyFetchOutcome returns PARTIAL_OK when >=75% + IHSG + SQLite OK and fails closed <75%', () => {
  const partialOk = fetchCandles.classifyFetchOutcome({
    universe: 960,
    fetched: 800,
    cached: 76,
    failed: 84,
    stale_after_fetch: 0,
    ihsg_ok: true,
    sqlite_sync_failed: false,
    cross_check_failed: false
  });
  assert.equal(partialOk.status, 'PARTIAL_OK');
  assert.equal(partialOk.ok, true);
  assert.equal(partialOk.partial_ok, true);
  assert.ok(partialOk.coverage_ratio >= 0.75);

  const tooLow = fetchCandles.classifyFetchOutcome({
    universe: 960,
    fetched: 500,
    cached: 0,
    failed: 460,
    stale_after_fetch: 460,
    ihsg_ok: true,
    sqlite_sync_failed: false,
    cross_check_failed: false
  });
  assert.equal(tooLow.status, 'FAILED');
  assert.equal(tooLow.ok, false);

  const ihsgBroken = fetchCandles.classifyFetchOutcome({
    universe: 960,
    fetched: 900,
    cached: 60,
    failed: 0,
    stale_after_fetch: 0,
    ihsg_ok: false,
    sqlite_sync_failed: false,
    cross_check_failed: false
  });
  assert.equal(ihsgBroken.status, 'FAILED');
  assert.equal(ihsgBroken.ok, false);
});

test('K3-3: SQLite-first 0-API-call hydration reads space and pipe keys and rejects synthetic Foreign payloads', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-k3-sqlite-'));
  const dbPath = path.join(tmpDir, 'market.sqlite');
  const arjumDir = path.join(tmpDir, 'arjum-data');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE market_rows (table_name TEXT NOT NULL, row_key TEXT NOT NULL, updated_at TEXT, row_json TEXT NOT NULL, PRIMARY KEY (table_name, row_key));');
    const ins = db.prepare('INSERT INTO market_rows (table_name, row_key, updated_at, row_json) VALUES (?, ?, ?, ?)');

    ins.run(
      sqliteHydrate.FLOW_TO_TABLE.ALL,
      'ZYRX 2026-11-25',
      '2026-11-25T20:42:00+07:00',
      JSON.stringify({
        ticker: 'ZYRX',
        date: '2026-11-25',
        brokers: [{ broker: 'YP', bval: 500000000, sval: 100000000, bvol: 50000, svol: 10000 }]
      })
    );

    ins.run(
      sqliteHydrate.FLOW_TO_TABLE.F,
      'BBCA|2026-11-25',
      '2026-11-25T20:47:00+07:00',
      JSON.stringify({
        ticker: 'BBCA',
        date: '2026-11-25',
        flow: 'F',
        brokers: [{ broker: 'AK', bval: 900000000, sval: 200000000, bvol: 9000, svol: 2000 }]
      })
    );

    ins.run(
      sqliteHydrate.FLOW_TO_TABLE.F,
      'FAKE 2026-11-25',
      '2026-11-25T20:48:00+07:00',
      JSON.stringify({
        ticker: 'FAKE',
        date: '2026-11-25',
        flow: 'F',
        provenance: 'DERIVED_LOCAL',
        computed_from: 'broker_code_heuristic_from_all',
        brokers: [{ broker: 'BK', bval: 1000, sval: 0, bvol: 10, svol: 0 }]
      })
    );
  } finally {
    db.close();
  }

  try {
    const zyrxAll = sqliteHydrate.hydrateFromSqliteIfPresent({
      ticker: 'ZYRX',
      date: '2026-11-25',
      flow: 'all',
      dbPath,
      baseDir: arjumDir,
      hydrateToDisk: true
    });
    assert.ok(zyrxAll);
    assert.equal(fs.existsSync(path.join(arjumDir, 'broker-summary', 'ZYRX', '2026-11-25.json')), true);

    const bbcaF = sqliteHydrate.hydrateFromSqliteIfPresent({
      ticker: 'BBCA',
      date: '2026-11-25',
      flow: 'F',
      dbPath,
      baseDir: arjumDir,
      hydrateToDisk: true
    });
    assert.ok(bbcaF);
    assert.equal(fs.existsSync(path.join(arjumDir, 'broker-summary-F', 'BBCA', '2026-11-25.json')), true);

    const fakeRejected = sqliteHydrate.hydrateFromSqliteIfPresent({
      ticker: 'FAKE',
      date: '2026-11-25',
      flow: 'F',
      dbPath,
      baseDir: arjumDir,
      hydrateToDisk: true
    });
    assert.equal(fakeRejected, null);
    assert.equal(fs.existsSync(path.join(arjumDir, 'broker-summary-F', 'FAKE', '2026-11-25.json')), false);

    const rowsMap = sqliteHydrate.listRowsForDateFromSqlite(sqliteHydrate.FLOW_TO_TABLE.ALL, '2026-11-25', { dbPath });
    assert.equal(rowsMap.has('ZYRX'), true);
    const tickerDates = sqliteHydrate.readAllDateRowsForTickerFromSqlite(sqliteHydrate.FLOW_TO_TABLE.F, 'BBCA', { dbPath });
    assert.equal(tickerDates.length, 1);
    assert.equal(tickerDates[0].date, '2026-11-25');
  } finally {
    sqliteHydrate.closeReadonlyDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('K3-4: Auto-sync chains prewarm/landing, runtime APIs use mtimeMs guard, and quota-burn --dry-run exits 0 cleanly', () => {
  const sigA = mtimeGuard.getSnapshotVersionSig(true);
  assert.equal(typeof sigA, 'string');
  assert.ok(sigA.includes('|'));

  for (const apiFile of [
    'api/screener.js',
    'api/top5-radar.js',
    'api/track-record.js',
    'api/landing-snapshot.js',
    'api/ranking.js',
    'api/sektor.js',
    'api/intel.js',
    'api/sector-hot.js'
  ]) {
    assert.match(read(apiFile), /snapshot-mtime-guard/, `${apiFile} must use shared snapshot-mtime-guard`);
  }

  const adapterSrc = read('lib/v6-production-job-adapters.cjs');
  assert.match(adapterSrc, /'sector-hot':[\s\S]*prewarm-daily-cache\.js/);
  assert.match(adapterSrc, /'top20':[\s\S]*prewarm-daily-cache\.js[\s\S]*direct-refresh-landing\.js/);
  const kseiSrc = read('api/admin/struktur-pasar/upload.js');
  assert.match(kseiSrc, /regenerate-local-snapshots\.js[\s\S]*prewarm-daily-cache\.js/);

  const dry = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'quota-burn.js'), '--dry-run'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: path.join(ROOT, 'node_modules') }
  });
  assert.equal(dry.status, 0, 'quota-burn --dry-run must exit 0');
  assert.doesNotMatch(dry.stdout, /FATAL:/);
});

test('K3-5: Supporter plan expiry is 2026-12-18 and Watchdog avoids false midnight quota & deploy restart alarms', () => {
  const cfg = JSON.parse(read('config/quota.json'));
  assert.match(String(cfg.planExpiresAt), /^2026-12-18/);
  const fc = adminConsoleSvc.getBackfillForecast(ROOT);
  assert.match(String(fc.planExpiresAt), /^2026-12-18/);

  const quotaMidnight = watchdog.classifyQuota({
    usageKnown: false,
    used: null,
    limit: null,
    remaining: null,
    reason: 'midnight_rollover'
  });
  assert.equal(quotaMidnight, null, 'midnight usageKnown=false must not emit false sisa 0 critical alert');

  const steadyPm2 = watchdog.classifyPm2Proc({
    name: 'autocuan-web',
    pm2_env: { status: 'online', restart_time: 50, unstable_restarts: 0 }
  });
  assert.equal(steadyPm2, null);

  const crashLoopPm2 = watchdog.classifyPm2Proc({
    name: 'autocuan-web',
    pm2_env: { status: 'online', restart_time: 50, unstable_restarts: 12 }
  });
  assert.ok(crashLoopPm2);
  assert.equal(crashLoopPm2.key, 'pm2:autocuan-web:restart-loop');
  assert.equal(crashLoopPm2.severity, 'critical');
});

test('K3-6: Track Record has single Three-Horizon table without duplicate Rekap panel and supports Three-Horizon backtest aliases', () => {
  const html = read('public/index.html');
  const trSection = html.split('id="page-trackrecord"')[1]?.split('<!-- ===== PAGE: WATCHLIST PRIBADI ===== -->')[0] || '';
  assert.ok(trSection.length > 0);
  assert.equal(trSection.includes('id="trTableViewPanel"'), false);
  assert.equal(trSection.includes('id="trTableBody"'), false);
  assert.equal(trSection.includes('Swing Konglo'), false);
  assert.equal(trSection.includes('Swing Non-Konglo'), false);
  assert.match(trSection, /<option value="potensi_besok">/);
  assert.match(trSection, /<option value="short_swing">/);
  assert.match(trSection, /<option value="swing">/);

  const sim = backtest.runBacktestSimulation([
    { ticker: 'PB1', date: '2026-11-10', source: 'daytrade', entry1: 1000, entry2: 1000, tp1: 1100, sl: 950, outcome: 'TP1_HIT' },
    { ticker: 'SS1', date: '2026-11-11', source: 'swing_konglo', entry1: 1000, entry2: 1000, tp1: 1120, sl: 950, outcome: 'TP1_HIT' },
    { ticker: 'SW1', date: '2026-11-12', source: 'swing_nk', entry1: 1000, entry2: 1000, tp1: 1200, sl: 920, outcome: 'TP1_HIT' }
  ], { category: 'potensi_besok' });
  assert.equal(sim.metrics.totalTrades, 1);
  assert.equal(sim.trades[0].ticker, 'PB1');

  const trRuntime = read('public/track-record-runtime.js');
  assert.match(trRuntime, /getElementById\('trTableBody'\)\s*\|\|\s*document\.getElementById\('trCanvasTableBody'\)/);
});

test('K3-7/8/9: Kelola Keuangan prod route & CSS, Portfolio SQLite close/auto-sync, #msDetailNote contrast, and TTL caches', () => {
  const devSrvSrc = read('tools/local-dev-server.js');
  assert.match(devSrvSrc, /if\s*\(endpointName === 'money-management'\)\s*\{[\s\S]*require\(['"]\.\.\/lib\/money-management-handler['"]\)/);

  const msCss = read('public/money-sheet.css');
  assert.match(msCss, /\.ms-month\s+input\[type="month"\]/);
  const acCss = read('public/ac-v2.css');
  assert.match(acCss, /#page-portofolio[\s\S]*#page-money-management[\s\S]*padding:\s*28px\s+32px\s+48px\s+!important/);

  const quoteSrc = read('api/quote.js');
  assert.match(quoteSrc, /stock_daily_history/);
  assert.match(quoteSrc, /portfolio=1|isPortfolioReq|portfolio/);
  const portJs = read('public/portfolio-command-center.js');
  assert.match(portJs, /refreshAllPrices\(false,\s*\{\s*silent:\s*true\s*\}\)/);

  const partialHtml = read('public/partials/analisis-saham.partial.html');
  assert.match(partialHtml, /id="msDetailNote"[^>]*rgba\(217,119,6,0\.12\)[^>]*color:var\(--ac-ink\)/);

  const shSrc = read('api/sector-hot.js');
  assert.match(shSrc, /WEB_TOP5_HISTORY_CACHE_TTL_MS/);
  assert.match(shSrc, /lookupDashboardAdminAppUserCached/);

  const admUsersSrc = read('lib/admin-users-handler.js');
  assert.match(admUsersSrc, /setCachedAdminUsersList/);
  assert.match(admUsersSrc, /invalidateAdminUsersListCache/);
});

test('K3-LOCAL-PROD-SERVER: production local-dev-server routes /api/money-management past preview mocks (no 404)', async () => {
  const src = read('tools/local-dev-server.js');
  // Spawn a minimal check by confirming ordering: preview guard runs ONLY when PREVIEW_MOCKS_ENABLED && isPreview,
  // and production falls through directly to lib/money-management-handler rather than returning 404.
  const previewIdx = src.indexOf("if (PREVIEW_MOCKS_ENABLED && endpointName === 'money-management' && isPreview)");
  const prodIdx = src.indexOf("if (endpointName === 'money-management')");
  assert.ok(previewIdx > 0 && prodIdx > previewIdx);
});

test('K3-MARKET-CONTEXT-PERF: VpsMarketStore indexes, fast-path retention/history without row.id, and exact count options', async () => {
  const { VpsMarketStore, closeVpsMarketStore } = require('../lib/vps-market-store');
  const { hybridizeClient } = require('../lib/hybrid-supabase-client');
  const historyStore = require('../lib/stock-daily-history-store');
  const { makeFakeSupabase } = require('./helpers/fake-supabase');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k3-mkt-perf-'));
  const dbPath = path.join(tmpDir, 'market.sqlite');
  let store = null;
  try {
    store = new VpsMarketStore(dbPath);
    const indexes = store.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
    assert.ok(indexes.includes('idx_market_rows_table_ticker_date'));
    assert.ok(indexes.includes('idx_market_rows_table_date'));

    const rows = [];
    for (let i = 1; i <= 12; i++) {
      rows.push({
        ticker: 'BBCA',
        trade_date: '2026-11-' + String(i).padStart(2, '0'),
        open: 9000, high: 9100, low: 8900, close: 9050, volume: 100000
      });
    }
    await historyStore.upsertDailyHistory(store, rows);

    // 1. Generic Supabase/VpsMarketStore fallback path (no fast method exposed, rows lack `.id`)
    const storeFallbackOnly = { from: (table) => store.from(table) };
    const deletedFallback = await historyStore.enforceRetention(storeFallbackOnly, ['bbca'], 8);
    assert.equal(deletedFallback, 4);

    // 2. Hybrid VpsMarketStore fast path
    const hybrid = hybridizeClient({}, { AUTO_CUAN_MARKET_DATA_VPS: '1', AUTO_CUAN_MARKET_DB: dbPath });
    const deletedFast = await historyStore.enforceRetention(hybrid, ['bbca'], 5);
    assert.equal(deletedFast, 3);

    const latestMap = await historyStore.getLatestSessionsForTickers(hybrid, ['BBCA'], 10);
    const remaining = latestMap.get('BBCA') || [];
    assert.equal(remaining.length, 5);
    assert.deepEqual(
      remaining.map((r) => r.trade_date),
      ['2026-11-12', '2026-11-11', '2026-11-10', '2026-11-09', '2026-11-08']
    );

    const exactCount = await store.from('stock_daily_history').select('ticker', { count: 'exact', head: true }).eq('ticker', 'BBCA');
    assert.equal(exactCount.count, 5);
    const plainSelect = await store.from('stock_daily_history').select('ticker,trade_date').eq('ticker', 'BBCA');
    assert.equal(plainSelect.count, null);
    assert.equal(plainSelect.data.length, 5);

    // Keep makeFakeSupabase baseline sanity intact
    const fakeWithId = makeFakeSupabase({ stock_daily_history: rows });
    assert.equal(await historyStore.enforceRetention(fakeWithId, ['BBCA'], 6), 6);
  } finally {
    if (store) store.close();
    closeVpsMarketStore();
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }); } catch (_) {}
  }
});
