'use strict';

const fs = require('fs');
const path = require('path');
const DATA_ROOT = '/home/ubuntu/auto-cuan/data/arjum-data';
const F_DIR = path.join(DATA_ROOT, 'broker-summary-F', 'KOTA');
const ALL_DIR = path.join(DATA_ROOT, 'broker-summary', 'KOTA');
const CANDLE_DIR = '/home/ubuntu/auto-cuan/data/daily-candles';

console.log('=== KOTA F file history ===');
if (fs.existsSync(F_DIR)) {
  const files = fs.readdirSync(F_DIR).filter(f => f.endsWith('.json')).sort();
  let nonEmpty = 0, empty = 0, noTrade = 0;
  const samples = [];
  for (const f of files) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(F_DIR, f), 'utf8'));
      const bc = Array.isArray(p.brokers) ? p.brokers.length : 0;
      const lc = Array.isArray(p.broker_levels) ? p.broker_levels.length : 0;
      if (p.derived === 'no-trade') noTrade++;
      else if (bc === 0 && lc === 0) empty++;
      else nonEmpty++;
      if (samples.length < 3) samples.push({ f, bc, lc, derived: p.derived || null, keys: Object.keys(p).join(',') });
    } catch (_) {}
  }
  console.log(`Total F files: ${files.length}, nonEmpty=${nonEmpty}, empty=${empty}, noTrade=${noTrade}`);
  console.log('Samples:', JSON.stringify(samples, null, 2));
} else {
  console.log('KOTA F dir does not exist');
}

console.log('\n=== KOTA all file for 2026-10-16 ===');
const allFile = path.join(ALL_DIR, '2026-10-16.json');
if (fs.existsSync(allFile)) {
  const p = JSON.parse(fs.readFileSync(allFile, 'utf8'));
  const bc = Array.isArray(p.brokers) ? p.brokers.length : 0;
  const lc = Array.isArray(p.broker_levels) ? p.broker_levels.length : 0;
  console.log({ size: fs.statSync(allFile).size, bc, lc, derived: p.derived, sampleBrokers: (p.brokers || []).slice(0, 3) });
}

console.log('\n=== KOTA F file for 2026-10-16 (raw) ===');
const fFile = path.join(F_DIR, '2026-10-16.json');
if (fs.existsSync(fFile)) {
  console.log(fs.readFileSync(fFile, 'utf8'));
}

console.log('\n=== KOTA candle turnover (last 60d) ===');
try {
  const cd = JSON.parse(fs.readFileSync(path.join(CANDLE_DIR, 'KOTA.json'), 'utf8'));
  const cs = (cd.candles || []).slice(-60);
  const sum = cs.reduce((a, c) => a + Number(c.volume || 0) * Number(c.close || 0), 0);
  console.log('Avg turnover over 60d:', (sum / cs.length).toLocaleString('id-ID'));
  console.log('Last candle:', cs[cs.length - 1]);
} catch (e) { console.log('err', e.message); }

// Check if any foreign brokers exist in KOTA all file
console.log('\n=== Any foreign broker codes in KOTA all? ===');
if (fs.existsSync(allFile)) {
  const p = JSON.parse(fs.readFileSync(allFile, 'utf8'));
  const FOREIGN = ['AK', 'BK', 'CS', 'DB', 'DX', 'GR', 'HD', 'KZ', 'ML', 'RX', 'UB', 'YP', 'YU', 'ZP', 'CG', 'LG', 'NI'];
  const codes = (p.brokers || []).map(b => b.broker_code);
  const found = codes.filter(c => FOREIGN.includes(c));
  console.log('All broker codes:', codes.join(','));
  console.log('Foreign-suspect codes present:', found.join(',') || '(none)');
}
