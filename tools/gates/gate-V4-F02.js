'use strict';

/**
 * tools/gates/gate-V4-F02.js
 * Gate Penguji Anti-Bohong FASE V4-F02:
 * 1. Simulasi pengiriman pesan teks watchdog/heartbeat ke channel sinyal diblokir secara terbukti (blocked === true).
 * 2. Simulasi pengiriman pesan sinyal sah (DAY TRADE: ...) tetap lolos (allowed === true).
 * 3. Pengiriman alert kritis hanya diarahkan ke Chat ID Admin 6396446903.
 * 4. Konfigurasi stale threshold job harian di scripts/watchdog.js terbukti >= 1560 menit.
 * 5. Seluruh file di data/heartbeats/*.json berukuran > 20 bytes, berformat JSON valid, dan 0 file heartbeat zombie.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates-v4', 'F02.json');

const result = lib.newResult(
  'V4-F02',
  'Pembungkaman Total Spam Watchdog di Grup Telegram Signal Saham & Perbaikan Heartbeat Cron WIB'
);

const notifier = require(path.join(ROOT, 'lib', 'telegram-notifier'));
const watchdog = require(path.join(ROOT, 'scripts', 'watchdog'));
const heartbeatRecorder = require(path.join(ROOT, 'lib', 'heartbeat-recorder'));

// --- Kontrol Negatif (Negative Control) ---
// Injeksi pesan yang seharusnya DITOLAK / DIBLOKIR:
// - Kirim teks WATCHDOG ke channel sinyal (bukan admin) -> wajib ditolak (allowed=false, blocked=true)
// - Kirim teks HEARTBEAT ke channel sinyal -> wajib ditolak
// - Kirim STATUS: KUNING ke admin -> wajib ditolak (hanya boleh kritis MERAH)
// - Kirim STATUS: HIJAU ke admin -> wajib ditolak
// - Kirim teks CRON ke channel sinyal -> wajib ditolak
function spamFilterValidator(sample) {
  if (!sample || typeof sample !== 'object') return false;
  const res = notifier.validateTelegramMessageDestination(sample.text, sample.chatId);
  return res.allowed === true;
}

const negativeSpamSamples = [
  { text: '🚨 WATCHDOG OPERASIONAL: 1 insiden', chatId: '-1001234567890' },
  { text: 'HEARTBEAT: broksum-1945 failure', chatId: '-1001234567890' },
  { text: 'CRON: fastwatcher failed to execute', chatId: '-1001234567890' },
  { text: 'STATUS: KUNING - warning heartbeat delay', chatId: '6396446903' },
  { text: 'STATUS: HIJAU - all systems nominal', chatId: '6396446903' },
  { text: 'INFRASTRUKTUR: Memory usage high', chatId: '-1001234567890' },
  { text: 'Heartbeat stale alert', chatId: null } // default TELEGRAM_CHAT_ID (signal group)
];

const nc = lib.runNegativeControl(negativeSpamSamples, spamFilterValidator);
result.negativeControl = {
  description: 'Injeksi pesan spam watchdog/heartbeat/cron/kuning/hijau; validator wajib menolak dan memblokir',
  injected: nc.injected,
  detected: nc.detected,
  pass: nc.injected >= 1 && nc.detected === nc.injected
};

async function main() {
  console.log('[GATE V4-F02] Memulai Verifikasi Otentik...');

  // -------------------------------------------------------------------------
  // 1. Verifikasi Pemblokiran Spam Watchdog/Heartbeat ke Channel Sinyal Publik
  // -------------------------------------------------------------------------
  const channelChatId = '-100987654321'; // Representasi grup sinyal publik
  const blockedCases = [
    '🚨 WATCHDOG OPERASIONAL — 2 insiden',
    'HEARTBEAT: daytrade-producer terlambat',
    'STATUS: KUNING — Kuota API data drift',
    'STATUS: HIJAU — cron pulih',
    'INFRASTRUKTUR: Disk usage 88%',
    'CRON: Daily update exit with error'
  ];

  let allBlocked = true;
  const blockDetails = [];

  for (const msg of blockedCases) {
    const val = notifier.validateTelegramMessageDestination(msg, channelChatId);
    const sendRes = await notifier.sendTelegramMessage(msg, { chat_id: channelChatId });

    const isValBlocked = val.blocked === true && val.allowed === false;
    const isSendBlocked = sendRes.blocked === true && sendRes.sent === false;

    if (!isValBlocked || !isSendBlocked) {
      allBlocked = false;
    }
    blockDetails.push({
      message: msg.slice(0, 30),
      valBlocked: isValBlocked,
      sendBlocked: isSendBlocked,
      reason: sendRes.reason
    });
  }

  lib.addAssertion(
    result,
    'Pesan watchdog/heartbeat/cron/kuning/hijau diblokir mutlak ke channel publik sinyal (blocked===true)',
    allBlocked === true,
    true,
    allBlocked
  );

  // -------------------------------------------------------------------------
  // 2. Verifikasi Kartu Sinyal Sah Lolos (DAY TRADE, SWING, BRIEF)
  // -------------------------------------------------------------------------
  const validSignals = [
    'DAY TRADE: BBRI Buy 5400 TP 5600 SL 5300',
    'SWING: ASII Buy 5100 TP 5450 SL 4950',
    'MORNING BRIEF: Analisis Pembukaan IHSG dan Saham Pilihan',
    'EVENING BRIEF: Ringkasan Pasar Saham Penutupan EOD'
  ];

  let allSignalsAllowed = true;
  for (const sig of validSignals) {
    const val = notifier.validateTelegramMessageDestination(sig, channelChatId);
    if (!val.allowed || val.blocked) {
      allSignalsAllowed = false;
    }
  }

  lib.addAssertion(
    result,
    'Sinyal trading sah (DAY TRADE, SWING, BRIEF) lolos tanpa terhambat (allowed===true)',
    allSignalsAllowed === true,
    true,
    allSignalsAllowed
  );

  // -------------------------------------------------------------------------
  // 3. Verifikasi Alert Kritis HANYA ke Chat ID Admin 6396446903
  // -------------------------------------------------------------------------
  const adminId = '6396446903';
  const isCorrectAdminId = notifier.ADMIN_CHAT_ID === adminId && watchdog.ADMIN_CHAT_ID === adminId;

  // Tes 3a: Pesan kritis ke Admin -> diizinkan
  const criticalMsg = '🚨 [KRITIS/MERAH] WATCHDOG OPERASIONAL — ERROR: PM2 stopped, exitCode 1';
  const adminCritCheck = notifier.validateTelegramMessageDestination(criticalMsg, adminId);

  // Tes 3b: Pesan warning/kuning saja ke Admin -> ditolak/disupresi (tidak boleh spam)
  const nonCritMsg = '🚨 WATCHDOG: STATUS: KUNING warning heartbeat delay';
  const adminNonCritCheck = notifier.validateTelegramMessageDestination(nonCritMsg, adminId);

  // Tes 3c: Simulasi watchdog.maybeSendAlerts tanpa isu kritis
  const tmpHistory = path.join(os.tmpdir(), `v4-f02-test-history-${Date.now()}.json`);
  let alertSentAdmin = 0;
  let targetChatSent = null;

  const mockAdminSender = async (text) => {
    alertSentAdmin++;
    targetChatSent = adminId;
    return { sent: true, ok: true };
  };

  // Run 1: Isu warning saja (tanpa kegagalan kritis) -> TIDAK boleh kirim ke Telegram
  const warningOnlyResult = {
    ok: false,
    at: new Date().toISOString(),
    issues: [
      { key: 'heartbeat:test:stale', severity: 'warning', detail: 'heartbeat basi' },
      { key: 'quota:drift', severity: 'warning', detail: 'quota drift' }
    ]
  };
  const warnSendRes = await watchdog.maybeSendAlerts({
    result: warningOnlyResult,
    historyPath: tmpHistory,
    sender: mockAdminSender
  });

  const warningSuppressed = warnSendRes.sent === 0 && warnSendRes.suppressed === true && alertSentAdmin === 0;

  // Run 2: Isu KRITIS (MERAH / ERROR) -> Boleh kirim ke Admin
  const criticalResult = {
    ok: false,
    at: new Date().toISOString(),
    issues: [
      { key: 'heartbeat:critical:exit', severity: 'critical', detail: 'exitCode=1 status=ERROR' }
    ]
  };
  const critSendRes = await watchdog.maybeSendAlerts({
    result: criticalResult,
    historyPath: tmpHistory,
    sender: mockAdminSender
  });

  const criticalDeliveredToAdmin = critSendRes.sent === 1 && alertSentAdmin === 1 && targetChatSent === adminId;

  try { fs.unlinkSync(tmpHistory); } catch (_) {}

  lib.addAssertion(
    result,
    'Notifikasi watchdog diarahkan HANYA ke Chat ID pribadi Admin 6396446903',
    isCorrectAdminId === true,
    adminId,
    `${notifier.ADMIN_CHAT_ID} / ${watchdog.ADMIN_CHAT_ID}`
  );

  lib.addAssertion(
    result,
    'Notifikasi watchdog HANYA dikirim saat status kritis (MERAH/ERROR), status kuning/hijau disupresi',
    adminCritCheck.allowed === true && adminNonCritCheck.blocked === true && warningSuppressed && criticalDeliveredToAdmin,
    true,
    `critAllowed=${adminCritCheck.allowed}, nonCritBlocked=${adminNonCritCheck.blocked}, warnSuppressed=${warningSuppressed}, critSent=${criticalDeliveredToAdmin}`
  );

  // -------------------------------------------------------------------------
  // 4. Verifikasi Stale Threshold Job Harian >= 1560 Menit (26 Jam)
  // -------------------------------------------------------------------------
  const dailyJobs = [
    'broksum-1945',
    'insider-tiered-2200',
    'fundamental-refresh-2220',
    'evening-brief-1700',
    'morning-brief-0600'
  ];

  let allStaleThresholdsOk = true;
  const staleDetails = {};

  for (const j of dailyJobs) {
    const tol = watchdog.defaultToleranceMin(j);
    staleDetails[j] = tol;
    if (typeof tol !== 'number' || tol < 1560) {
      allStaleThresholdsOk = false;
    }
  }

  lib.addAssertion(
    result,
    'Konfigurasi stale threshold job harian di scripts/watchdog.js terbukti >= 1560 menit (26 jam)',
    allStaleThresholdsOk === true,
    '>= 1560 menit',
    JSON.stringify(staleDetails)
  );

  // -------------------------------------------------------------------------
  // 5. Verifikasi Job daytrade-producer Dipersiapkan Aktif Sejak 08:50 WIB
  // -------------------------------------------------------------------------
  const daytradeStart = watchdog.DAYTRADE_PRODUCER_START_WIB;
  const isStartConfigured = daytradeStart === '08:50';

  const activeSample = watchdog.isDaytradeProducerActive('2026-11-04T08:50:00+07:00');
  const preActiveSample = watchdog.isDaytradeProducerActive('2026-11-04T08:40:00+07:00');
  const weekendSample = watchdog.isDaytradeProducerActive('2026-11-08T10:00:00+07:00');

  const daytradeActiveOk = isStartConfigured && activeSample === true && preActiveSample === false && weekendSample === false;

  lib.addAssertion(
    result,
    'Job daytrade-producer dipersiapkan aktif sejak 08:50 WIB pada hari bursa',
    daytradeActiveOk === true,
    'start=08:50, active(08:50)=true, pre(08:40)=false, weekend=false',
    `start=${daytradeStart}, active=${activeSample}, pre=${preActiveSample}, weekend=${weekendSample}`
  );

  // -------------------------------------------------------------------------
  // 6. Verifikasi Integritas Direktori data/heartbeats/
  //    - Seluruh file > 20 bytes
  //    - Format JSON valid minimal { job, lastRun, status, exitCode }
  //    - 0 file heartbeat zombie
  // -------------------------------------------------------------------------
  const hbDir = path.join(ROOT, 'data', 'heartbeats');
  const hbExists = fs.existsSync(hbDir);
  lib.addAssertion(
    result,
    'Direktori data/heartbeats/ ada dan aktif di workspace',
    hbExists === true,
    true,
    hbExists
  );

  // Uji pembersihan zombie nyata: buat file zombie buatan & file 0-byte, lalu bersihkan
  const testZombiePath = path.join(hbDir, 'broksum-1945-f01.json');
  const testZeroBytePath = path.join(hbDir, 'zombie-zero-byte.json');
  fs.writeFileSync(testZombiePath, '{"job":"broksum-1945-f01","status":"ERROR"}');
  fs.writeFileSync(testZeroBytePath, '');

  // Eksekusi audit and clean
  heartbeatRecorder.auditAndCleanHeartbeats(hbDir);
  heartbeatRecorder.initializeCanonicalHeartbeats(hbDir);

  const testZombieStillExists = fs.existsSync(testZombiePath);
  const testZeroByteStillExists = fs.existsSync(testZeroBytePath);

  lib.addAssertion(
    result,
    'Modul auditAndCleanHeartbeats terbukti otomatis menghapus file 0-byte dan zombie',
    testZombieStillExists === false && testZeroByteStillExists === false,
    'zombie & 0-byte berhasil dihapus',
    `zombieExists=${testZombieStillExists}, zeroByteExists=${testZeroByteStillExists}`
  );

  const hbFiles = fs.readdirSync(hbDir).filter((f) => f.endsWith('.json'));
  let validFilesCount = 0;
  let allAbove20Bytes = true;
  let allValidJson = true;
  let zombieFoundCount = 0;

  for (const f of hbFiles) {
    const fullPath = path.join(hbDir, f);
    const stat = fs.statSync(fullPath);
    if (stat.size <= 20) {
      allAbove20Bytes = false;
    }

    try {
      const content = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      if (!content || typeof content !== 'object' || (!content.job && !content.jobName)) {
        allValidJson = false;
      }
    } catch (_) {
      allValidJson = false;
    }

    const base = f.replace(/\.json$/, '');
    if (!heartbeatRecorder.CANONICAL_JOBS.includes(base)) {
      zombieFoundCount++;
    }

    validFilesCount++;
  }

  lib.addAssertion(
    result,
    'Seluruh file di data/heartbeats/*.json berukuran > 20 bytes dan berformat JSON valid',
    hbFiles.length >= 10 && allAbove20Bytes === true && allValidJson === true,
    `total>=10, all>20b, allValidJson`,
    `total=${hbFiles.length}, all>20b=${allAbove20Bytes}, validJson=${allValidJson}`
  );

  lib.addAssertion(
    result,
    '0 file heartbeat zombie / duplikat ditemukan di data/heartbeats/',
    zombieFoundCount === 0,
    0,
    zombieFoundCount
  );

  // -------------------------------------------------------------------------
  // Finalisasi Gate V4-F02
  // -------------------------------------------------------------------------
  console.log('----------------------------------------------------');
  console.log(`[GATE V4-F02] Total Pengujian: ${result.total}`);
  console.log(`[GATE V4-F02] Berhasil (Passed): ${result.checked}`);
  console.log(`[GATE V4-F02] Negative Control Pass: ${result.negativeControl.pass}`);

  const allPassed = result.checked === result.total && result.negativeControl.pass;
  if (allPassed) {
    console.log('----------------------------------------------------');
    console.log('PASS: Gate V4-F02 LULUS');
    console.log('----------------------------------------------------');
  } else {
    console.error('FAIL: Gate V4-F02 GAGAL');
  }

  lib.finalizeGate(result, OUT);
}

main().catch((err) => {
  console.error('[GATE V4-F02] Fatal uncaught error:', err);
  process.exit(1);
});
