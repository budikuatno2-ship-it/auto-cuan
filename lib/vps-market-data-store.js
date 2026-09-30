'use strict';

const fs = require('fs');
const path = require('path');
const localTables = require('./vps-local-table-query');

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

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withFileLock(filePath, fn) {
  ensureDir(filePath);
  const lock = filePath + '.lock';
  let fd = null;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      fd = fs.openSync(lock, 'wx');
      break;
    } catch (_) {
      try {
        const stat = fs.statSync(lock);
        if (Date.now() - stat.mtimeMs > 30000) fs.unlinkSync(lock);
      } catch (_) {}
      sleepSync(20);
    }
  }
  if (fd == null) throw new Error('VPS data file lock timeout: ' + filePath);
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(lock); } catch (_) {}
  }
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
  const id = row.id || cryptoKey(tradeDate + '|' + ticker);
  return Object.assign({}, row, { id, ticker, trade_date: tradeDate });
}

function cryptoKey(value) {
  const crypto = require('crypto');
  return crypto.createHash('sha1').update(String(value)).digest('hex');
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
  return withFileLock(FOREIGN_FILE, function() {
    const byKey = new Map();
    for (const row of readForeignRows()) byKey.set(row.trade_date + '|' + row.ticker, row);
    for (const raw of incomingRows || []) {
      const row = normalizeForeignRow(raw);
      if (!row) continue;
      const key = row.trade_date + '|' + row.ticker;
      byKey.set(key, Object.assign({}, byKey.get(key) || {}, row));
    }
    return writeForeignRows(Array.from(byKey.values()), { source: 'vps_local_upsert' });
  });
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


function parseInList(value) {
  if (Array.isArray(value)) return value;
  const text = String(value == null ? '' : value).trim().replace(/^\(/, '').replace(/\)$/, '');
  if (!text) return [];
  return text.split(',').map((v) => v.trim().replace(/^["']|["']$/g, ''));
}

function projectRows(rows, columns) {
  const raw = String(columns || '*').trim();
  if (!raw || raw === '*') return rows.map((r) => Object.assign({}, r));
  const cols = raw.split(',').map((x) => x.trim()).filter(Boolean);
  return rows.map((row) => {
    const out = {};
    for (const col of cols) {
      const clean = col.split(':').pop().trim();
      if (Object.prototype.hasOwnProperty.call(row, clean)) out[clean] = row[clean];
    }
    return out;
  });
}

class ForeignLocalQuery {
  constructor() {
    this.op = 'select';
    this.columns = '*';
    this.filters = [];
    this.orders = [];
    this.limitCount = null;
    this.rangeStart = null;
    this.rangeEnd = null;
    this.mutationRows = null;
    this.returning = false;
  }

  select(columns) {
    this.columns = columns || '*';
    this.returning = true;
    return this;
  }
  eq(col, value) { this.filters.push((r) => String(r[col]) === String(value)); return this; }
  neq(col, value) { this.filters.push((r) => String(r[col]) !== String(value)); return this; }
  in(col, values) {
    const set = new Set((values || []).map((v) => String(v)));
    this.filters.push((r) => set.has(String(r[col])));
    return this;
  }
  not(col, operator, value) {
    if (String(operator).toLowerCase() === 'in') {
      const set = new Set(parseInList(value).map(String));
      this.filters.push((r) => !set.has(String(r[col])));
    }
    return this;
  }
  order(col, options) {
    this.orders.push({ col, ascending: !(options && options.ascending === false) });
    return this;
  }
  limit(value) { this.limitCount = Math.max(0, Number(value) || 0); return this; }
  range(start, end) { this.rangeStart = Number(start) || 0; this.rangeEnd = Number(end); return this; }
  upsert(rows) { this.op = 'upsert'; this.mutationRows = Array.isArray(rows) ? rows : [rows]; return this; }
  insert(rows) { return this.upsert(rows); }
  delete() { this.op = 'delete'; return this; }
  maybeSingle() { return this._execute().then((r) => ({ data: r.data && r.data[0] || null, error: r.error })); }
  single() { return this.maybeSingle(); }

  then(resolve, reject) {
    return this._execute().then(resolve, reject);
  }

  async _execute() {
    try {
      if (this.op === 'upsert') {
        const normalized = (this.mutationRows || []).map(normalizeForeignRow).filter(Boolean);
        upsertForeignRows(normalized);
        const data = this.returning ? projectRows(normalized, this.columns) : null;
        return { data, error: null, count: normalized.length };
      }

      let rows = readForeignRows();
      if (this.filters.length) rows = rows.filter((r) => this.filters.every((fn) => fn(r)));

      if (this.op === 'delete') {
        const deletedRows = withFileLock(FOREIGN_FILE, function() {
          const current = readForeignRows();
          const matching = current.filter((r) => this.filters.every((fn) => fn(r)));
          const toDelete = new Set(matching.map((r) => r.id || (r.trade_date + '|' + r.ticker)));
          const kept = current.filter((r) => !toDelete.has(r.id || (r.trade_date + '|' + r.ticker)));
          writeForeignRows(kept, { source: 'vps_local_delete' });
          return matching;
        }.bind(this));
        return { data: this.returning ? projectRows(deletedRows, this.columns) : null, error: null, count: deletedRows.length };
      }

      if (this.orders.length) {
        const orders = this.orders.slice();
        rows = rows.slice().sort((a, b) => {
          for (const order of orders) {
            const av = a[order.col], bv = b[order.col];
            if (av == null && bv == null) continue;
            if (av == null) return order.ascending ? -1 : 1;
            if (bv == null) return order.ascending ? 1 : -1;
            if (av < bv) return order.ascending ? -1 : 1;
            if (av > bv) return order.ascending ? 1 : -1;
          }
          return 0;
        });
      }

      if (this.rangeStart != null) {
        const end = Number.isFinite(this.rangeEnd) ? this.rangeEnd + 1 : undefined;
        rows = rows.slice(this.rangeStart, end);
      }
      if (this.limitCount != null) rows = rows.slice(0, this.limitCount);
      return { data: projectRows(rows, this.columns), error: null, count: rows.length };
    } catch (error) {
      return { data: null, error: { message: error.message || String(error) }, count: null };
    }
  }
}

function wrapSupabaseClient(client) {
  if (!enabled() || !client) return client;
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'from') {
        return function(table) {
          if (table === 'foreign_watchlist_daily') return new ForeignLocalQuery();
          if (localTables.localTableReady(table)) return new localTables.LocalTableQuery(table);
          return target.from(table);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
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
  normalizeTicker,
  withFileLock,
  wrapSupabaseClient,
  ForeignLocalQuery
};
