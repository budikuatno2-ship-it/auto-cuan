'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SSH_KEY_PATH = 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';
const SQLITE_PATH = '/home/ubuntu/auto-cuan-data/market.sqlite';
const DATA_DIR = path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

async function extractVpsSqlite() {
  console.log('[1/4] Extracting BRPT data from VPS SQLite (read-only)...');

  // Extract stock_daily_history for BRPT
  const historyCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -i "${SSH_KEY_PATH}" ${VPS_HOST} "sqlite3 -readonly ${SQLITE_PATH} \\"SELECT row_json FROM market_rows WHERE table_name = 'stock_daily_history' AND row_key LIKE 'BRPT%' ORDER BY json_extract(row_json, '$.trade_date') ASC;\\""`;
  const historyRaw = execSync(historyCmd, { maxBuffer: 10 * 1024 * 1024 }).toString('utf8');
  const vpsHistory = historyRaw
    .trim()
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));

  fs.writeFileSync(path.join(DATA_DIR, 'vps_brpt_history.json'), JSON.stringify(vpsHistory, null, 2));
  console.log(`  -> Saved ${vpsHistory.length} VPS daily history bars (from ${vpsHistory[0]?.trade_date} to ${vpsHistory[vpsHistory.length - 1]?.trade_date})`);

  // Extract foreign_watchlist_daily for BRPT
  const foreignCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -i "${SSH_KEY_PATH}" ${VPS_HOST} "sqlite3 -readonly ${SQLITE_PATH} \\"SELECT row_json FROM market_rows WHERE table_name = 'foreign_watchlist_daily' AND (row_key LIKE '%BRPT%' OR row_json LIKE '%BRPT%') ORDER BY json_extract(row_json, '$.trade_date') ASC;\\""`;
  const foreignRaw = execSync(foreignCmd, { maxBuffer: 10 * 1024 * 1024 }).toString('utf8');
  const vpsForeign = foreignRaw
    .trim()
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));

  fs.writeFileSync(path.join(DATA_DIR, 'vps_brpt_foreign.json'), JSON.stringify(vpsForeign, null, 2));
  console.log(`  -> Saved ${vpsForeign.length} VPS foreign flow records (from ${vpsForeign[0]?.trade_date} to ${vpsForeign[vpsForeign.length - 1]?.trade_date})`);

  return { vpsHistory, vpsForeign };
}

async function fetchYahooFinance5Y() {
  console.log('[2/4] Fetching BRPT.JK 5-year OHLCV from Yahoo Finance...');
  const url = 'https://query2.finance.yahoo.com/v8/finance/chart/BRPT.JK?range=5y&interval=1d&includePrePost=false&events=div%7Csplit';
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AutoCuanBacktest/1.0' }
  });
  if (!res.ok) throw new Error(`Yahoo Finance responded with status ${res.status}`);
  const json = await res.json();
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result) throw new Error('No chart result in Yahoo Finance response');

  const timestamps = result.timestamp || [];
  const quote = result.indicators && result.indicators.quote && result.indicators.quote[0];
  if (!quote) throw new Error('No quote indicator in Yahoo response');

  const opens = quote.open || [];
  const highs = quote.high || [];
  const lows = quote.low || [];
  const closes = quote.close || [];
  const volumes = quote.volume || [];

  const candles = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] != null && opens[i] != null && highs[i] != null && lows[i] != null) {
      const timeSec = timestamps[i];
      // Convert to WIB date YYYY-MM-DD
      const wibDate = new Date((timeSec * 1000) + (7 * 3600 * 1000)).toISOString().slice(0, 10);
      candles.push({
        time: timeSec,
        date: wibDate,
        open: Math.round(opens[i]),
        high: Math.round(highs[i]),
        low: Math.round(lows[i]),
        close: Math.round(closes[i]),
        volume: volumes[i] != null ? Math.round(volumes[i]) : 0
      });
    }
  }

  // Deduplicate by date if any
  const uniqueCandles = [];
  const seenDates = new Set();
  for (const c of candles) {
    if (!seenDates.has(c.date)) {
      seenDates.add(c.date);
      uniqueCandles.push(c);
    }
  }

  fs.writeFileSync(path.join(DATA_DIR, 'yahoo_brpt_5y.json'), JSON.stringify(uniqueCandles, null, 2));
  fs.writeFileSync(path.join(DATA_DIR, 'yahoo_brpt_events.json'), JSON.stringify(result.events || {}, null, 2));
  console.log(`  -> Saved ${uniqueCandles.length} Yahoo Finance daily candles (from ${uniqueCandles[0]?.date} to ${uniqueCandles[uniqueCandles.length - 1]?.date})`);

  return uniqueCandles;
}

