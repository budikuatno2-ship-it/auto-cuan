#!/usr/bin/env node
'use strict';

/**
 * scripts/watchdog.js
 * Auto-Cuan V4 Watchdog Operasional & Forensic Health Monitor.
 * 
 * FASE V4-F02:
 * 1. Pembungkaman Total Spam ke Grup Telegram Signal Saham Bot.
 *    - Notifikasi HANYA dikirim ke Chat ID pribadi Admin (6396446903).
 *    - HANYA dikirim jika status adalah kegagalan kritis (MERAH / CRITICAL / ERROR).
 *    - DILARANG mengirim status kuning / warning atau hijau ke Telegram.
 * 2. Penyesuaian Stale Threshold:
 *    - Job harian (broksum-1945, insider-tiered-2200, fundamental-refresh-2220,
 *      evening-brief-1700, morning-brief-0600) = 1560 menit (26 jam) anti-alarm siang.
 *    - daytrade-producer dipersiapkan aktif sejak 08:50 WIB hari bursa.
 * 3. Audit direktori data/heartbeats/ & eliminasi zombie.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PRIMARY_HEARTBEAT_DIR = path.join(ROOT, 'data', 'heartbeats');
const SECONDARY_HEARTBEAT_DIR = path.join(ROOT, 'data', 'job-heartbeat');

const RUNNER_LOGS = process.env.AUTO_CUAN_RUNNER_DIR
  ? path.join(process.env.AUTO_CUAN_RUNNER_DIR, 'logs')
  : '/home/ubuntu/auto-cuan-runner/logs';
const LOCAL_LOGS = path.join(ROOT, 'logs', 'cron');
const ALERTS_DIR = path.join(ROOT, 'data', 'alerts');
const STATUS_PATH_DEFAULT = path.join(ALERTS_DIR, 'operational-status.json');
const HISTORY_PATH_DEFAULT = path.join(ALERTS_DIR, 'sent-history.json');

const ADMIN_CHAT_ID = '6396446903';
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 jam cooldown
const QUOTA_LABEL = 'Kuota API data';

// Ambang batas operasional
const DISK_USED_PCT_MAX = 85;
const MEM_FREE_PCT_MIN = 10;
const QUOTA_CRITICAL_REMAIN_PCT = 5;

// DayTrade Producer window configuration
const DAYTRADE_PRODUCER_START_WIB = '08:50';
const DAYTRADE_PRODUCER_END_WIB = '16:05';

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

function getWibComponents(dateInput) {
  const d = dateInput ? new Date(dateInput) : new Date();
  const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
  const wib = new Date(utc + (7 * 3600000));
  return {
    hours: wib.getHours(),
    minutes: wib.getMinutes(),
    dayOfWeek: wib.getDay(), // 0: Sun, 1-5: Mon-Fri, 6: Sat
    isWeekday: wib.getDay() >= 1 && wib.getDay() <= 5,
    timeMinutes: wib.getHours() * 60 + wib.getMinutes(),
    dateStr: wib.toISOString().slice(0, 10)
  };
}

function isDaytradeProducerActive(dateInput) {
  const wib = getWibComponents(dateInput);
  if (!wib.isWeekday) return false;
  const startMin = 8 * 60 + 50; // 08:50 WIB = 530
  const endMin = 16 * 60 + 5;   // 16:05 WIB = 965
  return wib.timeMinutes >= startMin && wib.timeMinutes <= endMin;
}

function listHeartbeats() {
  const names = new Set();
  for (const dir of [PRIMARY_HEARTBEAT_DIR, SECONDARY_HEARTBEAT_DIR]) {
    try {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
        for (const f of files) {
          names.add(f.slice(0, -5));
        }
      }
    } catch (_) {}
  }
  return Array.from(names).sort();
}

function readHeartbeat(name) {
  for (const dir of [PRIMARY_HEARTBEAT_DIR, SECONDARY_HEARTBEAT_DIR]) {
    try {
      const p = path.join(dir, name + '.json');
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed;
      }
    } catch (_) {}
  }
  return null;
}

function ageMin(hb, nowMs) {
  try {
    const ref = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const rawTime = hb.lastRun || hb.lastEndWIB || hb.updatedAt || hb.lastStartWIB;
    const end = rawTime ? new Date(rawTime).getTime() : NaN;
    if (!Number.isFinite(end)) return Infinity;
    return Math.max(0, (ref - end) / 60000);
  } catch (_) { return Infinity; }
}

/**
 * Toleransi keterlambatan per job (menit).
 * FASE V4-F02: Job harian malam dan pagi diatur ke 1560 menit (26 jam).
 */
