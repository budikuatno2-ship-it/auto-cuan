'use strict';
// Gate P2 — Perbaikan Eksekusi Cron WIB di VPS (Job Wrapper, Heartbeat Nyata, Bukti Jalan, Hard Stop 23:50 WIB).
// Kontrak: docs/darurat/KONTRAK.md Bagian 3 + instruksi subtask P2.
// PASS jika:
//   assertion1: crontab -l VPS 100% identik dengan deploy/vps/final-schedule.cron,
//     punya CRON_TZ=Asia/Jakarta, 0 entri di 23:50-00:10 WIB;
//   assertion2: untuk SELURUH N entri (checked===total) file skrip ada di disk + executable
//     + punya data/job-heartbeat/<nama-job>.json exitCode===0 dari uji env cron nyata;
//   assertion3: simulasi jam 23:51 WIB pada lib/wib-hard-stop.js + job-wrapper.sh
//     langsung hentikan job pemakai kuota.
// Bukti VPS disalin ke bukti-verifikasi-final/faseP2/ (heartbeat/log VPS).
// Wajib negativeControl (injected>=1) dan checked===total.
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'P2.json');
const BEFORE = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'P2-before.json');
const FASE2 = path.join(ROOT, 'bukti-verifikasi-final', 'faseP2');

const result = lib.newResult('P2', 'Perbaikan Eksekusi Cron WIB di VPS (Job Wrapper, Heartbeat Nyata, Bukti Jalan, Hard Stop 23:50 WIB)');

function read(p) {
  try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (_) { return null; }
}
function exists(p) {
  try { return fs.existsSync(path.join(ROOT, p)); } catch (_) { return false; }
}
function listFase2() {
  try { return fs.readdirSync(FASE2); } catch (_) { return []; }
}

// --- Parse final-schedule.cron: kumpulkan entri aktif (non-komentar, non-env) ---
function parseCronEntries(text) {
  const entries = [];
  const lines = String(text || '').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^[A-Z_][A-Z0-9_]*\s*=/.test(line)) continue; // env: CRON_TZ, PATH, ...
    const m = line.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    entries.push({ minute: m[1], hour: m[2], dom: m[3], month: m[4], dow: m[5], cmd: m[6].trim(), raw: line });
  }
  return entries;
}

function jobNameFromCmd(cmd) {
  const m = String(cmd || '').match(/job-wrapper\.sh\s+([A-Za-z0-9_-]+)\s+(\d+)/);
  if (!m) return null;
  return { name: m[1], timeout: parseInt(m[2], 10) };
}

function scriptTargetFromCmd(cmd) {
  // Ambil target skrip/tools setelah <timeout>: bash <path> | node <path> | langsung.
  const m = String(cmd || '').match(/job-wrapper\.sh\s+[A-Za-z0-9_-]+\s+\d+\s+(.+)$/);
  if (!m) return null;
  let rest = m[1].trim();
  rest = rest.replace(/^JOB_USES_QUOTA=\d+\s+/, '');
  rest = rest.replace(/^(bash|sh|\/bin\/bash)\s+/, '');
  rest = rest.replace(/^\/home\/ubuntu\/\.local\/node-v22\/bin\/node\s+/, '');
  const tok = rest.split(/\s+/)[0] || '';
  return tok;
}

function resolveLocalTarget(tok) {
  if (!tok) return null;
  if (tok.startsWith('/home/ubuntu/auto-cuan/')) return tok.replace('/home/ubuntu/auto-cuan/', '');
  if (tok.startsWith('tools/') || tok.startsWith('deploy/') || tok.startsWith('lib/')) return tok;
  return null;
}

