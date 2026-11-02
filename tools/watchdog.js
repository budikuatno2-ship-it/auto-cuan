#!/usr/bin/env node
'use strict';
// P6 — Watchdog operasional 5 menitan & alarm Telegram otomatis (0 Kuota API data upstream).
// P2-kompatibel: exit 0 pada run sukses (insiden dilaporkan via JSON + Telegram,
// bukan via exit code) agar heartbeat watchdog sendiri tetap hijau untuk gate P2.
// Memeriksa tiap tick cron:
//   (a) heartbeat data/job-heartbeat/*.json: exitCode!==0 atau basi melebihi toleransi jadwalnya;
//   (b) snapshot DayTrade basi saat jam bursa aktif (via lib/daytrade-snapshot-alarm.js);
//   (c) drift Kuota API data >2% atau sisa kritis (via lib/quota-state.js, tanpa hardcode angka paket);
//   (d) proses PM2 errored/stopped/restart berulang (via `pm2 jlist`, best-effort lokal);
//   (e) disk VPS >85% atau RAM bebas <10%.
// Menulis status ke data/alerts/operational-status.json (dibaca Admin Console) dan
// mengirim Telegram Admin dengan cooldown/anti-spam di data/alerts/sent-history.json
// (satu pesan per insiden sampai teratasi; tidak spam pada tick berikutnya).
// Mekanisme kirim memakai lib/telegram-notifier.js yang sudah ada (baca env di memori,
// tanpa pernah print nilai secret).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HEARTBEAT_DIR = path.join(ROOT, 'data', 'job-heartbeat');
const RUNNER_LOGS = process.env.AUTO_CUAN_RUNNER_DIR
  ? path.join(process.env.AUTO_CUAN_RUNNER_DIR, 'logs')
  : '/home/ubuntu/auto-cuan-runner/logs';
const LOCAL_LOGS = path.join(ROOT, 'logs', 'cron');
const ALERTS_DIR = path.join(ROOT, 'data', 'alerts');
const STATUS_PATH_DEFAULT = path.join(ALERTS_DIR, 'operational-status.json');
const HISTORY_PATH_DEFAULT = path.join(ALERTS_DIR, 'sent-history.json');

// Cooldown anti-spam per insiden: satu pesan sampai insiden teratasi,
// dengan batas paksa kirim ulang bila insiden menetap sangat lama.
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 jam
const QUOTA_LABEL = 'Kuota API data';

// Ambang operasional (persen, bukan angka paket kuota — bukan hardcode kuota).
const DISK_USED_PCT_MAX = 85;
const MEM_FREE_PCT_MIN = 10;
const QUOTA_CRITICAL_REMAIN_PCT = 5;

function parseArgs(argv) {
  const o = { maxAgeMin: null, jobs: null, json: false, noAlert: false, statusPath: null, historyPath: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--no-alert') o.noAlert = true;
    else if (a === '--max-age-min' && argv[i + 1] !== undefined) { const v = parseInt(argv[++i], 10); if (Number.isFinite(v) && v > 0) o.maxAgeMin = v; }
    else if (a.startsWith('--max-age-min=')) { const v = parseInt(a.slice(14), 10); if (Number.isFinite(v) && v > 0) o.maxAgeMin = v; }
    else if (a === '--jobs' && argv[i + 1] !== undefined) { o.jobs = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean); }
    else if (a.startsWith('--jobs=')) { o.jobs = a.slice(7).split(',').map((s) => s.trim()).filter(Boolean); }
    else if (a === '--status-path' && argv[i + 1] !== undefined) { o.statusPath = String(argv[++i]); }
    else if (a.startsWith('--status-path=')) { o.statusPath = a.slice(14); }
    else if (a === '--history-path' && argv[i + 1] !== undefined) { o.historyPath = String(argv[++i]); }
    else if (a.startsWith('--history-path=')) { o.historyPath = a.slice(15); }
  }
  return o;
}

