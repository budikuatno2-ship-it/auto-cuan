'use strict';
const fs = require('fs');

const logPath = '/home/ubuntu/auto-cuan-runner/logs/daily-market-update.log';
const content = fs.readFileSync(logPath, 'utf8');

const last10 = [
  '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09',
  '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'
];

// Split by JSON object containing "universe" and "target_date"
const regex = /\{\s*"mode":\s*"([^"]+)",[\s\S]*?"universe":\s*(\d+),[\s\S]*?"target_date":\s*"([^"]+)",[\s\S]*?"fetched":\s*(\d+),[\s\S]*?"cached":\s*(\d+),[\s\S]*?"failed":\s*(\d+),[\s\S]*?"quota_stop":\s*(true|false)/g;

const records = [];
let match;
while ((match = regex.exec(content)) !== null) {
  records.push({
    mode: match[1],
    universe: Number(match[2]),
    target_date: match[3],
    fetched: Number(match[4]),
    cached: Number(match[5]),
    failed: Number(match[6]),
    quota_stop: match[7] === 'true'
  });
}

const table = [];
for (const d of last10) {
  const matching = records.filter(r => r.target_date === d);
  const last = matching.length ? matching[matching.length - 1] : null;
  table.push({
    target_date: d,
    ran: matching.length > 0,
    attempts: matching.length,
    universe: last ? last.universe : 0,
    fetched: last ? last.fetched : 0,
    cached: last ? last.cached : 0,
    failed: last ? last.failed : 0,
    quota_stop: last ? last.quota_stop : false
  });
}

console.log(JSON.stringify(table, null, 2));