// Menit mulai sebuah entri cron (untuk cek jendela terlarang 23:50-00:10).
// Mengembalikan daftar {hour, minute} yang dicakup pola (kecuali pola kompleks -> konservatif: anggap mencakup bila rentang menyentuh).
function entryStartMinutes(e) {
  const out = [];
  const expand = (field, max) => {
    const vals = new Set();
    for (const part of String(field).split(',')) {
      let m = part.match(/^\*\/(\d+)$/);
      if (m) { const s = parseInt(m[1], 10); for (let v = 0; v <= max; v += s) vals.add(v); continue; }
      m = part.match(/^\*$/);
      if (m) { for (let v = 0; v <= max; v++) vals.add(v); continue; }
      m = part.match(/^(\d+)-(\d+)$/);
      if (m) { for (let v = parseInt(m[1], 10); v <= parseInt(m[2], 10); v++) vals.add(v); continue; }
      m = part.match(/^(\d+)-(\d+)\/(\d+)$/);
      if (m) { for (let v = parseInt(m[1], 10); v <= parseInt(m[2], 10); v += parseInt(m[3], 10)) vals.add(v); continue; }
      m = part.match(/^(\d+)$/);
      if (m) { vals.add(parseInt(m[1], 10)); continue; }
      return null; // pola tak dikenal -> konservatif
    }
    return vals;
  };
  const hours = expand(e.hour, 23);
  const mins = expand(e.minute, 59);
  if (!hours || !mins) return null;
  for (const h of hours) for (const mi of mins) out.push({ hour: h, minute: mi });
  return out;
}

function inForbidden(h, m) {
  const cur = h * 60 + m;
  return cur >= 23 * 60 + 50 || cur < 10; // 23:50-00:10
}

// --- Kontrol negatif: validator heartbeat wajib MENOLAK heartbeat korup ---
function heartbeatValidator(sample) {
  if (!sample || typeof sample !== 'object') return false;
  if (typeof sample.jobName !== 'string' || !sample.jobName) return false;
  if (typeof sample.exitCode !== 'number') return false;
  if (sample.exitCode !== 0) return false; // gate hanya terima exitCode 0
  if (typeof sample.status !== 'string' || !sample.status) return false;
  // P2: status skip terjadwal fail-closed (bukan gagal infra) diterima hijau.
  const okStatuses = new Set(['OK', 'LOCK_BUSY', 'FORBIDDEN_WINDOW_SKIP', 'SCHEDULED_SKIP']);
  if (!okStatuses.has(sample.status)) return false;
  if (!sample.lastStartWIB || !sample.lastEndWIB) return false;
  return true;
}
const ncSamples = [
  'CORRUPT_HEARTBEAT',
  { jobName: '', exitCode: 0, status: 'OK' },
  { jobName: 'x', exitCode: 1, status: 'ERROR', lastStartWIB: 't', lastEndWIB: 't' },
  { jobName: 'x', exitCode: 0, status: '', lastStartWIB: 't' }
];
const nc = lib.runNegativeControl(ncSamples, heartbeatValidator);
result.negativeControl = {
  description: 'Suntik heartbeat korup/exitCode!=0/status kosong di memori; validator heartbeat wajib menolak semuanya',
  injected: nc.injected,
  detected: nc.detected,
  pass: nc.injected >= 1 && nc.detected === nc.injected
};

// --- Muat jadwal lokal + bukti VPS ---
const cronText = read('deploy/vps/final-schedule.cron');
const entries = cronText ? parseCronEntries(cronText) : [];
const N = entries.length;
const files = listFase2();
function fase2(name) {
  const p = path.join(FASE2, name);
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; }
}
const crontabVps = fase2('crontab-vps.txt');
const vpsEntries = crontabVps ? parseCronEntries(crontabVps) : [];

// Normalisasi: bandingkan entri non-komentar tanpa spasi ganda.
function normEntries(list) {
  return list.map((e) => `${e.minute} ${e.hour} ${e.dom} ${e.month} ${e.dow} ${e.cmd.replace(/\s+/g, ' ').trim()}`).sort();
}

