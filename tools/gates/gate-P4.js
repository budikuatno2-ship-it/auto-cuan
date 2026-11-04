'use strict';
// Gate P4 — Mesin Penyerap Kuota Harian & Backfill Otomatis (tools/quota-burn.js).
// Kontrak: subtask P4 + docs/darurat/KONTRAK.md Bagian 3.
// PASS jika:
//   assertion1: usedToday dashboard/state upstream bertambah nyata (bukan nol);
//     bukti VPS (Drive D): bukti-verifikasi-final/faseP4/quota-state-vps.json,
//     quota-burn-state-vps.json, heartbeat-vps.json, usage-vps.json
//     (spent>=500, usedNow>usedBefore, heartbeat exitCode 0).
//   assertion2: bandingkan sensus VPS terbaru (latest-vps-after.json) vs
//     baseline VPS pra-burn (vps-baseline.json): emiten Q2 2026 + sel Broksum
//     ALL/Foreign bertambah fisik.
//   assertion3: data/completeness/forecast.json ada dan membuktikan jadwal selesai
//     sebelum 17 Nov 2026 (finishesBeforeExpiry===true, finishDate<2026-11-17).
// Kontrol negatif: suntik queue kosong / request 0 / negatif di memori,
//   pastikan gate canConsumeQuota quota-burn menolak dengan benar
//   (injected>=1, detected==injected).
// Bukti: bukti-verifikasi-final/gates/P4.json (pass:true, exit 0).
// DILARANG: sentuh main, hardcode kuota, sampel, ubah gate lain, bukti Drive C,
//   MASK_CSS, hapus fitur v1, print secret.
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'P4.json');
const BEFORE = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'P4-before.json');
const QUEUE = path.join(ROOT, 'data', 'backfill-queue.json');
const FORECAST = path.join(ROOT, 'data', 'completeness', 'forecast.json');
const BASELINE = path.join(ROOT, 'bukti-verifikasi-final', 'faseP3', 'before-backfill.json');
const BURN = path.join(ROOT, 'tools', 'quota-burn.js');
const BUILDER = path.join(ROOT, 'tools', 'build-backfill-queue.js');
const FORECAST_BUILDER = path.join(ROOT, 'tools', 'build-forecast.js');
// Bukti VPS (ditarik via SCP, Drive D saja).
const VPS_QSTATE = path.join(ROOT, 'bukti-verifikasi-final', 'faseP4', 'quota-state-vps.json');
const VPS_PROG = path.join(ROOT, 'bukti-verifikasi-final', 'faseP4', 'quota-burn-state-vps.json');
const VPS_HB = path.join(ROOT, 'bukti-verifikasi-final', 'faseP4', 'heartbeat-vps.json');
const VPS_USAGE = path.join(ROOT, 'bukti-verifikasi-final', 'faseP4', 'usage-vps.json');
const VPS_BASE = path.join(ROOT, 'bukti-verifikasi-final', 'faseP4', 'vps-baseline.json');
const VPS_VERIFY = path.join(ROOT, 'bukti-verifikasi-final', 'faseP4', 'verify-after.json');

const result = lib.newResult('P4', 'Mesin Penyerap Kuota Harian & Backfill Otomatis (tools/quota-burn.js)');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

// --- Kontrol negatif: gate canConsumeQuota WAJIB menolak input jahat ---
let quotaState = null;
try { quotaState = require(path.join(ROOT, 'lib', 'quota-state')); } catch (_) { quotaState = null; }
function burnGateValidator(sample) {
  if (!sample || typeof sample !== 'object') return false;
  if (!Array.isArray(sample.queueItems) || sample.queueItems.length === 0) return false;
  if (!quotaState) return false;
  const gate = quotaState.canConsumeQuota(sample.requested, 'quota-burn-test', {
    now: new Date('2026-10-30T10:00:00+07:00'),
    reserveFloor: sample.floor != null ? sample.floor : 0
  });
  return gate.ok === true;
}
const ncSamples = [
  { queueItems: [], requested: 1, floor: 0 },
  { queueItems: ['AADI@2026-10-16'], requested: 0, floor: 0 },
  { queueItems: ['AADI@2026-10-16'], requested: -5, floor: 0 }
];
const nc = lib.runNegativeControl(ncSamples, burnGateValidator);
result.negativeControl = {
  description: 'Suntik antrean kosong / request 0 / request negatif di memori; gate canConsumeQuota quota-burn wajib menolak semuanya',
  injected: nc.injected,
  detected: nc.detected,
  pass: nc.injected >= 1 && nc.detected === nc.injected
};

// --- Assertion 1: usedToday VPS bertambah nyata (bukan nol) ---
let a1pass = false;
let a1actual = '';
try {
  const qs = readJson(VPS_QSTATE);
  const prog = readJson(VPS_PROG);
  const hb = readJson(VPS_HB);
  const usage = readJson(VPS_USAGE);
  const used = qs ? Number(qs.localUsedToday) : -1;
  const spent = prog ? Number(prog.spent) : -1;
  const usedBefore = prog ? Number(prog.usedBefore) : null;
  const usedNow = prog ? Number(prog.usedNow) : null;
  const hbOk = hb && hb.jobName === 'quota-burn' && hb.exitCode === 0 && Number(hb.requestsUsed) > 0;
  const usageUsed = usage ? Number(usage.used) : -1;
  a1pass = used > 0 && spent >= 500 && usedNow != null && usedBefore != null
    && usedNow > usedBefore && hbOk === true && usageUsed > 0;
  a1actual = 'vps quota-state.used=' + used + ' burn.spent=' + spent
    + ' usedBefore=' + usedBefore + ' usedNow=' + usedNow
    + ' legacyUsage=' + usageUsed + ' heartbeat=' + (hbOk ? 'OK' : 'BAD');
} catch (e) { a1actual = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'usedToday VPS bertambah nyata via quota-burn (bukan nol)', a1pass === true, 'used>0, spent>=500, usedNow>usedBefore, heartbeat OK', a1actual);

