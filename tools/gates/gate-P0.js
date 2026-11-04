'use strict';
// Gate P0 — Triage Forensik Kondisi Nyata VPS & Lokal (Read-Only) + Mesin Gate.
// Kontrak: docs/darurat/KONTRAK.md Bagian 3. PASS bila rollback-point + 00-triage
// ada (>5KB), memuat ke-6 bagian output mentah VPS, tabel 29 entri cron,
// kutipan akar masalah kuota 0 + DayTrade basi, dan lib.js lolos kontrol negatif.
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'P0.json');
const BEFORE = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'P0-before.json');

const result = lib.newResult('P0', 'Triage Forensik Kondisi Nyata VPS dan Lokal + Mesin Gate');

function read(p) {
  try {
    return fs.readFileSync(path.join(ROOT, p), 'utf8');
  } catch (_) {
    return null;
  }
}

function size(p) {
  try {
    return fs.statSync(path.join(ROOT, p)).size;
  } catch (_) {
    return -1;
  }
}

// --- Kontrol negatif: validator bukti harus MENOLAK heartbeat korup / rollback kosong ---
function evidenceValidator(sample) {
  if (!sample || typeof sample !== 'object') return false;
  if (!sample.rollbackPointBytes || sample.rollbackPointBytes < 5120) return false;
  if (!sample.triageBytes || sample.triageBytes < 5120) return false;
  if (!sample.hasCronTable || !sample.hasQuotaRoot || !sample.hasDaytradeRoot) return false;
  return true;
}

const ncSamples = [
  { description: 'heartbeat korup (bukan objek)', sample: 'CORRUPT_HEARTBEAT' },
  { description: 'rollback-point kosong di memori', sample: { rollbackPointBytes: 0, triageBytes: 0 } },
  { description: 'triage tanpa tabel cron', sample: { rollbackPointBytes: 99999, triageBytes: 99999, hasCronTable: false, hasQuotaRoot: true, hasDaytradeRoot: true } }
];
const nc = lib.runNegativeControl(ncSamples.map((s) => s.sample), evidenceValidator);
result.negativeControl = {
  description: 'Suntik heartbeat korup + rollback-point kosong + triage tanpa tabel cron di memori; validator wajib menolak ketiganya',
  injected: nc.injected,
  detected: nc.detected,
  pass: nc.injected >= 1 && nc.detected === nc.injected
};

// --- Bukti nyata ---
const rb = read('bukti-verifikasi-final/faseP0/rollback-point.txt');
const rbSize = size('bukti-verifikasi-final/faseP0/rollback-point.txt');
const tri = read('docs/darurat/00-triage.md');
const triSize = size('docs/darurat/00-triage.md');
const kontrak = read('docs/darurat/KONTRAK.md');
const gateLib = read('tools/gates/lib.js');
const runAll = read('tools/gates/run-all.js');

