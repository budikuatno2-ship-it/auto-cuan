'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const cache = require('../lib/daytrade-ohlcv-cache');
const worker = require('../tools/daytrade-vps-worker-observe');

// ============================================================
// HELPERS
// ============================================================

function makeCandle(day, close) {
  return {
    time: Math.floor(Date.parse(day + 'T00:00:00Z') / 1000),
    date: day,
    open: close - 1,
    high: close + 2,
    low: close - 2,
    close: close,
    volume: 1000000
  };
}

function make90DCandles(baseClose) {
  const candles = [];
  const startDate = new Date('2026-04-01');
  for (let i = 0; i < 90; i++) {
    const d = new Date(startDate.getTime() + i * 86400000);
    const dateStr = d.toISOString().slice(0, 10);
    candles.push(makeCandle(dateStr, baseClose + i));
  }
  return candles;
}

// The cache TTL is market-aware: the configured TTL during IDX hours
// (Mon-Fri 09:00-15:30 WIB) and 12 hours outside them, because the exchange is
// shut and the candles cannot change. A test about STALE handling therefore has
// to say WHEN it is running, otherwise "20 minutes old" means stale in the
// morning and fresh at night. These two tests used the real wall clock and were
// clock-dependent; they only ever passed at any hour because the market-aware
// branch was unreachable (see lib/daytrade-ohlcv-cache.js fetchWithCache).
// Pinning the clock to a trading-hours instant preserves their intent exactly
// and removes the latent flake.
// 2026-09-03 is a Thursday; 11:00 WIB is inside 09:00-15:30.
const MARKET_HOURS_NOW = Date.parse('2026-09-03T04:00:00Z'); // 11:00 WIB

function freezeClockDuringMarketHours(t) {
  const realNow = Date.now;
  Date.now = () => MARKET_HOURS_NOW;
  t.after(() => { Date.now = realNow; });
}

async function tmpdir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ohlcv-cache-test-'));
}

// ============================================================
// TEST: Fresh cache used without Yahoo fetch
// ============================================================

test('fresh cache is used without calling Yahoo fetch', async () => {
  const dir = await tmpdir();
  const candles = make90DCandles(100);

  // Pre-seed cache with fresh data (just written = fresh)
  await cache.writeCache(dir, 'BBCA', candles, 'unit-test');

  // Track whether fetchFn was called
  let fetchCalled = false;
  const provider = cache.createCacheProvider({
    cacheDir: dir,
    ttlMs: 15 * 60 * 1000, // 15 min
    fetchFn: async () => {
      fetchCalled = true;
      return make90DCandles(200);
    }
  });

  const result = await provider.fetchWithCache('BBCA');

  assert.equal(fetchCalled, false, 'Yahoo fetch should NOT be called when cache is fresh');
  assert.ok(result, 'Should return candles');
  assert.equal(result.length, 90, 'Should return 90 candles');
  assert.equal(result[0].close, 100, 'Should return cached data (close=100), not fetched data');

  const stats = provider.getStats();
  assert.equal(stats.cacheHit, 1, 'cacheHit should be 1');
  assert.equal(stats.fetchSuccess, 0, 'fetchSuccess should be 0');
  assert.equal(stats.fetchFail, 0, 'fetchFail should be 0');
});

// ============================================================
// TEST: Stale cache triggers Yahoo refresh
// ============================================================

test('stale cache triggers Yahoo refresh and updates cache', async (t) => {
  freezeClockDuringMarketHours(t);
  const dir = await tmpdir();
  const oldCandles = make90DCandles(100);

  // Write cache with a backdated timestamp to make it stale
  await cache.writeCache(dir, 'TLKM', oldCandles, 'unit-test');
  // Manually backdate the updated_at to make it stale (> 15 min old)
  const filePath = path.join(dir, 'TLKM.json');
  const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
  raw.updated_at = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20 min ago
  await fs.writeFile(filePath, JSON.stringify(raw, null, 2) + '\n');

  let fetchCalled = false;
  const freshCandles = make90DCandles(500);
  const provider = cache.createCacheProvider({
    cacheDir: dir,
    ttlMs: 15 * 60 * 1000,
    fetchFn: async () => {
      fetchCalled = true;
      return freshCandles;
    }
  });

  const result = await provider.fetchWithCache('TLKM');

  assert.equal(fetchCalled, true, 'Yahoo fetch SHOULD be called when cache is stale');
  assert.ok(result, 'Should return candles');
  assert.equal(result.length, 90);
  assert.equal(result[0].close, 500, 'Should return freshly fetched data');

  const stats = provider.getStats();
  assert.equal(stats.fetchSuccess, 1, 'fetchSuccess should be 1');

  // Verify cache was updated on disk
  const updatedRaw = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.equal(updatedRaw.candles[0].close, 500, 'Cache file should contain updated data');
});

