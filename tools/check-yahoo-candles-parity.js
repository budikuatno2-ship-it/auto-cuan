'use strict';

const fs = require('fs');
const path = require('path');

// 22 tickers: 10 liquid, 5 medium, 5 quiet, 2 corporate actions
const tickers = [
  // 10 likuid
  'BBCA', 'BBRI', 'BMRI', 'BBNI', 'ASII', 'TLKM', 'BUMI', 'BRPT', 'AMMN', 'ADRO',
  // 5 sedang
  'MEDC', 'PGAS', 'PTBA', 'CPIN', 'KLBF',
  // 5 sepi
  'ALDO', 'BIKA', 'CITY', 'FISH', 'LIFE',
  // 2 corporate actions (PANI - rights issue, DSSA - stock split)
  'PANI', 'DSSA'
];

const candlesDir = '/home/ubuntu/auto-cuan/data/daily-candles';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchYahoo(ticker) {
  const symbol = `${ticker}.JK`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=3mo&interval=1d&includePrePost=false`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return { ok: false, status: res.status };
    const json = await res.json();
    const result = json && json.chart && json.chart.result && json.chart.result[0];
    if (!result || !result.timestamp) return { ok: false, error: 'no_chart_result' };

    const ts = result.timestamp;
    const q = result.indicators.quote[0];
    const adjclose = result.indicators.adjclose ? result.indicators.adjclose[0].adjclose : null;

    const candles = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.close[i] == null) continue;
      const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date(ts[i] * 1000));
      candles.push({
        date,
        open: q.open[i],
        high: q.high[i],
        low: q.low[i],
        close: q.close[i],
        volume: q.volume[i],
        adjclose: adjclose ? adjclose[i] : q.close[i]
      });
    }
    return { ok: true, candles };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function main() {
  const report = [];

  for (const tk of tickers) {
    // 1. Read Arjum candle from disk
    const arjumFile = path.join(candlesDir, `${tk}.json`);
    let arjumCandles = [];
    if (fs.existsSync(arjumFile)) {
      try {
        const d = JSON.parse(fs.readFileSync(arjumFile, 'utf8'));
        arjumCandles = (d.candles || []).map(c => ({
          date: c.date || c.time,
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
          volume: Number(c.volume)
        }));
      } catch (_) {}
    }

    // 2. Fetch Yahoo with 1.2s delay
    console.log(`Fetching Yahoo for ${tk}...`);
    const yahooRes = await fetchYahoo(tk);
    await sleep(1200);

    if (!yahooRes.ok) {
      report.push({ ticker: tk, status: 'yahoo_failed', error: yahooRes.error || yahooRes.status });
      continue;
    }

    const yahooCandles = yahooRes.candles;
    const yahooMap = new Map(yahooCandles.map(c => [c.date, c]));

    // Focus on last 60 trading days from Arjum
    const recentArjum = arjumCandles.slice(-60);
    let missingInYahoo = 0;
    let priceDiffCountGt05 = 0;
    let maxCloseDiffPct = 0;
    let maxVolRatio = 0;
    let isAdjustedDetected = false;
    let volUnitIsShares = true;

    const comparedDays = [];

    for (const ac of recentArjum) {
      const yc = yahooMap.get(ac.date);
      if (!yc) {
        missingInYahoo++;
        continue;
      }

      // Check OHLC diff
      const cDiff = Math.abs(yc.close - ac.close);
      const cDiffPct = ac.close > 0 ? (cDiff / ac.close) * 100 : 0;
      if (cDiffPct > maxCloseDiffPct) maxCloseDiffPct = cDiffPct;
      if (cDiffPct > 0.5) priceDiffCountGt05++;

      // Check if Yahoo adjclose differs from close (corporate action adjusted)
      if (yc.adjclose && Math.abs(yc.adjclose - yc.close) > 1) {
        isAdjustedDetected = true;
      }

      // Check volume ratio
      // In Arjum, volume is in shares (lembar)
      const vArjum = ac.volume || 0;
      const vYahoo = yc.volume || 0;
      let ratio = 1;
      if (vArjum > 0 && vYahoo > 0) {
        ratio = vYahoo / vArjum;
        if (Math.abs(ratio - 1) > Math.abs(maxVolRatio - 1)) maxVolRatio = ratio;
        // If vYahoo is approx vArjum / 100, then Yahoo is in lots
        if (Math.abs(ratio - 0.01) < 0.005) {
          volUnitIsShares = false; // lots!
        }
      }

      comparedDays.push({
        date: ac.date,
        arjumClose: ac.close,
        yahooClose: yc.close,
        cDiffPct: Number(cDiffPct.toFixed(2)),
        arjumVol: vArjum,
        yahooVol: vYahoo,
        volRatio: Number(ratio.toFixed(2))
      });
    }

    report.push({
      ticker: tk,
      arjumTotalDays: arjumCandles.length,
      daysCompared: recentArjum.length,
      missingInYahoo,
      priceDiffCountGt05,
      maxCloseDiffPct: Number(maxCloseDiffPct.toFixed(2)),
      volumeRatio: Number(maxVolRatio.toFixed(2)),
      volumeUnit: volUnitIsShares ? 'shares (lembar)' : 'lots (lot)',
      isCorporateActionAdjusted: isAdjustedDetected,
      sampleLatestDay: comparedDays[comparedDays.length - 1]
    });
  }

  fs.writeFileSync('/tmp/yahoo_comparison_report.json', JSON.stringify(report, null, 2));
  console.log('COMPLETED YAHOO COMPARISON');
}

main().catch(console.error);
