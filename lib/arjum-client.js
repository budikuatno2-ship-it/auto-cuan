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

function getArjumApiKey() {
  return String(process.env.ARJUM_API_KEY || '').trim();
}

function hasArjumApiKey() {
  return getArjumApiKey().length > 0;
}

function cleanTicker(raw) {
  return String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
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
        error: errDetail || `HTTP ${res.status}`
      };
    }

    const data = await res.json();
    return {
      ok: true,
      status: res.status,
      data
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

/**
 * 1. Broker Summary: breakdown per broker harian
 * @param {string} code - Ticker saham (e.g. 'BBCA')
 * @param {string} [date] - Tanggal bursa YYYY-MM-DD
 */
async function fetchBrokerSummary(code, date, flow) {
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

module.exports = {
  ARJUM_BASE_URL,
  getArjumApiKey,
  hasArjumApiKey,
  cleanTicker,
  fetchBrokerSummary,
  fetchBrokerAccumulation,
  fetchInsiders
};