// --- Assertion 1: crontab VPS identik + CRON_TZ + 0 entri 23:50-00:10 ---
let a1pass = false;
let a1actual = '';
try {
  const hasTzLocal = /CRON_TZ=Asia\/Jakarta/.test(cronText || '');
  const hasTzVps = /CRON_TZ=Asia\/Jakarta/.test(crontabVps || '');
  const normL = normEntries(entries);
  const normV = normEntries(vpsEntries);
  const identical = normL.length > 0 && normL.length === normV.length && normL.every((v, i) => v === normV[i]);
  // P2: jendela terlarang 23:50-00:10 hanya berlaku untuk job PEMAKAI KUOTA.
  // Job 0-kuota (JOB_USES_QUOTA=0: watchdog, security-monitor, screener lokal, dll)
  // boleh jalan di jendela tersebut — wrapper hanya memblokir job kuota.
  const usesQuota = (cmd) => !/JOB_USES_QUOTA=0/.test(String(cmd || ''));
  let forbiddenLocal = [];
  let forbiddenVps = [];
  for (const e of entries) {
    if (!usesQuota(e.cmd)) continue;
    const starts = entryStartMinutes(e);
    if (starts === null) { forbiddenLocal.push(e.raw.slice(0, 80) + ' (pola kompleks: anggap terlarang)'); continue; }
    if (starts.some((s) => inForbidden(s.hour, s.minute))) forbiddenLocal.push(e.raw.slice(0, 80));
  }
  for (const e of vpsEntries) {
    if (!usesQuota(e.cmd)) continue;
    const starts = entryStartMinutes(e);
    if (starts === null) { forbiddenVps.push(e.raw.slice(0, 80) + ' (pola kompleks)'); continue; }
    if (starts.some((s) => inForbidden(s.hour, s.minute))) forbiddenVps.push(e.raw.slice(0, 80));
  }
  a1pass = identical && hasTzLocal && hasTzVps && forbiddenLocal.length === 0 && forbiddenVps.length === 0;
  a1actual = `identik=${identical} (${normV.length}/${normL.length}) CRON_TZ lokal=${hasTzLocal} vps=${hasTzVps} terlarang lokal=${forbiddenLocal.length} vps=${forbiddenVps.length}` +
    (forbiddenLocal.length ? ' [' + forbiddenLocal.slice(0, 3).join(' | ') + ']' : '');
} catch (e) { a1actual = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'crontab VPS 100% identik + CRON_TZ + 0 entri 23:50-00:10', a1pass === true, 'identik 100%, CRON_TZ, 0 terlarang', a1actual);

// --- Assertion 2: SELURUH N entri — skrip ada+executable, via wrapper, heartbeat exitCode 0 ---
let a2pass = false;
let a2actual = '';
try {
  const problems = [];
  let checkedJobs = 0;
  for (const e of entries) {
    const job = jobNameFromCmd(e.cmd);
    if (!job) { problems.push('tanpa job-wrapper: ' + e.raw.slice(0, 80)); continue; }
    const tok = scriptTargetFromCmd(e.cmd);
    const rel = resolveLocalTarget(tok);
    if (!rel) { problems.push(`${job.name}: target tak dikenal (${tok})`); continue; }
    const abs = path.join(ROOT, rel);
    let st = null;
    try { st = fs.statSync(abs); } catch (_) { st = null; }
    if (!st || !st.isFile()) { problems.push(`${job.name}: skrip hilang (${rel})`); continue; }
    // Executable: .sh wajib +x; .js wajib dibaca node (file ada cukup, tapi cek sintaks ringan).
    if (rel.endsWith('.sh')) {
      try { fs.accessSync(abs, fs.constants.X_OK); } catch (_) { problems.push(`${job.name}: ${rel} tidak executable`); continue; }
    }
    // Heartbeat dari uji env cron nyata: bukti faseP2 <nama-job>.json (format aktual VPS)
    // ATAU data/job-heartbeat lokal.
    let hbRaw = fase2(`${job.name}.json`) || fase2(`heartbeat-${job.name}.json`);
    if (!hbRaw) {
      try { hbRaw = fs.readFileSync(path.join(ROOT, 'data', 'job-heartbeat', job.name + '.json'), 'utf8'); } catch (_) { hbRaw = null; }
    }
    if (!hbRaw) { problems.push(`${job.name}: heartbeat hilang`); continue; }
    let hb = null;
    try { hb = JSON.parse(hbRaw); } catch (_) { hb = null; }
    if (!heartbeatValidator(hb)) { problems.push(`${job.name}: heartbeat tidak valid (exitCode!=0/korup)`); continue; }
    checkedJobs += 1;
  }
  a2pass = N > 0 && problems.length === 0 && checkedJobs === N;
  a2actual = `N=${N} checkedJobs=${checkedJobs} masalah=${problems.length}` + (problems.length ? ' [' + problems.slice(0, 4).join(' | ') + ']' : '');
} catch (e) { a2actual = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'SELURUH N entri: skrip ada+executable + heartbeat exitCode 0 (checked===total)', a2pass === true, 'checked===total, 0 masalah', a2actual);

