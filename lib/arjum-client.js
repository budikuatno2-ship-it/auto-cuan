'use strict';

/**
 * Client for stock.arjum.com API
 * Provides:
 * - Broker Summary (/api/broker-summary/{code})
 * - Broker Accumulation (/api/broker-accumulation/{code})
 * - Insider Transactions (/api/insiders/{code})
 */

const ARJUM_BASE_URL = 'https://stock.arjum.com';
const DEFAULT_TIMEOUT_MS = 12000;

// !! UPDATE THIS WHENEVER THE ARJUM PLAN CHANGES !!
// As of 2026-09-06: 16,000 req/day (1,000 free + 10,000 Basic package +
// 5,000 top-up), each bucket on its own 30-day expiry. There is no known
// API endpoint to read the real remaining quota back (see
// extractQuotaHeaders below for the opportunistic alternative) — so this
// number must be updated by hand after every purchase/renewal/expiry.
// Prefer setting ARJUM_DAILY_QUOTA in the environment over editing this
// fallback, so a quota change doesn't need a code deploy.
const FALLBACK_DAILY_QUOTA = 16000;

function getArjumApiKey() {
  return String(process.env.ARJUM_API_KEY || '').trim();
}

function getConfiguredDailyQuota() {
  const fromEnv = parseInt(process.env.ARJUM_DAILY_QUOTA, 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : FALLBACK_DAILY_QUOTA;
}

function hasArjumApiKey() {
  return getArjumApiKey().length > 0;
}

function cleanTicker(raw) {
  return String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
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

/**
 * Common fetch helper with timeout and auth header
 */
async function fetchArjum(endpointPath, options = {}) {
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
    const quota = extractQuotaHeaders(res.headers);

    if (!res.ok) {
      let errDetail = res.statusText;
      try {
        const body = await res.json();
        if (body && (body.detail || body.error || body.message)) {
          errDetail = body.detail || body.error || body.message;
        }
      } catch (_) {}

      return {
        ok: false,
        status: res.status,
        error: errDetail || `HTTP ${res.status}`,
        quota
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
}

// Arjum's broker-summary endpoint silently falls back to a much smaller
// broker/level count when broker_limit/level_limit are omitted from the
// request — always send explicit values instead of relying on that default,
// so the UI (which supports up to 10-20 buyers/sellers) actually gets that
// many broker rows back.
const DEFAULT_BROKER_LIMIT = 20;
const DEFAULT_LEVEL_LIMIT = 25;

/**
 * 1. Broker Summary: breakdown per broker harian
 * @param {string} code - Ticker saham (e.g. 'BBCA')
 * @param {string} [date] - Tanggal bursa YYYY-MM-DD
 * @param {string} [flow] - 'F' (foreign) or 'D' (domestic); anything else
 *   (including 'all'/omitted) sends NO flow param at all. "All" is therefore
 *   never computed as foreign+domestic locally — it is Arjum's own native
 *   unfiltered response for the endpoint, fetched as an independent call.
 *   Do not "fix" this into a local F+D sum: each flow-filtered call applies
 *   its own top-broker truncation (broker_limit) independently, so the top-N
 *   foreign brokers plus the top-N domestic brokers do not reconstruct the
 *   true top-N overall — summing them would be LESS accurate than trusting
 *   Arjum's own unfiltered total.
 * @param {{brokerLimit?: number, levelLimit?: number}} [limits]
 */
async function fetchBrokerSummary(code, date, flow, limits) {
  const ticker = cleanTicker(code);
  if (!ticker) return { ok: false, error: 'Ticker tidak valid' };

  let endpoint = `/api/broker-summary/${ticker}`;
  const params = [];
  if (date) {
    const enc = encodeURIComponent(date);
    params.push(`start_date=${enc}`, `end_date=${enc}`, `date=${enc}`);
  }
  const cleanFlow = String(flow || '').trim().toUpperCase();
  if (cleanFlow === 'F' || cleanFlow === 'D') {
    params.push(`flow=${cleanFlow}`);
  }
  const brokerLimit = (limits && Number(limits.brokerLimit) > 0) ? Number(limits.brokerLimit) : DEFAULT_BROKER_LIMIT;
  const levelLimit = (limits && Number(limits.levelLimit) > 0) ? Number(limits.levelLimit) : DEFAULT_LEVEL_LIMIT;
  params.push(`broker_limit=${brokerLimit}`, `level_limit=${levelLimit}`);
  if (params.length > 0) endpoint += `?${params.join('&')}`;

  return await fetchArjum(endpoint);
}

/**
 * 2. Broker Accumulation: tren akumulasi vs distribusi historis
 * @param {string} code - Ticker saham
 */
async function fetchBrokerAccumulation(code) {
  const ticker = cleanTicker(code);
  if (!ticker) return { ok: false, error: 'Ticker tidak valid' };

  return await fetchArjum(`/api/broker-accumulation/${ticker}`);
}

/**
 * 3. Insider Transactions: transaksi orang dalam
 * @param {string} code - Ticker saham
 * @param {number} [page=1]
 * @param {number} [limit=15] - Max 15 per page
 */
async function fetchInsiders(code, page = 1, limit = 15) {
  const ticker = cleanTicker(code);
  if (!ticker) return { ok: false, error: 'Ticker tidak valid' };

  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(15, Math.max(1, parseInt(limit, 10) || 15));

  return await fetchArjum(`/api/insiders/${ticker}?page=${p}&limit=${l}`);
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
    /quota|rate.?limit|too many requests/i.test(message);
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
  cleanTicker,
  fetchBrokerSummary,
  fetchBrokerAccumulation,
  fetchInsiders,
  classifyFailure,
  extractQuotaHeaders
};
