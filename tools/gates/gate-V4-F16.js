'use strict';

/**
 * tools/gates/gate-V4-F16.js
 * ============================================================================
 * Gate Penguji Anti-Bohong FASE V4-F16 (Fase Penutup):
 * Pembungkusan Arsip Audit Forensik Lengkap Non-Destruktif (D:\AUDIT_ROO_V4_FINAL.zip).
 *
 * 1. Kontrol Negatif (Negative Control Validator) anti-gate-gaming.
 * 2. Verifikasi berkas D:\AUDIT_ROO_V4_FINAL.zip ada dan berukuran > 2 MB (> 2.000.000 bytes).
 * 3. Verifikasi isi zip memuat:
 *    - 20 file screenshot live di faseV4-live/*.png.
 *    - File master backtest individual 964 saham: backtest-individual-964.json.
 *    - File aturan permanen 8 skill: .roo/rules/auto-cuan-8-github-skills.md.
 *    - File manifest komprehensif: MANIFEST_AUDIT_V4_LENGKAP.md.
 *    - Seluruh 16 file log hasil gate: gates-v4/F01.json s.d. gates-v4/F16.json.
 * 4. Simpan bukti otentik ke bukti-verifikasi-final/gates-v4/F16.json.
 * 5. Cetak 'PASS: Gate V4-F16 LULUS'.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates-v4', 'F16.json');
const ZIP_PATH = 'D:\\AUDIT_ROO_V4_FINAL.zip';

const result = lib.newResult(
  'V4-F16',
  'Pembungkusan Arsip Audit Forensik Lengkap Non-Destruktif (D:\\AUDIT_ROO_V4_FINAL.zip)'
);

// --- Kontrol Negatif (Negative Control Validator) ---
function f16Validator(sample) {
  if (!sample || typeof sample !== 'object') return false;
  if (typeof sample.zipExists !== 'boolean' || sample.zipExists !== true) return false;
  if (typeof sample.zipSizeBytes !== 'number' || sample.zipSizeBytes <= 2000000) return false;
  if (typeof sample.screenshotCount !== 'number' || sample.screenshotCount !== 20) return false;
  if (typeof sample.hasBacktest964 !== 'boolean' || sample.hasBacktest964 !== true) return false;
  if (typeof sample.hasSkillsRule !== 'boolean' || sample.hasSkillsRule !== true) return false;
  if (typeof sample.hasManifest !== 'boolean' || sample.hasManifest !== true) return false;
  if (typeof sample.gateLogsCount !== 'number' || sample.gateLogsCount !== 16) return false;
  return true;
}

const negativeSamples = [
  null,
  // Sampel korup 1: File ZIP tidak ada
  {
    zipExists: false,
    zipSizeBytes: 0,
    screenshotCount: 0,
    hasBacktest964: false,
    hasSkillsRule: false,
    hasManifest: false,
    gateLogsCount: 0
  },
  // Sampel korup 2: Ukuran ZIP terlalu kecil (<= 2 MB / kosong)
  {
    zipExists: true,
    zipSizeBytes: 1048576, // 1 MB
    screenshotCount: 20,
    hasBacktest964: true,
    hasSkillsRule: true,
    hasManifest: true,
    gateLogsCount: 16
  },
  // Sampel korup 3: Screenshot tidak lengkap (< 20)
  {
    zipExists: true,
    zipSizeBytes: 5000000,
    screenshotCount: 18,
    hasBacktest964: true,
    hasSkillsRule: true,
    hasManifest: true,
    gateLogsCount: 16
  },
  // Sampel korup 4: Master backtest 964 atau aturan 8 skill hilang
  {
    zipExists: true,
    zipSizeBytes: 5000000,
    screenshotCount: 20,
    hasBacktest964: false,
    hasSkillsRule: true,
    hasManifest: true,
    gateLogsCount: 16
  },
  // Sampel korup 5: Log gate kurang dari 16
  {
    zipExists: true,
    zipSizeBytes: 5000000,
    screenshotCount: 20,
    hasBacktest964: true,
    hasSkillsRule: true,
    hasManifest: true,
    gateLogsCount: 14
  }
];

const nc = lib.runNegativeControl(negativeSamples, f16Validator);
result.negativeControl = {
  description: 'Suntik sampel korup (zip absen, ukuran <= 2MB, screenshot < 20, missing rules/backtest, logs < 16); validator wajib menolak',
  injected: nc.injected,
  detected: nc.detected,
  pass: nc.injected >= 1 && nc.detected === nc.injected
};

async function main() {
  console.log('[GATE V4-F16] Memulai Verifikasi Otentik Arsip Forensik V4...');
  console.log(`[TARGET ZIP] ${ZIP_PATH}`);

  // 1. Verifikasi keberadaan file ZIP
  const zipExists = fs.existsSync(ZIP_PATH);
  lib.addAssertion(
    result,
    'Asersi 1: Berkas arsip D:\\AUDIT_ROO_V4_FINAL.zip ada di filesystem',
    zipExists === true,
    true,
    zipExists
  );

  if (!zipExists) {
    console.error(`[FAIL] Berkas ${ZIP_PATH} tidak ditemukan!`);
    lib.finalizeGate(result, OUT);
    return;
  }

  // 2. Verifikasi ukuran berkas arsip > 2 MB
  const zipStats = fs.statSync(ZIP_PATH);
  const zipSizeBytes = zipStats.size;
  const isAbove2MB = zipSizeBytes > 2000000;
  const zipSizeMB = (zipSizeBytes / (1024 * 1024)).toFixed(2);

  lib.addAssertion(
    result,
    'Asersi 2: Ukuran berkas arsip > 2.000.000 bytes (> 2 MB)',
    isAbove2MB === true,
    '> 2000000 bytes (> 2 MB)',
    `${zipSizeBytes.toLocaleString('id-ID')} bytes (${zipSizeMB} MB)`
  );

  // 3. Ekstraksi daftar entri dari dalam berkas ZIP
  let entries = [];
  try {
    const listRaw = cp.execSync(`tar -tf "${ZIP_PATH}"`, { encoding: 'utf8' });
    entries = listRaw
      .split(/\r?\n/)
      .map(s => s.trim().replace(/^\.\//, '').replace(/\\/g, '/'))
      .filter(Boolean);
  } catch (err) {
    console.error('[ERROR] Gagal membaca daftar entri ZIP:', err.message);
  }

  console.log(`[ENTRIES] Total ${entries.length} file & direktori terbaca di dalam arsip.`);

  // 4. Verifikasi 20 screenshot live faseV4-live/*.png
  const EXPECTED_SCREENSHOTS = [
    '01-url-analisis-ihsg.png',
    '02-dashboard-top5-radar.png',
    '03-screener-populated.png',
    '04-sektor-hot-conglomerates.png',
    '05-catatan-admin-clean.png',
    '06-analisis-ai-bbca-fibo.png',
    '07-chart-bbca-simple-swing.png',
    '08-chart-bbca-pro-xabcd-smc.png',
    '09-chart-ihsg-pro-xabcd.png',
    '10-bandarmologi-bbca-full.png',
    '11-sinyal-intelijen-fast.png',
    '12-broker-hunter.png',
    '13-insider-bbca-ksei-table.png',
    '14-ranking-harian-valid.png',
    '15-financial-q2.png',
    '16-struktur-pasar-freefloat.png',
    '17-watchlist-portfolio.png',
    '18-track-record-metrics.png',
    '19-pattern-radar-xabcd.png',
    '20-admin-console-f5-reload.png'
  ];

  const foundScreenshots = EXPECTED_SCREENSHOTS.filter(name =>
    entries.some(e => e.includes(`faseV4-live/${name}`) || e.endsWith(name))
  );

  lib.addAssertion(
    result,
    'Asersi 3: Arsip memuat ke-20 file screenshot bukti live di faseV4-live/*.png',
    foundScreenshots.length === 20,
    20,
    `${foundScreenshots.length}/20 screenshot ditemukan`
  );

  // 5. Verifikasi master backtest 964, aturan 8 skill, dan manifest
  const hasBacktest964 = entries.some(e => e.includes('backtest-individual-964.json'));
  const hasSkillsRule = entries.some(e => e.includes('auto-cuan-8-github-skills.md'));
  const hasManifest = entries.some(e => e.includes('MANIFEST_AUDIT_V4_LENGKAP.md'));
  const coreDocsPass = hasBacktest964 && hasSkillsRule && hasManifest;

  lib.addAssertion(
    result,
    'Asersi 4: Arsip memuat MANIFEST_AUDIT_V4_LENGKAP.md, master backtest-individual-964.json, dan aturan 8 skill',
    coreDocsPass === true,
    true,
    `backtest=${hasBacktest964}, skills=${hasSkillsRule}, manifest=${hasManifest}`
  );

  // 6. Verifikasi seluruh 16 file log hasil gate (F01 s.d. F16)
  const EXPECTED_GATES = [];
  for (let i = 1; i <= 16; i++) {
    EXPECTED_GATES.push(`F${String(i).padStart(2, '0')}.json`);
  }

  const foundGates = EXPECTED_GATES.filter(name =>
    entries.some(e => e.includes(`gates-v4/${name}`) || e.endsWith(name))
  );

  lib.addAssertion(
    result,
    'Asersi 5: Arsip memuat seluruh 16 file log hasil gate (F01.json s.d. F16.json)',
    foundGates.length === 16,
    16,
    `${foundGates.length}/16 log gate ditemukan`
  );

  // Simpan data bukti forensik ke objek hasil
  result.forensicEvidence = {
    zipPath: ZIP_PATH,
    zipSizeBytes,
    zipSizeMB: Number(zipSizeMB),
    totalEntriesCount: entries.length,
    foundScreenshotsCount: foundScreenshots.length,
    foundGatesCount: foundGates.length,
    hasBacktest964,
    hasSkillsRule,
    hasManifest,
    verifiedAtWIB: new Date(Date.now() + 7 * 3600000).toISOString().replace('Z', '+07:00')
  };

  const allPassed = result.assertions.every(a => a.pass === true);

  console.log('----------------------------------------------------');
  console.log(`[GATE V4-F16] Total Pengujian : ${result.total}`);
  console.log(`[GATE V4-F16] Berhasil Lolos  : ${result.checked}`);
  console.log(`[GATE V4-F16] Negative Control: ${result.negativeControl.pass ? 'PASS' : 'FAIL'}`);
  console.log(`[GATE V4-F16] Status Final    : ${allPassed ? 'PASS' : 'FAIL'}`);
  console.log('----------------------------------------------------');

  if (allPassed) {
    console.log('PASS: Gate V4-F16 LULUS\n');
  } else {
    console.error('FAIL: Gate V4-F16 GAGAL\n');
  }

  lib.finalizeGate(result, OUT);
}

main().catch(err => {
  console.error('[GATE V4-F16 CRASH]', err);
  process.exit(1);
});
