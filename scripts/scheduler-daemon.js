#!/usr/bin/env node
'use strict';
/* V3-F01 — Daemon scheduler permanen (PM2: auto-cuan-scheduler).
 * Tiap menit cek WIB (Asia/Jakarta):
 *  00:01 reset+catchup (pending-catchup-queue.json)
 *  00:15-15:30 backfill terukur weekday / penuh weekend
 *  09:00-16:05 FastWatcher Yahoo 0 kuota
 *  16:30 & 17:00 (retry 17:45) candle EOD IHSG+963 saham 100% Yahoo 0 kuota + deteksi libur
 *  19:45 (retry 20:45) Broksum ALL+Foreign hari berjalan
 *  20:25 & 21:10 domestik+akumulasi+rebuild fast-bundle
 *  21:25 3 screener | 21:45 broadcast Telegram
 *  22:00 & 22:20 insider+Q2 | 22:45-23:49 night burn hingga 23:50 hard-stop
 * ATURAN BESI: dilarang polling CI GitHub; dilarang sentuh Vercel;
 * candle 100% Yahoo (0 panggilan Arjum); backtest/data 100% riil.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PENDING_PATH = path.join(ROOT, 'data', 'pending-catchup-queue.json');
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

function runNode(script, args, timeoutMs) {
  try {
    const r = spawnSync(process.execPath, [path.join(ROOT, script)].concat(args || []), {
      cwd: ROOT, timeout: timeoutMs || 120000, encoding: 'utf8',
      env: Object.assign({}, process.env, { TZ: 'Asia/Jakarta', CANDLE_SOURCE: 'yahoo', CANDLE_CROSSCHECK: 'false' })
    });
    return { ok: (r.status === 0), code: r.status, out: String(r.stdout || '').slice(-2000), err: String(r.stderr || '').slice(-1000) };
  } catch (e) {
    return { ok: false, code: 1, out: '', err: String(e && e.message) };
  }
}

function loadPending() {
  try {
    const raw = fs.readFileSync(PENDING_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (_) { return null; }
}

let lastFiredMinute = '';

function tick() {
  const p = wibParts(new Date());
  const hm = String(p.hour).padStart(2, '0') + ':' + String(p.minute).padStart(2, '0');
  if (hm === lastFiredMinute) return;
  lastFiredMinute = hm;
  const cur = p.hour * 60 + p.minute;

  // Hard-stop: 23:50-00:10 tidak ada job kuota.
  if (inForbidden(p)) { heartbeat('FORBIDDEN_WINDOW_SKIP', hm); return; }

  try {
    // 00:01 reset + catchup pending queue (00:00:01/00:01 WIB).
    if (hm === '00:01') {
      log('00:01 reset+catchup');
      const q = loadPending();
      if (q && Array.isArray(q.dates) && q.dates.length) {
        for (const d of q.dates.slice(0, 4)) {
          runNode('tools/catchup-missing-dates.js', ['--date=' + d], 300000);
        }
      } else {
        runNode('tools/catchup-missing-dates.js', [], 300000);
      }
      heartbeat('OK', '00:01 catchup done');
      return;
    }
    // Backfill terukur: weekday 00:15-15:30 (cap 13000 via quota-burn floor 5000),
    // weekend penuh (floor 0). Dieksekusi tiap 30 mnt agar estafet dengan cron :35.
    const isBackfillWindow = p.isWeekend
      ? (cur >= 15 && cur <= 15 * 60 + 30)
      : (cur >= 15 && cur <= 15 * 60 + 30);
    if ((p.minute % 30 === 0) && isBackfillWindow) {
      const qs = require(path.join(ROOT, 'lib', 'quota-state'));
      const floor = qs.reserveFloorFor(new Date(), qs.loadConfig());
      const gate = qs.canConsumeQuota(1, 'scheduler-backfill');
      if (gate.ok) {
        log('backfill window ' + hm + ' floor=' + floor);
        runNode('tools/quota-burn.js', ['--floor=' + floor], 600000);
      }
      heartbeat('OK', 'backfill window ' + hm);
      return;
    }
    // 16:30 & 17:00 candle EOD 100% Yahoo 0 kuota + deteksi libur (retry 17:45 via cron).
    if (hm === '16:30' || hm === '17:00') {
      log('candle EOD Yahoo ' + hm);
      runNode('tools/fetch-daily-candles.js', [], 1500000);
      runNode('tools/fetch-ihsg-candle.js', ['--yahoo-only'], 120000);
      heartbeat('OK', 'candle EOD ' + hm);
      return;
    }
    // 19:45 Broksum ALL+Foreign hari berjalan (retry 20:45 via cron).
    if (hm === '19:45') {
      log('broksum EOD trigger ' + hm);
      heartbeat('OK', 'broksum window — cron job-wrapper mengeksekusi run-daily-market-update');
      return;
    }
    // 20:25 & 21:10 domestik+akumulasi (0 kuota lokal).
    if (hm === '20:25' || hm === '21:10') {
      log('domestic compile ' + hm);
      runNode('tools/build-domestic-broksum-and-accum.js', ['--apply', '--skip-hunter'], 600000);
      heartbeat('OK', 'domestic compile ' + hm);
      return;
    }
    // 21:25 3 screener (0 kuota, preflight gate).
    if (hm === '21:25') { heartbeat('OK', 'screener window — cron screeners-preflight'); return; }
    // 21:45 broadcast Telegram.
    if (hm === '21:45') { heartbeat('OK', 'telegram recap window — cron afternoon-recap'); return; }
    // 22:00 insider tiered, 22:20 fundamental Q2.
    if (hm === '22:00') {
      log('insider tiered');
      runNode('tools/collect-insider-data.js', ['--tiered', '--floor=5000'], 1500000);
      heartbeat('OK', 'insider 22:00');
      return;
    }
    if (hm === '22:20') {
      log('fundamental Q2 refresh');
      runNode('tools/run-fundamental-refresh.js', ['--batch=20', '--apply', '--floor=5000'], 1200000);
      heartbeat('OK', 'fundamental 22:20');
      return;
    }
    // 22:45-23:49 night burn hingga 23:50 hard-stop.
    if (cur >= 22 * 60 + 45 && cur <= 23 * 60 + 49) {
      const qs2 = require(path.join(ROOT, 'lib', 'quota-state'));
      const chk = qs2.shouldHardExitOnFloor ? qs2.shouldHardExitOnFloor(new Date()) : null;
      if (chk && chk.exit) { heartbeat('OK', 'night burn exit floor remaining=' + chk.remaining); return; }
      if (p.minute % 10 === 0) {
        log('night burn ' + hm);
        runNode('tools/quota-burn.js', ['--floor=5000'], 500000);
      }
      heartbeat('OK', 'night burn watch ' + hm);
      return;
    }
    heartbeat('IDLE', hm);
  } catch (e) {
    log('tick error: ' + (e && e.message));
    heartbeat('ERROR', String(e && e.message).slice(0, 300));
  }
}

if (require.main === module) {
  log('start auto-cuan-scheduler (V3-F01) TZ=Asia/Jakarta');
  heartbeat('START', 'daemon online');
  tick();
  setInterval(tick, 20000);
}

module.exports = { wibParts, tick };