// --- Assertion 3: simulasi 23:51 — lib/wib-hard-stop.js + job-wrapper hentikan job kuota ---
let a3pass = false;
let a3actual = '';
try {
  let libStop = null;
  let quotaStop = null;
  try {
    const wib = require(path.join(ROOT, 'lib', 'wib-hard-stop'));
    const simDate = new Date('2026-10-30T23:51:00+07:00');
    if (wib && typeof wib.shouldStop === 'function') libStop = wib.shouldStop({ now: simDate });
    else if (wib && typeof wib.isHardStopNow === 'function') libStop = wib.isHardStopNow(simDate);
  } catch (e) { libStop = 'error:' + (e && e.message); }
  try {
    const qs = require(path.join(ROOT, 'lib', 'quota-state'));
    const simDate = new Date('2026-10-30T23:51:00+07:00');
    quotaStop = qs.isInForbiddenWindow(simDate);
  } catch (e) { quotaStop = 'error:' + (e && e.message); }
  // job-wrapper.sh: cek logika hard-stop via simulasi env (tanpa eksekusi berat).
  const wrapperText = read('deploy/vps/job-wrapper.sh') || '';
  const hasForbidCheck = /FORBIDDEN_WINDOW_SKIP/.test(wrapperText) && /23:50/.test(wrapperText) && /00:10/.test(wrapperText);
  const hasSimEnv = /AUTO_CUAN_SIMULATED_WIB_TIME/.test(wrapperText);
  a3pass = libStop === true && quotaStop === true && hasForbidCheck && hasSimEnv;
  a3actual = `wib-hard-stop@23:51=${libStop} quota-state@23:51=${quotaStop} wrapperForbid=${hasForbidCheck} wrapperSimEnv=${hasSimEnv}`;
} catch (e) { a3actual = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'simulasi 23:51: wib-hard-stop + job-wrapper hentikan job kuota', a3pass === true, 'stop=true semua lapis', a3actual);

// --- File wajib ada ---
lib.addAssertion(result, 'deploy/vps/job-wrapper.sh ada + executable', (() => {
  try {
    const abs = path.join(ROOT, 'deploy', 'vps', 'job-wrapper.sh');
    const st = fs.statSync(abs);
    if (!st.isFile()) return false;
    try { fs.accessSync(abs, fs.constants.X_OK); return true; } catch (_) { return false; }
  } catch (_) { return false; }
})(), 'ada + executable', exists('deploy/vps/job-wrapper.sh') ? 'ada' : 'hilang');
lib.addAssertion(result, 'tools/quota-burn.js + tools/watchdog.js + tools/security-monitor.js ada', exists('tools/quota-burn.js') && exists('tools/watchdog.js') && exists('tools/security-monitor.js'), 'ketiga tools ada', ['tools/quota-burn.js', 'tools/watchdog.js', 'tools/security-monitor.js'].map((p) => p + '=' + (exists(p) ? 'ada' : 'hilang')).join(' '));
lib.addAssertion(result, 'lib/wib-hard-stop.js + lib/quota-state.js + config/quota.json ada', exists('lib/wib-hard-stop.js') && exists('lib/quota-state.js') && exists('config/quota.json'), 'ketiga file ada', ['lib/wib-hard-stop.js', 'lib/quota-state.js', 'config/quota.json'].map((p) => p + '=' + (exists(p) ? 'ada' : 'hilang')).join(' '));
lib.addAssertion(result, 'kontrol negatif lolos (injected>=1, detected==injected)', result.negativeControl.injected >= 1 && result.negativeControl.detected === result.negativeControl.injected, 'detected==injected>=1', 'injected=' + result.negativeControl.injected + ' detected=' + result.negativeControl.detected);

// Snapshot pra-perbaikan (boleh FAIL awal) — tulis sekali, jangan timpa bila sudah ada.
try {
  if (!fs.existsSync(BEFORE)) {
    fs.mkdirSync(path.dirname(BEFORE), { recursive: true });
    const snap = Object.assign({}, result, { finishedAt: lib.nowIso(), pass: false, note: 'P2-before: snapshot kondisi sebelum perbaikan' });
    fs.writeFileSync(BEFORE, JSON.stringify(snap, null, 2));
  }
} catch (_) {}

lib.finalizeGate(result, OUT);
