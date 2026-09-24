'use strict';

/**
 * Chart Engine — Candle Fetcher (Arjum history endpoint)
 *
 * Endpoint: https://stock.arjum.com/api/history/{code}?limit=200&frame=daily
 * Auth: X-API-Key (ARJUM_API_KEY)
 * Timeout: 20s. Idempotent disk cache + simple daily quota limiter.
 */

const fs = require('fs');
const path = require('path');

const ARJUM_BASE = 'https://stock.arjum.com';
const DEFAULT_TIMEOUT_MS = 20000;
// Resolved lazily: the VPS runner chdir()s into the repo before requiring its
// handler, and tests override CANDLE_CACHE_DIR per case.
function cacheDir() {
  return process.env.CANDLE_CACHE_DIR || path.join(process.cwd(), 'data', 'daily-candles');
}
const QUOTA_FILE = process.env.CANDLE_QUOTA_FILE || path.join(process.cwd(), 'data', 'candle-quota.json');

// Screener candle source (Yahoo daily + backfilled local cache fallback).
const SCREENER_YAHOO_TIMEOUT_MS = Number(process.env.SCREENER_YAHOO_TIMEOUT_MS) || 8000;
const SCREENER_REMOTE_FAILURE_THRESHOLD = Math.max(1, Number(process.env.SCREENER_REMOTE_FAILURE_THRESHOLD) || 3);
let consecutiveRemoteFailures = 0;

function apiKey() {
  return String(process.env.ARJUM_API_KEY || '').trim();
}

function loadEnvFile() {
  const candidates = [path.join(process.cwd(), '.env.ai-eval-once'), path.join(process.cwd(), '.env.local'), path.join(process.cwd(), '.env')];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq <= 0) continue;
        const k = t.slice(0, eq).trim();
        let v = t.slice(eq + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (!process.env[k]) process.env[k] = v;
      }
    } catch (_) {}
  }
}

function todayWibKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function readQuota() {
  try {
    const raw = fs.readFileSync(QUOTA_FILE, 'utf8');
    const obj = JSON.parse(raw);
    return obj && obj.date === todayWibKey() ? (Number(obj.used) || 0) : 0;
  } catch (_) { return 0; }
}

function writeQuota(used) {
  try {
    fs.mkdirSync(path.dirname(QUOTA_FILE), { recursive: true });
    fs.writeFileSync(QUOTA_FILE, JSON.stringify({ date: todayWibKey(), used: used }));
  } catch (_) {}
}

function getUsedQuotaToday() { return readQuota(); }
function getConfiguredDailyQuota() { return Number(process.env.ARJUM_DAILY_QUOTA || 5000); }

function cleanTicker(ticker) {
  return String(ticker || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function cachePath(ticker) {
  return path.join(cacheDir(), cleanTicker(ticker) + '.json');
}

function readCache(ticker) {
  try {
    const p = cachePath(ticker);
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    // Treat an empty-candle cache as a miss so a previously-failed fetch is retried.
    if (!data || !Array.isArray(data.candles) || data.candles.length === 0) return null;
    return data;
  } catch (_) { return null; }
}

function writeCache(ticker, payload) {
  try {
    fs.mkdirSync(path.dirname(cachePath(ticker)), { recursive: true });
    fs.writeFileSync(cachePath(ticker), JSON.stringify(payload, null, 2));
  } catch (_) {}
}

async function fetchRemote(ticker, limit) {
  const key = apiKey();
  const url = `${ARJUM_BASE}/api/history/${cleanTicker(ticker)}?limit=${limit || 200}&frame=daily`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'X-API-Key': key, 'Accept': 'application/json' }
    });
    if (!res.ok) {
      return { ok: false, status: res.status, rateLimited: res.status === 429 };
    }
    const body = await res.json();
    return { ok: true, status: 200, data: body };
  } catch (e) {
    return { ok: false, status: 0, error: String(e && e.name === 'AbortError' ? 'timeout' : (e && e.message || e)) };
  } finally {
    clearTimeout(timer);
  }
}

