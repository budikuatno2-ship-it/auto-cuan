'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.env.AUTO_CUAN_ROOT || process.cwd();
const DATA_ROOT = process.env.AUTO_CUAN_DATA_ROOT || path.join('/home/ubuntu', 'auto-cuan-data');
const FOREIGN_FILE = path.join(DATA_ROOT, 'foreign-watchlist', 'daily.json');

let cache = new Map();

function enabled() {
  return String(process.env.AUTO_CUAN_MARKET_DATA_BACKEND || '').trim().toLowerCase() === 'vps';
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function atomicWriteJson(filePath, value) {
  ensureDir(filePath);
  const tmp = filePath + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
  cache.delete(filePath);
}

function readJsonCached(filePath, fallback) {
  try {
    const stat = fs.statSync(filePath);
    const hit = cache.get(filePath);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value;
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  } catch (_) {
    return fallback;
  }
}

function normalizeTicker(value) {
  return String(value || '').trim().toUpperCase().replace(/\.JK$/i, '');
}

function normalizeForeignRow(row) {
  row = row || {};
  const ticker = normalizeTicker(row.ticker);
  const tradeDate = String(row.trade_date || '').slice(0, 10);
  if (!ticker || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) return null;
  return Object.assign({}, row, { ticker, trade_date: tradeDate });
}

function readForeignRows() {
  const payload = readJsonCached(FOREIGN_FILE, { version: 1, rows: [] });
  const rows = Array.isArray(payload) ? payload : payload && payload.rows;
  return Array.isArray(rows) ? rows.map(normalizeForeignRow).filter(Boolean) : [];
}

function writeForeignRows(rows, meta) {
  const normalized = (rows || []).map(normalizeForeignRow).filter(Boolean);
  normalized.sort((a, b) => {
    if (a.trade_date !== b.trade_date) return a.trade_date < b.trade_date ? -1 : 1;
    return a.ticker.localeCompare(b.ticker);
  });
  atomicWriteJson(FOREIGN_FILE, {
    version: 1,
    updated_at: new Date().toISOString(),
    source: (meta && meta.source) || 'vps_local',
    rows: normalized
  });
  return normalized.length;
}

function upsertForeignRows(incomingRows) {
  const byKey = new Map();
  for (const row of readForeignRows()) byKey.set(row.trade_date + '|' + row.ticker, row);
  for (const raw of incomingRows || []) {
    const row = normalizeForeignRow(raw);
    if (!row) continue;
    const key = row.trade_date + '|' + row.ticker;
    byKey.set(key, Object.assign({}, byKey.get(key) || {}, row));
  }
  return writeForeignRows(Array.from(byKey.values()), { source: 'vps_local_upsert' });
}

function getLatestForeignForTickers(tickers, count) {
  const wanted = new Set((tickers || []).map(normalizeTicker).filter(Boolean));
  const limit = Math.max(1, Number(count) || 1);
  const map = new Map();

  const rows = readForeignRows().slice().sort((a, b) => {
    if (a.trade_date !== b.trade_date) return a.trade_date > b.trade_date ? -1 : 1;
    return a.ticker.localeCompare(b.ticker);
  });

  for (const row of rows) {
    if (!wanted.has(row.ticker)) continue;
    if (!map.has(row.ticker)) map.set(row.ticker, []);
    const list = map.get(row.ticker);
    if (list.length < limit) list.push(row);
  }
  return map;
}

function candlePath(ticker) {
  const dir = process.env.CANDLE_CACHE_DIR || path.join(ROOT, 'data', 'daily-candles');
  return path.join(dir, normalizeTicker(ticker) + '.json');
}

function readCandlePayload(ticker) {
  return readJsonCached(candlePath(ticker), null);
}

function readHistoryRows(ticker, count) {
  const clean = normalizeTicker(ticker);
  const payload = readCandlePayload(clean);
  const candles = payload && Array.isArray(payload.candles) ? payload.candles : (Array.isArray(payload) ? payload : []);
  const normalized = candles.map((c, index) => {
    const tradeDate = String(c && (c.date || c.trade_date) || '').slice(0, 10);
    const close = Number(c && c.close);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate) || !Number.isFinite(close) || close <= 0) return null;
    const prevRaw = index > 0 ? Number(candles[index - 1] && candles[index - 1].close) : null;
    return {
      ticker: clean,
      trade_date: tradeDate,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close,
      previous_close: Number.isFinite(prevRaw) && prevRaw > 0 ? prevRaw : null,
      volume: Number.isFinite(Number(c.volume)) ? Number(c.volume) : null,
      value: c.value == null ? null : Number(c.value),
      frequency: c.frequency == null ? null : Number(c.frequency),
      foreign_buy_value: c.foreign_buy_value == null ? null : Number(c.foreign_buy_value),
      foreign_sell_value: c.foreign_sell_value == null ? null : Number(c.foreign_sell_value),
      foreign_net_value: c.foreign_net_value == null ? null : Number(c.foreign_net_value),
      foreign_buy_lot: c.foreign_buy_lot == null ? null : Number(c.foreign_buy_lot),
      foreign_sell_lot: c.foreign_sell_lot == null ? null : Number(c.foreign_sell_lot),
      foreign_net_lot: c.foreign_net_lot == null ? null : Number(c.foreign_net_lot),
      data_source: c.data_source || 'vps_daily_candles',
      data_quality_status: c.data_quality_status || 'local_cache'
    };
  }).filter(Boolean).sort((a, b) => a.trade_date < b.trade_date ? 1 : -1);
  return normalized.slice(0, Math.max(1, Number(count) || 1));
}

