'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const VPS_CSV_DIR = path.join(DATA_DIR, 'vps_csv');
const REPORT_PATH = path.join(VPS_CSV_DIR, 'validation_report.json');

function validate() {
  console.log('====================================================');
  console.log('STEP 3: Validate VPS Data vs Yahoo & Local Reference');
  console.log('====================================================\n');

  const report = {
    timestamp: new Date().toISOString(),
    tradingview_csv_status: 'NOT_FOUND_ON_VPS_OR_LOCAL',
    foreign_flow: {},
    ohlcv_comparison: {}
  };

  // 1. Foreign flow validation
  const foreignCsvPath = path.join(VPS_CSV_DIR, 'brpt_foreign_flow_vps.csv');
  const foreignJsonPath = path.join(DATA_DIR, 'vps_brpt_foreign.json');

  const foreignCsvLines = fs.readFileSync(foreignCsvPath, 'utf8').trim().split('\n');
  const headers = foreignCsvLines[0].split(',');
  const foreignCsvRows = foreignCsvLines.slice(1).map(line => {
    const vals = line.split(',');
    const obj = {};
    headers.forEach((h, idx) => obj[h.trim()] = vals[idx]?.trim());
    return obj;
  });

  const foreignJsonRows = JSON.parse(fs.readFileSync(foreignJsonPath, 'utf8'));

  // Check duplicates
  const seenDates = new Set();
  let duplicates = 0;
  for (const r of foreignCsvRows) {
    if (seenDates.has(r.trade_date)) duplicates++;
    seenDates.add(r.trade_date);
  }

  // Cross check CSV vs JSON
  let matchCount = 0;
  const discrepancies = [];
  for (let i = 0; i < foreignCsvRows.length; i++) {
    const csv = foreignCsvRows[i];
    const json = foreignJsonRows[i];

    const netDiff = Number(csv.foreign_net) - Number(json.foreign_net);
    const nbsaDiff = Number(csv.nbsa) - Number(json.nbsa);
    const closeDiff = Number(csv.close) - Number(json.close);

    if (netDiff === 0 && nbsaDiff === 0 && closeDiff === 0) {
      matchCount++;
    } else {
      discrepancies.push({ date: csv.trade_date, netDiff, nbsaDiff, closeDiff });
    }
  }

  report.foreign_flow = {
    file: 'brpt_foreign_flow_vps.csv',
    total_records: foreignCsvRows.length,
    min_date: foreignCsvRows[0]?.trade_date,
    max_date: foreignCsvRows[foreignCsvRows.length - 1]?.trade_date,
    duplicates,
    unit_foreign_net: 'IDR Nominal (Rupiah)',
    unit_nbsa: 'Shares (Lembar)',
    exact_matches_vs_json: matchCount,
    discrepancies
  };

  console.log(`Foreign Flow Validation:`);
  console.log(`  -> Records: ${foreignCsvRows.length} (${report.foreign_flow.min_date} to ${report.foreign_flow.max_date})`);
  console.log(`  -> Exact matches vs vps_brpt_foreign.json: ${matchCount}/${foreignCsvRows.length}`);
  console.log(`  -> Discrepancies: ${discrepancies.length}\n`);

  // 2. OHLCV comparison
  const historyCsvPath = path.join(VPS_CSV_DIR, 'brpt_daily_history_vps.csv');
  const yahooJsonPath = path.join(DATA_DIR, 'yahoo_brpt_5y.json');

  const historyCsvLines = fs.readFileSync(historyCsvPath, 'utf8').trim().split('\n');
  const hHeaders = historyCsvLines[0].split(',');
  const vpsHistoryRows = historyCsvLines.slice(1).map(line => {
    const vals = line.split(',');
    const obj = {};
    hHeaders.forEach((h, idx) => obj[h.trim()] = vals[idx]?.trim());
    return obj;
  });

  const yahooRows = JSON.parse(fs.readFileSync(yahooJsonPath, 'utf8'));
  const yahooMap = new Map();
  yahooRows.forEach(y => yahooMap.set(y.date, y));

  let ohlcExactMatches = 0;
  let ohlcOverlapping = 0;
  const ohlcMismatches = [];

  for (const v of vpsHistoryRows) {
    if (yahooMap.has(v.trade_date)) {
      ohlcOverlapping++;
      const y = yahooMap.get(v.trade_date);
      const diffO = Number(v.open) - y.open;
      const diffH = Number(v.high) - y.high;
      const diffL = Number(v.low) - y.low;
      const diffC = Number(v.close) - y.close;
      const diffV = Number(v.volume) - y.volume;

      if (diffO === 0 && diffH === 0 && diffL === 0 && diffC === 0) {
        ohlcExactMatches++;
      } else {
        ohlcMismatches.push({
          date: v.trade_date,
          diff: { open: diffO, high: diffH, low: diffL, close: diffC, volume: diffV }
        });
      }
    }
  }

  report.ohlcv_comparison = {
    vps_history_records: vpsHistoryRows.length,
    yahoo_total_records: yahooRows.length,
    overlapping_dates: ohlcOverlapping,
    exact_price_matches: ohlcExactMatches,
    price_match_rate_pct: Math.round((ohlcExactMatches / ohlcOverlapping) * 1000) / 10,
    mismatches: ohlcMismatches
  };

  console.log(`OHLCV Validation:`);
  console.log(`  -> Overlapping Dates: ${ohlcOverlapping}`);
  console.log(`  -> Price Match Rate: ${report.ohlcv_comparison.price_match_rate_pct}% (${ohlcExactMatches}/${ohlcOverlapping})`);
  console.log(`  -> Price Mismatches: ${ohlcMismatches.length}`);

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`\nValidation report saved to: ${REPORT_PATH}`);
  console.log('====================================================\n');
}

validate();
