'use strict';

const fs = require('fs');
const path = require('path');
const ALL_DIR = '/home/ubuntu/auto-cuan/data/arjum-data/broker-summary';

let levels25Full = 0;
let levels25Padded = 0;
let levels100Full = 0;
let levels100Padded = 0;
let levelsOtherFull = 0;
let levelsOtherPadded = 0;
const samples = { levels100Full: [], levels25Full: [] };

const dirs = fs.readdirSync(ALL_DIR);
for (const tk of dirs) {
  const tkDir = path.join(ALL_DIR, tk);
  let isDir = false;
  try { isDir = fs.statSync(tkDir).isDirectory(); } catch (_) {}
  if (!isDir) continue;
  for (const f of fs.readdirSync(tkDir)) {
    if (!f.endsWith('.json') || f === 'latest.json') continue;
    let p;
    try { p = JSON.parse(fs.readFileSync(path.join(tkDir, f), 'utf8')); } catch (_) { continue; }
    const lv = Array.isArray(p.broker_levels) ? p.broker_levels : [];
    let nonNull = 0;
    for (const l of lv) {
      if (l && (l.buy || l.sell)) nonNull++;
    }
    const len = lv.length;
    const isFull = nonNull === len && len > 0;

    if (len === 25) { if (isFull) { levels25Full++; if (samples.levels25Full.length < 5) samples.levels25Full.push(`${tk}/${f} nonNull=${nonNull}`); } else levels25Padded++; }
    else if (len === 100) { if (isFull) { levels100Full++; if (samples.levels100Full.length < 5) samples.levels100Full.push(`${tk}/${f} nonNull=${nonNull}`); } else levels100Padded++; }
    else { if (isFull) levelsOtherFull++; else levelsOtherPadded++; }
  }
}

console.log(JSON.stringify({
  levels25Full, levels25Padded,
  levels100Full, levels100Padded,
  levelsOtherFull, levelsOtherPadded,
  samples
}, null, 2));
