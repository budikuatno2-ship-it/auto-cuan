/**
 * VPS On-Demand Data Fetcher
 *
 * Automatically fetches authentic broker summary data from the VPS on-demand
 * when files are missing locally. Prevents local disk bloat by only downloading
 * the specific ticker/date files requested.
 */

const { execFileSync, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// F3-001/F3-002: how "current" a local broker-summary snapshot must be before
// it may be presented as the live price. This has to be session-aware: during a
// live session the tape moves, so only a genuinely recent snapshot may
// short-circuit the bridge; outside session hours the exchange is shut and the
// last print cannot change, so a much wider window is correct.
const { getMarketSession } = require('./market-hours-guard');
const LIVE_SNAPSHOT_FRESH_MS = 30 * 60 * 1000;
const OFFLINE_SNAPSHOT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const SSH_KEY_PATH = process.env.VPS_SSH_KEY || 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
const SSH_TARGET = process.env.VPS_SSH_TARGET || 'ubuntu@168.110.221.197';
const VPS_ROOT_DATA_PATH = process.env.VPS_ROOT_DATA_PATH || '/home/ubuntu/auto-cuan/data/arjum-data';
const VPS_BASE_PATH = process.env.VPS_BASE_PATH || `${VPS_ROOT_DATA_PATH}/broker-summary`;

const SSH_OPTIONS = [
  '-i', SSH_KEY_PATH,
  '-o', 'ConnectTimeout=15',
  '-o', 'ServerAliveInterval=20',
  '-o', 'ServerAliveCountMax=12',
  '-o', 'StrictHostKeyChecking=no'
];

// Batch 2: resolved per call instead of frozen at import time, so an operator
// can repoint the bridge (tunnel rotation) — or a test can redirect it to a
// local stub — without reloading the module. The exported constant below keeps
// its historical shape for existing consumers.
function getVpsDataApiBase() {
  return process.env.VPS_DATA_API_BASE
    || process.env.NEXT_PUBLIC_VPS_DATA_API
    || 'https://wishing-challenged-deeper-crown.trycloudflare.com';
}
const VPS_DATA_API_BASE = process.env.VPS_DATA_API_BASE || process.env.NEXT_PUBLIC_VPS_DATA_API || 'https://wishing-challenged-deeper-crown.trycloudflare.com';

const memoryBrokerSummaryCache = new Map();
const memoryDatesCache = new Map();
let lastHttpBridgeFailure = 0;
const HTTP_BRIDGE_COOLDOWN_MS = 60000;

// F3-009: a long-running scanner walks an ever-changing ticker universe, so an
// unbounded memo table grows for the whole lifetime of the process. Every
// insertion goes through setBoundedCacheEntry() below.
const DEFAULT_MAX_MEMORY_CACHE_ENTRIES = 500;

// F3-004: in-flight coalescing. Two screeners asking for the same ticker+date
// at the same moment must share ONE upstream request instead of racing.
const inFlightBrokerSummaryRequests = new Map();

function maxMemoryCacheEntries() {
  const configured = Number(process.env.VPS_FETCHER_MAX_MEMORY_ENTRIES);
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  return DEFAULT_MAX_MEMORY_CACHE_ENTRIES;
}

/**
 * Insert into an in-memory memo table while holding it to a hard size bound.
 * Map preserves insertion order, so the oldest key is always the first one and
 * is the correct eviction victim. Re-inserting an existing key refreshes its
 * position, so entries still in active use are not evicted first.
 */
function setBoundedCacheEntry(cache, key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  const cap = maxMemoryCacheEntries();
  while (cache.size > cap) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** Test/ops hook: observe memo-table growth so an unbounded heap is visible. */
function __getMemoryCacheStats() {
  return {
    brokerSummaryEntries: memoryBrokerSummaryCache.size,
    datesEntries: memoryDatesCache.size,
    inFlightRequests: inFlightBrokerSummaryRequests.size,
    maxEntries: maxMemoryCacheEntries()
  };
}

/**
 * F3-001/F3-002: is a local snapshot current enough to be shown as the live
 * price? During a live session only a recent snapshot qualifies; outside
 * session hours the wider offline window applies because nothing can change.
 */
function localSnapshotFreshness(mtimeMs, nowMs) {
  const age = nowMs - mtimeMs;
  const session = getMarketSession(new Date(nowMs));
  const live = session === 'SESSION_1' || session === 'SESSION_2';
  const limit = live ? LIVE_SNAPSHOT_FRESH_MS : OFFLINE_SNAPSHOT_MAX_AGE_MS;
  // A negative age means clock skew on a file that was just written; treat it
  // as fresh rather than as infinitely old.
  return age <= limit;
}

function cleanTicker(ticker) {
  return String(ticker || '').trim().replace(/\.JK$/i, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Batch 1 (P0): the bridge was previously reached by spawning a Windows-only
// shell HTTP client binary, which does not exist on the Linux runtime — every
// call threw and was swallowed, so missing dates could never be backfilled.
// All HTTP now goes through the platform client (global fetch on Node 22).
//
// The *sync* variants must stay synchronous: lib/bandarmologi-intel-service.js
// calls fetchBrokerSummaryFromVpsSync / fetchAvailableDatesFromVpsSync inside
// synchronous code. They therefore perform the HTTP request in a short-lived
// child Node process and read the result from stdout.
const SYNC_HTTP_SCRIPT = [
  'const url = process.argv.find(a => typeof a === "string" && (a.startsWith("http://") || a.startsWith("https://"))) || process.argv[1] || "";',
  'const timeoutMs = Number(process.argv.slice(1).find(a => /^\\d+$/.test(a))) || 5000;',
  'const controller = new AbortController();',
  'const timer = setTimeout(() => controller.abort(), timeoutMs);',
  'fetch(url, { signal: controller.signal })',
  '  .then(res => res.text().then(body => {',
  '    clearTimeout(timer);',
  '    process.stdout.write(JSON.stringify({ ok: res.ok, status: res.status, body: body }));',
  '  }))',
  '  .catch(err => {',
  '    clearTimeout(timer);',
  '    process.stdout.write(JSON.stringify({ ok: false, status: 0, error: String((err && err.message) || err) }));',
  '  });'
].join('\n');

/**
 * Report a failed VPS fetch. Never swallows the reason: the original code used
 * bare `catch (_) {}`, which hid an unreachable bridge for an unknown length of
 * time. Secrets are never logged (only the URL scheme/host and the message).
 */
function logFetchFailure(scope, errorDetail) {
  const detail = errorDetail && errorDetail.message
    ? errorDetail.message
    : String(errorDetail);
  console.warn(`[VPS-FETCHER][WARN] ${scope} failed: ${detail}`);
}

/**
 * Synchronous GET returning parsed JSON, using the platform HTTP client.
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {{ok: boolean, status?: number, data?: object, error?: string}}
 */
function fetchJsonSync(url, timeoutMs) {
  const timeout = Number(timeoutMs) || 5000;
  let raw = null;
  try {
    raw = execFileSync(process.execPath, ['-e', SYNC_HTTP_SCRIPT, url, String(timeout)], {
      encoding: 'utf8',
      timeout: timeout + 3000,
      maxBuffer: 16 * 1024 * 1024
    });
  } catch (err) {
    logFetchFailure(url, err);
    return { ok: false, error: 'spawn_or_timeout' };
  }

  let envelope = null;
  try {
    envelope = JSON.parse(raw);
  } catch (parseErr) {
    logFetchFailure(url, parseErr);
    return { ok: false, error: 'invalid_json_envelope' };
  }

  if (!envelope || !envelope.ok) {
    logFetchFailure(url, (envelope && envelope.error) || 'bridge_error');
    return { ok: false, status: envelope && envelope.status, error: envelope && envelope.error };
  }

  try {
    const data = JSON.parse(envelope.body);
    return { ok: true, status: envelope.status, data };
  } catch (bodyErr) {
    logFetchFailure(url, bodyErr);
    return { ok: false, status: envelope.status, error: 'invalid_json_body' };
  }
}

function getLocalStorageDir() {
  if (process.env.ARJUM_DATA_DIR) {
    return path.join(process.env.ARJUM_DATA_DIR, 'broker-summary');
  }
  return path.join(__dirname, '..', 'data', 'arjum-data', 'broker-summary');
}

function ensureLocalDirExists(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * AUDIT-F5-07: publish a JSON snapshot atomically.
 *
 * Every on-demand sync path used a bare fs.writeFileSync() straight over the
 * live cache path. fs.writeFileSync truncates the target before writing, so a
 * concurrent reader (the hunter fast path in broker-hunter-service, or
 * readLocalBrokerAccumulation) could open the file mid-write and observe a
 * truncated/partial document — a torn read that JSON.parse() rejects, silently
 * degrading a populated snapshot into "no data".
 *
 * Write to a unique temp file in the SAME directory (so rename stays on one
 * filesystem and is therefore atomic), fsync it, then rename over the target.
 * A reader sees either the previous complete document or the new one, never a
 * partial one. Failures are reported through logFetchFailure, never swallowed.
 */
function atomicWriteJsonSync(filePath, data) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmpPath, 'w');
    fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (err) {
    if (fd != null) {
      try { fs.closeSync(fd); } catch (closeErr) {
        logFetchFailure(`atomic write close ${path.basename(filePath)}`, closeErr);
      }
    }
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (unlinkErr) {
      logFetchFailure(`atomic write cleanup ${path.basename(filePath)}`, unlinkErr);
    }
    logFetchFailure(`atomic write ${path.basename(filePath)}`, err);
    return false;
  }
}

function hasSshKey() {
  try {
    return fs.existsSync(SSH_KEY_PATH);
  } catch (_) {
    return false;
  }
}

function isTestEnv() {
  // Batch 2: explicit opt-in so an integration suite can exercise the REAL
  // bridge path (against a local stub). Previously this short-circuit made the
  // live-pricing defects impossible to test end to end.
  if (process.env.VPS_FETCHER_ALLOW_IN_TESTS === '1') return false;
  return process.env.NODE_ENV === 'test' ||
    Boolean(process.env.CI) ||
    typeof global.it === 'function' ||
    typeof global.test === 'function' ||
    process.argv.some(a => String(a).includes('test'));
}

/** Test/ops hook: drop memoised bridge results so a new environment is honoured. */
function __resetMemoryCaches() {
  memoryBrokerSummaryCache.clear();
  memoryDatesCache.clear();
  inFlightBrokerSummaryRequests.clear();
  // The cooldown is environment state too: leaving it set would silently skip
  // the bridge for a whole minute after the endpoint was repointed.
  lastHttpBridgeFailure = 0;
}

/**
 * Fetch available dates for a ticker from VPS via HTTP tunnel or SSH
 * @param {string} ticker
 * @returns {Promise<string[]>}
 */
async function fetchAvailableDatesFromVps(ticker) {
  if (!ticker) return [];
  if (isTestEnv()) return [];
  const safeTicker = cleanTicker(ticker);
  if (memoryDatesCache.has(safeTicker)) {
    return memoryDatesCache.get(safeTicker);
  }

  const url = `${getVpsDataApiBase()}/api/available-dates?ticker=${encodeURIComponent(safeTicker)}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let res;
    try {
      res = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    // F3-006: a non-2xx answer used to fall through silently, so a 429/503 was
    // indistinguishable from "this ticker has no dates". Report the status.
    if (!res.ok) {
      logFetchFailure('async available-dates bridge', `${url} -> HTTP ${res.status}`);
    } else {
      const data = await res.json();
      if (data && Array.isArray(data.dates)) {
        const cleanDates = data.dates.filter(d => d && d !== 'latest');
        if (cleanDates.length > 0) {
          setBoundedCacheEntry(memoryDatesCache, safeTicker, cleanDates);
          return cleanDates;
        }
      }
    }
  } catch (err) {
    logFetchFailure('async available-dates bridge', err);
  }

  return fetchAvailableDatesFromVpsSync(ticker);
}

/**
 * Fetch available dates for a ticker from VPS synchronously
 * @param {string} ticker
 * @returns {string[]}
 */
function fetchAvailableDatesFromVpsSync(ticker) {
  if (!ticker) return [];
  if (isTestEnv()) return [];
  const safeTicker = cleanTicker(ticker);
  if (memoryDatesCache.has(safeTicker)) {
    return memoryDatesCache.get(safeTicker);
  }

  const apiBase = getVpsDataApiBase();
  const bridge = fetchJsonSync(
    `${apiBase}/api/available-dates?ticker=${encodeURIComponent(safeTicker)}`,
    4000
  );
  if (bridge.ok && bridge.data && Array.isArray(bridge.data.dates)) {
    const cleanDates = bridge.data.dates.filter(d => d && d !== 'latest');
    if (cleanDates.length > 0) {
      setBoundedCacheEntry(memoryDatesCache, safeTicker, cleanDates);
      return cleanDates;
    }
  } else if (bridge.status) {
    // F3-006: surface the rejected status instead of silently trying SSH.
    logFetchFailure('sync available-dates bridge', `${apiBase} -> HTTP ${bridge.status}`);
  }

  if (hasSshKey()) {
    try {
      const remoteDir = `${VPS_BASE_PATH}/${safeTicker}`;
      const stdout = execFileSync('ssh', [
        ...SSH_OPTIONS,
        SSH_TARGET,
        `ls -1 "${remoteDir}" 2>/dev/null`
      ], { encoding: 'utf8', timeout: 18000 });
      if (stdout) {
        const dates = stdout.split('\n')
          .map(f => f.trim())
          .filter(f => f.endsWith('.json') && f !== 'latest.json')
          .map(f => f.replace('.json', ''))
          .sort().reverse();
        if (dates.length > 0) {
          setBoundedCacheEntry(memoryDatesCache, safeTicker, dates);
          return dates;
        }
      }
    } catch (err) {
      logFetchFailure(`ssh available-dates ${safeTicker}`, err);
    }
  }

  return [];
}

/**
 * Fetch a specific broker summary file from VPS synchronously
 * @param {string} ticker Ticker symbol (e.g. 'GPRA', 'BBCA')
 * @param {string} date Date key ('latest' or YYYY-MM-DD)
 * @returns {object|null} Parsed JSON data or null if unavailable
 */
function fetchBrokerSummaryFromVpsSync(ticker, date = 'latest') {
  if (!ticker) return null;
  if (isTestEnv()) return null;
  const safeTicker = cleanTicker(ticker);
  const safeDate = String(date || 'latest').trim().replace(/[^0-9\-a-zA-Z]/g, '');
  const cacheKey = `${safeTicker}_${safeDate}`;

  if (memoryBrokerSummaryCache.has(cacheKey)) {
    return memoryBrokerSummaryCache.get(cacheKey);
  }

  const candidateDates = [safeDate];

  // 1. Try VPS HTTP Bridge Tunnel (0 byte local storage)
  for (const targetDate of candidateDates) {
    const bridgeUrl = `${getVpsDataApiBase()}/api/broker-summary?ticker=${encodeURIComponent(safeTicker)}&date=${encodeURIComponent(targetDate)}`;
    const bridge = fetchJsonSync(bridgeUrl, 5000);
    const parsed = bridge.ok ? bridge.data : null;
    if (parsed && (parsed.brokers || parsed.stock_code)) {
      setBoundedCacheEntry(memoryBrokerSummaryCache, cacheKey, parsed);
      setBoundedCacheEntry(memoryBrokerSummaryCache, `${safeTicker}_${targetDate}`, parsed);
      return parsed;
    }
    // F3-005: a rejected status (429/502/503) previously vanished, so a
    // rate-limited bridge looked exactly like a missing file.
    if (!bridge.ok && bridge.status) {
      logFetchFailure('sync broker-summary bridge', `${bridgeUrl} -> HTTP ${bridge.status}`);
    }
  }

  // 2. Fallback to SSH if key is available
  if (!hasSshKey()) {
    return null;
  }

  for (const targetDate of candidateDates) {
    const remoteFilePath = `${VPS_BASE_PATH}/${safeTicker}/${targetDate}.json`;
    try {
      const stdout = execFileSync('ssh', [
        ...SSH_OPTIONS,
        SSH_TARGET,
        `cat "${remoteFilePath}" 2>/dev/null`
      ], {
        encoding: 'utf8',
        timeout: 18000,
        maxBuffer: 15 * 1024 * 1024
      });

      if (stdout && stdout.trim().startsWith('{')) {
        const parsed = JSON.parse(stdout);
        if (parsed && (parsed.brokers || parsed.stock_code)) {
          setBoundedCacheEntry(memoryBrokerSummaryCache, cacheKey, parsed);
          setBoundedCacheEntry(memoryBrokerSummaryCache, `${safeTicker}_${targetDate}`, parsed);
          return parsed;
        }
      }
    } catch (err) {
      logFetchFailure(`ssh broker-summary ${safeTicker}@${targetDate}`, err);
    }
  }

  return null;
}

/**
 * Fetch a specific broker summary file from VPS asynchronously
 * @param {string} ticker Ticker symbol
 * @param {string} date Date key
 * @returns {Promise<object|null>}
 */
async function fetchBrokerSummaryFromVps(ticker, date = 'latest') {
  if (!ticker) return null;
  if (isTestEnv()) return null;
  const safeTicker = cleanTicker(ticker);
  const safeDate = String(date || 'latest').trim().replace(/[^0-9\-a-zA-Z]/g, '');
  const cacheKey = `${safeTicker}_${safeDate}`;

  if (memoryBrokerSummaryCache.has(cacheKey)) {
    return memoryBrokerSummaryCache.get(cacheKey);
  }

  // F3-004: coalesce concurrent callers. Daytrade and Swing screeners can ask
  // for the same ticker in the same tick; without this each one issued its own
  // upstream request (a thundering herd against a rate-limited bridge).
  if (inFlightBrokerSummaryRequests.has(cacheKey)) {
    return inFlightBrokerSummaryRequests.get(cacheKey);
  }

  const pending = (async () => {
    const candidateDates = [safeDate];

    for (const targetDate of candidateDates) {
      const bridgeUrl = `${getVpsDataApiBase()}/api/broker-summary?ticker=${encodeURIComponent(safeTicker)}&date=${encodeURIComponent(targetDate)}`;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        let res;
        try {
          res = await fetch(bridgeUrl, { signal: controller.signal });
        } finally {
          clearTimeout(timeout);
        }
        if (res.ok) {
          const parsed = await res.json();
          if (parsed && (parsed.brokers || parsed.stock_code)) {
            setBoundedCacheEntry(memoryBrokerSummaryCache, cacheKey, parsed);
            setBoundedCacheEntry(memoryBrokerSummaryCache, `${safeTicker}_${targetDate}`, parsed);
            return parsed;
          }
        } else {
          // F3-005: name the status so a rate limit is diagnosable.
          logFetchFailure('async broker-summary bridge', `${bridgeUrl} -> HTTP ${res.status}`);
        }
      } catch (err) {
        logFetchFailure(`async broker-summary bridge ${safeTicker}@${targetDate}`, err);
      }
    }

    return fetchBrokerSummaryFromVpsSync(ticker, date);
  })();

  inFlightBrokerSummaryRequests.set(cacheKey, pending);
  try {
    return await pending;
  } finally {
    inFlightBrokerSummaryRequests.delete(cacheKey);
  }
}

/**
 * Fetch a specific broker hunter index file from VPS synchronously
 * @param {string} broker Broker code (e.g. 'AK', 'CC')
 * @param {string} range Range key ('1d', '7d', '30d')
 * @returns {object|null}
 */
function fetchBrokerHunterFromVpsSync(broker, range = '1d') {
  if (!broker) return null;
  const safeBroker = String(broker).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const safeRange = String(range || '1d').trim().toLowerCase();

  if (!hasSshKey()) return null;

  const candidateFiles = [
    `${safeBroker}_${safeRange}.json`,
    `${safeBroker}-${safeRange}.json`
  ];

  const localIndexDir = path.join(__dirname, '..', 'data', 'broker-hunter-indexes');
  ensureLocalDirExists(localIndexDir);

  for (const filename of candidateFiles) {
    const remotePath = `/home/ubuntu/auto-cuan/data/broker-hunter-indexes/${filename}`;
    try {
      const stdout = execFileSync('ssh', [
        ...SSH_OPTIONS,
        SSH_TARGET,
        `cat "${remotePath}" 2>/dev/null`
      ], {
        encoding: 'utf8',
        timeout: 18000,
        maxBuffer: 5 * 1024 * 1024
      });

      if (stdout && stdout.trim().startsWith('{')) {
        const parsed = JSON.parse(stdout);
        if (parsed && (parsed.top_accumulated || parsed.broker)) {
          const localPath = path.join(localIndexDir, `${safeBroker}_${safeRange}.json`);
          atomicWriteJsonSync(localPath, parsed);
          console.log(`[VPS-FETCHER] Successfully fetched Broker Hunter ${safeBroker} (${safeRange}) from VPS`);
          return parsed;
        }
      }
    } catch (err) {
      logFetchFailure(`ssh broker-hunter ${safeBroker}/${safeRange}`, err);
    }
  }

  return null;
}

/**
 * Fetch authentic OHLCV cache file for a ticker from VPS synchronously
 * @param {string} ticker Ticker symbol (e.g. 'BBCA', 'GPRA')
 * @returns {object|null}
 */
function fetchOhlcvFromVpsSync(ticker) {
  if (!ticker) return null;
  const safeTicker = cleanTicker(ticker);

  const localOhlcvDir = path.join(__dirname, '..', 'data', 'daytrade-ohlcv-cache');
  const localFilePath = path.join(localOhlcvDir, `${safeTicker}.json`);
  if (fs.existsSync(localFilePath)) {
    try {
      return JSON.parse(fs.readFileSync(localFilePath, 'utf8'));
    } catch (err) {
      logFetchFailure(`local ohlcv cache ${safeTicker}`, err);
    }
  }

  if (!hasSshKey()) return null;

  ensureLocalDirExists(localOhlcvDir);
  const remotePath = `/home/ubuntu/auto-cuan/data/daytrade-ohlcv-cache/${safeTicker}.json`;

  try {
    const stdout = execFileSync('ssh', [
      ...SSH_OPTIONS,
      SSH_TARGET,
      `cat "${remotePath}" 2>/dev/null`
    ], {
      encoding: 'utf8',
      timeout: 18000,
      maxBuffer: 10 * 1024 * 1024
    });

    if (stdout && stdout.trim().startsWith('{')) {
      const parsed = JSON.parse(stdout);
      if (parsed && (Array.isArray(parsed.candles) || parsed.ticker)) {
        atomicWriteJsonSync(localFilePath, parsed);
        console.log(`[VPS-FETCHER] Successfully fetched OHLCV ${safeTicker} from VPS`);
        return parsed;
      }
    }
  } catch (err) {
    logFetchFailure(`ssh ohlcv ${safeTicker}`, err);
  }

  return null;
}

/**
 * Fetch authentic OHLCV cache file for a ticker from VPS asynchronously
 * @param {string} ticker
 * @returns {Promise<object|null>}
 */
function fetchOhlcvFromVps(ticker) {
  return new Promise((resolve) => {
    try {
      resolve(fetchOhlcvFromVpsSync(ticker));
    } catch (err) {
      logFetchFailure(`async ohlcv ${ticker}`, err);
      resolve(null);
    }
  });
}

/**
 * Fetch authentic insider transactions file for a ticker from VPS synchronously
 * @param {string} ticker Ticker symbol
 * @returns {object|null}
 */
function fetchInsidersFromVpsSync(ticker) {
  if (!ticker) return null;
  const safeTicker = cleanTicker(ticker);

  const localInsDir = path.join(__dirname, '..', 'data', 'arjum-data', 'insiders', safeTicker);
  const localFilePath = path.join(localInsDir, 'p1.json');
  if (fs.existsSync(localFilePath)) {
    try {
      return JSON.parse(fs.readFileSync(localFilePath, 'utf8'));
    } catch (err) {
      logFetchFailure(`local insiders cache ${safeTicker}`, err);
    }
  }

  if (!hasSshKey()) return null;

  ensureLocalDirExists(localInsDir);
  const remotePath = `${VPS_ROOT_DATA_PATH}/insiders/${safeTicker}/p1.json`;

  try {
    const stdout = execFileSync('ssh', [
      ...SSH_OPTIONS,
      SSH_TARGET,
      `cat "${remotePath}" 2>/dev/null`
    ], {
      encoding: 'utf8',
      timeout: 18000,
      maxBuffer: 5 * 1024 * 1024
    });

    if (stdout && stdout.trim().startsWith('{')) {
      const parsed = JSON.parse(stdout);
      if (parsed && (Array.isArray(parsed.items) || parsed.stock_code)) {
        atomicWriteJsonSync(localFilePath, parsed);
        return parsed;
      }
    }
  } catch (err) {
    logFetchFailure(`ssh insiders ${safeTicker}`, err);
  }

  return null;
}

/**
 * Fetch authentic insider transactions file for a ticker from VPS asynchronously
 * @param {string} ticker
 * @returns {Promise<object|null>}
 */
function fetchInsidersFromVps(ticker) {
  return new Promise((resolve) => {
    try {
      resolve(fetchInsidersFromVpsSync(ticker));
    } catch (_) {
      resolve(null);
    }
  });
}

/**
 * Ensure broker summary exists locally; if not, fetch on-demand from VPS
 * @param {string} ticker
 * @param {string} date
 * @returns {Promise<boolean>} True if file exists or was fetched
 */
async function ensureBrokerSummary(ticker, date = 'latest') {
  if (!ticker) return false;
  const safeTicker = cleanTicker(ticker);
  const safeDate = String(date || 'latest').trim();

  const localTickerDir = path.join(getLocalStorageDir(), safeTicker);
  const targetFile = path.join(localTickerDir, `${safeDate}.json`);

  if (fs.existsSync(targetFile)) {
    return true;
  }

  const fetched = await fetchBrokerSummaryFromVps(safeTicker, safeDate);
  return !!fetched;
}

/**
 * Fetch multiple historical broker summary files for a ticker from VPS synchronously
 * @param {string} ticker Ticker symbol
 * @param {number} limit Maximum number of recent dates to fetch
 * @returns {string[]} Array of date strings synced
 */
function fetchBrokerSummaryRangeFromVpsSync(ticker, limit = 30) {
  if (!ticker) return [];
  const safeTicker = cleanTicker(ticker);
  if (!hasSshKey()) return [];

  const localTickerDir = path.join(getLocalStorageDir(), safeTicker);
  ensureLocalDirExists(localTickerDir);

  const remoteDir = `${VPS_BASE_PATH}/${safeTicker}`;
  const maxLimit = Math.max(1, Math.min(Number(limit) || 30, 90));
  const remoteCmd = `python3 -c "import os, json; d='${remoteDir}'; files = sorted([f for f in os.listdir(d) if f.endswith('.json') and f != 'latest.json'], reverse=True)[:${maxLimit}] if os.path.exists(d) else []; out = {f: json.load(open(os.path.join(d, f))) for f in files}; print(json.dumps(out))" 2>/dev/null`;

  try {
    const stdout = execFileSync('ssh', [
      ...SSH_OPTIONS,
      SSH_TARGET,
      remoteCmd
    ], {
      encoding: 'utf8',
      timeout: 25000,
      maxBuffer: 50 * 1024 * 1024
    });

    if (stdout && stdout.trim().startsWith('{')) {
      const data = JSON.parse(stdout);
      const datesSaved = [];
      for (const [filename, content] of Object.entries(data)) {
        const localFilePath = path.join(localTickerDir, filename);
        atomicWriteJsonSync(localFilePath, content);
        datesSaved.push(filename.replace('.json', ''));
      }
      if (datesSaved.length > 0) {
        const latestFile = path.join(localTickerDir, 'latest.json');
        if (!fs.existsSync(latestFile)) {
          const newestDate = datesSaved[0];
          atomicWriteJsonSync(latestFile, data[`${newestDate}.json`]);
        }
      }
      console.log(`[VPS-FETCHER] Successfully synced ${datesSaved.length} date files for ${safeTicker} from VPS`);
      return datesSaved;
    }
  } catch (err) {
    console.warn(`[VPS-FETCHER] Warning: failed to fetch range for ${safeTicker}: ${err.message}`);
  }
  return [];
}

/**
 * Fetch multiple historical broker summary files for a ticker from VPS asynchronously
 * @param {string} ticker
 * @param {number} limit
 * @returns {Promise<string[]>}
 */
function fetchBrokerSummaryRangeFromVps(ticker, limit = 30) {
  return new Promise((resolve) => {
    try {
      resolve(fetchBrokerSummaryRangeFromVpsSync(ticker, limit));
    } catch (_) {
      resolve([]);
    }
  });
}

/**
 * Batch 2: surface the freshest tradable price for a ticker straight from the
 * bridge's broker summary, WITHOUT persisting anything to local disk. This is
 * what lets a read-only deployment quote a live price instead of an abandoned
 * local candle.
 *
 * @param {string} ticker
 * @returns {{price: number, as_of_date: string, price_source: string}|null}
 */
function fetchLivePriceFromVpsSync(ticker) {
  if (!ticker) return null;
  if (isTestEnv()) return null;
  const clean = cleanTicker(ticker);
  const cacheKey = `${clean}___live_price__`;
  const cached = memoryBrokerSummaryCache.get(cacheKey);
  const LIVE_PRICE_TTL_MS = 60 * 1000;
  if (cached && typeof cached.timestamp === 'number' && Date.now() - cached.timestamp < LIVE_PRICE_TTL_MS) {
    return cached;
  }

  let payload = null;
  let sourceLabel = 'vps_bridge_live';
  const localLatestPath = path.join(getLocalStorageDir(), clean, 'latest.json');

  // 1. Try local disk cache for this ticker's latest broker summary first (0ms).
  //
  // F3-001/F3-002: the previous gate was a flat 12-hour window, which is right
  // only when the exchange is shut. During a live session it let a snapshot
  // captured hours earlier short-circuit the bridge entirely, so the scanner
  // quoted a frozen price and labelled it "vps_local_cache" — a stale price
  // wearing a fresh badge. The window is now session-aware: tight while the
  // tape is moving, wide when it cannot change.
  let staleLocalPayload = null;
  try {
    if (fs.existsSync(localLatestPath)) {
      const stat = fs.statSync(localLatestPath);
      const isFresh = localSnapshotFreshness(stat.mtimeMs, Date.now());
      const parsed = JSON.parse(fs.readFileSync(localLatestPath, 'utf8'));
      if (parsed && Array.isArray(parsed.brokers) && parsed.brokers.length > 0) {
        if (isFresh) {
          payload = parsed;
          sourceLabel = 'vps_local_cache';
        } else {
          staleLocalPayload = parsed;
        }
      }
    }
  } catch (readErr) {
    logFetchFailure(`local latest-broker-summary ${clean}`, readErr);
  }

  // 2. Try HTTP bridge if local disk has no fresh snapshot (skips if recently failed)
  if ((!payload || !Array.isArray(payload.brokers) || payload.brokers.length === 0) && (Date.now() - lastHttpBridgeFailure > HTTP_BRIDGE_COOLDOWN_MS)) {
    try {
      const res = fetchJsonSync(
        `${getVpsDataApiBase()}/api/broker-summary?ticker=${encodeURIComponent(clean)}&date=latest`,
        3000
      );
      if (res && res.ok && res.data && Array.isArray(res.data.brokers) && res.data.brokers.length > 0) {
        payload = res.data;
      } else {
        lastHttpBridgeFailure = Date.now();
      }
    } catch (err) {
      lastHttpBridgeFailure = Date.now();
      logFetchFailure(`http live-price ${clean}`, err);
    }
  }

  // 3. Fallback to direct SSH read from remote VPS if HTTP bridge is down
  if ((!payload || !Array.isArray(payload.brokers) || payload.brokers.length === 0) && hasSshKey()) {
    try {
      const remoteFilePath = `${VPS_BASE_PATH}/${clean}/latest.json`;
      const stdout = execFileSync('ssh', [
        ...SSH_OPTIONS,
        SSH_TARGET,
        `cat "${remoteFilePath}" 2>/dev/null`
      ], {
        encoding: 'utf8',
        timeout: 18000,
        maxBuffer: 15 * 1024 * 1024
      });
      if (stdout && stdout.trim().startsWith('{')) {
        const parsed = JSON.parse(stdout);
        if (parsed && Array.isArray(parsed.brokers) && parsed.brokers.length > 0) {
          payload = parsed;
          sourceLabel = 'vps_ssh_live';
          try {
            ensureLocalDirExists(path.dirname(localLatestPath));
            atomicWriteJsonSync(localLatestPath, parsed);
          } catch (wErr) {
            logFetchFailure(`write local latest-broker-summary ${clean}`, wErr);
          }
        }
      }
    } catch (err) {
      logFetchFailure(`ssh live-price ${clean}`, err);
    }
  }

  // 4. Offline fallback to stale local snapshot if network and SSH both unavailable.
  // F3-002: the label must tell the truth, and the degradation must be logged —
  // a silent fallback is how a stale price stayed undetected in production.
  if ((!payload || !Array.isArray(payload.brokers) || payload.brokers.length === 0) && staleLocalPayload) {
    payload = staleLocalPayload;
    sourceLabel = 'vps_local_cache_stale';
    logFetchFailure(
      `live-price ${clean}`,
      'bridge and SSH unavailable; serving an out-of-window local snapshot labelled vps_local_cache_stale'
    );
  }

  if (!payload || !Array.isArray(payload.brokers) || payload.brokers.length === 0) return null;

  // Volume-weighted average traded price across every broker row of the day.
  let val = 0;
  let vol = 0;
  for (const b of payload.brokers) {
    const bval = Number(b.bval || b.buy_val || 0);
    const bvol = Number(b.bvol || b.buy_vol || 0);
    if (bval > 0 && bvol > 0) { val += bval; vol += bvol; }
  }
  if (!(val > 0 && vol > 0)) return null;

  const detail = {
    price: Math.round(val / vol),
    as_of_date: String(payload.trade_date || payload.broker_start_date || payload.date || '').slice(0, 10) || null,
    price_source: sourceLabel,
    timestamp: Date.now()
  };
  setBoundedCacheEntry(memoryBrokerSummaryCache, cacheKey, detail);
  return detail;
}

/**
 * Batch 2: read a pre-aggregated intel index from the bridge or direct SSH from remote VPS.
 *
 * @param {string} range
 * @returns {object|null}
 */
function fetchIntelIndexFromVpsSync(range) {
  const cleanRange = String(range || '7d').trim().toLowerCase();
  if (isTestEnv()) return null;

  // 1. Try HTTP bridge
  try {
    const url = `${getVpsDataApiBase()}/api/bandarmologi-intel?range=${encodeURIComponent(cleanRange)}`;
    const res = fetchJsonSync(url, 4000);
    const payload = res && res.ok ? res.data : null;
    if (payload && payload.indexes && typeof payload.indexes === 'object') return payload;
  } catch (err) {
    logFetchFailure(`http intel-index ${cleanRange}`, err);
  }

  // 2. Direct SSH read from remote VPS bandarmologi-intel directory
  if (hasSshKey()) {
    try {
      const remoteIndexDir = `${VPS_ROOT_DATA_PATH}/bandarmologi-intel`;
      const candidates = (cleanRange === '7d' || !cleanRange)
        ? ['latest_7d.json', 'latest.json']
        : [`latest_${cleanRange}.json`];
      for (const fname of candidates) {
        const remoteFilePath = `${remoteIndexDir}/${fname}`;
        const stdout = execFileSync('ssh', [
          ...SSH_OPTIONS,
          SSH_TARGET,
          `cat "${remoteFilePath}" 2>/dev/null`
        ], {
          encoding: 'utf8',
          timeout: 25000,
          maxBuffer: 40 * 1024 * 1024
        });
        if (stdout && stdout.trim().startsWith('{')) {
          const parsed = JSON.parse(stdout);
          if (parsed && (parsed.indexes || parsed.tickers)) {
            return parsed;
          }
        }
      }
    } catch (err) {
      logFetchFailure(`ssh intel-index ${cleanRange}`, err);
    }
  }

  return null;
}

/**
 * Fetch authentic broker accumulation series for a ticker from VPS synchronously
 * @param {string} ticker
 * @returns {object|null}
 */
function fetchBrokerAccumulationFromVpsSync(ticker) {
  if (!ticker) return null;
  if (isTestEnv()) return null;
  const safeTicker = cleanTicker(ticker);
  const cacheKey = `acc_${safeTicker}`;
  if (memoryBrokerSummaryCache.has(cacheKey)) {
    return memoryBrokerSummaryCache.get(cacheKey);
  }

  // 1. Try HTTP bridge
  try {
    const bridge = fetchJsonSync(
      `${getVpsDataApiBase()}/api/broker-accumulation?ticker=${encodeURIComponent(safeTicker)}`,
      4000
    );
    if (bridge && bridge.ok && bridge.data && (Array.isArray(bridge.data.series) || bridge.data.top_buyers)) {
      memoryBrokerSummaryCache.set(cacheKey, bridge.data);
      return bridge.data;
    }
  } catch (err) {
    logFetchFailure(`http broker-accumulation ${safeTicker}`, err);
  }

  // 2. Direct SSH read from remote VPS
  if (hasSshKey()) {
    try {
      const remoteFilePath = `${VPS_ROOT_DATA_PATH}/broker-accumulation/${safeTicker}/series.json`;
      const stdout = execFileSync('ssh', [
        ...SSH_OPTIONS,
        SSH_TARGET,
        `cat "${remoteFilePath}" 2>/dev/null`
      ], {
        encoding: 'utf8',
        timeout: 18000,
        maxBuffer: 15 * 1024 * 1024
      });
      if (stdout && stdout.trim().startsWith('{')) {
        const parsed = JSON.parse(stdout);
        if (parsed) {
          try {
            const localAccDir = path.join(path.dirname(getLocalStorageDir()), 'broker-accumulation', safeTicker);
            ensureLocalDirExists(localAccDir);
            atomicWriteJsonSync(path.join(localAccDir, 'series.json'), parsed);
          } catch (writeErr) {
            logFetchFailure(`write broker-accumulation ${safeTicker}`, writeErr);
          }
          memoryBrokerSummaryCache.set(cacheKey, parsed);
          return parsed;
        }
      }
    } catch (err) {
      logFetchFailure(`ssh broker-accumulation ${safeTicker}`, err);
    }
  }

  return null;
}

/**
 * Fetch authentic broker accumulation series for a ticker from VPS asynchronously
 * @param {string} ticker
 * @returns {Promise<object|null>}
 */
function fetchBrokerAccumulationFromVps(ticker) {
  return new Promise((resolve) => {
    try {
      resolve(fetchBrokerAccumulationFromVpsSync(ticker));
    } catch (_) {
      resolve(null);
    }
  });
}

/** Batch 2: available-date master list from the bridge (full history). */
function fetchAvailableDatesFromVpsBridgeSync(ticker) {
  if (!ticker) return [];
  if (isTestEnv()) return [];
  const clean = cleanTicker(ticker);
  const res = fetchJsonSync(
    `${getVpsDataApiBase()}/api/available-dates?ticker=${encodeURIComponent(clean)}`,
    5000
  );
  const payload = res.ok ? res.data : null;
  if (!payload || !Array.isArray(payload.dates)) return [];
  return payload.dates.filter(d => d && d !== 'latest');
}

module.exports = {
  fetchBrokerSummaryFromVpsSync,
  fetchBrokerSummaryFromVps,
  fetchAvailableDatesFromVps,
  fetchAvailableDatesFromVpsSync,
  fetchAvailableDatesFromVpsBridgeSync,
  fetchBrokerSummaryRangeFromVpsSync,
  fetchBrokerSummaryRangeFromVps,
  fetchBrokerHunterFromVpsSync,
  fetchOhlcvFromVpsSync,
  fetchOhlcvFromVps,
  fetchInsidersFromVpsSync,
  fetchInsidersFromVps,
  fetchLivePriceFromVpsSync,
  fetchIntelIndexFromVpsSync,
  fetchBrokerAccumulationFromVpsSync,
  fetchBrokerAccumulationFromVps,
  cleanTicker,
  ensureBrokerSummary,
  __resetMemoryCaches,
  __getMemoryCacheStats,
  __atomicWriteJsonSync: atomicWriteJsonSync,
  hasSshKey,
  SSH_KEY_PATH,
  SSH_TARGET,
  SSH_OPTIONS,
  VPS_BASE_PATH,
  VPS_ROOT_DATA_PATH,
  VPS_DATA_API_BASE
};
