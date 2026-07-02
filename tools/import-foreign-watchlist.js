#!/usr/bin/env node
'use strict';

/**
 * Import local CSV foreign flow watchlist data into Supabase.
 *
 * Usage:
 *   node tools/import-foreign-watchlist.js [csvPath]
 *
 * Default CSV path:
 *   data/foreign-watchlist.csv
 *
 * Required environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const TABLE = 'foreign_watchlist_daily';
const DEFAULT_CSV = path.join('data', 'foreign-watchlist.csv');

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((v) => String(v || '').trim());
}

function parseNumber(value, field, rowNum) {
  const raw = String(value == null ? '' : value).trim();
  if (raw === '') return null;
  const cleaned = raw.replace(/,/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) throw new Error('Invalid numeric value at row ' + rowNum + ' field ' + field + ': ' + raw);
  return n;
}

function normalizeTicker(value, rowNum) {
  const ticker = String(value || '').trim().toUpperCase().replace(/\.JK$/, '');
  if (!/^[A-Z0-9]{2,12}$/.test(ticker)) throw new Error('Invalid ticker at row ' + rowNum + ': ' + value);
  return ticker;
}

function normalizeDate(value, rowNum) {
  const s = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('Invalid trade_date at row ' + rowNum + ': ' + value);
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new Error('Invalid trade_date at row ' + rowNum + ': ' + value);
  return s;
}

function readRows(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const required = ['trade_date', 'ticker', 'foreign_buy', 'foreign_sell', 'foreign_net'];
  required.forEach((h) => {
    if (!headers.includes(h)) throw new Error('Missing CSV column: ' + h);
  });

  const rows = [];
  const seen = new Set();
  for (let i = 1; i < lines.length; i++) {
    const rowNum = i + 1;
    const cols = parseCsvLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = cols[idx]; });
    const tradeDate = normalizeDate(obj.trade_date, rowNum);
    const ticker = normalizeTicker(obj.ticker, rowNum);
    const key = tradeDate + '|' + ticker;
    if (seen.has(key)) throw new Error('Duplicate CSV row for ' + key + ' at row ' + rowNum);
    seen.add(key);
    rows.push({
      trade_date: tradeDate,
      ticker: ticker,
      foreign_buy: parseNumber(obj.foreign_buy, 'foreign_buy', rowNum),
      foreign_sell: parseNumber(obj.foreign_sell, 'foreign_sell', rowNum),
      foreign_net: parseNumber(obj.foreign_net, 'foreign_net', rowNum),
      source: 'csv',
      uploaded_at: new Date().toISOString()
    });
  }
  return rows;
}

async function deleteOldRows(supabase, tickers) {
  let deleted = 0;
  const RETENTION_CHUNK = 8;
  async function cleanupTicker(ticker) {
    const { data: dateRows, error: dateErr } = await supabase
      .from(TABLE)
      .select('trade_date')
      .eq('ticker', ticker)
      .order('trade_date', { ascending: false });
    if (dateErr) throw new Error('Retention read failed for ' + ticker + ': ' + dateErr.message);

    const uniqueDates = Array.from(new Set((dateRows || []).map((r) => r.trade_date))).filter(Boolean);
    const keepDates = uniqueDates.slice(0, 7);
    if (uniqueDates.length <= 7) return 0;

    const { data: oldRows, error: oldErr } = await supabase
      .from(TABLE)
      .select('id')
      .eq('ticker', ticker)
      .not('trade_date', 'in', '(' + keepDates.join(',') + ')');
    if (oldErr) throw new Error('Retention lookup failed for ' + ticker + ': ' + oldErr.message);
    const oldIds = (oldRows || []).map((r) => r.id);
    if (oldIds.length === 0) return 0;

    const { error: delErr } = await supabase.from(TABLE).delete().in('id', oldIds);
    if (delErr) throw new Error('Retention delete failed for ' + ticker + ': ' + delErr.message);
    return oldIds.length;
  }
  // Parallelize retention in bounded chunks (was fully sequential — slow for many tickers).
  for (let i = 0; i < tickers.length; i += RETENTION_CHUNK) {
    const chunk = tickers.slice(i, i + RETENTION_CHUNK);
    const results = await Promise.all(chunk.map(cleanupTicker));
    results.forEach((n) => { deleted += n; });
  }
  return deleted;
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function upsertChunkWithRetry(supabase, chunk, chunkLabel, maxAttempts) {
  maxAttempts = maxAttempts || 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { data, error } = await supabase.from(TABLE).upsert(chunk, { onConflict: 'trade_date,ticker' }).select('ticker,trade_date');
      if (error) throw new Error(error.message);
      return { data: data, attempts: attempt };
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) {
        const backoffMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
        console.log('[import-foreign-watchlist] ' + chunkLabel + ' attempt ' + attempt + ' failed: ' + (e.message || e) + ' — retrying in ' + backoffMs + 'ms');
        await delay(backoffMs);
      }
    }
  }
  throw new Error(chunkLabel + ' failed after ' + maxAttempts + ' attempts: ' + (lastErr ? lastErr.message : 'unknown'));
}

async function main() {
  const csvPath = path.resolve(process.argv[2] || DEFAULT_CSV);
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  if (!fs.existsSync(csvPath)) throw new Error('CSV file not found: ' + csvPath);

  const rows = readRows(csvPath);
  if (rows.length === 0) {
    console.log('No CSV rows to import.');
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } });

  // Chunked upsert with retry — smaller chunks avoid timeouts; idempotent on (trade_date,ticker).
  const UPSERT_CHUNK = 200;
  let upsertReturned = 0;
  let totalRetryAttempts = 0;
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    const chunkNum = Math.floor(i / UPSERT_CHUNK) + 1;
    const chunkTotal = Math.ceil(rows.length / UPSERT_CHUNK);
    const label = 'Batch ' + chunkNum + '/' + chunkTotal + ' (' + chunk.length + ' rows)';
    const result = await upsertChunkWithRetry(supabase, chunk, label, 3);
    upsertReturned += (result.data && result.data.length) || chunk.length;
    totalRetryAttempts += (result.attempts - 1);
    console.log('[import-foreign-watchlist] ' + label + ' OK (attempt ' + result.attempts + ')');
  }

  const tickers = Array.from(new Set(rows.map((r) => r.ticker))).sort();
  const deleted = await deleteOldRows(supabase, tickers);
  const latestDate = rows.map((r) => r.trade_date).sort().slice(-1)[0];

  console.log('Foreign watchlist import summary');
  console.log('Imported rows: ' + rows.length);
  console.log('Upsert returned rows: ' + upsertReturned);
  console.log('Retry attempts (extra): ' + totalRetryAttempts);
  console.log('Deleted old rows: ' + deleted);
  console.log('Ticker count: ' + tickers.length);
  console.log('Latest date: ' + latestDate);
}

main().catch((err) => {
  console.error('[import-foreign-watchlist] ERROR: ' + err.message);
  process.exit(1);
});
