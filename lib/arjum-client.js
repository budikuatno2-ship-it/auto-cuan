'use strict';

/**
 * Client for stock.arjum.com API
 * Provides:
 * - Broker Summary (/api/broker-summary/{code})
 * - Broker Accumulation (/api/broker-accumulation/{code})
 * - Insider Transactions (/api/insiders/{code})
 */

const fs = require('fs');
const path = require('path');
const ARJUM_BASE_URL = 'https://stock.arjum.com';
const DEFAULT_TIMEOUT_MS = 12000;
const quotaTracker = require('./arjum-quota-tracker');
const broksumFlow = require('./broksum-flow');

// B2 (2026-10-23): ARJUM_DAILY_LIMIT is the SINGLE SOURCE OF TRUTH for the daily
// quota. Before this, `getConfiguredDailyQuota()` preferred a value "learned"
// from an `x-ratelimit-limit` response header over the configured limit. That
// header is the vendor's own per-key ceiling and can be LOWER than the plan the
// owner actually bought (the owner's dashboard shows 18,080 while a header value
// of 12,060 was being used), so the circuit breaker tripped early and J1 was
// starved. The header may now only LOWER the effective limit (a genuine vendor
// throttle), never raise it above the configured plan, and never replace it.
const DEFAULT_DAILY_LIMIT = 18080;
const DEFAULT_DAILY_QUOTA = DEFAULT_DAILY_LIMIT;
const FALLBACK_DAILY_QUOTA = DEFAULT_DAILY_LIMIT;
let lastObservedVendorLimit = null;

// Global Circuit Breaker State
let arjumCircuitBreakerTripped = false;
let lastCircuitBreakerDataDir = process.env.ARJUM_DATA_DIR;
let circuitBreakerTripDate = null;

// Throttling Serial Queue
let requestQueue = Promise.resolve();
let lastRequestEndTime = 0;

function getArjumApiKey() {
  return String(process.env.ARJUM_API_KEY || '').trim();
}

