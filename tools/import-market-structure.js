#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const fcaTransition = require('../lib/fca-transition-2026');
const marketImport = require('../lib/market-structure-import');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_CSV = path.join(ROOT, 'data', 'market-structure.csv');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, 'utf8');
  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) return;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = value;
  });
}

function loadLocalEnv() {
  [
    path.join(ROOT, '.env.ai-eval-once'),
    path.join(ROOT, '.env.local'),
    path.join(ROOT, '.env')
  ].forEach(loadEnvFile);
}

async function loadEligibleUniverse(supabase) {
  const result = await supabase
    .from('stock_boards')
    .select('ticker,company_name,board,is_fca,is_active,note')
    .limit(2000);
  if (result.error) throw new Error('Load stock_boards gagal: ' + result.error.message);

  return (result.data || [])
    .filter((row) => fcaTransition.isEligibleContinuousAuctionRow(row))
    .map((row) => String(row.ticker || '').trim().toUpperCase())
    .filter(Boolean);
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const apply = rawArgs.includes('--apply');
  const explicitDryRun = rawArgs.includes('--dry-run');
  if (apply && explicitDryRun) throw new Error('Gunakan salah satu: --apply atau --dry-run, bukan keduanya.');

  const positional = rawArgs.filter((arg) => !arg.startsWith('--'));
  const csvPath = path.resolve(positional[0] || DEFAULT_CSV);

  if (!fs.existsSync(csvPath)) throw new Error('CSV file not found: ' + csvPath);
  const parsed = marketImport.parseMarketStructureCsv(fs.readFileSync(csvPath, 'utf8'));

  loadLocalEnv();
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');

  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const universe = await loadEligibleUniverse(supabase);
  marketImport.validateRowsAgainstUniverse(parsed.rows, universe);

  const prepared = await marketImport.prepareMarketStructureRows(supabase, parsed.rows);
  const freeFloatRows = parsed.rows.filter((row) => row.free_float_pct != null).length;
  const hscRows = parsed.rows.filter((row) => row.hsc_flag != null).length;

  console.log('[import-market-structure] mode=' + (apply ? 'APPLY' : 'VALIDATE_ONLY'));
  console.log('[import-market-structure] parsed=' + parsed.rows.length +
    ' free_float=' + freeFloatRows + ' hsc=' + hscRows);
  console.log('[import-market-structure] eligible_universe=' + universe.length);
  console.log('[import-market-structure] sha256=' + parsed.summary.sha256);
  console.log('[import-market-structure] prepared=' + prepared.length);

  if (!apply) {
    console.log('[import-market-structure] Validation passed. No writes performed.');
    console.log('[import-market-structure] Re-run with --apply only after reviewing this SHA256 and source file.');
    return;
  }

  const count = await marketImport.upsertMarketStructureRows(supabase, parsed.rows);
  console.log('[import-market-structure] Upserted ' + count + ' rows into stock_fundamentals.');
}

main().catch((error) => {
  console.error('[import-market-structure] Error:', error && error.message || error);
  process.exit(1);
});
