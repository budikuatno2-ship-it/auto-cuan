'use strict';

/**
 * tools/gates/gate-V4-F14.js
 * ============================================================================
 * Gate Penguji Anti-Bohong FASE V4-F14:
 * Deployment Penuh ke VPS Produksi (168.110.221.197), Sinkronisasi Database/JSON,
 * Kompilasi di VPS, Reload PM2, & Verifikasi HTTP Langsung https://autocuan.web.id.
 *
 * 1. Kontrol Negatif (Negative Control Validator) anti-gate-gaming.
 * 2. Verifikasi Git Commit Hash Lokal vs VPS via SSH:
 *    localCommit === vpsCommit (100% identik).
 * 3. Verifikasi Status PM2 via SSH:
 *    Semua daemon auto-cuan berstatus 'online' tanpa looping crash.
 * 4. Verifikasi HTTP Langsung Produksi ke https://autocuan.web.id/api/admin/quota-status:
 *    Status 200 OK, used >= 14371, total === 18080.
 * 5. Verifikasi HTTP Langsung Produksi ke https://autocuan.web.id/api/version:
 *    Status 200 OK, kode V4 Final aktif.
 * 6. Verifikasi HTTP Langsung Produksi ke https://autocuan.web.id/api/fast-bundle?tickers=BBCA:
 *    Status 200 OK, dataset fast-bundle terisi lengkap.
 * 7. Simpan bukti otentik ke bukti-verifikasi-final/gates-v4/F14.json.
 * 8. Cetak 'PASS: Gate V4-F14 LULUS'.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates-v4', 'F14.json');

const SSH_KEY = 'D:/Private Key Oracle/ssh-key-2026-07-02.key';
const VPS_HOST = '168.110.221.197';
const VPS_USER = 'ubuntu';

const result = lib.newResult(
  'V4-F14',
  'Deployment Penuh VPS Produksi, Sinkronisasi Kode & Dataset, Reload PM2, & Verifikasi Live HTTP'
);

// --- Kontrol Negatif (Negative Control Validator) ---
function f14Validator(sample) {
  if (!sample || typeof sample !== 'object') return false;
  if (!sample.localCommit || !sample.vpsCommit || sample.localCommit !== sample.vpsCommit) return false;
  if (typeof sample.pm2AllOnline !== 'boolean' || sample.pm2AllOnline !== true) return false;
  if (typeof sample.httpQuotaStatusOk !== 'boolean' || sample.httpQuotaStatusOk !== true) return false;
  if (typeof sample.quotaUsed !== 'number' || sample.quotaUsed < 14371) return false;
  if (typeof sample.quotaTotal !== 'number' || sample.quotaTotal !== 18080) return false;
  if (typeof sample.httpVersionOk !== 'boolean' || sample.httpVersionOk !== true) return false;
  if (typeof sample.httpFastBundleOk !== 'boolean' || sample.httpFastBundleOk !== true) return false;
  return true;
}

const negativeSamples = [
  null,
  // Sampel korup 1: Commit hash lokal dan VPS tidak cocok (desinkronisasi)
  {
    localCommit: '931f86fb83c2d289c4121a1c845b16300feb58d4',
    vpsCommit: '27cafd6182b7fa3f0d655866bf0345c268ddb8fc',
    pm2AllOnline: true,
    httpQuotaStatusOk: true,
    quotaUsed: 14371,
    quotaTotal: 18080,
    httpVersionOk: true,
    httpFastBundleOk: true
  },
  // Sampel korup 2: PM2 daemon crash / offline
  {
    localCommit: '931f86fb83c2d289c4121a1c845b16300feb58d4',
    vpsCommit: '931f86fb83c2d289c4121a1c845b16300feb58d4',
    pm2AllOnline: false,
    httpQuotaStatusOk: true,
    quotaUsed: 14371,
    quotaTotal: 18080,
    httpVersionOk: true,
    httpFastBundleOk: true
  },
  // Sampel korup 3: HTTP Quota status gagal / kuota palsu
  {
    localCommit: '931f86fb83c2d289c4121a1c845b16300feb58d4',
    vpsCommit: '931f86fb83c2d289c4121a1c845b16300feb58d4',
    pm2AllOnline: true,
    httpQuotaStatusOk: false,
    quotaUsed: 3610,
    quotaTotal: 18080,
    httpVersionOk: true,
    httpFastBundleOk: true
  },
  // Sampel korup 4: Total kuota bukan 18080
  {
    localCommit: '931f86fb83c2d289c4121a1c845b16300feb58d4',
    vpsCommit: '931f86fb83c2d289c4121a1c845b16300feb58d4',
    pm2AllOnline: true,
    httpQuotaStatusOk: true,
    quotaUsed: 14371,
    quotaTotal: 10000,
    httpVersionOk: true,
    httpFastBundleOk: true
  }
];

function fetchHttps(urlStr) {
  return new Promise((resolve, reject) => {
    https.get(urlStr, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (_) {}
        resolve({ statusCode: res.statusCode, raw: data, json: parsed });
      });
    }).on('error', reject);
  });
}

function runSsh(remoteCmd) {
  const sshCmd = `ssh -n -o BatchMode=yes -o ConnectTimeout=15 -i "${SSH_KEY}" ${VPS_USER}@${VPS_HOST} "${remoteCmd}"`;
  return execSync(sshCmd, { encoding: 'utf8', timeout: 30000 }).trim();
}

async function main() {
  console.log('=============================================================');
  console.log(' GATE V4-F14: DEPLOYMENT PENUH KE VPS PRODUKSI (168.110.221.197)');
  console.log('=============================================================\n');

  // 1. Kontrol Negatif (Negative Controls)
  console.log('[1/6] Menjalankan uji kontrol negatif anti-gaming...');
  const nc = lib.runNegativeControl(negativeSamples, f14Validator);
  result.negativeControl = {
    description: 'Injeksi 4 sampel cacat (mismatched commit, pm2 crash, kuota salah, total kuota salah); validator wajib menolak 100%',
    injected: nc.injected,
    detected: nc.detected,
    pass: nc.injected >= 1 && nc.detected === nc.injected
  };
  lib.addAssertion(
    result,
    'Negative Control Anti-Gaming',
    result.negativeControl.pass,
    'Semua sampel korup terdeteksi (' + nc.injected + ')',
    'Terdeteksi: ' + nc.detected + ' / ' + nc.injected
  );

  // 2. Verifikasi Git Commit Hash Lokal vs VPS
  console.log('[2/6] Memverifikasi commit hash lokal vs VPS via SSH...');
  const localCommit = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  const vpsCommit = runSsh('cd /home/ubuntu/auto-cuan && git rev-parse HEAD');

  console.log(`  - Local Git Commit : ${localCommit}`);
  console.log(`  - VPS Git Commit   : ${vpsCommit}`);
  const commitMatch = Boolean(localCommit && vpsCommit && localCommit === vpsCommit);
  lib.addAssertion(
    result,
    'Git Commit Parity Local vs VPS (100% Identik)',
    commitMatch,
    localCommit,
    vpsCommit
  );

  // 3. Verifikasi PM2 Daemons Online via SSH
  console.log('[3/6] Memeriksa status PM2 daemons di VPS...');
  const pm2Raw = runSsh('pm2 jlist');
  let pm2List = [];
  try {
    pm2List = JSON.parse(pm2Raw);
  } catch (err) {
    console.error('Gagal mem-parse output pm2 jlist:', err.message);
  }

  const monitoredDaemons = [
    'auto-cuan-scheduler',
    'auto-cuan-vps-api',
    'autocuan-bot',
    'autocuan-verify-bot',
    'autocuan-web',
    'autocuan-web-tunnel'
  ];

  const daemonStatuses = {};
  let pm2AllOnline = pm2List.length >= monitoredDaemons.length;

  for (const name of monitoredDaemons) {
    const proc = pm2List.find(p => p.name === name);
    const st = (proc && proc.pm2_env && proc.pm2_env.status) || 'unknown';
    daemonStatuses[name] = st;
    if (st !== 'online') {
      pm2AllOnline = false;
    }
  }

  console.log('  - PM2 Daemon Statuses:', JSON.stringify(daemonStatuses));
  lib.addAssertion(
    result,
    'PM2 Process Status (All Monitored Daemons Online)',
    pm2AllOnline,
    'All online (6 daemons)',
    JSON.stringify(daemonStatuses)
  );

  // 4. Verifikasi HTTP Live: /api/admin/quota-status
  console.log('[4/6] Menghubungi https://autocuan.web.id/api/admin/quota-status...');
  const quotaRes = await fetchHttps('https://autocuan.web.id/api/admin/quota-status');
  console.log(`  - HTTP Status: ${quotaRes.statusCode}`);
  const quotaJson = quotaRes.json || {};
  const quotaUsed = Number(quotaJson.used || 0);
  const quotaTotal = Number(quotaJson.total || 0);
  const quotaRemaining = Number(quotaJson.remaining || 0);
  console.log(`  - Quota: used=${quotaUsed}, total=${quotaTotal}, remaining=${quotaRemaining}`);

  const httpQuotaStatusOk = (
    quotaRes.statusCode === 200 &&
    quotaUsed >= 14371 &&
    quotaTotal === 18080
  );
  lib.addAssertion(
    result,
    'Live Endpoint /api/admin/quota-status (200 OK, used >= 14371, total === 18080)',
    httpQuotaStatusOk,
    'status: 200, used >= 14371, total === 18080',
    `status: ${quotaRes.statusCode}, used: ${quotaUsed}, total: ${quotaTotal}`
  );

  // 5. Verifikasi HTTP Live: /api/version
  console.log('[5/6] Menghubungi https://autocuan.web.id/api/version...');
  const versionRes = await fetchHttps('https://autocuan.web.id/api/version');
  console.log(`  - HTTP Status: ${versionRes.statusCode}`);
  const versionJson = versionRes.json || {};
  console.log(`  - Version Data: version=${versionJson.version}, release=${versionJson.release}`);

  const httpVersionOk = (
    versionRes.statusCode === 200 &&
    versionJson.version === 'v4-final' &&
    versionJson.active === true
  );
  lib.addAssertion(
    result,
    'Live Endpoint /api/version (200 OK, v4-final Active)',
    httpVersionOk,
    'status: 200, version: v4-final, active: true',
    `status: ${versionRes.statusCode}, version: ${versionJson.version}, active: ${versionJson.active}`
  );

  // 6. Verifikasi HTTP Live: /api/fast-bundle?tickers=BBCA
  console.log('[6/6] Menghubungi https://autocuan.web.id/api/fast-bundle?tickers=BBCA...');
  const bundleRes = await fetchHttps('https://autocuan.web.id/api/fast-bundle?tickers=BBCA');
  console.log(`  - HTTP Status: ${bundleRes.statusCode}`);
  const bundleJson = bundleRes.json || {};
  const bbcaBundle = bundleJson.bundles && bundleJson.bundles.BBCA;
  const candleCount = Number(bbcaBundle ? (bbcaBundle.candle_count || (Array.isArray(bbcaBundle.candles_120) && bbcaBundle.candles_120.length)) : 0);
  const hasCandles = candleCount >= 100;
  const hasIndicators = Boolean(bbcaBundle && bbcaBundle.indicators && (bbcaBundle.indicators.rsi_wilder_14 != null || bbcaBundle.indicators.atr_14 != null));
  const hasFib = Boolean(bbcaBundle && (bbcaBundle.fib_9_lines != null || bbcaBundle.fib != null));

  const httpFastBundleOk = (
    bundleRes.statusCode === 200 &&
    bundleJson.success === true &&
    hasCandles &&
    hasIndicators &&
    hasFib
  );
  lib.addAssertion(
    result,
    'Live Endpoint /api/fast-bundle?tickers=BBCA (200 OK, 120 Candles, Indikator & Fib Valid)',
    httpFastBundleOk,
    'status: 200, success: true, candles >= 100, indicators & fib valid',
    `status: ${bundleRes.statusCode}, candles: ${candleCount}`
  );

  // Validasi Sampel Positif Akhir
  const positiveSample = {
    localCommit,
    vpsCommit,
    pm2AllOnline,
    httpQuotaStatusOk,
    quotaUsed,
    quotaTotal,
    httpVersionOk,
    httpFastBundleOk
  };
  const posOk = f14Validator(positiveSample);
  lib.addAssertion(
    result,
    'Positive Validator Verification',
    posOk,
    'f14Validator accepts genuine system state',
    `posOk: ${posOk}`
  );

  result.details = {
    localCommit,
    vpsCommit,
    commitMatch,
    pm2AllOnline,
    daemonStatuses,
    httpQuotaStatus: {
      status: quotaRes.statusCode,
      used: quotaUsed,
      total: quotaTotal,
      remaining: quotaRemaining
    },
    httpVersion: versionJson,
    httpFastBundle: {
      status: bundleRes.statusCode,
      bbcaCandlesCount: candleCount,
      indicatorsPresent: hasIndicators,
      fibonacciPresent: hasFib
    },
    verifiedAtWIB: new Date(Date.now() + 7 * 3600000).toISOString().replace('Z', '+07:00')
  };

  // Rekapitulasi & Output
  console.log('\n=============================================================');
  console.log('                 HASIL AKHIR GATE V4-F14');
  console.log('=============================================================');
  result.assertions.forEach((a, i) => {
    console.log(`  ${i + 1}. [${a.pass ? 'PASS' : 'FAIL'}] ${a.name} (Aktual: ${a.actual})`);
  });
  console.log(`Total Asersi: ${result.total} | Lolos: ${result.checked}`);
  console.log('=============================================================\n');

  const allPassed = result.assertions.length > 0 && result.assertions.every(a => a.pass);
  if (allPassed) {
    console.log('PASS: Gate V4-F14 LULUS');
  } else {
    console.error('FAIL: Gate V4-F14 GAGAL');
    process.exitCode = 1;
  }

  // Simpan Bukti Otentik
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  lib.finalizeGate(result, OUT);
}

if (require.main === module) {
  main().catch(err => {
    console.error('[GATE V4-F14 ERROR]', err);
    process.exit(1);
  });
}

module.exports = {
  f14Validator,
  negativeSamples
};