function upsertHistoryRows(rows) {
  const grouped = new Map();
  for (const row of rows || []) {
    const ticker = normalizeTicker(row && row.ticker);
    if (!ticker) continue;
    if (!grouped.has(ticker)) grouped.set(ticker, []);
    grouped.get(ticker).push(row);
  }

  let written = 0;
  for (const [ticker, incoming] of grouped.entries()) {
    const filePath = candlePath(ticker);
    const existingPayload = readJsonCached(filePath, { ticker, candles: [] }) || { ticker, candles: [] };
    const existing = Array.isArray(existingPayload) ? existingPayload : (Array.isArray(existingPayload.candles) ? existingPayload.candles : []);
    const byDate = new Map();

    for (const c of existing) {
      const date = String(c && (c.date || c.trade_date) || '').slice(0, 10);
      if (date) byDate.set(date, c);
    }
    for (const row of incoming) {
      const date = String(row && row.trade_date || '').slice(0, 10);
      if (!date) continue;
      byDate.set(date, Object.assign({}, byDate.get(date) || {}, {
        date,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
        value: row.value,
        frequency: row.frequency,
        foreign_buy_value: row.foreign_buy_value,
        foreign_sell_value: row.foreign_sell_value,
        foreign_net_value: row.foreign_net_value,
        foreign_buy_lot: row.foreign_buy_lot,
        foreign_sell_lot: row.foreign_sell_lot,
        foreign_net_lot: row.foreign_net_lot,
        data_source: row.data_source || 'daily_history_collector',
        data_quality_status: row.data_quality_status || 'ok'
      }));
      written += 1;
    }

    const candles = Array.from(byDate.values()).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const payload = Array.isArray(existingPayload)
      ? { ticker, candles, updated_at: new Date().toISOString() }
      : Object.assign({}, existingPayload, { ticker, candles, updated_at: new Date().toISOString() });
    atomicWriteJson(filePath, payload);
  }
  return written;
}

module.exports = {
  DATA_ROOT,
  FOREIGN_FILE,
  enabled,
  atomicWriteJson,
  readForeignRows,
  writeForeignRows,
  upsertForeignRows,
  getLatestForeignForTickers,
  readHistoryRows,
  upsertHistoryRows,
  normalizeTicker
};
