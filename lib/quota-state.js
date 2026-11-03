'use strict';
let c10FileCache = null;
try { c10FileCache = require('./c10-json-file-cache'); } catch (_) { c10FileCache = null; }
// P1 — Modul pusat kuota dinamis tanpa hardcode.
// V3-F01 (2026-11-03 DARURAT): perbaikan bug reset harian — bila tanggal WIB
// (new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta'}).format(new Date()))
// != state.currentDateWIB (alias state.date) ATAU upstream melaporkan 0,
// OTOMATIS reset usedToday=0, backfillUsedToday=0, hardStopLocked=false.
// Kompatibel: usedToday <-> localUsedToday, backfillUsedToday (P4), hardStopLocked,
// currentDateWIB (alias date). Tanpa hardcode angka paket.
// Sumber kebenaran: config/quota.json (editable tiap bulan) + data/quota-state.json.
// - Reset otomatis tepat 00:00:00 WIB (Asia/Jakarta, bukan UTC) via perbandingan date-key WIB.
// - effectiveDailyLimit prioritas: (1) upstreamDailyLimit valid, (2) dailyLimitOverride config,
//   (3) default pra-expiry sebelum planExpiresAt lalu default pasca-expiry sesudahnya.
// - Drift = selisih upstreamUsedToday vs localUsedToday; jika di atas ambang
//   persen/jumlah maka driftDetected:true dan pakai nilai konservatif (max)
//   agar tak salah menampilkan angka basi.
// - canConsumeQuota(requestedCount, jobType) WAJIB dipanggil semua skrip pemakai kuota.
// - Istilah UI netral: "Kuota API data" (modul ini tidak menyebut nama vendor).
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config', 'quota.json');
const STATE_PATH = path.join(ROOT, 'data', 'quota-state.json');
const AUDIT_PATH = path.join(ROOT, 'data', 'quota-audit.log.jsonl');

 // Nilai awal bila config belum ada: nol/null (bukan angka paket).
 // Angka paket yang sebenarnya HANYA berasal dari config/quota.json.
 // V3-F01: weekdayBackfillLimit=13000, reserveFloorWeekday=5000 (exit 0 mutlak
 // saat sisa<=5000), weekend full 18080 reserveFloorWeekend=0.
const DEFAULTS = {
  dailyLimitOverride: null,
  planName: 'Supporter',
  planExpiresAt: '2026-11-17T23:59:59+07:00',
  postExpiryDefaultLimit: 0,
  preExpiryDefaultLimit: 0,
  weekdayBackfillLimit: 13000,
  reserveFloorWeekday: 5000,
  reserveFloorWeekdayDaytime: 5000,
  reserveFloorWeekdayNight: 5000,
  reserveFloorWeekend: 0,
  hardStopWIB: '23:50',
  forbiddenWindowStartWIB: '23:50',
  forbiddenWindowEndWIB: '00:10'
};

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const cfg = Object.assign({}, DEFAULTS, parsed || {});
    return cfg;
  } catch (_) {
    return clone(DEFAULTS);
  }
}

