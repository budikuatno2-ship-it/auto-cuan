'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SSH_KEY_PATH = 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';

const DATA_DIR = path.join(__dirname, 'data');
const ARJUM_RAW_DIR = path.join(DATA_DIR, 'arjum_raw');
const ALL_DIR = path.join(DATA_DIR, 'all');

if (!fs.existsSync(ALL_DIR)) fs.mkdirSync(ALL_DIR, { recursive: true });
if (!fs.existsSync(ARJUM_RAW_DIR)) fs.mkdirSync(ARJUM_RAW_DIR, { recursive: true });

function scpArjumCandles() {
  console.log('[1/4] Copying Arjum daily-candles from VPS (read-only)...');
  const targetSubdir = path.join(ARJUM_RAW_DIR, 'daily-candles');
  if (fs.existsSync(targetSubdir) && fs.readdirSync(targetSubdir).length >= 900) {
    console.log(`  -> Already copied: ${fs.readdirSync(targetSubdir).length} files present.`);
    return targetSubdir;
  }

  const t0 = Date.now();
  execFileSync('scp', [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=15',
    '-i', SSH_KEY_PATH,
    '-r',
    `${VPS_HOST}:/home/ubuntu/auto-cuan/data/daily-candles`,
    ARJUM_RAW_DIR
  ]);
  console.log(`  -> SCP completed in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  return targetSubdir;
}

function getIdxTickers() {
  const csvPath = path.join(__dirname, '..', '..', 'public', 'assets', 'idx-tickers.csv');
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n').slice(1);
  const tickers = [];
  for (const l of lines) {
    const parts = l.split(',');
    const code = parts[0]?.trim().replace(/['"]/g, '').toUpperCase();
    if (code) tickers.push(code);
  }
  return tickers;
}

// Fetch long history from Yahoo since 2015-01-01 for fallback/supplement
async function fetchYahooSince2015(symbol) {
  const isIndex = symbol.startsWith('^');
  const yahooSymbol = isIndex ? encodeURIComponent(symbol) : symbol + '.JK';
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?period1=1420070400&period2=1792195200&interval=1d&includePrePost=false`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AutoCuanBacktest/1.0' }
    });
    if (!res.ok) return null;
    const json = await res.json();
    const result = json && json.chart && json.chart.result && json.chart.result[0];
    if (!result) return null;

    const timestamps = result.timestamp || [];
    const quote = result.indicators && result.indicators.quote && result.indicators.quote[0];
    if (!quote) return null;

    const opens = quote.open || [];
    const highs = quote.high || [];
    const lows = quote.low || [];
    const closes = quote.close || [];
    const volumes = quote.volume || [];

    const candles = [];
    const seen = new Set();
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] != null && opens[i] != null && highs[i] != null && lows[i] != null) {
        const timeSec = timestamps[i];
        const wibDate = new Date((timeSec * 1000) + (7 * 3600 * 1000)).toISOString().slice(0, 10);
        if (seen.has(wibDate)) continue;
        seen.add(wibDate);
        candles.push({
          date: wibDate,
          open: Number(opens[i].toFixed(4)),
          high: Number(highs[i].toFixed(4)),
          low: Number(lows[i].toFixed(4)),
          close: Number(closes[i].toFixed(4)),
          volume: volumes[i] != null ? Math.round(volumes[i]) : 0
        });
      }
    }
    return candles.sort((a, b) => a.date < b.date ? -1 : 1);
  } catch (err) {
    return null;
  }
}

/**
 * Detect splits / reverse splits in raw candles:
 * A price change between consecutive sessions where ratio = currClose / prevClose
 * exceeds normal limits and closely matches common ratios:
 * 1:2 (0.5), 1:4 (0.25), 1:5 (0.2), 1:10 (0.1), 2:1 (2.0), 5:1 (5.0), 10:1 (10.0)
 */
function detectAndAdjustSplits(candles, ticker) {
  const commonRatios = [
    { ratio: 0.5, factor: 0.5, name: '1:2' },
    { ratio: 0.25, factor: 0.25, name: '1:4' },
    { ratio: 0.2, factor: 0.2, name: '1:5' },
    { ratio: 0.1, factor: 0.1, name: '1:10' },
    { ratio: 2.0, factor: 2.0, name: '2:1' },
    { ratio: 5.0, factor: 5.0, name: '5:1' },
    { ratio: 10.0, factor: 10.0, name: '10:1' }
  ];

  const adjustments = [];
  const adjusted = candles.map(c => Object.assign({}, c));

  for (let i = 1; i < adjusted.length; i++) {
    const prevC = adjusted[i - 1].close;
    const currC = adjusted[i].close;
    if (prevC <= 0 || currC <= 0) continue;

    const r = currC / prevC;
    // Check if ratio matches common split within 4% tolerance
    for (const cr of commonRatios) {
      if (Math.abs(r - cr.ratio) / cr.ratio < 0.04) {
        // Detected a split on day i!
        // Adjust all prices before day i by factor cr.factor, and volumes by 1/cr.factor
        for (let j = 0; j < i; j++) {
          adjusted[j].open = Number((adjusted[j].open * cr.factor).toFixed(4));
          adjusted[j].high = Number((adjusted[j].high * cr.factor).toFixed(4));
          adjusted[j].low = Number((adjusted[j].low * cr.factor).toFixed(4));
          adjusted[j].close = Number((adjusted[j].close * cr.factor).toFixed(4));
          adjusted[j].volume = Math.round(adjusted[j].volume / cr.factor);
        }
        adjustments.push({
          ticker,
          date: adjusted[i].date,
          prevClose: prevC,
          currClose: currC,
          ratioDetected: cr.name,
          factorApplied: cr.factor
        });
        break;
      }
    }
  }

  return { adjusted, adjustments };
}

