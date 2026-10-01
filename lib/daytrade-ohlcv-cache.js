/**
 * Day Trade OHLCV Cache — Reusable VPS/Local Candle Cache
 *
 * Stores per-ticker 90D daily OHLCV as JSON in a local directory.
 * During market hours uses a short TTL (default 15 min) so repeated
 * scans avoid re-fetching the full 90D range from Yahoo.
 *
 * Fallback: if Yahoo fails but a cached file exists, returns stale
 * candles with a warning flag.
 *
 * Usage:
 *   const cache = require('./daytrade-ohlcv-cache');
 *   const provider = cache.createCacheProvider({ cacheDir, ttlMs });
 *   // Use as fetchCandles override in runDayTradeBatch options:
 *   const result = await engine.runDayTradeBatch(tickers, runMode, {
 *     fetchCandles: provider.fetchWithCache
 *   });
 */

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

// ============================================================
// DEFAULTS
// ============================================================

const DEFAULT_CACHE_DIR = path.resolve(process.cwd(), 'data', 'daytrade-ohlcv-cache');
const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_YAHOO_TIMEOUT_MS = 12000;

// F3-007: how old a cached series may be and still be served as a fallback when
// the upstream provider fails. Without a ceiling a 200-day-old series was handed
// to the technical-analysis pipeline as if it were current. 7 days spans a long
// weekend plus holidays while still refusing genuinely abandoned data.
const DEFAULT_MAX_STALE_FALLBACK_MS = 7 * 24 * 60 * 60 * 1000;

// ============================================================
// HELPERS
// ============================================================

// ponytail: fixed WIB UTC+7 offset for date/market hours, upgrade to tz database if non-IDX exchanges are supported.
function safeTicker(ticker) {
  return String(ticker || '')
    .trim()
    .replace(/\.JK$/i, '')
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '');
}

function tickerCachePath(cacheDir, ticker) {
  return path.join(cacheDir, safeTicker(ticker) + '.json');
}

function toWibDate(timeSec) {
  return new Date((Number(timeSec) * 1000) + (7 * 60 * 60 * 1000)).toISOString().slice(0, 10);
}

function parseTimeMs(val) {
  if (!val) return 0;
  if (typeof val === 'number') return val;
  var parsed = Date.parse(val);
  if (Number.isFinite(parsed)) return parsed;
  var num = Number(val);
  return Number.isFinite(num) ? num : 0;
}

function normalizeCandle(c) {
  if (!c) return null;
  var time = Number(c.time);
  if (!Number.isFinite(time)) {
    if (typeof c.time === 'string') {
      time = Math.floor(Date.parse(c.time) / 1000);
    }
  } else if (time > 1e11) {
    time = Math.floor(time / 1000);
  }
  var open = Number(c.open);
  var high = Number(c.high);
  var low = Number(c.low);
  var close = Number(c.close);
  var volume = Number(c.volume);
  if (!Number.isFinite(time) || !Number.isFinite(open) || !Number.isFinite(high) ||
      !Number.isFinite(low) || !Number.isFinite(close) || !Number.isFinite(volume)) return null;
  return {
    time: time,
    date: c.date || toWibDate(time),
    open: open,
    high: high,
    low: low,
    close: close,
    volume: volume
  };
}

function normalizeCandles(candles) {
  return (Array.isArray(candles) ? candles : [])
    .map(normalizeCandle)
    .filter(Boolean);
}

// ============================================================
// CACHE READ / WRITE
// ============================================================

// F6-B3-02: on Windows a concurrent atomic replace can make a reader's
// readFile fail with a sharing violation (EPERM/EACCES/EBUSY) even though the
// file is perfectly intact. Those codes are transient by nature — the reader
// only needs to let the replacing writer finish. Reporting them as "no cache"
// made a good cache look absent, which triggered a full upstream refetch (and
// returned null when upstream was also down).
var TRANSIENT_READ_CODES = { EPERM: true, EACCES: true, EBUSY: true, EMFILE: true, ENFILE: true };
var READ_RETRY_ATTEMPTS = 4;

