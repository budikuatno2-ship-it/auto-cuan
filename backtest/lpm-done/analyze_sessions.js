'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const RAW_DIR = path.join(__dirname, 'raw');

function loadJsonlGz(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const buf = fs.readFileSync(filePath);
  const text = zlib.gunzipSync(buf).toString('utf8');
  return text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function analyzeMinutes(rows) {
  const minMap = {};
  for (const r of rows) {
    if (!r.time) continue;
    const m = r.time.slice(0, 5); // HH:MM
    minMap[m] = (minMap[m] || 0) + 1;
  }
  return minMap;
}

function main() {
  const filesToAnalyze = [
    { label: 'BRPT 2026-09-08 (Tuesday)', path: path.join(RAW_DIR, '2026-09-08', 'BRPT.jsonl.gz') },
    { label: 'MEDC 2026-09-08 (Tuesday)', path: path.join(RAW_DIR, '2026-09-08', 'MEDC.jsonl.gz') },
    { label: 'ADRO 2026-09-08 (Tuesday)', path: path.join(RAW_DIR, '2026-09-08', 'ADRO.jsonl.gz') },
    { label: 'BRPT 2026-10-16 (Friday)',  path: path.join(RAW_DIR, '2026-10-16', 'BRPT.jsonl.gz') },
    { label: 'MEDC 2026-10-16 (Friday)',  path: path.join(RAW_DIR, '2026-10-16', 'MEDC.jsonl.gz') }
  ];

  const report = {};

  for (const item of filesToAnalyze) {
    const rows = loadJsonlGz(item.path);
    if (!rows) {
      console.log(`Skipping missing ${item.path}`);
      continue;
    }

    const minMap = analyzeMinutes(rows);
    const sortedMins = Object.keys(minMap).sort();

    // Check specific boundary windows
    const preOpening = sortedMins.filter(m => m < '09:00');
    const midDay = sortedMins.filter(m => m >= '11:20' && m <= '14:05');
    const eodClosing = sortedMins.filter(m => m >= '15:45');

    report[item.label] = {
      totalRows: rows.length,
      earliestTime: rows[rows.length - 1]?.time,
      latestTime: rows[0]?.time,
      preOpeningMinutes: preOpening.map(m => `${m}: ${minMap[m]}`),
      midDayMinutes: midDay.map(m => `${m}: ${minMap[m]}`),
      eodMinutes: eodClosing.map(m => `${m}: ${minMap[m]}`)
    };
  }

  console.log(JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(__dirname, 'session_time_analysis.json'), JSON.stringify(report, null, 2));
}

main();
