'use strict';

/**
 * Bandarmologi flow primitives (pure, dependency-light).
 *
 * Owns the canonical broker classification and the concentration math used by
 * the interactive Telegram bot (/bandar, /foreign, /ritel) and by any CLI
 * reporter. It reads the on-disk `data/arjum-data/broker-summary` snapshot so
 * every card is derived from the latest CLOSED exchange session and the VPS
 * stays light (no live intraday polling).
 *
 * Trust/accuracy boundaries:
 *  - Real broker-summary files carry `bval/sval/nval/bvol/svol` and a
 *    `broker_name`. They do NOT carry an `investor_type` field, so foreign flow
 *    MUST be classified through the canonical broker-code whitelist below —
 *    a previous inline loader relied on `investor_type` and silently reported
 *    zero foreign flow for real data.
 *  - Nothing here fabricates prices or volumes. A value that cannot be parsed
 *    is treated as 0 (never NaN) so a single malformed cell cannot poison a
 *    whole-universe aggregate.
 */

const fs = require('fs');
const path = require('path');

// Canonical foreign-broker whitelist (mirrors lib/foreign-flow-recap.js).
const FOREIGN_BROKERS = new Set([
  'AK', 'BK', 'CS', 'RX', 'KZ', 'ZP', 'DB', 'GW',
  'DP', 'MS', 'CG', 'ML', 'BQ', 'FS', 'YU'
]);

// Retail brokers whose flow reads as retail accumulation/distribution.
const RETAIL_BROKERS = new Set(['YP', 'PD', 'XC', 'NI', 'CC']);

function isForeignBroker(code) {
  return FOREIGN_BROKERS.has(String(code || '').trim().toUpperCase());
}

function isRetailBroker(code) {
  return RETAIL_BROKERS.has(String(code || '').trim().toUpperCase());
}

/**
 * Coerce a feed magnitude to a finite Number. Handles plain numbers/strings,
 * id-ID thousands ("1.500.000.000"), en-US thousands ("1,500,000,000") and
 * comma decimals ("1500,25"). Returns 0 for anything unparseable so callers
 * never propagate NaN into a sum.
 */
function toNumber(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value !== 'string') return 0;

  let s = value.trim();
  if (!s || s === '-' || s === '\u2014' || s === '\u2013') return 0;

  const negative = /^\(.*\)$/.test(s) || s.startsWith('-');
  s = s.replace(/^\(/, '').replace(/\)$/, '');
  s = s.replace(/[RrPp](?=[\s.\d,])/g, '').replace(/[%+\s]/g, '');
  if (!s) return 0;

  const hasDot = s.indexOf('.') >= 0;
  const hasComma = s.indexOf(',') >= 0;
  if (hasDot && hasComma) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (hasComma) {
    if (/^-?\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, '');
    else s = s.replace(',', '.');
  } else if (hasDot) {
    if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  }

  s = s.replace(/[^\d.eE+-]/g, '');
  if (!s) return 0;
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return negative && n > 0 ? -n : n;
}

/**
 * Normalize a raw broker-summary payload into uniform rows.
 * Accepts { brokers: [...] } or a bare array. `nval` falls back to
 * bval - sval when the feed omits it (never 0-by-default for a present pair).
 */
function parseBrokerRows(raw) {
  const brokers = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.brokers) ? raw.brokers : []);
  const rows = [];
  for (const b of brokers) {
    if (!b || typeof b !== 'object') continue;
    const code = String(b.broker_code || b.code || '').trim().toUpperCase();
    if (!code) continue;
    const bval = toNumber(b.bval != null ? b.bval : b.buy_val);
    const sval = toNumber(b.sval != null ? b.sval : b.sell_val);
    const nval = b.nval != null ? toNumber(b.nval) : (bval - sval);
    // Real broker-summary files carry no investor_type, so the canonical
    // broker-code whitelist is authoritative; when a feed DOES carry an
    // explicit foreign/asing marker we honour it too (union) so synthetic and
    // alternate feeds classify identically.
    const investor = String(b.investor_type || b.broker_type || b.type || '').toLowerCase();
    const foreign = b.foreign === true || investor === 'foreign' || investor === 'asing';
    rows.push({
      code,
      name: String(b.broker_name || b.name || code),
      bval,
      sval,
      nval,
      bvol: toNumber(b.bvol != null ? b.bvol : b.buy_vol),
      svol: toNumber(b.svol != null ? b.svol : b.sell_vol),
      foreign
    });
  }
  return rows;
}

