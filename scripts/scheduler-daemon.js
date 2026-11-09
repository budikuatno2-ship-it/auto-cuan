#!/usr/bin/env node
'use strict';
/* V5 (BUG-V5-P0-006 / N13) — OBSERVER ONLY.
 * =====================================================================
 * SEJARAH: V3-F01 menjadikan daemon PM2 `auto-cuan-scheduler` sebagai
 * eksekutor jadwal kedua (00:01 catchup, 00:15-15:30 backfill, candle EOD,
 * broksum, insider, night burn) — SAMA dengan isi deploy/vps/final-schedule.cron.
 * Dua scheduler aktif untuk pekerjaan yang sama menghasilkan eksekusi ganda,
 * lock contention, dan konsumsi kuota tak terprediksi (N13 DETECTED).
 *
 * KEPUTUSAN DESAIN V5: cron (deploy/vps/final-schedule.cron via job-wrapper.sh)
 * adalah SATU-SATUNYA eksekutor jadwal. Daemon ini kini HANYA OBSERVER:
 *   - menulis heartbeat kesehatan tiap menit (data/job-heartbeat/scheduler-daemon.json)
 *   - mencatat jendela terlarang 23:50-00:10 WIB (informasi, bukan eksekusi)
 *   - TIDAK PERNAH spawn job apapun (tidak ada runNode/spawn di jalur eksekusi)
 * Candle tetap 100% Yahoo (0 panggilan Arjum) — aturan besi V3-F01 dipertahankan.
 *
 * Pencabutan proses PM2 lama di VPS adalah APPROVAL_REQUIRED:
 *   pm2 delete auto-cuan-scheduler && pm2 save
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HB_PATH = path.join(ROOT, 'data', 'job-heartbeat', 'scheduler-daemon.json');
const LOG_PATH = path.join(ROOT, 'logs', 'scheduler-daemon.log');

function wibParts(now) {
  const d = now instanceof Date ? now : new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const p = fmt.formatToParts(d);
  let Y = '', M = '', D = '', h = 0, mi = 0, s = 0;
  for (const x of p) {
    if (x.type === 'year') Y = x.value;
    if (x.type === 'month') M = x.value;
    if (x.type === 'day') D = x.value;
    if (x.type === 'hour') h = parseInt(x.value, 10);
    if (x.type === 'minute') mi = parseInt(x.value, 10);
    if (x.type === 'second') s = parseInt(x.value, 10);
  }
  if (h === 24) h = 0;
  const dateKey = Y + '-' + M + '-' + D;
  const dow = new Date(dateKey + 'T00:00:00Z').getUTCDay();
  return { dateKey, hour: h, minute: mi, second: s, dow, isWeekend: dow === 0 || dow === 6 };
}

function log(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, new Date().toISOString() + ' ' + msg + '\n');
  } catch (_) {}
  console.log('[scheduler-daemon] ' + msg);
}

function heartbeat(status, detail) {
  try {
    const p = wibParts(new Date());
    fs.mkdirSync(path.dirname(HB_PATH), { recursive: true });
    fs.writeFileSync(HB_PATH, JSON.stringify({
      jobName: 'auto-cuan-scheduler', lastWIB: p.dateKey + ' ' + String(p.hour).padStart(2, '0') + ':' + String(p.minute).padStart(2, '0'),
      status, detail: String(detail || '').slice(0, 500), updatedAt: new Date().toISOString()
    }, null, 2));
  } catch (_) {}
}

function inForbidden(p) {
  const cur = p.hour * 60 + p.minute;
  return cur >= 23 * 60 + 50 || cur < 10; // 23:50-00:10 WIB
}

let lastFiredMinute = '';

// Observer tick: lapor kesehatan, TIDAK menjalankan job apapun.
// Semua penjadwalan eksekusi hidup di deploy/vps/final-schedule.cron.
function tick() {
  const p = wibParts(new Date());
  const hm = String(p.hour).padStart(2, '0') + ':' + String(p.minute).padStart(2, '0');
  if (hm === lastFiredMinute) return;
  lastFiredMinute = hm;
  if (inForbidden(p)) { heartbeat('FORBIDDEN_WINDOW_OBSERVED', hm + ' (cron owns execution; observer idle)'); return; }
  heartbeat('OBSERVER', hm + ' (execution owned by cron; catchup-0015 @ 00:15)');
}

if (require.main === module) {
  log('start auto-cuan-scheduler OBSERVER (V5) TZ=Asia/Jakarta — execution owned by cron');
  heartbeat('START', 'observer online; execution owned by cron');
  tick();
  setInterval(tick, 20000);
}

module.exports = { wibParts, tick };
