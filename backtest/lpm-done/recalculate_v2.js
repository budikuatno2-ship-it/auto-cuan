'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { aggregateDoneDetailsV2, calculateIdxAraArb } = require('./aggregate_v2');

const BASE_DIR = __dirname;
const RAW_DIR = path.join(BASE_DIR, 'raw');
const AGG_V1_DIR = path.join(BASE_DIR, 'agg');
const AGG_V2_DIR = path.join(BASE_DIR, 'agg_v2');
const CANDLES_DIR = path.join(BASE_DIR, '..', 'dua-skenario', 'data', 'arjum_raw', 'daily-candles');

if (!fs.existsSync(AGG_V2_DIR)) {
  fs.mkdirSync(AGG_V2_DIR, { recursive: true });
}

function getPrevClose(ticker, date) {
  const cPath = path.join(CANDLES_DIR, `${ticker}.json`);
  if (!fs.existsSync(cPath)) return null;
  try {
    const d = JSON.parse(fs.readFileSync(cPath, 'utf8'));
    if (!d || !Array.isArray(d.candles)) return null;
    const idx = d.candles.findIndex(c => c.date === date);
    if (idx > 0) return d.candles[idx - 1].close;
  } catch (_) {}
  return null;
}

function loadGzipJsonl(filePath) {
  const buf = fs.readFileSync(filePath);
  const text = zlib.gunzipSync(buf).toString('utf8');
  return text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function main() {
  console.log('====================================================');
  console.log('RECALCULATING AGGREGATES V2 (SESSION & LOCKED FILTER)');
  console.log('====================================================\n');

  const dates = fs.readdirSync(RAW_DIR).filter(d => fs.statSync(path.join(RAW_DIR, d)).isDirectory());
  const comparisons = [];

  for (const date of dates) {
    const dateRawDir = path.join(RAW_DIR, date);
    const files = fs.readdirSync(dateRawDir).filter(f => f.endsWith('.jsonl.gz'));

    const aggV1Path = path.join(AGG_V1_DIR, `${date}.json`);
    const aggV1Map = fs.existsSync(aggV1Path) ? JSON.parse(fs.readFileSync(aggV1Path, 'utf8')) : {};
    const aggV2Map = {};

    console.log(`Processing date: ${date} (${files.length} stocks)...`);

    for (const file of files) {
      const code = file.replace('.jsonl.gz', '').toUpperCase();
      const rawRows = loadGzipJsonl(path.join(dateRawDir, file));
      const prevClose = getPrevClose(code, date);

      const v2 = aggregateDoneDetailsV2(rawRows, prevClose);
      aggV2Map[code] = v2;

      const v1 = aggV1Map[code] || null;

      comparisons.push({
        date,
        code,
        prevClose,
        araPx: v2.araPx,
        arbPx: v2.arbPx,
        v1: v1 ? {
          val: v1.val,
          buyAggVal: v1.buyAggVal,
          sellAggVal: v1.sellAggVal,
          buyAggPct: v1.val > 0 ? +(v1.buyAggVal / v1.val * 100).toFixed(1) : 0,
          p95: v1.p95,
          fAggBuyVal: v1.fAggBuyVal
        } : null,
        v2: {
          val: v2.val,
          contVal: v2.contVal,
          auctionVal: v2.auctionVal,
          postVal: v2.postVal,
          lockedVal: v2.lockedVal,
          lockedSide: v2.lockedSide,
          lockedSharePct: +(v2.lockedShare * 100).toFixed(1),
          cleanContinuousN: v2.cleanContinuousN,
          buyAggVal: v2.buyAggVal,
          sellAggVal: v2.sellAggVal,
          buyAggPct: v2.contVal > 0 ? +(v2.buyAggVal / v2.contVal * 100).toFixed(1) : 0,
          p95: v2.p95,
          fAggBuyVal: v2.fAggBuyVal
        }
      });

      console.log(`  -> ${code} ${date}: Total Rp ${(v2.val/1e9).toFixed(2)}M, Locked Rp ${(v2.lockedVal/1e9).toFixed(2)}M (${(v2.lockedShare*100).toFixed(1)}% ${v2.lockedSide || '-'}), Clean Cont BuyAgg: Rp ${(v2.buyAggVal/1e9).toFixed(2)}M, Auction: Rp ${(v2.auctionVal/1e9).toFixed(2)}M`);
    }

    // Save agg_v2/<date>.json
    const aggV2Path = path.join(AGG_V2_DIR, `${date}.json`);
    fs.writeFileSync(aggV2Path, JSON.stringify(aggV2Map, null, 2));
    console.log(`Saved ${aggV2Path}\n`);
  }

  // Save comparison report
  const compReportPath = path.join(BASE_DIR, 'comparison_v1_v2.json');
  fs.writeFileSync(compReportPath, JSON.stringify(comparisons, null, 2));
  console.log(`Comparison report saved to: ${compReportPath}`);

  // Test checks
  console.log('\n--- VERIFICATION CHECKS ---');
  const brpt16 = comparisons.find(c => c.code === 'BRPT' && c.date === '2026-10-16');
  if (brpt16) {
    console.log('Check 1 (BRPT 16 Okt):');
    console.log('  Locked Side:', brpt16.v2.lockedSide, brpt16.v2.lockedSide === 'ARB' ? 'PASS' : 'FAIL');
    console.log('  Locked Share:', brpt16.v2.lockedSharePct + '%', brpt16.v2.lockedSharePct > 90 ? 'PASS' : 'FAIL');
    console.log('  v1 BuyAggVal:', brpt16.v1?.buyAggVal, '-> v2 BuyAggVal:', brpt16.v2.buyAggVal);
    console.log('  v1 FAggBuyVal:', brpt16.v1?.fAggBuyVal, '-> v2 FAggBuyVal:', brpt16.v2.fAggBuyVal);
  }

  const brpt8 = comparisons.find(c => c.code === 'BRPT' && c.date === '2026-09-08');
  if (brpt8) {
    console.log('\nCheck 2 (BRPT 8 Sep Normal Day):');
    console.log('  Locked Side:', brpt8.v2.lockedSide, brpt8.v2.lockedSide === null ? 'PASS' : 'FAIL');
    console.log('  Locked Val:', brpt8.v2.lockedVal, brpt8.v2.lockedVal === 0 ? 'PASS' : 'FAIL');
    const diffVal = brpt8.v1.val - (brpt8.v2.contVal + brpt8.v2.auctionVal + brpt8.v2.postVal);
    console.log('  Val Sum Identity (cont + auction + post === total):', diffVal === 0 ? 'PASS' : 'FAIL');
  }
}

main();
