'use strict';

const fs = require('fs');
const path = require('path');

const baseDir = '/home/ubuntu/auto-cuan/data/arjum-data';
const allDir = path.join(baseDir, 'broker-summary');
const fDir = path.join(baseDir, 'broker-summary-F');
const candlesDir = '/home/ubuntu/auto-cuan/data/daily-candles';

// Load trading days from IHSG
const ihsg = JSON.parse(fs.readFileSync(path.join(candlesDir, 'IHSG.json'), 'utf8'));
const tradingDays = (ihsg.candles || [])
  .map(c => c.date || c.time)
  .filter(d => d >= '2026-01-02' && d <= '2026-10-16')
  .sort();
const totalTradingDays = tradingDays.length;

// Identify liquid tickers (avg turnover >= Rp 1 Miliar/day)
const tickers = fs.readdirSync(candlesDir).filter(f => f.endsWith('.json') && f !== 'IHSG.json').map(f => f.replace('.json', ''));
const liquid = [];
const regular = [];

for (const tk of tickers) {
  try {
    const cd = JSON.parse(fs.readFileSync(path.join(candlesDir, `${tk}.json`), 'utf8'));
    const inRange = (cd.candles || []).filter(c => (c.date || c.time) >= '2026-01-02' && (c.date || c.time) <= '2026-10-16');
    if (inRange.length > 0) {
      const sum = inRange.reduce((a, c) => a + (Number(c.volume || 0) * Number(c.close || 0)), 0);
      const avgTurnover = sum / inRange.length;
      if (avgTurnover >= 1e9) liquid.push(tk);
      else regular.push(tk);
    }
  } catch (_) {}
}

// For each liquid ticker, count days with authentic F + unclipped all
let totalGridCells = liquid.length * totalTradingDays;
let coveredCells = 0;
let fPresentCells = 0;
let allUnclippedCells = 0;
let bothCells = 0;

const tickerCoverage = [];

for (const tk of liquid) {
  let tCovered = 0;
  let tF = 0;
  let tAll = 0;
  let tBoth = 0;

  for (const d of tradingDays) {
    const fPath = path.join(fDir, tk, `${d}.json`);
    const allPath = path.join(allDir, tk, `${d}.json`);

    let hasAuthenticF = false;
    if (fs.existsSync(fPath)) {
      try {
        const p = JSON.parse(fs.readFileSync(fPath, 'utf8'));
        if (p.flow === 'F' && p.derived !== 'no-trade') hasAuthenticF = true;
        else if (p.derived === 'no-trade') hasAuthenticF = true; // no-trade is valid
      } catch (_) {}
    }

    let hasUnclippedAll = false;
    if (fs.existsSync(allPath)) {
      try {
        const p = JSON.parse(fs.readFileSync(allPath, 'utf8'));
        const lc = Array.isArray(p.broker_levels) ? p.broker_levels.length : 0;
        const bc = Array.isArray(p.brokers) ? p.brokers.length : 0;
        if (p.derived === 'no-trade') hasUnclippedAll = true;
        else if (lc !== 25 || p.all_data === true) hasUnclippedAll = true;
        else if (bc > 0 && lc === 0) hasUnclippedAll = true;
      } catch (_) {}
    }

    if (hasAuthenticF) tF++;
    if (hasUnclippedAll) tAll++;
    if (hasAuthenticF && hasUnclippedAll) tBoth++;
    if (hasAuthenticF || hasUnclippedAll) tCovered++;
  }

  coveredCells += tCovered;
  fPresentCells += tF;
  allUnclippedCells += tAll;
  bothCells += tBoth;

  tickerCoverage.push({
    ticker: tk,
    fPct: ((tF / totalTradingDays) * 100).toFixed(1) + '%',
    allPct: ((tAll / totalTradingDays) * 100).toFixed(1) + '%',
    bothPct: ((tBoth / totalTradingDays) * 100).toFixed(1) + '%'
  });
}

const summary = {
  liquidTickersCount: liquid.length,
  regularTickersCount: regular.length,
  totalTradingDays,
  totalGridCells,
  fPresentPct: ((fPresentCells / totalGridCells) * 100).toFixed(2) + '%',
  allUnclippedPct: ((allUnclippedCells / totalGridCells) * 100).toFixed(2) + '%',
  bothPct: ((bothCells / totalGridCells) * 100).toFixed(2) + '%',
  fase3ConditionMet: (bothCells / totalGridCells) >= 0.90,
  top20Coverage: tickerCoverage.sort((a, b) => parseFloat(b.bothPct) - parseFloat(a.bothPct)).slice(0, 20),
  bottom20Coverage: tickerCoverage.slice(-20)
};

console.log(JSON.stringify(summary, null, 2));