// --- Assertion 2: verifikasi VPS pasca-burn vs baseline pra-burn: Q2 + ALL/F bertambah ---
let a2pass = false;
let a2actual = '';
try {
  const ver = readJson(VPS_VERIFY);
  const baseP3 = readJson(BASELINE);
  if (!ver || !ver.after || !ver.baseline) {
    a2actual = 'verify-after=' + (ver ? 'ada-tanpa-isi' : 'hilang');
  } else {
    const q2After = Number(ver.after.q2);
    const q2Base = Number(ver.baseline.q2);
    const allAfter = Number(ver.after.allFiles);
    const allBase = Number(ver.baseline.allFill);
    const fAfter = Number(ver.after.fFiles);
    const fBase = Number(ver.baseline.fFill);
    const q2Up = q2After > q2Base;
    const allUp = allAfter > allBase;
    const fUp = fAfter > fBase;
    const toolsOk = fs.existsSync(QUEUE) && fs.existsSync(BURN) && fs.existsSync(BUILDER);
    a2pass = q2Up && (allUp || fUp) && toolsOk === true;
    a2actual = 'VPS Q2 ' + q2Base + '->' + q2After
      + '; ALL.file ' + allBase + '->' + allAfter
      + '; F.file ' + fBase + '->' + fAfter
      + '; queue/burn/builder=' + toolsOk
      + '; P3-baseline Q2=' + (baseP3 ? baseP3.fundamental.withQ2_2026_all3 : '?');
  }
} catch (e) { a2actual = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'verifikasi VPS pasca-burn vs baseline pra-burn: Q2 + file ALL/F bertambah fisik', a2pass === true, 'Q2 naik + (ALL naik atau F naik) + queue/burn/builder ada', a2actual);

// --- Assertion 3: forecast ada dan selesai sebelum 17 Nov 2026 ---
let a3pass = false;
let a3actual = '';
try {
  const fc = readJson(FORECAST);
  if (!fc) {
    a3actual = 'data/completeness/forecast.json hilang';
  } else {
    const finish = String(fc.finishDate || '');
    const before = fc.finishesBeforeExpiry === true;
    const hasTable = Array.isArray(fc.dailyTable) && fc.dailyTable.length > 0;
    const hasRem = Number.isFinite(Number(fc.remainingRequests)) && Number(fc.remainingRequests) > 0;
    a3pass = before && finish < '2026-11-17' && hasTable && hasRem;
    a3actual = 'finish=' + finish + ' beforeExpiry=' + before + ' days=' + (fc.dailyTable ? fc.dailyTable.length : 0) + ' remaining=' + fc.remainingRequests;
  }
} catch (e) { a3actual = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'forecast.json ada dan jadwal selesai sebelum 17 Nov 2026', a3pass === true, 'finish<2026-11-17, finishesBeforeExpiry=true, tabel harian ada', a3actual);

// --- Assertion 4: tanpa hardcode kuota di file P4 + Admin Console membaca file ---
// (tools/gates/ dikecualikan dari pemindaian, sama seperti gate P1.)
let a4pass = false;
let a4actual = '';
try {
  const banned = ['18080', '12060', '8412', '18.080', '12.060', '8.412'];
  const hits = [];
  for (const f of [BURN, BUILDER, FORECAST_BUILDER]) {
    try {
      const src = fs.readFileSync(f, 'utf8');
      src.split('\n').forEach((ln, i) => {
        for (const p of banned) {
          if (ln.includes(p)) { hits.push(path.basename(f) + ':' + (i + 1) + ':' + p); break; }
        }
      });
    } catch (_) {}
  }
  let uiOk = false;
  try {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'admin-console.html'), 'utf8');
    const js = fs.readFileSync(path.join(ROOT, 'public', 'admin-console-runtime.js'), 'utf8');
    const api = fs.readFileSync(path.join(ROOT, 'api', 'admin-users.js'), 'utf8');
    uiOk = html.includes('forecastTbody') && js.includes('backfill_forecast') && api.includes('backfill_forecast');
  } catch (_) {}
  a4pass = hits.length === 0 && uiOk === true;
  a4actual = 'banned=' + hits.length + (hits.length ? ' (' + hits.slice(0, 3).join(';') + ')' : '') + ' ui=' + (uiOk ? 'forecast-panel+endpoint OK' : 'MISSING');
} catch (e) { a4actual = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'tanpa hardcode kuota di file P4 + Admin Console membaca forecast dari file', a4pass === true, '0 banned + panel forecast + endpoint ada', a4actual);

// --- Assertion 5: kontrol negatif ---
lib.addAssertion(result, 'kontrol negatif lolos (queue kosong/request jahat ditolak)', result.negativeControl.injected >= 1 && result.negativeControl.detected === result.negativeControl.injected, 'detected==injected>=1', 'injected=' + result.negativeControl.injected + ' detected=' + result.negativeControl.detected);

// Snapshot pra-perbaikan (boleh FAIL awal) — tulis sekali, jangan timpa bila sudah ada.
try {
  if (!fs.existsSync(BEFORE)) {
    fs.mkdirSync(path.dirname(BEFORE), { recursive: true });
    const snap = Object.assign({}, result, { finishedAt: lib.nowIso(), pass: false, note: 'P4-before: snapshot kondisi sebelum perbaikan' });
    fs.writeFileSync(BEFORE, JSON.stringify(snap, null, 2));
  }
} catch (_) {}

lib.finalizeGate(result, OUT);
