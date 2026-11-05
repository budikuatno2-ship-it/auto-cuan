'use strict';
const fs = require('fs');
const path = require('path');

const STAGING = 'D:\\staging-audit-roo-v3';

const checks = [
  'MANIFEST_AUDIT_V3_LENGKAP.md',
  'LAPORAN_FINAL_V3_TERVERIFIKASI.md',
  'CHECKPOINT_AUDIT_ROO.md',
  'docs/darurat/00-triage.md',
  'docs/darurat/KONTRAK.md',
  'tools/gates/gate-V3-F01.js',
  'tools/gates/gate-V3-R1.js',
  'tools/gates/gate-D1.js',
  'tmp_investigasi/konglo165.json',
  'bukti-verifikasi-final/gates-v3/F01.json',
  'bukti-verifikasi-final/gates-v3/R1.json',
  'bukti-verifikasi-final/gates/B1.json',
  'bukti-verifikasi-final/faseV3-live/01-landing-live.png',
  'bukti-verifikasi-final/faseV3-live/16-admin-console-kuota-fleksibel.png',
  'bukti-verifikasi-final/faseD1/D1-01-landing.png',
  'bukti-verifikasi-final/audit-data-963-emiten.json',
  'server.js',
  'api/ai/chat.js',
  'api/landing-snapshot.js',
  'public/index.html',
  'public/app.js',
  'public/ac.css',
  'public/chart-workstation.js',
  'lib/quota-state.js',
  'lib/security-shield.js',
  'lib/fast-bundle.js',
  'config/quota.json',
  'config/liquidity.json',
  'config/v3-f03-winning-params.json',
  'deploy/vps/final-schedule.cron',
  'data/quota-state.json',
  'data/admin-notes.json',
  'data/pending-catchup-queue.json',
  'data/completeness/latest.json',
  'GIT_AUDIT_LOG.txt'
];

let allOk = true;
for (const c of checks) {
  const p = path.join(STAGING, c);
  const exists = fs.existsSync(p);
  if (!exists) {
    console.log('[FAIL] Missing:', c);
    allOk = false;
  }
}

if (allOk) {
  console.log('[PASS] Seluruh 35 berkas percontohan krusial terverifikasi ADA di staging!');
} else {
  console.log('[FAIL] Ada berkas yang belum tersalin!');
  process.exit(1);
}
