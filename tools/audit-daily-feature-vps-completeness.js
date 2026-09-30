#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getVpsMarketStore } = require('../lib/vps-market-store');
const fcaTransition = require('../lib/fca-transition-2026');
const contextBuilder = require('../lib/daily-market-context-builder');
const historyStore = require('../lib/stock-daily-history-store');
const dailyCollector = require('../lib/daily-history-collector');
const { HISTORY_RETENTION_TRADING_SESSIONS } = require('../lib/daily-market-context-constants');

const EXPECTED_ELIGIBLE_UNIVERSE = 800;

const ROOT = path.resolve(__dirname, '..');
const DAILY_CANDLES_DIR = process.env.AUTO_CUAN_DAILY_CANDLES_DIR ||
  path.join(ROOT, 'data', 'daily-candles');

function cleanTicker(value) {
  return String(value || '').trim().toUpperCase().replace(/\.JK$/i, '');
}

async function loadEligibleUniverse(store) {
  const result = await store
    .from('stock_boards')
    .select('ticker,company_name,board,is_fca,is_active,note')
    .limit(2000);
  if (result.error) throw new Error('Load stock_boards VPS gagal: ' + result.error.message);

  const eligible = Array.from(new Set(
    (result.data || [])
      .filter((row) => fcaTransition.isEligibleContinuousAuctionRow(row))
      .map((row) => cleanTicker(row.ticker))
      .filter(Boolean)
  )).sort();

  if (eligible.length !== EXPECTED_ELIGIBLE_UNIVERSE) {
    throw new Error(
      'Eligible scanner universe contract mismatch: expected=' +
      EXPECTED_ELIGIBLE_UNIVERSE + ' actual=' + eligible.length
    );
  }

  return eligible;
}

