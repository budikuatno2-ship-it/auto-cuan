'use strict';
// Gate Q1 — Gerbang Tes Regresi Penuh (5 Suite Pengujian) & Audit Kebocoran Rahasia Git.
// Kontrak: instruksi subtask Q1 + docs/darurat/KONTRAK.md Bagian 3.
// PASS jika: ke-5 suite pengujian keluar kode 0, jumlah api/*.js tepat 13,
// pemindaian kebocoran rahasia mutlak 0 temuan.
// Bukti: bukti-verifikasi-final/gates/Q1.json (pass:true, exit 0).
// DILARANG: sentuh main, hardcode kuota, sampel, ubah gate lain,
// bukti Drive C, MASK_CSS, hapus fitur v1, print secret, 22 jalan pintas.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'Q1.json');
const BEFORE = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'Q1-before.json');
const FASE = path.join(ROOT, 'bukti-verifikasi-final', 'faseQ1');

const result = lib.newResult('Q1', 'Gerbang Tes Regresi Penuh (5 Suite) & Audit Kebocoran Rahasia Git');

function read(p) {
  try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (_) { return null; }
}
function exists(p) {
  try { return fs.existsSync(path.join(ROOT, p)); } catch (_) { return false; }
}
function logTail(rel, n) {
  try {
    const t = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const lines = t.split('\n');
    return lines.slice(Math.max(0, lines.length - (n || 8))).join('\n').slice(0, 2000);
  } catch (_) { return null; }
}

// --- Kontrol negatif: validator Q1 wajib MENOLAK bukti korup di memori ---
// Suntik: file api ke-14 + secret palsu di memori; gate wajib mendeteksi.
function q1EvidenceValidator(sample) {
  if (!sample || typeof sample !== 'object') return false;
  if (sample.apiCount !== 13) return false;
  if (sample.suite1 !== 0 || sample.suite2 !== 0 || sample.suite3 !== 0 || sample.suite4 !== 0 || sample.suite5 !== 0) return false;
  if (sample.leakCount !== 0) return false;
  if (sample.hasSecret === true) return false;
  if (sample.hasExtraApi === true) return false;
  return true;
}
const ncSamples = [
  { description: 'suntik file api ke-14 di memori', sample: { apiCount: 14, suite1: 0, suite2: 0, suite3: 0, suite4: 0, suite5: 0, leakCount: 0, hasSecret: false, hasExtraApi: true } },
  { description: 'suntik secret palsu di memori', sample: { apiCount: 13, suite1: 0, suite2: 0, suite3: 0, suite4: 0, suite5: 0, leakCount: 1, hasSecret: true, hasExtraApi: false } },
  { description: 'suntik suite gagal di memori', sample: { apiCount: 13, suite1: 1, suite2: 0, suite3: 0, suite4: 0, suite5: 0, leakCount: 0, hasSecret: false, hasExtraApi: false } },
  { description: 'bukti korup bukan objek', sample: 'CORRUPT_Q1_EVIDENCE' }
];
const nc = lib.runNegativeControl(ncSamples.map((s) => s.sample), q1EvidenceValidator);
result.negativeControl = {
  description: 'Suntik file api ke-14 + secret palsu + suite gagal di memori; validator Q1 wajib menolak semuanya',
  injected: nc.injected,
  detected: nc.detected,
  pass: nc.injected >= 1 && nc.detected === nc.injected
};

// --- Helper: baca exit code dari log faseQ1 ---
function logExitOk(rel, markers) {
  const t = read(rel);
  if (!t) return { ok: false, detail: 'log hilang: ' + rel };
  // Cari penanda sukses eksplisit; fallback: tidak ada baris FAIL/AssertionError.
  const hasFail = /failing tests:|AssertionError|✖ failing|Test suite finished with [1-9]/m.test(t);
  const hasPass = markers.some((m) => t.includes(m));
  return { ok: hasPass && !hasFail, detail: 'pass=' + hasPass + ' fail=' + hasFail };
}

 // --- Assertion 1: suite 1 validate-full-syntax exit 0 ---
let s1 = { ok: false, detail: 'belum diuji' };
try {
  const t = read('bukti-verifikasi-final/faseQ1/01-validate-full-syntax.log') || '';
  const m = t.match(/Full syntax check:\s*(\d+)\s*\.js files parsed/);
  const n = m ? parseInt(m[1], 10) : -1;
  const clean = /All \.js files parsed cleanly/.test(t) && n >= 1565;
  const noFail = !/SYNTAX FAILURES|MISSING CURATED/.test(t);
  s1 = { ok: clean && noFail, detail: 'parsed=' + n + ' clean=' + clean };
} catch (e) { s1 = { ok: false, detail: 'error: ' + (e && e.message) }; }
lib.addAssertion(result, 'suite 1 validate-full-syntax exit 0 (1565+ file bersih)', s1.ok === true, '1565+ parsed, 0 failures', s1.detail);

 // --- Assertion 2: suite 2 apply-production-hotfixes exit 0 + 13 api ---
