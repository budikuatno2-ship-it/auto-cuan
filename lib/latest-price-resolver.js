'use strict';

const { toDateKey } = require('./idx-trading-calendar');

const SOURCES = [
  { table: 'daytrade_screener_latest', label: 'daytrade_screener_latest' },
  { table: 'swing_screener_latest', label: 'swing_screener_latest' },
  { table: 'swing_screener_non_konglo_latest', label: 'swing_screener_non_konglo_latest' },
  { table: 'foreign_watchlist_daily', label: 'foreign_watchlist_daily' }
];
const PRICE_FIELDS = ['latest_price', 'current_price', 'last_price', 'price', 'last', 'close_price', 'close'];
const DATE_FIELDS = ['price_date', 'price_asof', 'last_price_asof', 'as_of_date', 'date', 'calculated_at', 'published_at', 'run_date', 'trade_date', 'updated_at'];
function n(value) { if (typeof value === 'boolean') return null; value = Number(value); return Number.isFinite(value) && value > 0 ? value : null; }
function date(value) { if (!value) return null; if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) value += 'T00:00:00+07:00'; var d = new Date(value); return Number.isNaN(d.getTime()) ? null : d; }
// Was `date(value).toISOString().slice(0, 10)` — a naive UTC calendar-date
// slice. rowDate() can return a real timestamp field (calculated_at,
// published_at, updated_at), and for any instant in UTC 17:00-23:59 (=
// Asia/Jakarta 00:00-06:59 the next day), that UTC slice reports the WRONG
// (previous) WIB trading date. toDateKey (lib/idx-trading-calendar.js) is
// the codebase's established Asia/Jakarta-aware date-key conversion — reuse
// it instead of re-deriving calendar-date math here.
//
// IMPORTANT: toDateKey takes a same-day shortcut for any STRING that
// already starts with "YYYY-MM-DD" (treating it as an already-resolved
// date, e.g. a plain trade_date/run_date column) — it only applies the
// Asia/Jakarta conversion to a genuine Date object. A full ISO timestamp
// STRING like '2026-08-12T19:00:00Z' would hit that same-day shortcut and
// reproduce the exact UTC-slice bug this is fixing. So this always routes
// through the local date() helper first to get a real Date instance,
// guaranteeing the timezone-aware path runs regardless of whether the
// underlying DB column happened to already be a Date, an ISO string, or a
// plain "YYYY-MM-DD" string (the last case is unaffected either way, since
// its UTC-midnight instant is always still the same WIB calendar day).
function dateOnly(value) { var d = date(value); if (!d) return null; try { return toDateKey(d); } catch (e) { return null; } }
function rowPrice(row) { for (const field of PRICE_FIELDS) { const value = n(row && row[field]); if (value) return value; } return null; }
function rowDate(row) { for (const field of DATE_FIELDS) if (row && row[field]) return row[field]; return null; }
// ponytail: 72h maxAge accommodates standard weekend gap (Friday 16:00 to Monday 09:00 WIB); upgrade to full trading-day diff when multi-day holiday gap support is required
function isFresh(row, options) { var at = date(rowDate(row)); if (!at) return false; var now = date(options && options.now) || new Date(); var maxHours = n(options && options.maxAgeHours) || 72; return now.getTime() - at.getTime() <= maxHours * 3600000 && now.getTime() >= at.getTime() - 3600000; }
function resolveLatestPrice(rowsBySource, options) {
  rowsBySource = rowsBySource || {};
  let best = null;
  for (const source of SOURCES) {
    const row = rowsBySource[source.table];
    if (!row || !rowPrice(row) || !isFresh(row, options)) continue;
    const dKey = dateOnly(rowDate(row));
    if (!best || (dKey && dKey > best.dKey)) best = { source, row, dKey };
  }
  if (best) {
    const { source, row } = best;
    const now = date(options && options.now) || new Date();
    return { price: rowPrice(row), price_source: source.label, price_date: dateOnly(rowDate(row)), price_age_hours: Math.max(0, Math.round((now - date(rowDate(row))) / 360000) / 10), stale: false, row };
  }
  return { price: null, price_source: null, price_date: null, price_age_hours: null, stale: true, diagnostic: 'no_fresh_latest_price_source' };
}

