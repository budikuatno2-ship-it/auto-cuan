'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Pure aggregation function for order flow done-details.
 * Computes RG board metrics and separate NG value.
 */
function aggregateDoneDetails(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  // 1. Separate board NG
  let ngVal = 0;
  const rgRows = [];

  for (const r of rows) {
    const board = String(r.market_board || 'RG').toUpperCase();
    const val = Number(r.value_raw || 0);
    if (board === 'NG') {
      ngVal += val;
    } else {
      rgRows.push(r);
    }
  }

  if (rgRows.length === 0) {
    return {
      n: 0, val: 0, vol: 0, vwap: 0,
      buyAggVal: 0, sellAggVal: 0,
      p50: 0, p90: 0, p95: 0, p99: 0,
      bigBuyVal: 0, bigSellVal: 0, bigN: 0,
      fBuyVal: 0, fSellVal: 0,
      fAggBuyVal: 0, fAggSellVal: 0,
      ngVal: Math.round(ngVal),
      first: null, last: null
    };
  }

  const n = rgRows.length;
  let val = 0;
  let vol = 0;
  let buyAggVal = 0;
  let sellAggVal = 0;
  let fBuyVal = 0;
  let fSellVal = 0;
  let fAggBuyVal = 0;
  let fAggSellVal = 0;

  const vals = [];
  const times = [];

  for (const r of rgRows) {
    const vRaw = Number(r.value_raw || 0);
    const shares = Number(r.qty_num || 0) * 100;
    const action = String(r.action || '').toUpperCase();
    const bType = String(r.buyer_type || '').toUpperCase();
    const sType = String(r.seller_type || '').toUpperCase();

    val += vRaw;
    vol += shares;
    vals.push(vRaw);
    if (r.time) times.push(String(r.time));

    // Aggressor action
    if (action === 'BUY') {
      buyAggVal += vRaw;
    } else if (action === 'SELL') {
      sellAggVal += vRaw;
    }

    // Foreign participants
    if (bType === 'F') {
      fBuyVal += vRaw;
      if (action === 'BUY') fAggBuyVal += vRaw;
    }
    if (sType === 'F') {
      fSellVal += vRaw;
      if (action === 'SELL') fAggSellVal += vRaw;
    }
  }

  // Sort values for percentiles
  vals.sort((a, b) => a - b);
  const p50 = vals[Math.floor(0.50 * (n - 1))];
  const p90 = vals[Math.floor(0.90 * (n - 1))];
  const p95 = vals[Math.floor(0.95 * (n - 1))];
  const p99 = vals[Math.floor(0.99 * (n - 1))];

  // Big transactions (value >= p95)
  let bigBuyVal = 0;
  let bigSellVal = 0;
  let bigN = 0;

  for (const r of rgRows) {
    const vRaw = Number(r.value_raw || 0);
    if (vRaw >= p95) {
      bigN++;
      const action = String(r.action || '').toUpperCase();
      if (action === 'BUY') bigBuyVal += vRaw;
      else if (action === 'SELL') bigSellVal += vRaw;
    }
  }

  // Sort times for first and last
  times.sort();
  const first = times[0] || null;
  const last = times[times.length - 1] || null;
  const vwap = vol > 0 ? Math.round(val / vol) : 0;

  return {
    n,
    val: Math.round(val),
    vol: Math.round(vol),
    vwap,
    buyAggVal: Math.round(buyAggVal),
    sellAggVal: Math.round(sellAggVal),
    p50: Math.round(p50),
    p90: Math.round(p90),
    p95: Math.round(p95),
    p99: Math.round(p99),
    bigBuyVal: Math.round(bigBuyVal),
    bigSellVal: Math.round(bigSellVal),
    bigN,
    fBuyVal: Math.round(fBuyVal),
    fSellVal: Math.round(fSellVal),
    fAggBuyVal: Math.round(fAggBuyVal),
    fAggSellVal: Math.round(fAggSellVal),
    ngVal: Math.round(ngVal),
    first,
    last
  };
}