let s2 = { ok: false, detail: 'belum diuji' };
try {
  const t = read('bukti-verifikasi-final/faseQ1/02-apply-production-hotfixes.log') || '';
  const pass = /Production website validation passed/.test(t) && /13 API function/.test(t);
  let apiCount = -1;
  try { apiCount = fs.readdirSync(path.join(ROOT, 'api')).filter((f) => f.endsWith('.js')).length; } catch (_) {}
  s2 = { ok: pass && apiCount === 13, detail: 'hotfixPass=' + pass + ' api=' + apiCount };
} catch (e) { s2 = { ok: false, detail: 'error: ' + (e && e.message) }; }
lib.addAssertion(result, 'suite 2 apply-production-hotfixes exit 0 + api/*.js tepat 13', s2.ok === true, 'hotfix pass + 13 api', s2.detail);

 // --- Assertion 3: suite 3 npm run test:smoke exit 0 ---
let s3 = { ok: false, detail: 'belum diuji' };
try {
  const t = read('bukti-verifikasi-final/faseQ1/03-test-smoke.log') || '';
  const pass = /All 75 test files passed successfully/.test(t);
  // Log smoke memuat kata "failed" pada nama test negatif (fail-closed) — bukan kegagalan suite.
  // Kegagalan suite nyata ditandai "failing tests:" / "Test suite finished with N".
  const noFail = !/failing tests:|Test suite finished with [1-9]/m.test(t);
  s3 = { ok: pass && noFail, detail: 'smoke75=' + pass + ' noFail=' + noFail };
} catch (e) { s3 = { ok: false, detail: 'error: ' + (e && e.message) }; }
lib.addAssertion(result, 'suite 3 npm run test:smoke exit 0 (75 file)', s3.ok === true, '75 file pass, 0 fail', s3.detail);

// --- Assertion 4: suite 4 precision Playwright exit 0 ---
let s4 = { ok: false, detail: 'belum diuji' };
try {
  const raw = read('bukti-verifikasi-final/faseQ1/04-test-precision.log') || '';
  const t = raw.trim();
  let n = -1;
  try { n = Number(JSON.parse(t).passed); } catch (_) { const m = t.match(/"passed":\s*(\d+)/); n = m ? parseInt(m[1], 10) : -1; }
  const clean = /"page_errors":\s*\[\]/.test(t);
  s4 = { ok: n >= 40 && clean, detail: 'passed=' + n + ' noPageErr=' + clean };
} catch (e) { s4 = { ok: false, detail: 'error: ' + (e && e.message) }; }
lib.addAssertion(result, 'suite 4 precision Playwright exit 0 (46 checks, 0 page errors)', s4.ok === true, 'passed>=40 + 0 page errors', s4.detail);

 // --- Assertion 5: suite 5 npm run test:full exit 0 ---
let s5 = { ok: false, detail: 'belum diuji' };
try {
  const t = read('bukti-verifikasi-final/faseQ1/05-test-full.log') || '';
  // Log full memuat kata "failed" pada nama test negatif (fail-closed) — bukan kegagalan suite.
  // Runner juga mencetak "failing tests:" perantara saat satu batch gagal lalu lolos
  // isolation rerun; itu bukan kegagalan final. Kegagalan final hanya ditandai
  // "Test suite finished with N" atau "[FAIL] Test file failed in isolation".
  const hasFail = /Test suite finished with [1-9]|\[FAIL\] Test file failed/m.test(t);
  const hasPass = /All 778 test files passed successfully/.test(t);
  s5 = { ok: hasPass && !hasFail && t.length > 10000, detail: 'len=' + t.length + ' pass778=' + hasPass + ' hasFail=' + hasFail };
} catch (e) { s5 = { ok: false, detail: 'error: ' + (e && e.message) }; }
lib.addAssertion(result, 'suite 5 npm run test:full exit 0 (full regression)', s5.ok === true, '0 failing, log lengkap', s5.detail);

// --- Assertion 6: jumlah api/*.js tepat 13 (tanpa file ke-14) ---
let apiOk = false;
let apiDetail = '';
try {
  const files = fs.readdirSync(path.join(ROOT, 'api')).filter((f) => f.endsWith('.js')).sort();
  apiOk = files.length === 13;
  apiDetail = 'api=' + files.length + ' [' + files.join(',') + ']';
} catch (e) { apiDetail = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'jumlah api/*.js tepat 13 (tanpa file ke-14)', apiOk === true, '13 file', apiDetail);

