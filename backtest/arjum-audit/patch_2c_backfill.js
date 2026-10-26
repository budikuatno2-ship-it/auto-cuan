'use strict';

const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '..', '..', 'tools', 'backfill-broksum.js');
let c = fs.readFileSync(target, 'utf8');
const crlf = c.includes('\r\n');
c = c.replace(/\r\n/g, '\n');

function rep(from, to, label) {
  if (!c.includes(from)) { console.error('NOT FOUND: ' + label); process.exitCode = 1; return; }
  c = c.replace(from, to);
  console.log('OK: ' + label);
}

// 2c constants
rep(
`// Default pacing: 8 req/sec (125ms delay) as verified in benchmark
const DEFAULT_DELAY_MS = 125;
const SLOWDOWN_DELAY_MS = 200; // 5 req/sec on rate burst
const WEEKDAY_RESERVE = 800;
const WEEKEND_RESERVE = 300;`,
`// Default pacing: 8 req/sec (125ms delay) as verified in benchmark
const DEFAULT_DELAY_MS = 125;
const SLOWDOWN_DELAY_MS = 200; // 5 req/sec on rate burst
const WEEKDAY_RESERVE = 800;
const WEEKEND_RESERVE = 300;
// 2c: BEFORE the EOD .done sentinel exists for today, reserve enough quota for
// the production EOD run (J1 + J2) so the 23:30 retry still has room.
// (avg J1 2.628 + avg J2 962) + 500 headroom = ~4.500.
const WEEKDAY_RESERVE_BEFORE_EOD = 4500;

// 2c: read the EOD completion sentinel written by run-daily-market-update.js.
function eodDoneExists(baseDir, wibDateKey) {
  try {
    return fs.existsSync(path.join(baseDir, '_eod', wibDateKey + '.done'));
  } catch (_) { return false; }
}

// WIB date key (YYYY-MM-DD) with no external deps.
function wibDateKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
  return parts;
}

// Holiday/weekend detection without throwing when the calendar is unavailable.
function isTradingDaySafe(dateKey) {
  try {
    const cal = require('../lib/idx-trading-calendar');
    if (typeof cal.isTradingDay === 'function') {
      return cal.isTradingDay(dateKey, cal.getSeedHolidaySet ? cal.getSeedHolidaySet() : undefined);
    }
    const holidays = cal.getSeedHolidaySet ? cal.getSeedHolidaySet() : new Set();
    const d = new Date(dateKey + 'T00:00:00Z');
    const day = d.getUTCDay();
    return day !== 0 && day !== 6 && !holidays.has(dateKey);
  } catch (_) {
    const d = new Date(dateKey + 'T00:00:00Z');
    const day = d.getUTCDay();
    return day !== 0 && day !== 6;
  }
}`,
'2c constants + eod/dates helpers'
);

// Replace the mode auto-detect + reserve computation
rep(
`  if (!mode) {
    const now = new Date();
    const dayOfWeek = now.getUTCDay();
    mode = (dayOfWeek === 0 || dayOfWeek === 6) ? 'weekend' : 'weekday';
  }

  // Set Arjum throttle delay in process env so client throttle queue matches worker pacing
  process.env.ARJUM_THROTTLE_DELAY_MS = String(delayMs);

  const reserveQuota = mode === 'weekend' ? WEEKEND_RESERVE : WEEKDAY_RESERVE;
  const baseDir = getBaseDir(overrideTargetDir);`,
`  if (!mode) {
    const now = new Date();
    const dayOfWeek = now.getUTCDay();
    mode = (dayOfWeek === 0 || dayOfWeek === 6) ? 'weekend' : 'weekday';
  }

  // Set Arjum throttle delay in process env so client throttle queue matches worker pacing
  process.env.ARJUM_THROTTLE_DELAY_MS = String(delayMs);

  const baseDir = getBaseDir(overrideTargetDir);

  // 2c: holiday fallback. On a non-trading weekday, behave like weekend.
  const todayKey = wibDateKey();
  if (mode === 'weekday' && !isTradingDaySafe(todayKey)) {
    console.log('[MODE] ' + todayKey + ' bukan hari bursa -> beralih ke mode weekend.');
    mode = 'weekend';
  }

  // 2c: dynamic weekday reserve. Before the EOD .done sentinel for today exists,
  // keep a large reserve so the 23:30 production retry can still run. After the
  // sentinel exists, the small 800 reserve applies.
  let reserveQuota;
  if (mode === 'weekend') {
    reserveQuota = WEEKEND_RESERVE;
  } else {
    const doneExists = eodDoneExists(baseDir, todayKey);
    reserveQuota = doneExists ? WEEKDAY_RESERVE : WEEKDAY_RESERVE_BEFORE_EOD;
  }`,
'dynamic reserve + holiday fallback'
);

if (crlf) c = c.replace(/\n/g, '\r\n');
fs.writeFileSync(target, c, 'utf8');
console.log('Patched:', target);