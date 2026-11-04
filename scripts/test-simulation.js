'use strict';

const fs = require('fs');
const path = require('path');
const lp = require('../lib/liquidity-profiler');

const dir = path.join(__dirname, '..', 'data', 'daily-candles');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'IHSG.json');
const universeTickers = files.map(f => f.replace('.json', '')).sort();

const CONGLOMERATE_TICKERS = new Set([
  'BBCA', 'TOWR', 'BELI', 'RANC', 'SUPR',
  'JARR', 'PGUN', 'PACK',
  'BREN', 'BRPT', 'CUAN', 'TPIA', 'PTRO',
  'INDF', 'ICBP', 'AMMN', 'BUMI', 'BRMS', 'DCII', 'DNET', 'EMTK',
  'ADRO', 'AADI', 'ESSA', 'MBMA', 'PALM', 'TRIM', 'MDKA', 'SRTG',
  'ABMM', 'BMTR', 'CFIN', 'DILD', 'GJTL', 'SIMP', 'BNGA',
  'TLKM', 'ASII', 'BMRI', 'BBNI', 'UNTR', 'KLBF', 'CPIN', 'PGAS', 'SMGR'
]);

// 1. Classify Universe into Tier 1 and Tier 2
const tier1Tickers = [];
const tier2Tickers = [];

for (const ticker of universeTickers) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, `${ticker}.json`), 'utf8'));
    const candles = raw.candles || raw;
    const prof = lp.calculateLiquidityProfile(candles, { ticker });
    const isConglo = CONGLOMERATE_TICKERS.has(ticker);

    if (prof.isLiquid || isConglo) {
      tier1Tickers.push(ticker);
    } else {
      tier2Tickers.push(ticker);
    }
  } catch (e) {
    tier2Tickers.push(ticker);
  }
}

console.log(`Tier 1: ${tier1Tickers.length} emiten`);
console.log(`Tier 2: ${tier2Tickers.length} emiten`);

// Option 1: Group A (Mon & Thu) and Group B (Tue & Fri), Sweep on Wed
const groupA = [];
const groupB = [];
tier2Tickers.forEach((ticker, idx) => {
  if (idx % 2 === 0) groupA.push(ticker);
  else groupB.push(ticker);
});

console.log(`Group A: ${groupA.length}, Group B: ${groupB.length}`);

// Simulate 7 trading days
// Day 1: Mon (Tier 1 + Group A)
// Day 2: Tue (Tier 1 + Group B)
// Day 3: Wed (Tier 1 + Sweep)
// Day 4: Thu (Tier 1 + Group A)
// Day 5: Fri (Tier 1 + Group B)
// Day 6: Mon (Tier 1 + Group A)
// Day 7: Tue (Tier 1 + Group B)

const days = [
  { day: 1, name: 'Senin (W1)', groups: ['Tier 1', 'Group A'], count: tier1Tickers.length + groupA.length },
  { day: 2, name: 'Selasa (W1)', groups: ['Tier 1', 'Group B'], count: tier1Tickers.length + groupB.length },
  { day: 3, name: 'Rabu (W1)', groups: ['Tier 1', 'Sweep/Cadangan'], count: tier1Tickers.length },
  { day: 4, name: 'Kamis (W1)', groups: ['Tier 1', 'Group A'], count: tier1Tickers.length + groupA.length },
  { day: 5, name: 'Jumat (W1)', groups: ['Tier 1', 'Group B'], count: tier1Tickers.length + groupB.length },
  { day: 6, name: 'Senin (W2)', groups: ['Tier 1', 'Group A'], count: tier1Tickers.length + groupA.length },
  { day: 7, name: 'Selasa (W2)', groups: ['Tier 1', 'Group B'], count: tier1Tickers.length + groupB.length }
];

const totalReq7d = days.reduce((acc, d) => acc + d.count, 0);
const avgReq7d = totalReq7d / 7;

console.log('Simulation 7 Days:');
days.forEach(d => console.log(` Day ${d.day} [${d.name}]: ${d.count} req`));
console.log(`Average 7 Days: ${avgReq7d.toFixed(1)} req/day`);

// Weekly check for Tier 2 emiten (Days 1 to 5)
const countsInWeek = {};
tier2Tickers.forEach(t => countsInWeek[t] = 0);

[groupA, groupB, [], groupA, groupB].forEach(dayTickers => {
  dayTickers.forEach(t => countsInWeek[t]++);
});

const values = Object.values(countsInWeek);
const minChecks = Math.min(...values);
const maxChecks = Math.max(...values);
console.log(`Weekly checks per Tier 2 emiten: Min=${minChecks}, Max=${maxChecks}`);