/**
 * Read a cache file, retrying only the transient sharing-violation codes.
 * Returns { text, error }. A persistent failure still returns an error so the
 * caller can fail closed — retries are strictly bounded.
 */
async function readFileWithRetry(filePath, attempts) {
  var lastErr = null;
  for (var i = 0; i < attempts; i++) {
    try {
      var text = await fsp.readFile(filePath, 'utf8');
      return { text: text, error: null };
    } catch (err) {
      lastErr = err;
      if (err && err.code === 'ENOENT') return { text: null, error: err };
      if (!(err && TRANSIENT_READ_CODES[err.code])) return { text: null, error: err };
      await new Promise(function (resolve) { setTimeout(resolve, 5 * (i + 1)); });
    }
  }
  return { text: null, error: lastErr };
}

/**
 * Read cached candles for a ticker.
 * Returns { hit, stale, corrupt, candles, updatedAtMs, meta }
 *
 * F6-B3-01: `corrupt` distinguishes "this file exists but is unreadable data"
 * from "there is no cache yet". Before, both produced the same `{ hit: false }`
 * shape, so on-disk corruption was indistinguishable from a cold start and no
 * consumer could surface it for repair.
 */
async function readCache(cacheDir, ticker, nowMs, ttlMs) {
  var filePath = tickerCachePath(cacheDir, ticker);
  var read = await readFileWithRetry(filePath, READ_RETRY_ATTEMPTS);
  if (read.error) {
    if (read.error.code === 'ENOENT') {
      return { hit: false, stale: true, candles: [], updatedAtMs: 0, ageMs: Infinity, meta: null };
    }
    return { hit: false, stale: true, candles: [], updatedAtMs: 0, ageMs: Infinity, meta: null, error: read.error.message };
  }

  var parsed;
  try {
    parsed = JSON.parse(read.text);
  } catch (e) {
    return { hit: false, stale: true, corrupt: true, candles: [], updatedAtMs: 0, ageMs: Infinity, meta: null, error: e && e.message };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { hit: false, stale: true, corrupt: true, candles: [], updatedAtMs: 0, ageMs: Infinity, meta: null, error: 'payload is not an object' };
  }
  if (!Array.isArray(parsed.candles)) {
    return { hit: false, stale: true, corrupt: true, candles: [], updatedAtMs: 0, ageMs: Infinity, meta: parsed, error: 'candles is not an array' };
  }
  if (parsed.candles.length === 0) {
    return { hit: false, stale: true, candles: [], updatedAtMs: 0, ageMs: Infinity, meta: parsed };
  }
  var rawLast = parsed.candles[parsed.candles.length - 1];
  var normLast = normalizeCandle(rawLast);
  if (!normLast || !Number.isFinite(normLast.time) || normLast.time <= 0 ||
      !Number.isFinite(normLast.volume) || normLast.volume < 0) {
    return { hit: false, stale: true, corrupt: true, candles: [], updatedAtMs: 0, ageMs: Infinity, meta: parsed, error: 'newest candle is unusable' };
  }
  var candles = normalizeCandles(parsed.candles);
  if (candles.length === 0) {
    return { hit: false, stale: true, corrupt: true, candles: [], updatedAtMs: 0, ageMs: Infinity, meta: parsed, error: 'no usable candle survived normalisation' };
  }
  var updatedAtMs = parseTimeMs(parsed.updated_at);
  nowMs = Number(nowMs) || Date.now();
  ttlMs = ttlMs != null ? Number(ttlMs) : DEFAULT_TTL_MS;
  var age = Math.max(0, nowMs - updatedAtMs);
  var stale = !isCacheFresh(updatedAtMs, nowMs, ttlMs);
  return { hit: true, stale: stale, candles: candles, updatedAtMs: updatedAtMs, ageMs: age, meta: parsed };
}

/**
 * Write candles to cache file for a ticker.
 * Trims to last 90 candles.
 */
