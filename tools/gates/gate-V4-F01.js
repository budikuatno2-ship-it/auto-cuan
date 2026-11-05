'use strict';

/**
 * tools/gates/gate-V4-F01.js
 * Gate Penguji Anti-Bohong FASE V4-F01:
 * - Verifikasi .roo/rules/auto-cuan-8-github-skills.md (ada, ukuran >= 40.000 bytes, dan memuat ke-8 URL GitHub).
 * - Verifikasi direktori tmp_investigasi sudah tidak ada (fs.existsSync('tmp_investigasi') === false).
 * - Verifikasi Quota Manager / endpoint internal mengembalikan data kuota riil:
 *   used >= 14371, total === 18080, remaining <= 3709, reserveFloorWeekday === 5000,
 *   weekendReserveFloor === 0, backfillLocked === true saat remaining <= 5000 sebelum 20:30 WIB.
 * - Verifikasi pembukaan kunci otomatis setelah 20:30 WIB (backfillLocked === false) dan weekend (reserveFloor === 0).
 * - Menjalankan pengujian nyata dan mencetak 'PASS: Gate V4-F01 LULUS'.
 */

const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates-v4', 'F01.json');

const result = lib.newResult(
  'V4-F01',
  'Pemasangan 8 Skill GitHub Permanen, Pembersihan tmp_investigasi, & Sinkronisasi Kuota Riil Stock Arjum'
);

// --- Kontrol Negatif (Negative Control) ---
function quotaSampleValidator(sample) {
  if (!sample || typeof sample !== 'object') return false;
  if (typeof sample.used !== 'number' || isNaN(sample.used) || sample.used < 0) return false;
  if (typeof sample.total !== 'number' || isNaN(sample.total) || sample.total <= 0) return false;
  if (typeof sample.remaining !== 'number' || isNaN(sample.remaining) || sample.remaining < 0) return false;
  if (sample.used + sample.remaining !== sample.total) return false;
  if (typeof sample.reserveFloorWeekday !== 'number' || sample.reserveFloorWeekday !== 5000) return false;
  if (typeof sample.weekendReserveFloor !== 'number' || sample.weekendReserveFloor !== 0) return false;
  if (typeof sample.backfillLocked !== 'boolean') return false;
  return true;
}

const corruptSamples = [
  null,
  { used: 'bukan_angka', total: 18080, remaining: 3709 },
  { used: -100, total: 18080, remaining: 18180 },
  { used: 14371, total: 18080, remaining: 9999 }, // used + remaining != total
  { used: 14371, total: 18080, remaining: 3709, reserveFloorWeekday: 1000 }, // wrong reserveFloorWeekday
  { used: 14371, total: 18080, remaining: 3709, reserveFloorWeekday: 5000, weekendReserveFloor: 500 }, // wrong weekendReserveFloor
  { used: 14371, total: 18080, remaining: 3709, reserveFloorWeekday: 5000, weekendReserveFloor: 0, backfillLocked: 'bukan_boolean' }
];

const nc = lib.runNegativeControl(corruptSamples, quotaSampleValidator);
result.negativeControl = {
  description: 'Suntik sampel korup (tipe salah, angka negatif, math drift, reserve floor tidak valid); validator wajib menolak',
  injected: nc.injected,
  detected: nc.detected,
  pass: nc.injected >= 1 && nc.detected === nc.injected
};