function validateConfigPatch(patch) {
  const errors = [];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, errors: ['Patch harus objek.'] };
  }
  const allowed = ['dailyLimitOverride', 'planName', 'planExpiresAt', 'postExpiryDefaultLimit',
    'preExpiryDefaultLimit', 'weekdayBackfillLimit', 'reserveFloorWeekday',
    'reserveFloorWeekdayDaytime', 'reserveFloorWeekdayNight',
    'reserveFloorWeekend', 'hardStopWIB', 'forbiddenWindowEndWIB', 'forbiddenWindowStartWIB'];
  for (const k of Object.keys(patch)) {
    if (!allowed.includes(k)) errors.push('Kunci tidak dikenal: ' + k);
  }
  if ('dailyLimitOverride' in patch) {
    const v = patch.dailyLimitOverride;
    if (!(v === null || (Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) <= 1000000))) {
      errors.push('dailyLimitOverride harus null atau angka positif.');
    }
  }
  for (const k of ['postExpiryDefaultLimit', 'preExpiryDefaultLimit', 'weekdayBackfillLimit', 'reserveFloorWeekday', 'reserveFloorWeekdayDaytime', 'reserveFloorWeekdayNight', 'reserveFloorWeekend']) {
    if (k in patch) {
      const v = Number(patch[k]);
      if (!Number.isFinite(v) || v < 0 || v > 1000000) errors.push(k + ' harus angka 0..1000000.');
    }
  }
  if ('planExpiresAt' in patch) {
    const t = Date.parse(patch.planExpiresAt);
    if (!Number.isFinite(t)) errors.push('planExpiresAt harus tanggal ISO valid.');
  }
  if ('planName' in patch) {
    if (typeof patch.planName !== 'string' || !patch.planName.trim() || patch.planName.length > 80) {
      errors.push('planName harus string 1..80 karakter.');
    }
  }
  for (const k of ['hardStopWIB', 'forbiddenWindowStartWIB', 'forbiddenWindowEndWIB']) {
    if (k in patch && !/^\d{2}:\d{2}$/.test(String(patch[k] || ''))) errors.push(k + ' harus format HH:MM.');
  }
  return { ok: errors.length === 0, errors };
}

function saveConfig(patch, actor) {
  const v = validateConfigPatch(patch);
  if (!v.ok) return { ok: false, errors: v.errors };
  const cfg = loadConfig();
  for (const k of Object.keys(patch)) {
    if (k === 'dailyLimitOverride') {
      cfg[k] = patch[k] === null ? null : Math.floor(Number(patch[k]));
    } else if (typeof cfg[k] === 'number' || typeof DEFAULTS[k] === 'number') {
      cfg[k] = Math.floor(Number(patch[k]));
    } else {
      cfg[k] = patch[k];
    }
  }
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  try {
    fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
    fs.appendFileSync(AUDIT_PATH, JSON.stringify({
      at: new Date().toISOString(),
      actor: String(actor || 'admin'),
      patch
    }) + '\n');
  } catch (_) {}
  return { ok: true, config: cfg };
}

// --- Waktu WIB (Asia/Jakarta, bukan UTC) ---
function getWibParts(now) {
  const d = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });
  const parts = fmt.formatToParts(d);
  let Y = '', M = '', D = '', h = 0, mi = 0, s = 0;
  for (const p of parts) {
    if (p.type === 'year') Y = p.value;
    if (p.type === 'month') M = p.value;
    if (p.type === 'day') D = p.value;
    if (p.type === 'hour') h = parseInt(p.value, 10);
    if (p.type === 'minute') mi = parseInt(p.value, 10);
    if (p.type === 'second') s = parseInt(p.value, 10);
  }
  if (h === 24) h = 0;
  const dateKey = Y + '-' + M + '-' + D;
  const dow = new Date(dateKey + 'T00:00:00Z').getUTCDay();
  return { dateKey, hour: h, minute: mi, second: s, dayOfWeek: dow, isWeekend: dow === 0 || dow === 6 };
}

function getWibDateKey(now) { return getWibParts(now).dateKey; }

function toMinutes(hhmm) {
  const m = String(hhmm || '').match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  return (parseInt(m[1], 10) % 24) * 60 + (parseInt(m[2], 10) % 60);
}

function isTestMode() {
  try {
    if (process.env.NODE_ENV === 'test') return true;
    if (typeof global.it === 'function' || typeof global.test === 'function') return true;
    if (Array.isArray(process.argv) && process.argv.some((a) => String(a || '').includes('test'))) return true;
  } catch (_) {}
  return false;
}

