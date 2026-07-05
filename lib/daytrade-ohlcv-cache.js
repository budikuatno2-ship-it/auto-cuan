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

// ============================================================
// HELPERS
// ============================================================

function safeTicker(ticker) {
  return String(ticker || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
}

function tickerCachePath(cacheDir, ticker) {
  return path.join(cacheDir, safeTicker(ticker) + '.json');
}

function normalizeCandle(c) {
  if (!c) return null;
  var time = Number(c.time);
  var open = Number(c.open);
  var high = Number(c.high);
  var low = Number(c.low);
  var close = Number(c.close);
  var volume = Number(c.volume);
  if (!Number.isFinite(time) || !Number.isFinite(open) || !Number.isFinite(high) ||
      !Number.isFinite(low) || !Number.isFinite(close) || !Number.isFinite(volume)) return null;
  return {
    time: time,
    date: c.date || new Date(time * 1000).toISOString().slice(0, 10),
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

/**
 * Read cached candles for a ticker.
 * Returns { hit, stale, candles, updatedAtMs, meta }
 */
async function readCache(cacheDir, ticker, nowMs, ttlMs) {
  var filePath = tickerCachePath(cacheDir, ticker);
  try {
    var raw = await fsp.readFile(filePath, 'utf8');
    var parsed = JSON.parse(raw);
    var candles = normalizeCandles(parsed.candles);
    var updatedAtMs = parsed.updated_at ? Date.parse(parsed.updated_at) : 0;
    var age = nowMs - updatedAtMs;
    var stale = !updatedAtMs || age > ttlMs;
    return { hit: true, stale: stale, candles: candles, updatedAtMs: updatedAtMs, ageMs: age, meta: parsed };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { hit: false, stale: true, candles: [], updatedAtMs: 0, ageMs: Infinity, meta: null };
    return { hit: false, stale: true, candles: [], updatedAtMs: 0, ageMs: Infinity, meta: null, error: e.message };
  }
}

/**
 * Write candles to cache file for a ticker.
 * Trims to last 90 candles.
 */
async function writeCache(cacheDir, ticker, candles, source) {
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
  await fsp.writeFile(tickerCachePath(cacheDir, ticker), JSON.stringify(payload, null, 2) + '\n');
  return payload;
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
          date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
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
  var now = new Date(nowMs);
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
 * Check if cache is fresh given market-aware TTL.
 */
function isCacheFresh(updatedAtMs, nowMs, ttlMs) {
  if (!updatedAtMs) return false;
  var effectiveTtl = getEffectiveTtl(ttlMs, nowMs);
  return (nowMs - updatedAtMs) <= effectiveTtl;
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

  var stats = { cacheHit: 0, cacheMiss: 0, fetchSuccess: 0, fetchFail: 0, staleFallback: 0 };

  /**
   * Fetch candles for a ticker, using cache with TTL.
   * - If fresh cache exists: return cached candles (no Yahoo call).
   * - If stale/missing: fetch from Yahoo, update cache, return.
   * - If Yahoo fails but cache exists: fallback to stale cache with warning.
   * - If Yahoo fails and no cache: return null.
   */
  async function fetchWithCache(ticker) {
    var nowMs = Date.now();
    var cached = await readCache(cacheDir, ticker, nowMs, ttlMs);

    // Fresh cache: use directly
    if (cached.hit && !cached.stale && cached.candles.length >= 20) {
      // Re-check with market-aware freshness
      if (isCacheFresh(cached.updatedAtMs, nowMs, ttlMs)) {
        stats.cacheHit++;
        return cached.candles;
      }
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
      // Yahoo returned insufficient data: fallback to cache if available
      if (cached.hit && cached.candles.length >= 20) {
        stats.staleFallback++;
        return cached.candles;
      }
      stats.fetchFail++;
      return null;
    } catch (e) {
      // Yahoo failed: fallback to cache if available
      if (cached.hit && cached.candles.length >= 20) {
        stats.staleFallback++;
        return cached.candles;
      }
      stats.fetchFail++;
      return null;
    }
  }

  return {
    fetchWithCache: fetchWithCache,
    readCache: function(ticker) { return readCache(cacheDir, ticker, Date.now(), ttlMs); },
    writeCache: function(ticker, candles) { return writeCache(cacheDir, ticker, candles, 'manual'); },
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
  DEFAULT_TTL_MS: DEFAULT_TTL_MS,
  DEFAULT_CACHE_DIR: DEFAULT_CACHE_DIR
};
