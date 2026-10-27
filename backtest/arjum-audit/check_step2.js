'use strict';
const fs = require('fs');
const path = require('path');

const last10TradingDays = [
  '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09',
  '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'
];

const stateDir = '/home/ubuntu/auto-cuan/data/arjum-data/_daily-market-update';
const markersDir = '/home/ubuntu/auto-cuan/data/arjum-data/broker-summary-markers';
const eodDir = '/home/ubuntu/auto-cuan/data/arjum-data/_eod';
const candleDir = '/home/ubuntu/auto-cuan/data/daily-candles';

console.log('=== 1. STATUS HARIAN 10 HARI TERAKHIR DARI _daily-market-update & _eod ===');
const daySummary = [];
for (const d of last10TradingDays) {
  const sPath = path.join(stateDir, d + '.json');
  const ePath = path.join(eodDir, d + '.done');
  const mPath = path.join(markersDir, d + '.json');

  let state = null;
  if (fs.existsSync(sPath)) {
    try { state = JSON.parse(fs.readFileSync(sPath, 'utf8')); } catch (_) {}
  }

  let eodDone = fs.existsSync(ePath);
  let marker = null;
  if (fs.existsSync(mPath)) {
    try { marker = JSON.parse(fs.readFileSync(mPath, 'utf8')); } catch (_) {}
  }

  daySummary.push({
    date: d,
    hasState: !!state,
    stateComplete: state ? state.complete : false,
    broker_complete: state ? state.broker_complete : (marker ? marker.complete : false),
    candle_complete: state ? state.candle_complete : false,
    history_complete: state ? state.history_complete : false,
    eodDoneSentinel: eodDone,
    updated_at: state ? state.updated_at : null
  });
}
console.log(JSON.stringify(daySummary, null, 2));

console.log('\n=== 2. CEK LOG RUN TERAKHIR DI daily-market-update.log UNTUK CANDLE ===');
// Parse daily-market-update.log for summary lines
const logPath = '/home/ubuntu/auto-cuan-runner/logs/daily-market-update.log';
if (fs.existsSync(logPath)) {
  const lines = fs.readFileSync(logPath, 'utf8').split('\n');
  const candleSummaries = [];
  for (let i = lines.length - 1; i >= 0 && candleSummaries.length < 15; i--) {
    const l = lines[i];
    if (l.includes('"target_date"') && l.includes('"universe"')) {
      try {
        // Collect surrounding json
        let jsonStr = l;
        let start = i;
        while (start > 0 && !lines[start].trim().startsWith('{')) start--;
        let end = i;
        while (end < lines.length && !lines[end].trim().endsWith('}')) end++;
        const blob = lines.slice(start, end + 1).join('\n');
        const parsed = JSON.parse(blob);
        candleSummaries.push(parsed);
      } catch (_) {}
    }
  }
  console.log('Sample candle run summaries from log:');
  console.log(JSON.stringify(candleSummaries.slice(0, 10), null, 2));
}

console.log('\n=== 3. CEK DATA CANDLE UNTUK BBCA, BRPT, MEDC, ADRO, DAN 1 SAHAM SEPI (CASH / ZONE) ===');
const checkTickers = ['BBCA', 'BRPT', 'MEDC', 'ADRO', 'CASH', 'AYAM'];

for (const t of checkTickers) {
  const p = path.join(candleDir, t + '.json');
  if (!fs.existsSync(p)) {
    console.log(`Ticker ${t}: FILE TIDAK DITEMUKAN`);
    continue;
  }
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  const candles = data.candles || [];
  
  // Check duplicates
  const dates = candles.map(c => c.date);
  const uniqueDates = new Set(dates);
  const hasDupes = dates.length !== uniqueDates.size;

  // Check 2026 trading days
  const candles2026 = candles.filter(c => c.date && c.date.startsWith('2026'));
  const firstDate = candles.length ? candles[0].date : null;
  const lastDate = candles.length ? candles[candles.length - 1].date : null;

  // Check OHLC consistency & volume
  let ohlcAnomaly = 0;
  let negativeVol = 0;
  let zeroVol = 0;
  let nullVol = 0;

  for (const c of candles) {
    const o = Number(c.open), h = Number(c.high), l = Number(c.low), cl = Number(c.close), v = Number(c.volume);
    if (l > o || l > cl || h < o || h < cl || l > h) ohlcAnomaly++;
    if (v < 0) negativeVol++;
    if (v === 0) zeroVol++;
    if (c.volume == null) nullVol++;
  }

  // Last 5 bars
  const last5 = candles.slice(-5);

  console.log(JSON.stringify({
    ticker: t,
    source: data.source,
    range: data.range,
    interval: data.interval,
    totalCandles: candles.length,
    candles2026Count: candles2026.length,
    firstDate,
    lastDate,
    hasDuplicates: hasDupes,
    ohlcAnomalies: ohlcAnomaly,
    negativeVolumes: negativeVol,
    zeroVolumes: zeroVol,
    nullVolumes: nullVol,
    latestBar: last5[last5.length - 1]
  }, null, 2));
}
