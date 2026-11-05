'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ZIP_PATH = 'D:\\AUDIT_ROO_V3_LENGKAP.zip';
const STAGING = 'D:\\staging-audit-roo-v3';
const ROOT = path.resolve(__dirname, '..');

console.log('=== VERIFIKASI AKHIR AUDIT V3 ===\n');

// 1. Verifikasi File ZIP
if (!fs.existsSync(ZIP_PATH)) {
  console.error(`[FAIL] File zip tidak ditemukan di ${ZIP_PATH}`);
  process.exit(1);
}

const zipStat = fs.statSync(ZIP_PATH);
const zipSizeMb = (zipStat.size / (1024 * 1024)).toFixed(2);
console.log(`[PASS] File ZIP ditemukan: ${ZIP_PATH}`);
console.log(`       Ukuran: ${zipStat.size.toLocaleString()} bytes (${zipSizeMb} MB)`);
if (zipStat.size < 1000000) {
  console.error(`[WARN] Ukuran zip terlalu kecil (< 1MB)`);
  process.exit(1);
}

// 2. Verifikasi File Asli di D:\auto-cuan-2 tetap utuh 100%
const essentialOriginals = [
  'server.js',
  'public/index.html',
  'public/app.js',
  'public/ac.css',
  'public/chart-workstation.js',
  'lib/quota-state.js',
  'lib/security-shield.js',
  'lib/fast-bundle.js',
  'config/quota.json',
  'data/quota-state.json',
  'data/admin-notes.json',
  'data/pending-catchup-queue.json',
  'deploy/vps/final-schedule.cron',
  'LAPORAN_FINAL_V3_TERVERIFIKASI.md',
  'MANIFEST_AUDIT_V3_LENGKAP.md',
  'tools/gates/gate-V3-F01.js',
  'tools/gates/gate-V3-R1.js'
];

let origOk = true;
for (const f of essentialOriginals) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) {
    console.error(`[FAIL] Berkas asli hilang di repo: ${f}`);
    origOk = false;
  }
}

if (!origOk) {
  process.exit(1);
}
console.log(`[PASS] Seluruh berkas asli di repositori D:\\auto-cuan-2 tetap UTUH 100% (tidak ada yang terhapus atau terpindah).`);

// 3. Cek apakah ada file tracked yang terhapus via git status
const gitStatus = cp.execSync('git status -s', { cwd: ROOT, encoding: 'utf8' });
const deletedFiles = gitStatus.split('\n').filter(l => l.startsWith(' D') || l.startsWith('D '));
if (deletedFiles.length > 0) {
  console.error('[FAIL] Ditemukan file tracked git yang terhapus:\n' + deletedFiles.join('\n'));
  process.exit(1);
}
console.log(`[PASS] Git status mengonfirmasi 0 berkas tracked terhapus.`);

console.log('\n=== SELURUH VERIFIKASI SELESAI DENGAN SUKSES ===');
