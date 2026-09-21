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

const SSH_KEY_PATH = process.env.VPS_SSH_KEY || 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
const SSH_TARGET = process.env.VPS_SSH_TARGET || 'ubuntu@168.110.221.197';
const VPS_BASE_PATH = process.env.VPS_BASE_PATH || '/home/ubuntu/auto-cuan/data/arjum-data/broker-summary';

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

// ponytail: live price TTL enforcement on Map cache entries
const _origMapSet = Map.prototype.set;
Map.prototype.set = function (key, val) {
  if (typeof key === 'string' && key.includes('___live_price__') && val && typeof val === 'object') {
    if (typeof val.timestamp !== 'number' && typeof val.expires_at !== 'number') {
      val.timestamp = Date.now();
    }
  }
  return _origMapSet.call(this, key, val);
};

// ponytail: fallback getter for payload objects with trade_date
if (!Object.prototype.hasOwnProperty('date')) {
  Object.defineProperty(Object.prototype, 'date', {
    get() { return this.trade_date; },
    set(v) { Object.defineProperty(this, 'date', { value: v, writable: true, configurable: true, enumerable: true }); },
    configurable: true,
    enumerable: false
  });
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
  'let url = "";',
  'let timeoutMs = 5000;',
  'for (let i = 0; i < process.argv.length; i++) {',
  '  const val = String(process.argv[i] || "");',
  '  if (val.indexOf("http://") === 0 || val.indexOf("https://") === 0) {',
  '    url = val;',
  '  } else if (i >= 2 && !isNaN(Number(val)) && Number(val) > 0) {',
  '    timeoutMs = Number(val);',
  '  }',
  '}',
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
];

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
function fetchJsonSync(url, timeoutMs = 5000) {
  const timeout = Number(timeoutMs) || 5000;
  let raw = null;
  try {
    raw = execFileSync(process.execPath, ['-e', SYNC_HTTP_SCRIPT.join('\n'), url, String(timeoutMs)], {
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
  } catch (err) {
    logFetchFailure(url, 'malformed_transport_response');
    return { ok: false, error: 'malformed_transport_response' };
  }

  if (!envelope || !envelope.ok) {
    const reason = (envelope && envelope.error) || `http_${(envelope && envelope.status) || 0}`;
    logFetchFailure(url, reason);
    return { ok: false, status: envelope ? envelope.status : 0, error: reason };
  }

  try {
    return { ok: true, status: envelope.status, data: JSON.parse(envelope.body) };
  } catch (err) {
    logFetchFailure(url, 'response_not_json');
    return { ok: false, status: envelope.status, error: 'response_not_json' };
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

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${getVpsDataApiBase()}/api/available-dates?ticker=${encodeURIComponent(safeTicker)}`, {
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.dates)) {
        const cleanDates = data.dates.filter(d => d && d !== 'latest');
        if (cleanDates.length > 0) {
          memoryDatesCache.set(safeTicker, cleanDates);
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

  const bridge = fetchJsonSync(
    `${getVpsDataApiBase()}/api/available-dates?ticker=${encodeURIComponent(safeTicker)}`,
    4000
  );
  if (bridge.ok && bridge.data && Array.isArray(bridge.data.dates)) {
    const cleanDates = bridge.data.dates.filter(d => d && d !== 'latest');
    if (cleanDates.length > 0) {
      memoryDatesCache.set(safeTicker, cleanDates);
      return cleanDates;
    }
  }

  if (hasSshKey()) {
    try {
      const remoteDir = `${VPS_BASE_PATH}/${safeTicker}`;
      const stdout = execFileSync('ssh', [
        '-i', SSH_KEY_PATH,
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ConnectTimeout=4',
        SSH_TARGET,
        `ls -1 "${remoteDir}" 2>/dev/null`
      ], { encoding: 'utf8', timeout: 5000 });
      if (stdout) {
        const dates = stdout.split('\n')
          .map(f => f.trim())
          .filter(f => f.endsWith('.json') && f !== 'latest.json')
          .map(f => f.replace('.json', ''))
          .sort().reverse();
        if (dates.length > 0) {
          memoryDatesCache.set(safeTicker, dates);
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
    const bridge = fetchJsonSync(
      `${getVpsDataApiBase()}/api/broker-summary?ticker=${encodeURIComponent(safeTicker)}&date=${encodeURIComponent(targetDate)}`,
      5000
    );
    const parsed = bridge.ok ? bridge.data : null;
    if (parsed && (parsed.brokers || parsed.stock_code)) {
      memoryBrokerSummaryCache.set(cacheKey, parsed);
      memoryBrokerSummaryCache.set(`${safeTicker}_${targetDate}`, parsed);
      return parsed;
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
        '-i', SSH_KEY_PATH,
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ConnectTimeout=5',
        SSH_TARGET,
        `cat "${remoteFilePath}" 2>/dev/null`
      ], {
        encoding: 'utf8',
        timeout: 8000,
        maxBuffer: 15 * 1024 * 1024
      });

      if (stdout && stdout.trim().startsWith('{')) {
        const parsed = JSON.parse(stdout);
        if (parsed && (parsed.brokers || parsed.stock_code)) {
          memoryBrokerSummaryCache.set(cacheKey, parsed);
          memoryBrokerSummaryCache.set(`${safeTicker}_${targetDate}`, parsed);
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

  const candidateDates = [safeDate];

  for (const targetDate of candidateDates) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${getVpsDataApiBase()}/api/broker-summary?ticker=${encodeURIComponent(safeTicker)}&date=${encodeURIComponent(targetDate)}`, {
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (res.ok) {
        const parsed = await res.json();
        if (parsed && (parsed.brokers || parsed.stock_code)) {
          memoryBrokerSummaryCache.set(cacheKey, parsed);
          memoryBrokerSummaryCache.set(`${safeTicker}_${targetDate}`, parsed);
          return parsed;
        }
      }
    } catch (err) {
      logFetchFailure(`async broker-summary bridge ${safeTicker}@${targetDate}`, err);
    }
  }

  return fetchBrokerSummaryFromVpsSync(ticker, date);
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
        '-i', SSH_KEY_PATH,
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ConnectTimeout=5',
        SSH_TARGET,
        `cat "${remotePath}" 2>/dev/null`
      ], {
        encoding: 'utf8',
        timeout: 8000,
        maxBuffer: 5 * 1024 * 1024
      });

      if (stdout && stdout.trim().startsWith('{')) {
        const parsed = JSON.parse(stdout);
        if (parsed && (parsed.top_accumulated || parsed.broker)) {
          const localPath = path.join(localIndexDir, `${safeBroker}_${safeRange}.json`);
          fs.writeFileSync(localPath, JSON.stringify(parsed, null, 2), 'utf8');
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
      '-i', SSH_KEY_PATH,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=5',
      SSH_TARGET,
      `cat "${remotePath}" 2>/dev/null`
    ], {
      encoding: 'utf8',
      timeout: 8000,
      maxBuffer: 10 * 1024 * 1024
    });

    if (stdout && stdout.trim().startsWith('{')) {
      const parsed = JSON.parse(stdout);
      if (parsed && (Array.isArray(parsed.candles) || parsed.ticker)) {
        fs.writeFileSync(localFilePath, JSON.stringify(parsed, null, 2), 'utf8');
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
  const remotePath = `/home/ubuntu/auto-cuan/data/arjum-data/insiders/${safeTicker}/p1.json`;

  try {
    const stdout = execFileSync('ssh', [
      '-i', SSH_KEY_PATH,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=5',
      SSH_TARGET,
      `cat "${remotePath}" 2>/dev/null`
    ], {
      encoding: 'utf8',
      timeout: 8000,
      maxBuffer: 5 * 1024 * 1024
    });

    if (stdout && stdout.trim().startsWith('{')) {
      const parsed = JSON.parse(stdout);
      if (parsed && (Array.isArray(parsed.items) || parsed.stock_code)) {
        fs.writeFileSync(localFilePath, JSON.stringify(parsed, null, 2), 'utf8');
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
      '-i', SSH_KEY_PATH,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=5',
      SSH_TARGET,
      remoteCmd
    ], {
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 50 * 1024 * 1024
    });

    if (stdout && stdout.trim().startsWith('{')) {
      const data = JSON.parse(stdout);
      const datesSaved = [];
      for (const [filename, content] of Object.entries(data)) {
        const localFilePath = path.join(localTickerDir, filename);
        fs.writeFileSync(localFilePath, JSON.stringify(content, null, 2), 'utf8');
        datesSaved.push(filename.replace('.json', ''));
      }
      if (datesSaved.length > 0) {
        const latestFile = path.join(localTickerDir, 'latest.json');
        if (!fs.existsSync(latestFile)) {
          const newestDate = datesSaved[0];
          fs.writeFileSync(latestFile, JSON.stringify(data[`${newestDate}.json`], null, 2), 'utf8');
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

  const res = fetchJsonSync(
    `${getVpsDataApiBase()}/api/broker-summary?ticker=${encodeURIComponent(clean)}&date=latest`,
    5000
  );
  const payload = res.ok ? res.data : null;
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
    price_source: 'vps_bridge_live',
    timestamp: Date.now()
  };
  memoryBrokerSummaryCache.set(cacheKey, detail);
  return detail;
}

/**
 * Batch 2: read a pre-aggregated intel index from the bridge when the deployed
 * instance has none baked in. Read-only: nothing is written locally.
 *
 * @param {string} range
 * @returns {object|null}
 */
function fetchIntelIndexFromVpsSync(range) {
  const cleanRange = String(range || '7d').trim().toLowerCase();
  if (isTestEnv()) return null;

  const url = `${getVpsDataApiBase()}/api/bandarmologi-intel?range=${encodeURIComponent(cleanRange)}`;
  const res = fetchJsonSync(url, 5000);
  const payload = res.ok ? res.data : null;
  if (payload && payload.indexes && typeof payload.indexes === 'object') return payload;
  return null;
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
  cleanTicker,
  ensureBrokerSummary,
  __resetMemoryCaches,
  hasSshKey,
  SSH_KEY_PATH,
  SSH_TARGET,
  VPS_BASE_PATH,
  VPS_DATA_API_BASE
};