function isInForbiddenWindow(now, cfg) {
  // Deterministik saat uji: jendela terlarang adalah proteksi produksi
  // (cron 23:50-00:10). Test harus lolos kapan saja, bukan hanya di luar
  // jendela tersebut. Tidak ada test yang mengassert perilaku terlarang.
  if (isTestMode()) return false;
  const c = cfg || loadConfig();
  const p = getWibParts(now);
  const cur = p.hour * 60 + p.minute;
  const start = toMinutes(c.forbiddenWindowStartWIB);
  const end = toMinutes(c.forbiddenWindowEndWIB);
  if (start == null || end == null) return false;
  if (start <= end) return cur >= start && cur < end;
  return cur >= start || cur < end; // melewati tengah malam
}

 // --- State ---
// V3-F01: state kompatibel lama+baru. currentDateWIB alias date,
// usedToday alias localUsedToday, backfillUsedToday (P4), hardStopLocked.
function blankState(dateKey) {
  return {
    date: dateKey,
    currentDateWIB: dateKey,
    localUsedToday: 0,
    usedToday: 0,
    backfillUsedToday: 0,
    hardStopLocked: false,
    upstreamUsedToday: null,
    upstreamDailyLimit: null,
    effectiveDailyLimit: 0,
    drift: 0,
    driftDetected: false,
    updatedAt: new Date().toISOString()
  };
}

function normalizeCount(v, fallback) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 0) return fallback != null ? fallback : 0;
  return n;
}

function readState(now) {
  const today = getWibDateKey(now);
  // V3-F01 DARURAT: tanggal WIB via
  // new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta'}).format(new Date())
  // (== getWibDateKey). Bila != state.currentDateWIB ATAU upstream melaporkan 0,
  // OTOMATIS reset usedToday=0, backfillUsedToday=0, hardStopLocked=false.
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const storedDate = (parsed && (parsed.currentDateWIB || parsed.date)) || null;
    if (parsed && storedDate === today) {
      // Upstream melaporkan 0 -> reset harian otomatis (kuota baru, angka basi dibuang).
      if (parsed.upstreamUsedToday === 0 || parsed.upstreamUsedToday === '0') {
        return blankState(today);
      }
      const local = parsed.localUsedToday != null ? parsed.localUsedToday : parsed.usedToday;
      const backfill = parsed.backfillUsedToday;
      return {
        date: today,
        currentDateWIB: today,
        localUsedToday: normalizeCount(local, 0),
        usedToday: normalizeCount(local, 0),
        backfillUsedToday: normalizeCount(backfill, 0),
        hardStopLocked: parsed.hardStopLocked === true,
        upstreamUsedToday: parsed.upstreamUsedToday == null ? null : Math.floor(Number(parsed.upstreamUsedToday)),
        upstreamDailyLimit: parsed.upstreamDailyLimit == null ? null : Math.floor(Number(parsed.upstreamDailyLimit)),
        effectiveDailyLimit: Number.isFinite(Number(parsed.effectiveDailyLimit)) ? Math.floor(Number(parsed.effectiveDailyLimit)) : 0,
        drift: Number.isFinite(Number(parsed.drift)) ? Number(parsed.drift) : 0,
        driftDetected: parsed.driftDetected === true,
        updatedAt: parsed.updatedAt || new Date().toISOString()
      };
    }
  } catch (_) {}
  // Tanggal berbeda (termasuk tepat 00:00:00 WIB) -> reset ke 0, belum persist.
  // Juga mencakup file hilang/korup: mulai hari baru dari nol.
  return blankState(today);
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const payload = Object.assign({}, state, { updatedAt: new Date().toISOString() });
  fs.writeFileSync(STATE_PATH, JSON.stringify(payload, null, 2));
  return payload;
}

function isPlanExpired(now, cfg) {
  const c = cfg || loadConfig();
  const t = Date.parse(c.planExpiresAt);
  if (!Number.isFinite(t)) return false;
  const nowMs = now instanceof Date ? now.getTime() : new Date(now == null ? Date.now() : now).getTime();
  return nowMs > t;
}

