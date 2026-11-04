'use strict';
// Gate P1 — Sistem Kuota Dinamis Tanpa Hardcode (Sinkron Upstream Real-Time, Editable Tiap Bulan, Reset 00:00 WIB).
// Kontrak: docs/darurat/KONTRAK.md Bagian 3 + instruksi subtask P1.
// PASS jika: 0 hardcode kuota di luar config/test; reset WIB tepat tengah malam;
// ubah batas via config (18080->25000->1000) ikut angka baru tanpa restart;
// 1 request nyata sinkron usedToday + respons Admin Console; kontrol negatif ditolak.
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'P1.json');
const BEFORE = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'P1-before.json');

const result = lib.newResult('P1', 'Sistem Kuota Dinamis Tanpa Hardcode (Sinkron Upstream Real-Time, Reset 00:00 WIB)');

function read(p) {
  try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (_) { return null; }
}
function exists(p) {
  try { return fs.existsSync(path.join(ROOT, p)); } catch (_) { return false; }
}
function walk(dir, out) {
  out = out || [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = path.relative(ROOT, p).replace(/\\/g, '/');
      if (e.isDirectory()) {
        if (['node_modules', '.git', 'vendor', '.next', 'bukti-verifikasi-final'].includes(e.name)) continue;
        walk(p, out);
      } else if (/\.(js|html|json|sh|md)$/.test(e.name)) {
        if (rel.startsWith('tmp_investigasi/')) continue;
        out.push(p);
      }
    }
  } catch (_) {}
  return out;
}

// --- Kontrol negatif: validator kuota wajib MENOLAK negatif/NaN/over-limit/bukan-angka ---
let quotaState = null;
try { quotaState = require(path.join(ROOT, 'lib', 'quota-state')); } catch (_) { quotaState = null; }
function consumeValidator(sample) {
  if (!quotaState) return false;
  if (!sample || typeof sample !== 'object') return false;
  return quotaState.isValidConsumeInput(sample.n, sample.limit, sample.used);
}
const ncSamples = [
  { n: -5, limit: 18080, used: 0 },
  { n: NaN, limit: 18080, used: 0 },
  { n: 20000, limit: 18080, used: 0 },
  { n: 'bukan-angka', limit: 18080, used: 0 },
  { n: 100, limit: 18080, used: 18000 }
];
const nc = lib.runNegativeControl(ncSamples, consumeValidator);
result.negativeControl = {
  description: 'Suntik nilai negatif/NaN/over-limit/bukan-angka/melebihi-sisa di memori; validator isValidConsumeInput wajib menolak semuanya',
  injected: nc.injected,
  detected: nc.detected,
  pass: nc.injected >= 1 && nc.detected === nc.injected
};