function defaultToleranceMin(jobName) {
  const n = String(jobName || '').toLowerCase();
  if (n === 'watchdog' || n === 'security-monitor') return 10;
  if (/fastwatcher/.test(n)) return 15;
  if (/daytrade-producer/.test(n)) return 30;
  if (/sector-hot-intraday/.test(n)) return 30;
  if (/suspension-guard/.test(n)) return 30;

  // FASE V4-F02: 1560 menit (26 jam) untuk job harian malam dan pagi
  if (/broksum-1945|insider-tiered-2200|fundamental-refresh-2220|evening-brief-1700|morning-brief-0600/.test(n) ||
      /^(broksum|insider-tiered|fundamental-refresh|evening-brief|morning-brief|afternoon-recap)/.test(n) ||
      /daily-candles|ihsg-candle|lifecycle|market-context|sector-hot-eod|screeners-preflight|top5-radar|landing-snapshot|quota-burn|catchup/.test(n)) {
    return 1560;
  }

  return 1560;
}

function isOkHeartbeatStatus(status) {
  const s = String(status || '').toUpperCase();
  return s === 'OK' || s === 'LOCK_BUSY' || s === 'FORBIDDEN_WINDOW_SKIP' || s === 'SCHEDULED_SKIP';
}

function classifyHeartbeat(hb, nowMs, toleranceMin) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  if (!hb || typeof hb !== 'object') {
    return { key: 'heartbeat:unknown:missing', severity: 'critical', source: 'heartbeat', detail: 'heartbeat hilang/korup' };
  }
  const name = hb.jobName || hb.job || 'unknown';
  if (name === 'watchdog' || name === 'security-monitor') return null;

  const badExit = hb.exitCode !== 0 && !isOkHeartbeatStatus(hb.status);
  if (badExit) {
    return {
      key: 'heartbeat:' + name + ':exit',
      severity: 'critical',
      source: 'heartbeat',
      detail: name + ': exitCode=' + hb.exitCode + ' status=' + (hb.status || '?') + ' ' + String(hb.lastErrorSnippet || '').slice(0, 120)
    };
  }

  // Khusus daytrade-producer: di luar jam aktif (08:50 - 16:05 WIB hari kerja), jangan alarm basi
  if (name === 'daytrade-producer' && !isDaytradeProducerActive(new Date(now))) {
    return null;
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

function evaluateAll(opts) {
  const o = opts || {};
  const nowMs = o.now != null ? new Date(o.now).getTime() : Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const issues = [];

  // (a) heartbeat
  let heartbeats = o.heartbeats;
  if (!Array.isArray(heartbeats)) {
    const isProbe = (n) => /(-probe|-test|^p2-|-canary|-f\d+|\d{4})$/.test(String(n || ''));
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
    const jName = hb.jobName || hb.job;
    const tol = tolerances[jName] != null ? tolerances[jName] : (maxAgeFallback != null ? maxAgeFallback : defaultToleranceMin(jName));
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
  lines.push('🚨 [KRITIS/MERAH] WATCHDOG OPERASIONAL — ' + (result && result.issues ? result.issues.length : 0) + ' insiden KRITIS');
  lines.push('');
  lines.push('Waktu: ' + ((result && result.at) || new Date().toISOString()));
  lines.push(QUOTA_LABEL + ': ' + (result && result.quota ? ('dipakai ' + result.quota.used + '/' + result.quota.limit) : 'tidak terbaca'));
  lines.push('');
  for (const issue of (result && result.issues) || []) {
    lines.push('• [' + (issue.severity || 'CRITICAL').toUpperCase() + '/' + (issue.source || '?') + '] ' + (issue.detail || issue.key));
  }
  lines.push('');
  lines.push('Cek: pm2 jlist / tail log cron / data/heartbeats/*.json');
  return lines.join('\n');
}

/**
 * Pengirim Telegram khusus Watchdog.
 * FASE V4-F02: HANYA ke Chat ID pribadi Admin (6396446903).
 */
async function defaultTelegramSender(text) {
  const notifier = require(path.join(ROOT, 'lib', 'telegram-notifier'));
  return notifier.sendTelegramMessage(text, {
    chat_id: ADMIN_CHAT_ID,
    skip_market_guard: true
  });
}

/**
 * Filter dan kirim alert.
 * FASE V4-F02: HANYA kegagalan kritis (MERAH/CRITICAL/ERROR) yang boleh dikirim.
 * Status kuning/warning dan hijau mutlak disupresi jika tidak ada insiden kritis.
 */
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

  // FASE V4-F02: Periksa apakah ada insiden KRITIS (MERAH / CRITICAL / ERROR)
  const hasCritical = ((result.issues) || []).some((i) => {
    const sev = String(i.severity || '').toLowerCase();
    return sev === 'critical' || sev === 'merah' || sev === 'error' || sev === 'darurat';
  });

  // Jika TIDAK ADA insiden kritis sama sekali (hanya warning/kuning/info atau normal),
  // DILARANG mengirim alert Telegram (supresi total spam).
  if (!hasCritical) {
    if (changed || Object.keys(history).length > 0) writeSentHistory({}, historyPath);
    return {
      sent: 0,
      skipped: (result.issues || []).length,
      historyPath,
      suppressed: true,
      reason: 'no_critical_issues_suppressed'
    };
  }

  const fresh = [];
  for (const issue of (result.issues || [])) {
    const k = String(issue.key);
    const prev = history[k];
    if (prev && Number.isFinite(Number(prev.lastSentAt)) && (nowMs - Number(prev.lastSentAt)) < cooldownMs) {
      continue;
    }
    fresh.push(issue);
  }

  if (fresh.length === 0) {
    if (changed) writeSentHistory(history, historyPath);
    return { sent: 0, skipped: (result.issues || []).length, historyPath };
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
    return { sent: fresh.length, skipped: (result.issues || []).length - fresh.length, historyPath, result: res };
  }
  if (changed) writeSentHistory(history, historyPath);
  return { sent: 0, skipped: (result.issues || []).length, historyPath, result: res, sendFailed: true };
}

function auditHeartbeats() {
  try {
    const rec = require(path.join(ROOT, 'lib', 'heartbeat-recorder'));
    if (rec && typeof rec.auditAndCleanHeartbeats === 'function') {
      rec.auditAndCleanHeartbeats(PRIMARY_HEARTBEAT_DIR);
    }
  } catch (_) {}
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Audit dan bersihkan zombie/0-byte heartbeats saat watchdog dijalankan
  auditHeartbeats();

  for (const d of [PRIMARY_HEARTBEAT_DIR, SECONDARY_HEARTBEAT_DIR, LOCAL_LOGS, path.join(RUNNER_LOGS, 'cron'), ALERTS_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  }

  const result = evaluateAll({ now: Date.now(), maxAgeMin: opts.maxAgeMin, tolerances: null });
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
  ADMIN_CHAT_ID,
  ALERT_COOLDOWN_MS,
  QUOTA_LABEL,
  DAYTRADE_PRODUCER_START_WIB,
  DAYTRADE_PRODUCER_END_WIB,
  STATUS_PATH_DEFAULT,
  HISTORY_PATH_DEFAULT,
  PRIMARY_HEARTBEAT_DIR,
  SECONDARY_HEARTBEAT_DIR,
  parseArgs,
  listHeartbeats,
  readHeartbeat,
  ageMin,
  defaultToleranceMin,
  isDaytradeProducerActive,
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
  defaultTelegramSender,
  readQuotaSnapshot,
  readDaytradeInput,
  readPm2List,
  readDiskStats,
  auditHeartbeats,
  main
};
