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

// Node script executed on VPS (read-only against /home/ubuntu/auto-cuan/data/)
const vpsScript = `
const fs = require('fs');
const path = require('path');

const BS_DIR = '/home/ubuntu/auto-cuan/data/arjum-data/broker-summary';
const CANDLES_DIR = '/home/ubuntu/auto-cuan/data/daily-candles';

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

// 1. All raw dates from BRPT directory
const brptFiles = fs.readdirSync(path.join(BS_DIR, 'BRPT'))
  .filter(f => f.endsWith('.json') && f !== 'latest.json')
  .sort();
const allTradingDates = brptFiles.map(f => f.replace('.json', ''));

console.log('Total calendar/file dates in 2026:', allTradingDates.length, 'from', allTradingDates[0], 'to', allTradingDates[allTradingDates.length - 1]);

// 2. Identify liquid stocks across full year 2026
const tickers = fs.readdirSync(BS_DIR).filter(f => fs.statSync(path.join(BS_DIR, f)).isDirectory());
const liquidStocks = [];

for (const tk of tickers) {
  const cFile = path.join(CANDLES_DIR, tk + '.json');
  if (!fs.existsSync(cFile)) continue;
  try {
    const cd = JSON.parse(fs.readFileSync(cFile, 'utf8'));
    if (!cd || !Array.isArray(cd.candles) || cd.candles.length < 50) continue;
    const inRange = cd.candles.filter(c => c.date >= '2026-01-02' && c.date <= '2026-10-16');
    if (inRange.length < 30) continue;
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
console.log('Total liquid stocks across 2026 (avg turnover >= 1M):', liquidStocks.length);

// 3. Compute indicators with T > 0 filtering
const stockMetrics = new Map();
const stockDateMaps = new Map();

for (const stock of liquidStocks) {
  const tk = stock.ticker;
  const candleMap = new Map();
  stock.candles.forEach((c, idx) => candleMap.set(c.date, { ...c, idx }));

  const tkDir = path.join(BS_DIR, tk);
  const dailyParsed = [];

  for (let t = 0; t < allTradingDates.length; t++) {
    const d = allTradingDates[t];
    const bsFile = path.join(tkDir, d + '.json');
    let bsJson = null;
    if (fs.existsSync(bsFile)) {
      try { bsJson = JSON.parse(fs.readFileSync(bsFile, 'utf8')); } catch(e) {}
    }

    const candle = candleMap.get(d) || null;
    const close = candle ? candle.close : null;

    // TRUE T: from candle volume * close (if available), else sum of brokers
    const candleTurnover = candle && candle.volume && candle.close ? (candle.volume * candle.close) : null;

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

    const T = (candleTurnover != null && candleTurnover > 0) ? Math.round(candleTurnover) : Math.round(sumB);

    // BUANG HARI DENGAN T=0 (libur bursa, file kosong, tanpa turnover)
    if (!T || T <= 0) {
      continue;
    }

    const tb = (top3Buy - top3Sell) / T;

    // ARA/ARB relative to previous active day close
    let locked = null;
    const prevC = (dailyParsed.length > 0) ? dailyParsed[dailyParsed.length - 1].close : ((candle && candle.idx > 0) ? stock.candles[candle.idx - 1].close : null);
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

  // Pass 2: Rolling metrics across active trading days
  let runningTbCum = 0;
  const outList = [];
  const nActive = dailyParsed.length;

  for (let t = 0; t < nActive; t++) {
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

    let fwdRet10 = null;
    if (t + 10 < nActive) {
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

  for (let t = 0; t < nActive; t++) {
    if (outList[t].tbCum != null && t >= 5 && outList[t - 5].tbCum != null) {
      outList[t].tbSlope5 = Math.round((outList[t].tbCum - outList[t - 5].tbCum) * 100) / 100;
    }
  }

  stockMetrics.set(tk, outList);
  const dMap = new Map();
  outList.forEach(item => dMap.set(item.d, item));
  stockDateMaps.set(tk, dMap);
}

// Export active days for BRPT, BBCA, MEDC
const exportTargets = ['BRPT', 'BBCA', 'MEDC'];
const exportedData = {};

for (const tk of exportTargets) {
  const metrics = stockMetrics.get(tk) || [];
  exportedData[tk] = {
    meta: {
      ticker: tk,
      dataSource: 'arjum broker-summary & daily-candles',
      sourceT: 'Arjum daily-candles (volume * close)',
      dateRange: {
        from: metrics.length > 0 ? metrics[0].d : null,
        to: metrics.length > 0 ? metrics[metrics.length - 1].d : null,
        totalActiveTradingDays: metrics.length
      },
      zeroTurnoverDaysRemoved: allTradingDates.length - metrics.length,
      boardAvailable: false,
      investorTypeAvailable: false,
      note: 'Hari T=0 (libur bursa / file kosong) telah dibuang sebelum menghitung MA20(T), tbCum, tbSlope5, hab20, kons. T diambil dari candle turnover (volume * close).'
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

// Rank & Spearman Functions
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

function bootstrapMeanCI(arr, B = 5000) {
  const valid = arr.filter(x => x != null && Number.isFinite(x));
  if (valid.length < 5) return { mean: 0, ci95: [0, 0] };
  const m = valid.reduce((a, b) => a + b, 0) / valid.length;
  const bMeans = [];
  let seed = 42;
  function rnd() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }
  for (let b = 0; b < B; b++) {
    let sum = 0;
    for (let i = 0; i < valid.length; i++) sum += valid[Math.floor(rnd() * valid.length)];
    bMeans.push(sum / valid.length);
  }
  bMeans.sort((a,b) => a - b);
  return {
    mean: Math.round(m * 10000) / 10000,
    ci95: [Math.round(bMeans[Math.floor(B * 0.025)] * 10000) / 10000, Math.round(bMeans[Math.floor(B * 0.975)] * 10000) / 10000]
  };
}

// 4. Identify Market Active Dates (dates where >= 20 liquid stocks had T > 0)
const marketActiveDates = [];
for (const d of allTradingDates) {
  let count = 0;
  for (const dMap of stockDateMaps.values()) {
    if (dMap.has(d)) count++;
  }
  if (count >= 20) {
    marketActiveDates.push(d);
  }
}

console.log('Total active exchange dates (T > 0, >= 20 stocks):', marketActiveDates.length, 'out of', allTradingDates.length, 'dates');

// Full Period: warmup 20 active days up to mid-Sep 2026
const midSepActiveIdx = marketActiveDates.findIndex(d => d >= '2026-09-15');
const fullPeriodActiveDates = marketActiveDates.slice(20, midSepActiveIdx + 1);

console.log('Evaluating Full Period (active days without T=0):', fullPeriodActiveDates.length, 'dates (' + fullPeriodActiveDates[0] + ' to ' + fullPeriodActiveDates[fullPeriodActiveDates.length - 1] + ')');

const dailyResultsFull = [];

for (const d of fullPeriodActiveDates) {
  const rows = [];

  for (const [tk, dMap] of stockDateMaps.entries()) {
    const item = dMap.get(d);
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
    const icTb = spearman(rows.map(r => r.tb), rows.map(r => r.fwdRet10));
    const validSlope = rows.filter(r => r.tbSlope5 != null);
    const icSlope = validSlope.length >= 20 ? spearman(validSlope.map(r => r.tbSlope5), validSlope.map(r => r.fwdRet10)) : null;
    const validHab = rows.filter(r => r.distHab20Pct != null);
    const icHab = validHab.length >= 20 ? spearman(validHab.map(r => r.distHab20Pct), validHab.map(r => r.fwdRet10)) : null;

    rows.sort((a,b) => a.tb - b.tb);
    const qSize = Math.floor(rows.length / 5);
    const q1 = rows.slice(0, qSize);
    const q5 = rows.slice(-qSize);
    const q1Avg = q1.reduce((s, x) => s + x.fwdRet10, 0) / qSize;
    const q5Avg = q5.reduce((s, x) => s + x.fwdRet10, 0) / qSize;

    dailyResultsFull.push({
      date: d,
      nStocks: rows.length,
      icTb,
      icSlope,
      icHab,
      q1Avg,
      q5Avg,
      q5BeatsQ1: q5Avg > q1Avg
    });
  }
}

const icTbStats = bootstrapMeanCI(dailyResultsFull.map(r => r.icTb));
const icSlopeStats = bootstrapMeanCI(dailyResultsFull.map(r => r.icSlope));
const icHabStats = bootstrapMeanCI(dailyResultsFull.map(r => r.icHab));

const q5Wins = dailyResultsFull.filter(r => r.q5BeatsQ1).length;
const hitRateQ5vsQ1 = dailyResultsFull.length > 0 ? Math.round((q5Wins / dailyResultsFull.length) * 1000) / 10 : 0;
const meanSpread = dailyResultsFull.reduce((s, r) => s + (r.q5Avg - r.q1Avg), 0) / (dailyResultsFull.length || 1);

// Crash period (mid-Sep to Oct 2026)
const crashDates = marketActiveDates.slice(midSepActiveIdx + 1);
const crashDaily = [];

for (const d of crashDates) {
  const rows = [];
  for (const [tk, dMap] of stockDateMaps.entries()) {
    const item = dMap.get(d);
    if (item && item.fwdRet10 != null && item.tb != null) {
      rows.push({ ticker: tk, tb: item.tb, fwdRet10: item.fwdRet10 });
    }
  }
  if (rows.length >= 20) {
    const icTb = spearman(rows.map(r => r.tb), rows.map(r => r.fwdRet10));
    crashDaily.push({ date: d, n: rows.length, icTb });
  }
}
const crashStats = bootstrapMeanCI(crashDaily.map(r => r.icTb));

const analysisSummaryV2 = {
  fullPeriod: {
    description: 'Full 2026 Period (active trading days without T=0)',
    datesCount: dailyResultsFull.length,
    dateRange: [fullPeriodActiveDates[0], fullPeriodActiveDates[fullPeriodActiveDates.length - 1]],
    sourceT: 'Arjum daily-candles (volume * close)',
    zeroTurnoverDaysFiltered: true,
    icTb: icTbStats,
    icSlope5: icSlopeStats,
    icHab20: icHabStats,
    hitRateQ5vsQ1Pct: hitRateQ5vsQ1,
    meanSpreadQ5vsQ1Pct: Math.round(meanSpread * 10000) / 100
  },
  crashPeriod: {
    datesCount: crashDaily.length,
    dateRange: crashDaily.length ? [crashDaily[0].date, crashDaily[crashDaily.length - 1].date] : [],
    icTb: crashStats
  }
};

console.log('__ANALYSIS_V2_START__');
console.log(JSON.stringify({ analysisSummaryV2, exportedData }, null, 2));
console.log('__ANALYSIS_V2_END__');
`;