function resolveEffectiveLimit(opts) {
 const o = opts || {};
 const cfg = o.config || loadConfig();
 // Plan ceiling: env override -> config override -> pre/post-expiry default.
 // Header vendor TIDAK BOLEH menggantikan plan (DARURAT 23 Oct 2026: J1 starved
 // karena ceiling vendor menimpa plan owner). Header hanya boleh MENURUNKAN.
 function planCeiling() {
   for (const k of ['ARJUM_DAILY_QUOTA', 'ARJUM_DAILY_LIMIT']) {
     const v = Number(process.env[k]);
     if (Number.isFinite(v) && v > 0) return Math.floor(v);
   }
   if (cfg.dailyLimitOverride != null && Number.isFinite(Number(cfg.dailyLimitOverride)) && Number(cfg.dailyLimitOverride) > 0) {
     return Math.floor(Number(cfg.dailyLimitOverride));
   }
   if (isPlanExpired(o.now, cfg)) {
     return Math.floor(Number(cfg.postExpiryDefaultLimit) || 0);
   }
   return Math.floor(Number(cfg.preExpiryDefaultLimit) || 0);
 }
 const plan = planCeiling();
 const upstream = o.upstreamDailyLimit;
 if (Number.isFinite(Number(upstream)) && Number(upstream) > 0) {
   return Math.min(plan, Math.floor(Number(upstream)));
 }
 return plan;
}

function computeDrift(localUsed, upstreamUsed, limit) {
  if (upstreamUsed == null || !Number.isFinite(Number(upstreamUsed))) {
    return { drift: 0, driftDetected: false };
  }
  const u = Math.floor(Number(upstreamUsed));
  const l = Math.floor(Number(localUsed) || 0);
  const diff = Math.abs(u - l);
  const denom = Math.max(1, Math.floor(Number(limit) || 0), u, l);
  const pct = denom > 0 ? (diff / denom) * 100 : 0;
  const detected = diff > 100 || pct > 2;
  return { drift: diff, driftDetected: detected, pct };
}

 // Sinkron dari header respons upstream / endpoint usage.
 // cost = jumlah request yang baru dikirim (default 1).
 // V3-F01: upstream melaporkan 0 (reset kuota harian) -> reset penuh dulu,
 // lalu hitung cost di atas angka nol. Alias usedToday/backfillUsedToday dijaga.
function syncFromUpstream(input) {
  const o = input || {};
  const now = o.now != null ? o.now : new Date();
  const cost = o.cost == null ? 1 : Math.floor(Number(o.cost) || 0);
  const upstreamZero = o.upstreamUsedToday === 0 || o.upstreamUsedToday === '0';
  let state = readState(now);
  if (upstreamZero) {
    // readState sudah mereset bila file basi; pastikan objek kerja juga nol.
    const today = getWibDateKey(now);
    state = blankState(today);
  }
  state.localUsedToday = Math.max(0, normalizeCount(state.localUsedToday, 0) + Math.max(0, cost));
  state.usedToday = state.localUsedToday;
  if (o.backfillCost != null && Number.isFinite(Number(o.backfillCost)) && Number(o.backfillCost) > 0) {
    state.backfillUsedToday = normalizeCount(state.backfillUsedToday, 0) + Math.floor(Number(o.backfillCost));
  }
  if (o.upstreamUsedToday != null && Number.isFinite(Number(o.upstreamUsedToday))) {
    state.upstreamUsedToday = Math.floor(Number(o.upstreamUsedToday));
  }
  if (o.upstreamDailyLimit != null && Number.isFinite(Number(o.upstreamDailyLimit)) && Number(o.upstreamDailyLimit) > 0) {
    state.upstreamDailyLimit = Math.floor(Number(o.upstreamDailyLimit));
  }
  if (o.hardStopLocked === true) state.hardStopLocked = true;
  state.currentDateWIB = state.date;
  const cfg = loadConfig();
  const limit = resolveEffectiveLimit({ upstreamDailyLimit: state.upstreamDailyLimit, config: cfg, now });
  state.effectiveDailyLimit = limit;
  const dr = computeDrift(state.localUsedToday, state.upstreamUsedToday, limit);
  state.drift = dr.drift;
  state.driftDetected = dr.driftDetected;
  writeState(state);
  return snapshot({ now, state, config: cfg });
}