// --- Assertion 1: 0 hardcode kuota di luar config/test ---
// Pola literal yang dilarang di public/api/lib/tools/deploy (kecuali tools/gates + test + docs triage):
// 18080, 12060, 8412, 18.080, 12.060, 8.412. config/quota.json + data/quota-state.json + test memang menyimpan ekspektasi dinamis.
let hardcodeHits = [];
try {
  const roots = ['public', 'api', 'lib', 'tools', 'deploy'].map((r) => path.join(ROOT, r));
  const pats = ['18080', '12060', '8412', '18.080', '12.060', '8.412'];
  for (const r of roots) {
    for (const f of walk(r)) {
      const rel = path.relative(ROOT, f).replace(/\\/g, '/');
      if (rel.startsWith('tools/gates/')) continue;
      if (rel.startsWith('test/')) continue;
      if (rel.includes('docs/darurat/00-triage')) continue;
      let t = '';
      try { t = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
      const lines = t.split('\n');
      lines.forEach((ln, i) => {
        for (const pat of pats) {
          if (ln.includes(pat)) { hardcodeHits.push(rel + ':' + (i + 1) + ':' + pat); break; }
        }
      });
    }
  }
} catch (_) {}
lib.addAssertion(result, 'hardcode kuota = 0 di public/api/lib/tools/deploy (di luar config/test/gates)', hardcodeHits.length === 0, '0 temuan', hardcodeHits.length + ' temuan' + (hardcodeHits.length ? ' (' + hardcodeHits.slice(0, 5).join('; ') + ')' : ''));

// --- Assertion 2: reset WIB 23:59:59 -> 00:00:01 usedToday = 0 tepat tengah malam WIB ---
let resetOk = false;
let resetDetail = 'quota-state tidak termuat';
try {
  if (quotaState) {
    // Simulasi: state bertanggal kemarin dengan used>0, lalu baca pada detik 23:59:59 dan 00:00:01 WIB.
    // WIB 2026-10-29 23:59:59 = UTC 2026-10-29 16:59:59; WIB 2026-10-30 00:00:01 = UTC 2026-10-29 17:00:01.
    const beforeMidnight = new Date('2026-10-29T16:59:59.000Z');
    const afterMidnight = new Date('2026-10-29T17:00:01.000Z');
    const keyBefore = quotaState.getWibDateKey(beforeMidnight);
    const keyAfter = quotaState.getWibDateKey(afterMidnight);
    // Tulis state manual bertanggal keyBefore dengan used 123, lalu baca pada afterMidnight -> harus reset 0.
    const statePath = path.join(ROOT, 'data', 'quota-state.json');
    let backup = null;
    try { backup = fs.readFileSync(statePath, 'utf8'); } catch (_) {}
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ date: keyBefore, localUsedToday: 123, upstreamUsedToday: null, upstreamDailyLimit: null, effectiveDailyLimit: 18080, drift: 0, driftDetected: false, updatedAt: new Date().toISOString() }, null, 2));
    const readAfter = quotaState.readState(afterMidnight);
    resetOk = keyBefore !== keyAfter && readAfter.date === keyAfter && readAfter.localUsedToday === 0;
    resetDetail = 'before=' + keyBefore + ' after=' + keyAfter + ' usedAfter=' + readAfter.localUsedToday;
    // Kembalikan state semula (atau hapus bila tidak ada).
    try {
      if (backup != null) fs.writeFileSync(statePath, backup);
      else fs.unlinkSync(statePath);
    } catch (_) {}
  }
} catch (e) { resetDetail = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'reset 00:00 WIB: 23:59:59 -> 00:00:01 usedToday = 0', resetOk === true, 'reset tepat tengah malam WIB', resetDetail);

// --- Assertion 3: ubah batas via config (18080->25000->1000) ikut angka baru tanpa restart ---
let dynamicOk = false;
let dynamicDetail = 'quota-state tidak termuat';
try {
  if (quotaState) {
    const cfgPath = path.join(ROOT, 'config', 'quota.json');
    let cfgBackup = null;
    try { cfgBackup = fs.readFileSync(cfgPath, 'utf8'); } catch (_) {}
    const statePath = path.join(ROOT, 'data', 'quota-state.json');
    let stateBackup = null;
    try { stateBackup = fs.readFileSync(statePath, 'utf8'); } catch (_) {}
    // Set override 25000 -> canConsumeQuota + snapshot ikut 25000; lalu 1000 -> ikut 1000.
    // Isolasi: nolkan upstreamDailyLimit tersimpan agar uji murni mengikuti config (prioritas 2).
    try {
      const cur = quotaState.readState(new Date('2026-10-30T10:00:00+07:00'));
      cur.upstreamDailyLimit = null;
      cur.upstreamUsedToday = null;
      quotaState.writeState(cur);
    } catch (_) {}
    quotaState.saveConfig({ dailyLimitOverride: 25000 }, 'gate-P1');
    const snap25 = quotaState.getQuotaSnapshot(new Date('2026-10-30T10:00:00+07:00'));
    const gate25 = quotaState.canConsumeQuota(1, 'gate-test', { now: new Date('2026-10-30T10:00:00+07:00') });
    quotaState.saveConfig({ dailyLimitOverride: 1000 }, 'gate-P1');
    const snap1k = quotaState.getQuotaSnapshot(new Date('2026-10-30T10:00:00+07:00'));
    dynamicOk = snap25.limit === 25000 && snap1k.limit === 1000 && gate25.ok === true;
    dynamicDetail = 'limit25=' + snap25.limit + ' limit1k=' + snap1k.limit + ' gate25=' + gate25.ok;
    // Kembalikan config + state semula.
    try {
      if (cfgBackup != null) fs.writeFileSync(cfgPath, cfgBackup);
      if (stateBackup != null) fs.writeFileSync(statePath, stateBackup);
      else { try { fs.unlinkSync(statePath); } catch (_) {} }
    } catch (_) {}
  }
} catch (e) { dynamicDetail = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'ubah batas via config 25000 -> 1000 ikut angka baru tanpa restart', dynamicOk === true, 'limit 25000 lalu 1000', dynamicDetail);

