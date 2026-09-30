'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DB_PATH = process.env.AUTO_CUAN_MARKET_DB ||
  '/home/ubuntu/auto-cuan-data/market.sqlite';

const TABLE_KEYS = Object.freeze({
  stock_daily_history: ['ticker', 'trade_date'],
  stock_daily_features: ['ticker'],
  stock_fundamentals: ['ticker'],
  stock_boards: ['ticker'],
  idx_trading_calendar: ['trade_date'],
  foreign_watchlist_daily: ['trade_date', 'ticker'],
  daytrade_screener_latest: ['ticker'],
  daytrade_screener_meta: ['id'],
  daytrade_screener_runs: ['id'],
  swing_screener_latest: ['ticker'],
  swing_screener_meta: ['id'],
  swing_screener_non_konglo_latest: ['ticker'],
  swing_screener_non_konglo_meta: ['id'],
  swing_screener_non_konglo_jobs: ['id'],
  swing_screener_non_konglo_staging: ['run_date', 'ticker'],
  sector_hot_groups: ['group_code'],
  sector_hot_group_members: ['group_code', 'ticker'],
  sector_hot_members_latest: ['group_code', 'ticker'],
  sector_hot_latest: ['group_code'],
  sector_hot_meta: ['id'],
  telegram_daily_picks: ['id'],
  ai_analysis_cache: ['id'],
  ai_context_snapshots: ['id'],
  ai_eval_runs: ['id'],
  ai_eval_chunks: ['id'],
  ai_eval_case_index: ['id'],
  stock_news_cache: ['id']
});

const MARKET_TABLES = new Set(Object.keys(TABLE_KEYS));

let generatedCounter = 0;

function loadSqlite() {
  try {
    return require('node:sqlite');
  } catch (error) {
    const wrapped = new Error(
      'VPS market store membutuhkan Node >=22.13 dengan node:sqlite. ' +
      'Runtime ini belum mendukungnya: ' + (error && error.message || error)
    );
    wrapped.code = 'VPS_SQLITE_UNAVAILABLE';
    throw wrapped;
  }
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function safeField(field) {
  const value = String(field || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error('Kolom market store tidak valid: ' + value);
  }
  return value;
}

function jsonPath(field) {
  return '$.' + safeField(field);
}

function autoId() {
  generatedCounter = (generatedCounter + 1) % 1000;
  return Math.floor(Date.now() / 1000) * 1000000 +
    (process.pid % 1000) * 1000 + generatedCounter;
}

function normalizeRows(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map((row) => Object.assign({}, row));
  if (value && typeof value === 'object') return [Object.assign({}, value)];
  return [];
}

function keyFieldsFor(table, onConflict) {
  if (onConflict) {
    return String(onConflict).split(',').map((x) => safeField(x.trim())).filter(Boolean);
  }
  return TABLE_KEYS[table] || ['id'];
}

function ensureRowKeyFields(table, row, keyFields) {
  const copy = Object.assign({}, row);
  for (const field of keyFields) {
    if (copy[field] == null && field === 'id') copy[field] = autoId();
  }
  const missing = keyFields.filter((field) => copy[field] == null || copy[field] === '');
  if (missing.length) {
    throw new Error('Market store row key tidak lengkap untuk ' + table + ': ' + missing.join(','));
  }
  return copy;
}

function rowKey(row, keyFields) {
  return keyFields.map((field) => String(row[field])).join('\u001f');
}

function parseColumns(columns) {
  const raw = String(columns == null ? '*' : columns).trim();
  if (!raw || raw === '*') return null;
  return raw.split(',').map((item) => item.trim()).filter(Boolean)
    .map((item) => {
      const aliasParts = item.split(':');
      const source = aliasParts.length > 1 ? aliasParts[aliasParts.length - 1] : item;
      return { output: aliasParts.length > 1 ? aliasParts[0].trim() : source.trim(), source: source.trim() };
    })
    .filter((item) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(item.source));
}

function projectRow(row, columns) {
  if (!columns) return row;
  const out = {};
  for (const col of columns) out[col.output] = row[col.source];
  return out;
}

function compareForOrder(a, b, field, ascending, nullsFirst) {
  const av = a[field];
  const bv = b[field];
  const aNull = av == null;
  const bNull = bv == null;
  if (aNull || bNull) {
    if (aNull && bNull) return 0;
    const first = nullsFirst === true;
    return aNull ? (first ? -1 : 1) : (first ? 1 : -1);
  }
  let cmp = 0;
  if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
  else cmp = String(av).localeCompare(String(bv));
  return ascending === false ? -cmp : cmp;
}

function splitOrExpression(expression) {
  const text = String(expression || '').trim();
  if (!text) return [];
  const clauses = [];
  let buf = '';
  let depth = 0;
  for (const ch of text) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      if (buf.trim()) clauses.push(buf.trim());
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) clauses.push(buf.trim());
  return clauses;
}

