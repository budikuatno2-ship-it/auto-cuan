'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SSH_KEY_PATH = 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';
const OUT_DIR = path.join(__dirname, 'out');

if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

// Node script to execute on VPS (read-only against /home/ubuntu/auto-cuan/data/)
const vpsScript = `
const fs = require('fs');
const path = require('path');

const BS_DIR = '/home/ubuntu/auto-cuan/data/arjum-data/broker-summary';
const CANDLES_DIR = '/home/ubuntu/auto-cuan/data/daily-candles';

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function getIdxTickSize(price) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return 1;
  if (p < 200) return 1;
  if (p < 500) return 2;
  if (p < 2000) return 5;
  if (p < 5000) return 10;
  return 25;
}

function roundToIdxTick(price, mode) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return 0;
  const tick = getIdxTickSize(p);
  let rounded;
  if (mode === 'ceil' || mode === 'up') rounded = Math.ceil(p / tick) * tick;
  else if (mode === 'floor' || mode === 'down') rounded = Math.floor(p / tick) * tick;
  else rounded = Math.round(p / tick) * tick;
  return Math.max(1, rounded);
}

function calculateIdxAraArb(prevClose) {
  const ref = Number(prevClose);
  if (!Number.isFinite(ref) || ref <= 0) return { araPx: null, arbPx: null };
  let araPct = 0.35;
  if (ref > 5000) araPct = 0.20;
  else if (ref > 200) araPct = 0.25;
  const araPx = roundToIdxTick(ref * (1 + araPct), 'floor');
  const arbRaw = Math.max(1, Math.floor(ref * 0.85));
  const arbPx = roundToIdxTick(arbRaw, 'ceil');
  return { araPx, arbPx };
}

function parseDailyBroksum(d) {
  const bMap = new Map();
  if (!d) return bMap;
  if (Array.isArray(d.broker_levels) && d.broker_levels.length > 0) {
    for (const lvl of d.broker_levels) {
      if (lvl.buy && lvl.buy.broker_code) {
        const code = String(lvl.buy.broker_code).trim().toUpperCase();
        const cur = bMap.get(code) || { bval: 0, sval: 0, bvol: 0, svol: 0 };
        cur.bval += Number(lvl.buy.bval || 0);
        cur.bvol += Number(lvl.buy.bvol || 0);
        bMap.set(code, cur);
      }
      if (lvl.sell && lvl.sell.broker_code) {
        const code = String(lvl.sell.broker_code).trim().toUpperCase();
        const cur = bMap.get(code) || { bval: 0, sval: 0, bvol: 0, svol: 0 };
        cur.sval += Number(lvl.sell.sval || 0);
        cur.svol += Number(lvl.sell.svol || 0);
        bMap.set(code, cur);
      }
    }
  } else if (Array.isArray(d.brokers)) {
    for (const b of d.brokers) {
      const code = String(b.broker_code).trim().toUpperCase();
      const cur = bMap.get(code) || { bval: 0, sval: 0, bvol: 0, svol: 0 };
      cur.bval += Number(b.bval || 0);
      cur.sval += Number(b.sval || 0);
      cur.bvol += Number(b.bvol || 0);
      cur.svol += Number(b.svol || 0);
      bMap.set(code, cur);
    }
  }
  for (const [code, obj] of bMap.entries()) {
    obj.nval = obj.bval - obj.sval;
    obj.nvol = obj.bvol - obj.svol;
  }
  return bMap;
}

// Load all trading dates from BRPT (which is 100% complete with 99 dates)
const brptFiles = fs.readdirSync(path.join(BS_DIR, 'BRPT'))
  .filter(f => f.endsWith('.json') && f !== 'latest.json')
  .filter(f => f >= '2026-06-01.json' && f <= '2026-10-16.json')
  .sort();
const tradingDates = brptFiles.map(f => f.replace('.json', ''));

console.log('Total trading dates:', tradingDates.length, 'from', tradingDates[0], 'to', tradingDates[tradingDates.length - 1]);

// Get all liquid tickers (average daily turnover >= 1 Miliar in daily candles)
const tickers = fs.readdirSync(BS_DIR).filter(f => fs.statSync(path.join(BS_DIR, f)).isDirectory());
const liquidStocks = [];

for (const tk of tickers) {
  const cFile = path.join(CANDLES_DIR, tk + '.json');
  if (!fs.existsSync(cFile)) continue;
  try {
    const cd = JSON.parse(fs.readFileSync(cFile, 'utf8'));
    if (!cd || !Array.isArray(cd.candles) || cd.candles.length < 50) continue;
    // Calculate average turnover June-Oct 2026
    const inRange = cd.candles.filter(c => c.date >= '2026-06-01' && c.date <= '2026-10-16');
    if (inRange.length < 20) continue;
    const avgTurn = inRange.reduce((acc, c) => acc + (c.volume * c.close), 0) / inRange.length;
    if (avgTurn >= 1000000000) { // >= Rp 1 Miliar
      liquidStocks.push({
        ticker: tk,
        avgTurnover: avgTurn,
        candles: cd.candles
      });
    }
  } catch(e) {}
}

liquidStocks.sort((a,b) => b.avgTurnover - a.avgTurnover);
console.log('Total liquid stocks (avg turnover >= 1M):', liquidStocks.length);

// Compute daily indicators for all liquid stocks across all dates
const stockMetrics = new Map(); // ticker -> Array of daily computed metrics

for (const stock of liquidStocks) {
  const tk = stock.ticker;
  const candleMap = new Map();
  stock.candles.forEach((c, idx) => candleMap.set(c.date, { ...c, idx }));

  const tkDir = path.join(BS_DIR, tk);
  const dailyParsed = [];

  for (let t = 0; t < tradingDates.length; t++) {
    const d = tradingDates[t];
    const bsFile = path.join(tkDir, d + '.json');
    let bsJson = null;
    if (fs.existsSync(bsFile)) {
      try { bsJson = JSON.parse(fs.readFileSync(bsFile, 'utf8')); } catch(e) {}
    }

    const candle = candleMap.get(d) || null;
    const close = candle ? candle.close : null;
    const prevC = (candle && candle.idx > 0) ? stock.candles[candle.idx - 1].close : null;

    const bMap = parseDailyBroksum(bsJson);
    let sumB = 0, sumS = 0;
    const brokerList = [];
    for (const [code, b] of bMap.entries()) {
      sumB += b.bval;
      sumS += b.sval;
      brokerList.push({ b: code, nval: b.nval, bval: b.bval, sval: b.sval, bvol: b.bvol, svol: b.svol });
    }
    brokerList.sort((a, b) => b.nval - a.nval);

    const buyers = brokerList.filter(x => x.nval > 0).slice(0, 3);
    const top3Buy = buyers.reduce((s, x) => s + x.nval, 0);
    const sellers = brokerList.filter(x => x.nval < 0).slice(-3).reverse();
    const top3Sell = sellers.reduce((s, x) => s + Math.abs(x.nval), 0);
    const T = Math.round(sumB);
    const tb = T > 0 ? (top3Buy - top3Sell) / T : 0;

    let locked = null;
    if (prevC != null && close != null) {
      const { araPx, arbPx } = calculateIdxAraArb(prevC);
      if (araPx != null && close >= araPx) locked = 'ARA';
      else if (arbPx != null && close <= arbPx) locked = 'ARB';
    }

    const top = {
      buy: buyers.map(x => ({ b: x.b, net: Math.round(x.nval) })),
      sell: sellers.map(x => ({ b: x.b, net: Math.round(x.nval) }))
    };

    dailyParsed.push({
      date: d,
      close,
      prevClose: prevC,
      bMap,
      T,
      top3Buy: Math.round(top3Buy),
      top3Sell: Math.round(top3Sell),
      tb: Math.round(tb * 10000) / 10000,
      locked,
      top
    });
  }

  // Pass 2: Rolling metrics
  let runningTbCum = 0;
  const outList = [];

  for (let t = 0; t < tradingDates.length; t++) {
    const cur = dailyParsed[t];
    let ma20T = null;
    let hab20 = null;
    let kons = null;

    if (t >= 19) {
      let sumT = 0;
      for (let j = t - 19; j <= t; j++) sumT += dailyParsed[j].T;
      ma20T = sumT / 20;

      const broker20Map = new Map();
      for (let j = t - 19; j <= t; j++) {
        for (const [code, b] of dailyParsed[j].bMap.entries()) {
          const cur20 = broker20Map.get(code) || { bval: 0, sval: 0, bvol: 0, svol: 0, nval: 0 };
          cur20.bval += b.bval;
          cur20.sval += b.sval;
          cur20.bvol += b.bvol;
          cur20.svol += b.svol;
          cur20.nval += b.nval;
          broker20Map.set(code, cur20);
        }
      }

      const sorted20 = Array.from(broker20Map.entries()).map(([code, b]) => ({ code, ...b })).sort((a,b) => b.nval - a.nval);
      const top3Accum = sorted20.slice(0, 3).filter(x => x.nval > 0);
      let sumBuyVal20 = 0, sumBuyVol20 = 0;
      for (const b of top3Accum) {
        sumBuyVal20 += b.bval;
        sumBuyVol20 += b.bvol;
      }
      hab20 = sumBuyVol20 > 0 ? Math.round(sumBuyVal20 / sumBuyVol20) : null;

      const top1Broker = sorted20[0] ? sorted20[0].code : null;
      if (top1Broker) {
        let days10 = 0;
        const start10 = Math.max(0, t - 9);
        for (let j = start10; j <= t; j++) {
          const dayB = dailyParsed[j].bMap.get(top1Broker);
          if (dayB && dayB.nval > 0) days10++;
        }
        let streak = 0;
        for (let j = t; j >= 0; j--) {
          const dayB = dailyParsed[j].bMap.get(top1Broker);
          if (dayB && dayB.nval > 0) streak++; else break;
        }
        kons = { b: top1Broker, days10, streak };
      }
    }

    let tbCum = null;
    if (ma20T != null && ma20T > 0) {
      const delta = (cur.top3Buy - cur.top3Sell) / ma20T;
      runningTbCum += delta;
      tbCum = Math.round(runningTbCum * 100) / 100;
    }

    // 10-day forward return: return from close[t] to close[t+10]
    let fwdRet10 = null;
    if (t + 10 < tradingDates.length) {
      const futureClose = dailyParsed[t + 10].close;
      if (cur.close > 0 && futureClose > 0) {
        fwdRet10 = (futureClose - cur.close) / cur.close;
      }
    }

    const distHab20Pct = (cur.close && hab20) ? Math.round(((cur.close - hab20) / hab20) * 10000) / 100 : null;

    outList.push({
      d: cur.date,
      close: cur.close,
      T: cur.T,
      top3Buy: cur.top3Buy,
      top3Sell: cur.top3Sell,
      tb: cur.tb,
      tbCum,
      tbSlope5: null,
      hab20,
      distHab20Pct,
      kons,
      foreignNet: null,
      locked: cur.locked,
      top: cur.top,
      fwdRet10
    });
  }

  // Pass 3: tbSlope5
  for (let t = 0; t < tradingDates.length; t++) {
    if (outList[t].tbCum != null && t >= 5 && outList[t - 5].tbCum != null) {
      outList[t].tbSlope5 = Math.round((outList[t].tbCum - outList[t - 5].tbCum) * 100) / 100;
    }
  }

  stockMetrics.set(tk, outList);
}

console.log('Computed indicators for', stockMetrics.size, 'stocks.');

// Export specific targets: BRPT, BBCA, MEDC
const exportTargets = ['BRPT', 'BBCA', 'MEDC'];
const exportedData = {};

for (const tk of exportTargets) {
  const metrics = stockMetrics.get(tk) || [];
  exportedData[tk] = {
    meta: {
      ticker: tk,
      dataSource: 'arjum broker-summary & daily-candles',
      dateRange: { from: tradingDates[0], to: tradingDates[tradingDates.length - 1], totalDays: tradingDates.length },
      missingDaysCount: 0,
      boardAvailable: false,
      investorTypeAvailable: false,
      note: 'board is implicit RG as verified by 100% done-details match; investorType is absent in raw broksum so foreignNet is null'
    },
    data: metrics.map(m => ({
      d: m.d,
      T: m.T,
      top3Buy: m.top3Buy,
      top3Sell: m.top3Sell,
      tb: m.tb,
      tbCum: m.tbCum,
      tbSlope5: m.tbSlope5,
      hab20: m.hab20,
      kons: m.kons,
      foreignNet: m.foreignNet,
      locked: m.locked,
      top: m.top
    }))
  };
}

// -------------------------------------------------------------
// STEP 3: QUANTITATIVE UTILITY TESTING (SPEARMAN RANK CORRELATION)
// -------------------------------------------------------------
// Rank function: assigns average rank for ties
function rankArray(arr) {
  const sorted = arr.map((val, idx) => ({ val, idx })).sort((a, b) => a.val - b.val);
  const ranks = new Float64Array(arr.length);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j < sorted.length - 1 && sorted[j + 1].val === sorted[j].val) j++;
    const avgRank = (i + 1 + j + 1) / 2;
    for (let k = i; k <= j; k++) ranks[sorted[k].idx] = avgRank;
    i = j + 1;
  }
  return ranks;
}

function spearman(x, y) {
  const n = x.length;
  if (n < 5) return null;
  const rx = rankArray(x);
  const ry = rankArray(y);
  let sumD2 = 0;
  for (let i = 0; i < n; i++) {
    const diff = rx[i] - ry[i];
    sumD2 += diff * diff;
  }
  return 1 - (6 * sumD2) / (n * (n * n - 1));
}

// Period: June to mid-September (e.g. 2026-06-01 to 2026-09-15)
// Notice that 2026-09-15 + 10 trading days falls at 2026-09-29, well before 16 Oct crash!
const midSepIndex = tradingDates.findIndex(d => d >= '2026-09-15');
const normalTestDates = tradingDates.slice(20, midSepIndex + 1); // skip warmup first 20 days so tbSlope5 & hab20 exist

console.log('Evaluating Normal Period (Jun to mid-Sep):', normalTestDates.length, 'trading dates (' + normalTestDates[0] + ' to ' + normalTestDates[normalTestDates.length-1] + ')');

const dailyResults = [];

for (const d of normalTestDates) {
  const dateIdx = tradingDates.indexOf(d);
  const rows = [];

  for (const [tk, list] of stockMetrics.entries()) {
    const item = list[dateIdx];
    if (item && item.fwdRet10 != null && item.tb != null) {
      rows.push({
        ticker: tk,
        tb: item.tb,
        tbSlope5: item.tbSlope5,
        distHab20Pct: item.distHab20Pct,
        fwdRet10: item.fwdRet10
      });
    }
  }

  if (rows.length >= 20) {
    const tbList = rows.map(r => r.tb);
    const retList = rows.map(r => r.fwdRet10);
    const icTb = spearman(tbList, retList);

    const validSlope = rows.filter(r => r.tbSlope5 != null);
    const icSlope = validSlope.length >= 20 ? spearman(validSlope.map(r => r.tbSlope5), validSlope.map(r => r.fwdRet10)) : null;

    const validHab = rows.filter(r => r.distHab20Pct != null);
    const icHab = validHab.length >= 20 ? spearman(validHab.map(r => r.distHab20Pct), validHab.map(r => r.fwdRet10)) : null;

    // Quintiles on tb: Q5 (top 20%) vs Q1 (bottom 20%)
    rows.sort((a,b) => a.tb - b.tb);
    const qSize = Math.floor(rows.length / 5);
    const q1 = rows.slice(0, qSize);
    const q5 = rows.slice(-qSize);
    const q1AvgRet = q1.reduce((s, x) => s + x.fwdRet10, 0) / qSize;
    const q5AvgRet = q5.reduce((s, x) => s + x.fwdRet10, 0) / qSize;

    dailyResults.push({
      date: d,
      nStocks: rows.length,
      icTb,
      icSlope,
      icHab,
      q1AvgRet,
      q5AvgRet,
      q5BeatsQ1: q5AvgRet > q1AvgRet
    });
  }
}

// Bootstrap IC CI95 across dates
function bootstrapMeanCI(arr, B = 5000) {
  const valid = arr.filter(x => x != null && Number.isFinite(x));
  if (valid.length < 5) return { mean: 0, ci: [0, 0] };
  const m = valid.reduce((a, b) => a + b, 0) / valid.length;
  const bMeans = [];
  let seed = 42;
  function rnd() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }

  for (let b = 0; b < B; b++) {
    let sum = 0;
    for (let i = 0; i < valid.length; i++) {
      sum += valid[Math.floor(rnd() * valid.length)];
    }
    bMeans.push(sum / valid.length);
  }
  bMeans.sort((a,b) => a - b);
  return {
    mean: Math.round(m * 10000) / 10000,
    ci95: [Math.round(bMeans[Math.floor(B * 0.025)] * 10000) / 10000, Math.round(bMeans[Math.floor(B * 0.975)] * 10000) / 10000]
  };
}

const icTbStats = bootstrapMeanCI(dailyResults.map(r => r.icTb));
const icSlopeStats = bootstrapMeanCI(dailyResults.map(r => r.icSlope));
const icHabStats = bootstrapMeanCI(dailyResults.map(r => r.icHab));

const q5Wins = dailyResults.filter(r => r.q5BeatsQ1).length;
const hitRateQuintile = dailyResults.length > 0 ? Math.round((q5Wins / dailyResults.length) * 1000) / 10 : 0;
const meanSpreadQ5Q1 = dailyResults.reduce((s, r) => s + (r.q5AvgRet - r.q1AvgRet), 0) / (dailyResults.length || 1);

// -------------------------------------------------------------
// Separate Analysis: October Crash Period (after mid-Sep up to 16 Okt)
// -------------------------------------------------------------
const crashTestDates = tradingDates.slice(midSepIndex + 1);
const crashDaily = [];

for (const d of crashTestDates) {
  const dateIdx = tradingDates.indexOf(d);
  const rows = [];
  for (const [tk, list] of stockMetrics.entries()) {
    const item = list[dateIdx];
    if (item && item.fwdRet10 != null && item.tb != null) {
      rows.push({
        ticker: tk,
        tb: item.tb,
        fwdRet10: item.fwdRet10
      });
    }
  }
  if (rows.length >= 20) {
    const icTb = spearman(rows.map(r => r.tb), rows.map(r => r.fwdRet10));
    crashDaily.push({ date: d, n: rows.length, icTb });
  }
}
const crashIcStats = bootstrapMeanCI(crashDaily.map(r => r.icTb));

const analysisSummary = {
  normalPeriod: {
    datesCount: dailyResults.length,
    dateRange: [normalTestDates[0], normalTestDates[normalTestDates.length - 1]],
    icTb: icTbStats,
    icSlope5: icSlopeStats,
    icHab20: icHabStats,
    hitRateQ5vsQ1Pct: hitRateQuintile,
    meanSpreadQ5vsQ1Pct: Math.round(meanSpreadQ5Q1 * 10000) / 100
  },
  crashPeriod: {
    datesCount: crashDaily.length,
    dateRange: crashDaily.length ? [crashDaily[0].date, crashDaily[crashDaily.length-1].date] : [],
    icTb: crashIcStats
  }
};

console.log('__ANALYSIS_OUTPUT_START__');
console.log(JSON.stringify({ analysisSummary, exportedData }, null, 2));
console.log('__ANALYSIS_OUTPUT_END__');
`;

