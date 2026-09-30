#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const vpsStore = require('../lib/vps-market-data-store');
const localTables = require('../lib/vps-local-table-query');

const DATA_ROOT = process.env.AUTO_CUAN_DATA_ROOT || '/home/ubuntu/auto-cuan-data';
const SNAPSHOT_ROOT = path.join(DATA_ROOT, 'supabase-snapshots');
const PAGE_SIZE = 1000;

const ORDER_KEYS = {
  foreign_watchlist_daily: ['id'],
  stock_daily_features: ['ticker'],
  stock_boards: ['ticker'],
  idx_trading_calendar: ['trade_date'],
  daytrade_screener_latest: ['ticker'],
  daytrade_screener_meta: ['id'],
  daytrade_screener_runs: ['id'],
  swing_screener_latest: ['ticker'],
  swing_screener_meta: ['id'],
  swing_screener_non_konglo_latest: ['ticker'],
  swing_screener_non_konglo_meta: ['id'],
  swing_screener_non_konglo_jobs: ['id'],
  swing_screener_non_konglo_staging: ['id'],
  telegram_daily_picks: ['id'],
  sector_hot_latest: ['group_code'],
  sector_hot_meta: ['id'],
  sector_hot_group_members: ['id'],
  sector_hot_members_latest: ['id'],
  ai_analysis_cache: ['cache_key'],
  ai_analysis_logs: ['id'],
  ai_context_snapshots: ['id'],
  ai_eval_runs: ['id'],
  ai_usage_logs: ['id'],
  stock_news_cache: ['ticker', 'period']
};

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

async function fetchTablePass(supabase, table) {
  const keys = ORDER_KEYS[table];
  if (!keys || !keys.length) throw new Error('No deterministic export order configured for ' + table);

  const rows = [];
  let offset = 0;
  while (true) {
    let query = supabase.from(table).select('*');
    for (const key of keys) query = query.order(key, { ascending: true });
    const page = await query.range(offset, offset + PAGE_SIZE - 1);
    if (page.error) throw new Error(table + ' page ' + offset + ' failed: ' + page.error.message);
    const pageRows = page.data || [];
    rows.push(...pageRows);
    if (pageRows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    if (offset > 2000000) throw new Error(table + ' export safety limit exceeded');
  }
  return rows;
}

async function fetchTable(supabase, table) {
  // Offset pagination can observe moving rows on a live table. Two consecutive
  // deterministic passes must therefore match exactly before a snapshot is
  // accepted. Market writers run outside this one-time migration where
  // possible; any concurrent mutation makes hashes differ and forces retry.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const first = await fetchTablePass(supabase, table);
    const second = await fetchTablePass(supabase, table);
    const firstSha = sha256Json(first);
    const secondSha = sha256Json(second);
    if (first.length === second.length && firstSha === secondSha) {
      return { expected: second.length, rows: second, verified_sha256: secondSha, verification_attempt: attempt };
    }
    console.warn('[vps-migrate] ' + table + ': changed during export, retry ' + attempt + '/3');
  }
  throw new Error(table + ' changed during all verification passes; stop writers and retry migration.');
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
    if (localTables.LOCAL_TABLES.has(table)) {
      localTables.writeTableRows(table, result.rows, 'supabase_cutover_snapshot');
    }
    manifest.tables[table] = {
      row_count: result.rows.length,
      sha256: result.verified_sha256 || sha256Json(result.rows),
      verification_attempt: result.verification_attempt || null,
      deterministic_order: ORDER_KEYS[table],
      file: filePath,
      active_local_file: localTables.LOCAL_TABLES.has(table) ? localTables.tablePath(table) : null
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

if (require.main === module) {
  main().catch((error) => {
    console.error('[vps-migrate] ERROR:', error && error.message || error);
    process.exit(1);
  });
}

module.exports = { TABLES, ORDER_KEYS, fetchTablePass, fetchTable, sha256Json, main };
