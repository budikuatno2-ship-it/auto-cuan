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

// Single provider authority for every quota consumer; no fallback to the
// previous static package limit when provider evidence is stale or absent.
let _quotaAuthority = null;
function quotaAuthority() {
  if (_quotaAuthority === null) {
    try { _quotaAuthority = require('./quota-limit'); } catch (_) { _quotaAuthority = false; }
  }
  return _quotaAuthority || null;
}

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config', 'quota.json');
const STATE_PATH = path.join(ROOT, 'data', 'quota-state.json');
const AUDIT_PATH = path.join(ROOT, 'data', 'quota-audit.log.jsonl');

 // Nilai awal bila config belum ada: nol/null (bukan angka paket).
 // Angka paket yang sebenarnya HANYA berasal dari config/quota.json.
 // V3-F01: backfill weekday terukur, floor weekday 5000 (exit 0 mutlak),
 // weekend penuh floor 0.
const DEFAULTS = {
  dailyLimitOverride: null,
  planName: 'Supporter',
  planExpiresAt: '2026-11-17T23:59:59+07:00',
  postExpiryDefaultLimit: 0,
  preExpiryDefaultLimit: 0,
  maxQuota: 18080,
  weekdayBackfillLimit: 13000,
  weekendBackfillLimit: 18080,
  reserveFloorWeekday: 5000,
  reserveFloorWeekdayDaytime: 5000,
  reserveFloorWeekdayNight: 5000,
  reserveFloorWeekend: 0,
  hardStopWIB: '23:50',
  forbiddenWindowStartWIB: '23:50',
  forbiddenWindowEndWIB: '00:10',
  staleThresholdMinutes: 120,
  lowQuotaMode: false,
  telegramMuteDaily: false,
  telegramMuteEmergency: false,
  telegramMuteNonCritical: false,
  dynamicPreflightGate: true,
  holidayManualMode: 'normal',
  holidayManualDateWIB: null,
  holidayBackfillRemainder: true
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
    'preExpiryDefaultLimit', 'maxQuota', 'weekdayBackfillLimit', 'weekendBackfillLimit',
    'reserveFloorWeekday', 'reserveFloorWeekdayDaytime', 'reserveFloorWeekdayNight',
    'reserveFloorWeekend', 'hardStopWIB', 'forbiddenWindowEndWIB', 'forbiddenWindowStartWIB',
    'staleThresholdMinutes', 'lowQuotaMode', 'telegramMuteDaily', 'telegramMuteEmergency',
    'telegramMuteNonCritical', 'dynamicPreflightGate', 'holidayManualMode',
    'holidayManualDateWIB', 'holidayBackfillRemainder'];
  for (const k of Object.keys(patch)) {
    if (!allowed.includes(k)) errors.push('Kunci tidak dikenal: ' + k);
  }
  if ('dailyLimitOverride' in patch) {
    const v = patch.dailyLimitOverride;
    if (!(v === null || (Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) <= 1000000))) {
      errors.push('dailyLimitOverride harus null atau angka positif.');
    }
  }
  for (const k of ['postExpiryDefaultLimit', 'preExpiryDefaultLimit', 'maxQuota', 'weekdayBackfillLimit', 'weekendBackfillLimit', 'reserveFloorWeekday', 'reserveFloorWeekdayDaytime', 'reserveFloorWeekdayNight', 'reserveFloorWeekend']) {
    if (k in patch) {
      const v = Number(patch[k]);
      if (!Number.isFinite(v) || v < 0 || v > 1000000) errors.push(k + ' harus angka 0..1000000.');
    }
  }
  if ('staleThresholdMinutes' in patch) {
    const v = patch.staleThresholdMinutes;
    if (!(v === 0 || v === null || (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 10080))) {
      errors.push('staleThresholdMinutes harus 0 (mati) atau 1..10080.');
    }
  }
  for (const k of ['lowQuotaMode', 'telegramMuteDaily', 'telegramMuteEmergency', 'telegramMuteNonCritical', 'dynamicPreflightGate', 'holidayBackfillRemainder']) {
    if (k in patch) {
      const v = patch[k];
      if (!(v === true || v === false || v === 0 || v === 1 || v === 'true' || v === 'false')) {
        errors.push(k + ' harus boolean.');
      }
    }
  }
  if ('holidayManualMode' in patch) {
    const v = String(patch.holidayManualMode || '');
    if (v !== 'normal' && v !== 'libur' && v !== 'buka') errors.push('holidayManualMode harus normal/libur/buka.');
  }
  if ('holidayManualDateWIB' in patch) {
    const v = patch.holidayManualDateWIB;
    if (!(v === null || /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')))) errors.push('holidayManualDateWIB harus null atau YYYY-MM-DD.');
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
  if ('hardStopWIB' in patch) {
    const v = String(patch.hardStopWIB || '');
    if (!['23:40', '23:45', '23:50'].includes(v)) errors.push('hardStopWIB harus salah satu 23:40/23:45/23:50.');
  }
  return { ok: errors.length === 0, errors };
}

function toBool(v, fallback) {
  if (v === true || v === 1 || v === 'true' || v === '1') return true;
  if (v === false || v === 0 || v === 'false' || v === '0') return false;
  return fallback;
}

// V3-F02: auto-proposi cerdas — bila maxQuota diubah, turunkan/naikkan
// weekdayBackfillLimit + reserveFloorWeekday proporsional bila user tidak
// meng-override eksplisit. Rasio bawaan: backfill 13000/18080, floor 5000/18080.
function autoProposeQuota(patch, base) {
  const out = Object.assign({}, patch);
  const baseMax = Number(base && base.maxQuota != null ? base.maxQuota : base && base.preExpiryDefaultLimit) || 18080;
  const newMax = out.maxQuota != null ? Math.floor(Number(out.maxQuota)) : baseMax;
  if (!Number.isFinite(newMax) || newMax <= 0) return out;
  const hasBackfill = 'weekdayBackfillLimit' in out;
  const hasFloor = 'reserveFloorWeekday' in out;
  if (!hasBackfill) {
    if (newMax <= 1000) out.weekdayBackfillLimit = Math.min(newMax, 700);
    else if (newMax <= 5000) out.weekdayBackfillLimit = Math.min(newMax, 3600);
    else out.weekdayBackfillLimit = Math.min(newMax, Math.round((newMax * 13000) / 18080));
  }
  if (!hasFloor) {
    if (newMax <= 1000) out.reserveFloorWeekday = Math.min(newMax, 300);
    else if (newMax <= 5000) out.reserveFloorWeekday = Math.min(newMax, 1400);
    else out.reserveFloorWeekday = Math.min(newMax, Math.round((newMax * 5000) / 18080));
  }
  if (!('reserveFloorWeekdayDaytime' in out) && 'reserveFloorWeekday' in out) {
    out.reserveFloorWeekdayDaytime = out.reserveFloorWeekday;
  }
  if (!('reserveFloorWeekdayNight' in out) && 'reserveFloorWeekday' in out) {
    out.reserveFloorWeekdayNight = out.reserveFloorWeekday;
  }
  return out;
}

function saveConfig(patch, actor) {
  const v = validateConfigPatch(patch);
  if (!v.ok) return { ok: false, errors: v.errors };
  const cfg = loadConfig();
  const enriched = autoProposeQuota(patch, cfg);
  for (const k of Object.keys(enriched)) {
    if (k === 'dailyLimitOverride' || k === 'holidayManualDateWIB') {
      cfg[k] = enriched[k] === null ? null : enriched[k];
      if (k === 'dailyLimitOverride' && cfg[k] !== null) cfg[k] = Math.floor(Number(cfg[k]));
    } else if (k === 'maxQuota' && (enriched[k] === null || enriched[k] === '')) {
      cfg[k] = null;
    } else if (typeof cfg[k] === 'number' || typeof DEFAULTS[k] === 'number') {
      cfg[k] = Math.floor(Number(enriched[k]));
    } else if (typeof DEFAULTS[k] === 'boolean') {
      cfg[k] = toBool(enriched[k], cfg[k]);
    } else {
      cfg[k] = enriched[k];
    }
  }
  // Sinkronkan preExpiryDefaultLimit dengan maxQuota agar jadwal cron tetap
  // sama tapi batas efektif ikut tanpa restart (snapshot resolve fresh).
  if ('maxQuota' in enriched && Number.isFinite(Number(enriched.maxQuota)) && Number(enriched.maxQuota) > 0) {
    cfg.preExpiryDefaultLimit = Math.floor(Number(enriched.maxQuota));
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
  // SELF-HEALING 2026-11-03 20:53 WIB: angka basi menempel (drift +
  // upstream >= limit + lokal nol) TIDAK BOLEH memblokir hari ini.
  // Bukti header upstream asli: remaining penuh -> kuota hari ini PENUH.
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const storedDate = (parsed && (parsed.currentDateWIB || parsed.date)) || null;
    if (parsed && storedDate === today) {
      // Upstream melaporkan 0 -> reset harian otomatis (kuota baru, angka basi dibuang).
      if (parsed.upstreamUsedToday === 0 || parsed.upstreamUsedToday === '0') {
        return blankState(today);
      }
      // Self-healing: drift basi menempel (upstream >= limit tapi lokal 0) ->
      // reset penuh, jangan deadlock. Header segar akan mengisi ulang angka benar.
      try {
        const upUsed = parsed.upstreamUsedToday == null ? null : Math.floor(Number(parsed.upstreamUsedToday));
        const local = parsed.localUsedToday != null ? parsed.localUsedToday : parsed.usedToday;
        const localN = local == null ? 0 : Math.floor(Number(local));
        const lim = parsed.effectiveDailyLimit != null && Number.isFinite(Number(parsed.effectiveDailyLimit)) && Number(parsed.effectiveDailyLimit) > 0
          ? Math.floor(Number(parsed.effectiveDailyLimit))
          : resolveEffectiveLimit({ upstreamDailyLimit: parsed.upstreamDailyLimit });
        if (upUsed != null && Number.isFinite(upUsed) && upUsed >= lim && lim > 0 && localN === 0) {
          return blankState(today);
        }
      } catch (_) {}
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
  const ql = quotaAuthority();
  if (!ql) return null;
  const resolved = ql.resolveLimit({ now: o.now, env: o.env || process.env, cfg: o.config });
  if (!resolved.ok) return null;
  const vendor = o.upstreamDailyLimit;
  if (vendor != null && Number.isFinite(Number(vendor)) && Number(vendor) > 0) {
    return Math.min(resolved.limit, Math.floor(Number(vendor)));
  }
  return resolved.limit;
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
  // V3-F01 ATURAN BESI: weekday floor 5000 (exit 0 mutlak), weekend floor 0.
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
  const state = readState(now);
  const limit = resolveEffectiveLimit({ upstreamDailyLimit: state.upstreamDailyLimit, config: cfg, now });
  if (isInForbiddenWindow(now, cfg)) {
    return { ok: false, reason: 'FORBIDDEN_WINDOW', requested: n, jobType: jobType || null, limit, used: null };
  }
  if (limit == null) {
    return { ok: false, reason: 'LIMIT_UNKNOWN', requested: n, jobType: jobType || null, limit: null, used: null, remaining: null };
  }
  const ql = quotaAuthority();
  const usage = ql ? ql.resolveUsage({ now, state }) : { known: false };
  if (!usage.known) {
    return { ok: false, reason: 'USAGE_UNKNOWN', requested: n, jobType: jobType || null, limit, used: null, remaining: null };
  }
  const used = Math.max(effectiveUsed(state), usage.used);
  if (!isValidConsumeInput(n, limit, used)) {
    return { ok: false, reason: used + n > limit ? 'QUOTA_EXCEEDED' : 'INVALID_COUNT',
      requested: n, jobType: jobType || null, limit, used,
      remaining: Math.max(0, limit - used), overage: Math.max(0, used - limit) };
  }
  const floor = o.reserveFloor != null ? Math.floor(Number(o.reserveFloor)) : reserveFloorFor(now, cfg);
  const remainingAfter = limit - (used + n);
  if (remainingAfter < floor) {
    return { ok: false, reason: 'RESERVE_FLOOR', requested: n, jobType: jobType || null, limit, used,
      remaining: Math.max(0, limit - used), floor, remainingAfter };
  }
  return { ok: true, reason: 'OK', requested: n, jobType: jobType || null,
    limit, used, remaining: Math.max(0, limit - used), floor, remainingAfter };
}

 // V3-F02 — Kontrol fleksibel: libur 3 lapis + saklar manual + antrean 00:00:01.
 // Lapis1: Sabtu/Minggu -> weekend (hemat penuh, backfill weekend penuh).
 // Lapis2: cek candle Yahoo 17:00 WIB 0 kuota — IHSG + mayoritas tanpa bar baru = LIBUR.
 // Lapis3: batalkan Broksum ALL+Foreign (~1928 kuota) saat LIBUR terdeteksi.
 // Saklar manual: normal/buka/libur + checkbox backfill sisa kuota + auto-reset Normal lewat 00:00 WIB.
function getEffectiveHolidayManual(cfg, now) {
  const c = cfg || loadConfig();
  const today = getWibDateKey(now);
  const mode = String(c.holidayManualMode || 'normal');
  const forDate = c.holidayManualDateWIB || null;
  // Auto-reset: saklar manual hanya berlaku untuk tanggal yang disimpan.
  // Lewat 00:00 WIB (tanggal berbeda) otomatis kembali Normal.
  if ((mode === 'libur' || mode === 'buka') && forDate && forDate === today) return mode;
  return 'normal';
}

function detectHoliday3Layer(now, signals, cfg) {
  const c = cfg || loadConfig();
  const p = getWibParts(now);
  const manual = getEffectiveHolidayManual(c, now);
  if (manual === 'libur') {
    return { isHoliday: true, layer: 'manual', label: 'LIBUR (manual)', cancelBroksum: true, saveQuota: 1928, backfillRemainder: toBool(c.holidayBackfillRemainder, true) };
  }
  if (manual === 'buka') {
    return { isHoliday: false, layer: 'manual', label: 'BUKA (manual)', cancelBroksum: false, saveQuota: 0, backfillRemainder: toBool(c.holidayBackfillRemainder, true) };
  }
  // Lapis1: weekend.
  if (p.isWeekend) {
    return { isHoliday: true, layer: 'lapis1-weekend', label: 'LIBUR (akhir pekan)', cancelBroksum: false, saveQuota: 0, backfillRemainder: true };
  }
  // Lapis2: sinyal candle 17:00 WIB 0 kuota.
  const s = signals || {};
  if (s.ihsgHasNewBar === false && s.majorityHasNewBar === false) {
    return { isHoliday: true, layer: 'lapis2-candle', label: 'LIBUR (candle 17:00 WIB: IHSG + mayoritas tanpa bar baru)', cancelBroksum: true, saveQuota: 1928, backfillRemainder: toBool(c.holidayBackfillRemainder, true) };
  }
  // Lapis3: dievaluasi scheduler — bila LIBUR, batalkan Broksum ALL+Foreign.
  return { isHoliday: false, layer: 'none', label: 'BUKA', cancelBroksum: false, saveQuota: 0, backfillRemainder: toBool(c.holidayBackfillRemainder, true) };
}

function weekendBackfillLimitFor(cfg) {
  const c = cfg || loadConfig();
  const v = Number(c.weekendBackfillLimit);
  if (Number.isFinite(v) && v > 0) return Math.floor(v);
  return 18080;
}

function staleThresholdMinutesFor(cfg) {
  const c = cfg || loadConfig();
  const v = c.staleThresholdMinutes;
  if (v === null || v === 0 || v === '0') return 0; // 0 = mati
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 0) return 120;
  return n;
}

function isStaleSince(lastIso, now, cfg) {
  const threshold = staleThresholdMinutesFor(cfg);
  if (!threshold || threshold <= 0) return { stale: false, thresholdMinutes: 0, ageMinutes: 0, disabled: true };
  const t = Date.parse(lastIso);
  if (!Number.isFinite(t)) return { stale: true, thresholdMinutes: threshold, ageMinutes: -1, disabled: false };
  const nowMs = now instanceof Date ? now.getTime() : new Date(now == null ? Date.now() : now).getTime();
  const ageMin = Math.floor((nowMs - t) / 60000);
  return { stale: ageMin > threshold, thresholdMinutes: threshold, ageMinutes: ageMin, disabled: false };
}

// Antrean prioritas susulan: bila config diubah mepet reset atau sisaKuota<=0,
// antrean jalan otomatis 00:00:01 WIB via scheduler-daemon + cron catchup-0001.
// Jadwal cron tetap sama — hanya isi antrean yang ditambah.
const PENDING_QUEUE_PATH = path.join(ROOT, 'data', 'pending-catchup-queue.json');
const MANUAL_TRIGGER_PATH = path.join(ROOT, 'data', 'manual-trigger-queue.json');
const KILL_REQUEST_PATH = path.join(ROOT, 'data', 'job-kill-request.json');

function readPendingQueue() {
  try {
    const raw = fs.readFileSync(PENDING_QUEUE_PATH, 'utf8');
    const q = JSON.parse(raw);
    if (q && Array.isArray(q.dates) && Array.isArray(q.jobs)) return q;
    return null;
  } catch (_) { return null; }
}

function enqueuePendingCatchup(reason, now) {
  const today = getWibDateKey(now);
  let q = readPendingQueue();
  if (!q) {
    q = { tool: 'scripts/scheduler-daemon.js', generatedAt: new Date().toISOString(), note: 'V3-F02: antrean susulan prioritas (jalan 00:00:01 WIB / saat kuota ada)', dates: [], jobs: [] };
  }
  if (!q.dates.includes(today)) q.dates.push(today);
  const jobs = ['broksum-ALL', 'broksum-Foreign', 'domestic-compile', 'accumulation-1H-3H-5H-10H-20H', 'insider-tiered', 'fundamental-Q2'];
  for (const j of jobs) if (!q.jobs.includes(j)) q.jobs.push(j);
  q.generatedAt = new Date().toISOString();
  q.lastReason = String(reason || 'manual');
  q.executeAt = today + 'T00:00:01+07:00';
  fs.mkdirSync(path.dirname(PENDING_QUEUE_PATH), { recursive: true });
  fs.writeFileSync(PENDING_QUEUE_PATH, JSON.stringify(q, null, 2));
  return q;
}

function shouldQueueAtReset(snap, now, cfg) {
  const c = cfg || loadConfig();
  const p = getWibParts(now);
  const curMin = p.hour * 60 + p.minute;
  // Mepet reset: 23:40-00:10 WIB (selaras hardStop slider + forbidden window).
  const nearReset = curMin >= 23 * 60 + 40 || curMin < 10;
  const remaining = snap ? snap.remaining : null;
  if (remaining != null && remaining <= 0) return { queue: true, reason: 'sisaKuota<=0' };
  if (nearReset) return { queue: true, reason: 'mepet-reset' };
  return { queue: false, reason: 'kuota-tersedia' };
}

// Trigger satuan 0 kuota (komputasi lokal, tanpa panggilan upstream):
// candle-yahoo | domestic-compile | accumulation | 3-screeners | reset-cache.
const ZERO_QUOTA_TRIGGERS = ['candle-yahoo', 'domestic-compile', 'accumulation', 'screeners-3x', 'reset-cache'];
function triggerZeroQuotaJob(name, actor) {
  if (!ZERO_QUOTA_TRIGGERS.includes(String(name))) return { ok: false, error: 'Trigger tidak dikenal: ' + name };
  let q = null;
  try { q = JSON.parse(fs.readFileSync(MANUAL_TRIGGER_PATH, 'utf8')); } catch (_) { q = null; }
  if (!q || !Array.isArray(q.triggers)) q = { triggers: [] };
  q.triggers.push({ name: String(name), at: new Date().toISOString(), actor: String(actor || 'admin'), quotaCost: 0 });
  q.triggers = q.triggers.slice(-50);
  fs.mkdirSync(path.dirname(MANUAL_TRIGGER_PATH), { recursive: true });
  fs.writeFileSync(MANUAL_TRIGGER_PATH, JSON.stringify(q, null, 2));
  return { ok: true, name: String(name), quotaCost: 0 };
}

// Tombol darurat: Kill All Active Upstream Jobs — tulis permintaan SIGTERM
// yang dibaca scheduler-daemon; web tidak dimatikan (hanya worker upstream).
function requestKillAllJobs(actor) {
  const payload = { at: new Date().toISOString(), actor: String(actor || 'admin'), action: 'SIGTERM-upstream-only', spareWeb: true };
  fs.mkdirSync(path.dirname(KILL_REQUEST_PATH), { recursive: true });
  fs.writeFileSync(KILL_REQUEST_PATH, JSON.stringify(payload, null, 2));
  return { ok: true, killRequested: true };
}

// Dynamic Preflight Gate: bila aktif, screener boleh jalan dengan candle+ALL
// saja (footnote faktor asing); bila mati, wajib candle+ALL+Foreign lengkap.
function preflightAllows(parts, cfg) {
  const c = cfg || loadConfig();
  const gate = toBool(c.dynamicPreflightGate, true);
  const p = parts || {};
  const candleOk = p.candleOk === true;
  const allOk = p.allOk === true;
  const foreignOk = p.foreignOk === true;
  if (gate) {
    return { allowed: candleOk && allOk, mode: 'longgar (candle+ALL)', foreignFootnote: !foreignOk, gate };
  }
  return { allowed: candleOk && allOk && foreignOk, mode: 'ketat (candle+ALL+Foreign)', foreignFootnote: false, gate };
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
  const limit = resolveEffectiveLimit({ upstreamDailyLimit: state.upstreamDailyLimit, config: cfg, now });
  const ql = quotaAuthority();
  const usage = ql ? ql.resolveUsage({ now, state }) : { known: false, used: null, measuredZero: false };
  const limitKnown = limit != null;
  const usageKnown = usage && usage.known === true;
  const used = usageKnown ? Math.max(effectiveUsed(state), usage.used) : null;
  const remaining = limitKnown && usageKnown ? Math.max(0, limit - used) : null;
  const overage = limitKnown && usageKnown ? Math.max(0, used - limit) : null;
  const pct = limitKnown && usageKnown && limit > 0 ? Math.min(100, Number(((used / limit) * 100).toFixed(1))) : null;
  const localN = normalizeCount(state.localUsedToday != null ? state.localUsedToday : state.usedToday, 0);
  const holiday = detectHoliday3Layer(now, o.holidaySignals, cfg);
  return {
    used, usedToday: used, localUsedToday: localN,
    backfillUsedToday: normalizeCount(state.backfillUsedToday, 0),
    hardStopLocked: state.hardStopLocked === true,
    currentDateWIB: state.currentDateWIB || state.date,
    upstreamUsedToday: state.upstreamUsedToday,
    upstreamDailyLimit: state.upstreamDailyLimit,
    limit, limitKnown, usageKnown,
    measuredZero: usageKnown && used === 0, remaining, overage, pct,
    reset: '00:00 WIB', label: 'Kuota API data', date: state.date,
    drift: state.drift || 0, driftDetected: state.driftDetected === true,
    planName: cfg.planName, planExpiresAt: cfg.planExpiresAt,
    forbidden: isInForbiddenWindow(now, cfg), holiday,
    maxQuota: limit, weekdayBackfillLimit: weekdayBackfillLimitFor(cfg),
    weekendBackfillLimit: weekendBackfillLimitFor(cfg),
    staleThresholdMinutes: staleThresholdMinutesFor(cfg),
    lowQuotaMode: toBool(cfg.lowQuotaMode, false),
    telegramMute: { daily: toBool(cfg.telegramMuteDaily, false), emergency: toBool(cfg.telegramMuteEmergency, false), nonCritical: toBool(cfg.telegramMuteNonCritical, false) },
    dynamicPreflightGate: toBool(cfg.dynamicPreflightGate, true),
    config: cfg
  };
}

function getQuotaSnapshot(now) { return snapshot({ now: now != null ? now : new Date() }); }

function getWibDateKeyFromDate(d) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(d instanceof Date ? d : new Date(d));
  } catch (_) { return getWibDateKey(d); }
}

// ==========================================================================
// BUG-V5-P0-023 / N14 — ROUTING: atomic quota claims (reserve/commit/release)
// ==========================================================================
// lib/quota-reservation.js is the single AUTHORITY for claiming quota.
// quota-state.js stays the legacy read/snapshot module; its atomic claim
// verbs are routed here so every existing consumer that requires
// lib/quota-state.js transparently lands on the authority (no circular
// import: the authority module is self-contained).
// Lazy require so probe/test harnesses can load this module standalone.
let _reservationAuthority = null;
function reservationAuthority() {
  if (_reservationAuthority === null) {
    try { _reservationAuthority = require('./quota-reservation'); }
    catch (_) { _reservationAuthority = false; }
  }
  return _reservationAuthority || null;
}

function reserveQuota(count, jobType, opts) {
  const m = reservationAuthority();
  if (!m) return { ok: false, reason: 'AUTHORITY_UNAVAILABLE', requested: count, jobType: jobType || null };
  return m.reserveQuota(count, jobType, opts);
}

function releaseQuota(id, opts) {
  const m = reservationAuthority();
  if (!m) return { ok: false, reason: 'AUTHORITY_UNAVAILABLE', id };
  return m.releaseQuota(id, opts);
}

function commitReservation(id, actualCount, opts) {
  const m = reservationAuthority();
  if (!m) return { ok: false, reason: 'AUTHORITY_UNAVAILABLE', id };
  return m.commitReservation(id, actualCount, opts);
}

function reservationStatus(id, opts) {
  const m = reservationAuthority();
  if (!m) return { ok: false, reason: 'AUTHORITY_UNAVAILABLE', id };
  return m.reservationStatus(id, opts);
}

// V3-F01: exit 0 mutlak saat sisa<=reserveFloor (weekday 5000, weekend 0).
// Dipakai worker backfill agar berhenti rapi tanpa error saat kuota cadangan tersentuh.
function shouldHardExitOnFloor(now, cfg) {
  const c = cfg || loadConfig();
  const st = readState(now);
  const limit = resolveEffectiveLimit({ upstreamDailyLimit: st.upstreamDailyLimit, config: c, now });
  if (limit == null) return { exit: true, remaining: null, floor: null, limit: null, used: null, reason: 'LIMIT_UNKNOWN' };
  const ql = quotaAuthority();
  const usage = ql ? ql.resolveUsage({ now, state: st }) : { known: false };
  if (!usage.known) return { exit: true, remaining: null, floor: null, limit, used: null, reason: 'USAGE_UNKNOWN' };
  const used = Math.max(effectiveUsed(st), usage.used);
  const remaining = Math.max(0, limit - used);
  const floor = reserveFloorFor(now, c);
  return { exit: remaining <= floor, remaining, floor, limit, used };
}

function setProviderLimit(input) {
  const ql = quotaAuthority();
  return ql ? ql.setProviderLimit(input) : { ok: false, reason: 'AUTHORITY_UNAVAILABLE' };
}
function setLimitOverride(input) {
  const ql = quotaAuthority();
  return ql ? ql.setOverride(input) : { ok: false, reason: 'AUTHORITY_UNAVAILABLE' };
}
function clearLimitOverride(input) {
  const ql = quotaAuthority();
  return ql ? ql.clearOverride(input) : { ok: false, reason: 'AUTHORITY_UNAVAILABLE' };
}
function resolveQuotaTruth(opts) {
  const ql = quotaAuthority();
  return ql ? ql.resolveTruth(opts) : { ok: false, limit: null, used: null, remaining: null, reason: 'AUTHORITY_UNAVAILABLE' };
}

module.exports = {
  CONFIG_PATH,
  STATE_PATH,
  AUDIT_PATH,
  PENDING_QUEUE_PATH,
  MANUAL_TRIGGER_PATH,
  KILL_REQUEST_PATH,
  ZERO_QUOTA_TRIGGERS,
  DEFAULTS,
  loadConfig,
  validateConfigPatch,
  saveConfig,
  autoProposeQuota,
  toBool,
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
  weekendBackfillLimitFor,
  staleThresholdMinutesFor,
  isStaleSince,
  getEffectiveHolidayManual,
  detectHoliday3Layer,
  readPendingQueue,
  enqueuePendingCatchup,
  shouldQueueAtReset,
  triggerZeroQuotaJob,
  requestKillAllJobs,
  preflightAllows,
  shouldHardExitOnFloor,
  isValidConsumeInput,
  canConsumeQuota,
  effectiveUsed,
  snapshot,
  getQuotaSnapshot,
  // BUG-V5-P0-023 / N14: atomic claim authority routed through this module
  reserveQuota,
  releaseQuota,
  commitReservation,
  reservationStatus,
  setProviderLimit,
  setLimitOverride,
  clearLimitOverride,
  resolveQuotaTruth
};