// Verification on sample_BRPT_20261016.json
function verifySample() {
  const samplePath = path.join(__dirname, 'sample_BRPT_20261016.json');
  if (!fs.existsSync(samplePath)) {
    console.error('sample_BRPT_20261016.json not found');
    return;
  }
  const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
  console.log(`Verifying aggregation logic on ${sample.length} rows...`);

  // Manual independent counts
  let manualNgVal = 0;
  let manualRgN = 0;
  let manualRgVal = 0;
  let manualRgVol = 0;
  let manualBuyAgg = 0;
  let manualSellAgg = 0;
  let manualFBuy = 0;
  let manualFSell = 0;
  let manualFAggBuy = 0;
  let manualFAggSell = 0;
  const manualVals = [];
  const manualTimes = [];

  for (const r of sample) {
    const val = Number(r.value_raw || 0);
    if (r.market_board === 'NG') {
      manualNgVal += val;
    } else {
      manualRgN++;
      manualRgVal += val;
      manualRgVol += Number(r.qty_num || 0) * 100;
      manualVals.push(val);
      manualTimes.push(r.time);
      if (r.action === 'BUY') manualBuyAgg += val;
      if (r.action === 'SELL') manualSellAgg += val;
      if (r.buyer_type === 'F') {
        manualFBuy += val;
        if (r.action === 'BUY') manualFAggBuy += val;
      }
      if (r.seller_type === 'F') {
        manualFSell += val;
        if (r.action === 'SELL') manualFAggSell += val;
      }
    }
  }

  manualVals.sort((a, b) => a - b);
  manualTimes.sort();
  const manualP95 = manualVals[Math.floor(0.95 * (manualRgN - 1))];
  let manualBigBuy = 0, manualBigSell = 0, manualBigN = 0;
  for (const r of sample) {
    if (r.market_board !== 'NG' && Number(r.value_raw || 0) >= manualP95) {
      manualBigN++;
      if (r.action === 'BUY') manualBigBuy += Number(r.value_raw);
      if (r.action === 'SELL') manualBigSell += Number(r.value_raw);
    }
  }

  const agg = aggregateDoneDetails(sample);

  console.log('Manual vs Aggregate Check:');
  console.log('  n:        ', agg.n, '===', manualRgN, agg.n === manualRgN ? 'OK' : 'MISMATCH');
  console.log('  val:      ', agg.val, '===', manualRgVal, agg.val === manualRgVal ? 'OK' : 'MISMATCH');
  console.log('  vol:      ', agg.vol, '===', manualRgVol, agg.vol === manualRgVol ? 'OK' : 'MISMATCH');
  console.log('  buyAggVal:', agg.buyAggVal, '===', manualBuyAgg, agg.buyAggVal === manualBuyAgg ? 'OK' : 'MISMATCH');
  console.log('  sellAggVal:', agg.sellAggVal, '===', manualSellAgg, agg.sellAggVal === manualSellAgg ? 'OK' : 'MISMATCH');
  console.log('  ngVal:    ', agg.ngVal, '===', manualNgVal, agg.ngVal === manualNgVal ? 'OK' : 'MISMATCH');
  console.log('  p95:      ', agg.p95, '===', manualP95, agg.p95 === manualP95 ? 'OK' : 'MISMATCH');
  console.log('  bigN:     ', agg.bigN, '===', manualBigN, agg.bigN === manualBigN ? 'OK' : 'MISMATCH');
  console.log('  fAggBuy:  ', agg.fAggBuyVal, '===', manualFAggBuy, agg.fAggBuyVal === manualFAggBuy ? 'OK' : 'MISMATCH');
  console.log('  first:    ', agg.first, '===', manualTimes[0], agg.first === manualTimes[0] ? 'OK' : 'MISMATCH');
  console.log('  last:     ', agg.last, '===', manualTimes[manualTimes.length - 1], agg.last === manualTimes[manualTimes.length - 1] ? 'OK' : 'MISMATCH');

  console.log('\nAggregated Object:');
  console.log(JSON.stringify(agg, null, 2));
}

if (require.main === module) {
  verifySample();
}

module.exports = {
  aggregateDoneDetails
};
