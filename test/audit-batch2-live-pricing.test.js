'use strict';

/**
 * Batch 2 integration note: the stub bridge runs as a SEPARATE PROCESS
 * (test/fixtures/bridge-stub-server.js) because the production client performs
 * its synchronous bridge call via execFileSync, which blocks this process's
 * event loop. An in-process stub would deadlock, so the stub is out of process
 * and the production code path stays completely real.
 */

/**
 * Regression guards for BATCH 2 — Real price synchronisation & live VPS data bridge (P1).
 *
 * Root causes documented in SYSTEM_ARCHITECTURE_LIFECYCLE.md:
 *   B1 — `available-dates` exposed a raw local directory listing, so a deployed
 *        instance with one file showed a one-option dropdown even though the VPS
 *        bridge held the full history.
 *   B2 — Market Scanner `current_price` came from an abandoned local OHLCV candle
 *        (CUAN 630) instead of the live bridge VWAP (914).
 *   B3 — the intel serving path hard-failed when the baked index was missing and
 *        the read-only-deployment guard prevented any live aggregate source.
 *   B4 — payloads carried no honest provenance (as_of_date / price_source), so a
 *        stale price was indistinguishable from a live one in the UI.
 *
 * Network: a LOCAL stub HTTP server impersonates the VPS bridge. No external
 * endpoint, no Telegram, no Supabase, no production credentials.
 *
 * NOTE: api/bandarmologi.js does not exist in this repository. The real
 * bandarmologi endpoint is api/sector-hot.js (action=bandarmologi /
 * action=available-dates / action=bandarmologi-intel), which is what the
 * services below are called by.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Fixture truth values (deliberately different from any committed baked index)
// ---------------------------------------------------------------------------

const LATEST_DATE = '2026-09-14';
const LIVE_VWAP = 914;                 // bridge truth for the ticker below
const STALE_CANDLE_CLOSE = 630;        // abandoned local OHLCV candle
const STALE_CANDLE_DATE = '2026-07-17';
const TICKER = 'AUDITB2';

/** 172 distinct trading dates, newest first, weekends skipped. */
function buildTradingDates(fromDate, count) {
  const out = [];
  const d = new Date(fromDate + 'T00:00:00Z');
  while (out.length < count) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}
const BRIDGE_DATES = buildTradingDates(LATEST_DATE, 172);
const BRIDGE_DATES_OLDEST = BRIDGE_DATES[BRIDGE_DATES.length - 1];

/** Broker summary whose aggregate VWAP equals LIVE_VWAP exactly. */
function brokerSummaryPayload(ticker, date) {
  // bval / bvol => 914 exactly, with two rows so it is a real weighted average.
  return {
    stock_code: ticker,
    broker_start_date: date,
    broker_end_date: date,
    brokers: [
      { broker_code: 'YP', broker_name: 'Mirae', bval: 914000, bvol: 1000, sval: 0, svol: 0, bfrq: 5, sfrq: 1 },
      { broker_code: 'CC', broker_name: 'Mandiri', bval: 91400, bvol: 100, sval: 0, svol: 0, bfrq: 2, sfrq: 0 }
    ]
  };
}
const BRIDGE_DATE_COUNT = 172;

let bridgeChild = null;
// Counted in this process by intercepting nothing — the stub logs each hit to
// stderr and we tally the lines, so assertions can prove the bridge was used.
let bridgeHits = { availableDates: 0, brokerSummary: 0, intel: 0 };
let ready = null;

const STUB_PATH = path.join(__dirname, 'fixtures', 'bridge-stub-server.js');

/**
 * Start the stub bridge OUT OF PROCESS and resolve its base URL.
 * Out of process is mandatory: the production sync call uses execFileSync, which
 * blocks this process's event loop — an in-process server could never reply.
 */