function listHeartbeats() {
  try {
    if (!fs.existsSync(HEARTBEAT_DIR)) return [];
    return fs.readdirSync(HEARTBEAT_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  } catch (_) { return []; }
}

function readHeartbeat(name) {
  try {
    const raw = fs.readFileSync(path.join(HEARTBEAT_DIR, name + '.json'), 'utf8');
    return JSON.parse(raw);
  } catch (_) { return null; }
}

function ageMin(hb, nowMs) {
  try {
    const ref = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const end = hb && hb.lastEndWIB ? new Date(hb.lastEndWIB).getTime() : NaN;
    if (!Number.isFinite(end)) return Infinity;
    return (ref - end) / 60000;
  } catch (_) { return Infinity; }
}

// Toleransi keterlambatan per job (menit), diturunkan dari ritme jadwalnya.
// Job 5-menitan toleransi ketat; job harian/mingguan toleransi longgar.
function defaultToleranceMin(jobName) {
  const n = String(jobName || '');
  if (n === 'watchdog' || n === 'security-monitor') return 10;
  if (/fastwatcher/.test(n)) return 15;
  if (/daytrade-producer|sector-hot-intraday/.test(n)) return 30;
  if (/suspension-guard/.test(n)) return 30;
  if (/daily-candles|ihsg-candle|lifecycle|market-context|sector-hot-eod/.test(n)) return 180;
  if (/broksum|domestic-compile|bandarmologi|screeners-preflight|top5-radar|landing-snapshot|afternoon-recap/.test(n)) return 240;
  if (/insider-tiered|fundamental-refresh|quota-burn|catchup|backfill/.test(n)) return 300;
  return 180;
}

function isOkHeartbeatStatus(status) {
  return status === 'OK' || status === 'LOCK_BUSY' || status === 'FORBIDDEN_WINDOW_SKIP' || status === 'SCHEDULED_SKIP';
}

// (a) Klasifikasi satu heartbeat: gagal (exitCode) atau terlambat (basi).
// Mengembalikan issue {key,severity,source,detail} atau null bila sehat.
function classifyHeartbeat(hb, nowMs, toleranceMin) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  if (!hb || typeof hb !== 'object') {
    return { key: 'heartbeat:unknown:missing', severity: 'critical', source: 'heartbeat', detail: 'heartbeat hilang/korup' };
  }
  const name = hb.jobName || 'unknown';
  if (name === 'watchdog' || name === 'security-monitor') return null; // run saat ini adalah bukti hidup
  const badExit = hb.exitCode !== 0 && !isOkHeartbeatStatus(hb.status);
  if (badExit) {
    return {
      key: 'heartbeat:' + name + ':exit',
      severity: 'critical',
      source: 'heartbeat',
      detail: name + ': exitCode=' + hb.exitCode + ' status=' + (hb.status || '?') + ' ' + String(hb.lastErrorSnippet || '').slice(0, 120)
    };
  }
  const tol = Number.isFinite(Number(toleranceMin)) && Number(toleranceMin) > 0
    ? Number(toleranceMin)
    : defaultToleranceMin(name);
  const a = ageMin(hb, now);
  if (!(a <= tol)) {
    const ageTxt = Number.isFinite(a) ? (Math.round(a * 10) / 10) + ' mnt' : 'tak terbaca';
    return {
      key: 'heartbeat:' + name + ':stale',
      severity: 'warning',
      source: 'heartbeat',
      detail: name + ': heartbeat basi (' + ageTxt + ' > ' + tol + ' mnt)'
    };
  }
  return null;
}

