'use strict';

const fs = require('fs');
const path = require('path');
const brokerAccumulationLocal = require('/home/ubuntu/auto-cuan/lib/broker-accumulation-local');

// Check what tickers have series.json on VPS and check unclipped dates
const baseDir = '/home/ubuntu/auto-cuan/data/arjum-data';
const accumDir = path.join(baseDir, 'broker-accumulation');
const broksumDir = path.join(baseDir, 'broker-summary');

const testTickers = ['BBCA', 'BRPT', 'BBRI', 'MEDC', 'ADRO', 'BUMI', 'BMRI', 'TPIA', 'BBNI', 'TLKM'];
const results = [];

for (const tk of testTickers) {
  const tkAccumFile = path.join(accumDir, tk, 'series.json');
  if (!fs.existsSync(tkAccumFile)) {
    results.push({ ticker: tk, status: 'no_series_json' });
    continue;
  }

  let authentic = null;
  try {
    authentic = JSON.parse(fs.readFileSync(tkAccumFile, 'utf8'));
  } catch (e) {
    results.push({ ticker: tk, status: 'corrupt_series_json', error: e.message });
    continue;
  }

  // Find date range from authentic series
  if (!authentic.series || authentic.series.length === 0 || !authentic.series[0].points) {
    results.push({ ticker: tk, status: 'empty_authentic_series' });
    continue;
  }

  const authenticDates = authentic.series[0].points.map(p => p.date).sort();
  const startDate = authenticDates[0];
  const endDate = authenticDates[authenticDates.length - 1];

  // Check if daily broksum exists and is unclipped for each date
  let totalDates = authenticDates.length;
  let unclippedDates = 0;
  let clippedDates = 0;
  let missingDates = 0;
  const dailySeries = [];

  for (const d of authenticDates) {
    const fPath = path.join(broksumDir, tk, `${d}.json`);
    if (!fs.existsSync(fPath)) {
      missingDates++;
      continue;
    }
    try {
      const bData = JSON.parse(fs.readFileSync(fPath, 'utf8'));
      const isClipped = Array.isArray(bData.broker_levels) && bData.broker_levels.length === 25 && bData.all_data !== true;
      if (isClipped) clippedDates++;
      else unclippedDates++;
      dailySeries.push({ date: d, broksum: bData });
    } catch (_) {
      missingDates++;
    }
  }

  const isFullUnclipped = clippedDates === 0 && missingDates === 0 && unclippedDates === totalDates;

  // Test local computation against authentic
  let parityReport = null;
  if (dailySeries.length > 0) {
    const localCalc = brokerAccumulationLocal.computeBrokerAccumulation(tk, dailySeries);

    // Compare top buyers & sellers
    const authTopBuyers = (authentic.top_buyers || []).map(b => b.broker_code);
    const localTopBuyers = (localCalc.top_buyers || []).map(b => b.broker_code);
    const authTopSellers = (authentic.top_sellers || []).map(b => b.broker_code);
    const localTopSellers = (localCalc.top_sellers || []).map(b => b.broker_code);

    // Compare net values for top buyers
    const buyerDiffs = [];
    (authentic.top_buyers || []).forEach(b => {
      const localMatch = (localCalc.top_buyers || []).find(x => x.broker_code === b.broker_code);
      if (localMatch) {
        const diffVal = Math.abs(b.total_nval - localMatch.total_nval);
        const pctDiff = b.total_nval !== 0 ? (diffVal / Math.abs(b.total_nval)) * 100 : 0;
        buyerDiffs.push({ broker: b.broker_code, authVal: b.total_nval, localVal: localMatch.total_nval, diffVal, pctDiff: Number(pctDiff.toFixed(2)) });
      } else {
        buyerDiffs.push({ broker: b.broker_code, authVal: b.total_nval, localVal: null, missing: true });
      }
    });

    const sellerDiffs = [];
    (authentic.top_sellers || []).forEach(b => {
      const localMatch = (localCalc.top_sellers || []).find(x => x.broker_code === b.broker_code);
      if (localMatch) {
        const diffVal = Math.abs(b.total_nval - localMatch.total_nval);
        const pctDiff = b.total_nval !== 0 ? (diffVal / Math.abs(b.total_nval)) * 100 : 0;
        sellerDiffs.push({ broker: b.broker_code, authVal: b.total_nval, localVal: localMatch.total_nval, diffVal, pctDiff: Number(pctDiff.toFixed(2)) });
      } else {
        sellerDiffs.push({ broker: b.broker_code, authVal: b.total_nval, localVal: null, missing: true });
      }
    });

    parityReport = {
      authTopBuyers,
      localTopBuyers,
      authTopSellers,
      localTopSellers,
      buyerRankMatch: JSON.stringify(authTopBuyers) === JSON.stringify(localTopBuyers),
      sellerRankMatch: JSON.stringify(authTopSellers) === JSON.stringify(localTopSellers),
      buyerDiffs,
      sellerDiffs
    };
  }

  results.push({
    ticker: tk,
    totalDates,
    startDate,
    endDate,
    unclippedDates,
    clippedDates,
    missingDates,
    isFullUnclipped,
    parityReport
  });
}

console.log(JSON.stringify(results, null, 2));