const has = (s, re) => (s || '').match(re) !== null;
const cronRows = tri ? (tri.match(/^\| (?:\d+|#) \|/gm) || []).length : 0;

lib.addAssertion(result, 'rollback-point.txt ada dan >5KB', rb !== null && rbSize > 5120, '>5120 bytes', rbSize + ' bytes');
lib.addAssertion(result, '00-triage.md ada dan >5KB', tri !== null && triSize > 5120, '>5120 bytes', triSize + ' bytes');
lib.addAssertion(result, 'rollback memuat branch+HEAD+pm2+crontab+timedatectl', has(rb, /rev-parse HEAD/) && has(rb, /pm2 status/i) && has(rb, /crontab -l/) && has(rb, /timedatectl/), 'ke-5 penanda rollback', (has(rb, /rev-parse HEAD/) ? 'HEAD:ya ' : 'HEAD:tidak ') + (has(rb, /pm2 status/i) ? 'pm2:ya ' : 'pm2:tidak ') + (has(rb, /crontab -l/) ? 'cron:ya ' : 'cron:tidak ') + (has(rb, /timedatectl/) ? 'time:ya' : 'time:tidak'));
lib.addAssertion(result, 'triage bagian (a) lingkungan cron mentah', has(tri, /__TIMEDATECTL__|timedatectl/) && has(tri, /CRON_TZ=Asia\/Jakarta/) && has(tri, /which node|__WHICH_NODE__/) && has(tri, /daytrade-producer\.lock|RUNNER_LOCKS/), '(a) date/timedatectl/crontab/PATH/SHELL/node/lock', 'lihat 00-triage.md (a)');
lib.addAssertion(result, 'triage bagian (b) tabel audit 29 entri cron', cronRows >= 29 && has(tri, /29 Okt/) && has(tri, /test -f|EXISTS/), '>=29 baris tabel + test -f', cronRows + ' baris tabel');
lib.addAssertion(result, 'triage bagian (c) DayTrade basi + screener error', has(tri, /daytrade-producer\.log/) && has(tri, /OUTSIDE_MARKET|after_close/) && has(tri, /COVERAGE_INSUFFICIENT|86\.28%/) && has(tri, /screener-latest\.json/), '(c) 60 baris log + pm2 + manual run + preflight', 'lihat 00-triage.md (c)');
lib.addAssertion(result, 'triage bagian (d) forensik angka kuota', has(tri, /admin-console-service\.js/) && has(tri, /8412/) && has(tri, /12060/) && has(tri, /usage\.json/), '(d) file pembaca angka + grep kuota', 'lihat 00-triage.md (d)');
lib.addAssertion(result, 'triage bagian (e) 1 request upstream + header kuota', has(tri, /UPSTREAM_STATUS=200/) && has(tri, /x-ratelimit-limit/) && has(tri, /x-ratelimit-remaining/) && has(tri, /ENV_PRESENT_ARJUM_API_KEY=true/), '(e) status 200 + header limit/remaining, tanpa secret', 'lihat 00-triage.md (e)');
lib.addAssertion(result, 'triage bagian (f) keamanan VPS', has(tri, /last -n 20|SEC_LAST/) && has(tri, /ss -tlnp|SEC_PORTS/) && has(tri, /fail2ban|SEC_FAIL2BAN/) && has(tri, /ufw|SEC_UFW/), '(f) last/authfail/ports/ufw/fail2ban', 'lihat 00-triage.md (f)');
lib.addAssertion(result, 'KONTRAK.md memuat kontrak + privasi', kontrak !== null && has(kontrak, /Bagian 2/) && has(kontrak, /Bagian 3/) && has(kontrak, /ATURAN PRIVASI/), 'Bagian 2 + 3 + privasi', (kontrak || '').length + ' bytes');
lib.addAssertion(result, 'lib.js finalizeGate ketat + run-all.js 31 gate', gateLib !== null && has(gateLib, /checked\s*===\s*result\.total/) && has(gateLib, /negativeControl/) && runAll !== null && has(runAll, /31|P30/), 'finalizeGate + run-all P0..P30', 'lib ' + (gateLib || '').length + 'B, run-all ' + (runAll || '').length + 'B');
lib.addAssertion(result, 'kontrol negatif lolos (injected>=1, detected==injected)', result.negativeControl.injected >= 1 && result.negativeControl.detected === result.negativeControl.injected, 'detected==injected>=1', 'injected=' + result.negativeControl.injected + ' detected=' + result.negativeControl.detected);

// Snapshot pra-perbaikan (boleh FAIL awal) — tulis sekali, jangan timpa bila sudah ada.
try {
  if (!fs.existsSync(BEFORE)) {
    fs.mkdirSync(path.dirname(BEFORE), { recursive: true });
    const snap = Object.assign({}, result, { finishedAt: lib.nowIso(), pass: false, note: 'P0-before: snapshot kondisi sebelum perbaikan' });
    fs.writeFileSync(BEFORE, JSON.stringify(snap, null, 2));
  }
} catch (_) {}

lib.finalizeGate(result, OUT);
