#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const vpsStore = require('../lib/vps-market-data-store');

const DATA_ROOT = process.env.AUTO_CUAN_DATA_ROOT || '/home/ubuntu/auto-cuan-data';
const SNAPSHOT_ROOT = path.join(DATA_ROOT, 'supabase-snapshots');
const PAGE_SIZE = 1000;

const TABLES = [
  'foreign_watchlist_daily',
  'stock_daily_features',
  'stock_boards',
  'idx_trading_calendar',
  'daytrade_screener_latest',
  'daytrade_screener_meta',
  'daytrade_screener_runs',
  'swing_screener_latest',
  'swing_screener_meta',
  'swing_screener_non_konglo_latest',
  'swing_screener_non_konglo_meta',
  'swing_screener_non_konglo_jobs',
  'swing_screener_non_konglo_staging',
  'telegram_daily_picks',
  'sector_hot_latest',
  'sector_hot_meta',
  'sector_hot_group_members',
  'sector_hot_members_latest',
  'ai_analysis_cache',
  'ai_analysis_logs',
  'ai_context_snapshots',
  'ai_eval_runs',
  'ai_usage_logs',
  'stock_news_cache'
];

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
}

function loadEnv() {
  const root = process.env.AUTO_CUAN_ROOT || process.cwd();
  [
    path.join(root, '.env'),
    path.join(root, '.env.local'),
    path.join(root, '.env.intraday-runtime'),
    path.join(root, '.env.ai-eval-once')
  ].forEach(loadEnvFile);
}

async function fetchTable(supabase, table) {
  const countRes = await supabase.from(table).select('*', { count: 'exact', head: true });
  if (countRes.error) throw new Error(table + ' count failed: ' + countRes.error.message);
  const expected = Number(countRes.count) || 0;

  const rows = [];
  for (let offset = 0; offset < expected; offset += PAGE_SIZE) {
    const end = Math.min(expected - 1, offset + PAGE_SIZE - 1);
    const page = await supabase.from(table).select('*').range(offset, end);
    if (page.error) throw new Error(table + ' page ' + offset + ' failed: ' + page.error.message);
    rows.push(...(page.data || []));
  }

  if (rows.length !== expected) {
    throw new Error(table + ' row-count mismatch: expected=' + expected + ' fetched=' + rows.length);
  }
  return { expected, rows };
}

function sha256Json(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function main() {
  loadEnv();
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');

  fs.mkdirSync(SNAPSHOT_ROOT, { recursive: true });
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const manifest = {
    version: 1,
    created_at: new Date().toISOString(),
    destination: SNAPSHOT_ROOT,
    tables: {}
  };

  for (const table of TABLES) {
    const result = await fetchTable(supabase, table);
    const payload = {
      version: 1,
      table,
      exported_at: new Date().toISOString(),
      row_count: result.rows.length,
      rows: result.rows
    };
    const filePath = path.join(SNAPSHOT_ROOT, table + '.json');
    vpsStore.atomicWriteJson(filePath, payload);
    manifest.tables[table] = {
      row_count: result.rows.length,
      sha256: sha256Json(result.rows),
      file: filePath
    };
    console.log('[vps-migrate] ' + table + ': ' + result.rows.length + ' rows');
  }

  // Seed the active VPS foreign-flow store from the verified exported snapshot.
  const foreign = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_ROOT, 'foreign_watchlist_daily.json'), 'utf8'));
  const foreignRows = foreign && Array.isArray(foreign.rows) ? foreign.rows : [];
  const foreignTotal = vpsStore.writeForeignRows(foreignRows, { source: 'supabase_cutover_snapshot' });
  manifest.foreign_active_store_rows = foreignTotal;

  const manifestPath = path.join(SNAPSHOT_ROOT, 'manifest.json');
  vpsStore.atomicWriteJson(manifestPath, manifest);

  console.log('');
  console.log('=== VPS MARKET DATA SNAPSHOT COMPLETE ===');
  console.log('Destination: ' + SNAPSHOT_ROOT);
  console.log('Tables: ' + Object.keys(manifest.tables).length);
  console.log('Foreign active store rows: ' + foreignTotal);
  console.log('Manifest: ' + manifestPath);
  console.log('No Supabase rows were deleted.');
}

main().catch((error) => {
  console.error('[vps-migrate] ERROR:', error && error.message || error);
  process.exit(1);
});

module.exports = { TABLES, fetchTable, sha256Json };
