'use strict';

const crypto = require('node:crypto');
const risk = require('./market-structure-risk');

const MAX_CSV_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 3000;
const UPSERT_BATCH_SIZE = 200;
const REQUIRED_HEADERS = ['ticker'];

function normalizeHeader(value) {
  return String(value || '').replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[<>]/g, '');
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { value += '"'; i++; } else { quoted = false; }
      } else value += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(value.trim()); value = ''; }
    else if (ch === '\n') {
      row.push(value.trim()); value = '';
      if (row.some((item) => item !== '')) rows.push(row);
      row = [];
    } else if (ch !== '\r') value += ch;
  }
  if (quoted) throw new Error('CSV tidak valid: tanda kutip belum ditutup.');
  row.push(value.trim());
  if (row.some((item) => item !== '')) rows.push(row);
  return rows;
}

function normalizeTicker(value, rowNumber) {
  const ticker = String(value || '').trim().toUpperCase().replace(/\.JK$/, '').replace(/[^A-Z0-9]/g, '');
  if (!ticker || ticker.length > 12) throw new Error('Ticker tidak valid pada baris ' + rowNumber + ': ' + (value || '(kosong)'));
  return ticker;
}

function textOrNull(value) {
  const text = String(value == null ? '' : value).trim();
  return text && text !== '-' ? text : null;
}

function dateOrNull(value, field, rowNumber) {
  const text = textOrNull(value);
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(new Date(text + 'T00:00:00Z').getTime())) {
    throw new Error('Tanggal tidak valid pada baris ' + rowNumber + ', kolom ' + field + ': ' + text);
  }
  return text;
}

function parseMarketStructureCsv(csvText) {
  const source = String(csvText || '').replace(/^\uFEFF/, '');
  const bytes = Buffer.byteLength(source, 'utf8');
  if (!source.trim()) throw new Error('CSV kosong.');
  if (bytes > MAX_CSV_BYTES) throw new Error('Ukuran CSV melebihi batas 2 MB.');

  const csvRows = parseCsv(source);
  if (csvRows.length < 2) throw new Error('CSV tidak memiliki baris data.');
  const headers = csvRows[0].map(normalizeHeader);
  for (const required of REQUIRED_HEADERS) {
    if (!headers.includes(required)) throw new Error('Kolom CSV wajib tidak ditemukan: ' + required);
  }

  const rows = [];
  const seen = new Set();

  for (let index = 1; index < csvRows.length; index++) {
    if (rows.length >= MAX_ROWS) throw new Error('Jumlah data melebihi batas ' + MAX_ROWS + ' baris.');
    const values = csvRows[index];
    if (!values.some((item) => String(item || '').trim() !== '')) continue;

    const rowNumber = index + 1;
    const record = {};
    headers.forEach((header, columnIndex) => { record[header] = values[columnIndex] == null ? '' : values[columnIndex]; });

    const ticker = normalizeTicker(record.ticker, rowNumber);
    if (seen.has(ticker)) throw new Error('Ticker duplikat pada baris ' + rowNumber + ': ' + ticker);
    seen.add(ticker);

    const rawFreeFloat = textOrNull(record.free_float_pct);
    const freeFloatPct = rawFreeFloat == null ? null : risk.normalizeFreeFloatPct(rawFreeFloat.replace('%', '').replace(',', '.'));
    if (rawFreeFloat != null && freeFloatPct == null) {
      throw new Error('free_float_pct tidak valid pada baris ' + rowNumber + ': ' + rawFreeFloat);
    }

    const rawHsc = textOrNull(record.hsc_flag);
    const hscFlag = rawHsc == null ? null : risk.normalizeBoolean(rawHsc);
    if (rawHsc != null && hscFlag == null) {
      throw new Error('hsc_flag tidak valid pada baris ' + rowNumber + ': ' + rawHsc);
    }

    const freeFloatSource = textOrNull(record.free_float_source);
    const freeFloatAsOf = dateOrNull(record.free_float_as_of, 'free_float_as_of', rowNumber);
    const hscSource = textOrNull(record.hsc_source);
    const hscAsOf = dateOrNull(record.hsc_as_of, 'hsc_as_of', rowNumber);

    if (freeFloatPct != null && (!freeFloatSource || !freeFloatAsOf)) {
      throw new Error('Baris ' + rowNumber + ' (' + ticker + ') free float wajib memiliki free_float_source dan free_float_as_of.');
    }
    if (hscFlag != null && (!hscSource || !hscAsOf)) {
      throw new Error('Baris ' + rowNumber + ' (' + ticker + ') HSC wajib memiliki hsc_source dan hsc_as_of.');
    }
    if (freeFloatPct == null && hscFlag == null) {
      throw new Error('Baris ' + rowNumber + ' (' + ticker + ') tidak memiliki free_float_pct maupun hsc_flag.');
    }

    rows.push({
      ticker,
      free_float_pct: freeFloatPct,
      free_float_source: freeFloatPct != null ? freeFloatSource : null,
      free_float_as_of: freeFloatPct != null ? freeFloatAsOf : null,
      hsc_flag: hscFlag,
      hsc_source: hscFlag != null ? hscSource : null,
      hsc_as_of: hscFlag != null ? hscAsOf : null,
      updated_at: new Date().toISOString()
    });
  }

  if (!rows.length) throw new Error('CSV tidak memiliki data yang dapat diproses.');
  return {
    rows,
    summary: {
      row_count: rows.length,
      ticker_count: rows.length,
      sha256: crypto.createHash('sha256').update(source).digest('hex')
    }
  };
}

function chunk(items, size) {
  const result = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

async function upsertMarketStructureRows(supabase, rows) {
  if (!supabase) throw new Error('supabase client is required');
  const tickers = rows.map((row) => row.ticker);
  const existing = new Map();

  for (const tickerBatch of chunk(tickers, UPSERT_BATCH_SIZE)) {
    const lookup = await supabase.from('stock_fundamentals').select('*').in('ticker', tickerBatch);
    if (lookup.error) throw new Error('Load existing stock_fundamentals gagal: ' + lookup.error.message);
    for (const row of lookup.data || []) existing.set(row.ticker, row);
  }

  const merged = rows.map((row) => {
    const current = existing.get(row.ticker) || { ticker: row.ticker };
    const next = Object.assign({}, current, { ticker: row.ticker, updated_at: row.updated_at });
    if (row.free_float_pct != null) {
      next.free_float_pct = row.free_float_pct;
      next.free_float_source = row.free_float_source;
      next.free_float_as_of = row.free_float_as_of;
    }
    if (row.hsc_flag != null) {
      next.hsc_flag = row.hsc_flag;
      next.hsc_source = row.hsc_source;
      next.hsc_as_of = row.hsc_as_of;
    }
    return next;
  });

  let count = 0;
  for (const batch of chunk(merged, UPSERT_BATCH_SIZE)) {
    const result = await supabase.from('stock_fundamentals').upsert(batch, { onConflict: 'ticker' });
    if (result.error) throw new Error('Upsert market structure gagal: ' + result.error.message);
    count += batch.length;
  }
  return count;
}

module.exports = {
  parseMarketStructureCsv,
  upsertMarketStructureRows,
  normalizeTicker
};