// ============================================================
// TEST: Yahoo failure falls back to stale cache
// ============================================================

test('Yahoo failure falls back to stale cache with staleFallback stat', async (t) => {
  freezeClockDuringMarketHours(t);
  const dir = await tmpdir();
  const oldCandles = make90DCandles(300);

  // Write cache then backdate to make it stale
  await cache.writeCache(dir, 'BMRI', oldCandles, 'unit-test');
  const filePath = path.join(dir, 'BMRI.json');
  const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
  raw.updated_at = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
  await fs.writeFile(filePath, JSON.stringify(raw, null, 2) + '\n');

  let fetchCalled = false;
  const provider = cache.createCacheProvider({
    cacheDir: dir,
    ttlMs: 15 * 60 * 1000,
    fetchFn: async () => {
      fetchCalled = true;
      throw new Error('Yahoo HTTP 429');
    }
  });

  const result = await provider.fetchWithCache('BMRI');

  assert.equal(fetchCalled, true, 'Yahoo fetch should be attempted');
  assert.ok(result, 'Should fallback to stale cache');
  assert.equal(result.length, 90);
  assert.equal(result[0].close, 300, 'Should return stale cached data');

  const stats = provider.getStats();
  assert.equal(stats.staleFallback, 1, 'staleFallback should be 1');
  assert.equal(stats.fetchSuccess, 0);
  assert.equal(stats.fetchFail, 0, 'fetchFail should be 0 since we fell back to cache');
});

// ============================================================
// TEST: Yahoo failure with NO cache returns null
// ============================================================

test('Yahoo failure with no cache returns null', async () => {
  const dir = await tmpdir();

  const provider = cache.createCacheProvider({
    cacheDir: dir,
    ttlMs: 15 * 60 * 1000,
    fetchFn: async () => {
      throw new Error('Network timeout');
    }
  });

  const result = await provider.fetchWithCache('NONEXIST');

  assert.equal(result, null, 'Should return null when Yahoo fails and no cache exists');

  const stats = provider.getStats();
  assert.equal(stats.fetchFail, 1);
  assert.equal(stats.cacheHit, 0);
  assert.equal(stats.staleFallback, 0);
});

// ============================================================
// TEST: VPS loop default interval is 15 minutes
// ============================================================

test('VPS loop default interval is 15 minutes (900000 ms)', () => {
  assert.equal(worker.DEFAULT_LOOP_INTERVAL_MS, 15 * 60 * 1000,
    'DEFAULT_LOOP_INTERVAL_MS should be 900000 (15 minutes)');
});

// ============================================================
// TEST: Cache TTL default is 15 minutes
// ============================================================

test('cache DEFAULT_TTL_MS is 15 minutes (900000 ms)', () => {
  assert.equal(cache.DEFAULT_TTL_MS, 15 * 60 * 1000,
    'DEFAULT_TTL_MS should be 900000 (15 minutes)');
});

// ============================================================
// TEST: getEffectiveTtl returns long TTL outside market hours
// ============================================================

test('getEffectiveTtl returns 12h TTL on weekends', () => {
  // Saturday 2026-07-11 10:00 WIB = 03:00 UTC
  const satMs = Date.parse('2026-07-11T03:00:00Z');
  const ttl = cache.getEffectiveTtl(900000, satMs);
  assert.equal(ttl, 12 * 60 * 60 * 1000, 'Weekend should use 12h TTL');
});

test('getEffectiveTtl returns configured TTL during market hours', () => {
  // Wednesday 2026-07-08 10:00 WIB = 03:00 UTC
  const wedMs = Date.parse('2026-07-08T03:00:00Z');
  const ttl = cache.getEffectiveTtl(900000, wedMs);
  assert.equal(ttl, 900000, 'Market hours should use configured 15min TTL');
});