function toFeedNumber(raw) {
  if (raw == null || raw === '') return NaN;
  if (typeof raw === 'number') return raw;
  var str = String(raw).trim();
  // Indonesian locale: "1.234,56" -> "1234.56"; "1,234.56" -> "1234.56"; "1,234" (thousand) -> "1234"
  // Heuristic: if both '.' and ',' present, comma is decimal when it appears after last dot.
  var hasDot = str.indexOf('.') !== -1;
  var hasComma = str.indexOf(',') !== -1;
  if (hasDot && hasComma) {
    var lastDot = str.lastIndexOf('.');
    var lastComma = str.lastIndexOf(',');
    if (lastComma > lastDot) {
      str = str.replace(/\./g, '').replace(',', '.');
    } else {
      str = str.replace(/,/g, '');
    }
  } else if (hasComma) {
    var parts = str.split(',');
    if (parts.length === 2 && parts[1].length <= 2) {
      str = str.replace(',', '.');
    } else {
      str = str.replace(/,/g, '');
    }
  }
  str = str.replace(/\s+/g, '');
  var n = Number(str);
  return n;
}

function normalizePayload(ticker, raw, limit) {
  // Arjum /api/history/{code} returns { stock_code, frame, rows: [...] }.
  // Older/inner shapes may use data/candles/history; a bare array is accepted too.
  const arr = Array.isArray(raw) ? raw : (raw && (raw.rows || raw.data || raw.candles || raw.history));
  const candles = (Array.isArray(arr) ? arr : []).map(function (c) {
    return {
      date: c.date || c.t || c.time || null,
      open: toFeedNumber(c.open != null ? c.open : c.o),
      high: toFeedNumber(c.high != null ? c.high : c.h),
      low: toFeedNumber(c.low != null ? c.low : c.l),
      close: toFeedNumber(c.close != null ? c.close : c.c),
      volume: (function(v){ var n=toFeedNumber(v); return Number.isFinite(n) ? n : 0; })(c.volume != null ? c.volume : (c.v != null ? c.v : 0))
    };
  }).filter(function (c) {
    return Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close);
  });
  // Arjum returns newest-first; every consumer in this repo expects oldest-first.
  candles.sort(function (a, b) { return String(a.date || '').localeCompare(String(b.date || '')); });
  return { ticker: cleanTicker(ticker), source: 'arjum', range: (limit || 200) + 'd', interval: 'daily', candles: candles };
}

/**
 * Fetch daily candles for one ticker (idempotent cache-first).
 * @param {string} ticker
 * @param {object} [opts] { limit, force, skipCache }
 * @returns {Promise<{ok:boolean, data:object|null, from_cache:boolean, rateLimited:boolean, status:number, error?:string}>}
 */
async function fetchDailyCandles(ticker, opts) {
  loadEnvFile();
  opts = opts || {};
  // Arjum rejects limit < 20 with HTTP 422 (ge=20). Clamp to a safe floor.
  // Default is 200 so the history reaches January 2026 (>=170 candles).
  const limit = Math.max(20, Number(opts.limit) || 200);
  // A cache is only usable when it holds a full history; anything shorter than
  // MIN_CANDLES (170) is treated as a miss so the fetch is retried.
  const MIN_CANDLES = Number(process.env.CANDLE_MIN_CANDLES) || 170;
  if (!opts.skipCache && !opts.force) {
    const cached = readCache(ticker);
    if (cached && cached.candles.length >= MIN_CANDLES) {
      return { ok: true, data: cached, from_cache: true, rateLimited: false, status: 200 };
    }
  }
  if (!apiKey()) return { ok: false, data: null, from_cache: false, rateLimited: false, status: 401, error: 'missing_api_key' };

  const used = getUsedQuotaToday();
  const quota = getConfiguredDailyQuota();
  if (used >= quota) return { ok: false, data: null, from_cache: false, rateLimited: true, status: 429, error: 'quota_exhausted' };

  const remote = await fetchRemote(ticker, limit);
  if (!remote.ok) return { ok: false, data: null, from_cache: false, rateLimited: remote.rateLimited, status: remote.status, error: remote.error };

  writeQuota(used + 1);
  const payload = normalizePayload(ticker, remote.data, limit);
  writeCache(ticker, payload);
  return { ok: true, data: payload, from_cache: false, rateLimited: false, status: 200 };
}

/**
 * Normalize one cached daily-candle file into the shape the screeners expect:
 * { time: unix seconds, date, open, high, low, close, volume }.
 * Returns null when the cache is missing, malformed, or shorter than `minCandles`.
 */