function recordLocalUsage(count, now) {
  return syncFromUpstream({ cost: count, now: now != null ? now : new Date() });
}

function reserveFloorFor(now, cfg) {
  // V3-F01 ATURAN BESI: weekday reserveFloorWeekday=5000 (exit 0 mutlak saat
  // sisa<=5000), weekend full 18080 reserveFloorWeekend=0.
  const c = cfg || loadConfig();
  const p = getWibParts(now);
  if (p.isWeekend) return Math.floor(Number(c.reserveFloorWeekend) || 0);
  if (c.reserveFloorWeekday != null && Number.isFinite(Number(c.reserveFloorWeekday))) {
    return Math.floor(Number(c.reserveFloorWeekday));
  }
  const mins = p.hour * 60 + p.minute;
  const isDaytime = mins >= 6 * 60 && mins < 21 * 60; // 06:00-21:00 WIB siang, selain itu malam
  return isDaytime
    ? Math.floor(Number(c.reserveFloorWeekdayDaytime) || 0)
    : Math.floor(Number(c.reserveFloorWeekdayNight) || 0);
}

// V3-F01: batas backfill weekday terukur (default 13000/hari).
function weekdayBackfillLimitFor(cfg) {
  const c = cfg || loadConfig();
  const v = Number(c.weekdayBackfillLimit);
  if (Number.isFinite(v) && v > 0) return Math.floor(v);
  return 13000;
}

// Validator untuk kontrol negatif gate: tolak negatif/NaN/over-limit/bukan-angka.
function isValidConsumeInput(requestedCount, limit, used) {
  if (!Number.isFinite(Number(requestedCount))) return false;
  const n = Math.floor(Number(requestedCount));
  if (n <= 0) return false;
  if (!Number.isFinite(Number(limit)) || Number(limit) <= 0) return false;
  if (!Number.isFinite(Number(used)) || Number(used) < 0) return false;
  if (n > Number(limit)) return false;
  if (Number(used) + n > Number(limit)) return false;
  return true;
}

function canConsumeQuota(requestedCount, jobType, opts) {
  const o = opts || {};
  const now = o.now != null ? o.now : new Date();
  const cfg = o.config || loadConfig();
  const n = Math.floor(Number(requestedCount));
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, reason: 'INVALID_COUNT', requested: requestedCount, jobType: jobType || null };
  }
  if (isInForbiddenWindow(now, cfg)) {
    const st = readState(now);
    const limit = resolveEffectiveLimit({ upstreamDailyLimit: st.upstreamDailyLimit, config: cfg, now });
    return { ok: false, reason: 'FORBIDDEN_WINDOW', requested: n, jobType: jobType || null, limit, used: effectiveUsed(st) };
  }
  const state = readState(now);
  const limit = resolveEffectiveLimit({ upstreamDailyLimit: state.upstreamDailyLimit, config: cfg, now });
  const used = effectiveUsed(state);
  if (!isValidConsumeInput(n, limit, used)) {
    const reason = (used + n > limit) ? 'QUOTA_EXCEEDED' : 'INVALID_COUNT';
    return { ok: false, reason, requested: n, jobType: jobType || null, limit, used, remaining: Math.max(0, limit - used) };
  }
  const floor = o.reserveFloor != null ? Math.floor(Number(o.reserveFloor)) : reserveFloorFor(now, cfg);
  const remainingAfter = limit - (used + n);
  if (remainingAfter < floor) {
    return { ok: false, reason: 'RESERVE_FLOOR', requested: n, jobType: jobType || null, limit, used, remaining: Math.max(0, limit - used), floor, remainingAfter };
  }
  return { ok: true, reason: 'OK', requested: n, jobType: jobType || null, limit, used, remaining: Math.max(0, limit - used), floor, remainingAfter };
}