function main() {
  console.log('Running broker summary analysis v2 with T=0 filtering (read-only against VPS data)...');
  const out = execSync(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -i "${SSH_KEY_PATH}" ${VPS_HOST} node`, {
    input: vpsScript,
    maxBuffer: 30 * 1024 * 1024,
    encoding: 'utf8'
  });

  const s = out.indexOf('__ANALYSIS_V2_START__');
  const e = out.indexOf('__ANALYSIS_V2_END__');
  if (s !== -1 && e !== -1) {
    const jsonStr = out.slice(s + '__ANALYSIS_V2_START__'.length, e).trim();
    const result = JSON.parse(jsonStr);

    console.log('\nAnalysis finished successfully!');
    console.log('Summary with T=0 filtered out:');
    console.log(JSON.stringify(result.analysisSummaryV2, null, 2));

    // Save exported targets to out/
    for (const [tk, data] of Object.entries(result.exportedData)) {
      const outPath = path.join(OUT_DIR, `${tk}.json`);
      fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
      console.log(`Saved: ${outPath} (${data.data.length} active trading days, ${data.meta.zeroTurnoverDaysRemoved} T=0 days removed)`);
    }

    // Save analysis summary v2
    fs.writeFileSync(path.join(__dirname, 'broksum_utility_analysis_v2.json'), JSON.stringify(result.analysisSummaryV2, null, 2));
    console.log('Saved broksum_utility_analysis_v2.json');
  } else {
    console.log('Raw output:', out);
  }
}

main();