function compareDatasets(vpsHistory, yahooCandles, vpsForeign) {
  console.log('[3/4] Comparing overlapping dates between VPS SQLite and Yahoo Finance...');
  const vpsMap = new Map();
  for (const row of vpsHistory) {
    vpsMap.set(row.trade_date, row);
  }

  const comparison = {
    total_yahoo_bars: yahooCandles.length,
    total_vps_bars: vpsHistory.length,
    overlapping_bars: 0,
    mismatches: [],
    exact_matches: 0
  };

  for (const y of yahooCandles) {
    if (vpsMap.has(y.date)) {
      comparison.overlapping_bars++;
      const v = vpsMap.get(y.date);
      const diffOpen = y.open - v.open;
      const diffHigh = y.high - v.high;
      const diffLow = y.low - v.low;
      const diffClose = y.close - v.close;
      const diffVolume = y.volume - v.volume;

      if (diffOpen !== 0 || diffHigh !== 0 || diffLow !== 0 || diffClose !== 0 || diffVolume !== 0) {
        comparison.mismatches.push({
          date: y.date,
          yahoo: { open: y.open, high: y.high, low: y.low, close: y.close, volume: y.volume },
          vps: { open: v.open, high: v.high, low: v.low, close: v.close, volume: v.volume },
          diff: { open: diffOpen, high: diffHigh, low: diffLow, close: diffClose, volume: diffVolume }
        });
      } else {
        comparison.exact_matches++;
      }
    }
  }

  fs.writeFileSync(path.join(DATA_DIR, 'dataset_comparison.json'), JSON.stringify(comparison, null, 2));
  console.log(`  -> Overlapping bars: ${comparison.overlapping_bars}`);
  console.log(`  -> Exact matches: ${comparison.exact_matches}`);
  console.log(`  -> Mismatches: ${comparison.mismatches.length}`);

  // Build combined dataset
  console.log('[4/4] Building combined BRPT dataset...');
  const foreignMap = new Map();
  for (const f of vpsForeign) {
    foreignMap.set(f.trade_date, f);
  }

  // Combined dataset uses Yahoo for complete OHLCV history,
  // and links VPS foreign flow where available (foreign_net, nbsa, etc.).
  // Where foreign flow is not available, foreign fields are explicitly null (AntiSlop).
  const combined = yahooCandles.map(c => {
    const f = foreignMap.get(c.date) || null;
    return {
      time: c.time,
      date: c.date,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume, // volume in shares (lembar)
      turnover: c.volume * c.close, // estimated nominal turnover
      foreign_net: f ? f.foreign_net : null,
      foreign_nbsa: f ? f.nbsa : null,
      has_foreign_data: f !== null
    };
  });

  fs.writeFileSync(path.join(DATA_DIR, 'brpt_combined_dataset.json'), JSON.stringify(combined, null, 2));
  console.log(`  -> Combined dataset created with ${combined.length} bars. Bars with foreign data: ${combined.filter(b => b.has_foreign_data).length}`);
}

async function main() {
  try {
    const { vpsHistory, vpsForeign } = await extractVpsSqlite();
    const yahooCandles = await fetchYahooFinance5Y();
    compareDatasets(vpsHistory, yahooCandles, vpsForeign);
    console.log('Preparation completed successfully.');
  } catch (err) {
    console.error('Error during data preparation:', err);
    process.exit(1);
  }
}

main();