// (d) Klasifikasi satu proses PM2: stopped/errored/restart berulang.
// Mendukung bentuk pm2 jlist {name, pm_id, pm2_env:{status, restart_time, unstable_restarts}}
// maupun bentuk ringkas {name, status, restart_time, unstable_restarts}.
function classifyPm2Proc(proc) {
  if (!proc || typeof proc !== 'object') return null;
  const name = proc.name || (proc.pm2_env && proc.pm2_env.name) || 'unknown-pm2';
  const env = proc.pm2_env && typeof proc.pm2_env === 'object' ? proc.pm2_env : proc;
  const status = String(env.status || proc.status || 'unknown').toLowerCase();
  const restarts = Number(env.unstable_restarts != null ? env.unstable_restarts : proc.unstable_restarts);
  const restartTime = Number(env.restart_time != null ? env.restart_time : proc.restart_time);
  if (status === 'online') {
    const loop = (Number.isFinite(restarts) && restarts > 3) || (Number.isFinite(restartTime) && restartTime > 10);
    if (loop) {
      return {
        key: 'pm2:' + name + ':restart-loop',
        severity: 'critical',
        source: 'pm2',
        detail: name + ': restart berulang (restart_time=' + restartTime + ' unstable=' + restarts + ')'
      };
    }
    return null;
  }
  if (status === 'stopped' || status === 'errored' || status === 'stopping' || status === 'launching' || status === 'one-launch-status') {
    return {
      key: 'pm2:' + name + ':' + status,
      severity: 'critical',
      source: 'pm2',
      detail: name + ': status PM2 ' + status + ' (restart_time=' + (Number.isFinite(restartTime) ? restartTime : '?') + ')'
    };
  }
  return null;
}

// (c) Klasifikasi snapshot Kuota API data: drift >2% atau sisa kritis.
// Membaca bentuk snapshot lib/quota-state.js (tanpa hardcode angka paket).
function classifyQuota(snap) {
  if (!snap || typeof snap !== 'object') return null;
  const limit = Number(snap.limit);
  const remaining = Number(snap.remaining);
  const drift = Number(snap.drift);
  if (snap.driftDetected === true) {
    return {
      key: 'quota:drift',
      severity: 'warning',
      source: 'quota',
      detail: QUOTA_LABEL + ' drift terdeteksi (selisih ' + (Number.isFinite(drift) ? drift : '?') + ', dipakai ' + snap.used + '/' + (Number.isFinite(limit) ? limit : '?') + ')'
    };
  }
  if (Number.isFinite(drift) && Number.isFinite(limit) && limit > 0) {
    const pct = (Math.abs(drift) / Math.max(1, limit)) * 100;
    if (pct > 2) {
      return {
        key: 'quota:drift',
        severity: 'warning',
        source: 'quota',
        detail: QUOTA_LABEL + ' drift ' + pct.toFixed(1) + '% melebihi ambang (selisih ' + drift + ')'
      };
    }
  }
  if (Number.isFinite(limit) && limit > 0 && Number.isFinite(remaining)) {
    if (remaining <= 0) {
      return { key: 'quota:exhausted', severity: 'critical', source: 'quota', detail: QUOTA_LABEL + ' habis (sisa 0)' };
    }
    if ((remaining / limit) * 100 < QUOTA_CRITICAL_REMAIN_PCT) {
      return { key: 'quota:critical', severity: 'critical', source: 'quota', detail: QUOTA_LABEL + ' sisa kritis (' + remaining + '/' + limit + ')' };
    }
  }
  return null;
}

