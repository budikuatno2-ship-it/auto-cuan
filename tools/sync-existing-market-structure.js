#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const fcaTransition = require('../lib/fca-transition-2026');
const risk = require('../lib/market-structure-risk');
const marketImport = require('../lib/market-structure-import');
const existingSync = require('../lib/market-structure-existing-sync');
const historyStore = require('../lib/stock-daily-history-store');

const ROOT = path.resolve(__dirname, '..');
const MARKET_PATH = path.join(ROOT, 'data', 'market-structure', 'latest.json');
const HSC_PATH = path.join(ROOT, 'data', 'market-structure', 'hsc', 'current-2026.json');
const CHUNK_SIZE = 200;

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

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
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
    .filter(Boolean)
    .sort();
}

async function syncExistingDailyFeatureRows(supabase, sourceRows) {
  const sourceByTicker = new Map(sourceRows.map((row) => [row.ticker, row]));
  const existingFeatures = [];

  for (const batch of chunk(Array.from(sourceByTicker.keys()), CHUNK_SIZE)) {
    const result = await supabase.from('stock_daily_features').select('*').in('ticker', batch);
    if (result.error) throw new Error('Load stock_daily_features gagal: ' + result.error.message);
    existingFeatures.push(...(result.data || []));
  }

  const updates = [];
  for (const feature of existingFeatures) {
    const source = sourceByTicker.get(feature.ticker);
    if (!source) continue;

    const context = risk.buildMarketStructureContext(source);
    updates.push(Object.assign({}, feature, {
      free_float_pct: context.free_float_pct,
      free_float_source: context.free_float_source,
      free_float_as_of: context.free_float_as_of,
      hsc_flag: context.hsc_flag,
      hsc_source: context.hsc_source,
      hsc_as_of: context.hsc_as_of,
      market_structure_status: context.market_structure_status,
      market_structure_guard: context.market_structure_guard,
      market_structure_note: context.market_structure_note
    }));
  }

  if (!updates.length) return 0;
  return historyStore.upsertDailyFeatures(supabase, updates);
}

async function main() {
  const apply = process.argv.includes('--apply');
  if (!fs.existsSync(MARKET_PATH)) throw new Error('Existing market structure file tidak ditemukan: ' + MARKET_PATH);
  if (!fs.existsSync(HSC_PATH)) throw new Error('Existing HSC file tidak ditemukan: ' + HSC_PATH);

  const marketPayload = JSON.parse(fs.readFileSync(MARKET_PATH, 'utf8'));
  const hscPayload = JSON.parse(fs.readFileSync(HSC_PATH, 'utf8'));

  loadLocalEnv();
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');

  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const universe = await loadEligibleUniverse(supabase);

  const built = existingSync.buildExistingMarketStructureRows(marketPayload, hscPayload, universe);
  marketImport.validateRowsAgainstUniverse(built.rows, universe);

  const prepared = await marketImport.prepareMarketStructureRows(supabase, built.rows);

  console.log('=== EXISTING MARKET STRUCTURE SYNC ===');
  console.log('Mode: ' + (apply ? 'APPLY' : 'VALIDATE_ONLY'));
  console.log('Eligible universe: ' + built.summary.eligible_count);
  console.log('Market stocks: ' + built.summary.market_stock_count);
  console.log('Free Float verified: ' + built.summary.free_float_verified + '/' + built.summary.eligible_count);
  console.log('Missing Free Float: ' + built.summary.missing_free_float.length +
    (built.summary.missing_free_float.length ? ' [' + built.summary.missing_free_float.join(', ') + ']' : ''));
  console.log('HSC dataset tickers: ' + built.summary.hsc_dataset_count);
  console.log('HSC verified in universe: ' + built.summary.hsc_verified_in_universe);
  console.log('HSC active/revoked in universe: ' +
    built.summary.hsc_active_in_universe + '/' + built.summary.hsc_revoked_in_universe);
  console.log('Prepared fundamentals rows: ' + prepared.length);

  if (!apply) {
    console.log('Validation passed. No writes performed.');
    console.log('Run again with --apply to sync existing data into Supabase.');
    return;
  }

  const fundamentalsCount = await marketImport.upsertMarketStructureRows(supabase, built.rows);
  const featureCount = await syncExistingDailyFeatureRows(supabase, built.rows);

  console.log('Fundamentals upserted: ' + fundamentalsCount);
  console.log('Daily feature rows refreshed: ' + featureCount);
  console.log('Sync complete. Run tools/audit-market-structure-coverage.js next.');
}

main().catch((error) => {
  console.error('[sync-existing-market-structure] Error:', error && error.message || error);
  process.exit(1);
});

module.exports = {
  loadEligibleUniverse,
  syncExistingDailyFeatureRows,
  main
};
