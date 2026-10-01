'use strict';

/**
 * Scheduled Historical Backfill Runner
 * Intelligently manages quota based on day of week and market schedule:
 * - Weekends (Sat-Sun): Total quota 29,114 dedicated to backfill (limit 29,050).
 * - Weekdays Before EOD (< 18:00 WIB): Limit 24,114 (strictly reserves 5,000 for EOD).
 * - Weekdays After EOD (>= 18:00 WIB): EOD is completed, consumes remaining quota up to 29,050.
 * - Command line override: accepts --daily-limit <N>.
 */

const { spawn } = require('child_process');
const path = require('path');

const nowUtc = new Date();
const nowWib = new Date(nowUtc.getTime() + (7 * 3600 * 1000));
const dayOfWeek = nowWib.getUTCDay(); // 0 = Sunday, 6 = Saturday, 1-5 = Mon-Fri
const hourWib = nowWib.getUTCHours();
const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);

// Parse CLI argument if provided
let dailyLimit = null;
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--daily-limit' && process.argv[i + 1]) {
    dailyLimit = parseInt(process.argv[i + 1], 10);
  }
}

if (!dailyLimit) {
  if (isWeekend) {
    dailyLimit = 29050;
  } else if (hourWib >= 18 || hourWib < 6) {
    // Post-EOD or midnight: EOD has finished, consume remaining quota before reset
    dailyLimit = 29050;
  } else {
    // Pre-EOD: Reserve 5,000 for 18:00 WIB EOD sync
    dailyLimit = 24114;
  }
}

const logPrefix = isWeekend
  ? '[WEEKEND FULL-THROTTLE 29.050]'
  : (hourWib >= 18 || hourWib < 6
      ? '[POST-EOD FULL CONSUMPTION 29.050]'
      : '[PRE-EOD 24.114 (5.000 RESERVED FOR EOD)]');

console.log('=== AUTO-CUAN SCHEDULED BACKFILL RUNNER ===');
console.log('Time (WIB): ' + nowWib.toISOString().replace('T', ' ').slice(0, 19));
console.log('Day: ' + ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'][dayOfWeek] + ' (' + (isWeekend ? 'Akhir Pekan' : 'Hari Kerja') + ')');
console.log('Target Limit: ' + dailyLimit + ' ' + logPrefix);

const scriptPath = path.join(__dirname, 'backfill-engine.js');
const args = [
  scriptPath,
  '--from', '2026-01-01',
  '--to', '2026-05-31',
  '--daily-limit', String(dailyLimit)
];

const child = spawn(process.execPath, args, {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit'
});

child.on('exit', (code) => {
  console.log('Backfill engine finished with code ' + code);
  process.exit(code || 0);
});
