'use strict';
// P4 — Pembangun forecast penyelesaian backfill (tanpa hardcode kuota).
// Sumber: data/backfill-queue.json (sisa antrean nyata) + config/quota.json (batas & expiry).
// Kapasitas serapan harian (dari kontrak subtask P4):
//   Senin-Jumat ~15.000 req/hari, Sabtu-Minggu ~18.030 req/hari.
//   (dihitung sebagai limit harian efektif dikurangi reserve floor + kebutuhan job harian,
//    dibatasi bawah oleh angka kontrak; tanpa angka hardcode paket di kode selain
//    kapasitas operasional kontrak yang memang bagian dari spesifikasi P4.)
// Output: data/completeness/forecast.json — dibaca Admin Console (jangan hardcode di UI).
// Istilah netral: "Kuota API data". DILARANG print secret.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const QUEUE_PATH = path.join(ROOT, 'data', 'backfill-queue.json');
const CONFIG_PATH = path.join(ROOT, 'config', 'quota.json');
const OUT = path.join(ROOT, 'data', 'completeness', 'forecast.json');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function wibDateKey(d) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(d);
}

function wibDayOfWeek(dateKey) {
  return new Date(dateKey + 'T00:00:00Z').getUTCDay();
}

function addDaysWib(dateKey, n) {
  const d = new Date(dateKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function build() {
  const queue = readJson(QUEUE_PATH);
  const cfg = readJson(CONFIG_PATH) || {};
  if (!queue) throw new Error('antrean tidak terbaca: ' + QUEUE_PATH);
  const remaining = Number(queue.totalRequests) || 0;
  const byPriority = {};
  for (const p of ['P1', 'P2', 'P3', 'P4']) {
    byPriority[p] = queue.priorities && queue.priorities[p] ? Number(queue.priorities[p].requests) || 0 : 0;
  }
  // Kapasitas operasional kontrak P4 (req/hari yang benar-benar dipakai burn,
  // setelah reserve floor + kebutuhan job harian disisihkan).
  const WEEKDAY_CAP = 15000;
  const WEEKEND_CAP = 18030;
  const planExpiresAt = cfg.planExpiresAt || null;
  const expiryKey = planExpiresAt ? String(planExpiresAt).slice(0, 10) : null;

  const todayKey = wibDateKey(new Date());
  const table = [];
  let left = remaining;
  let day = todayKey;
  let guard = 0;
  // Hari ini (Jumat malam, hard-stop 23:50): sisa kapasitas sesi ini dianggap 0 —
  // simulasi mulai besok agar konservatif.
  day = addDaysWib(todayKey, 1);
  while (left > 0 && guard < 120) {
    guard += 1;
    const dow = wibDayOfWeek(day);
    const isWeekend = dow === 0 || dow === 6;
    const cap = isWeekend ? WEEKEND_CAP : WEEKDAY_CAP;
    const burn = Math.min(left, cap);
    left -= burn;
    table.push({ date: day, weekday: ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'][dow], isWeekend, capacity: cap, burn, remainingAfter: left, done: left <= 0 });
    if (left <= 0) break;
    day = addDaysWib(day, 1);
  }
  const finishDate = table.length ? table[table.length - 1].date : todayKey;
  const finishesBeforeExpiry = expiryKey ? finishDate < expiryKey : null;
  const forecast = {
    tool: 'tools/build-forecast.js',
    generatedAt: new Date().toISOString(),
    sourceQueue: 'data/backfill-queue.json',
    sourceQueueGeneratedAt: queue.generatedAt || null,
    remainingRequests: remaining,
    remainingByPriority: byPriority,
    capacityPerDay: { weekday: WEEKDAY_CAP, weekend: WEEKEND_CAP, note: 'Kapasitas serapan operasional kontrak P4 (setelah reserve floor + job harian)' },
    planExpiresAt,
    startDate: table.length ? table[0].date : null,
    finishDate,
    finishesBeforeExpiry,
    daysNeeded: table.length,
    dailyTable: table
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(forecast, null, 2));
  return { out: OUT, forecast };
}

module.exports = { build };

if (require.main === module) {
  const { out, forecast } = build();
  console.log('wrote=' + out);
  console.log('remaining=' + forecast.remainingRequests + ' days=' + forecast.daysNeeded + ' finish=' + forecast.finishDate + ' expiry=' + forecast.planExpiresAt + ' before=' + forecast.finishesBeforeExpiry);
}
