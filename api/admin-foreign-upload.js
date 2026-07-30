'use strict';

const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { requireAdminSession, isSameOrigin } = require('../lib/admin-session');

const MAX_CSV_BYTES = 3 * 1024 * 1024;
const MAX_ROWS = 5000;
const UPSERT_BATCH_SIZE = 200;
const RETENTION_TICKER_BATCH_SIZE = 50;
const DELETE_BATCH_SIZE = 200;
const REQUIRED_HEADERS = [
  'date', 'ticker', 'open', 'high', 'low', 'close',
  'volume', 'freq', 'valuasi', 'nbsa'
];

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

function normalizeHeader(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[<>]/g, '');
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          value += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        value += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(value.trim());
      value = '';
    } else if (ch === '\n') {
      row.push(value.trim());
      value = '';
      if (row.some((item) => item !== '')) rows.push(row);
      row = [];
    } else if (ch !== '\r') {
      value += ch;
    }
  }

  if (quoted) throw new Error('CSV tidak valid: tanda kutip belum ditutup.');
  row.push(value.trim());
  if (row.some((item) => item !== '')) rows.push(row);
  return rows;
}

function normalizeDate(value, rowNumber) {
  const raw = String(value || '').trim();
  let iso = raw;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (us) {
    iso = `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new Error(`Tanggal tidak valid pada baris ${rowNumber}: ${raw || '(kosong)'}`);
  }

  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) {
    throw new Error(`Tanggal tidak valid pada baris ${rowNumber}: ${raw}`);
  }
  return iso;
}

function normalizeTicker(value, rowNumber) {
  const ticker = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\.JK$/, '')
    .replace(/[^A-Z0-9]/g, '');

  if (!ticker || ticker.length > 12) {
    throw new Error(`Ticker tidak valid pada baris ${rowNumber}: ${value || '(kosong)'}`);
  }
  return ticker;
}

function parseNumber(value, field, rowNumber) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw || raw === '-' || raw.toLowerCase() === 'null') return null;
  const number = Number(raw.replace(/,/g, ''));
  if (!Number.isFinite(number)) {
    throw new Error(`Angka tidak valid pada baris ${rowNumber}, kolom ${field}: ${raw}`);
  }
  return number;
}

function parseForeignCsv(csvText) {
  const source = String(csvText || '').replace(/^\uFEFF/, '');
  const byteLength = Buffer.byteLength(source, 'utf8');
  if (!source.trim()) throw new Error('CSV kosong.');
  if (byteLength > MAX_CSV_BYTES) {
    const error = new Error('Ukuran CSV melebihi batas 3 MB.');
    error.statusCode = 413;
    throw error;
  }

  const csvRows = parseCsv(source);
  if (csvRows.length < 2) throw new Error('CSV tidak memiliki baris data.');

  const headers = csvRows[0].map(normalizeHeader);
  for (const required of REQUIRED_HEADERS) {
    if (!headers.includes(required)) {
      throw new Error(`Kolom CSV wajib tidak ditemukan: ${required}`);
    }
  }

  const rows = [];
  const seen = new Set();
  const dates = new Set();
  const tickers = new Set();

  for (let index = 1; index < csvRows.length; index += 1) {
    const values = csvRows[index];
    if (!values.some((item) => String(item || '').trim() !== '')) continue;
    if (rows.length >= MAX_ROWS) {
      throw new Error(`Jumlah data melebihi batas ${MAX_ROWS} baris.`);
    }

    const rowNumber = index + 1;
    const record = {};
    headers.forEach((header, columnIndex) => {
      record[header] = values[columnIndex] == null ? '' : values[columnIndex];
    });

    const tradeDate = normalizeDate(record.date, rowNumber);
    const ticker = normalizeTicker(record.ticker, rowNumber);
    const key = `${tradeDate}|${ticker}`;
    if (seen.has(key)) {
      throw new Error(`Data duplikat ${key} pada baris ${rowNumber}.`);
    }
    seen.add(key);

    const close = parseNumber(record.close, 'close', rowNumber);
    const nbsa = parseNumber(record.nbsa, 'nbsa', rowNumber);

    rows.push({
      trade_date: tradeDate,
      ticker,
      foreign_buy: null,
      foreign_sell: null,
      foreign_net: close == null || nbsa == null ? null : close * nbsa,
      close,
      volume: parseNumber(record.volume, 'volume', rowNumber),
      freq: parseNumber(record.freq, 'freq', rowNumber),
      valuasi: parseNumber(record.valuasi, 'valuasi', rowNumber),
      nbsa,
      source: 'admin_web_csv',
      uploaded_at: new Date().toISOString()
    });

    dates.add(tradeDate);
    tickers.add(ticker);
  }

  if (rows.length === 0) throw new Error('CSV tidak memiliki data yang dapat diproses.');

  const sortedDates = Array.from(dates).sort();
  return {
    rows,
    summary: {
      row_count: rows.length,
      ticker_count: tickers.size,
      date_count: dates.size,
      first_date: sortedDates[0],
      last_date: sortedDates[sortedDates.length - 1],
      sha256: crypto.createHash('sha256').update(source).digest('hex')
    }
  };
}

function chunk(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

async function upsertRows(supabase, rows) {
  let upserted = 0;
  for (const batch of chunk(rows, UPSERT_BATCH_SIZE)) {
    const result = await supabase
      .from('foreign_watchlist_daily')
      .upsert(batch, { onConflict: 'trade_date,ticker' });
    if (result.error) throw new Error(`Upsert foreign gagal: ${result.error.message}`);
    upserted += batch.length;
  }
  return upserted;
}

async function enforceRetention(supabase, tickers) {
  let deleted = 0;

  for (const tickerBatch of chunk(tickers, RETENTION_TICKER_BATCH_SIZE)) {
    const lookup = await supabase
      .from('foreign_watchlist_daily')
      .select('id,ticker,trade_date')
      .in('ticker', tickerBatch)
      .order('trade_date', { ascending: false });

    if (lookup.error) throw new Error(`Retention lookup gagal: ${lookup.error.message}`);

    const byTicker = new Map();
    for (const row of lookup.data || []) {
      if (!byTicker.has(row.ticker)) byTicker.set(row.ticker, []);
      byTicker.get(row.ticker).push(row);
    }

    const deleteIds = [];
    for (const tickerRows of byTicker.values()) {
      const datesKept = new Set();
      for (const row of tickerRows) {
        if (datesKept.has(row.trade_date)) continue;
        if (datesKept.size < 7) {
          datesKept.add(row.trade_date);
        } else {
          deleteIds.push(row.id);
        }
      }
    }

    for (const idBatch of chunk(deleteIds, DELETE_BATCH_SIZE)) {
      const removal = await supabase
        .from('foreign_watchlist_daily')
        .delete()
        .in('id', idBatch);
      if (removal.error) throw new Error(`Retention delete gagal: ${removal.error.message}`);
      deleted += idBatch.length;
    }
  }

  return deleted;
}

function authenticate(req, res) {
  if (!isSameOrigin(req)) {
    res.status(403).json({ success: false, error: 'Permintaan ditolak.' });
    return null;
  }

  const auth = requireAdminSession(req);
  if (!auth.ok) {
    res.status(auth.status).json({ success: false, error: auth.error });
    return null;
  }

  if (String(auth.session.un || '').trim().toLowerCase() !== 'budi') {
    res.status(403).json({ success: false, error: 'Akses admin ditolak.' });
    return null;
  }

  return auth;
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  if (!authenticate(req, res)) return;

  const action = String(req.body && req.body.action || '').trim().toLowerCase();
  const csv = req.body && req.body.csv;

  try {
    const parsed = parseForeignCsv(csv);

    if (action === 'preview') {
      return res.status(200).json({
        success: true,
        preview: true,
        summary: parsed.summary
      });
    }

    if (action !== 'import') {
      return res.status(400).json({ success: false, error: 'Action tidak valid.' });
    }

    const supabase = getSupabase();
    if (!supabase) {
      return res.status(503).json({ success: false, error: 'Database belum dikonfigurasi.' });
    }

    const upsertedCount = await upsertRows(supabase, parsed.rows);
    const uniqueTickers = Array.from(new Set(parsed.rows.map((row) => row.ticker))).sort();
    const deletedOldCount = await enforceRetention(supabase, uniqueTickers);

    return res.status(200).json({
      success: true,
      imported_count: parsed.rows.length,
      upserted_count: upsertedCount,
      deleted_old_count: deletedOldCount,
      summary: parsed.summary
    });
  } catch (error) {
    const status = Number(error && error.statusCode) || 400;
    return res.status(status).json({
      success: false,
      error: error && error.message ? error.message : 'Import foreign gagal.'
    });
  }
}

handler._test = {
  normalizeDate,
  normalizeTicker,
  parseForeignCsv
};

module.exports = handler;