function readBrokerDay(brokerRoot, ticker, date) {
  if (!brokerRoot || !ticker || !date) return null;
  const filePath = path.join(brokerRoot, String(ticker).toUpperCase(), String(date) + '.json');
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function listBrokerDates(brokerRoot, ticker) {
  const dir = path.join(brokerRoot, String(ticker).toUpperCase());
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
      .map((name) => name.slice(0, 10))
      .sort();
  } catch (_) {
    return [];
  }
}

function listBrokerTickers(brokerRoot) {
  if (!brokerRoot || !fs.existsSync(brokerRoot)) return [];
  try {
    return fs.readdirSync(brokerRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name.toUpperCase())
      .filter((name) => /^[A-Z0-9]{2,10}$/.test(name));
  } catch (_) {
    return [];
  }
}

/**
 * Concentration ratios for one side ('bval' for buyers, 'sval' for sellers).
 * CR3/CR5 are the share of the top 3 / top 5 brokers over the SAME side total,
 * so they always sit in [0, 100]. A zero total yields 0 (no division by zero).
 */
function computeConcentration(rows, side) {
  let total = 0;
  const positives = [];
  for (const r of rows) {
    const v = Math.max(0, toNumber(r[side]));
    if (v > 0) {
      total += v;
      positives.push(r);
    }
  }
  positives.sort((a, b) => toNumber(b[side]) - toNumber(a[side]));
  const share = (n) => (total > 0
    ? (positives.slice(0, n).reduce((s, r) => s + Math.max(0, toNumber(r[side])), 0) / total) * 100
    : 0);
  return {
    total,
    sorted: positives,
    cr3: share(3),
    cr5: share(5)
  };
}

function averageBuyPrice(row) {
  const bval = toNumber(row && row.bval);
  const bvol = toNumber(row && row.bvol);
  if (bvol > 0 && bval > 0) return bval / bvol;
  return null;
}

/**
 * Full bandarmology summary for one trading day.
 * `avgBuyPrice` is only returned when the feed actually carried buy volume —
 * it is never estimated from an unrelated field.
 */
function summarizeBandarDay(rows) {
  const buyers = computeConcentration(rows, 'bval');
  const sellers = computeConcentration(rows, 'sval');

  let retailNet = 0;
  let foreignNet = 0;
  for (const r of rows) {
    const nval = toNumber(r.nval);
    if (isRetailBroker(r.code)) retailNet += nval;
    if (isForeignBroker(r.code) || r.foreign) foreignNet += nval;
  }

  const topBuyers = buyers.sorted.slice(0, 5).map((r) => ({
    code: r.code,
    name: r.name,
    value: toNumber(r.bval),
    avgBuyPrice: averageBuyPrice(r)
  }));
  const topSellers = sellers.sorted.slice(0, 5).map((r) => ({
    code: r.code,
    name: r.name,
    value: toNumber(r.sval)
  }));

  return {
    brokerCount: rows.length,
    turnover: buyers.total,
    cr3Buy: buyers.cr3,
    cr5Buy: buyers.cr5,
    cr3Sell: sellers.cr3,
    cr5Sell: sellers.cr5,
    topBuyers,
    topSellers,
    retailNet,
    foreignNet,
    net: rows.reduce((s, r) => s + toNumber(r.nval), 0)
  };
}

/**
 * Resolve the last N trading sessions (by available on-disk dates) up to and
 * including `anchorDate` (when the anchor file exists). Returns ascending.
 */
function resolveWindowDates(brokerRoot, ticker, sessions, anchorDate) {
  const dates = listBrokerDates(brokerRoot, ticker);
  const bounded = anchorDate ? dates.filter((d) => d <= anchorDate) : dates;
  return bounded.slice(-Math.max(1, Number(sessions) || 1));
}