test('getEffectiveTtl returns 12h TTL before market open', () => {
  // Wednesday 2026-07-08 07:00 WIB = 00:00 UTC (before 09:00 WIB open)
  const earlyMs = Date.parse('2026-07-08T00:00:00Z');
  const ttl = cache.getEffectiveTtl(900000, earlyMs);
  assert.equal(ttl, 12 * 60 * 60 * 1000, 'Before market open should use 12h TTL');
});

test('getEffectiveTtl returns 12h TTL after market close', () => {
  // Wednesday 2026-07-08 16:00 WIB = 09:00 UTC (after 15:30 WIB close)
  const afterMs = Date.parse('2026-07-08T09:00:00Z');
  const ttl = cache.getEffectiveTtl(900000, afterMs);
  assert.equal(ttl, 12 * 60 * 60 * 1000, 'After market close should use 12h TTL');
});

// ============================================================
// TEST: isCacheFresh uses market-aware TTL
// ============================================================

test('isCacheFresh returns true for recently updated cache during market hours', () => {
  // Now: Wednesday 10:00 WIB. Cache updated 5 min ago. TTL=15min. Should be fresh.
  const nowMs = Date.parse('2026-07-08T03:00:00Z');
  const updatedAtMs = nowMs - 5 * 60 * 1000;
  assert.equal(cache.isCacheFresh(updatedAtMs, nowMs, 900000), true);
});

test('isCacheFresh returns false for cache older than TTL during market hours', () => {
  // Now: Wednesday 10:00 WIB. Cache updated 20 min ago. TTL=15min. Should be stale.
  const nowMs = Date.parse('2026-07-08T03:00:00Z');
  const updatedAtMs = nowMs - 20 * 60 * 1000;
  assert.equal(cache.isCacheFresh(updatedAtMs, nowMs, 900000), false);
});

test('isCacheFresh returns true for old cache on weekend (12h effective TTL)', () => {
  // Saturday, cache 2 hours old. Effective TTL = 12h. Should be fresh.
  const nowMs = Date.parse('2026-07-11T03:00:00Z');
  const updatedAtMs = nowMs - 2 * 60 * 60 * 1000;
  assert.equal(cache.isCacheFresh(updatedAtMs, nowMs, 900000), true);
});

// ============================================================
// TEST: normalizeCandles filters invalid entries
// ============================================================

test('normalizeCandles filters out invalid candle entries', () => {
  const input = [
    makeCandle('2026-07-01', 100),
    null,
    { time: NaN, open: 1, high: 2, low: 0, close: 1, volume: 100 },
    makeCandle('2026-07-02', 101),
    { time: 'invalid', open: 1, high: 2, low: 0.5, close: 1, volume: 100 }
  ];
  const result = cache.normalizeCandles(input);
  assert.equal(result.length, 2);
  assert.equal(result[0].close, 100);
  assert.equal(result[1].close, 101);
});

// ============================================================
// TEST: writeCache trims to 90 candles
// ============================================================

test('writeCache trims candles to last 90', async () => {
  const dir = await tmpdir();
  const candles = [];
  for (let i = 0; i < 120; i++) {
    const d = new Date(Date.parse('2026-01-01') + i * 86400000);
    candles.push(makeCandle(d.toISOString().slice(0, 10), 100 + i));
  }

  await cache.writeCache(dir, 'TEST', candles, 'unit-test');
  const read = await cache.readCache(dir, 'TEST', Date.now(), 900000);
  assert.equal(read.candles.length, 90);
  // Should keep the LAST 90 (i=30..119 → close=130..219)
  assert.equal(read.candles[0].close, 130);
  assert.equal(read.candles[89].close, 219);
});

// ============================================================
// TEST: Multiple fetches with fresh cache only call Yahoo once
// ============================================================

test('second fetch within TTL uses cache without calling Yahoo again', async () => {
  const dir = await tmpdir();
  let fetchCount = 0;
  const freshCandles = make90DCandles(400);

  const provider = cache.createCacheProvider({
    cacheDir: dir,
    ttlMs: 15 * 60 * 1000,
    fetchFn: async () => {
      fetchCount++;
      return freshCandles;
    }
  });

  // First call: no cache, must fetch
  const r1 = await provider.fetchWithCache('ADRO');
  assert.equal(fetchCount, 1, 'First call should fetch from Yahoo');
  assert.equal(r1[0].close, 400);

  // Second call: cache is now fresh, should NOT fetch
  const r2 = await provider.fetchWithCache('ADRO');
  assert.equal(fetchCount, 1, 'Second call should use cache, not fetch again');
  assert.equal(r2[0].close, 400);

  const stats = provider.getStats();
  assert.equal(stats.fetchSuccess, 1);
  assert.equal(stats.cacheHit, 1);
});


