#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const fcaTransition = require('../lib/fca-transition-2026');
const coverage = require('../lib/market-structure-coverage');

const ROOT = path.resolve(__dirname, '..');
const REPORT_PATH = path.join(ROOT, 'data', 'reports', 'market-structure-coverage-latest.json');

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

async function loadUniverse(supabase) {
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

async function loadFundamentals(supabase, tickers) {
  const rows = [];
  for (const batch of chunk(tickers, 250)) {
    const result = await supabase
      .from('stock_fundamentals')
      .select('ticker,free_float_pct,free_float_source,free_float_as_of,hsc_flag,hsc_source,hsc_as_of')
      .in('ticker', batch);
    if (result.error) throw new Error('Load stock_fundamentals gagal: ' + result.error.message);
    rows.push(...(result.data || []));
  }
  return rows;
}

async function main() {
  loadLocalEnv();

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const universe = await loadUniverse(supabase);
  const fundamentals = await loadFundamentals(supabase, universe);
  const report = coverage.buildCoverageReport(universe, fundamentals, { expectedUniverse: 800 });

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8');

  console.log('=== MARKET STRUCTURE COVERAGE ===');
  console.log('Universe: ' + report.universe.actual + '/' + report.universe.expected +
    ' contract=' + (report.universe.contract_ok ? 'OK' : 'MISMATCH'));
  console.log('Free Float verified: ' + report.coverage.free_float_verified + '/' + report.universe.actual +
    ' (' + report.coverage.free_float_verified_pct + '%)');
  console.log('HSC verified: ' + report.coverage.hsc_verified + '/' + report.universe.actual +
    ' (' + report.coverage.hsc_verified_pct + '%)');
  console.log('Both verified: ' + report.coverage.both_verified + '/' + report.universe.actual +
    ' (' + report.coverage.both_verified_pct + '%)');
  console.log('Below IDX min free float: ' + report.risk_context.below_idx_min_free_float);
  console.log('HSC flagged: ' + report.risk_context.hsc_flagged);
  console.log('Guard NORMAL/CAUTION/UNKNOWN: ' +
    report.risk_context.normal + '/' + report.risk_context.caution + '/' + report.risk_context.unknown);
  console.log('Missing both: ' + report.coverage.missing_both);
  console.log('Report: ' + REPORT_PATH);

  if (!report.universe.contract_ok) process.exitCode = 2;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[market-structure-coverage] Error:', error && error.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  loadUniverse,
  loadFundamentals,
  main
};