// (b) Klasifikasi snapshot DayTrade: basi saat jam bursa aktif.
// Input {marketOpen, snapshotDate, lastTradingDay, snapshotMtime, now, staleMinutes}.
function classifyDaytrade(input) {
  const d = input || {};
  try {
    const alarm = require(path.join(ROOT, 'lib', 'daytrade-snapshot-alarm'));
    if (!alarm || typeof alarm.evaluate !== 'function') return null;
    const decision = alarm.evaluate({
      snapshotMtime: d.snapshotMtime,
      now: d.now != null ? d.now : new Date(),
      marketOpen: d.marketOpen === true,
      staleMinutes: Number.isFinite(Number(d.staleMinutes)) ? Number(d.staleMinutes) : undefined,
      snapshotDate: d.snapshotDate,
      lastTradingDay: d.lastTradingDay
    });
    if (decision && decision.shouldAlert === true) {
      return {
        key: 'daytrade:stale',
        severity: 'critical',
        source: 'daytrade',
        detail: 'DayTrade basi saat jam bursa (' + String(decision.reason || 'stale') + ', umur ' + (decision.ageMinutes == null ? '?' : decision.ageMinutes + ' mnt') + ')'
      };
    }
    return null;
  } catch (_) { return null; }
}

// (e) Klasifikasi disk/RAM: disk >85% atau RAM bebas <10%.
function classifyDisk(disk) {
  const d = disk || {};
  const used = Number(d.diskUsedPct);
  const free = Number(d.memFreePct);
  if (Number.isFinite(used) && used > DISK_USED_PCT_MAX) {
    return { key: 'disk:usage', severity: 'critical', source: 'disk', detail: 'disk VPS ' + used + '% > ' + DISK_USED_PCT_MAX + '%' };
  }
  if (Number.isFinite(free) && free < MEM_FREE_PCT_MIN) {
    return { key: 'mem:low', severity: 'critical', source: 'disk', detail: 'RAM bebas ' + free + '% < ' + MEM_FREE_PCT_MIN + '%' };
  }
  return null;
}

function readQuotaSnapshot(now) {
  try {
    const qs = require(path.join(ROOT, 'lib', 'quota-state'));
    return qs.getQuotaSnapshot(now != null ? now : new Date());
  } catch (_) { return null; }
}

function readDaytradeInput(now) {
  const at = now != null ? now : Date.now();
  try {
    const snapPath = path.join(ROOT, 'data', 'screener-latest.json');
    let mtime = null;
    let snapshotDate = null;
    try {
      const st = fs.statSync(snapPath);
      mtime = st.mtime;
      const raw = fs.readFileSync(snapPath, 'utf8');
      const snap = JSON.parse(raw);
      snapshotDate = (snap && snap.source_dates && snap.source_dates.daytrade)
        ? String(snap.source_dates.daytrade).slice(0, 10)
        : ((snap && (snap.market_date || snap.run_date || snap.trade_date)) ? String(snap.market_date || snap.run_date || snap.trade_date).slice(0, 10) : null);
    } catch (_) {}
    let marketOpen = false;
    try {
      const guard = require(path.join(ROOT, 'lib', 'market-hours-guard'));
      if (guard && typeof guard.isMarketOpen === 'function') marketOpen = guard.isMarketOpen(new Date(at)) === true;
    } catch (_) {}
    let lastTradingDay = null;
    try {
      const alarm = require(path.join(ROOT, 'lib', 'daytrade-snapshot-alarm'));
      if (alarm && typeof alarm.resolveLastTradingDay === 'function') {
        lastTradingDay = alarm.resolveLastTradingDay(new Date(at));
      }
    } catch (_) {}
    return { marketOpen, snapshotDate, lastTradingDay, snapshotMtime: mtime, now: new Date(at) };
  } catch (_) {
    return { marketOpen: false, snapshotDate: null, lastTradingDay: null, snapshotMtime: null, now: new Date(at) };
  }
}