function parseOrClause(clause) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\.(eq|neq|gt|gte|lt|lte|is|like|ilike)\.(.*)$/.exec(clause);
  if (!match) return null;
  let value = match[3];
  if (value === 'null') value = null;
  else if (value === 'true') value = true;
  else if (value === 'false') value = false;
  else if (/^-?\d+(?:\.\d+)?$/.test(value)) value = Number(value);
  return { field: match[1], op: match[2], value };
}

function matchesFilter(row, filter) {
  const actual = row[filter.field];
  const expected = filter.value;
  switch (filter.op) {
    case 'eq': return actual === expected || String(actual) === String(expected);
    case 'neq': return !(actual === expected || String(actual) === String(expected));
    case 'gt': return actual > expected;
    case 'gte': return actual >= expected;
    case 'lt': return actual < expected;
    case 'lte': return actual <= expected;
    case 'is': return expected === null ? actual == null : actual === expected;
    case 'in': return (filter.value || []).some((v) => actual === v || String(actual) === String(v));
    case 'like': {
      const pattern = String(expected).replace(/[.+^$(){}|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
      return new RegExp('^' + pattern + '$').test(String(actual == null ? '' : actual));
    }
    case 'ilike': {
      const pattern = String(expected).replace(/[.+^$(){}|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
      return new RegExp('^' + pattern + '$', 'i').test(String(actual == null ? '' : actual));
    }
    default: return false;
  }
}

class LocalMarketQuery {
  constructor(store, table) {
    this.store = store;
    this.table = table;
    this.action = 'select';
    this.columns = null;
    this.returningColumns = null;
    this.selectOptions = {};
    this.filters = [];
    this.orGroups = [];
    this.orders = [];
    this.limitValue = null;
    this.rangeValue = null;
    this.payload = null;
    this.onConflict = null;
    this.singleMode = null;
  }

  select(columns, options) {
    const parsed = parseColumns(columns);
    if (this.action === 'insert' || this.action === 'upsert' || this.action === 'update' || this.action === 'delete') {
      this.returningColumns = parsed;
    } else {
      this.action = 'select';
      this.columns = parsed;
      this.selectOptions = options || {};
    }
    return this;
  }

  insert(rows) { this.action = 'insert'; this.payload = normalizeRows(rows); return this; }
  upsert(rows, options) {
    this.action = 'upsert';
    this.payload = normalizeRows(rows);
    this.onConflict = options && options.onConflict || null;
    return this;
  }
  update(values) { this.action = 'update'; this.payload = Object.assign({}, values || {}); return this; }
  delete() { this.action = 'delete'; return this; }

  eq(field, value) { this.filters.push({ field: safeField(field), op: 'eq', value }); return this; }
  neq(field, value) { this.filters.push({ field: safeField(field), op: 'neq', value }); return this; }
  gt(field, value) { this.filters.push({ field: safeField(field), op: 'gt', value }); return this; }
  gte(field, value) { this.filters.push({ field: safeField(field), op: 'gte', value }); return this; }
  lt(field, value) { this.filters.push({ field: safeField(field), op: 'lt', value }); return this; }
  lte(field, value) { this.filters.push({ field: safeField(field), op: 'lte', value }); return this; }
  is(field, value) { this.filters.push({ field: safeField(field), op: 'is', value }); return this; }
  in(field, values) { this.filters.push({ field: safeField(field), op: 'in', value: Array.isArray(values) ? values : [] }); return this; }
  like(field, value) { this.filters.push({ field: safeField(field), op: 'like', value }); return this; }
  ilike(field, value) { this.filters.push({ field: safeField(field), op: 'ilike', value }); return this; }
  match(values) {
    Object.entries(values || {}).forEach(([field, value]) => this.eq(field, value));
    return this;
  }
  filter(field, operator, value) {
    const op = String(operator || '').toLowerCase();
    if (typeof this[op] === 'function') return this[op](field, value);
    throw new Error('Operator market store belum didukung: ' + operator);
  }
  not(field, operator, value) {
    const op = String(operator || '').toLowerCase();
    if (op === 'is' && value === null) {
      this.filters.push({ field: safeField(field), op: 'neq', value: null });
      return this;
    }
    if (op === 'eq') return this.neq(field, value);
    throw new Error('Operator NOT market store belum didukung: ' + operator);
  }
  or(expression) {
    const group = splitOrExpression(expression).map(parseOrClause).filter(Boolean);
    if (!group.length) throw new Error('OR market store tidak dapat diparse: ' + expression);
    this.orGroups.push(group);
    return this;
  }
  order(field, options) {
    this.orders.push({
      field: safeField(field),
      ascending: !(options && options.ascending === false),
      nullsFirst: options && options.nullsFirst
    });
    return this;
  }
  limit(value) { this.limitValue = Math.max(0, Number(value) || 0); return this; }
  range(from, to) { this.rangeValue = [Math.max(0, Number(from) || 0), Math.max(0, Number(to) || 0)]; return this; }
  maybeSingle() { this.singleMode = 'maybe'; this.limitValue = this.limitValue == null ? 2 : this.limitValue; return this; }
  single() { this.singleMode = 'single'; this.limitValue = this.limitValue == null ? 2 : this.limitValue; return this; }
  throwOnError() { return this; }
  abortSignal() { return this; }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }

  async execute() {
    try {
      if (this.action === 'select') return this.executeSelect();
      if (this.action === 'insert' || this.action === 'upsert') return this.executeInsertLike();
      if (this.action === 'update') return this.executeUpdate();
      if (this.action === 'delete') return this.executeDelete();
      throw new Error('Aksi market store tidak dikenal: ' + this.action);
    } catch (error) {
      return { data: null, error: { message: error.message, code: error.code || 'VPS_MARKET_STORE_ERROR' }, count: null };
    }
  }

  loadMatchedRows() {
    let rows = this.store.readTable(this.table);
    if (this.filters.length) {
      rows = rows.filter((row) => this.filters.every((filter) => matchesFilter(row, filter)));
    }
    for (const group of this.orGroups) {
      rows = rows.filter((row) => group.some((filter) => matchesFilter(row, filter)));
    }
    if (this.orders.length) {
      rows.sort((a, b) => {
        for (const order of this.orders) {
          const cmp = compareForOrder(a, b, order.field, order.ascending, order.nullsFirst);
          if (cmp) return cmp;
        }
        return 0;
      });
    }
    return rows;
  }

  executeSelect() {
    let rows = this.loadMatchedRows();
    const total = rows.length;
    if (this.rangeValue) {
      rows = rows.slice(this.rangeValue[0], this.rangeValue[1] + 1);
    }
    if (this.limitValue != null) rows = rows.slice(0, this.limitValue);
    rows = rows.map((row) => projectRow(row, this.columns));

    if (this.selectOptions && this.selectOptions.head === true) {
      return { data: null, error: null, count: total };
    }
    if (this.singleMode) {
      if (rows.length === 1) return { data: rows[0], error: null, count: total };
      if (rows.length === 0 && this.singleMode === 'maybe') return { data: null, error: null, count: total };
      return {
        data: null,
        error: { message: 'Single row expected; got ' + rows.length, code: 'PGRST116' },
        count: total
      };
    }
    return {
      data: rows,
      error: null,
      count: this.selectOptions && this.selectOptions.count ? total : null
    };
  }

  executeInsertLike() {
    const conflictFields = keyFieldsFor(this.table, this.onConflict);
    const inserted = [];
    this.store.transaction(() => {
      for (const raw of this.payload || []) {
        const row = ensureRowKeyFields(this.table, raw, conflictFields);
        this.store.writeRow(this.table, row, conflictFields, this.action === 'upsert');
        inserted.push(row);
      }
    });
    return { data: this.returningColumns ? inserted.map((row) => projectRow(row, this.returningColumns)) : null, error: null, count: inserted.length };
  }

  executeUpdate() {
    const matched = this.loadMatchedRows();
    const keyFields = keyFieldsFor(this.table, null);
    const updated = [];
    this.store.transaction(() => {
      for (const oldRow of matched) {
        const next = Object.assign({}, oldRow, this.payload || {});
        this.store.deleteRow(this.table, oldRow, keyFields);
        this.store.writeRow(this.table, ensureRowKeyFields(this.table, next, keyFields), keyFields, true);
        updated.push(next);
      }
    });
    return { data: this.returningColumns ? updated.map((row) => projectRow(row, this.returningColumns)) : null, error: null, count: updated.length };
  }

  executeDelete() {
    const matched = this.loadMatchedRows();
    const keyFields = keyFieldsFor(this.table, null);
    this.store.transaction(() => {
      for (const row of matched) this.store.deleteRow(this.table, row, keyFields);
    });
    return { data: this.returningColumns ? matched.map((row) => projectRow(row, this.returningColumns)) : null, error: null, count: matched.length };
  }
}

class VpsMarketStore {
  constructor(filePath) {
    this.filePath = filePath || DEFAULT_DB_PATH;
    ensureParent(this.filePath);
    const { DatabaseSync } = loadSqlite();
    this.db = new DatabaseSync(this.filePath);
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA synchronous=NORMAL;');
    this.db.exec('PRAGMA busy_timeout=5000;');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS market_rows (' +
      'table_name TEXT NOT NULL,' +
      'row_key TEXT NOT NULL,' +
      'row_json TEXT NOT NULL,' +
      'updated_at TEXT NOT NULL,' +
      'PRIMARY KEY(table_name,row_key)' +
      ');' +
      'CREATE INDEX IF NOT EXISTS idx_market_rows_table ON market_rows(table_name);'
    );
    this.selectTableStmt = this.db.prepare('SELECT row_json FROM market_rows WHERE table_name=?');
    this.insertStmt = this.db.prepare(
      'INSERT INTO market_rows(table_name,row_key,row_json,updated_at) VALUES(?,?,?,?)'
    );
    this.upsertStmt = this.db.prepare(
      'INSERT INTO market_rows(table_name,row_key,row_json,updated_at) VALUES(?,?,?,?) ' +
      'ON CONFLICT(table_name,row_key) DO UPDATE SET row_json=excluded.row_json,updated_at=excluded.updated_at'
    );
    this.deleteStmt = this.db.prepare('DELETE FROM market_rows WHERE table_name=? AND row_key=?');
    this.clearStmt = this.db.prepare('DELETE FROM market_rows WHERE table_name=?');
    this.countStmt = this.db.prepare('SELECT COUNT(*) AS count FROM market_rows WHERE table_name=?');
  }

  from(table) {
    const name = String(table || '');
    if (!MARKET_TABLES.has(name)) throw new Error('Tabel bukan VPS market-data: ' + name);
    return new LocalMarketQuery(this, name);
  }

  readTable(table) {
    return this.selectTableStmt.all(table).map((row) => JSON.parse(row.row_json));
  }

  writeRow(table, row, keyFields, allowReplace) {
    const key = rowKey(row, keyFields);
    const json = JSON.stringify(row);
    const now = new Date().toISOString();
    try {
      (allowReplace ? this.upsertStmt : this.insertStmt).run(table, key, json, now);
    } catch (error) {
      error.message = 'Write ' + table + ' gagal: ' + error.message;
      throw error;
    }
  }

  deleteRow(table, row, keyFields) {
    this.deleteStmt.run(table, rowKey(row, keyFields));
  }

  clearTable(table) {
    this.clearStmt.run(table);
  }

  count(table) {
    const row = this.countStmt.get(table);
    return Number(row && row.count || 0);
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (_) {}
      throw error;
    }
  }

  close() {
    try { this.db.close(); } catch (_) {}
  }
}

let singleton = null;

function getVpsMarketStore(filePath) {
  const target = filePath || DEFAULT_DB_PATH;
  if (!singleton || singleton.filePath !== target) {
    if (singleton) singleton.close();
    singleton = new VpsMarketStore(target);
  }
  return singleton;
}

module.exports = {
  DEFAULT_DB_PATH,
  TABLE_KEYS,
  MARKET_TABLES,
  VpsMarketStore,
  getVpsMarketStore,
  keyFieldsFor,
  matchesFilter
};