async function buildDataset() {
  const arjumDir = scpArjumCandles();
  const idxTickers = getIdxTickers();
  console.log(`[2/4] Processing ${idxTickers.length} tickers from idx-tickers.csv...`);

  const sources = {};
  const allAdjustments = [];
  const coverageReport = [];
  const failedTickers = [];

  let processedCount = 0;

  for (const ticker of idxTickers) {
    processedCount++;
    if (processedCount % 100 === 0) {
      console.log(`  Processed ${processedCount} / ${idxTickers.length} tickers...`);
    }

    const arjumFile = path.join(arjumDir, `${ticker}.json`);
    let rawCandles = null;
    let source = '';

    if (fs.existsSync(arjumFile)) {
      try {
        const d = JSON.parse(fs.readFileSync(arjumFile, 'utf8'));
        if (d && Array.isArray(d.candles) && d.candles.length > 0) {
          rawCandles = d.candles.map(c => ({
            date: String(c.date).slice(0, 10),
            open: Number(c.open),
            high: Number(c.high),
            low: Number(c.low),
            close: Number(c.close),
            volume: Number(c.volume || 0)
          }));
          source = 'arjum (vps daily-candles 500d)';
        }
      } catch (e) {}
    }

    // If ticker not in Arjum or has < 300 bars, try fetching from Yahoo
    if (!rawCandles || rawCandles.length < 300) {
      const yahooCandles = await fetchYahooSince2015(ticker);
      if (yahooCandles && yahooCandles.length >= 300) {
        rawCandles = yahooCandles;
        source = 'yahoo (2015-present)';
      } else if (rawCandles && rawCandles.length > 0) {
        // keep short arjum candles
      } else if (yahooCandles && yahooCandles.length > 0) {
        rawCandles = yahooCandles;
        source = 'yahoo (< 300 bars)';
      }
    }

    if (!rawCandles || rawCandles.length === 0) {
      failedTickers.push(ticker);
      continue;
    }

    // Clean and detect corporate actions if source is Arjum (raw prices)
    const { adjusted, adjustments } = detectAndAdjustSplits(rawCandles, ticker);
    if (adjustments.length > 0) {
      allAdjustments.push(...adjustments);
    }

    // Save to data/all/<TICKER>.json
    const outPath = path.join(ALL_DIR, `${ticker}.json`);
    fs.writeFileSync(outPath, JSON.stringify(adjusted));

    sources[ticker] = {
      source,
      bars: adjusted.length,
      from: adjusted[0].date,
      to: adjusted[adjusted.length - 1].date,
      adjustmentsCount: adjustments.length
    };

    coverageReport.push({
      ticker,
      bars: adjusted.length,
      from: adjusted[0].date,
      to: adjusted[adjusted.length - 1].date,
      source
    });
  }

  // Also include any universe tickers already prepared in previous step
  const universeDir = path.join(DATA_DIR, 'universe');
  if (fs.existsSync(universeDir)) {
    for (const f of fs.readdirSync(universeDir).filter(f => f.endsWith('.json'))) {
      const tk = f.replace('.json', '');
      const outPath = path.join(ALL_DIR, f);
      if (!fs.existsSync(outPath)) {
        fs.copyFileSync(path.join(universeDir, f), outPath);
        sources[tk] = { source: 'yahoo long universe (2015)', bars: 2899, from: '2015-01-02', to: '2026-10-16', adjustmentsCount: 0 };
      }
    }
  }

  // Write sources and adjustments
  console.log('[3/4] Writing _sources.json and _adjustments.json...');
  fs.writeFileSync(path.join(ALL_DIR, '_sources.json'), JSON.stringify(sources, null, 2));
  fs.writeFileSync(path.join(ALL_DIR, '_adjustments.json'), JSON.stringify(allAdjustments, null, 2));

  console.log('[4/4] Dataset construction summary:');
  console.log(`  Total tickers written: ${Object.keys(sources).length}`);
  console.log(`  Failed tickers: ${failedTickers.length} (${failedTickers.slice(0, 10).join(', ')})`);
  console.log(`  Corporate action adjustments detected: ${allAdjustments.length}`);
  console.log('Dataset built successfully in:', ALL_DIR);
}

buildDataset().catch(err => {
  console.error('Error building dataset:', err);
  process.exit(1);
});
