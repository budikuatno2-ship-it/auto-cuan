#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const { getVpsMarketStore, TABLE_KEYS } = require('../lib/vps-market-store');

const ROOT = path.resolve(__dirname, '..');
const PAGE_SIZE = 1000;

const DEFAULT_TABLES = [
  'stock_daily_history',
  'stock_daily_features',
  'stock_boards',
  'idx_trading_calendar',
  'foreign_watchlist_daily',
  'daytrade_screener_latest',
  'daytrade_screener_meta',
  'daytrade_screener_runs',
  'swing_screener_latest',
  'swing_screener_meta',
  'swing_screener_non_konglo_latest',
  'swing_screener_non_konglo_meta',
  'swing_screener_non_konglo_jobs',
  'swing_screener_non_konglo_staging',
  'sector_hot_groups',
  'sector_hot_group_members',
  'sector_hot_members_latest',
  'sector_hot_latest',
  'sector_hot_meta',
  'telegram_daily_picks',
  'ai_analysis_cache',
  'ai_context_snapshots',
  'ai_eval_runs',
  'ai_eval_chunks',
  'ai_eval_case_index',
  'stock_news_cache'
];

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const i = trimmed.indexOf('=');
    if (i <= 0) continue;
    const key = trimmed.slice(0, i).trim();
    let value = trimmed.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] == null) process.env[key] = value;
  }
}

function loadEnv() {
  [
    path.join(ROOT, '.env.intraday-runtime'),
    path.join(ROOT, '.env.local'),
    path.join(ROOT, '.env')
  ].forEach(loadEnvFile);
}

function parseArgs(argv) {
  const out = { verifyOnly: false, tables: DEFAULT_TABLES.slice() };
  for (const arg of argv || []) {
    if (arg === '--verify-only') out.verifyOnly = true;
    else if (arg.startsWith('--tables=')) {
      out.tables = arg.slice('--tables='.length).split(',').map((x) => x.trim()).filter(Boolean);
    }
  }
  return out;
}

async function remoteCount(supabase, table) {
  const res = await supabase.from(table).select('*', { count: 'exact', head: true });
  if (res.error) throw new Error(table + ' count gagal: ' + res.error.message);
  return Number(res.count) || 0;
}

async function copyTable(supabase, local, table) {
  if (!TABLE_KEYS[table]) throw new Error('Table belum terdaftar di VPS market store: ' + table);

  const total = await remoteCount(supabase, table);
  local.clearTable(table);

  let copied = 0;
  while (copied < total) {
    const from = copied;
    const to = Math.min(total - 1, from + PAGE_SIZE - 1);
    const res = await supabase.from(table).select('*').range(from, to);
    if (res.error) throw new Error(table + ' page ' + from + '-' + to + ' gagal: ' + res.error.message);
    const rows = res.data || [];
    if (!rows.length && copied < total) throw new Error(table + ' berhenti sebelum selesai pada offset ' + copied);

    if (rows.length) {
      const write = await local.from(table).upsert(rows, { onConflict: TABLE_KEYS[table].join(',') });
      if (write.error) throw new Error(table + ' local upsert gagal: ' + write.error.message);
    }
    copied += rows.length;
    process.stdout.write('[migrate] ' + table + ' ' + copied + '/' + total + '\r');
  }
  process.stdout.write('\n');

  const localCount = local.count(table);
  if (localCount !== total) {
    throw new Error(table + ' count mismatch remote=' + total + ' local=' + localCount);
  }
  return { table, remote: total, local: localCount };
}

async function verifyTable(supabase, local, table) {
  const remote = await remoteCount(supabase, table);
  const localCount = local.count(table);
  return { table, remote, local: localCount, ok: remote === localCount };
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY wajib tersedia.');

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const local = getVpsMarketStore();

  console.log('=== VPS MARKET DATA MIGRATION ===');
  console.log('DB: ' + local.filePath);
  console.log('Mode: ' + (args.verifyOnly ? 'VERIFY_ONLY' : 'COPY_THEN_VERIFY'));
  console.log('Tables: ' + args.tables.length);

  const results = [];
  for (const table of args.tables) {
    const result = args.verifyOnly
      ? await verifyTable(supabase, local, table)
      : await copyTable(supabase, local, table);
    results.push(result);
    console.log(
      '[migrate] ' + table +
      ' remote=' + result.remote +
      ' local=' + result.local +
      ' ' + (result.ok === false ? 'MISMATCH' : 'OK')
    );
  }

  const failed = results.filter((r) => r.remote !== r.local);
  if (failed.length) {
    console.error('VERIFICATION FAILED: ' + failed.map((r) => r.table).join(', '));
    process.exitCode = 2;
    return;
  }

  console.log('VERIFICATION OK: all selected market-data tables match by row count.');
  if (!args.verifyOnly) {
    console.log('');
    console.log('NEXT: enable AUTO_CUAN_MARKET_DATA_VPS=1 on the VPS and restart PM2.');
    console.log('Do NOT delete Supabase tables yet.');
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[migrate-market-data-to-vps] ' + (error && error.message || error));
    process.exitCode = 1;
  });
}

module.exports = { DEFAULT_TABLES, parseArgs, remoteCount, copyTable, verifyTable };
