'use strict';
const fs = require('fs');

const logPath = '/home/ubuntu/auto-cuan-runner/logs/daily-market-update.log';
const lines = fs.readFileSync(logPath, 'utf8').split('\n');

const last10TradingDays = [
  '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09',
  '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'
];

const results = {};
for (const d of last10TradingDays) {
  results[d] = {
    date: d,
    ran: false,
    runsCount: 0,
    candleOutputs: [],
    brokerOutputs: [],
    errors: { 429: 0, 500: 0, timeout: 0, other: 0 }
  };
}

let currentRunDate = null;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  // Match target date in log
  const matchDate = /Target Date \(WIB\):\s*(\d{4}-\d{2}-\d{2})/.exec(line);
  if (matchDate && results[matchDate[1]]) {
    currentRunDate = matchDate[1];
    results[currentRunDate].ran = true;
    results[currentRunDate].runsCount++;
  }

  // Check candle JSON output
  if (line.includes('"target_date"') && line.includes('"universe"')) {
    try {
      let start = i;
      while (start > 0 && !lines[start].trim().startsWith('{')) start--;
      let end = i;
      while (end < lines.length && !lines[end].trim().endsWith('}')) end++;
      const blob = lines.slice(start, end + 1).join('\n');
      const parsed = JSON.parse(blob);
      if (parsed.target_date && results[parsed.target_date]) {
        results[parsed.target_date].candleOutputs.push(parsed);
      }
    } catch (_) {}
  }

  // Check errors
  if (currentRunDate) {
    if (line.includes('429') || line.includes('rate limit')) results[currentRunDate].errors[429]++;
    if (line.includes('500') || line.includes('502') || line.includes('503')) results[currentRunDate].errors[500]++;
    if (line.includes('timeout') || line.includes('ETIMEDOUT') || line.includes('ESOCKETTIMEDOUT')) results[currentRunDate].errors.timeout++;
  }
}

console.log(JSON.stringify(results, null, 2));
