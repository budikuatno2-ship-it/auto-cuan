'use strict';
const fs = require('fs');
const path = require('path');

const D = '/home/ubuntu/auto-cuan/data/arjum-data';
const fBase = path.join(D, 'broker-summary-F');
const allBase = path.join(D, 'broker-summary');

const nonFFiles = [];
const tickers = fs.readdirSync(fBase);

for (const t of tickers) {
  const tDir = path.join(fBase, t);
  if (!fs.statSync(tDir).isDirectory()) continue;
  const files = fs.readdirSync(tDir).filter(f => f.endsWith('.json'));
  for (const f of files) {
    const p = path.join(tDir, f);
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (parsed.flow !== 'F') {
        nonFFiles.push({ ticker: t, file: f, pathF: p, flow: parsed.flow });
      }
    } catch (_) {}
    if (nonFFiles.length >= 200) break;
  }
  if (nonFFiles.length >= 200) break;
}

// Pick 20 pseudo-random or spread-out files
const step = Math.max(1, Math.floor(nonFFiles.length / 20));
const sample20 = [];
for (let i = 0; i < 20 && i * step < nonFFiles.length; i++) {
  sample20.push(nonFFiles[i * step]);
}

const comparisons = [];
for (const item of sample20) {
  const pathAll = path.join(allBase, item.ticker, item.file);
  const pathLatest = path.join(allBase, item.ticker, 'latest.json');
  const existsAll = fs.existsSync(pathAll);
  const existsLatest = fs.existsSync(pathLatest);

  const contentF = fs.readFileSync(item.pathF, 'utf8');
  const contentAll = existsAll ? fs.readFileSync(pathAll, 'utf8') : null;
  const contentLatest = existsLatest ? fs.readFileSync(pathLatest, 'utf8') : null;

  const identicalToDatedAll = contentAll ? contentF === contentAll : false;
  const identicalToLatestAll = contentLatest ? contentF === contentLatest : false;

  const parsedF = JSON.parse(contentF);

  comparisons.push({
    ticker: item.ticker,
    date: item.file.replace('.json', ''),
    flowF: item.flow,
    brokersInF: (parsedF.brokers || []).length,
    identicalToDatedAll,
    identicalToLatestAll,
    isSameAsDatedOrLatest: identicalToDatedAll || identicalToLatestAll
  });
}

console.log('=== HASIL PERBANDINGAN 20 FILE ACAK NON-F ===');
console.log(JSON.stringify(comparisons, null, 2));