function readScreenerCandles(ticker, minCandles) {
  const cached = readCache(ticker);
  if (!cached || !Array.isArray(cached.candles)) return null;
  const floor = Math.max(1, Number(minCandles) || 20);
  const candles = cached.candles.map(function (row) {
    const dateStr = String((row && row.date) || '').slice(0, 10);
    const parsed = Date.parse(dateStr + 'T00:00:00Z');
    const open = Number(row && row.open), high = Number(row && row.high);
    const low = Number(row && row.low), close = Number(row && row.close), volume = Number(row && row.volume);
    if (!Number.isFinite(parsed) || !Number.isFinite(open) || !Number.isFinite(high) ||
        !Number.isFinite(low) || !Number.isFinite(close) || !Number.isFinite(volume)) return null;
    return { time: Math.floor(parsed / 1000), date: dateStr, open: open, high: high, low: low, close: close, volume: volume };
  }).filter(Boolean).sort(function (a, b) { return a.time - b.time; });
  return candles.length >= floor ? candles : null;
}

function noteScreenerRemoteResult(ok) {
  consecutiveRemoteFailures = ok ? 0 : consecutiveRemoteFailures + 1;
}
function screenerRemoteCircuitOpen() {
  return consecutiveRemoteFailures >= SCREENER_REMOTE_FAILURE_THRESHOLD;
}
function resetScreenerCandleCircuit() {
  consecutiveRemoteFailures = 0;
}
function getScreenerRemoteFailureCount() {
  return consecutiveRemoteFailures;
}

/**
 * Yahoo daily OHLCV with a hard abort deadline. The screener paths used a bare
 * fetch() here, so one unresponsive Yahoo socket hung the whole batch and left
 * daytrade_screener_meta.status stuck at 'scanning'.
 */
async function fetchYahooScreenerCandles(ticker, opts) {
  opts = opts || {};
  const symbol = cleanTicker(ticker) + '.JK';
  const range = String(opts.range || '90d');
  const timeoutMs = Math.max(500, Number(opts.timeoutMs) || SCREENER_YAHOO_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  try {
    const res = await fetch('https://query2.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) +
      '?range=' + encodeURIComponent(range) + '&interval=1d&includePrePost=false', {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AutoCuan/1.0)' }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data && data.chart && data.chart.result && data.chart.result[0];
    const quote = result && result.indicators && result.indicators.quote && result.indicators.quote[0];
    if (!result || !quote) return null;
    const timestamps = result.timestamp || [];
    const opens = quote.open || [], highs = quote.high || [], lows = quote.low || [];
    const closes = quote.close || [], volumes = quote.volume || [];
    const candles = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] == null || opens[i] == null || highs[i] == null || lows[i] == null || volumes[i] == null) continue;
      candles.push({
        time: timestamps[i],
        date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
        open: opens[i], high: highs[i], low: lows[i], close: closes[i], volume: volumes[i]
      });
    }
    return candles.length >= 20 ? candles : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Screener candle source: Yahoo first (keeps the live intraday bar), the
 * backfilled data/daily-candles cache second, and a circuit breaker so a
 * dead/rate-limited Yahoo cannot make every remaining ticker wait for the
 * timeout (772 Day Trade tickers x 8s would exceed the batch wrapper).
 */
async function fetchScreenerCandles(ticker, opts) {
  opts = opts || {};
  const minCandles = Math.max(1, Number(opts.minCandles) || 20);
  const cached = readScreenerCandles(ticker, minCandles);
  if (cached && screenerRemoteCircuitOpen()) return cached;
  const remote = await fetchYahooScreenerCandles(ticker, opts);
  noteScreenerRemoteResult(!!remote);
  if (remote && remote.length >= minCandles) return remote;
  return cached;
}

module.exports = {
  toFeedNumber,
  normalizePayload,
  fetchDailyCandles,
  getUsedQuotaToday,
  getConfiguredDailyQuota,
  cleanTicker,
  readCache,
  writeCache,
  readScreenerCandles,
  fetchYahooScreenerCandles,
  fetchScreenerCandles,
  noteScreenerRemoteResult,
  resetScreenerCandleCircuit,
  screenerRemoteCircuitOpen,
  getScreenerRemoteFailureCount,
  SCREENER_YAHOO_TIMEOUT_MS,
  SCREENER_REMOTE_FAILURE_THRESHOLD
};