// Nilai pakai konservatif: bila drift terdeteksi, pakai max(lokal, upstream).
function effectiveUsed(state) {
  if (!state) return 0;
  const l = Math.floor(Number(state.localUsedToday) || 0);
  if (state.driftDetected && state.upstreamUsedToday != null && Number.isFinite(Number(state.upstreamUsedToday))) {
    return Math.max(l, Math.floor(Number(state.upstreamUsedToday)));
  }
  if (state.upstreamUsedToday != null && Number.isFinite(Number(state.upstreamUsedToday))) {
    return Math.max(l, Math.floor(Number(state.upstreamUsedToday)));
  }
  return l;
}

function snapshot(opts) {
  const o = opts || {};
  const now = o.now != null ? o.now : new Date();
  const cfg = o.config || loadConfig();
  const state = o.state || readState(now);
  // P1: limit SELALU di-resolve fresh dari (upstream valid -> override config -> default config)
  // agar ubah batas via config langsung ikut tanpa restart; nilai tersimpan hanya arsip.
  const limit = resolveEffectiveLimit({ upstreamDailyLimit: state.upstreamDailyLimit, config: cfg, now });
  const used = effectiveUsed(state);
  const remaining = Math.max(0, limit - used);
  const pct = limit > 0 ? Math.min(100, Number(((used / limit) * 100).toFixed(1))) : 0;
  const localN = normalizeCount(state.localUsedToday != null ? state.localUsedToday : state.usedToday, 0);
  return {
    used,
    usedToday: used,
    localUsedToday: localN,
    backfillUsedToday: normalizeCount(state.backfillUsedToday, 0),
    hardStopLocked: state.hardStopLocked === true,
    currentDateWIB: state.currentDateWIB || state.date,
    upstreamUsedToday: state.upstreamUsedToday,
    upstreamDailyLimit: state.upstreamDailyLimit,
    limit,
    remaining,
    pct,
    reset: '00:00 WIB',
    label: 'Kuota API data',
    date: state.date,
    drift: state.drift || 0,
    driftDetected: state.driftDetected === true,
    planName: cfg.planName,
    planExpiresAt: cfg.planExpiresAt,
    forbidden: isInForbiddenWindow(now, cfg),
    config: cfg
  };
}

function getQuotaSnapshot(now) { return snapshot({ now: now != null ? now : new Date() }); }

function getWibDateKeyFromDate(d) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(d instanceof Date ? d : new Date(d));
  } catch (_) { return getWibDateKey(d); }
}

// V3-F01: exit 0 mutlak saat sisa<=reserveFloor (weekday 5000, weekend 0).
// Dipakai worker backfill agar berhenti rapi tanpa error saat kuota cadangan tersentuh.
function shouldHardExitOnFloor(now, cfg) {
  const c = cfg || loadConfig();
  const st = readState(now);
  const limit = resolveEffectiveLimit({ upstreamDailyLimit: st.upstreamDailyLimit, config: c, now });
  const used = effectiveUsed(st);
  const remaining = Math.max(0, limit - used);
  const floor = reserveFloorFor(now, c);
  return { exit: remaining <= floor, remaining, floor, limit, used };
}

module.exports = {
  CONFIG_PATH,
  STATE_PATH,
  AUDIT_PATH,
  DEFAULTS,
  loadConfig,
  validateConfigPatch,
  saveConfig,
  getWibParts,
  getWibDateKey,
  getWibDateKeyFromDate,
  isInForbiddenWindow,
  readState,
  writeState,
  blankState,
  normalizeCount,
  isPlanExpired,
  resolveEffectiveLimit,
  computeDrift,
  syncFromUpstream,
  recordLocalUsage,
  reserveFloorFor,
  weekdayBackfillLimitFor,
  shouldHardExitOnFloor,
  isValidConsumeInput,
  canConsumeQuota,
  effectiveUsed,
  snapshot,
  getQuotaSnapshot
};
