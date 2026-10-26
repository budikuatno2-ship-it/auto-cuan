'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const TICKERS = ['BBCA', 'TLKM', 'ADRO', 'ANTM', 'MEDC'];
const STRIDE = 5;

const BASE_DIR = __dirname;

function runTicker(ticker) {
  console.log(`\n====================================================`);
  console.log(`RUNNING DUA SKENARIO FOR: ${ticker} (Stride = ${STRIDE})`);
  console.log(`====================================================`);

  const targetFile = `data/universe/${ticker}.json`;
  const cmd = `node run-dua-skenario.js ${targetFile} data/universe ${STRIDE}`;

  const output = execSync(cmd, { cwd: BASE_DIR, maxBuffer: 20 * 1024 * 1024, encoding: 'utf8' });
  console.log(output);

  // Copy result to dua-skenario-hasil-<TICKER>.json
  const sourceResult = path.join(BASE_DIR, 'dua-skenario-hasil.json');
  const targetResult = path.join(BASE_DIR, `dua-skenario-hasil-${ticker}.json`);
  fs.copyFileSync(sourceResult, targetResult);
  console.log(`  -> Successfully saved: ${targetResult}`);
}

async function main() {
  for (const t of TICKERS) {
    runTicker(t);
  }
  console.log('\nAll 5 tickers completed successfully.');
}

main();