async function fetchFreshScreenerLatestPrice(ticker, options) {
  ticker = String(ticker || '').trim().toUpperCase().replace(/\.JK$/i, '').replace(/[^A-Z0-9]/g, '');
  if (!ticker) return { price: null, stale: true, diagnostic: 'empty_ticker' };
  options = options || {};

  // 1. Try Supabase if configured or passed in options
  const supabase = options.supabase;
  const base = String(options.supabaseUrl || process.env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '');
  const key = options.supabaseKey || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  const rows = {};
  if (supabase && typeof supabase.from === 'function') {
    await Promise.all(SOURCES.map(async function(source) {
      try {
        const orderClause = source.order || 'calculated_at';
        const res = await supabase.from(source.table).select('*').eq('ticker', ticker).order(orderClause, { ascending: false }).limit(1);
        if (res && res.data && res.data[0]) {
          rows[source.table] = res.data[0];
        }
      } catch (_) {}
    }));
  } else if (base && key && typeof fetch === 'function') {
    await Promise.all(SOURCES.map(async function(source) {
      try {
        const orderClause = source.order || 'calculated_at.desc,updated_at.desc';
        const url = base + '/rest/v1/' + source.table + '?ticker=eq.' + encodeURIComponent(ticker) + '&order=' + orderClause + '&limit=1';
        let response = await fetch(url, { headers: { apikey: key, Authorization: 'Bearer ' + key } });
        if (!response.ok) {
          const fallbackUrl = base + '/rest/v1/' + source.table + '?ticker=eq.' + encodeURIComponent(ticker) + '&limit=1';
          response = await fetch(fallbackUrl, { headers: { apikey: key, Authorization: 'Bearer ' + key } });
          if (!response.ok) return;
        }
        const data = await response.json();
        rows[source.table] = data && data[0] || null;
      } catch (_) {}
    }));
  }

  const resolved = resolveLatestPrice(rows, options);
  if (resolved && resolved.price > 0 && !resolved.stale) {
    return resolved;
  }

  // 2. Authoritative live fallback from VPS fetcher
  try {
    const vpsFetcher = require('./vps-data-fetcher');
    if (vpsFetcher && typeof vpsFetcher.fetchLivePriceFromVpsSync === 'function') {
      const vps = vpsFetcher.fetchLivePriceFromVpsSync(ticker);
      if (vps && vps.price > 0) {
        return {
          price: vps.price,
          price_source: vps.price_source || 'vps_live',
          price_date: vps.as_of_date || null,
          price_age_hours: 0,
          stale: false,
          row: null
        };
      }
    }
  } catch (_) {}

  return resolved;
}

/**
 * Stage 1: BULK resolution entry point for scanner-style callers.
 *
 * Resolving a whole universe ticker-by-ticker is what pushed the intel endpoint
 * past its budget: every miss fell through to a synchronous network probe. This
 * helper takes the rows a caller ALREADY fetched (or a pre-resolved price map) and
 * returns a plain { TICKER: { price, price_source, price_date } } map, so a scanner
 * can answer from memory in one pass.
 *
 * @param {Object<string, Object>} rowsByTicker - { TICKER: { table: row } }
 * @param {{now?: string|Date}} [options]
 * @returns {Object<string, {price: number, price_source: string, price_date: string|null}>}
 */
function resolveLatestPriceBulk(rowsByTicker, options) {
  const out = {};
  if (!rowsByTicker || typeof rowsByTicker !== 'object') return out;
  for (const key of Object.keys(rowsByTicker)) {
    const clean = String(key || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!clean) continue;
    const resolved = resolveLatestPrice(rowsByTicker[key], options);
    if (resolved && resolved.price > 0 && !resolved.stale) {
      out[clean] = {
        price: resolved.price,
        price_source: resolved.price_source,
        price_date: resolved.price_date
      };
    }
  }
  return out;
}

module.exports = {
  SOURCES,
  resolveLatestPrice,
  resolveLatestPriceBulk,
  isFresh,
  rowPrice,
  rowDate,
  fetchFreshScreenerLatestPrice
};
