'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SSH_KEY_PATH = 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';
const SQLITE_PATH = '/home/ubuntu/auto-cuan-data/market.sqlite';

const BASE_DATA_DIR = path.join(__dirname, 'data');
const UNIVERSE_DIR = path.join(BASE_DATA_DIR, 'universe');

if (!fs.existsSync(UNIVERSE_DIR)) {
  fs.mkdirSync(UNIVERSE_DIR, { recursive: true });
}

function runSsh(remoteCmd) {
  const args = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=15',
    '-i', SSH_KEY_PATH,
    VPS_HOST,
    remoteCmd
  ];
  return execFileSync('ssh', args, { maxBuffer: 25 * 1024 * 1024, encoding: 'utf8' });
}

function getTop80LiquidTickers() {
  console.log('[1/3] Extracting 60-day turnover data from VPS SQLite (read-only)...');
  const sql = `
    SELECT
      json_extract(row_json, '$.ticker') as ticker,
      json_extract(row_json, '$.trade_date') as trade_date,
      CAST(json_extract(row_json, '$.volume') AS REAL) * CAST(json_extract(row_json, '$.close') AS REAL) as turnover
    FROM market_rows
    WHERE table_name = 'stock_daily_history'
    ORDER BY json_extract(row_json, '$.ticker'), json_extract(row_json, '$.trade_date') DESC;
  `;

  const raw = runSsh(`sqlite3 -readonly -separator '|' ${SQLITE_PATH} "${sql.replace(/\n\s+/g, ' ').trim()}"`);
  const lines = raw.trim().split('\n').filter(Boolean);

  const tickerTurnovers = new Map();
  for (const line of lines) {
    const [ticker, date, turnStr] = line.split('|');
    if (!ticker || !turnStr) continue;
    const turn = Number(turnStr);
    if (!Number.isFinite(turn) || turn <= 0) continue;

    if (!tickerTurnovers.has(ticker)) {
      tickerTurnovers.set(ticker, []);
    }
    const arr = tickerTurnovers.get(ticker);
    if (arr.length < 60) {
      arr.push(turn);
    }
  }

  const tickerMedians = [];
  for (const [ticker, turns] of tickerTurnovers.entries()) {
    if (turns.length < 15) continue; // must have sufficient active trading sessions
    const sorted = turns.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    tickerMedians.push({
      ticker,
      sessions: turns.length,
      medianTurnover: median,
      medianTurnoverMiliar: Math.round(median / 1e7) / 100 // in Miliar IDR
    });
  }

  tickerMedians.sort((a, b) => b.medianTurnover - a.medianTurnover);
  const top80 = tickerMedians.slice(0, 80);

  // Ensure BRPT, BBCA, TLKM, ADRO, ANTM are present
  const required = ['BRPT', 'BBCA', 'TLKM', 'ADRO', 'ANTM'];
  for (const req of required) {
    if (!top80.some(t => t.ticker === req)) {
      const found = tickerMedians.find(t => t.ticker === req);
      if (found) top80.push(found);
    }
  }

  fs.writeFileSync(path.join(BASE_DATA_DIR, 'top80_liquid_tickers.json'), JSON.stringify(top80, null, 2));
  console.log(`  -> Selected top ${top80.length} liquid tickers. Top 5:`, top80.slice(0, 5).map(t => `${t.ticker} (${t.medianTurnoverMiliar} M)`).join(', '));
  return top80.map(t => t.ticker);
}

async function fetchTickerCandlesLong(symbol) {
  const isIndex = symbol.startsWith('^');
  const yahooSymbol = isIndex ? encodeURIComponent(symbol) : symbol + '.JK';
  // 2015-01-01 to Oct 2026
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?period1=1420070400&period2=1792195200&interval=1d&includePrePost=false`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AutoCuanBacktest/1.0' }
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
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
  const seenDates = new Set();

  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] != null && opens[i] != null && highs[i] != null && lows[i] != null) {
      const timeSec = timestamps[i];
      // Convert to WIB date YYYY-MM-DD
      const wibDate = new Date((timeSec * 1000) + (7 * 3600 * 1000)).toISOString().slice(0, 10);
      if (seenDates.has(wibDate)) continue;
      seenDates.add(wibDate);

      // Preserve raw adjusted prices as ratios (do not force tick rounding so shape ratios are accurate)
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
}

async function prepareAllData(tickers) {
  console.log(`[2/3] Fetching historical OHLCV since 2015 for BRPT and ${tickers.length} universe tickers...`);

  // 1. Fetch BRPT and save to data/BRPT.json
  console.log('  Fetching BRPT (primary target)...');
  const brptCandles = await fetchTickerCandlesLong('BRPT');
  if (!brptCandles || brptCandles.length === 0) {
    throw new Error('Failed to fetch BRPT candles');
  }
  fs.writeFileSync(path.join(BASE_DATA_DIR, 'BRPT.json'), JSON.stringify(brptCandles, null, 1));
  console.log(`  -> Saved BRPT.json: ${brptCandles.length} bars (${brptCandles[0].date} to ${brptCandles[brptCandles.length - 1].date})`);

  // 2. Fetch all universe tickers in batches
  console.log('  Fetching universe tickers into data/universe/ ...');
  const shortDataTickers = [];
  const failedTickers = [];

  const BATCH_SIZE = 5;
  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const batch = tickers.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (ticker) => {
      const targetPath = path.join(UNIVERSE_DIR, `${ticker}.json`);
      if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 1000) {
        // already fetched
        return;
      }
      try {
        const c = await fetchTickerCandlesLong(ticker);
        if (c && c.length > 0) {
          fs.writeFileSync(targetPath, JSON.stringify(c, null, 1));
          if (c.length < 300) {
            shortDataTickers.push({ ticker, bars: c.length });
          }
        } else {
          failedTickers.push(ticker);
        }
      } catch (err) {
        failedTickers.push(ticker);
      }
    }));
    process.stdout.write(`    Progress: ${Math.min(i + BATCH_SIZE, tickers.length)} / ${tickers.length}\r`);
    await new Promise(r => setTimeout(r, 100)); // rate limit courtesy
  }

  console.log('\n[3/3] Data preparation complete.');
  console.log(`  Tickers with < 300 bars (${shortDataTickers.length}):`, shortDataTickers);
  console.log(`  Failed tickers (${failedTickers.length}):`, failedTickers);

  fs.writeFileSync(path.join(BASE_DATA_DIR, 'short_data_report.json'), JSON.stringify({ shortDataTickers, failedTickers }, null, 2));
}

async function main() {
  try {
    const tickers = getTop80LiquidTickers();
    await prepareAllData(tickers);
    console.log('All universe data prepared successfully.');
  } catch (err) {
    console.error('Error preparing universe:', err);
    process.exit(1);
  }
}

main();
