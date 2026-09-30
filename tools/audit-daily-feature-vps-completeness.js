#!/usr/bin/env node
'use strict';

const { getVpsMarketStore } = require('../lib/vps-market-store');
const fcaTransition = require('../lib/fca-transition-2026');
const contextBuilder = require('../lib/daily-market-context-builder');
const historyStore = require('../lib/stock-daily-history-store');

function cleanTicker(value) {
  return String(value || '').trim().toUpperCase().replace(/\.JK$/i, '');
}

async function loadEligibleUniverse(store) {
  const result = await store
    .from('stock_boards')
    .select('ticker,company_name,board,is_fca,is_active,note')
    .limit(2000);
  if (result.error) throw new Error('Load stock_boards VPS gagal: ' + result.error.message);

  return (result.data || [])
    .filter((row) => fcaTransition.isEligibleContinuousAuctionRow(row))
    .map((row) => cleanTicker(row.ticker))
    .filter(Boolean)
    .sort();
}

function summarizeFeatureCoverage(eligibleTickers, featureRows, historyRows) {
  const eligible = Array.from(new Set((eligibleTickers || []).map(cleanTicker).filter(Boolean))).sort();
  const featureSet = new Set((featureRows || []).map((row) => cleanTicker(row && row.ticker)).filter(Boolean));
  const missing = eligible.filter((ticker) => !featureSet.has(ticker));

  const historyByTicker = new Map();
  for (const row of historyRows || []) {
    const ticker = cleanTicker(row && row.ticker);
    if (!ticker || !missing.includes(ticker)) continue;
    if (!historyByTicker.has(ticker)) {
      historyByTicker.set(ticker, { ticker, history_count: 0, latest_trade_date: null });
    }
    const item = historyByTicker.get(ticker);
    item.history_count += 1;
    const date = String(row.trade_date || '');
    if (date && (!item.latest_trade_date || date > item.latest_trade_date)) {
      item.latest_trade_date = date;
    }
  }

  const missingDetails = missing.map((ticker) => {
    const history = historyByTicker.get(ticker);
    return {
      ticker,
      history_count: history ? history.history_count : 0,
      latest_trade_date: history ? history.latest_trade_date : null,
      repairable_from_local_history: !!(history && history.history_count > 0)
    };
  });

  return {
    eligible_count: eligible.length,
    feature_count_in_eligible: eligible.length - missing.length,
    missing_count: missing.length,
    missing_tickers: missing,
    repairable_count: missingDetails.filter((row) => row.repairable_from_local_history).length,
    no_history_count: missingDetails.filter((row) => !row.repairable_from_local_history).length,
    missing_details: missingDetails
  };
}

async function readCoverage(store, eligibleTickers) {
  const featureResult = await store
    .from('stock_daily_features')
    .select('ticker,as_of_trade_date,updated_at')
    .limit(2000);
  if (featureResult.error) throw new Error('Load stock_daily_features VPS gagal: ' + featureResult.error.message);

  const featureSet = new Set((featureResult.data || []).map((row) => cleanTicker(row.ticker)).filter(Boolean));
  const missing = eligibleTickers.filter((ticker) => !featureSet.has(ticker));

  let historyRows = [];
  if (missing.length) {
    const historyResult = await store
      .from('stock_daily_history')
      .select('ticker,trade_date')
      .in('ticker', missing);
    if (historyResult.error) throw new Error('Load stock_daily_history VPS gagal: ' + historyResult.error.message);
    historyRows = historyResult.data || [];
  }

  return summarizeFeatureCoverage(eligibleTickers, featureResult.data || [], historyRows);
}

async function repairFromLocalHistory(store, summary) {
  const tickers = (summary.missing_details || [])
    .filter((row) => row.repairable_from_local_history)
    .map((row) => row.ticker);

  if (!tickers.length) {
    return { attempted: 0, built: 0, upserted: 0, skipped_no_history: [] };
  }

  const built = await contextBuilder.buildFeatureSnapshotsForTickers(store, tickers, {});
  const upserted = await historyStore.upsertDailyFeatures(store, built.rows);

  return {
    attempted: tickers.length,
    built: built.rows.length,
    upserted,
    skipped_no_history: built.skippedTickers || []
  };
}

function printSummary(summary) {
  console.log('Eligible scanner universe: ' + summary.eligible_count);
  console.log('Daily features present: ' + summary.feature_count_in_eligible + '/' + summary.eligible_count);
  console.log('Missing daily features: ' + summary.missing_count);
  console.log('Repairable from local history: ' + summary.repairable_count);
  console.log('No local history: ' + summary.no_history_count);
  if (summary.missing_details.length) {
    console.log('Missing detail:');
    for (const row of summary.missing_details) {
      console.log(
        '  ' + row.ticker +
        ' history=' + row.history_count +
        ' latest=' + (row.latest_trade_date || '-') +
        ' repairable=' + (row.repairable_from_local_history ? 'YES' : 'NO')
      );
    }
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const store = getVpsMarketStore();

  console.log('=== DAILY FEATURE VPS COMPLETENESS ===');
  console.log('Storage: VPS_ONLY');
  console.log('DB: ' + store.filePath);
  console.log('Mode: ' + (apply ? 'APPLY_LOCAL_HISTORY_ONLY' : 'AUDIT_ONLY'));

  const eligible = await loadEligibleUniverse(store);
  const before = await readCoverage(store, eligible);
  printSummary(before);

  if (!apply) {
    console.log('Audit complete. No writes performed.');
    console.log('Run again with --apply to rebuild ONLY missing tickers that already have local history.');
    return;
  }

  const repair = await repairFromLocalHistory(store, before);
  console.log('Repair attempted: ' + repair.attempted);
  console.log('Feature rows built: ' + repair.built);
  console.log('Feature rows upserted: ' + repair.upserted);
  console.log('Builder skipped_no_history: ' + repair.skipped_no_history.length +
    (repair.skipped_no_history.length ? ' [' + repair.skipped_no_history.join(', ') + ']' : ''));

  const after = await readCoverage(store, eligible);
  console.log('--- AFTER REPAIR ---');
  printSummary(after);

  if (after.missing_count > 0) {
    process.exitCode = 2;
    console.log('Remaining missing rows were not fabricated. They require valid local candle history first.');
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[audit-daily-feature-vps-completeness] Error:', error && error.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  cleanTicker,
  loadEligibleUniverse,
  summarizeFeatureCoverage,
  readCoverage,
  repairFromLocalHistory,
  main
};
