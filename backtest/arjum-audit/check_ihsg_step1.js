'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('=== CEK 1: FILESYSTEM PADA FOLDER DATA & CANDLE ===');
const baseDirs = [
  '/home/ubuntu/auto-cuan/data',
  '/home/ubuntu/auto-cuan/data/daily-candles',
  '/home/ubuntu/auto-cuan/data/daytrade-ohlcv-cache',
  '/home/ubuntu/auto-cuan/data/arjum-data',
  '/home/ubuntu/auto-cuan/data/arjum-data/broker-summary',
  '/home/ubuntu/auto-cuan/data/arjum-data/broker-summary-F',
  '/home/ubuntu/auto-cuan/data/arjum-data/broker-accumulation',
  '/home/ubuntu/auto-cuan-data'
];

for (const d of baseDirs) {
  if (fs.existsSync(d)) {
    try {
      const files = fs.readdirSync(d);
      const matches = files.filter(f => /ihsg|composite|jkse|\^jkse/i.test(f));
      console.log(`Directory: ${d} -> Matches: ${matches.length ? matches.join(', ') : 'TIDAK ADA'}`);
    } catch (e) {
      console.log(`Directory: ${d} -> Error: ${e.message}`);
    }
  } else {
    console.log(`Directory: ${d} -> TIDAK DITEMUKAN`);
  }
}

console.log('\n=== CEK 2: TABEL SQLITE (market_rows) ===');
const sqliteDb = '/home/ubuntu/auto-cuan-data/market.sqlite';
if (fs.existsSync(sqliteDb)) {
  const query = "SELECT table_name, row_key FROM market_rows WHERE row_key LIKE 'IHSG%' OR row_key LIKE 'COMPOSITE%' OR row_key LIKE '%JKSE%' OR row_key LIKE '%^JKSE%';";
  try {
    const res = execSync(`sqlite3 -readonly "${sqliteDb}" "${query}"`, { encoding: 'utf8' });
    console.log(`Query row_key matches:\n${res.trim() || 'TIDAK ADA ROW YANG COCOK'}`);
  } catch (e) {
    console.log(`SQLite query error: ${e.message}`);
  }

  // Also check if any table in market_rows contains IHSG in row_json
  const tables = ['stock_daily_history', 'stock_daily_features', 'sector_hot_latest', 'foreign_watchlist_daily'];
  for (const t of tables) {
    try {
      const q = `SELECT count(*) FROM market_rows WHERE table_name = '${t}' AND (row_key LIKE '%IHSG%' OR row_key LIKE '%JKSE%' OR row_key LIKE '%COMPOSITE%');`;
      const count = execSync(`sqlite3 -readonly "${sqliteDb}" "${q}"`, { encoding: 'utf8' }).trim();
      console.log(`Table ${t} with index symbol row_key: ${count}`);
    } catch (_) {}
  }
} else {
  console.log(`SQLite DB ${sqliteDb} tidak ditemukan.`);
}

console.log('\n=== CEK 3: PENCARIAN REPO/KODE TERKAIT PENULIS & PEMBACA IHSG ===');
// Check api/quote.js, api/candles.js, lib/market-regime.js
console.log('Selesai cek dasar.');
