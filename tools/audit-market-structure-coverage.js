#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getVpsMarketStore } = require('../lib/vps-market-store');
const fcaTransition = require('../lib/fca-transition-2026');
const coverage = require('../lib/market-structure-coverage');

const ROOT = path.resolve(__dirname, '..');
const REPORT_PATH = path.join(ROOT, 'data', 'reports', 'market-structure-coverage-latest.json');

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function loadUniverse(store) {
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

async function loadFundamentals(store, tickers) {
  const rows = [];
  for (const batch of chunk(tickers, 250)) {
    const result = await store
      .from('stock_fundamentals')
      .select('ticker,free_float_pct,free_float_source,free_float_as_of,hsc_flag,hsc_source,hsc_as_of')
      .in('ticker', batch);
    if (result.error) throw new Error('Load stock_fundamentals VPS gagal: ' + result.error.message);
    rows.push(...(result.data || []));
  }
  return rows;
}

async function main() {
  const store = getVpsMarketStore();

  const universe = await loadUniverse(store);
  const fundamentals = await loadFundamentals(store, universe);
  const report = coverage.buildCoverageReport(universe, fundamentals, { expectedUniverse: 800 });

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8');

  console.log('=== MARKET STRUCTURE COVERAGE ===');
  console.log('Storage: VPS_ONLY');
  console.log('DB: ' + store.filePath);
  console.log('Universe: ' + report.universe.actual + '/' + report.universe.expected +
    ' contract=' + (report.universe.contract_ok ? 'OK' : 'MISMATCH'));
  console.log('Free Float verified: ' + report.coverage.free_float_verified + '/' + report.universe.actual +
    ' (' + report.coverage.free_float_verified_pct + '%)');
  console.log('HSC verified: ' + report.coverage.hsc_verified + '/' + report.universe.actual +
    ' (' + report.coverage.hsc_verified_pct + '%)');
  console.log('Both verified: ' + report.coverage.both_verified + '/' + report.universe.actual +
    ' (' + report.coverage.both_verified_pct + '%)');
  console.log('Low free float (<15% risk ref): ' + report.risk_context.low_free_float_risk);
  console.log('Regulatory compliance: ' + report.risk_context.regulatory_compliance_status);
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
