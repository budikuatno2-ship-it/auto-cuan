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
    const freeFloatPct = rawFreeFloat == null ? null : risk.normalizeFreeFloatPct(rawFreeFloat.replace(/%/g, '').replace(',', '.'));
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

function validateRowsAgainstUniverse(rows, allowedTickers) {
  const allowed = new Set((allowedTickers || []).map((ticker) => normalizeTicker(ticker, 'universe')));
  if (!allowed.size) throw new Error('Universe ticker kosong; import diblokir.');

  const rejected = [];
  for (const row of rows || []) {
    if (!allowed.has(row.ticker)) rejected.push(row.ticker);
  }
  if (rejected.length) {
    throw new Error('Ticker di luar universe continuous-auction: ' + rejected.slice(0, 25).join(', ') +
      (rejected.length > 25 ? ' +' + (rejected.length - 25) + ' lainnya' : ''));
  }
  return true;
}

function applyMetric(next, current, incoming, valueField, sourceField, asOfField, label) {
  if (incoming[valueField] == null) return;

  const currentValue = current[valueField];
  const currentAsOf = current[asOfField];
  const incomingAsOf = incoming[asOfField];

  if (currentValue != null && currentAsOf) {
    if (incomingAsOf < currentAsOf) {
      throw new Error('Snapshot ' + label + ' lebih lama untuk ' + incoming.ticker +
        ': incoming ' + incomingAsOf + ' < existing ' + currentAsOf);
    }
    if (incomingAsOf === currentAsOf && String(incoming[valueField]) !== String(currentValue)) {
      throw new Error('Konflik snapshot ' + label + ' tanggal sama untuk ' + incoming.ticker +
        ': incoming=' + incoming[valueField] + ' existing=' + currentValue);
    }
  }

  next[valueField] = incoming[valueField];
  next[sourceField] = incoming[sourceField];
  next[asOfField] = incoming[asOfField];
}

function mergeMarketStructureRows(existingRows, incomingRows) {
  const existing = new Map();
  for (const row of existingRows || []) {
    if (row && row.ticker) existing.set(normalizeTicker(row.ticker, 'existing'), row);
  }

  return (incomingRows || []).map((row) => {
    const current = existing.get(row.ticker) || { ticker: row.ticker };
    const next = Object.assign({}, current, { ticker: row.ticker, updated_at: row.updated_at });

    applyMetric(next, current, row, 'free_float_pct', 'free_float_source', 'free_float_as_of', 'free-float');
    applyMetric(next, current, row, 'hsc_flag', 'hsc_source', 'hsc_as_of', 'HSC');
    applyMetric(next, current, row, 'market_cap', 'market_cap_source', 'market_cap_as_of', 'market-cap');

    return next;
  });
}

async function loadExistingRows(supabase, rows) {
  if (!supabase) throw new Error('supabase client is required');
  const tickers = rows.map((row) => row.ticker);
  const existing = [];

  for (const tickerBatch of chunk(tickers, UPSERT_BATCH_SIZE)) {
    const lookup = await supabase.from('stock_fundamentals').select('*').in('ticker', tickerBatch);
    if (lookup.error) throw new Error('Load existing stock_fundamentals gagal: ' + lookup.error.message);
    existing.push(...(lookup.data || []));
  }
  return existing;
}

async function prepareMarketStructureRows(supabase, rows) {
  const existing = await loadExistingRows(supabase, rows);
  return mergeMarketStructureRows(existing, rows);
}

async function upsertMarketStructureRows(supabase, rows) {
  if (!supabase || typeof supabase.rpc !== 'function') {
    throw new Error('supabase client with rpc() is required');
  }

  let count = 0;
  for (const batch of chunk(rows || [], UPSERT_BATCH_SIZE)) {
    const result = await supabase.rpc('upsert_verified_market_structure_rows', { p_rows: batch });
    if (result.error) {
      throw new Error('Atomic market structure upsert gagal: ' + result.error.message);
    }
    const written = Number(result.data);
    if (!Number.isFinite(written) || written !== batch.length) {
      throw new Error('Atomic market structure upsert count mismatch: expected ' +
        batch.length + ', got ' + String(result.data));
    }
    count += written;
  }
  return count;
}

module.exports = {
  parseMarketStructureCsv,
  validateRowsAgainstUniverse,
  mergeMarketStructureRows,
  prepareMarketStructureRows,
  upsertMarketStructureRows,
  normalizeTicker
};
