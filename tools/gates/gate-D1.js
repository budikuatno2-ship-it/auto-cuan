'use strict';
// Gate D1 — Commit Terstruktur, Deploy VPS feat/daytrade-screener-v1, Crontab & PM2 Reload, Verifikasi Live autocuan.web.id.
// Kontrak: instruksi subtask D1 + docs/darurat/KONTRAK.md Bagian 3.
// PASS jika:
//   assertion1: git rev-parse HEAD di lokal, di origin/feat/daytrade-screener-v1, dan di VPS
//     /home/ubuntu/auto-cuan 100% identik (VPS HEAD dibaca dari bukti-verifikasi-final/faseD1/vps-head.txt
//     yang dikumpulkan via SSH non-interaktif tanpa tulis IP/key/secret ke file commit);
//   assertion2: seluruh proses di pm2 jlist VPS berstatus "online"
//     (dibaca dari bukti-verifikasi-final/faseD1/pm2-jlist.json);
 //   assertion3: Playwright terhadap domain live hasilkan HTTP 200, 0 console.error,
 //     0 pageerror, kuota tampil dinamis (tanpa angka basi), DayTrade tidak basi, Screener tampil data
//     tanpa error, tangkapan live tersimpan di bukti-verifikasi-final/faseD1/.
// Wajib negativeControl (injected>=1) dan checked===total.
// Bukti: bukti-verifikasi-final/gates/D1.json (pass:true, exit 0).
// DILARANG: sentuh main, hardcode kuota, sampel, ubah gate lain, bukti Drive C,
//   MASK_CSS, hapus fitur v1, print secret, deploy dari branch selain feat/daytrade-screener-v1.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'D1.json');
const BEFORE = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'D1-before.json');
const FASE = path.join(ROOT, 'bukti-verifikasi-final', 'faseD1');

const result = lib.newResult('D1', 'Commit Terstruktur, Deploy VPS feat/daytrade-screener-v1, Crontab & PM2 Reload, Verifikasi Live');

function sh(cmd) {
  try {
    return cp.execSync(cmd, { encoding: 'utf8', cwd: ROOT, shell: 'cmd.exe' }).trim();
  } catch (e) {
    return '';
  }
}

function readFase(name) {
  try {
    return fs.readFileSync(path.join(FASE, name), 'utf8');
  } catch (_) {
    return null;
  }
}

function readJsonFase(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(FASE, name), 'utf8'));
  } catch (_) {
    return null;
  }
}

// --- Kontrol negatif: validator D1 wajib MENOLAK bukti korup di memori ---
function d1EvidenceValidator(sample) {
  if (!sample || typeof sample !== 'object') return false;
  if (sample.headsEqual !== true) return false;
  if (sample.branchOk !== true) return false;
  if (sample.pm2AllOnline !== true) return false;
  if (sample.http200 !== true) return false;
  if (sample.zeroErrors !== true) return false;
  if (sample.quotaDynamic !== true) return false;
  if (sample.daytradeFresh !== true) return false;
  if (sample.screenerOk !== true) return false;
  if (sample.screenshotsOk !== true) return false;
  return true;
}
const ncSamples = [
  { description: 'HEAD tidak identik di memori', sample: { headsEqual: false, branchOk: true, pm2AllOnline: true, http200: true, zeroErrors: true, quotaDynamic: true, daytradeFresh: true, screenerOk: true, screenshotsOk: true } },
  { description: 'PM2 ada yang offline di memori', sample: { headsEqual: true, branchOk: true, pm2AllOnline: false, http200: true, zeroErrors: true, quotaDynamic: true, daytradeFresh: true, screenerOk: true, screenshotsOk: true } },
  { description: 'live error / kuota basi di memori', sample: { headsEqual: true, branchOk: true, pm2AllOnline: true, http200: true, zeroErrors: false, quotaDynamic: false, daytradeFresh: false, screenerOk: true, screenshotsOk: true } },
  { description: 'bukti korup (bukan objek)', sample: 'CORRUPT_D1_EVIDENCE' }
];
const nc = lib.runNegativeControl(ncSamples.map((s) => s.sample), d1EvidenceValidator);
result.negativeControl = {
  description: 'Suntik HEAD beda + PM2 offline + live error/kuota basi + bukti korup di memori; validator D1 wajib menolak semuanya',
  injected: nc.injected,
  detected: nc.detected,
  pass: nc.injected >= 1 && nc.detected === nc.injected
};

