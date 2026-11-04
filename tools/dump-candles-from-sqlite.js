'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.AUTO_CUAN_MARKET_DB || 'D:/Auto-Cuan/data-subset/market-vps-full.sqlite';
const OUT_DIR = path.join(__dirname, '..', 'data', 'daily-candles');

console.log('Reading from', DB_PATH);
const db = new DatabaseSync(DB_PATH, { readOnly: true });

fs.mkdirSync(OUT_DIR, { recursive: true });

console.time('Load SQLite rows');
const rows = db.prepare("SELECT row_json FROM market_rows WHERE table_name='stock_daily_history'").all();
console.timeEnd('Load SQLite rows');
console.log('Total history rows:', rows.length);

console.time('Group by ticker');
const tickerMap = new Map();
for (let i = 0; i < rows.length; i++) {
  const o = JSON.parse(rows[i].row_json);
  const t = o.ticker;
  if (!t) continue;
  let arr = tickerMap.get(t);
  if (!arr) {
    arr = [];
    tickerMap.set(t, arr);
  }
  arr.push({
    date: o.trade_date,
    open: o.open,
    high: o.high,
    low: o.low,
    close: o.close,
    volume: o.volume
  });
}
console.timeEnd('Group by ticker');
console.log('Total tickers found in history:', tickerMap.size);

// Also check stock_boards to see if any ticker has 0 history
const boardRows = db.prepare("SELECT row_json FROM market_rows WHERE table_name='stock_boards'").all();
for (let i = 0; i < boardRows.length; i++) {
  const b = JSON.parse(boardRows[i].row_json);
  if (b.ticker && !tickerMap.has(b.ticker)) {
    tickerMap.set(b.ticker, []);
  }
}
console.log('Total tickers after checking boards:', tickerMap.size);

console.time('Write JSON files');
let written = 0;
for (const [ticker, candles] of tickerMap.entries()) {
  candles.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const payload = {
    code: ticker,
    ticker: ticker,
    range: '1y',
    candles: candles,
    source: 'vps_sqlite'
  };
  fs.writeFileSync(path.join(OUT_DIR, `${ticker}.json`), JSON.stringify(payload, null, 2));
  written++;
}
console.timeEnd('Write JSON files');
console.log(`Successfully wrote ${written} files to ${OUT_DIR}`);
