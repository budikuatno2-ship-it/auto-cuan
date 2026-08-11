#!/usr/bin/env node
'use strict';

/**
 * Import local CSV fundamentals data into Supabase stock_fundamentals.
 *
 * PBV requires book-value-per-share data that no automatic, already-trusted
 * source in this repository provides (see lib/daily-pbv.js and
 * lib/admin-fundamentals-upload.js for the full reasoning). This is the
 * CLI import path — same CSV format/validation as the admin upload action
 * (api/admin-users.js?action=fundamentals_upload), just driven from a local
 * file instead of a browser upload.
 *
 * Usage:
 *   node tools/import-fundamentals.js [csvPath]
 *   node tools/import-fundamentals.js [csvPath] --dry-run
 *
 * Default CSV path:
 *   data/fundamentals.csv
 *
 * Required CSV columns (header row, case-insensitive):
 *   ticker, fundamental_period, source, and EITHER
 *   book_value_per_share OR both equity and shares_outstanding.
 * See lib/admin-fundamentals-upload.js for full column documentation.
 *
 * Required environment variables (skipped in --dry-run):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Idempotent: upserts on `ticker`, safe to re-run with corrected data.
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { parseFundamentalsCsv } = require('../lib/admin-fundamentals-upload');

const DEFAULT_CSV = path.join('data', 'fundamentals.csv');

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--dry-run');
  const isDryRun = process.argv.includes('--dry-run');
  const csvPath = path.resolve(args[0] || DEFAULT_CSV);

  if (!fs.existsSync(csvPath)) throw new Error('CSV file not found: ' + csvPath);
  const csvText = fs.readFileSync(csvPath, 'utf8');

  const parsed = parseFundamentalsCsv(csvText);
  console.log('[import-fundamentals] Parsed ' + parsed.rows.length + ' rows from ' + csvPath);
  console.log('[import-fundamentals] sha256=' + parsed.summary.sha256);

  if (isDryRun) {
    console.log('[import-fundamentals] --dry-run: validation only, no writes performed.');
    parsed.rows.forEach((r) => console.log('  ' + r.ticker + ' (' + r.fundamental_period + ', source=' + r.source + ')'));
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');

  const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const UPSERT_CHUNK = 200;
  let upserted = 0;
  for (let i = 0; i < parsed.rows.length; i += UPSERT_CHUNK) {
    const batch = parsed.rows.slice(i, i + UPSERT_CHUNK);
    const { error } = await supabase.from('stock_fundamentals').upsert(batch, { onConflict: 'ticker' });
    if (error) throw new Error('Upsert failed: ' + error.message);
    upserted += batch.length;
  }

  console.log('[import-fundamentals] Upserted ' + upserted + ' rows into stock_fundamentals.');
}

main().catch((e) => {
  console.error('[import-fundamentals] Error:', e && e.message);
  process.exit(1);
});