/**
 * Aggregate `mode` ('foreign' | 'ritel') net flow across a ticker universe
 * over the last `sessions` trading days ending at each ticker's latest
 * (optionally <= anchorDate) session. Returns [{ ticker, net, sessions }].
 */
function aggregateUniverseFlow(brokerRoot, mode, sessions, anchorDate, tickers) {
  const universe = (Array.isArray(tickers) && tickers.length)
    ? tickers
    : listBrokerTickers(brokerRoot);
  const out = [];
  for (const ticker of universe) {
    const dates = resolveWindowDates(brokerRoot, ticker, sessions, anchorDate);
    if (!dates.length) continue;
    let net = 0;
    let used = 0;
    for (const date of dates) {
      const raw = readBrokerDay(brokerRoot, ticker, date);
      if (!raw) continue;
      used += 1;
      for (const row of parseBrokerRows(raw)) {
        const match = mode === 'foreign'
          ? (isForeignBroker(row.code) || row.foreign)
          : isRetailBroker(row.code);
        if (match) net += toNumber(row.nval);
      }
    }
    if (used > 0 && net !== 0) out.push({ ticker, net, sessions: used });
  }
  out.sort((a, b) => b.net - a.net);
  return out;
}

/**
 * Latest available trading date for a ticker (optionally not after anchor).
 */
function latestBrokerDate(brokerRoot, ticker, anchorDate) {
  const dates = resolveWindowDates(brokerRoot, ticker, 1, anchorDate);
  return dates.length ? dates[dates.length - 1] : null;
}

/**
 * One-day bandarmology detail for a ticker: rows + summary + the resolved date.
 * Returns null when no snapshot exists (caller must say so, not fabricate).
 */
function bandarForTicker(brokerRoot, ticker, anchorDate) {
  const date = latestBrokerDate(brokerRoot, ticker, anchorDate);
  if (!date) return null;
  const raw = readBrokerDay(brokerRoot, ticker, date);
  if (!raw) return null;
  const rows = parseBrokerRows(raw);
  return { ticker: String(ticker).toUpperCase(), date, rows, summary: summarizeBandarDay(rows) };
}

/**
 * Bandarmology aggregated over the last `sessions` trading days ending at the
 * latest available (or <= anchorDate) session. Per-broker bval/sval/nval are
 * SUMMED across the window before the CR3/CR5 concentration is computed, so the
 * ratios describe the window's real turnover rather than a single day.
 */
function bandarForTickerWindow(brokerRoot, ticker, sessions, anchorDate) {
  const dates = resolveWindowDates(brokerRoot, ticker, sessions, anchorDate);
  if (!dates.length) return null;
  const byBroker = new Map();
  for (const date of dates) {
    const raw = readBrokerDay(brokerRoot, ticker, date);
    if (!raw) continue;
    for (const row of parseBrokerRows(raw)) {
      const acc = byBroker.get(row.code) || { code: row.code, name: row.name, bval: 0, sval: 0, nval: 0, bvol: 0, svol: 0 };
      acc.bval += row.bval;
      acc.sval += row.sval;
      acc.nval += row.nval;
      acc.bvol += row.bvol;
      acc.svol += row.svol;
      byBroker.set(row.code, acc);
    }
  }
  const rows = Array.from(byBroker.values());
  if (!rows.length) return null;
  return {
    ticker: String(ticker).toUpperCase(),
    date: dates[dates.length - 1],
    from: dates[0],
    sessions: dates.length,
    rows,
    summary: summarizeBandarDay(rows)
  };
}

module.exports = {
  FOREIGN_BROKERS,
  RETAIL_BROKERS,
  isForeignBroker,
  isRetailBroker,
  toNumber,
  parseBrokerRows,
  readBrokerDay,
  listBrokerDates,
  listBrokerTickers,
  computeConcentration,
  averageBuyPrice,
  summarizeBandarDay,
  resolveWindowDates,
  aggregateUniverseFlow,
  latestBrokerDate,
  bandarForTicker,
  bandarForTickerWindow
};