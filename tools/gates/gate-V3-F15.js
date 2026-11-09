'use strict';
// Gate V3-F15 — Pengambilan 16 Screenshot Bukti Nyata Live (https://autocuan.web.id) Tanpa Duplikasi.
// Kontrak:
// 1. 16 screenshot PNG nyata live tersimpan di bukti-verifikasi-final/faseV3-live/:
//    01-landing-live.png, 02-modal-login-blur.png, 03-dashboard-19-menu.png,
//    04-screener-konglo-tersaring.png, 05-screener-nonkonglo.png, 06-screener-daytrade.png,
//    07-catatan-admin-bersih-dan-tombol-hapus.png, 08-analisis-ai-fibo-dan-chat.png,
//    09-chart-smc-xabcd-BULL.png, 10-chart-zigzag-BBRI.png, 11-chart-hybrid-mode.png,
//    12-bandarmologi-lengkap.png, 13-insider-kontras-dan-ksei.png, 14-financial-BRPT-Q2.png,
//    15-pusat-akun-uji-telegram-sukses.png, 16-admin-console-kuota-fleksibel.png.
// 2. Anti-Gate-Gaming & Validasi Kualitas:
//    - Ukuran setiap berkas PNG wajib > 25 KB (> 25.000 bytes).
//    - 16 hash SHA-256 wajib unik 100% (0 duplikat).
//    - 16 ukuran byte wajib unik 100% (0 duplikat).
//    - Header magic PNG valid (89 50 4E 47 0D 0A 1A 0A).
//    - Semua asersi DOM live bernilai true.
// 3. Wajib negativeControl (injected >= 1 && detected === injected).
// 4. ATURAN BESI: dilarang polling CI GitHub/sleep, dilarang menyentuh Vercel, data riil.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const LIVE_DIR = path.join(ROOT, 'bukti-verifikasi-final', 'faseV3-live');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates-v3', 'F15.json');

const result = lib.newResult('V3-F15', 'Pengambilan 16 Screenshot Bukti Nyata Live (https://autocuan.web.id) Tanpa Duplikasi');

const EXPECTED_FILES = [
  '01-landing-live.png',
  '02-modal-login-blur.png',
  '03-dashboard-19-menu.png',
  '04-screener-konglo-tersaring.png',
  '05-screener-nonkonglo.png',
  '06-screener-daytrade.png',
  '07-catatan-admin-bersih-dan-tombol-hapus.png',
  '08-analisis-ai-fibo-dan-chat.png',
  '09-chart-smc-xabcd-BULL.png',
  '10-chart-zigzag-BBRI.png',
  '11-chart-hybrid-mode.png',
  '12-bandarmologi-lengkap.png',
  '13-insider-kontras-dan-ksei.png',
  '14-financial-BRPT-Q2.png',
  '15-pusat-akun-uji-telegram-sukses.png',
  '16-admin-console-kuota-fleksibel.png'
];

function exists(p) {
  try { return fs.existsSync(path.join(ROOT, p)); } catch (_) { return false; }
}

// Kontrol negatif: validator bukti 16 screenshot wajib MENOLAK bukti korup/duplikat/kecil.
function f15EvidenceValidator(sample) {
  if (!sample || typeof sample !== 'object') return false;
  if (!Array.isArray(sample.screenshots) || sample.screenshots.length !== 16) return false;

  const hashes = new Set();
  const sizes = new Set();

  for (const s of sample.screenshots) {
    if (!s || typeof s !== 'object') return false;
    if (typeof s.filename !== 'string' || !s.filename.endsWith('.png')) return false;
    if (typeof s.sizeBytes !== 'number' || s.sizeBytes <= 25000) return false;
    if (typeof s.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(s.sha256)) return false;
    if (hashes.has(s.sha256)) return false; // DILARANG DUPLIKAT HASH
    if (sizes.has(s.sizeBytes)) return false; // DILARANG DUPLIKAT UKURAN
    if (!s.domAssertion || s.domAssertion.pass !== true) return false;
    hashes.add(s.sha256);
    sizes.add(s.sizeBytes);
  }

  if (sample.httpStatus !== 200) return false;
  if (sample.allOver25Kb !== true) return false;
  if (sample.allUniqueHashes !== true) return false;
  if (sample.allUniqueSizes !== true) return false;
  if (sample.allAssertionsPass !== true) return false;
  return true;
}