/**
 * F3-008 / F6-B3-03 / F6-B3-05: replace a cache file atomically.
 *
 * `fs.writeFile` truncates the destination first, so a concurrent reader can
 * observe an empty or half-written file (a JSON parse failure that the caller
 * cannot distinguish from "no cache"). Writing to a unique temp file and
 * renaming it into place means a reader sees either the complete old file or
 * the complete new one.
 *
 * Two hardening rules added in Batch 3:
 *
 *   1. A destination that exists and is NOT a regular file is refused up front
 *      (EISDIR/EINVAL) before a temp file is even created. The old code only
 *      discovered this after exhausting the rename retries, and the in-place
 *      fallback then threw EISDIR with a stray temp file already on disk.
 *
 *   2. There is NO in-place fallback any more. Writing the payload in place is
 *      precisely the torn-read window this function exists to remove: under
 *      concurrent writers it produced files that failed to parse. A cache that
 *      keeps its previous complete snapshot is stale; a cache that has been
 *      clobbered in place is CORRUPT. When every rename is refused the update
 *      fails loudly and the previous snapshot survives intact.
 *
 * On Windows a rename over a file that another handle currently has open fails
 * with EPERM/EACCES/EBUSY, so the rename is retried with a growing backoff.
 */
async function writeFileAtomic(filePath, contents) {
  // F6-B3-03: fail before any side effect when the destination cannot be a file.
  try {
    var existing = await fsp.stat(filePath);
    if (!existing.isFile()) {
      var shapeErr = new Error('destination is not a regular file: ' + filePath);
      shapeErr.code = existing.isDirectory() ? 'EISDIR' : 'EINVAL';
      throw shapeErr;
    }
  } catch (statErr) {
    if (statErr && statErr.code !== 'ENOENT') throw statErr;
  }

  var tmpPath = filePath + '.' + process.pid + '.' + Date.now().toString(36) +
    Math.random().toString(36).slice(2, 8) + '.tmp';
  try {
    await fsp.writeFile(tmpPath, contents);
    var lastErr = null;
    for (var attempt = 0; attempt < 15; attempt++) {
      try {
        await fsp.rename(tmpPath, filePath);
        return true;
      } catch (err) {
        lastErr = err;
        if (err && (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY')) {
          await new Promise(function (resolve) { setTimeout(resolve, 10 * (attempt + 1)); });
          continue;
        }
        throw err;
      }
    }
    // F6-B3-05: never fall back to an in-place write — that is the torn-read
    // window itself. Report the refusal so the caller can retry later while the
    // previous, complete snapshot stays readable.
    var refused = new Error('atomic replace of ' + path.basename(filePath) + ' was refused (' + (lastErr && lastErr.code) + ') after ' + 15 + ' attempts');
    refused.code = (lastErr && lastErr.code) || 'EPERM';
    throw refused;
  } finally {
    // A failed rename leaves the temp file behind; never leak it.
    try { await fsp.unlink(tmpPath); } catch (_) {}
  }
}

async function writeCache(cacheDir, ticker, candles, source) {
  try {
    await fsp.mkdir(cacheDir, { recursive: true });
    var trimmed = normalizeCandles(candles).slice(-90);
    var payload = {
      version: 1,
      ticker: safeTicker(ticker),
      source: source || 'yahoo',
      range: '90d',
      interval: '1d',
      updated_at: new Date().toISOString(),
      candles: trimmed
    };
    await writeFileAtomic(tickerCachePath(cacheDir, ticker), JSON.stringify(payload, null, 2) + '\n');
    return payload;
  } catch (_) {
    return null;
  }
}

// ============================================================
// YAHOO FINANCE FETCHER (direct, with timeout)
// ============================================================

async function fetchYahooCandles(ticker, opts) {
  opts = opts || {};
  var timeoutMs = opts.timeoutMs || DEFAULT_YAHOO_TIMEOUT_MS;
  var symbol = safeTicker(ticker) + '.JK';
  var url = 'https://query2.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(symbol) + '?range=90d&interval=1d&includePrePost=false';

  var ac = new AbortController();
  var timer = setTimeout(function() { ac.abort(); }, timeoutMs);

  try {
    var response = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });

    if (!response.ok) {
      var err = new Error('Yahoo HTTP ' + response.status);
      err.status = response.status;
      throw err;
    }

    var data = await response.json();
    var result = data && data.chart && data.chart.result && data.chart.result[0];
    if (!result) return null;

    var timestamps = result.timestamp || [];
    var indicators = result.indicators && result.indicators.quote && result.indicators.quote[0];
    if (!indicators) return null;

    var opens = indicators.open || [];
    var highs = indicators.high || [];
    var lows = indicators.low || [];
    var closes = indicators.close || [];
    var volumes = indicators.volume || [];

    var candles = [];
    for (var i = 0; i < timestamps.length; i++) {
      if (closes[i] != null && opens[i] != null && highs[i] != null && lows[i] != null && volumes[i] != null) {
        candles.push({
          time: timestamps[i],
          date: toWibDate(timestamps[i]),
          open: opens[i],
          high: highs[i],
          low: lows[i],
          close: closes[i],
          volume: volumes[i]
        });
      }
    }

    return candles.length >= 20 ? candles : null;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// FRESHNESS CHECK (market hours awareness)
// ============================================================

/**
 * Determine effective TTL.
 * During IDX market hours (Mon-Fri 09:00-15:30 WIB), use the configured TTL.
 * Outside market hours, extend TTL significantly (12 hours)
 * since data won't change.
 */
function getEffectiveTtl(ttlMs, nowMs) {
  var TWELVE_HOURS = 12 * 60 * 60 * 1000;
  var wibMs = nowMs + (7 * 60 * 60 * 1000);
  var wib = new Date(wibMs);
  var day = wib.getUTCDay(); // 0=Sun, 6=Sat
  var h = wib.getUTCHours();
  var min = wib.getUTCMinutes();
  var totalMin = h * 60 + min;

  // Weekend: use long TTL
  if (day === 0 || day === 6) return TWELVE_HOURS;

  // Before market open (09:00 WIB = 540 min) or after close (15:30 WIB = 930 min)
  if (totalMin < 540 || totalMin > 930) return TWELVE_HOURS;

  // During market hours: use configured TTL
  return ttlMs;
}

/**
 * Check if cache is fresh given market-aware TTL and session boundary.
 * If cache was written before 09:00 WIB on a trading day and now is >= 09:00 WIB,
 * the cache is expired across the market open boundary to fetch live opening candles.
 */
function isCacheFresh(updatedAtMs, nowMs, ttlMs) {
  if (arguments.length === 2 && typeof nowMs === 'number' && nowMs < 86400000 * 30) {
    ttlMs = nowMs;
    nowMs = Date.now();
  }
  nowMs = Number(nowMs) || Date.now();
  updatedAtMs = parseTimeMs(updatedAtMs);
  if (!updatedAtMs) return false;
  ttlMs = ttlMs != null ? Number(ttlMs) : DEFAULT_TTL_MS;

  var effectiveTtl = Number(getEffectiveTtl(ttlMs, nowMs));
  var age = nowMs - updatedAtMs;
  if (age < 0 || age > effectiveTtl) return false;

  var wibOffset = 7 * 60 * 60 * 1000;
  var nowWib = new Date(nowMs + wibOffset);
  var nowDay = nowWib.getUTCDay(); // 0=Sun, 6=Sat
  if (nowDay >= 1 && nowDay <= 5) {
    var nowTotalMin = nowWib.getUTCHours() * 60 + nowWib.getUTCMinutes();
    // At or after market open (09:00 WIB = 540 min)
    if (nowTotalMin >= 540) {
      var updatedWib = new Date(updatedAtMs + wibOffset);
      var sameDate = nowWib.getUTCFullYear() === updatedWib.getUTCFullYear() &&
                     nowWib.getUTCMonth() === updatedWib.getUTCMonth() &&
                     nowWib.getUTCDate() === updatedWib.getUTCDate();
      var updatedTotalMin = updatedWib.getUTCHours() * 60 + updatedWib.getUTCMinutes();
      if (!sameDate || updatedTotalMin < 540) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Temuan #8: newest broker-summary trading date on disk for a ticker.
 * Lazy require keeps this module free of a load-time cycle with
 * bandarmologi-service. Returns 'YYYY-MM-DD' or null when unknown.
 */
function latestBrokerSummaryDate(ticker) {
  try {
    var svc = require('./bandarmologi-service');
    var dates = svc.listDiskDates('broker-summary', safeTicker(ticker));
    if (Array.isArray(dates) && dates.length > 0 && dates[0]) return String(dates[0]).slice(0, 10);
  } catch (_) {}
  return null;
}

/**
 * Temuan #8: newest candle date in a cached series ('YYYY-MM-DD') or null.
 */
function newestCandleDate(candles) {
  var list = Array.isArray(candles) ? candles : [];
  var best = null;
  for (var i = 0; i < list.length; i++) {
    var d = list[i] && list[i].date ? String(list[i].date).slice(0, 10) : null;
    if (d && (!best || d > best)) best = d;
  }
  return best;
}

// ============================================================
// CACHE PROVIDER — main entry point
// ============================================================

/**
 * Create a cache-backed candle provider.
 *
 * Options:
 *   cacheDir    — directory for per-ticker JSON (default: data/daytrade-ohlcv-cache)
 *   ttlMs       — freshness TTL during market hours in ms (default: 15 min)
 *   timeoutMs   — Yahoo fetch timeout per request (default: 12s)
 *   fetchFn     — override Yahoo fetch function (for testing)
 *
 * Returns object with:
 *   fetchWithCache(ticker)    — main function to use as fetchCandles override
 *   readCache(ticker)         — read raw cache
 *   writeCache(ticker, candles) — write raw cache
 *   stats                     — { cacheHit, cacheMiss, fetchSuccess, fetchFail, staleFallback }
 */
function createCacheProvider(options) {
  options = options || {};
  var cacheDir = options.cacheDir || DEFAULT_CACHE_DIR;
  var ttlMs = options.ttlMs != null ? options.ttlMs : DEFAULT_TTL_MS;
  var timeoutMs = options.timeoutMs || DEFAULT_YAHOO_TIMEOUT_MS;
  var fetchFn = options.fetchFn || fetchYahooCandles;
  // F3-007: ceiling for the upstream-failure fallback. Configurable so an
  // operator can tighten or relax it without a code change.
  var maxStaleFallbackMs = options.maxStaleFallbackMs != null
    ? Number(options.maxStaleFallbackMs)
    : DEFAULT_MAX_STALE_FALLBACK_MS;
  // Temuan #8: opt-in guard so a candle cache older than the newest broker
  // summary is not treated as fresh. Off by default (synthetic/offline candle
  // sources must not be blocked); the day-trade VPS scan turns it on.
  var syncWithBrokerSummary = options.syncWithBrokerSummary === true;

  var stats = { cacheHit: 0, cacheMiss: 0, fetchSuccess: 0, fetchFail: 0, staleFallback: 0, cacheBehindSummary: 0, staleRejected: 0 };

  /**
   * F3-007: may this cached series still be used when the upstream provider is
   * unavailable? A series older than the ceiling is abandoned data — serving it
   * would silently feed the technical-analysis pipeline prices from months ago.
   */
  function isUsableStaleFallback(cached, nowMs) {
    if (!cached.hit || cached.candles.length < 20) return false;
    if (!Number.isFinite(maxStaleFallbackMs) || maxStaleFallbackMs <= 0) return true;
    var age = nowMs - cached.updatedAtMs;
    // An unknown write time (updatedAtMs 0) is unverifiable, so it is not usable.
    if (!cached.updatedAtMs || age > maxStaleFallbackMs) return false;
    return true;
  }

  /**
   * Fetch candles for a ticker, using cache with TTL.
   * - If fresh cache exists: return cached candles (no Yahoo call).
   * - If stale/missing: fetch from Yahoo, update cache, return.
   * - If Yahoo fails but cache exists: fallback to stale cache with warning.
   * - If Yahoo fails and no cache: return null.
   */
  async function fetchWithCache(rawTicker) {
    var ticker = safeTicker(rawTicker);
    var nowMs = Date.now();
    var cached = await readCache(cacheDir, ticker, nowMs, ttlMs);

    // Fresh cache: use directly.
    //
    // Freshness is decided ONLY by isCacheFresh, which applies getEffectiveTtl
    // (the configured TTL during IDX hours, 12 hours outside them). The previous
    // code also required `!cached.stale`, and readCache computes that against the
    // RAW ttlMs with no knowledge of market hours — a strictly stricter gate, so
    // the 12-hour window could never widen anything. Outside market hours every
    // scan therefore re-fetched from Yahoo after 15 minutes, for data that cannot
    // have changed because the exchange is shut.
    //
    // Temuan #8: TTL freshness alone let a candle series whose newest bar is
    // BEHIND the newest broker-summary trading day still count as fresh, so a
    // scan could compute on yesterday's prices while today's summary was already
    // on disk. Opt-in via `syncWithBrokerSummary` so synthetic/offline candle
    // sources (tests, arbitrary tickers, backfill) keep the old behaviour; the
    // day-trade VPS scan opts in. Only blocks on positive evidence: a broker
    // summary for THIS ticker and a strictly newer summary date.
    var behindSummary = false;
    if (syncWithBrokerSummary) {
      var cachedNewest = newestCandleDate(cached.candles);
      var summaryNewest = latestBrokerSummaryDate(ticker);
      behindSummary = Boolean(cachedNewest && summaryNewest && cachedNewest < summaryNewest);
      if (behindSummary && cached.hit) stats.cacheBehindSummary++;
    }
    if (cached.hit && cached.candles.length >= 20 &&
        isCacheFresh(cached.updatedAtMs, nowMs, ttlMs) && !behindSummary) {
      stats.cacheHit++;
      return cached.candles;
    }

    // Stale or missing: try Yahoo fetch
    try {
      var fresh = await fetchFn(ticker, { timeoutMs: timeoutMs });
      if (fresh && fresh.length >= 20) {
        var normalized = normalizeCandles(fresh);
        await writeCache(cacheDir, ticker, normalized, 'yahoo');
        stats.fetchSuccess++;
        if (!cached.hit) stats.cacheMiss++;
        return normalized.slice(-90);
      }
      // Upstream returned insufficient data: fallback to cache if it is still
      // inside the usable age window.
      if (isUsableStaleFallback(cached, nowMs)) {
        stats.staleFallback++;
        return cached.candles;
      }
      if (cached.hit && cached.candles.length >= 20) stats.staleRejected++;
      stats.fetchFail++;
      return null;
    } catch (e) {
      // Upstream failed: fallback to cache if it is still inside the window.
      if (isUsableStaleFallback(cached, nowMs)) {
        stats.staleFallback++;
        return cached.candles;
      }
      if (cached.hit && cached.candles.length >= 20) stats.staleRejected++;
      stats.fetchFail++;
      return null;
    }
  }

  return {
    fetchWithCache: fetchWithCache,
    readCache: function(ticker) { return readCache(cacheDir, safeTicker(ticker), Date.now(), ttlMs); },
    writeCache: function(ticker, candles) { return writeCache(cacheDir, safeTicker(ticker), candles, 'manual'); },
    getStats: function() { return Object.assign({}, stats); },
    stats: stats,
    // Exposed for testing
    _cacheDir: cacheDir,
    _ttlMs: ttlMs
  };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  createCacheProvider: createCacheProvider,
  readCache: readCache,
  writeCache: writeCache,
  fetchYahooCandles: fetchYahooCandles,
  normalizeCandles: normalizeCandles,
  isCacheFresh: isCacheFresh,
  getEffectiveTtl: getEffectiveTtl,
  writeFileAtomic: writeFileAtomic,
  DEFAULT_TTL_MS: DEFAULT_TTL_MS,
  DEFAULT_CACHE_DIR: DEFAULT_CACHE_DIR,
  DEFAULT_MAX_STALE_FALLBACK_MS: DEFAULT_MAX_STALE_FALLBACK_MS
};