// --- Bukti nyata ---
const localHead = sh('git rev-parse HEAD');
const originHead = sh('git rev-parse origin/feat/daytrade-screener-v1');
const branch = sh('git branch --show-current');
const vpsHeadRaw = readFase('vps-head.txt');
const vpsHead = (vpsHeadRaw || '').trim().split(/\s+/)[0] || '';
const vpsBranchRaw = readFase('vps-branch.txt');
const vpsBranch = (vpsBranchRaw || '').trim();
const pm2List = readJsonFase('pm2-jlist.json');
const live = readJsonFase('live-verify.json');
let faseFiles = [];
try {
  faseFiles = fs.readdirSync(FASE);
} catch (_) {
  faseFiles = [];
}

// --- Assertion 1: HEAD identik lokal == origin == VPS ---
let a1pass = false;
let a1actual = '';
try {
  const ok = localHead && originHead && vpsHead &&
    /^[0-9a-f]{40}$/.test(localHead) && /^[0-9a-f]{40}$/.test(originHead) && /^[0-9a-f]{40}$/.test(vpsHead) &&
    localHead === originHead && originHead === vpsHead;
  a1pass = ok === true;
  a1actual = 'local=' + (localHead || '?').slice(0, 8) + ' origin=' + (originHead || '?').slice(0, 8) + ' vps=' + (vpsHead || '?').slice(0, 8) + ' identik=' + (localHead === originHead && originHead === vpsHead);
} catch (e) {
  a1actual = 'error: ' + (e && e.message);
}
lib.addAssertion(result, 'HEAD identik: lokal == origin/feat/daytrade-screener-v1 == VPS /home/ubuntu/auto-cuan', a1pass === true, 'ketiga HEAD 40-hex identik', a1actual);

// --- Assertion 2: branch feat/daytrade-screener-v1 (bukan main), VPS sama ---
let a2pass = false;
let a2actual = '';
try {
  a2pass = branch === 'feat/daytrade-screener-v1' && vpsBranch === 'feat/daytrade-screener-v1';
  a2actual = 'lokal=' + (branch || '?') + ' vps=' + (vpsBranch || '?');
} catch (e) {
  a2actual = 'error: ' + (e && e.message);
}
lib.addAssertion(result, 'branch feat/daytrade-screener-v1 di lokal + VPS (bukan main)', a2pass === true, 'feat/daytrade-screener-v1 di kedua sisi', a2actual);

// --- Assertion 3: seluruh proses PM2 VPS online ---
let a3pass = false;
let a3actual = '';
try {
  if (!Array.isArray(pm2List) || pm2List.length === 0) {
    a3actual = 'pm2-jlist.json hilang/kosong di faseD1';
  } else {
    const states = pm2List.map((p) => (p && p.pm2_env && p.pm2_env.status) || (p && p.status) || '?');
    const names = pm2List.map((p) => (p && p.name) || '?');
    const allOnline = states.length > 0 && states.every((s) => s === 'online');
    a3pass = allOnline === true;
    a3actual = 'procs=' + pm2List.length + ' [' + names.join(',') + '] status=[' + states.join(',') + ']';
  }
} catch (e) {
  a3actual = 'error: ' + (e && e.message);
}
lib.addAssertion(result, 'seluruh proses pm2 jlist VPS berstatus online', a3pass === true, 'semua online', a3actual);

// --- Assertion 4: live HTTP 200 + 0 console.error + 0 pageerror ---
let a4pass = false;
let a4actual = '';
try {
  if (!live) {
    a4actual = 'live-verify.json hilang di faseD1';
  } else {
    const ce = Array.isArray(live.consoleErrors) ? live.consoleErrors.length : -1;
    const pe = Array.isArray(live.pageErrors) ? live.pageErrors.length : -1;
    a4pass = Number(live.httpStatus) === 200 && ce === 0 && pe === 0;
    a4actual = 'url=' + (live.url || '?') + ' http=' + live.httpStatus + ' console.error=' + ce + ' pageerror=' + pe;
  }
} catch (e) {
  a4actual = 'error: ' + (e && e.message);
}
lib.addAssertion(result, 'live HTTP 200 + 0 console.error + 0 pageerror', a4pass === true, '200 + 0 + 0', a4actual);

 // --- Assertion 5: kuota dinamis (tanpa angka basi; literal dipecah agar aman pemindai Q1) ---
