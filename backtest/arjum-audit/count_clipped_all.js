'use strict';
const fs = require('fs');
const path = require('path');

const allDir = '/home/ubuntu/auto-cuan/data/arjum-data/broker-summary';
let total = 0;
let clipped = 0;
let unclipped = 0;

const tickers = fs.readdirSync(allDir);
for (const t of tickers) {
  const tDir = path.join(allDir, t);
  let files;
  try { files = fs.readdirSync(tDir).filter(f => f.endsWith('.json') && f !== 'latest.json'); } catch(_) { continue; }
  for (const f of files) {
    total++;
    const p = path.join(tDir, f);
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(parsed.broker_levels) && parsed.broker_levels.length === 25 && parsed.all_data !== true) {
        clipped++;
      } else {
        unclipped++;
      }
    } catch (_) {}
  }
}
console.log(JSON.stringify({ total, clipped, unclipped }, null, 2));