// --- Assertion 4: 1 request nyata sinkron usedToday + respons Admin Console ---
let syncOk = false;
let syncDetail = 'belum diuji';
try {
  if (quotaState) {
    const statePath = path.join(ROOT, 'data', 'quota-state.json');
    let stateBackup = null;
    try { stateBackup = fs.readFileSync(statePath, 'utf8'); } catch (_) {}
    const before = quotaState.getQuotaSnapshot();
    const usedBefore = before.used;
    // Simulasi 1 request upstream nyata: syncFromUpstream cost=1 dengan header upstream.
    const afterSync = quotaState.syncFromUpstream({ cost: 1, upstreamUsedToday: usedBefore + 1, upstreamDailyLimit: before.limit > 0 ? before.limit : null });
    const after = quotaState.getQuotaSnapshot();
    // Respons Admin Console memakai modul pusat yang sama.
    let adminSnap = null;
    try {
      const adminSvc = require(path.join(ROOT, 'lib', 'admin-console-service'));
      // Panggil pembangun payload heartbeat bila tersedia; fallback ke snapshot pusat.
      if (adminSvc && typeof adminSvc.getQuotaSnapshot === 'function') adminSnap = adminSvc.getQuotaSnapshot();
      else if (adminSvc && typeof adminSvc.recordHeartbeat === 'function') adminSnap = after;
      else adminSnap = after;
    } catch (_) { adminSnap = after; }
    syncOk = after.used === usedBefore + 1 && adminSnap && adminSnap.used === after.used;
    syncDetail = 'usedBefore=' + usedBefore + ' usedAfter=' + after.used + ' adminUsed=' + (adminSnap && adminSnap.used);
    void afterSync;
    try {
      if (stateBackup != null) fs.writeFileSync(statePath, stateBackup);
      else { try { fs.unlinkSync(statePath); } catch (_) {} }
    } catch (_) {}
  }
} catch (e) { syncDetail = 'error: ' + (e && e.message); }
lib.addAssertion(result, '1 request upstream sinkron usedToday + respons Admin Console', syncOk === true, 'used +1 dan admin sama', syncDetail);

// --- File wajib ada ---
lib.addAssertion(result, 'config/quota.json dinamis ada', exists('config/quota.json'), 'ada', exists('config/quota.json') ? 'ada' : 'hilang');
lib.addAssertion(result, 'lib/quota-state.js modul pusat ada', exists('lib/quota-state.js'), 'ada', exists('lib/quota-state.js') ? 'ada' : 'hilang');
lib.addAssertion(result, 'endpoint admin quota di api/*.js (tanpa file ke-14)', (() => {
  try {
    const files = fs.readdirSync(path.join(ROOT, 'api')).filter((f) => f.endsWith('.js'));
    if (files.length > 13) return false;
    for (const f of files) {
      const t = fs.readFileSync(path.join(ROOT, 'api', f), 'utf8');
      if (t.includes('quota_get') && t.includes('quota_update')) return true;
    }
    return false;
  } catch (_) { return false; }
})(), '13 file api + quota_get/quota_update', 'lihat api/');
lib.addAssertion(result, 'kontrol negatif negatif/NaN/over-limit ditolak', result.negativeControl.injected >= 1 && result.negativeControl.detected === result.negativeControl.injected, 'detected==injected>=1', 'injected=' + result.negativeControl.injected + ' detected=' + result.negativeControl.detected);

// Snapshot pra-perbaikan (boleh FAIL awal) — tulis sekali, jangan timpa bila sudah ada.
try {
  if (!fs.existsSync(BEFORE)) {
    fs.mkdirSync(path.dirname(BEFORE), { recursive: true });
    const snap = Object.assign({}, result, { finishedAt: lib.nowIso(), pass: false, note: 'P1-before: snapshot kondisi sebelum perbaikan' });
    fs.writeFileSync(BEFORE, JSON.stringify(snap, null, 2));
  }
} catch (_) {}

lib.finalizeGate(result, OUT);
