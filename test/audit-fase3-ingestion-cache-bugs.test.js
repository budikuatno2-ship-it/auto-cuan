'use strict';

/**
 * FASE 3 — Forensic audit of the ingestion + market-data cache layer.
 *
 * Targets:
 *   lib/vps-data-fetcher.js      (VPS bridge ingestion + in-memory caches)
 *   lib/daytrade-ohlcv-cache.js  (on-disk market-data cache; there is no
 *                                 lib/market-data-cache.js in this repo)
 *
 * Every assertion below is a regression guard for a defect that was reproduced
 * against the REAL implementation first (see AUDIT_LOG_FASE_3_23SEPT.md) — no
 * historical audit status was trusted.
 *
 * Network: only a LOCAL stub bridge on 127.0.0.1 (test/fixtures/fase3-bridge-stub.js).
 * No production endpoint, no Telegram, no Supabase, no credentials.
 *
 * The stub runs OUT OF PROCESS because the production sync path performs its
 * HTTP call via execFileSync, which blocks this process's event loop; an
 * in-process server could never answer it.
 */

// Opt in BEFORE anything else: lib/vps-data-fetcher.js refuses to touch the
// network while it detects a test runner, which would mask every defect here.
process.env.VPS_FETCHER_ALLOW_IN_TESTS = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const vpsFetcher = require('../lib/vps-data-fetcher');
const ohlcvCache = require('../lib/daytrade-ohlcv-cache');

const STUB_PATH = path.join(__dirname, 'fixtures', 'fase3-bridge-stub.js');

// A machine-local SSH key must never be used by this suite. The production
// default points at a real Windows path, so an unset override would let the
// "SSH fallback" branches reach out for real.
const MISSING_SSH_KEY = path.join(os.tmpdir(), 'fase3-audit-missing-key.pem');
process.env.VPS_SSH_KEY = MISSING_SSH_KEY;

// ---------------------------------------------------------------------------
// Frozen clocks. 2026-09-23 is a Wednesday.
//   03:00Z = 10:00 WIB -> SESSION_1 (live)
//   13:00Z = 20:00 WIB -> CLOSED
// ---------------------------------------------------------------------------
const FROZEN_LIVE_SESSION = Date.parse('2026-09-23T03:00:00Z');
const FROZEN_OFF_HOURS = Date.parse('2026-09-23T13:00:00Z');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fase3-audit-'));
let activeChildren = [];

test.after(() => {
  for (const child of activeChildren) {
    try { child.kill('SIGTERM'); } catch (_) {}
  }
  activeChildren = [];
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (_) {}
});

// ---------------------------------------------------------------------------
// Stub bridge control
// ---------------------------------------------------------------------------

/**
 * Start the out-of-process stub bridge.
 * @param {{mode?: string, vwap?: number, date?: string}} opts
 * @returns {Promise<{baseUrl: string, requests: string[], stop: () => void}>}
 */
