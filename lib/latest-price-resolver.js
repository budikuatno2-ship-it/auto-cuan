'use strict';

const { toDateKey } = require('./idx-trading-calendar');

const SOURCES = [
  { table: 'daytrade_screener_latest', label: 'daytrade_screener_latest' },
  { table: 'swing_screener_latest', label: 'swing_screener_latest' },
  { table: 'swing_screener_non_konglo_latest', label: 'swing_screener_non_konglo_latest' },
  { table: 'foreign_watchlist_daily', label: 'foreign_watchlist_daily' }
];
const PRICE_FIELDS = ['latest_price', 'current_price', 'last_price', 'last', 'close_price', 'close'];
const DATE_FIELDS = ['price_date', 'price_asof', 'last_price_asof', 'calculated_at', 'published_at', 'run_date', 'trade_date', 'updated_at'];
function n(value) { value = Number(value); return Number.isFinite(value) && value > 0 ? value : null; }
function date(value) { if (!value) return null; var d = new Date(value); return Number.isNaN(d.getTime()) ? null : d; }
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
function isFresh(row, options) { var at = date(rowDate(row)); if (!at) return false; var now = date(options && options.now) || new Date(); var maxHours = n(options && options.maxAgeHours) || 48; return now.getTime() - at.getTime() <= maxHours * 3600000 && now.getTime() >= at.getTime() - 3600000; }
function resolveLatestPrice(rowsBySource, options) {
  rowsBySource = rowsBySource || {};
  for (const source of SOURCES) {
    const row = rowsBySource[source.table];
    if (!row || !rowPrice(row) || !isFresh(row, options)) continue;
    return { price: rowPrice(row), price_source: source.label, price_date: dateOnly(rowDate(row)), price_age_hours: Math.max(0, Math.round(((date(options && options.now) || new Date()) - date(rowDate(row))) / 360000) / 10), stale: false, row };
  }
  return { price: null, price_source: null, price_date: null, price_age_hours: null, stale: true, diagnostic: 'no_fresh_latest_price_source' };
}
module.exports = { SOURCES, resolveLatestPrice, isFresh, rowPrice, rowDate };