function normalizeCanonicalCandles(payload) {
  const raw = Array.isArray(payload)
    ? payload
    : (payload && (payload.candles || payload.rows || payload.data || payload.history));
  return (Array.isArray(raw) ? raw : [])
    .map((row) => {
      const date = String(row && (row.date || row.trade_date || row.t || row.time) || '').slice(0, 10);
      const open = Number(row && (row.open != null ? row.open : row.o));
      const high = Number(row && (row.high != null ? row.high : row.h));
      const low = Number(row && (row.low != null ? row.low : row.l));
      const close = Number(row && (row.close != null ? row.close : row.c));
      const volume = Number(row && (row.volume != null ? row.volume : row.v));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
      if (![open, high, low, close, volume].every(Number.isFinite)) return null;
      if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0) return null;
      return {
        date,
        open,
        high,
        low,
        close,
        volume,
        data_source: String(row && (row.data_source || row.source) || 'canonical_archive'),
        data_quality_status: String(row && row.data_quality_status || 'ok')
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function readCanonicalArchiveCandles(archiveDir, ticker) {
  const filePath = path.join(archiveDir, cleanTicker(ticker) + '.json');
  if (!fs.existsSync(filePath)) return [];
  try {
    return normalizeCanonicalCandles(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (_) {
    return [];
  }
}

function readCanonicalArchiveMeta(archiveDir, ticker) {
  const filePath = path.join(archiveDir, cleanTicker(ticker) + '.json');
  if (!fs.existsSync(filePath)) {
    return {
      archive_exists: false,
      archive_candle_count: 0,
      archive_first_date: null,
      archive_latest_date: null,
      archive_last_positive_volume_date: null,
      archive_positive_volume_last20: 0,
      archive_positive_volume_last60: 0,
      archive_zero_volume_tail: 0,
      archive_distinct_close_last20: 0
    };
  }
  try {
    const candles = readCanonicalArchiveCandles(archiveDir, ticker);
    const last20 = candles.slice(-20);
    const last60 = candles.slice(-60);
    const positive20 = last20.filter((row) => row.volume > 0);
    const positive60 = last60.filter((row) => row.volume > 0);
    const lastPositive = candles.slice().reverse().find((row) => row.volume > 0) || null;
    let zeroVolumeTail = 0;
    for (let i = candles.length - 1; i >= 0; i--) {
      if (candles[i].volume > 0) break;
      zeroVolumeTail += 1;
    }
    return {
      archive_exists: true,
      archive_candle_count: candles.length,
      archive_first_date: candles.length ? candles[0].date : null,
      archive_latest_date: candles.length ? candles[candles.length - 1].date : null,
      archive_last_positive_volume_date: lastPositive ? lastPositive.date : null,
      archive_positive_volume_last20: positive20.length,
      archive_positive_volume_last60: positive60.length,
      archive_zero_volume_tail: zeroVolumeTail,
      archive_distinct_close_last20: new Set(last20.map((row) => row.close)).size
    };
  } catch (_) {
    return {
      archive_exists: true,
      archive_candle_count: 0,
      archive_first_date: null,
      archive_latest_date: null,
      archive_last_positive_volume_date: null,
      archive_positive_volume_last20: 0,
      archive_positive_volume_last60: 0,
      archive_zero_volume_tail: 0,
      archive_distinct_close_last20: 0
    };
  }
}

function summarizeFeatureCoverage(eligibleTickers, featureRows, historyRows, archiveMetaByTicker) {
  const eligible = Array.from(new Set((eligibleTickers || []).map(cleanTicker).filter(Boolean))).sort();
  const eligibleSet = new Set(eligible);
  const allFeatureTickers = Array.from(new Set(
    (featureRows || []).map((row) => cleanTicker(row && row.ticker)).filter(Boolean)
  )).sort();
  const featureSet = new Set(allFeatureTickers);
  const missing = eligible.filter((ticker) => !featureSet.has(ticker));
  const outsideEligible = allFeatureTickers.filter((ticker) => !eligibleSet.has(ticker));

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

  const archives = archiveMetaByTicker || new Map();
  const missingDetails = missing.map((ticker) => {
    const history = historyByTicker.get(ticker);
    const archive = archives.get(ticker) || {
      archive_exists: false,
      archive_candle_count: 0,
      archive_first_date: null,
      archive_latest_date: null,
      archive_last_positive_volume_date: null,
      archive_positive_volume_last20: 0,
      archive_positive_volume_last60: 0,
      archive_zero_volume_tail: 0,
      archive_distinct_close_last20: 0
    };
    return Object.assign({
      ticker,
      history_count: history ? history.history_count : 0,
      latest_trade_date: history ? history.latest_trade_date : null,
      repairable_from_local_history: !!(history && history.history_count > 0)
    }, archive, {
      repairable_from_canonical_archive: archive.archive_candle_count >= 20
    });
  });

  return {
    eligible_count: eligible.length,
    total_feature_rows: allFeatureTickers.length,
    feature_count_in_eligible: eligible.length - missing.length,
    feature_rows_outside_eligible: outsideEligible,
    missing_count: missing.length,
    missing_tickers: missing,
    repairable_count: missingDetails.filter((row) => row.repairable_from_local_history).length,
    no_history_count: missingDetails.filter((row) => !row.repairable_from_local_history).length,
    canonical_archive_available_count: missingDetails.filter((row) => row.repairable_from_canonical_archive).length,
    canonical_archive_missing_or_invalid_count: missingDetails.filter((row) => !row.repairable_from_canonical_archive).length,
    canonical_archive_rehydrate_candidate_count: missingDetails.filter(isArchiveRehydrateCandidate).length,
    missing_details: missingDetails
  };
}

async function readCoverage(store, eligibleTickers, archiveDir) {
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

  const archiveMetaByTicker = new Map();
  for (const ticker of missing) {
    archiveMetaByTicker.set(ticker, readCanonicalArchiveMeta(archiveDir, ticker));
  }

  return summarizeFeatureCoverage(
    eligibleTickers,
    featureResult.data || [],
    historyRows,
    archiveMetaByTicker
  );
}

function isArchiveRehydrateCandidate(row) {
  row = row || {};
  return row.repairable_from_canonical_archive === true &&
    !!row.archive_latest_date &&
    row.archive_last_positive_volume_date === row.archive_latest_date &&
    Number(row.archive_zero_volume_tail) === 0 &&
    Number(row.archive_positive_volume_last20) > 0 &&
    Number(row.archive_distinct_close_last20) > 1;
}

async function rehydrateFromCanonicalArchive(store, summary, archiveDir) {
  const candidates = (summary.missing_details || []).filter(isArchiveRehydrateCandidate);
  const sourceTimestamp = new Date().toISOString();
  const allHistoryRows = [];
  const tickers = [];
  const week52ByTicker = {};
  const rsiByTicker = {};
  const skipped = [];

  for (const detail of candidates) {
    // Re-read at write time and re-check the trade-evidence guard so a changed
    // archive cannot bypass the audit decision.
    const liveMeta = readCanonicalArchiveMeta(archiveDir, detail.ticker);
    if (!isArchiveRehydrateCandidate(Object.assign({}, detail, liveMeta, {
      repairable_from_canonical_archive: liveMeta.archive_candle_count >= 20
    }))) {
      skipped.push(detail.ticker);
      continue;
    }

    const candles = readCanonicalArchiveCandles(archiveDir, detail.ticker);
    if (candles.length < 20) {
      skipped.push(detail.ticker);
      continue;
    }

    const historyRows = dailyCollector.candlesToHistoryRows(detail.ticker, candles, {
      sourceTimestamp
    });
    if (!historyRows.length) {
      skipped.push(detail.ticker);
      continue;
    }

    allHistoryRows.push(...historyRows);
    tickers.push(detail.ticker);
    week52ByTicker[detail.ticker] = dailyCollector.computeWeek52FromCandles(candles);
    rsiByTicker[detail.ticker] = dailyCollector.computeRsiFromCandles(candles, {});
  }

  const historyUpserted = allHistoryRows.length
    ? await historyStore.upsertDailyHistory(store, allHistoryRows)
    : 0;

  if (!tickers.length) {
    return {
      attempted: candidates.length,
      history_upserted: historyUpserted,
      feature_built: 0,
      feature_upserted: 0,
      skipped
    };
  }

  const built = await contextBuilder.buildFeatureSnapshotsForTickers(store, tickers, {
    week52ByTicker,
    rsiByTicker
  });
  const featureUpserted = await historyStore.upsertDailyFeatures(store, built.rows);

  return {
    attempted: candidates.length,
    history_upserted: historyUpserted,
    feature_built: built.rows.length,
    feature_upserted: featureUpserted,
    skipped: Array.from(new Set(skipped.concat(built.skippedTickers || []))).sort()
  };
}

async function repairFromLocalHistory(store, summary) {
  const tickers = (summary.missing_details || [])
    .filter((row) => row.repairable_from_local_history)
    .map((row) => row.ticker);

  if (!tickers.length) {
    return { attempted: 0, built: 0, upserted: 0, skipped_no_history: [] };
  }

  const built = await contextBuilder.buildFeatureSnapshotsForTickers(store, tickers, {
    historySessions: HISTORY_RETENTION_TRADING_SESSIONS
  });
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
  console.log('Total daily feature rows: ' + summary.total_feature_rows);
  console.log('Daily features present in eligible: ' +
    summary.feature_count_in_eligible + '/' + summary.eligible_count);
  console.log('Feature rows outside eligible: ' + summary.feature_rows_outside_eligible.length +
    (summary.feature_rows_outside_eligible.length
      ? ' [' + summary.feature_rows_outside_eligible.join(', ') + ']' : ''));
  console.log('Missing daily features: ' + summary.missing_count);
  console.log('Repairable from stock_daily_history: ' + summary.repairable_count);
  console.log('No stock_daily_history: ' + summary.no_history_count);
  console.log('Canonical archive available (>=20 candles): ' + summary.canonical_archive_available_count);
  console.log('Canonical archive missing/invalid: ' + summary.canonical_archive_missing_or_invalid_count);
  console.log('Archive rehydrate candidates (fresh positive-volume proof): ' +
    summary.canonical_archive_rehydrate_candidate_count);
  if (summary.missing_details.length) {
    console.log('Missing detail:');
    for (const row of summary.missing_details) {
      console.log(
        '  ' + row.ticker +
        ' sqlite_history=' + row.history_count +
        ' sqlite_latest=' + (row.latest_trade_date || '-') +
        ' archive=' + row.archive_candle_count +
        ' archive_first=' + (row.archive_first_date || '-') +
        ' archive_latest=' + (row.archive_latest_date || '-') +
        ' last_positive=' + (row.archive_last_positive_volume_date || '-') +
        ' vol20=' + row.archive_positive_volume_last20 +
        ' vol60=' + row.archive_positive_volume_last60 +
        ' zero_tail=' + row.archive_zero_volume_tail +
        ' close20=' + row.archive_distinct_close_last20 +
        ' archive_repairable=' + (row.repairable_from_canonical_archive ? 'YES' : 'NO')
      );
    }
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const applyArchive = process.argv.includes('--apply-archive');
  if (apply && applyArchive) throw new Error('Pilih salah satu: --apply atau --apply-archive.');
  const store = getVpsMarketStore();

  console.log('=== DAILY FEATURE VPS COMPLETENESS ===');
  console.log('Storage: VPS_ONLY');
  console.log('DB: ' + store.filePath);
  console.log('Canonical candle archive: ' + DAILY_CANDLES_DIR);
  console.log('Mode: ' + (applyArchive
    ? 'APPLY_CANONICAL_ARCHIVE_REHYDRATE'
    : (apply ? 'APPLY_LOCAL_HISTORY_ONLY' : 'AUDIT_ONLY')));

  const eligible = await loadEligibleUniverse(store);
  const before = await readCoverage(store, eligible, DAILY_CANDLES_DIR);
  printSummary(before);

  if (!apply && !applyArchive) {
    console.log('Audit complete. No writes performed.');
    if (before.canonical_archive_rehydrate_candidate_count > 0) {
      console.log('Run with --apply-archive to rehydrate ONLY missing tickers with fresh positive-volume canonical candles.');
    } else if (before.repairable_count > 0) {
      console.log('Run with --apply to rebuild ONLY missing tickers already present in stock_daily_history.');
    } else {
      console.log('No safe repair action is available.');
    }
    return;
  }

  const repair = applyArchive
    ? await rehydrateFromCanonicalArchive(store, before, DAILY_CANDLES_DIR)
    : await repairFromLocalHistory(store, before);

  console.log('Repair attempted: ' + repair.attempted);
  if (applyArchive) {
    console.log('History rows upserted: ' + repair.history_upserted);
    console.log('Feature rows built: ' + repair.feature_built);
    console.log('Feature rows upserted: ' + repair.feature_upserted);
    console.log('Repair skipped: ' + repair.skipped.length +
      (repair.skipped.length ? ' [' + repair.skipped.join(', ') + ']' : ''));
  } else {
    console.log('Feature rows built: ' + repair.built);
    console.log('Feature rows upserted: ' + repair.upserted);
    console.log('Builder skipped_no_history: ' + repair.skipped_no_history.length +
      (repair.skipped_no_history.length ? ' [' + repair.skipped_no_history.join(', ') + ']' : ''));
  }

  const after = await readCoverage(store, eligible, DAILY_CANDLES_DIR);
  console.log('--- AFTER REPAIR ---');
  printSummary(after);

  if (after.missing_count > 0) {
    process.exitCode = 2;
    console.log('Remaining missing rows were not fabricated.');
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
  EXPECTED_ELIGIBLE_UNIVERSE,
  loadEligibleUniverse,
  normalizeCanonicalCandles,
  readCanonicalArchiveCandles,
  readCanonicalArchiveMeta,
  isArchiveRehydrateCandidate,
  summarizeFeatureCoverage,
  readCoverage,
  repairFromLocalHistory,
  rehydrateFromCanonicalArchive,
  main
};