async function main() {
  console.log('[GATE V4-F01] Memulai Verifikasi Otentik...');

  // 1. Verifikasi ketiadaan direktori tmp_investigasi
  const tmpInvestigasiPath = path.join(ROOT, 'tmp_investigasi');
  const tmpExists = fs.existsSync(tmpInvestigasiPath);
  lib.addAssertion(
    result,
    'Direktori tmp_investigasi/ telah dihapus permanen dari workspace',
    tmpExists === false,
    false,
    tmpExists
  );

  // 2. Verifikasi berkas aturan .roo/rules/auto-cuan-8-github-skills.md
  const rulePath = path.join(ROOT, '.roo', 'rules', 'auto-cuan-8-github-skills.md');
  const ruleExists = fs.existsSync(rulePath);
  let ruleSize = 0;
  let ruleContent = '';

  if (ruleExists) {
    const stats = fs.statSync(rulePath);
    ruleSize = stats.size;
    ruleContent = fs.readFileSync(rulePath, 'utf8');
  }

  lib.addAssertion(
    result,
    'Berkas .roo/rules/auto-cuan-8-github-skills.md ada di workspace',
    ruleExists === true,
    true,
    ruleExists
  );

  lib.addAssertion(
    result,
    'Ukuran berkas aturan >= 40.000 bytes (spesifikasi minimal)',
    ruleSize >= 40000,
    '>= 40000 bytes',
    `${ruleSize} bytes`
  );

  // Verifikasi ke-8 URL GitHub di dalam berkas aturan
  const requiredRepos = [
    'https://github.com/nutlope/hallmark',
    'https://github.com/miqdadbadjuber/anti-slop',
    'https://github.com/pbakaus/impeccable',
    'https://github.com/cth9191/animate',
    'https://github.com/DhvanilPatel/swarm-cursors',
    'https://github.com/Tencent/BrowserSkill',
    'https://github.com/browser-use/browser-use',
    'https://github.com/NationalSecurityAgency/ghidra'
  ];

  for (const repoUrl of requiredRepos) {
    const containsRepo = ruleContent.includes(repoUrl);
    lib.addAssertion(
      result,
      `Dokumen aturan memuat referensi repositori ${repoUrl}`,
      containsRepo === true,
      true,
      containsRepo
    );
  }

  // 3. Verifikasi Quota Manager & Kuota Riil
  const quotaManagerPath = path.join(ROOT, 'lib', 'quota-manager.js');
  const qmExists = fs.existsSync(quotaManagerPath);
  lib.addAssertion(
    result,
    'Modul lib/quota-manager.js terpasang di sistem',
    qmExists === true,
    true,
    qmExists
  );

  let quotaManager = null;
  try {
    quotaManager = require(quotaManagerPath);
  } catch (err) {
    console.error('[GATE V4-F01] Gagal mengimpor lib/quota-manager.js:', err);
  }

  lib.addAssertion(
    result,
    'Modul lib/quota-manager.js dapat diimpor tanpa exception',
    quotaManager !== null,
    true,
    Boolean(quotaManager)
  );

  if (quotaManager) {
    // A. Verifikasi Status Kuota Riil Terkini
    const status = quotaManager.getQuotaStatus();
    console.log('[GATE V4-F01] Status Kuota Riil Terbaca:', {
      used: status.used,
      total: status.total,
      remaining: status.remaining,
      reserveFloorWeekday: status.reserveFloorWeekday,
      weekendReserveFloor: status.weekendReserveFloor,
      backfillLocked: status.backfillLocked
    });

    lib.addAssertion(
      result,
      'Kuota terpakai riil (used >= 14371)',
      status.used >= 14371,
      '>= 14371',
      status.used
    );

    lib.addAssertion(
      result,
      'Total kuota harian valid (total === 18080)',
      status.total === 18080,
      18080,
      status.total
    );

    lib.addAssertion(
      result,
      'Sisa kuota riil valid (remaining <= 3709)',
      status.remaining <= 3709,
      '<= 3709',
      status.remaining
    );

    lib.addAssertion(
      result,
      'Matematika kuota deterministik (used + remaining === total)',
      status.used + status.remaining === status.total,
      true,
      status.used + status.remaining === status.total
    );

    lib.addAssertion(
      result,
      'Konfigurasi reserve floor hari kerja (reserveFloorWeekday === 5000)',
      status.reserveFloorWeekday === 5000,
      5000,
      status.reserveFloorWeekday
    );

    lib.addAssertion(
      result,
      'Konfigurasi reserve floor akhir pekan (weekendReserveFloor === 0)',
      status.weekendReserveFloor === 0,
      0,
      status.weekendReserveFloor
    );

    // B. Verifikasi Hard-Lock Backfill sebelum 20:30 WIB saat remaining <= 5000
    // Menggunakan simulasi hari kerja Rabu pk 10:00 WIB (03:00 UTC)
    const daytimeSim = new Date('2026-11-04T03:00:00.000Z');
    const daytimeStatus = quotaManager.getQuotaStatus(daytimeSim);
    lib.addAssertion(
      result,
      'Hard-Lock aktif pada hari kerja sebelum 20:30 WIB saat sisa kuota <= 5.000 (backfillLocked === true)',
      daytimeStatus.backfillLocked === true,
      true,
      daytimeStatus.backfillLocked
    );

    lib.addAssertion(
      result,
      'Floor cadangan hari kerja sebelum 20:30 WIB adalah 5.000 (reserveFloor === 5000)',
      daytimeStatus.reserveFloor === 5000,
      5000,
      daytimeStatus.reserveFloor
    );

    // C. Verifikasi Pembukaan Kunci Otomatis setelah 20:30 WIB
    // Menggunakan simulasi hari kerja Rabu pk 21:00 WIB (14:00 UTC)
    const nightSim = new Date('2026-11-04T14:00:00.000Z');
    const nightStatus = quotaManager.getQuotaStatus(nightSim);
    lib.addAssertion(
      result,
      'Kunci cadangan otomatis dibuka tepat setelah 20:30 WIB hingga 23:50 WIB (backfillLocked === false)',
      nightStatus.backfillLocked === false,
      false,
      nightStatus.backfillLocked
    );

    lib.addAssertion(
      result,
      'Floor cadangan turun ke 0 setelah 20:30 WIB (reserveFloor === 0)',
      nightStatus.reserveFloor === 0,
      0,
      nightStatus.reserveFloor
    );

    // D. Verifikasi Alokasi Kuota Penuh pada Akhir Pekan (Sabtu/Minggu)
    // Menggunakan simulasi hari Sabtu pk 10:00 WIB (03:00 UTC)
    const weekendSim = new Date('2026-11-07T03:00:00.000Z');
    const weekendStatus = quotaManager.getQuotaStatus(weekendSim);
    lib.addAssertion(
      result,
      'Akhir pekan kuota penuh tidak terkunci backfill (backfillLocked === false)',
      weekendStatus.backfillLocked === false,
      false,
      weekendStatus.backfillLocked
    );

    lib.addAssertion(
      result,
      'Floor cadangan akhir pekan adalah 0 (reserveFloor === 0)',
      weekendStatus.reserveFloor === 0,
      0,
      weekendStatus.reserveFloor
    );

    // E. Verifikasi routes/admin.js mengembalikan status kuota
    const adminRoutes = require(path.join(ROOT, 'routes', 'admin.js'));
    let adminQuotaRes = null;
    const mockRes = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(data) { adminQuotaRes = JSON.parse(data); }
    };
    await adminRoutes({ url: '/quota', method: 'GET' }, mockRes);

    const hasValidAdminQuota = adminQuotaRes && adminQuotaRes.success === true && adminQuotaRes.quota && adminQuotaRes.quota.used >= 14371;
    lib.addAssertion(
      result,
      'Endpoint internal routes/admin.js mengembalikan data kuota riil',
      hasValidAdminQuota === true,
      true,
      hasValidAdminQuota
    );
  }

  // Ringkasan & Finalisasi Gate
  console.log('----------------------------------------------------');
  console.log(`[GATE V4-F01] Total Pengujian: ${result.total}`);
  console.log(`[GATE V4-F01] Berhasil (Passed): ${result.checked}`);
  console.log(`[GATE V4-F01] Negative Control Pass: ${result.negativeControl.pass}`);

  const allPassed = result.checked === result.total && result.negativeControl.pass;
  if (allPassed) {
    console.log('----------------------------------------------------');
    console.log('PASS: Gate V4-F01 LULUS');
    console.log('----------------------------------------------------');
  } else {
    console.error('FAIL: Gate V4-F01 GAGAL');
  }

  lib.finalizeGate(result, OUT);
}

main().catch((err) => {
  console.error('[GATE V4-F01] Fatal uncaught error:', err);
  process.exit(1);
});
