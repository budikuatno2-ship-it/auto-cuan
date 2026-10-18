'use strict';

const fs = require('fs');
const path = require('path');
const ALL_DIR = '/home/ubuntu/auto-cuan/data/arjum-data/broker-summary';

let total = 0;
let withFlag = 0;
let levelsExact100 = 0;
let levelsGt100 = 0;
let levelsLt25 = 0;
let levels25 = 0;
let sampleWithFlag = [];

const dirs = fs.readdirSync(ALL_DIR);
for (const tk of dirs) {
  const tkDir = path.join(ALL_DIR, tk);
  let isDir = false;
  try { isDir = fs.statSync(tkDir).isDirectory(); } catch (_) {}
  if (!isDir) continue;
  for (const f of fs.readdirSync(tkDir)) {
    if (!f.endsWith('.json') || f === 'latest.json') continue;
    total++;
    try {
      const p = JSON.parse(fs.readFileSync(path.join(tkDir, f), 'utf8'));
      if (p.all_data === true) {
        withFlag++;
        if (sampleWithFlag.length < 3) sampleWithFlag.push(`${tk}/${f} levels=${(p.broker_levels||[]).length} brokers=${(p.brokers||[]).length}`);
      }
      const lv = Array.isArray(p.broker_levels) ? p.broker_levels.length : 0;
      if (lv === 25) levels25++;
      else if (lv === 100) levelsExact100++;
      else if (lv > 100) levelsGt100++;
      else if (lv < 25) levelsLt25++;
    } catch (_) {}
  }
}

console.log(JSON.stringify({
  total,
  withAllDataFlag: withFlag,
  levels25,
  levelsExact100,
  levelsGt100,
  levelsLt25,
  sampleWithFlag
}, null, 2));
