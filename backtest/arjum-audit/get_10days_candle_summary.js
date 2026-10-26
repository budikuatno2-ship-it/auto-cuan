'use strict';
const fs = require('fs');

const logPath = '/home/ubuntu/auto-cuan-runner/logs/daily-market-update.log';
const lines = fs.readFileSync(logPath, 'utf8').split('\n');

const last10 = [
  '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09',
  '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'
];

const summaries = {};
for (const d of last10) summaries[d] = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line.includes('"target_date":') && line.includes('"universe":')) {
    // Collect the json block
    let start = i;
    while (start > 0 && !lines[start].trim().startsWith('{')) start--;
    let end = i;
    while (end < lines.length && !lines[end].trim().endsWith('}')) end++;
    try {
      const blob = lines.slice(start, end + 1).join('\n');
      const parsed = JSON.parse(blob);
      if (parsed.target_date && summaries[parsed.target_date]) {
        summaries[parsed.target_date].push({
          line: start + 1,
          ...parsed
        });
      }
    } catch (_) {}
  }
}

// Print the final/completed summary for each date
const report = [];
for (const d of last10) {
  const list = summaries[d] || [];
  // Pick the last run for that date
  const last = list.length ? list[list.length - 1] : null;
  report.push({
    date: d,
    ran: list.length > 0,
    attempts: list.length,
    universe: last ? last.universe : null,
    fetched: last ? last.fetched : null,
    cached: last ? last.cached : null,
    failed: last ? last.failed : null,
    quota_stop: last ? last.quota_stop : null,
    mode: last ? last.mode : null
  });
}
console.log(JSON.stringify(report, null, 2));