// The configured plan limit, ignoring anything learned from response headers.
function getConfiguredPlanLimit() {
  const fromEnv = parseInt(process.env.ARJUM_DAILY_LIMIT || process.env.ARJUM_DAILY_QUOTA, 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_DAILY_LIMIT;
}

// The effective limit every consumer (circuit breaker, backfill budget guard,
// J1) must use. ARJUM_DAILY_LIMIT wins; a vendor header can only lower it.
function getConfiguredDailyQuota() {
  const plan = getConfiguredPlanLimit();
  if (lastObservedVendorLimit && Number.isFinite(lastObservedVendorLimit) && lastObservedVendorLimit > 0) {
    return Math.min(plan, lastObservedVendorLimit);
  }
  return plan;
}

// ─────────────────────────────────────────────────────────────────────────
// Dynamic quota reserve helpers — read from .env, NOT hardcoded.
// Owner can change ARJUM_WEEKDAY_RESERVE / ARJUM_WEEKEND_RESERVE at any
// time without touching a single line of code.
// ─────────────────────────────────────────────────────────────────────────
function getArjumWeekdayReserve() {
  if (process.env.ARJUM_WEEKDAY_RESERVE !== undefined) {
    const v = parseInt(process.env.ARJUM_WEEKDAY_RESERVE, 10);
    if (Number.isFinite(v) && v >= 0) return v;
  }
  return 5000; // default J1 weekday floor
}

function getArjumWeekendReserve() {
  if (process.env.ARJUM_WEEKEND_RESERVE !== undefined) {
    const v = parseInt(process.env.ARJUM_WEEKEND_RESERVE, 10);
    if (Number.isFinite(v) && v >= 0) return v;
  }
  return 0; // default: 100% quota usable on Sat/Sun
}

function getArjumPostEodReserve() {
  if (process.env.ARJUM_POST_EOD_RESERVE !== undefined) {
    const v = parseInt(process.env.ARJUM_POST_EOD_RESERVE, 10);
    if (Number.isFinite(v) && v >= 0) return v;
  }
  return 0; // default: once EOD done, leftover is free
}

function __setObservedVendorLimit(limit) {
  lastObservedVendorLimit = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : null;
}

function hasArjumApiKey() {
  return getArjumApiKey().length > 0;
}

function cleanTicker(raw) {
  return String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function getThrottleDelayMs() {
  if (process.env.ARJUM_THROTTLE_DELAY_MS != null) {
    const val = parseInt(process.env.ARJUM_THROTTLE_DELAY_MS, 10);
    if (!Number.isNaN(val)) return Math.max(0, val);
  }
  // Fast execution in test runner to keep CI/test suites responsive
  if (process.env.NODE_ENV === 'test' || typeof global.it === 'function' || typeof global.test === 'function' || process.argv.some(a => a.includes('test'))) {
    return 10;
  }
  return 800; // Default: 800ms (within mandatory 600ms - 1000ms range)
}

function checkAndSyncCircuitBreaker() {
  const currentDataDir = process.env.ARJUM_DATA_DIR;
  if (currentDataDir !== lastCircuitBreakerDataDir) {
    lastCircuitBreakerDataDir = currentDataDir;
    arjumCircuitBreakerTripped = false;
    circuitBreakerTripDate = null;
    return;
  }
  const today = quotaTracker.getTodayWibKey();
  if (circuitBreakerTripDate && circuitBreakerTripDate !== today) {
    arjumCircuitBreakerTripped = false;
    circuitBreakerTripDate = null;
  }
}

// B4 (2026-10-23): when the breaker trips on quota, log the numbers it decided
// on (limit, used, remaining) so a wrong limit is visible instead of silent.
function quotaSnapshot() {
  const limit = getConfiguredDailyQuota();
  const used = quotaTracker.getUsedToday();
  return { limit, used, remaining: limit - used };
}

function isCircuitBreakerTripped() {
  checkAndSyncCircuitBreaker();
  if (arjumCircuitBreakerTripped) return true;
  const snap = quotaSnapshot();
  if (snap.used >= snap.limit) {
    arjumCircuitBreakerTripped = true;
    circuitBreakerTripDate = quotaTracker.getTodayWibKey();
    console.warn(`[CIRCUIT BREAKER] Arjum daily quota reached. Blocking outgoing calls. limit=${snap.limit} used=${snap.used} remaining=${snap.remaining}`);
    return true;
  }
  return false;
}

function resetCircuitBreaker() {
  arjumCircuitBreakerTripped = false;
  circuitBreakerTripDate = null;
}

function tripCircuitBreaker(reason) {
  arjumCircuitBreakerTripped = true;
  circuitBreakerTripDate = quotaTracker.getTodayWibKey();
  const snap = quotaSnapshot();
  console.warn(`[CIRCUIT BREAKER] Arjum daily quota reached or rate-limited. Blocking outgoing calls. limit=${snap.limit} used=${snap.used} remaining=${snap.remaining} Reason: ${reason || 'unspecified'}`);
}

function getStorageDir() {
  const configured = process.env.ARJUM_DATA_DIR;
  if (configured && fs.existsSync(configured)) return configured;
  return path.join(__dirname, '..', 'data', 'arjum-data');
}

function readLocalBrokerSummary(ticker, date, flow) {
  try {
    const baseDir = getStorageDir();
    const cleanFlow = String(flow || '').trim().toUpperCase();
    // SECURITY (CodeQL: uncontrolled data in path expression): `date` reaches
    // this function from request/CLI input, so it must never be interpolated
    // into a filesystem path verbatim. Only a strict YYYY-MM-DD key (or the
    // literal 'latest' sentinel) is allowed; anything else is a cache miss.
    const rawDate = date == null ? '' : String(date).trim();
    const safeDate = rawDate === 'latest' ? 'latest'
      : (/^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null);
    if (rawDate && safeDate == null) return null;

    // Foreign flow (flow='F')
    if (cleanFlow === 'F') {
      const fDir = path.join(baseDir, 'broker-summary-F', ticker);
      if (!fs.existsSync(fDir)) return null;
      if (safeDate && safeDate !== 'latest') {
        const fPath = path.join(fDir, `${safeDate}.json`);
        if (fs.existsSync(fPath)) {
          const content = fs.readFileSync(fPath, 'utf8');
          const parsed = JSON.parse(content);
          if (parsed && typeof parsed === 'object' && parsed.flow === 'F') return parsed;
        }
        return null;
      }
      const filesF = fs.readdirSync(fDir).filter(f => f.endsWith('.json') && f !== 'latest.json').sort().reverse();
      if (filesF.length > 0) {
        const content = fs.readFileSync(path.join(fDir, filesF[0]), 'utf8');
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === 'object' && parsed.flow === 'F') return parsed;
      }
      return null;
    }

    // Domestic flow (flow='D'): D = All - F computed dynamically
    if (cleanFlow === 'D') {
      const allData = readLocalBrokerSummary(ticker, date, 'all');
      const fData = readLocalBrokerSummary(ticker, date, 'F');
      if (allData && fData) {
        return broksumFlow.computeDomestic(allData, fData);
      }
      return null;
    }

    // Default: 'all' flow
    const targetDir = path.join(baseDir, 'broker-summary', ticker);
    if (!fs.existsSync(targetDir)) return null;

    if (safeDate && safeDate !== 'latest') {
      const filePath = path.join(targetDir, `${safeDate}.json`);
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === 'object') return parsed;
      }
      return null;
    }

    const latestPath = path.join(targetDir, 'latest.json');
    if (fs.existsSync(latestPath)) {
      const content = fs.readFileSync(latestPath, 'utf8');
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object') return parsed;
    }

    const files = fs.readdirSync(targetDir).filter(f => f.endsWith('.json') && f !== 'latest.json').sort().reverse();
    if (files.length > 0) {
      const content = fs.readFileSync(path.join(targetDir, files[0]), 'utf8');
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (_) {}
  return null;
}

function readLocalBrokerAccumulation(ticker) {
  try {
    const baseDir = getStorageDir();
    const targetDir = path.join(baseDir, 'broker-accumulation', ticker);
    if (!fs.existsSync(targetDir)) return null;

    const seriesPath = path.join(targetDir, 'series.json');
    if (fs.existsSync(seriesPath)) {
      const content = fs.readFileSync(seriesPath, 'utf8');
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object') return parsed;
    }
    const latestPath = path.join(targetDir, 'latest.json');
    if (fs.existsSync(latestPath)) {
      const content = fs.readFileSync(latestPath, 'utf8');
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (_) {}
  return null;
}

function readLocalInsiders(ticker, page = 1) {
  try {
    const baseDir = getStorageDir();
    const targetDir = path.join(baseDir, 'insiders', ticker);
    if (!fs.existsSync(targetDir)) return null;

    const pPath = path.join(targetDir, `p${page}.json`);
    if (fs.existsSync(pPath)) {
      const content = fs.readFileSync(pPath, 'utf8');
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (_) {}
  return null;
}

function getJakartaTime(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false
  });
  const parts = fmt.formatToParts(now);
  let year = '', month = '', day = '', hour = 0, minute = 0, second = 0;
  for (const p of parts) {
    if (p.type === 'year') year = p.value;
    if (p.type === 'month') month = p.value;
    if (p.type === 'day') day = p.value;
    if (p.type === 'hour') hour = parseInt(p.value, 10);
    if (p.type === 'minute') minute = parseInt(p.value, 10);
    if (p.type === 'second') second = parseInt(p.value, 10);
  }
  const dateKey = `${year}-${month}-${day}`;
  const d = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  return { dateKey, dayOfWeek: d, hour, minute, second, isWeekend: d === 0 || d === 6 };
}

function shouldEnforceMarketHours() {
  if (process.env.NODE_ENV === 'test' || typeof global.it === 'function' || typeof global.test === 'function' || process.argv.some(a => a.includes('test'))) {
    return false;
  }
  if (process.env.ARJUM_DISABLE_MARKET_GUARD === '1') {
    return false;
  }
  return true;
}

function isMarketHoursWib(now = new Date()) {
  const { isWeekend, hour } = getJakartaTime(now);
  if (isWeekend) return false;
  return hour >= 9 && hour < 16;
}

function isEodReadyWib(dateStr, now = new Date()) {
  const { dateKey, hour, minute } = getJakartaTime(now);
  if (!dateStr || dateStr < dateKey) return true;
  if (dateStr > dateKey) return false;
  return (hour > 16 || (hour === 16 && minute >= 15));
}

// Arjum has no documented "check remaining quota" endpoint (its /api/docs
// path is itself gated behind auth, and probing it live would burn paid
// quota just to explore) — so remaining-quota detection is opportunistic:
// piggyback on whatever headers a normal request already returns, at zero
// extra cost. If Arjum ever starts sending a rate-limit style header, this
// picks it up automatically; otherwise callers fall back to the manually
// configured ARJUM_DAILY_QUOTA.
const QUOTA_REMAINING_HEADERS = ['x-ratelimit-remaining', 'x-quota-remaining', 'ratelimit-remaining'];
const QUOTA_LIMIT_HEADERS = ['x-ratelimit-limit', 'x-quota-limit', 'ratelimit-limit'];
function extractQuotaHeaders(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  let remaining = null;
  let limit = null;
  for (const name of QUOTA_REMAINING_HEADERS) {
    const v = headers.get(name);
    if (v != null && v !== '' && !Number.isNaN(Number(v))) { remaining = Number(v); break; }
  }
  for (const name of QUOTA_LIMIT_HEADERS) {
    const v = headers.get(name);
    if (v != null && v !== '' && !Number.isNaN(Number(v))) { limit = Number(v); break; }
  }
  if (remaining == null && limit == null) return null;
  return { remaining, limit };
}

function enqueueRequest(fn) {
  const resultPromise = requestQueue.then(async () => {
    if (isCircuitBreakerTripped()) {
      return {
        ok: false,
        status: 429,
        success: false,
        rateLimited: true,
        fallback: true,
        error: '[CIRCUIT BREAKER] Arjum daily quota reached or rate-limited. Blocking outgoing calls.'
      };
    }

    const minDelay = getThrottleDelayMs();
    const now = Date.now();
    const timeSinceLast = now - lastRequestEndTime;
    if (timeSinceLast < minDelay && lastRequestEndTime > 0) {
      const waitMs = minDelay - timeSinceLast;
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }

    try {
      return await fn();
    } finally {
      lastRequestEndTime = Date.now();
    }
  });

  requestQueue = resultPromise.catch(() => {});
  return resultPromise;
}

/**
 * Common fetch helper with timeout, auth header, circuit breaker, and serial queue throttling
 */
async function fetchArjum(endpointPath, options = {}) {
  // Layer paling depan: tolak instan jika circuit breaker aktif
  if (isCircuitBreakerTripped()) {
    return {
      ok: false,
      status: 429,
      success: false,
      rateLimited: true,
      fallback: true,
      error: '[CIRCUIT BREAKER] Arjum daily quota reached or rate-limited. Blocking outgoing calls.'
    };
  }

  return enqueueRequest(async () => {
    if (isCircuitBreakerTripped()) {
      return {
        ok: false,
        status: 429,
        success: false,
        rateLimited: true,
        fallback: true,
        error: '[CIRCUIT BREAKER] Arjum daily quota reached or rate-limited. Blocking outgoing calls.'
      };
    }

    const apiKey = getArjumApiKey();
    const url = `${ARJUM_BASE_URL}${endpointPath}`;
    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    const headers = {
      'Accept': 'application/json',
      'User-Agent': 'AutoCuan-Bandarmologi/1.0'
    };

    if (apiKey) {
      headers['X-API-Key'] = apiKey;
    }

    try {
      const res = await fetch(url, {
        method: options.method || 'GET',
        headers,
        signal: controller ? controller.signal : undefined
      });

      quotaTracker.recordUsage(1);
      const quota = extractQuotaHeaders(res.headers);
      if (quota && quota.limit && Number.isFinite(quota.limit) && quota.limit > 0) {
        lastObservedVendorLimit = quota.limit;
      }

      if (!res.ok) {
        let errDetail = res.statusText;
        try {
          const body = await res.json();
          if (body && (body.detail || body.error || body.message)) {
            errDetail = body.detail || body.error || body.message;
          }
        } catch (_) {}

        const classified = classifyFailure({ status: res.status, error: errDetail });
        if (classified.reason === 'quota_exceeded' || res.status === 429) {
          tripCircuitBreaker(errDetail || 'HTTP 429');
        }

        return {
          ok: false,
          status: res.status,
          error: errDetail || `HTTP ${res.status}`,
          quota,
          rateLimited: res.status === 429 || classified.reason === 'quota_exceeded'
        };
      }

      const data = await res.json();
      return {
        ok: true,
        status: res.status,
        data,
        quota
      };
    } catch (err) {
      const isAbort = err && (err.name === 'AbortError' || String(err).includes('aborted'));
      return {
        ok: false,
        status: isAbort ? 504 : 500,
        error: isAbort ? 'Request timeout ke stock.arjum.com' : (err.message || String(err))
      };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  });
}

const DEFAULT_BROKER_LIMIT = 100;
const DEFAULT_LEVEL_LIMIT = 100;

/**
 * 1. Broker Summary: breakdown per broker harian
 * @param {string} code - Ticker saham (e.g. 'BBCA')
 * @param {string} [date] - Tanggal bursa YYYY-MM-DD
 * @param {string} [flow] - 'F' (foreign) or 'D' (domestic); anything else sends NO flow param
 * @param {{brokerLimit?: number, levelLimit?: number}} [limits]
 * @param {object} [options] - { fresh?: boolean, forceLive?: boolean, bypassMarketGuard?: boolean }
 */
async function fetchBrokerSummary(code, date, flow, limits, options = {}) {
  const ticker = cleanTicker(code);
  if (!ticker) return { ok: false, error: 'Ticker tidak valid' };

  const cleanFlow = String(flow || '').trim().toUpperCase();
  const isFilteredFlow = cleanFlow === 'F' || cleanFlow === 'D';
  const forceFresh = Boolean(options && (options.fresh || options.forceLive));
  const noFallback = Boolean(options && options.noFallback);

  // CACHE-FIRST: Prioritaskan pembacaan cache disk lokal jika tidak memaksa live/fresh
  if (!forceFresh && !isFilteredFlow && !noFallback) {
    const cached = readLocalBrokerSummary(ticker, date);
    if (cached) {
      return {
        ok: true,
        status: 200,
        data: cached,
        from_cache: true,
        quota: null
      };
    }
  }

  // Graceful fallback jika circuit breaker aktif
  if (isCircuitBreakerTripped()) {
    if (noFallback || forceFresh) {
      return {
        ok: false,
        status: 429,
        success: false,
        rateLimited: true,
        fallback: false,
        error: '[CIRCUIT BREAKER] Arjum daily quota reached or rate-limited. Blocking outgoing calls.'
      };
    }
    const fallbackCached = readLocalBrokerSummary(ticker, 'latest', flow) || readLocalBrokerSummary(ticker, date, flow);
    if (fallbackCached) {
      // Pastikan integritas flow: permintaan flow=F TIDAK BOLEH mengembalikan flow=all
      if (isFilteredFlow && fallbackCached.flow !== cleanFlow) {
        return {
          ok: false,
          status: 429,
          success: false,
          rateLimited: true,
          fallback: false,
          error: `[CIRCUIT BREAKER] No local cache matching flow=${cleanFlow}.`
        };
      }
      return { ok: true, status: 200, data: fallbackCached, fallback: true, rateLimited: true };
    }
    return {
      ok: false,
      status: 429,
      success: false,
      rateLimited: true,
      fallback: true,
      error: '[CIRCUIT BREAKER] Arjum daily quota reached or rate-limited. Blocking outgoing calls.'
    };
  }

  // Guard Jam Operasional BEI untuk live intraday
  const todayKey = quotaTracker.getTodayWibKey();
  const isToday = !date || date === todayKey || date === 'latest';

  if (isToday && shouldEnforceMarketHours() && !(options && options.bypassMarketGuard)) {
    if (noFallback || forceFresh) {
      return {
        ok: false,
        status: 400,
        success: false,
        error: 'Di luar jam operasional bursa BEI.'
      };
    }
    const timeInfo = getJakartaTime();
    if (timeInfo.isWeekend) {
      const cached = readLocalBrokerSummary(ticker, 'latest', flow) || readLocalBrokerSummary(ticker, date, flow);
      if (cached && (!isFilteredFlow || cached.flow === cleanFlow)) return { ok: true, status: 200, data: cached, from_cache: true, fallback: true };
      return {
        ok: false,
        status: 400,
        success: false,
        error: 'Bursa BEI tutup di akhir pekan. Permintaan live intraday ditolak.'
      };
    }
    if (timeInfo.hour < 9) {
      const cached = readLocalBrokerSummary(ticker, 'latest', flow) || readLocalBrokerSummary(ticker, date, flow);
      if (cached && (!isFilteredFlow || cached.flow === cleanFlow)) return { ok: true, status: 200, data: cached, from_cache: true, fallback: true };
      return {
        ok: false,
        status: 400,
        success: false,
        error: 'Di luar jam operasional bursa BEI (09:00 - 16:00 WIB). Sesi perdagangan belum dimulai.'
      };
    }
    if (timeInfo.hour === 16 && timeInfo.minute < 15) {
      const cached = readLocalBrokerSummary(ticker, 'latest', flow) || readLocalBrokerSummary(ticker, date, flow);
      if (cached && (!isFilteredFlow || cached.flow === cleanFlow)) return { ok: true, status: 200, data: cached, from_cache: true, fallback: true };
      return {
        ok: false,
        status: 400,
        success: false,
        error: 'Sesi bursa BEI telah ditutup (16:00 WIB). Menunggu rilis data broker summary resmi pasca 16:15 WIB.'
      };
    }
  }

  let endpoint = `/api/broker-summary/${ticker}`;
  const params = [];
  if (date) {
    const enc = encodeURIComponent(date);
    params.push(`start_date=${enc}`, `end_date=${enc}`, `date=${enc}`);
  }
  if (isFilteredFlow) {
    params.push(`flow=${cleanFlow}`);
  }
  const useAllData = Boolean((options && options.allData) || (limits && limits.allData));
  if (useAllData) {
    params.push('all_data=true');
  } else {
    const brokerLimit = (limits && Number(limits.brokerLimit) > 0) ? Number(limits.brokerLimit) : DEFAULT_BROKER_LIMIT;
    const levelLimit = (limits && Number(limits.levelLimit) > 0) ? Number(limits.levelLimit) : DEFAULT_LEVEL_LIMIT;
    params.push(`broker_limit=${brokerLimit}`, `level_limit=${levelLimit}`);
  }
  if (params.length > 0) endpoint += `?${params.join('&')}`;

  const res = await fetchArjum(endpoint, options);
  if (!res.ok && res.rateLimited && !noFallback && !forceFresh) {
    const fallbackCached = readLocalBrokerSummary(ticker, 'latest', flow) || readLocalBrokerSummary(ticker, date, flow);
    if (fallbackCached && (!isFilteredFlow || fallbackCached.flow === cleanFlow)) {
      return { ok: true, status: 200, data: fallbackCached, fallback: true, rateLimited: true };
    }
  }
  return res;
}

/**
 * 2. Broker Accumulation: tren akumulasi vs distribusi historis
 * @param {string} code - Ticker saham
 * @param {object} [options]
 */
async function fetchBrokerAccumulation(code, options = {}) {
  const ticker = cleanTicker(code);
  if (!ticker) return { ok: false, error: 'Ticker tidak valid' };

  const forceFresh = Boolean(options && (options.fresh || options.forceLive));
  if (!forceFresh) {
    const cached = readLocalBrokerAccumulation(ticker);
    if (cached) {
      return {
        ok: true,
        status: 200,
        data: cached,
        from_cache: true,
        quota: null
      };
    }
  }

  if (isCircuitBreakerTripped()) {
    const fallbackCached = readLocalBrokerAccumulation(ticker);
    if (fallbackCached) {
      return { ok: true, status: 200, data: fallbackCached, fallback: true, rateLimited: true };
    }
    return {
      ok: false,
      status: 429,
      success: false,
      rateLimited: true,
      fallback: true,
      error: '[CIRCUIT BREAKER] Arjum daily quota reached or rate-limited. Blocking outgoing calls.'
    };
  }

  const res = await fetchArjum(`/api/broker-accumulation/${ticker}`, options);
  if (!res.ok && res.rateLimited) {
    const fallbackCached = readLocalBrokerAccumulation(ticker);
    if (fallbackCached) {
      return { ok: true, status: 200, data: fallbackCached, fallback: true, rateLimited: true };
    }
  }
  return res;
}

/**
 * 3. Insider Transactions: transaksi orang dalam
 * @param {string} code - Ticker saham
 * @param {number} [page=1]
 * @param {number} [limit=15] - Max 15 per page
 * @param {object} [options]
 */
async function fetchInsiders(code, page = 1, limit = 15, options = {}) {
  const ticker = cleanTicker(code);
  if (!ticker) return { ok: false, error: 'Ticker tidak valid' };

  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(15, Math.max(1, parseInt(limit, 10) || 15));

  const forceFresh = Boolean(options && (options.fresh || options.forceLive));
  if (!forceFresh) {
    const cached = readLocalInsiders(ticker, p);
    if (cached) {
      return {
        ok: true,
        status: 200,
        data: cached,
        from_cache: true,
        quota: null
      };
    }
  }

  if (isCircuitBreakerTripped()) {
    const fallbackCached = readLocalInsiders(ticker, p);
    if (fallbackCached) {
      return { ok: true, status: 200, data: fallbackCached, fallback: true, rateLimited: true };
    }
    return {
      ok: false,
      status: 429,
      success: false,
      rateLimited: true,
      fallback: true,
      error: '[CIRCUIT BREAKER] Arjum daily quota reached or rate-limited. Blocking outgoing calls.'
    };
  }

  const res = await fetchArjum(`/api/insiders/${ticker}?page=${p}&limit=${l}`, options);
  if (!res.ok && res.rateLimited) {
    const fallbackCached = readLocalInsiders(ticker, p);
    if (fallbackCached) {
      return { ok: true, status: 200, data: fallbackCached, fallback: true, rateLimited: true };
    }
  }
  return res;
}

/**
 * Classifies a failed fetchArjum() result ({ ok:false, status, error }) so
 * callers (the UI's demo-fallback badge, the backfill worker's stop
 * condition) can react to "quota exceeded" differently from a generic API
 * error or an unrelated network failure, instead of lumping every failure
 * into one silent fallback.
 * @param {{ok?: boolean, status?: number, error?: string}} res
 * @returns {{reason: 'quota_exceeded'|'api_error'|'unknown', detail: string}}
 */
function classifyFailure(res) {
  if (!res) return { reason: 'unknown', detail: '' };
  const status = res.status;
  const message = String(res.error || '').toLowerCase();
  const looksLikeQuota = status === 429 ||
    /quota|rate.?limit|too many requests|limit reached|quota exceeded/i.test(message);
  if (looksLikeQuota) {
    return { reason: 'quota_exceeded', detail: res.error || 'HTTP 429' };
  }
  if (status || res.error) {
    return { reason: 'api_error', detail: res.error || `HTTP ${status}` };
  }
  return { reason: 'unknown', detail: '' };
}

module.exports = {
  ARJUM_BASE_URL,
  getArjumApiKey,
  hasArjumApiKey,
  getConfiguredDailyQuota,
  getConfiguredPlanLimit,
  quotaSnapshot,
  cleanTicker,
  fetchArjum,
  fetchBrokerSummary,
  fetchBrokerAccumulation,
  fetchInsiders,
  classifyFailure,
  extractQuotaHeaders,
  DEFAULT_BROKER_LIMIT,
  DEFAULT_LEVEL_LIMIT,
  getUsedQuotaToday: quotaTracker.getUsedToday,
  getRemainingQuotaToday: (configuredTotal) => quotaTracker.getRemainingToday(
    configuredTotal != null ? configuredTotal : getConfiguredDailyQuota()
  ),
  isCircuitBreakerTripped,
  resetCircuitBreaker,
  tripCircuitBreaker,
  getJakartaTime,
  isMarketHoursWib,
  isEodReadyWib,
  readLocalBrokerSummary,
  readLocalBrokerAccumulation,
  readLocalInsiders,
  __setObservedVendorLimit,
  getArjumWeekdayReserve,
  getArjumWeekendReserve,
  getArjumPostEodReserve
};