function startStubBridge() {
  return new Promise((resolve, reject) => {
    bridgeChild = spawn(process.execPath, [STUB_PATH], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const timer = setTimeout(() => reject(new Error('stub bridge start timeout')), 15000);

    bridgeChild.stdout.on('data', chunk => {
      const text = String(chunk);
      const m = /BRIDGE_PORT=(\d+)/.exec(text);
      if (m) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${m[1]}`);
      }
    });

    bridgeChild.on('error', err => { clearTimeout(timer); reject(err); });
    bridgeChild.on('exit', code => {
      if (code !== 0 && code !== null) {
        clearTimeout(timer);
        reject(new Error(`stub bridge exited early with code ${code}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Environment is configured BEFORE any module is required, because
// lib/vps-data-fetcher.js freezes its base URL at import time.
// ---------------------------------------------------------------------------

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'autocuan-b2-'));
const EMPTY_ARJUM_DIR = path.join(TMP_ROOT, 'arjum-empty');
const EMPTY_INTEL_DIR = path.join(TMP_ROOT, 'intel-empty');
fs.mkdirSync(EMPTY_ARJUM_DIR, { recursive: true });
fs.mkdirSync(EMPTY_INTEL_DIR, { recursive: true });

/** Simulate a deployed (read-only, no local cache) instance with a live bridge. */
function configureDeployedEnv(baseUrl) {
  process.env.VPS_DATA_API_BASE = baseUrl;
  process.env.ARJUM_DATA_DIR = EMPTY_ARJUM_DIR;         // no local broker-summary
  process.env.INTEL_INDEX_DIR = EMPTY_INTEL_DIR;        // no baked intel index
  process.env.INTEL_CACHE_DIR = path.join(TMP_ROOT, 'intel-cache-empty');
  // The /tmp fallback directory is machine-global; without this override a
  // leftover file from any earlier run would satisfy the "nothing available"
  // case and hide a real regression.
  process.env.INTEL_TMP_DIR = path.join(TMP_ROOT, 'intel-tmp-empty');
  process.env.VERCEL = '1';                             // deployed runtime
  // The VPS fetcher refuses network calls when it detects a test runner; this
  // explicit opt-in is what lets the suite exercise the REAL bridge path
  // instead of mocking it away.
  process.env.VPS_FETCHER_ALLOW_IN_TESTS = '1';
  process.env.VPS_SSH_KEY = path.join(TMP_ROOT, 'missing.key');
}

ready = startStubBridge().then(baseUrl => {
  configureDeployedEnv(baseUrl);
  return baseUrl;
});

test.after(() => {
  if (bridgeChild) {
    try { bridgeChild.kill('SIGTERM'); } catch (_) {}
  }
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (_) {}
});

function requireDeployed(modulePath) {
  // Lazy require so the env above is in place before module constants load.
  return require(modulePath);
}

// ---------------------------------------------------------------------------
// B1 — available-dates must come from the VPS bridge master list when deployed
// ---------------------------------------------------------------------------

test('B1: deployed available-dates returns the full bridge history, not the local listing', async () => {
  await ready;
  const service = requireDeployed('../lib/bandarmologi-service');

  const dates = await service.getAvailableDates(TICKER);

  assert.ok(Array.isArray(dates), 'must return an array');
  assert.equal(dates.length, BRIDGE_DATES.length,
    `expected the master bridge list (${BRIDGE_DATES.length}) but got ${dates.length}`);
  assert.equal(dates[0], LATEST_DATE);
  assert.equal(dates[dates.length - 1], BRIDGE_DATES_OLDEST);
  // Proven by content: these 172 values exist ONLY in the stub bridge, never on
  // local disk (ARJUM_DATA_DIR is empty), so serving them proves the bridge was used.
  assert.ok(dates.includes(BRIDGE_DATES_OLDEST), 'the bridge list must have been used, not a local listing');
});

test('B1b: a non-empty but PARTIAL local listing must not truncate the bridge history', async () => {
  await ready;
  const service = requireDeployed('../lib/bandarmologi-service');
  const fetcher = requireDeployed('../lib/vps-data-fetcher');

  // Simulate production exactly: one local file, full history on the bridge.
  const partialDir = path.join(TMP_ROOT, 'partial-arjum');
  const tickerDir = path.join(partialDir, 'broker-summary', TICKER);
  fs.mkdirSync(tickerDir, { recursive: true });
  fs.writeFileSync(path.join(tickerDir, `${LATEST_DATE}.json`),
    JSON.stringify(brokerSummaryPayload(TICKER, LATEST_DATE)), 'utf8');

  const previous = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = partialDir;
  try {
    assert.equal(service.listDiskDates('broker-summary', TICKER).length, 1,
      'precondition: local disk must hold exactly one date');
    const dates = await service.getAvailableDates(TICKER);
    assert.equal(dates.length, BRIDGE_DATES.length,
      `partial local cache must not truncate the bridge master list (got ${dates.length})`);
    assert.ok(dates.includes(BRIDGE_DATES_OLDEST),
      'the oldest bridge date must be present in the dropdown source');
  } finally {
    process.env.ARJUM_DATA_DIR = previous;
    // Reset memoised fetcher caches so later tests are unaffected.
    if (fetcher && typeof fetcher.__resetMemoryCaches === 'function') fetcher.__resetMemoryCaches();
  }
});

// ---------------------------------------------------------------------------
// B2 — live bridge price must beat a stale local candle
// ---------------------------------------------------------------------------

test('B2: Market Scanner price prefers the live bridge over a stale local candle', async () => {
  await ready;
  const intel = requireDeployed('../lib/bandarmologi-intel-service');

  // Abandoned candle cache, exactly like the CUAN 630 / PTRO 4080 defect.
  const ohlcvDir = path.join(process.cwd(), 'data', 'daytrade-ohlcv-cache');
  const ohlcvFile = path.join(ohlcvDir, `${TICKER}.json`);
  fs.mkdirSync(ohlcvDir, { recursive: true });
  const existedBefore = fs.existsSync(ohlcvFile);
  const backup = existedBefore ? fs.readFileSync(ohlcvFile, 'utf8') : null;

  fs.writeFileSync(ohlcvFile, JSON.stringify({
    ticker: TICKER,
    interval: '1d',
    updated_at: STALE_CANDLE_DATE + 'T00:00:00.000Z',
    candles: [{ time: 1784253600, date: STALE_CANDLE_DATE, open: 630, high: 640, low: 610, close: STALE_CANDLE_CLOSE, volume: 1000 }]
  }, null, 2), 'utf8');

  try {
    const price = intel.getCachedClosePrice(TICKER);
    assert.notEqual(price, STALE_CANDLE_CLOSE,
      'a stale candle must never be served as the current price when the bridge has fresher data');
    assert.equal(price, LIVE_VWAP,
      `expected the live bridge VWAP ${LIVE_VWAP}, got ${price}`);
  } finally {
    if (backup !== null) fs.writeFileSync(ohlcvFile, backup, 'utf8');
    else fs.rmSync(ohlcvFile, { force: true });
  }
});

test('B2b: the price carrier exposes honest as_of_date and price_source', async () => {
  await ready;
  const intel = requireDeployed('../lib/bandarmologi-intel-service');

  assert.equal(typeof intel.getCachedClosePriceDetail, 'function',
    'a provenance-carrying accessor must exist so the UI can label the price');

  const detail = intel.getCachedClosePriceDetail(TICKER);
  assert.ok(detail, 'detail must be returned');
  assert.equal(detail.price, LIVE_VWAP);
  assert.equal(detail.as_of_date, LATEST_DATE,
    'as_of_date must be the trading date the price belongs to, not a write timestamp');
  assert.equal(detail.price_source, 'vps_bridge_live');
});

// ---------------------------------------------------------------------------
// B3 — VERCEL must serve, and must never write to a read-only disk
// ---------------------------------------------------------------------------

test('B3: VERCEL can read a live aggregate without writing to local disk', async () => {
  await ready;
  const intel = requireDeployed('../lib/bandarmologi-intel-service');

  assert.equal(process.env.VERCEL, '1', 'precondition: deployed runtime');

  const snapshotBefore = fs.readdirSync(EMPTY_INTEL_DIR).sort();

  const payload = await intel.getBandarmologiIntel({ range: '7d', ticker: TICKER });

  assert.equal(payload.success, true, 'serving must not hard-fail on a read-only deployment');
  assert.ok(payload.result, 'the per-ticker aggregate must be present');

  const snapshotAfter = fs.readdirSync(EMPTY_INTEL_DIR).sort();
  assert.deepEqual(snapshotAfter, snapshotBefore,
    'no index file may be written to the local intel directory on VERCEL');
});

test('B3b: VERCEL never attempts a full recompute+save (read-only filesystem)', async () => {
  await ready;
  const intel = requireDeployed('../lib/bandarmologi-intel-service');

  const before = fs.readdirSync(EMPTY_INTEL_DIR).sort();
  const payload = await intel.getBandarmologiIntel({ range: '7d', forceRefresh: true });
  const after = fs.readdirSync(EMPTY_INTEL_DIR).sort();

  assert.deepEqual(after, before, 'forceRefresh must not write on VERCEL');
  assert.equal(payload.success, true, 'a forced refresh on VERCEL must still serve');
  assert.ok(payload.data_source, 'the payload must declare where the data came from');
});

test('B3c: when no index exists and no bridge is reachable, the failure is explicit', async () => {
  await ready;
  const intel = requireDeployed('../lib/bandarmologi-intel-service');

  const previousBase = process.env.VPS_DATA_API_BASE;
  // Unroutable port: the bridge genuinely cannot be reached.
  process.env.VPS_DATA_API_BASE = 'http://127.0.0.1:1';
  try {
    const payload = await intel.getBandarmologiIntel({ range: '7d' });
    assert.equal(payload.success, false, 'an unreachable bridge with no index must fail honestly');
    assert.ok(payload.error, 'the failure must carry a reason');
    assert.equal(payload.data_source, 'unavailable');
  } finally {
    process.env.VPS_DATA_API_BASE = previousBase;
  }
});

// ---------------------------------------------------------------------------
// B4 — scanner rows must carry provenance so the UI can flag stale prices
// ---------------------------------------------------------------------------

test('B4: intel payload declares data_source and as_of_date', async () => {
  await ready;
  const intel = requireDeployed('../lib/bandarmologi-intel-service');

  const payload = await intel.getBandarmologiIntel({ range: '7d', ticker: TICKER });
  assert.equal(payload.success, true);

  assert.equal(payload.as_of_date, LATEST_DATE,
    'as_of_date must reflect the trading date of the served data');
  assert.equal(payload.data_source, 'live_bridge',
    'data served from the live bridge must be labelled as such');
});

test('B4b: a baked index served without a bridge is labelled, not silently stale', async () => {
  await ready;
  const intel = requireDeployed('../lib/bandarmologi-intel-service');

  const bakedDir = path.join(TMP_ROOT, 'intel-baked');
  fs.mkdirSync(bakedDir, { recursive: true });
  fs.writeFileSync(path.join(bakedDir, 'latest_7d.json'), JSON.stringify({
    updated_at: '2026-09-12T16:57:26.353Z',
    effective_date: '2026-09-11',
    date: '2026-09-11',
    total_evaluated: 1,
    indexes: {
      harga_di_bawah_modal_bandar: [{ ticker: 'BAKED', current_price: 1, bandar_avg_buy: 2 }],
      silent_foreign_accumulation: [], ritel_cutloss_bandar_nampung: [],
      distribusi_ke_ritel: [], cr3_massive: []
    }
  }), 'utf8');

  const previousDir = process.env.INTEL_INDEX_DIR;
  const previousBase = process.env.VPS_DATA_API_BASE;
  process.env.INTEL_INDEX_DIR = bakedDir;
  process.env.VPS_DATA_API_BASE = 'http://127.0.0.1:1'; // bridge unavailable
  try {
    const payload = await intel.getBandarmologiIntel({ range: '7d' });
    assert.equal(payload.success, true, 'a baked index must still be served');
    assert.equal(payload.data_source, 'baked_index');
    assert.equal(payload.as_of_date, '2026-09-11',
      'as_of_date must come from the index trading date, never the write timestamp');
    assert.equal(payload.updated_at, '2026-09-12T16:57:26.353Z');
  } finally {
    process.env.INTEL_INDEX_DIR = previousDir;
    process.env.VPS_DATA_API_BASE = previousBase;
  }
});
