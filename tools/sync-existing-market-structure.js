#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getVpsMarketStore } = require('../lib/vps-market-store');
const fcaTransition = require('../lib/fca-transition-2026');
const risk = require('../lib/market-structure-risk');
const marketImport = require('../lib/market-structure-import');
const existingSync = require('../lib/market-structure-existing-sync');
const historyStore = require('../lib/stock-daily-history-store');

const ROOT = path.resolve(__dirname, '..');
const MARKET_PATH = process.env.AUTO_CUAN_MARKET_STRUCTURE_PATH ||
  path.join(ROOT, 'data', 'market-structure', 'latest.json');
const HSC_PATH = process.env.AUTO_CUAN_HSC_PATH ||
  path.join(ROOT, 'data', 'market-structure', 'hsc', 'current-2026.json');
const CHUNK_SIZE = 200;

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function loadEligibleUniverse(store) {
  const result = await store
    .from('stock_boards')
    .select('ticker,company_name,board,is_fca,is_active,note')
    .limit(2000);
  if (result.error) throw new Error('Load stock_boards VPS gagal: ' + result.error.message);

  return (result.data || [])
    .filter((row) => fcaTransition.isEligibleContinuousAuctionRow(row))
    .map((row) => String(row.ticker || '').trim().toUpperCase())
    .filter(Boolean)
    .sort();
}

async function syncExistingDailyFeatureRows(store, sourceRows) {
  const sourceByTicker = new Map(sourceRows.map((row) => [row.ticker, row]));
  const existingFeatures = [];

  for (const batch of chunk(Array.from(sourceByTicker.keys()), CHUNK_SIZE)) {
    const result = await store.from('stock_daily_features').select('*').in('ticker', batch);
    if (result.error) throw new Error('Load stock_daily_features VPS gagal: ' + result.error.message);
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
  return historyStore.upsertDailyFeatures(store, updates);
}

async function upsertPreparedFundamentals(store, rows) {
  let count = 0;
  for (const batch of chunk(rows || [], CHUNK_SIZE)) {
    const result = await store
      .from('stock_fundamentals')
      .upsert(batch, { onConflict: 'ticker' });
    if (result.error) throw new Error('Upsert stock_fundamentals VPS gagal: ' + result.error.message);
    count += batch.length;
  }
  return count;
}

async function main() {
  const apply = process.argv.includes('--apply');
  if (!fs.existsSync(MARKET_PATH)) throw new Error('Existing market structure file tidak ditemukan: ' + MARKET_PATH);
  if (!fs.existsSync(HSC_PATH)) throw new Error('Existing HSC file tidak ditemukan: ' + HSC_PATH);

  const marketPayload = JSON.parse(fs.readFileSync(MARKET_PATH, 'utf8'));
  const hscPayload = JSON.parse(fs.readFileSync(HSC_PATH, 'utf8'));

  const store = getVpsMarketStore();
  const universe = await loadEligibleUniverse(store);

  const built = existingSync.buildExistingMarketStructureRows(marketPayload, hscPayload, universe);
  // Canonical market-structure storage covers the full listed-stock universe.
  // Scanner eligibility (800) is a runtime subset, so validate writes against
  // canonical market tickers instead of rejecting the 162 non-scanner names.
  const canonicalTickers = (marketPayload.stocks || [])
    .map((stock) => String(stock && stock.ticker || '').trim().toUpperCase())
    .filter(Boolean);
  marketImport.validateRowsAgainstUniverse(built.rows, canonicalTickers);

  // Merge against the LOCAL stock_fundamentals state first so stale snapshots
  // and same-date conflicts stay fail-closed before any local write occurs.
  const prepared = await marketImport.prepareMarketStructureRows(store, built.rows);

  console.log('=== EXISTING MARKET STRUCTURE SYNC ===');
  console.log('Storage: VPS_ONLY');
  console.log('DB: ' + store.filePath);
  console.log('Market structure source: ' + MARKET_PATH);
  console.log('HSC source: ' + HSC_PATH);
  console.log('Mode: ' + (apply ? 'APPLY' : 'VALIDATE_ONLY'));
  console.log('Canonical market universe: ' + built.summary.canonical_count);
  console.log('Eligible scanner universe: ' + built.summary.eligible_count);
  console.log('Market stocks: ' + built.summary.market_stock_count);
  console.log('Free Float verified canonical: ' +
    built.summary.free_float_verified_canonical + '/' + built.summary.canonical_count);
  console.log('Missing Free Float canonical: ' + built.summary.missing_free_float_canonical.length +
    (built.summary.missing_free_float_canonical.length
      ? ' [' + built.summary.missing_free_float_canonical.join(', ') + ']' : ''));
  console.log('Free Float verified eligible: ' +
    built.summary.free_float_verified_eligible + '/' + built.summary.eligible_count);
  console.log('Missing Free Float eligible: ' + built.summary.missing_free_float_eligible.length +
    (built.summary.missing_free_float_eligible.length
      ? ' [' + built.summary.missing_free_float_eligible.join(', ') + ']' : ''));
  console.log('HSC dataset tickers: ' + built.summary.hsc_dataset_count);
  console.log('HSC outside eligible universe: ' + built.summary.hsc_outside_universe.length +
    (built.summary.hsc_outside_universe.length ? ' [' + built.summary.hsc_outside_universe.join(', ') + ']' : ''));
  console.log('HSC verified canonical: ' + built.summary.hsc_verified_canonical);
  console.log('HSC active/revoked canonical: ' +
    built.summary.hsc_active_canonical + '/' + built.summary.hsc_revoked_canonical);
  console.log('HSC verified eligible: ' + built.summary.hsc_verified_in_universe);
  console.log('HSC active/revoked eligible: ' +
    built.summary.hsc_active_in_universe + '/' + built.summary.hsc_revoked_in_universe);
  console.log('Prepared fundamentals rows: ' + prepared.length);

  if (!apply) {
    console.log('Validation passed. No writes performed.');
    console.log('Run again with --apply to sync existing data into VPS market.sqlite.');
    return;
  }

  const fundamentalsCount = await upsertPreparedFundamentals(store, prepared);
  const featureCount = await syncExistingDailyFeatureRows(store, built.rows);

  console.log('Fundamentals upserted to VPS: ' + fundamentalsCount);
  console.log('Daily feature rows refreshed on VPS: ' + featureCount);
  console.log('Sync complete. Run tools/audit-market-structure-coverage.js next.');
}

main().catch((error) => {
  console.error('[sync-existing-market-structure] Error:', error && error.message || error);
  process.exit(1);
});

module.exports = {
  loadEligibleUniverse,
  syncExistingDailyFeatureRows,
  upsertPreparedFundamentals,
  main
};
