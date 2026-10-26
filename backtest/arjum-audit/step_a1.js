'use strict';
const fs = require('fs');
const path = require('path');

const D = '/home/ubuntu/auto-cuan/data/arjum-data/broker-summary-F';
const table = {}; // hour -> { flow: count }
let totalFiles = 0;
let stockCodeMismatch = 0;
const flowCounts = {};
const mismatchExamples = [];

const tickers = fs.readdirSync(D);

for (const ticker of tickers) {
  const tDir = path.join(D, ticker);
  let stat;
  try {
    stat = fs.statSync(tDir);
  } catch (_) { continue; }
  if (!stat.isDirectory()) continue;

  const files = fs.readdirSync(tDir).filter(f => f.endsWith('.json'));
  for (const f of files) {
    totalFiles++;
    const p = path.join(tDir, f);
    try {
      const fStat = fs.statSync(p);
      // Convert mtime to WIB (UTC+7)
      const wibDate = new Date(fStat.mtime.getTime() + 7 * 3600 * 1000);
      const hourKey = wibDate.toISOString().slice(0, 10) + ' ' + String(wibDate.getUTCHours()).padStart(2, '0') + ':00';

      const content = fs.readFileSync(p, 'utf8');
      const parsed = JSON.parse(content);

      const flowVal = String(parsed.flow !== undefined ? parsed.flow : 'missing');
      flowCounts[flowVal] = (flowCounts[flowVal] || 0) + 1;

      if (!table[hourKey]) table[hourKey] = {};
      table[hourKey][flowVal] = (table[hourKey][flowVal] || 0) + 1;

      const codeInFile = String(parsed.stock_code || parsed.code || '').trim().toUpperCase();
      if (codeInFile && codeInFile !== ticker.toUpperCase()) {
        stockCodeMismatch++;
        if (mismatchExamples.length < 5) {
          mismatchExamples.push({ file: p, expected: ticker, got: codeInFile });
        }
      }
    } catch (e) {
      flowCounts['corrupt'] = (flowCounts['corrupt'] || 0) + 1;
    }
  }
}

console.log('=== RINGKASAN TOTAL FLOW ===');
console.log(JSON.stringify({ totalFiles, stockCodeMismatch, flowCounts }, null, 2));

console.log('\n=== TABEL PER JAM (WIB) x FLOW ===');
const sortedHours = Object.keys(table).sort();
console.log('Hour (WIB)         | ' + Object.keys(flowCounts).map(k => k.padEnd(8)).join(' | '));
console.log('-------------------+-' + Object.keys(flowCounts).map(() => '---------').join('-+-'));
for (const h of sortedHours) {
  const row = Object.keys(flowCounts).map(k => String(table[h][k] || 0).padStart(8)).join(' | ');
  console.log(`${h} | ${row}`);
}

if (mismatchExamples.length > 0) {
  console.log('\n=== CONTOH STOCK_CODE MISMATCH ===');
  console.log(JSON.stringify(mismatchExamples, null, 2));
}
