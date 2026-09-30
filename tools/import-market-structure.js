#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const marketImport = require('../lib/market-structure-import');

const DEFAULT_CSV = path.join('data', 'market-structure.csv');

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== '--dry-run');
  const dryRun = process.argv.includes('--dry-run');
  const csvPath = path.resolve(args[0] || DEFAULT_CSV);

  if (!fs.existsSync(csvPath)) throw new Error('CSV file not found: ' + csvPath);
  const parsed = marketImport.parseMarketStructureCsv(fs.readFileSync(csvPath, 'utf8'));

  console.log('[import-market-structure] Parsed ' + parsed.rows.length + ' rows');
  console.log('[import-market-structure] sha256=' + parsed.summary.sha256);

  if (dryRun) {
    parsed.rows.forEach((row) => {
      console.log(
        '  ' + row.ticker +
        ' free_float=' + (row.free_float_pct == null ? 'N/A' : row.free_float_pct + '%') +
        ' hsc=' + (row.hsc_flag == null ? 'UNKNOWN' : String(row.hsc_flag))
      );
    });
    console.log('[import-market-structure] --dry-run: no writes performed.');
    return;
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');

  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const count = await marketImport.upsertMarketStructureRows(supabase, parsed.rows);
  console.log('[import-market-structure] Upserted ' + count + ' rows into stock_fundamentals.');
}

main().catch((error) => {
  console.error('[import-market-structure] Error:', error && error.message || error);
  process.exit(1);
});
