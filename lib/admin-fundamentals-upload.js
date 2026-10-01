'use strict';

/**
 * Admin Fundamentals Upload — CSV import into stock_fundamentals.
 *
 * PBV requires book-value-per-share (or equity + shares_outstanding) data
 * that no automatic, already-trusted source in this repository provides
 * (see lib/daily-pbv.js and the repository audit — Yahoo's chart endpoint,
 * the only Yahoo endpoint this project already uses, does not return
 * fundamentals; Yahoo's quoteSummary/fundamentals endpoint has no precedent
 * in this codebase and is known to require fragile crumb/cookie auth with
 * unreliable coverage for IDX small/mid-cap tickers). Rather than fabricate
 * or bolt on an unverified scraping dependency, fundamentals are imported
 * here the same way foreign flow already is (lib/admin-foreign-upload.js):
 * an idempotent CSV upload with clear provenance.
 *
 * Expected CSV columns (header row required, case-insensitive):
 *   ticker                — required, IDX ticker (e.g. BBCA)
 *   book_value_per_share   — optional numeric; used directly if present
 *   equity                 — optional numeric; used with shares_outstanding
 *                             to derive BVPS when book_value_per_share is absent
 *   shares_outstanding     — optional numeric; paired with equity
 *   fundamental_period      — required, e.g. "FY2025" or "Q2-2026"
 *   source                  — required, e.g. "idx_annual_report_2025" or
 *                              "manual_entry_2026-08-11"
 *
 * Each row must provide EITHER book_value_per_share OR both equity and
 * shares_outstanding — otherwise PBV can never be computed for that row,
 * so the row is rejected at parse time rather than silently stored as
 * unusable. Numbers are never fabricated: a blank/missing optional field
 * stays null.
 */

const crypto = require('node:crypto');

const MAX_CSV_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 3000;
const UPSERT_BATCH_SIZE = 200;
const REQUIRED_HEADERS = ['ticker', 'fundamental_period', 'source'];

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
        if (text[i + 1] === '"') { value += '"'; i += 1; } else { quoted = false; }
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

function normalizeTicker(value, rowNumber) {
  const ticker = String(value || '').trim().toUpperCase().replace(/\.JK$/, '').replace(/[^A-Z0-9]/g, '');
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

function requireText(value, field, rowNumber) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw new Error(`Kolom wajib kosong pada baris ${rowNumber}: ${field}`);
  return text;
}

function parseFundamentalsCsv(csvText) {
  const source = String(csvText || '').replace(/^\uFEFF/, '');
  const byteLength = Buffer.byteLength(source, 'utf8');
  if (!source.trim()) throw new Error('CSV kosong.');
  if (byteLength > MAX_CSV_BYTES) {
    const error = new Error('Ukuran CSV melebihi batas 2 MB.');
    error.statusCode = 413;
    throw error;
  }

  const csvRows = parseCsv(source);
  if (csvRows.length < 2) throw new Error('CSV tidak memiliki baris data.');

  const headers = csvRows[0].map(normalizeHeader);
  for (const required of REQUIRED_HEADERS) {
    if (!headers.includes(required)) throw new Error(`Kolom CSV wajib tidak ditemukan: ${required}`);
  }
  const hasBvps = headers.includes('book_value_per_share');
  const hasEquityPair = headers.includes('equity') && headers.includes('shares_outstanding');
  if (!hasBvps && !hasEquityPair) {
    throw new Error('CSV harus memiliki kolom book_value_per_share, atau kedua kolom equity dan shares_outstanding.');
  }

  const rows = [];
  const seen = new Set();

  for (let index = 1; index < csvRows.length; index += 1) {
    const values = csvRows[index];
    if (!values.some((item) => String(item || '').trim() !== '')) continue;
    if (rows.length >= MAX_ROWS) throw new Error(`Jumlah data melebihi batas ${MAX_ROWS} baris.`);

    const rowNumber = index + 1;
    const record = {};
    headers.forEach((header, columnIndex) => {
      record[header] = values[columnIndex] == null ? '' : values[columnIndex];
    });

    const ticker = normalizeTicker(record.ticker, rowNumber);
    if (seen.has(ticker)) throw new Error(`Ticker duplikat pada baris ${rowNumber}: ${ticker}`);
    seen.add(ticker);

    const bookValuePerShare = hasBvps ? parseNumber(record.book_value_per_share, 'book_value_per_share', rowNumber) : null;
    const equity = hasEquityPair ? parseNumber(record.equity, 'equity', rowNumber) : null;
    const sharesOutstanding = hasEquityPair ? parseNumber(record.shares_outstanding, 'shares_outstanding', rowNumber) : null;

    const canDeriveBvps = bookValuePerShare != null || (equity != null && sharesOutstanding != null && sharesOutstanding > 0);
    if (!canDeriveBvps) {
      throw new Error(`Baris ${rowNumber} (${ticker}) tidak memiliki data cukup untuk menghitung book value per share.`);
    }

    rows.push({
      ticker,
      book_value_per_share: bookValuePerShare,
      equity,
      shares_outstanding: sharesOutstanding,
      fundamental_period: requireText(record.fundamental_period, 'fundamental_period', rowNumber),
      source: requireText(record.source, 'source', rowNumber),
      updated_at: new Date().toISOString()
    });
  }

  if (rows.length === 0) throw new Error('CSV tidak memiliki data yang dapat diproses.');

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
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

async function upsertRows(supabase, rows) {
  let upserted = 0;
  for (const batch of chunk(rows, UPSERT_BATCH_SIZE)) {
    const result = await supabase.from('stock_fundamentals').upsert(batch, { onConflict: 'ticker' });
    if (result.error) throw new Error(`Upsert fundamentals gagal: ${result.error.message}`);
    upserted += batch.length;
  }
  return upserted;
}

async function handleAdminFundamentalsUpload(req, res, supabase) {
  const mode = String(req.body && req.body.mode || '').trim().toLowerCase();
  const csv = req.body && req.body.csv;

  try {
    const parsed = parseFundamentalsCsv(csv);

    if (mode === 'preview') {
      return res.status(200).json({ success: true, preview: true, summary: parsed.summary });
    }

    if (mode !== 'import') {
      return res.status(400).json({ success: false, error: 'Mode tidak valid.' });
    }

    if (!supabase) {
      return res.status(503).json({ success: false, error: 'Database belum dikonfigurasi.' });
    }

    const upsertedCount = await upsertRows(supabase, parsed.rows);

    return res.status(200).json({
      success: true,
      imported_count: parsed.rows.length,
      upserted_count: upsertedCount,
      summary: parsed.summary
    });
  } catch (error) {
    const status = Number(error && error.statusCode) || 400;
    return res.status(status).json({
      success: false,
      error: error && error.message ? error.message : 'Import fundamentals gagal.'
    });
  }
}

module.exports = {
  handleAdminFundamentalsUpload,
  parseFundamentalsCsv,
  normalizeTicker,
  REQUIRED_HEADERS
};
