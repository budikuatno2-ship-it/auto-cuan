'use strict';

const fs = require('fs');
const path = require('path');
const lp = require('../lib/liquidity-profiler');

const dir = path.join(__dirname, '..', 'data', 'daily-candles');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'IHSG.json');

const CONGLOMERATE_TICKERS = new Set([
  'BBCA', 'TOWR', 'BELI', 'RANC', 'SUPR',
  'JARR', 'PGUN', 'PACK',
  'BREN', 'BRPT', 'CUAN', 'TPIA', 'PTRO',
  'INDF', 'ICBP', 'AMMN', 'BUMI', 'BRMS', 'DCII', 'DNET', 'EMTK',
  'ADRO', 'AADI', 'ESSA', 'MBMA', 'PALM', 'TRIM', 'MDKA', 'SRTG',
  'ABMM', 'BMTR', 'CFIN', 'DILD', 'GJTL', 'SIMP', 'BNGA',
  'TLKM', 'ASII', 'BMRI', 'BBNI', 'UNTR', 'KLBF', 'CPIN', 'PGAS', 'SMGR'
]);

let liquid = 0;
let nonLiquid = 0;
let illiquid = 0;
let tier1 = 0;
let tier2 = 0;

const tier1List = [];
const tier2List = [];

for (const f of files) {
  const ticker = f.replace('.json', '');
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const candles = raw.candles || raw;
    const prof = lp.calculateLiquidityProfile(candles, { ticker });
    const isConglo = CONGLOMERATE_TICKERS.has(ticker);

    if (prof.isLiquid || isConglo) {
      tier1++;
      tier1List.push(ticker);
    } else {
      tier2++;
      tier2List.push(ticker);
    }

    if (prof.isLiquid) liquid++;
    else if (prof.isNonLiquid) nonLiquid++;
    else illiquid++;
  } catch (e) {}
}

console.log(`Total Emiten: ${files.length}`);
console.log(`Profiler Raw: Liquid=${liquid}, NonLiquid=${nonLiquid}, Illiquid=${illiquid}`);
console.log(`Tiered: Tier 1 (Likuid / Konglomerasi / Aktif) = ${tier1}, Tier 2 (Non-Likuid / Lapis 2-3) = ${tier2}`);
