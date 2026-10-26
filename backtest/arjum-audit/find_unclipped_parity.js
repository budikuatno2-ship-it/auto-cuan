'use strict';
const fs = require('fs');
const path = require('path');
const brokerAccumulationLocal = require('/home/ubuntu/auto-cuan/lib/broker-accumulation-local');

const D = '/home/ubuntu/auto-cuan/data/arjum-data';
const allDir = path.join(D, 'broker-summary');
const fDir = path.join(D, 'broker-summary-F');
const accDir = path.join(D, 'broker-accumulation');

// Get all tickers in broker-summary-F that have files
const fTickers = fs.readdirSync(fDir).filter(t => fs.statSync(path.join(fDir, t)).isDirectory());
console.log('Tickers with authentic F:', fTickers.length);

const results = [];

for (const ticker of fTickers) {
  const tAllDir = path.join(allDir, ticker);
  const tFDir = path.join(fDir, ticker);
  const accFile = path.join(accDir, ticker, 'series.json');

  if (!fs.existsSync(tAllDir) || !fs.existsSync(tFDir) || !fs.existsSync(accFile)) continue;

  let apiAcc = null;
  try { apiAcc = JSON.parse(fs.readFileSync(accFile, 'utf8')); } catch (_) { continue; }
  const apiSeries = (apiAcc && (apiAcc.daily_series || apiAcc.series)) || [];
  if (apiSeries.length === 0) continue;

  const apiDateMap = new Map();
  for (const s of apiSeries) {
    if (s.date) apiDateMap.set(s.date, s);
  }

  const fFiles = fs.readdirSync(tFDir).filter(f => f.endsWith('.json') && f !== 'latest.json');
  const validDates = [];

  for (const f of fFiles) {
    const d = f.replace('.json', '');
    const pAll = path.join(tAllDir, f);
    const pF = path.join(tFDir, f);
    if (!fs.existsSync(pAll) || !fs.existsSync(pF)) continue;

    try {
      const allData = JSON.parse(fs.readFileSync(pAll, 'utf8'));
      const fData = JSON.parse(fs.readFileSync(pF, 'utf8'));
      if (fData.flow !== 'F') continue;

      // Unclipped condition: all_data === true OR broker_levels.length < 25 OR (brokers list present and < 25)
      const levelsLen = Array.isArray(allData.broker_levels) ? allData.broker_levels.length : 0;
      const brokersLen = Array.isArray(allData.brokers) ? allData.brokers.length : 0;
      const isClipped = levelsLen === 25 && allData.all_data !== true;

      if (!isClipped && apiDateMap.has(d)) {
        validDates.push({ date: d, allData, fData, apiPoint: apiDateMap.get(d) });
      }
    } catch (_) {}
  }

  if (validDates.length >= 10) {
    // Run evaluation
    const dailySeries = validDates.map(v => ({ date: v.date, broksum: v.allData }));
    const localDerived = brokerAccumulationLocal.computeBrokerAccumulation(ticker, dailySeries);
    const localMap = new Map();
    if (localDerived && Array.isArray(localDerived.series)) {
      for (const s of localDerived.series) localMap.set(s.date, s);
    }

    let matches = 0;
    let evaluated = 0;
    const sampleDiffs = [];

    for (const v of validDates) {
      evaluated++;
      const apiP = v.apiPoint;
      const locP = localMap.get(v.date);
      if (!locP) continue;

      const statusMatch = locP.status === apiP.status || locP.net_status === apiP.net_status;
      const apiVal = Number(apiP.net_val || apiP.net_value || apiP.net || 0);
      const locVal = Number(locP.net_val || locP.net_value || locP.net || 0);
      const diffPct = apiVal !== 0 ? Math.abs((locVal - apiVal) / apiVal) : (locVal === 0 ? 0 : 1);

      if (statusMatch && diffPct <= 0.01) { // 1% threshold
        matches++;
      } else {
        if (sampleDiffs.length < 2) {
          sampleDiffs.push({ date: v.date, apiStatus: apiP.status || apiP.net_status, locStatus: locP.status || locP.net_status, apiVal, locVal, diffPct: +(diffPct*100).toFixed(2) });
        }
      }
    }

    results.push({
      ticker,
      validDatesCount: validDates.length,
      evaluated,
      matches,
      matchPct: evaluated > 0 ? +(matches / evaluated * 100).toFixed(2) : 0,
      sampleDiffs
    });
  }
}

console.log('Hasil pencarian ticker dengan data all unclipped (<25 broker) & F asli:');
console.log(JSON.stringify(results.slice(0, 15), null, 2));
