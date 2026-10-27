'use strict';
const fs = require('fs');
const path = require('path');

const D = '/home/ubuntu/auto-cuan/data/arjum-data';
const fDir = path.join(D, 'broker-summary-F');
const allDir = path.join(D, 'broker-summary');
const txt = '/home/ubuntu/auto-cuan/data/daytrade-observe-tickers.txt';

const tickers = fs.readFileSync(txt, 'utf8').split(/\r?\n/).map(s => s.trim().toUpperCase()).filter(s => /^[A-Z]{4}$/.test(s));
console.log('Total Tickers in observe universe:', tickers.length);

// Count trading days in scope (from daily candles of BBCA)
const bbcaCandleFile = '/home/ubuntu/auto-cuan/data/daily-candles/BBCA.json';
const bbcaCandles = JSON.parse(fs.readFileSync(bbcaCandleFile, 'utf8')).candles;
const tradingDays = bbcaCandles.map(c => c.date).filter(d => d >= '2026-01-02' && d <= '2026-10-16');
console.log('Total trading days (2026-01-02 to 2026-10-16):', tradingDays.length);

const totalExpectedPairs = tickers.length * tradingDays.length;
console.log('Total expected ticker x date pairs:', totalExpectedPairs);

// 1. Sisa file F asli
let existingFCount = 0;
let missingFCount = 0;

for (const t of tickers) {
  const tDir = path.join(fDir, t);
  if (!fs.existsSync(tDir)) {
    missingFCount += tradingDays.length;
    continue;
  }
  for (const d of tradingDays) {
    const fPath = path.join(tDir, `${d}.json`);
    if (fs.existsSync(fPath)) {
      try {
        const p = JSON.parse(fs.readFileSync(fPath, 'utf8'));
        if (p.flow === 'F') existingFCount++;
        else missingFCount++;
      } catch (_) {
        missingFCount++;
      }
    } else {
      missingFCount++;
    }
  }
}

console.log('Existing authentic flow=F files:', existingFCount);
console.log('Remaining missing Foreign requests:', missingFCount);

// 2. Re-fetch All yang terpotong (clipped to 25 levels)
let totalAllFiles = 0;
let clippedAllFiles = 0;
let unclippedAllFiles = 0;

for (const t of tickers) {
  const tDir = path.join(allDir, t);
  if (!fs.existsSync(tDir)) continue;
  for (const d of tradingDays) {
    const p = path.join(tDir, `${d}.json`);
    if (fs.existsSync(p)) {
      totalAllFiles++;
      try {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (Array.isArray(parsed.broker_levels) && parsed.broker_levels.length === 25 && parsed.all_data !== true) {
          clippedAllFiles++;
        } else {
          unclippedAllFiles++;
        }
      } catch (_) {}
    }
  }
}

console.log({
  totalAllFiles,
  clippedAllFiles,
  unclippedAllFiles
});
