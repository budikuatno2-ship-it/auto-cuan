'use strict';
const fs = require('fs');

const logPath = '/home/ubuntu/auto-cuan-runner/logs/daily-market-update.log';
const lines = fs.readFileSync(logPath, 'utf8').split('\n');

const dates = [
  '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09',
  '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'
];

// Let's find timestamps for candle stages for these dates
const out = {};
for (const d of dates) out[d] = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  for (const d of dates) {
    if (line.includes(`"target_date": "${d}"`)) {
      // Look back for start of candle run or previous timestamp
      let ts = null;
      for (let j = Math.max(0, i - 100); j <= Math.min(lines.length - 1, i + 20); j++) {
        const m = /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})/.exec(lines[j]);
        if (m) ts = m[1];
      }
      out[d].push({ lineIndex: i, ts });
    }
  }
}
console.log(JSON.stringify(out, null, 2));
