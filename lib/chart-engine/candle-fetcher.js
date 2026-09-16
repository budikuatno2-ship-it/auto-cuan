'use strict';

/**
 * Chart Engine — Candle Fetcher (Arjum history endpoint)
 *
 * Endpoint: https://stock.arjum.com/api/history/{code}?limit=120&frame=daily
 * Auth: X-API-Key (ARJUM_API_KEY)
 * Timeout: 20s. Idempotent disk cache + simple daily quota limiter.
 */

const fs = require('fs');
const path = require('path');

const ARJUM_BASE = 'https://stock.arjum.com';
const DEFAULT_TIMEOUT_MS = 20000;
const CACHE_DIR = process.env.CANDLE_CACHE_DIR || path.join(process.cwd(), 'data', 'daily-candles');
const QUOTA_FILE = process.env.CANDLE_QUOTA_FILE || path.join(process.cwd(), 'data', 'candle-quota.json');

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
  return path.join(CACHE_DIR, cleanTicker(ticker) + '.json');
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
  const url = `${ARJUM_BASE}/api/history/${cleanTicker(ticker)}?limit=${limit || 120}&frame=daily`;
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

function normalizePayload(ticker, raw, limit) {
  // Arjum /api/history/{code} returns { stock_code, frame, rows: [...] }.
  // Older/inner shapes may use data/candles/history; a bare array is accepted too.
  const arr = Array.isArray(raw) ? raw : (raw && (raw.rows || raw.data || raw.candles || raw.history));
  const candles = (Array.isArray(arr) ? arr : []).map(function (c) {
    return {
      date: c.date || c.t || c.time || null,
      open: Number(c.open || c.o),
      high: Number(c.high || c.h),
      low: Number(c.low || c.l),
      close: Number(c.close || c.c),
      volume: Number(c.volume || c.v || 0)
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

module.exports = {
  fetchDailyCandles,
  getUsedQuotaToday,
  getConfiguredDailyQuota,
  cleanTicker,
  readCache,
  writeCache
};