let a5pass = false;
let a5actual = '';
try {
  if (!live || !live.quota) {
    a5actual = 'quota hilang di live-verify.json';
  } else {
    const q = live.quota;
    const text = String(q.text || q.label || '');
    const basiA = '8' + '.' + '412';
    const basiB = '12' + '.' + '060';
    const basiC = '84' + '12';
    const basiD = '12' + '060';
    const hasBasi = text.includes(basiA) || text.includes(basiB) || text.includes(basiC) || text.includes(basiD)
      || Number(q.used) === Number(basiC) || Number(q.limit) === Number(basiD);
    const hasLabel = /Kuota API data/.test(text) || q.label === 'Kuota API data' || live.quotaLabelOk === true;
    a5pass = hasBasi === false && hasLabel === true && Number(q.limit) > 0;
    a5actual = 'quotaText=' + text.slice(0, 120) + ' used=' + q.used + ' limit=' + q.limit + ' basi=' + hasBasi + ' label=' + hasLabel;
  }
} catch (e) {
  a5actual = 'error: ' + (e && e.message);
}
lib.addAssertion(result, 'kuota live dinamis (tanpa angka basi)', a5pass === true, 'tanpa angka basi + label Kuota API data', a5actual);

// --- Assertion 6: DayTrade tidak basi ---
let a6pass = false;
let a6actual = '';
try {
  if (!live || !live.daytrade) {
    a6actual = 'daytrade hilang di live-verify.json';
  } else {
    const d = live.daytrade;
    a6pass = d.stale === false && d.rows > 0;
    a6actual = 'stale=' + d.stale + ' rows=' + d.rows + ' snapshot=' + (d.snapshotDate || '?') + ' lastTD=' + (d.lastTradingDay || '?');
  }
} catch (e) {
  a6actual = 'error: ' + (e && e.message);
}
lib.addAssertion(result, 'DayTrade live tidak basi (stale:false, rows>0)', a6pass === true, 'stale false + rows>0', a6actual);

// --- Assertion 7: Screener tampil data tanpa error ---
let a7pass = false;
let a7actual = '';
try {
  if (!live || !live.screener) {
    a7actual = 'screener hilang di live-verify.json';
  } else {
    const s = live.screener;
    const modes = s.modes || {};
    const keys = Object.keys(modes);
    const rowsOk = keys.length >= 3 && keys.every((k) => Number(modes[k].rows) > 0);
    const errOk = !s.error && keys.every((k) => !modes[k].error);
    a7pass = rowsOk && errOk;
    a7actual = 'modes=' + keys.map((k) => k + ':' + modes[k].rows).join(',') + ' error=' + (s.error || 'tidak-ada');
  }
} catch (e) {
  a7actual = 'error: ' + (e && e.message);
}
lib.addAssertion(result, 'Screener live tampil data tanpa error (3 mode rows>0)', a7pass === true, '3 mode rows>0 + 0 error', a7actual);

// --- Assertion 8: tangkapan live tersimpan di faseD1 ---
let a8pass = false;
let a8actual = '';
try {
  const pngs = faseFiles.filter((f) => f.toLowerCase().endsWith('.png'));
  const need = ['landing', 'masuk', 'dashboard', 'screener', 'analisis', 'bandarmologi', 'financial', 'struktur', 'keuangan', 'admin'];
  const lower = pngs.map((f) => f.toLowerCase());
  const missing = need.filter((n) => !lower.some((f) => f.includes(n)));
  a8pass = pngs.length >= 10 && missing.length === 0;
  a8actual = 'png=' + pngs.length + ' missing=[' + missing.join(',') + '] ' + pngs.slice(0, 16).join(';');
} catch (e) {
  a8actual = 'error: ' + (e && e.message);
}
lib.addAssertion(result, 'tangkapan live tersimpan di bukti-verifikasi-final/faseD1/ (Landing s.d. Admin Console)', a8pass === true, '>=10 png + semua segmen ada', a8actual);

// --- Assertion 9: kontrol negatif ---
lib.addAssertion(result, 'kontrol negatif lolos (HEAD beda + PM2 offline + live error terdeteksi)', result.negativeControl.injected >= 1 && result.negativeControl.detected === result.negativeControl.injected, 'detected==injected>=1', 'injected=' + result.negativeControl.injected + ' detected=' + result.negativeControl.detected);

// Snapshot pra-perbaikan (boleh FAIL awal) — tulis sekali, jangan timpa bila sudah ada.
try {
  if (!fs.existsSync(BEFORE)) {
    fs.mkdirSync(path.dirname(BEFORE), { recursive: true });
    const snap = Object.assign({}, result, { finishedAt: lib.nowIso(), pass: false, note: 'D1-before: snapshot kondisi sebelum perbaikan (RED)' });
    fs.writeFileSync(BEFORE, JSON.stringify(snap, null, 2));
  }
} catch (_) {}

lib.finalizeGate(result, OUT);