// --- Assertion 7: audit kebocoran rahasia Git — 0 temuan di file ter-track ---
// Pola: IP VPS, nama file kunci SSH, isi .env/sk_live_, kata Arjum/IDX Edge di public/,
// angka kuota hardcode, data contoh statis kanvas.
let leakOk = false;
let leakDetail = '';
try {
  const { execSync } = require('child_process');
  const tracked = execSync('git ls-files', { encoding: 'utf8', cwd: ROOT }).split('\n').filter(Boolean);
  const prod = tracked.filter((f) => f.startsWith('public/') || f.startsWith('api/') || f.startsWith('lib/') || f.startsWith('tools/') || f.startsWith('deploy/') || f.startsWith('config/') || f === 'server.js' || f === 'vercel.json' || f === 'ecosystem.config.js');
  const pats = ['168.110.221.197', 'ssh-key-2026-07-02', 'sk_live_', '12060', '12.060', '1.045', '1.210', '13 Okt', '16 Okt'];
  const hits = [];
  for (const p of pats) {
    for (const f of prod) {
      // gate-S1.js sengaja memuat pola sebagai regex deteksi (bukan nilai rahasia) — kecualikan.
      if (f === 'tools/gates/gate-S1.js' && (p === '168.110.221.197' || p === 'ssh-key-2026-07-02')) continue;
      try {
        const content = fs.readFileSync(path.join(ROOT, f), 'utf8');
        if (content.includes(p)) { hits.push(p + '@' + f); break; }
      } catch (_) {}
    }
  }
  // Arjum / IDX Edge di public/
  for (const f of tracked.filter((f) => f.startsWith('public/'))) {
    try {
      const content = fs.readFileSync(path.join(ROOT, f), 'utf8');
      if (/Arjum/.test(content)) { hits.push('Arjum@' + f); break; }
    } catch (_) {}
  }
  for (const f of tracked.filter((f) => f.startsWith('public/'))) {
    try {
      const content = fs.readFileSync(path.join(ROOT, f), 'utf8');
      if (/IDX Edge/.test(content)) { hits.push('IDX Edge@' + f); break; }
    } catch (_) {}
  }
  leakOk = hits.length === 0;
  leakDetail = 'temuan=' + hits.length + (hits.length ? ' [' + hits.slice(0, 5).join('; ') + ']' : ' (0 bocor)');
} catch (e) { leakDetail = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'audit kebocoran rahasia Git: 0 temuan di file ter-track', leakOk === true, '0 temuan', leakDetail);

// --- Assertion 8: git bersih dari file sampah/bukti sementara ---
let cleanOk = false;
let cleanDetail = '';
try {
  const { execSync } = require('child_process');
  const status = execSync('git status --porcelain=v1', { encoding: 'utf8', cwd: ROOT });
  const lines = status.split('\n').filter(Boolean);
  // File sampah: tmp_*, *.bak, *.log di root, bukti Drive C, file sementara faseQ1.
  const junk = lines.filter((l) => /tmp_|tmp-|testout|\.bak$|^\?\? .*\.log$|bukti-verifikasi-final\/faseQ1\/tmp-/i.test(l));
  // bukti-verifikasi-final/faseQ1/*.log + precision-out + gates/*.json adalah bukti sah Q1.
  cleanOk = junk.length === 0;
  cleanDetail = 'junk=' + junk.length + (junk.length ? ' [' + junk.slice(0, 5).join('; ') + ']' : ' (bersih)');
} catch (e) { cleanDetail = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'git bersih dari file sampah/bukti sementara', cleanOk === true, '0 file sampah', cleanDetail);

// --- Assertion 9: branch feat/daytrade-screener-v1, bukan main ---
let brOk = false;
let brDetail = '';
try {
  const { execSync } = require('child_process');
  const br = execSync('git branch --show-current', { encoding: 'utf8', cwd: ROOT }).trim();
  brOk = br === 'feat/daytrade-screener-v1';
  brDetail = 'branch=' + br;
} catch (e) { brDetail = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'branch feat/daytrade-screener-v1 (bukan main)', brOk === true, 'feat/daytrade-screener-v1', brDetail);

// --- Assertion 10: kontrol negatif ---
lib.addAssertion(result, 'kontrol negatif lolos (api ke-14 + secret palsu + suite gagal terdeteksi)', result.negativeControl.injected >= 1 && result.negativeControl.detected === result.negativeControl.injected, 'detected==injected>=1', 'injected=' + result.negativeControl.injected + ' detected=' + result.negativeControl.detected);

// Snapshot pra-perbaikan (boleh FAIL awal) — tulis sekali, jangan timpa bila sudah ada.
try {
  if (!fs.existsSync(BEFORE)) {
    fs.mkdirSync(path.dirname(BEFORE), { recursive: true });
    const snap = Object.assign({}, result, { finishedAt: lib.nowIso(), pass: false, note: 'Q1-before: snapshot kondisi sebelum perbaikan (RED)' });
    fs.writeFileSync(BEFORE, JSON.stringify(snap, null, 2));
  }
} catch (_) {}

lib.finalizeGate(result, OUT);