function checkPngMagic(buffer) {
  if (!buffer || buffer.length < 8) return false;
  return (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  );
}

async function main() {
  // 1. Kontrol Negatif (Negative Control)
  const validSampleBase = () => ({
    httpStatus: 200,
    allOver25Kb: true,
    allUniqueHashes: true,
    allUniqueSizes: true,
    allAssertionsPass: true,
    screenshots: EXPECTED_FILES.map((fn, idx) => ({
      filename: fn,
      sizeBytes: 30000 + idx * 500,
      sha256: crypto.createHash('sha256').update(fn + '-' + idx).digest('hex'),
      domAssertion: { pass: true, detail: 'ok' }
    }))
  });

  const ncSamples = [
    null,
    // Kurang dari 16 screenshot
    (() => {
      const s = validSampleBase();
      s.screenshots.pop();
      return s;
    })(),
    // Duplikat hash
    (() => {
      const s = validSampleBase();
      s.screenshots[1].sha256 = s.screenshots[0].sha256;
      return s;
    })(),
    // Duplikat ukuran byte
    (() => {
      const s = validSampleBase();
      s.screenshots[1].sizeBytes = s.screenshots[0].sizeBytes;
      return s;
    })(),
    // Ukuran <= 25 KB
    (() => {
      const s = validSampleBase();
      s.screenshots[0].sizeBytes = 24999;
      return s;
    })(),
    // DOM assertion gagal
    (() => {
      const s = validSampleBase();
      s.screenshots[0].domAssertion.pass = false;
      return s;
    })(),
    // HTTP status bukan 200
    (() => {
      const s = validSampleBase();
      s.httpStatus = 500;
      return s;
    })()
  ];

  const nc = lib.runNegativeControl(ncSamples, f15EvidenceValidator);
  result.negativeControl = {
    description: 'Suntik sampel null / <16 shot / duplikat hash / duplikat ukuran / size<=25KB / DOM assert fail / HTTP!=200; validator F15 wajib menolak seluruhnya',
    injected: nc.injected,
    detected: nc.detected,
    pass: nc.injected >= 1 && nc.detected === nc.injected
  };

  // 2. Scope files ada
  const scopeFiles = [
    'tools/d1-live-verify-v3.js',
    'tools/gates/gate-V3-F15.js',
    'bukti-verifikasi-final/faseV3-live/summary.json'
  ];
  const missingScope = scopeFiles.filter((f) => !exists(f));
  lib.addAssertion(
    result,
    'scope V3-F15 selaras (d1-live-verify-v3 + gate-V3-F15 + summary.json)',
    missingScope.length === 0,
    '3/3 ada',
    missingScope.length ? ('hilang: ' + missingScope.join(',')) : '3/3 ada'
  );

  // 3. Tepat 16 screenshot PNG ada di folder bukti-verifikasi-final/faseV3-live/
  const missingShots = EXPECTED_FILES.filter((f) => !fs.existsSync(path.join(LIVE_DIR, f)));
  lib.addAssertion(
    result,
    '16/16 berkas screenshot PNG nyata live lengkap di bukti-verifikasi-final/faseV3-live/',
    missingShots.length === 0,
    '16/16 berkas ada',
    missingShots.length ? ('hilang: ' + missingShots.join(',')) : '16/16 ada'
  );

  // 4. Verifikasi ukuran setiap PNG > 25 KB
  const fileStats = [];
  const hashes = new Set();
  const sizes = new Set();
  let allOver25Kb = true;
  let allMagicValid = true;
  let duplicateHashesCount = 0;
  let duplicateSizesCount = 0;

  for (const fn of EXPECTED_FILES) {
    const fp = path.join(LIVE_DIR, fn);
    if (!fs.existsSync(fp)) continue;
    const buf = fs.readFileSync(fp);
    const stat = fs.statSync(fp);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');

    const isOver25Kb = stat.size > 25000;
    const isMagic = checkPngMagic(buf);

    if (!isOver25Kb) allOver25Kb = false;
    if (!isMagic) allMagicValid = false;

    if (hashes.has(hash)) duplicateHashesCount++;
    if (sizes.has(stat.size)) duplicateSizesCount++;

    hashes.add(hash);
    sizes.add(stat.size);

    fileStats.push({
      file: fn,
      sizeBytes: stat.size,
      sizeKb: +(stat.size / 1024).toFixed(2),
      sha256: hash,
      magicValid: isMagic
    });
  }

  lib.addAssertion(
    result,
    'ukuran seluruh 16 PNG wajib > 25 KB (> 25.000 bytes)',
    allOver25Kb === true && fileStats.length === 16,
    '16/16 > 25 KB',
    fileStats.length === 16 && allOver25Kb ? `Semua 16 file > 25 KB (min: ${Math.min(...fileStats.map(s => s.sizeBytes))} bytes)` : 'Ada file <= 25 KB'
  );

  // 5. Anti-Gate-Gaming: 16 hash SHA-256 wajib unik 100%
  lib.addAssertion(
    result,
    'anti-gate-gaming: 16 hash SHA-256 unik 100% (0 duplikat)',
    hashes.size === 16 && duplicateHashesCount === 0,
    '16/16 unik (0 duplikat)',
    `${hashes.size}/16 unik, duplikat=${duplicateHashesCount}`
  );

  // 6. Anti-Gate-Gaming: 16 ukuran byte wajib unik 100%
  lib.addAssertion(
    result,
    'anti-gate-gaming: 16 ukuran byte unik 100% (0 duplikat byte)',
    sizes.size === 16 && duplicateSizesCount === 0,
    '16/16 unik (0 duplikat)',
    `${sizes.size}/16 unik, duplikat=${duplicateSizesCount}`
  );

  // 7. Format biner PNG valid (magic byte header)
  lib.addAssertion(
    result,
    'format berkas 16 PNG valid (magic byte header 89 50 4E 47)',
    allMagicValid === true,
    '16/16 magic PNG valid',
    allMagicValid ? '16/16 valid PNG' : 'Ditemukan format biner invalid'
  );

  // 8. Pembacaan summary live & validasi DOM assertion live
  let summary = null;
  try {
    summary = JSON.parse(fs.readFileSync(path.join(LIVE_DIR, 'summary.json'), 'utf8'));
  } catch (_) {
    summary = null;
  }

  const summaryValid = !!(
    summary &&
    summary.httpStatus === 200 &&
    summary.totalScreenshots === 16 &&
    summary.allOver25Kb === true &&
    summary.allUniqueHashes === true &&
    summary.allUniqueSizes === true &&
    summary.allAssertionsPass === true
  );

  lib.addAssertion(
    result,
    'summary.json live verification: HTTP 200 + 16 DOM assertions true 100%',
    summaryValid === true,
    'HTTP 200, 16 DOM assertions PASS',
    summaryValid ? 'HTTP 200 + 16/16 DOM assertions PASS' : 'Summary invalid atau ada assertion gagal'
  );

  // 9. Kontrol negatif lolos
  lib.addAssertion(
    result,
    'kontrol negatif lolos (injected >= 1 && detected === injected)',
    result.negativeControl.pass === true,
    'injected >= 1 && detected === injected',
    `injected=${result.negativeControl.injected}, detected=${result.negativeControl.detected}`
  );

  result.liveEvidence = {
    summary,
    files: fileStats
  };

  lib.finalizeGate(result, OUT);
  return result;
}

main().catch((err) => {
  try {
    lib.addAssertion(result, 'gate V3-F15 tidak crash', false, 'no crash', String((err && err.message) || err));
    lib.finalizeGate(result, OUT);
  } catch (_) {
    process.exit(1);
  }
});
