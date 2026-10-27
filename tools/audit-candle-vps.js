#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const dir = path.resolve('/home/ubuntu/auto-cuan/data/daily-candles');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
const report = { totalFiles: files.length, badFiles: [], emptyFiles: [], zeroCloseFiles: [], totalCandles: 0, zeroClose: 0, nanClose: 0, negClose: 0, zeroVolume: 0, samples: {} };

for (const f of files) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
  catch(e) { report.badFiles.push(f); continue; }
  const candles = Array.isArray(raw) ? raw : (raw.candles || raw.data || []);
  if (candles.length === 0) { report.emptyFiles.push(f); continue; }
  const ticker = raw.code || f.replace('.json','');
  const last = candles[candles.length - 1];
  report.totalCandles += candles.length;
  for (const c of candles) {
    if (!c.close || c.close <= 0) report.zeroClose++;
    if (isNaN(c.close)) report.nanClose++;
    if (c.close < 0) report.negClose++;
    if (c.volume === undefined || c.volume === null || c.volume < 0) report.zeroVolume++;
  }
  if (!last.close || last.close <= 0 || isNaN(last.close))
    report.zeroCloseFiles.push({ ticker, lastDate: last.date || '', lastClose: last.close });
  if (Object.keys(report.samples).length < 5)
    report.samples[ticker] = { candles: candles.length, lastDate: last.date, lastClose: last.close, lastVolume: last.volume };
}
console.log(JSON.stringify({
  files: report.totalFiles, bad: report.badFiles.length, empty: report.emptyFiles.length,
  zeroFiles: report.zeroCloseFiles.length, totalCandles: report.totalCandles,
  zeroClose: report.zeroClose, nanClose: report.nanClose, negClose: report.negClose,
  zeroVolume: report.zeroVolume, samples: report.samples, zeroFilesSample: report.zeroCloseFiles.slice(0,10)
}));