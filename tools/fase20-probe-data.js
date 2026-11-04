#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');

function count(dir) {
  try { return fs.readdirSync(dir).length; } catch (_) { return -1; }
}
function sizeOf(p) {
  try { return fs.statSync(p).size; } catch (_) { return -1; }
}
function sample(dir, n) {
  try { return fs.readdirSync(dir).slice(0, n); } catch (_) { return []; }
}

const dirs = ['daily-candles', 'arjum-data', 'broker-accumulation', 'broker-hunter-indexes',
  'bandarmologi-intel-indexes', 'insider-network', 'daytrade-ohlcv-cache'];

for (const d of dirs) {
  const p = path.join(DATA, d);
  console.log(d.padEnd(28) + ' entries=' + String(count(p)).padEnd(6) + ' sample=' + JSON.stringify(sample(p, 4)));
}

// arjum-data subdirs
const arjum = path.join(DATA, 'arjum-data');
try {
  for (const sub of fs.readdirSync(arjum)) {
    const sp = path.join(arjum, sub);
    if (fs.statSync(sp).isDirectory()) {
      console.log('  arjum-data/' + sub + ' entries=' + count(sp) + ' sample=' + JSON.stringify(sample(sp, 3)));
    }
  }
} catch (_) {}

// financial statements for key tickers
const finTickers = ['BBCA', 'BBRI', 'BMRI', 'TLKM', 'BRPT', 'ANTM', 'GOTO', 'ASII', 'ADRO', 'MEDC', 'IHSG'];
console.log('');
console.log('=== PER-TICKER FILES ===');
for (const t of finTickers) {
  const candle = path.join(DATA, 'daily-candles', t + '.json');
  const accum = path.join(DATA, 'broker-accumulation', t + '.json');
  const fmt = p => fs.existsSync(p) ? Math.round(sizeOf(p) / 1024) + 'KB' : 'MISSING';
  let candleRows = 0;
  try {
    const c = JSON.parse(fs.readFileSync(candle, 'utf8'));
    candleRows = Array.isArray(c) ? c.length : (c.candles || []).length;
  } catch (_) {}
  console.log('  ' + t.padEnd(6) + ' candle=' + fmt(candle).padEnd(9) + ' rows=' + String(candleRows).padEnd(6) + ' accum=' + fmt(accum));
}

// financial statements directory names
console.log('');
console.log('=== arjum-data children (types) ===');
try {
  for (const sub of fs.readdirSync(arjum)) {
    const sp = path.join(arjum, sub);
    if (fs.statSync(sp).isDirectory()) {
      const inner = sample(sp, 2);
      console.log('  ' + sub + '/ -> ' + JSON.stringify(inner));
      if (inner.length) {
        const deep = path.join(sp, inner[0]);
        if (fs.existsSync(deep) && fs.statSync(deep).isDirectory()) {
          console.log('      deeper: ' + JSON.stringify(sample(deep, 4)));
        }
      }
    }
  }
} catch (e) { console.log('  err', e.message); }