// ============================================================
// TEST: --loop flag parsed correctly
// ============================================================

test('parseArgs recognizes --loop flag', () => {
  const args = worker.parseArgs(['node', 'script', '--mode', 'observe', '--loop']);
  assert.equal(args.loop, true, '--loop should be true');
  assert.equal(args.mode, 'observe', 'mode should still be observe');
});

test('parseArgs defaults loop to false when --loop not given', () => {
  const args = worker.parseArgs(['node', 'script', '--mode', 'observe']);
  assert.equal(args.loop, false, 'loop should default to false');
});

test('parseArgs preserves other args alongside --loop', () => {
  const args = worker.parseArgs(['node', 'script', '--mode', 'observe', '--loop', '--limit', '5', '--tickers', 'BBCA,BBRI']);
  assert.equal(args.loop, true);
  assert.equal(args.limit, 5);
  assert.deepEqual(args.tickers, ['BBCA', 'BBRI']);
});

// ============================================================
// TEST: runLoop uses DEFAULT_LOOP_INTERVAL_MS (15 min) and respects env override
// ============================================================

test('DEFAULT_LOOP_INTERVAL_MS is 15 minutes', () => {
  assert.equal(worker.DEFAULT_LOOP_INTERVAL_MS, 15 * 60 * 1000,
    'DEFAULT_LOOP_INTERVAL_MS should be 900000 (15 minutes)');
});

test('runLoop is exported and callable', () => {
  assert.equal(typeof worker.runLoop, 'function', 'runLoop should be exported');
});

// ============================================================
// TEST: runLoop executes iterations and can be stopped
// ============================================================

test('runLoop executes at least one iteration and stops on SIGINT', async () => {
  // We test by providing a very short interval and sending SIGINT after 1st iteration
  let iterationCount = 0;
  const originalRunWorker = worker.runWorker;

  // Monkey-patch runWorker for this test to avoid real execution
  // We'll call runLoop with a custom cliArgs that triggers fast stop
  // Instead, we test the function signature and early stop via short interval

  // Use a direct approach: call runLoop with interval_ms=50, and stop after a brief time
  const loopPromise = worker.runLoop({
    mode: 'observe',
    loop: true,
    limit: 1,
    tickers: ['BBCA'],
    interval_ms: 50, // 50ms interval for fast test
    // Override lock/cache dirs to temp
    lockFile: path.join(os.tmpdir(), 'test-loop-lock-' + Date.now() + '.lock'),
    cacheDir: await tmpdir(),
    logDir: await tmpdir()
  });

  // Give it time for at least 1 iteration attempt then stop
  await new Promise((resolve) => setTimeout(resolve, 300));
  process.emit('SIGINT');

  const result = await loopPromise;
  assert.equal(result.stopped, true, 'Loop should report stopped=true');
  assert.ok(result.iterations >= 1, 'Loop should have run at least 1 iteration');
});

// ============================================================
// TEST: Single-run mode (no --loop) does NOT loop
// ============================================================

test('runWorker without --loop returns single result (not a loop)', async () => {
  const dir = await tmpdir();
  const logDir = await tmpdir();
  const lockFile = path.join(os.tmpdir(), 'test-single-run-' + Date.now() + '.lock');

  const result = await worker.runWorker({
    mode: 'observe',
    tickers: ['BBCA'],
    limit: 1,
    lockFile: lockFile,
    cacheDir: dir,
    logDir: logDir
  });

  // Single run returns a log object (not { iterations, stopped })
  assert.ok(result, 'Should return a result');
  assert.equal(result.mode, 'observe', 'Should be observe mode');
  assert.ok('duration_ms' in result, 'Should have duration_ms (single run log)');
  assert.ok(!('iterations' in result), 'Should NOT have iterations key (not a loop)');
  assert.ok(!('stopped' in result), 'Should NOT have stopped key (not a loop)');
});
