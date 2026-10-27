'use strict';

// Price tape under the top bar (HANDOFF §4a).
//
// Source: the same daily-history store the market breadth reads, so the tape
// shows the last completed session and says so ("penutupan <tanggal>"). It is
// not a live feed yet; when the DayTrade live cache is exposed server-side the
// rows can come from there with the same shape.
//
// Rules: IHSG first; liquid stocks (value traded >= Rp 5 M) that rose, largest
// gain first, at most 30; fewer than 8 risers -> top up with the most liquid of
// the rest. No recommendation labels.

const fs = require('node:fs');
const path = require('node:path');
const localStore = require('./local-market-subset-store');

const MIN_VALUE = 5e9;
const MAX_ITEMS = 30;
const MIN_GREEN = 8;
const CACHE_MS = 60 * 1000;

let memo = null;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function readIhsg(rootDir) {
  const file = path.join(rootDir || process.cwd(), 'data', 'daily-candles', 'IHSG.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(raw && raw.candles) ? raw.candles : [];
    if (list.length < 2) return null;
    const last = list[list.length - 1];
    const prev = list[list.length - 2];
    const close = num(last.close);
    const prevClose = num(prev.close);
    if (!(close > 0) || !(prevClose > 0)) return null;
    return {
      ticker: 'IHSG',
      date: String(last.date || last.time || '').slice(0, 10) || null,
      close,
      change_pct: Math.round(((close - prevClose) / prevClose) * 10000) / 100
    };
  } catch (_) {
    return null;
  }
}

function buildTape(options) {
  const opts = options || {};
  const store = opts.store || localStore.loadStore();
  const tickers = opts.tickers || localStore.getAllTickers();
  const rows = [];
  let latest = null;

  for (const t of tickers) {
    const list = store.historyByTicker[t];
    if (!list || list.length < 2) continue;
    const last = list[list.length - 1];
    const prev = list[list.length - 2];
    const date = String(last.trade_date || last.date || '').slice(0, 10);
    const close = num(last.close);
    const prevClose = num(last.previous_close) || num(prev.close);
    const volume = num(last.volume);
    if (!date || !(close > 0) || !(prevClose > 0)) continue;
    const value = num(last.value) != null ? num(last.value) : (volume != null ? close * volume : null);
    if (!latest || date > latest) latest = date;
    rows.push({ ticker: String(t).toUpperCase(), date, close, change_pct: Math.round(((close - prevClose) / prevClose) * 10000) / 100, value });
  }

  // Only stocks that traded in the latest session; a ticker whose last bar is
  // older would show a stale move as today's.
  const session = rows.filter((r) => r.date === latest && r.value != null && r.value >= MIN_VALUE);
  let items = session.filter((r) => r.change_pct > 0).sort((a, b) => b.change_pct - a.change_pct).slice(0, MAX_ITEMS);
  if (items.length < MIN_GREEN) {
    const rest = session.filter((r) => !(r.change_pct > 0)).sort((a, b) => b.value - a.value).slice(0, MIN_GREEN - items.length);
    items = items.concat(rest);
  }

  return {
    success: true,
    data_available: items.length > 0,
    as_of_date: latest,
    basis: 'close',
    ihsg: readIhsg(opts.rootDir),
    items: items.map((r) => ({ ticker: r.ticker, close: r.close, change_pct: r.change_pct }))
  };
}

function getTape(options) {
  const now = Date.now();
  if (memo && now - memo.at < CACHE_MS && !(options && options.fresh)) return memo.data;
  const data = buildTape(options);
  memo = { at: now, data };
  return data;
}

module.exports = { buildTape, getTape, MIN_VALUE, MAX_ITEMS, MIN_GREEN };