function startStubBridge(opts) {
  opts = opts || {};
  const env = Object.assign({}, process.env, {
    FASE3_STUB_MODE: opts.mode || 'ok',
    FASE3_STUB_VWAP: String(opts.vwap == null ? 914 : opts.vwap),
    FASE3_STUB_DATE: opts.date || '2026-09-23'
  });

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [STUB_PATH], { stdio: ['ignore', 'pipe', 'pipe'], env });
    activeChildren.push(child);

    const requests = [];
    const timer = setTimeout(() => reject(new Error('stub bridge start timeout')), 15000);
    let settled = false;

    child.stdout.on('data', chunk => {
      for (const line of String(chunk).split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('REQ ')) requests.push(trimmed.slice(4));
        const match = /BRIDGE_PORT=(\d+)/.exec(trimmed);
        if (match && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve({
            baseUrl: `http://127.0.0.1:${match[1]}`,
            requests,
            stop: () => { try { child.kill('SIGTERM'); } catch (_) {} }
          });
        }
      }
    });

    child.on('error', err => { if (!settled) { clearTimeout(timer); reject(err); } });
    child.on('exit', code => {
      if (!settled && code !== 0 && code !== null) {
        clearTimeout(timer);
        reject(new Error(`stub bridge exited early with code ${code}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Freeze Date.now for the duration of a test. */
function freezeClock(t, nowMs) {
  const realNow = Date.now;
  Date.now = () => nowMs;
  t.after(() => { Date.now = realNow; });
}

/** Capture console.warn output. */
function captureWarnings(t) {
  const lines = [];
  const realWarn = console.warn;
  console.warn = (...args) => { lines.push(args.map(String).join(' ')); };
  t.after(() => { console.warn = realWarn; });
  return lines;
}

/** A broker-summary snapshot whose VWAP is exactly `vwap`. */
function brokerSnapshot(ticker, tradeDate, vwap) {
  return {
    stock_code: ticker,
    trade_date: tradeDate,
    broker_start_date: tradeDate,
    brokers: [
      { broker_code: 'YP', broker_name: 'Mirae', bval: vwap * 1000, bvol: 1000, sval: 0, svol: 0 },
      { broker_code: 'CC', broker_name: 'Mandiri', bval: vwap * 100, bvol: 100, sval: 0, svol: 0 }
    ]
  };
}

/**
 * Write a local broker-summary latest.json snapshot with an explicit mtime.
 * @returns {string} the temp ARJUM_DATA_DIR root
 */
function seedLocalSnapshot(ticker, tradeDate, vwap, mtimeMs) {
  const root = fs.mkdtempSync(path.join(TMP_ROOT, 'arjum-'));
  const dir = path.join(root, 'broker-summary', ticker);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'latest.json');
  fs.writeFileSync(file, JSON.stringify(brokerSnapshot(ticker, tradeDate, vwap), null, 2), 'utf8');
  if (mtimeMs != null) {
    const seconds = mtimeMs / 1000;
    fs.utimesSync(file, seconds, seconds);
  }
  return root;
}

/** Candles spread over `count` days, each padded so writes span several syscalls. */
function paddedCandles(baseClose, count) {
  const out = [];
  const start = Date.parse('2026-01-01T00:00:00Z');
  for (let i = 0; i < count; i++) {
    out.push({
      time: Math.floor(start / 1000) + i * 86400,
      date: new Date(start + i * 86400000).toISOString().slice(0, 10),
      open: baseClose, high: baseClose + 2, low: baseClose - 2,
      close: baseClose + i, volume: 1000000,
      pad: 'x'.repeat(60)
    });
  }
  return out;
}

// ===========================================================================
// F3-001 — a local snapshot must never outrank a healthy live bridge during
//          the trading session
// ===========================================================================

test('F3-001: during the live session a 6h-old local snapshot must not freeze the price', async (t) => {
  freezeClock(t, FROZEN_LIVE_SESSION);

  // Bridge truth: 999. Local snapshot truth: 500, captured 6 hours ago.
  const bridge = await startStubBridge({ vwap: 999, date: '2026-09-23' });
  t.after(() => bridge.stop());

  const previousBase = process.env.VPS_DATA_API_BASE;
  const previousDir = process.env.ARJUM_DATA_DIR;
  process.env.VPS_DATA_API_BASE = bridge.baseUrl;
  process.env.ARJUM_DATA_DIR = seedLocalSnapshot('F3STALE', '2026-09-22', 500, FROZEN_LIVE_SESSION - 6 * HOUR_MS);

  try {
    vpsFetcher.__resetMemoryCaches();
    const detail = vpsFetcher.fetchLivePriceFromVpsSync('F3STALE');

    assert.ok(detail, 'a price must be resolved');
    assert.equal(
      detail.price, 999,
      `the live bridge (999) must win over a 6h-old local snapshot (500); got ${detail.price}`
    );
    assert.equal(
      detail.price_source, 'vps_bridge_live',
      `a session-fresh bridge price must be labelled vps_bridge_live, got ${detail.price_source}`
    );
    assert.equal(detail.as_of_date, '2026-09-23', 'as_of_date must come from the live bridge payload');
  } finally {
    if (previousBase === undefined) delete process.env.VPS_DATA_API_BASE;
    else process.env.VPS_DATA_API_BASE = previousBase;
    if (previousDir === undefined) delete process.env.ARJUM_DATA_DIR;
    else process.env.ARJUM_DATA_DIR = previousDir;
    vpsFetcher.__resetMemoryCaches();
  }
});

// ===========================================================================
// F3-002 — when the bridge is unreachable, an ageing local snapshot must be
//          labelled honestly (stale), never as a fresh cache
// ===========================================================================

test('F3-002: an ageing local snapshot served offline must be labelled vps_local_cache_stale', async (t) => {
  freezeClock(t, FROZEN_LIVE_SESSION);

  const previousBase = process.env.VPS_DATA_API_BASE;
  const previousDir = process.env.ARJUM_DATA_DIR;
  // Unroutable port: the bridge genuinely cannot be reached.
  process.env.VPS_DATA_API_BASE = 'http://127.0.0.1:1';
  process.env.ARJUM_DATA_DIR = seedLocalSnapshot('F3OFFLINE', '2026-09-22', 500, FROZEN_LIVE_SESSION - 6 * HOUR_MS);

  const warnings = captureWarnings(t);
  try {
    vpsFetcher.__resetMemoryCaches();
    const detail = vpsFetcher.fetchLivePriceFromVpsSync('F3OFFLINE');

    assert.ok(detail, 'the offline fallback must still answer from the local snapshot');
    assert.equal(detail.price, 500, 'the local snapshot VWAP is the only available truth');
    assert.equal(
      detail.price_source, 'vps_local_cache_stale',
      `a snapshot captured 6h ago during a live session is stale and must say so, got ${detail.price_source}`
    );
    assert.notEqual(detail.price_source, 'vps_local_cache',
      'an ageing snapshot must never be presented as a fresh local cache');
    assert.ok(warnings.length > 0, 'the offline fallback must not be silent');
  } finally {
    if (previousBase === undefined) delete process.env.VPS_DATA_API_BASE;
    else process.env.VPS_DATA_API_BASE = previousBase;
    if (previousDir === undefined) delete process.env.ARJUM_DATA_DIR;
    else process.env.ARJUM_DATA_DIR = previousDir;
    vpsFetcher.__resetMemoryCaches();
  }
});

// ===========================================================================
// F3-003 — regression guard: outside the session the local snapshot still
//          short-circuits the bridge (the offline benefit must survive)
// ===========================================================================

test('F3-003: outside the session a recent local snapshot is still served without touching the bridge', async (t) => {
  freezeClock(t, FROZEN_OFF_HOURS);

  const bridge = await startStubBridge({ vwap: 999 });
  t.after(() => bridge.stop());

  const previousBase = process.env.VPS_DATA_API_BASE;
  const previousDir = process.env.ARJUM_DATA_DIR;
  process.env.VPS_DATA_API_BASE = bridge.baseUrl;
  process.env.ARJUM_DATA_DIR = seedLocalSnapshot('F3CLOSED', '2026-09-23', 500, FROZEN_OFF_HOURS - 6 * HOUR_MS);

  try {
    vpsFetcher.__resetMemoryCaches();
    const detail = vpsFetcher.fetchLivePriceFromVpsSync('F3CLOSED');

    assert.ok(detail);
    assert.equal(detail.price, 500, 'the exchange is shut, so the local snapshot is the latest print');
    assert.equal(detail.price_source, 'vps_local_cache');
    assert.equal(
      bridge.requests.filter(r => r.includes('/api/broker-summary')).length, 0,
      'the bridge must not be consulted when a fresh local snapshot already answers'
    );
  } finally {
    if (previousBase === undefined) delete process.env.VPS_DATA_API_BASE;
    else process.env.VPS_DATA_API_BASE = previousBase;
    if (previousDir === undefined) delete process.env.ARJUM_DATA_DIR;
    else process.env.ARJUM_DATA_DIR = previousDir;
    vpsFetcher.__resetMemoryCaches();
  }
});

// ===========================================================================
// F3-004 — concurrent identical requests must not duplicate upstream traffic
//          (thundering herd)
// ===========================================================================

test('F3-004: concurrent identical broker-summary requests must share one upstream call', async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; });

  let upstreamCalls = 0;
  global.fetch = async () => {
    upstreamCalls++;
    await new Promise(resolve => setTimeout(resolve, 40));
    return {
      ok: true,
      status: 200,
      json: async () => brokerSnapshot('F3HERD', '2026-09-23', 700)
    };
  };

  vpsFetcher.__resetMemoryCaches();

  const [first, second] = await Promise.all([
    vpsFetcher.fetchBrokerSummaryFromVps('F3HERD', 'latest'),
    vpsFetcher.fetchBrokerSummaryFromVps('F3HERD', 'latest')
  ]);

  assert.ok(first && second, 'both callers must resolve a payload');
  assert.equal(first.stock_code, 'F3HERD');
  assert.equal(second.stock_code, 'F3HERD');
  assert.equal(
    upstreamCalls, 1,
    `two concurrent callers for the same ticker+date must cause ONE upstream request, saw ${upstreamCalls}`
  );
});

// ===========================================================================
// F3-005 — a rejected upstream response must be surfaced, not swallowed
// ===========================================================================

test('F3-005: HTTP 429 from the bridge must be reported with its status', async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; });

  const previousBase = process.env.VPS_DATA_API_BASE;
  process.env.VPS_DATA_API_BASE = 'http://127.0.0.1:1'; // make the sync fallback fail fast

  const warnings = captureWarnings(t);
  try {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return { ok: false, status: 429, json: async () => ({ error: 'rate limit exceeded' }) };
    };

    vpsFetcher.__resetMemoryCaches();
    const result = await vpsFetcher.fetchBrokerSummaryFromVps('F3RATE', 'latest');

    assert.equal(calls, 1, 'the async bridge path must be attempted once');
    assert.equal(result, null, 'a rate-limited upstream must not produce data');
    assert.ok(
      warnings.some(line => line.includes('429')),
      `the failure must name the HTTP status so the incident is diagnosable; warnings were ${JSON.stringify(warnings)}`
    );
  } finally {
    if (previousBase === undefined) delete process.env.VPS_DATA_API_BASE;
    else process.env.VPS_DATA_API_BASE = previousBase;
    vpsFetcher.__resetMemoryCaches();
  }
});

// ===========================================================================
// F3-006 — non-2xx on the available-dates endpoint must also be surfaced
// ===========================================================================

test('F3-006: HTTP 503 on available-dates must be reported with its status', async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; });

  const previousBase = process.env.VPS_DATA_API_BASE;
  process.env.VPS_DATA_API_BASE = 'http://127.0.0.1:1';

  const warnings = captureWarnings(t);
  try {
    global.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });

    vpsFetcher.__resetMemoryCaches();
    const dates = await vpsFetcher.fetchAvailableDatesFromVps('F3DATES');

    assert.deepEqual(dates, [], 'an unavailable endpoint must not yield dates');
    assert.ok(
      warnings.some(line => line.includes('503')),
      `the failure must name the HTTP status; warnings were ${JSON.stringify(warnings)}`
    );
  } finally {
    if (previousBase === undefined) delete process.env.VPS_DATA_API_BASE;
    else process.env.VPS_DATA_API_BASE = previousBase;
    vpsFetcher.__resetMemoryCaches();
  }
});

// ===========================================================================
// F3-007 — the stale candle fallback must have an age ceiling
// ===========================================================================

test('F3-007: an ancient candle cache must not be served as a usable series', async (t) => {
  freezeClock(t, FROZEN_LIVE_SESSION);
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'ohlcv-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  // 200 days old, and upstream is failing with a rate limit.
  await ohlcvCache.writeCache(dir, 'F3ANCIENT', paddedCandles(100, 90), 'audit');
  const file = path.join(dir, 'F3ANCIENT.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.updated_at = new Date(FROZEN_LIVE_SESSION - 200 * DAY_MS).toISOString();
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n', 'utf8');

  const provider = ohlcvCache.createCacheProvider({
    cacheDir: dir,
    ttlMs: 15 * 60 * 1000,
    fetchFn: async () => { throw new Error('Yahoo HTTP 429'); }
  });

  const result = await provider.fetchWithCache('F3ANCIENT');
  assert.equal(
    result, null,
    'a 200-day-old series must be refused rather than silently used for technical analysis'
  );
});

test('F3-007b: a recently stale cache is still served when upstream fails', async (t) => {
  freezeClock(t, FROZEN_LIVE_SESSION);
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'ohlcv-recent-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  await ohlcvCache.writeCache(dir, 'F3RECENT', paddedCandles(100, 90), 'audit');
  const file = path.join(dir, 'F3RECENT.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.updated_at = new Date(FROZEN_LIVE_SESSION - 1 * DAY_MS).toISOString();
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n', 'utf8');

  const provider = ohlcvCache.createCacheProvider({
    cacheDir: dir,
    ttlMs: 15 * 60 * 1000,
    fetchFn: async () => { throw new Error('Yahoo HTTP 429'); }
  });

  const result = await provider.fetchWithCache('F3RECENT');
  assert.ok(Array.isArray(result) && result.length >= 20,
    'a one-day-old fallback is still operationally useful and must keep working');
  assert.equal(provider.getStats().staleFallback, 1);
});

// ===========================================================================
// F3-008 — cache snapshot writes must be atomic
// ===========================================================================

test('F3-008a: concurrent writers must never blend payloads into one file', async (t) => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'atomic-race-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const WRITERS = 8;
  const ROUNDS = 30;
  for (let round = 0; round < ROUNDS; round++) {
    const ticker = 'F3RACE' + round;
    await Promise.all(
      Array.from({ length: WRITERS }, (_, writer) =>
        ohlcvCache.writeCache(dir, ticker, paddedCandles(100 + writer * 100, 90), 'writer-' + writer)
      )
    );

    const text = fs.readFileSync(path.join(dir, ticker + '.json'), 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      assert.fail(`round ${round}: concurrent writers produced invalid JSON (${err.message})`);
    }
    const base = parsed.candles[0].close;
    assert.ok(
      base >= 100 && base <= 100 + (WRITERS - 1) * 100 && base % 100 === 0,
      `round ${round}: the file mixes payloads from different writers (base close ${base})`
    );
  }
});

test('F3-008b: a reader racing a writer must never observe a partial snapshot', async (t) => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'atomic-torn-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const ticker = 'F3TORN';
  await ohlcvCache.writeCache(dir, ticker, paddedCandles(1, 90), 'seed');
  const file = path.join(dir, ticker + '.json');

  // The reader polls on a timer rather than in a tight synchronous loop: a
  // blocking loop starves the event loop, which would stop the writer from ever
  // interleaving and make this test pass vacuously. A ~2ms cadence was measured
  // to expose the defect (93 of 200 reads torn) against the previous in-place
  // write, so it genuinely exercises the race.
  let tornReads = 0;
  let reads = 0;
  let stop = false;
  const reader = (async () => {
    while (!stop) {
      reads++;
      try {
        JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (_) {
        tornReads++;
      }
      await new Promise(resolve => setTimeout(resolve, 2));
    }
  })();

  for (let i = 0; i < 200; i++) {
    await ohlcvCache.writeCache(dir, ticker, paddedCandles(1000 + i, 90), 'churn');
  }
  stop = true;
  await reader;

  assert.ok(reads > 20, `the reader must actually interleave with the writer (only ${reads} reads)`);
  assert.equal(
    tornReads, 0,
    `${tornReads} of ${reads} concurrent reads observed a partially written snapshot — writes must be atomic`
  );
});

// ===========================================================================
// F3-009 — the in-memory caches must be bounded and observable
// ===========================================================================

test('F3-009: the in-memory ingestion caches must be bounded', async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; });

  const previousCap = process.env.VPS_FETCHER_MAX_MEMORY_ENTRIES;
  process.env.VPS_FETCHER_MAX_MEMORY_ENTRIES = '50';

  try {
    assert.equal(
      typeof vpsFetcher.__getMemoryCacheStats, 'function',
      'a stats accessor must exist so unbounded heap growth is observable in production'
    );

    global.fetch = async (url) => {
      const ticker = new URL(String(url)).searchParams.get('ticker') || 'X';
      return {
        ok: true,
        status: 200,
        json: async () => brokerSnapshot(ticker, '2026-09-23', 500)
      };
    };

    vpsFetcher.__resetMemoryCaches();
    for (let i = 0; i < 120; i++) {
      await vpsFetcher.fetchBrokerSummaryFromVps('F3MEM' + i, 'latest');
    }

    const stats = vpsFetcher.__getMemoryCacheStats();
    assert.ok(
      stats.brokerSummaryEntries <= 50,
      `the broker-summary memory cache must respect the configured bound, saw ${stats.brokerSummaryEntries}`
    );
    assert.ok(
      stats.datesEntries <= 50,
      `the dates memory cache must respect the configured bound, saw ${stats.datesEntries}`
    );
  } finally {
    if (previousCap === undefined) delete process.env.VPS_FETCHER_MAX_MEMORY_ENTRIES;
    else process.env.VPS_FETCHER_MAX_MEMORY_ENTRIES = previousCap;
    vpsFetcher.__resetMemoryCaches();
  }
});