function main() {
  console.log('Executing broker summary quantitative analysis on VPS (read-only)...');
  const out = execSync(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -i "${SSH_KEY_PATH}" ${VPS_HOST} node`, {
    input: vpsScript,
    maxBuffer: 25 * 1024 * 1024,
    encoding: 'utf8'
  });

  const s = out.indexOf('__ANALYSIS_OUTPUT_START__');
  const e = out.indexOf('__ANALYSIS_OUTPUT_END__');
  if (s !== -1 && e !== -1) {
    const jsonStr = out.slice(s + '__ANALYSIS_OUTPUT_START__'.length, e).trim();
    const result = JSON.parse(jsonStr);

    console.log('Analysis completed successfully!');
    console.log('Summary:');
    console.log(JSON.stringify(result.analysisSummary, null, 2));

    // Save exported targets to out/
    for (const [tk, data] of Object.entries(result.exportedData)) {
      const outPath = path.join(OUT_DIR, `${tk}.json`);
      fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
      console.log(`Saved: ${outPath} (${data.data.length} trading days)`);
    }

    // Save analysis summary
    fs.writeFileSync(path.join(__dirname, 'broksum_utility_analysis.json'), JSON.stringify(result.analysisSummary, null, 2));
  } else {
    console.log('Raw output:', out);
  }
}

main();