function readPm2List() {
  try {
    const out = execSync('pm2 jlist', { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
    const arr = JSON.parse(String(out || '[]'));
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}

function readDiskStats() {
  let diskUsedPct = null;
  let memFreePct = null;
  try {
    const total = os.totalmem();
    const free = os.freemem();
    if (Number.isFinite(total) && total > 0 && Number.isFinite(free)) {
      memFreePct = Math.round((free / total) * 1000) / 10;
    }
  } catch (_) {}
  try {
    if (process.platform !== 'win32') {
      const df = execSync('df -k /', { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
      const lines = String(df || '').split('\n');
      for (const ln of lines) {
        const m = ln.match(/(\d+)%/);
        if (m) { diskUsedPct = parseInt(m[1], 10); break; }
      }
    }
  } catch (_) {}
  return { diskUsedPct, memFreePct };
}

// Evaluasi gabungan 5 lapis. Opsi injeksi memudahkan simulasi gate tanpa I/O.
function evaluateAll(opts) {
  const o = opts || {};
  const nowMs = o.now != null ? new Date(o.now).getTime() : Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const issues = [];

  // (a) heartbeat
  let heartbeats = o.heartbeats;
  if (!Array.isArray(heartbeats)) {
    const isProbe = (n) => /(-probe|-test|^p2-|-canary)$/.test(String(n || ''));
    heartbeats = listHeartbeats()
      .filter((n) => !isProbe(n))
      .map((n) => readHeartbeat(n))
      .filter(Boolean);
  }
  const tolerances = o.tolerances || {};
  const maxAgeFallback = (o.maxAgeMin != null && Number.isFinite(Number(o.maxAgeMin)) && Number(o.maxAgeMin) > 0)
    ? Number(o.maxAgeMin)
    : null;
  for (const hb of heartbeats) {
    if (!hb) continue;
    const tol = tolerances[hb.jobName] != null ? tolerances[hb.jobName] : (maxAgeFallback != null ? maxAgeFallback : defaultToleranceMin(hb.jobName));
    const issue = classifyHeartbeat(hb, nowMs, tol);
    if (issue) issues.push(Object.assign({ at: nowIso }, issue));
  }

  // (d) PM2
  const pm2List = Array.isArray(o.pm2List) ? o.pm2List : readPm2List();
  for (const proc of pm2List) {
    const issue = classifyPm2Proc(proc);
    if (issue) issues.push(Object.assign({ at: nowIso }, issue));
  }

  // (c) Kuota API data
  const quotaSnapshot = o.quotaSnapshot !== undefined ? o.quotaSnapshot : readQuotaSnapshot(new Date(nowMs));
  if (quotaSnapshot) {
    const issue = classifyQuota(quotaSnapshot);
    if (issue) issues.push(Object.assign({ at: nowIso }, issue));
  }

  // (b) DayTrade
  const daytrade = o.daytrade !== undefined ? o.daytrade : readDaytradeInput(nowMs);
  if (daytrade) {
    const issue = classifyDaytrade(daytrade);
    if (issue) issues.push(Object.assign({ at: nowIso }, issue));
  }

  // (e) disk/RAM
  const disk = o.disk !== undefined ? o.disk : readDiskStats();
  if (disk) {
    const issue = classifyDisk(disk);
    if (issue) issues.push(Object.assign({ at: nowIso }, issue));
  }

  const ok = issues.length === 0;
  return {
    ok,
    at: nowIso,
    checked: {
      heartbeats: heartbeats.length,
      pm2: pm2List.length,
      quota: quotaSnapshot ? 1 : 0,
      daytrade: daytrade ? 1 : 0,
      disk: disk ? 1 : 0
    },
    issues,
    quota: quotaSnapshot ? {
      label: QUOTA_LABEL,
      used: quotaSnapshot.used,
      limit: quotaSnapshot.limit,
      remaining: quotaSnapshot.remaining,
      pct: quotaSnapshot.pct,
      driftDetected: quotaSnapshot.driftDetected === true
    } : { label: QUOTA_LABEL, used: null, limit: null },
    summary: ok ? 'OK' : ('DARURAT: ' + issues.length + ' insiden')
  };
}

function writeOperationalStatus(result, opts) {
  const o = opts || {};
  const dest = o.statusPath || STATUS_PATH_DEFAULT;
  const payload = {
    ok: result ? result.ok === true : false,
    at: (result && result.at) || new Date().toISOString(),
    checked: (result && result.checked) || {},
    issues: Array.isArray(result && result.issues) ? result.issues : [],
    quota: (result && result.quota) || { label: QUOTA_LABEL },
    summary: (result && result.summary) || '',
    reader: 'Admin Console: baca file ini untuk panel status operasional'
  };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(payload, null, 2));
  return dest;
}

function readSentHistory(historyPath) {
  const p = historyPath || HISTORY_PATH_DEFAULT;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return {};
  } catch (_) { return {}; }
}

function writeSentHistory(history, historyPath) {
  const p = historyPath || HISTORY_PATH_DEFAULT;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(history || {}, null, 2));
  return p;
}

function buildAlertMessage(result) {
  const lines = [];
  lines.push('🚨 WATCHDOG OPERASIONAL — ' + (result && result.issues ? result.issues.length : 0) + ' insiden');
  lines.push('');
  lines.push('Waktu: ' + ((result && result.at) || new Date().toISOString()));
  lines.push(QUOTA_LABEL + ': ' + (result && result.quota ? ('dipakai ' + result.quota.used + '/' + result.quota.limit) : 'tidak terbaca'));
  lines.push('');
  for (const issue of (result && result.issues) || []) {
    lines.push('• [' + (issue.severity || '?') + '/' + (issue.source || '?') + '] ' + (issue.detail || issue.key));
  }
  lines.push('');
  lines.push('Cek: pm2 jlist / tail log cron / data/job-heartbeat/*.json');
  return lines.join('\n');
}

async function defaultTelegramSender(text) {
  const notifier = require(path.join(ROOT, 'lib', 'telegram-notifier'));
  return notifier.sendTelegramMessage(text, { skip_market_guard: true });
}

// Anti-spam: kirim SATU pesan gabungan untuk insiden baru saja; tick berikutnya
// diam selama insiden yang sama belum teratasi. Insiden yang hilang dari hasil
// dianggap pulih dan dihapus dari histori sehingga insiden berikutnya kirim lagi.
async function maybeSendAlerts(opts) {
  const o = opts || {};
  const result = o.result || { ok: true, issues: [] };
  const historyPath = o.historyPath || HISTORY_PATH_DEFAULT;
  const nowMs = o.now != null ? new Date(o.now).getTime() : Date.now();
  const sender = typeof o.sender === 'function' ? o.sender : defaultTelegramSender;
  const cooldownMs = Number.isFinite(Number(o.cooldownMs)) && Number(o.cooldownMs) > 0 ? Number(o.cooldownMs) : ALERT_COOLDOWN_MS;

  const history = readSentHistory(historyPath);
  const currentKeys = new Set(((result.issues) || []).map((i) => String(i.key)));
  let changed = false;
  for (const k of Object.keys(history)) {
    if (!currentKeys.has(k)) { delete history[k]; changed = true; }
  }

  if (!result.issues || result.issues.length === 0) {
    if (changed || Object.keys(history).length > 0) writeSentHistory({}, historyPath);
    else {
      try { writeSentHistory(history, historyPath); } catch (_) {}
    }
    return { sent: 0, skipped: 0, historyPath };
  }

  const fresh = [];
  for (const issue of result.issues) {
    const k = String(issue.key);
    const prev = history[k];
    if (prev && Number.isFinite(Number(prev.lastSentAt)) && (nowMs - Number(prev.lastSentAt)) < cooldownMs) {
      continue; // insiden sama, belum teratasi, masih cooldown -> jangan spam
    }
    fresh.push(issue);
  }

  if (fresh.length === 0) {
    if (changed) writeSentHistory(history, historyPath);
    return { sent: 0, skipped: result.issues.length, historyPath };
  }

  const text = buildAlertMessage({ ok: false, at: result.at, issues: fresh, quota: result.quota });
  let res = null;
  try {
    res = await sender(text);
  } catch (e) {
    res = { sent: false, reason: 'sender_throw: ' + (e && e.message ? e.message : e) };
  }
  const okSend = Boolean(res && (res.sent === true || res.ok === true || res.skipped === true));
  if (okSend) {
    for (const issue of fresh) {
      history[String(issue.key)] = { lastSentAt: nowMs, severity: issue.severity || null, detail: String(issue.detail || '').slice(0, 200) };
    }
    writeSentHistory(history, historyPath);
    return { sent: fresh.length, skipped: result.issues.length - fresh.length, historyPath, result: res };
  }
  if (changed) writeSentHistory(history, historyPath);
  return { sent: 0, skipped: result.issues.length, historyPath, result: res, sendFailed: true };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  // Direktori vital: heartbeat + salah satu lokasi log cron + alerts.
  for (const d of [HEARTBEAT_DIR, LOCAL_LOGS, path.join(RUNNER_LOGS, 'cron'), ALERTS_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  }
  // maxAgeMin CLI hanya override global bila diberikan eksplisit; default null
  // memakai toleransi per-job defaultToleranceMin (ritme jadwal masing-masing).
  const result = evaluateAll({ now: Date.now(), maxAgeMin: opts.maxAgeMin, tolerances: null });
  // Filter --jobs bila diminta (kompatibel CLI P2).
  let out = result;
  if (opts.jobs && opts.jobs.length) {
    const keep = new Set(opts.jobs);
    const hbIssues = result.issues.filter((i) => i.source !== 'heartbeat' || keep.has(String(i.key).split(':')[1]));
    out = Object.assign({}, result, { issues: hbIssues, ok: hbIssues.length === 0, summary: hbIssues.length === 0 ? 'OK' : ('DARURAT: ' + hbIssues.length + ' insiden') });
  }
  const statusPath = opts.statusPath || STATUS_PATH_DEFAULT;
  const historyPath = opts.historyPath || HISTORY_PATH_DEFAULT;
  writeOperationalStatus(out, { statusPath });

  const finish = (alertRes) => {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: out.ok, at: out.at, checked: out.checked, issues: out.issues, quota: out.quota, alerts: alertRes || null }, null, 2) + '\n');
    } else {
      console.log('[watchdog] ' + (out.ok ? 'OK' : 'ISSUES=' + out.issues.length) + ' checkedHb=' + (out.checked && out.checked.heartbeats));
      for (const i of out.issues) console.log('  - [' + i.source + '] ' + i.detail);
      if (alertRes) console.log('[watchdog] telegram sent=' + alertRes.sent + ' skipped=' + alertRes.skipped);
    }
    // P6: watchdog yang menemukan insiden tetap exit 0 — insiden dilaporkan via
    // JSON + Telegram, bukan via exit code, agar heartbeat watchdog sendiri
    // tetap hijau untuk gate P2 (menemukan masalah adalah tugasnya, bukan gagalnya).
    process.exitCode = 0;
    return out;
  };

  if (opts.noAlert) return finish(null);
  return maybeSendAlerts({ result: out, historyPath }).then(
    (alertRes) => finish(alertRes),
    () => finish({ sent: 0, skipped: out.issues.length, sendFailed: true })
  );
}

if (require.main === module) main();

module.exports = {
  parseArgs,
  listHeartbeats,
  readHeartbeat,
  ageMin,
  defaultToleranceMin,
  classifyHeartbeat,
  classifyPm2Proc,
  classifyQuota,
  classifyDaytrade,
  classifyDisk,
  evaluateAll,
  writeOperationalStatus,
  readSentHistory,
  writeSentHistory,
  buildAlertMessage,
  maybeSendAlerts,
  readQuotaSnapshot,
  readDaytradeInput,
  readPm2List,
  readDiskStats,
  main,
  STATUS_PATH_DEFAULT,
  HISTORY_PATH_DEFAULT,
  ALERT_COOLDOWN_MS,
  QUOTA_LABEL
};
