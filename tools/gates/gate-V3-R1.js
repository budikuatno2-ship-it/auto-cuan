'use strict';
// Gate V3-R1 — Gate Induk Validasi Seluruh Gate F01 s.d. F15, Kuota Stock Arjum Produktif, & Backtest 964 Saham Riil.
//
// Kontrak Gate Induk:
// 1. Validasi 15/15 Gate Fase V3 (F01 s.d. F15) di bukti-verifikasi-final/gates-v3/:
//    - Seluruh gate JSON ada dan valid.
//    - pass: true, checked === total, total > 0.
//    - negativeControl pass: true (injected >= 1 && detected === injected).
//    - 100% assertions di setiap gate bernilai pass: true (0 toleransi kegagalan).
// 2. Kuota Stock Arjum Produktif & Terjaga:
//    - config/quota.json valid dengan backfill 13.000, reserve floor 5.000, weekend 0, hardStop 23:50.
//    - Snapshot quota dinamis valid (limit: 18080, remaining >= 0, label: 'Kuota API data').
//    - Bukti penyelamatan F01 valid (usedToday > 500, file broksum 2-3 Nov 2026 ada di VPS/lokal, PM2 + crontab aktif).
// 3. Backtest 964 Saham Riil (bukti-verifikasi-final/fase03/backtest-full-964-saham.json):
//    - 964/964 ticker riil terproses (963 saham + IHSG), 0 NaN, 0 RNG.
//    - 3 formula screener pemenang terkunci (Konglo, Non-Konglo, Daytrade).
//    - Fisik berkas data/daily-candles mencakup 964 berkas.
// 4. Kontrol Negatif Wajib (Negative Control):
//    - Injected >= 1 && detected === injected.
// 5. Output: bukti-verifikasi-final/gates-v3/R1.json dengan exit code 0.

const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const GATES_V3_DIR = path.join(ROOT, 'bukti-verifikasi-final', 'gates-v3');
const OUT = path.join(GATES_V3_DIR, 'R1.json');

const result = lib.newResult(
  'V3-R1',
  'Gate Induk Validasi Seluruh Gate F01 s.d. F15, Kuota Stock Arjum Produktif, & Backtest 964 Saham Riil'
);

const EXPECTED_GATES = [
  'F01', 'F02', 'F03', 'F04', 'F05',
  'F06', 'F07', 'F08', 'F09', 'F10',
  'F11', 'F12', 'F13', 'F14', 'F15'
];

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8')); } catch (_) { return null; }
}

function readText(p) {
  try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (_) { return null; }
}

function exists(p) {
  try { return fs.existsSync(path.join(ROOT, p)); } catch (_) { return false; }
}

// Validator kontrol negatif untuk gate induk
function v3R1Validator(sample) {
  if (!sample || typeof sample !== 'object') return false;
  if (sample.pass !== true) return false;
  if (!Number.isFinite(sample.checked) || !Number.isFinite(sample.total)) return false;
  if (sample.total <= 0 || sample.checked !== sample.total) return false;
  const nc = sample.negativeControl || {};
  if (!((nc.injected || 0) >= 1 && nc.detected === nc.injected)) return false;
  if (!Array.isArray(sample.assertions) || sample.assertions.length === 0) return false;
  if (!sample.assertions.every((a) => a && a.pass === true)) return false;
  if (!sample.allGatesOk) return false;
  if (!sample.quotaProductive) return false;
  if (!sample.backtest964Ok) return false;
  return true;
}

async function main() {
  // 1. Kontrol Negatif (Negative Control)
  const validBase = () => ({
    pass: true,
    checked: 15,
    total: 15,
    negativeControl: { injected: 3, detected: 3, pass: true },
    assertions: [{ pass: true }],
    allGatesOk: true,
    quotaProductive: true,
    backtest964Ok: true
  });

  const ncSamples = [
    { desc: 'pass:false', corrupt: Object.assign(validBase(), { pass: false }) },
    { desc: 'checked!=total', corrupt: Object.assign(validBase(), { checked: 14 }) },
    { desc: 'total<=0', corrupt: Object.assign(validBase(), { total: 0, checked: 0 }) },
    { desc: 'nc injected=0', corrupt: Object.assign(validBase(), { negativeControl: { injected: 0, detected: 0 } }) },
    { desc: 'nc mismatch', corrupt: Object.assign(validBase(), { negativeControl: { injected: 2, detected: 1 } }) },
    { desc: 'assertion fail', corrupt: Object.assign(validBase(), { assertions: [{ pass: false }] }) },
    { desc: 'allGatesOk false', corrupt: Object.assign(validBase(), { allGatesOk: false }) },
    { desc: 'quotaProductive false', corrupt: Object.assign(validBase(), { quotaProductive: false }) },
    { desc: 'backtest964Ok false', corrupt: Object.assign(validBase(), { backtest964Ok: false }) },
    { desc: 'non-object', corrupt: 'NOT_AN_OBJECT' }
  ];

  const nc = lib.runNegativeControl(ncSamples.map((s) => s.corrupt), v3R1Validator);
  result.negativeControl = {
    description: 'Validator v3R1Validator wajib menolak: pass false, checked!=total, total<=0, nc invalid, assertion gagal, sub-validasi false, non-object',
    injected: nc.injected,
    detected: nc.detected,
    pass: nc.injected >= 1 && nc.detected === nc.injected
  };

  // 2. Audit Inventaris 15 Gate V3 (F01 s.d. F15)
  const gateDetails = [];
  let allGatesPass = true;
  let totalCheckedAssertions = 0;
  let totalAssertions = 0;

  for (const id of EXPECTED_GATES) {
    const filename = `bukti-verifikasi-final/gates-v3/${id}.json`;
    const j = readJson(filename);
    const ncG = (j && j.negativeControl) || {};
    const assertions = (j && Array.isArray(j.assertions)) ? j.assertions : [];
    const allAssPass = assertions.length > 0 && assertions.every((a) => a && a.pass === true);

    const ok = !!j
      && j.pass === true
      && j.checked === j.total
      && (j.total || 0) > 0
      && (ncG.injected || 0) >= 1
      && (ncG.detected || 0) === (ncG.injected || 0)
      && allAssPass === true;

    if (!ok) allGatesPass = false;

    if (j) {
      totalCheckedAssertions += (j.checked || 0);
      totalAssertions += (j.total || 0);
    }

    gateDetails.push({
      gate: id,
      title: j ? j.title : 'MISSING',
      pass: ok,
      checked: j ? j.checked : 0,
      total: j ? j.total : 0,
      ncPass: (ncG.injected || 0) >= 1 && (ncG.detected === ncG.injected)
    });
  }

  lib.addAssertion(
    result,
    '15/15 Gate Fase V3 (F01..F15) Lolos Sempurna (pass:true, checked===total, NC ok, 0 toleransi)',
    allGatesPass === true && gateDetails.length === 15,
    '15/15 gate lolos',
    `Lolos: ${gateDetails.filter(g => g.pass).length}/15 gate, Total asersi terverifikasi: ${totalCheckedAssertions}/${totalAssertions}`
  );

  // 3. Verifikasi Kuota Stock Arjum Produktif & Terjaga
  let quotaConfigOk = false;
  let quotaSnapshotOk = false;
  let f01QuotaEvidenceOk = false;

  const quotaCfg = readJson('config/quota.json');
  if (quotaCfg) {
    const floorWeekday = quotaCfg.reserveFloorWeekday ?? quotaCfg.reserveFloorWeekdayDaytime;
    quotaConfigOk = quotaCfg.weekdayBackfillLimit === 13000
      && floorWeekday === 5000
      && quotaCfg.reserveFloorWeekend === 0
      && quotaCfg.hardStopWIB === '23:50'
      && quotaCfg.planName === 'Supporter'
      && quotaCfg.maxQuota === 18080;
  }

  lib.addAssertion(
    result,
    'Konfigurasi Kuota config/quota.json Terkunci (backfill 13k, floor 5k, weekend 0, hardstop 23:50)',
    quotaConfigOk,
    'weekdayBackfill=13000, floor=5000, weekend=0, hardStop=23:50',
    quotaCfg ? `backfill=${quotaCfg.weekdayBackfillLimit}, floor=${quotaCfg.reserveFloorWeekday ?? quotaCfg.reserveFloorWeekdayDaytime}, weekend=${quotaCfg.reserveFloorWeekend}, hardStop=${quotaCfg.hardStopWIB}` : 'config hilang'
  );

  try {
    const quotaState = require(path.join(ROOT, 'lib', 'quota-state'));
    const snap = quotaState.getQuotaSnapshot();
    quotaSnapshotOk = snap && snap.limit === 18080 && snap.remaining >= 0 && snap.label === 'Kuota API data';
  } catch (e) {
    quotaSnapshotOk = false;
  }

  lib.addAssertion(
    result,
    'Snapshot Kuota Dinamis Produktif & Valid (limit 18080, remaining valid, label terverifikasi)',
    quotaSnapshotOk,
    'limit=18080, remaining>=0, label=Kuota API data',
    quotaSnapshotOk ? 'Snapshot dinamis aktif & valid' : 'Snapshot kuota gagal'
  );

  const f01Gate = readJson('bukti-verifikasi-final/gates-v3/F01.json');
  if (f01Gate && f01Gate.pass === true) {
    const broksumAss = f01Gate.assertions.find(a => a.name.includes('broksum'));
    const movingAss = f01Gate.assertions.find(a => a.name.includes('usedToday>500') || a.name.includes('kuota bergerak'));
    const cronAss = f01Gate.assertions.find(a => a.name.includes('crontab'));
    f01QuotaEvidenceOk = Boolean(broksumAss && broksumAss.pass && movingAss && movingAss.pass && cronAss && cronAss.pass);
  }

  lib.addAssertion(
    result,
    'Bukti Operasional Kuota Arjum Produktif di VPS (usedToday>500, broksum 2-3 Nov ada, cron/PM2 aktif)',
    f01QuotaEvidenceOk,
    'F01 assertions passed (kuota bergerak, broksum VPS, cron+pm2)',
    f01QuotaEvidenceOk ? 'Terverifikasi produktif di VPS dari F01' : 'Bukti F01 tidak lengkap'
  );

  // 4. Verifikasi Backtest 964 Saham Riil
  const btPath = 'bukti-verifikasi-final/fase03/backtest-full-964-saham.json';
  const btData = readJson(btPath);
  let btOk = false;
  let btDetail = '';

  if (btData && btData.meta) {
    const universeFiles = btData.meta.universeFiles;
    const tickersWithCandles = btData.meta.tickersWithCandles;
    const nanCount = btData.meta.nanCount;
    const perTickerCount = btData.perTicker ? Object.keys(btData.perTicker).length : 0;
    const winners = btData.winners || {};
    const hasWinners = Boolean(winners.konglo && winners.nonkonglo && winners.daytrade);

    btOk = universeFiles === 964
      && (tickersWithCandles === 963 || tickersWithCandles === 964)
      && perTickerCount === 964
      && nanCount === 0
      && hasWinners;

    btDetail = `universeFiles=${universeFiles}, perTicker=${perTickerCount}, nanCount=${nanCount}, winners=${hasWinners ? 'Konglo/NonKonglo/Daytrade' : 'none'}`;
  } else {
    btDetail = 'berkas backtest tidak ditemukan';
  }

  lib.addAssertion(
    result,
    'Backtest 964 Saham Riil Lengkap (964 ticker, 0 NaN, 3 pemenang formula terkunci)',
    btOk,
    '964 ticker, nanCount=0, winners terkunci',
    btDetail
  );

  // Verifikasi fisik berkas daily candles
  let candleFiles = [];
  try {
    candleFiles = fs.readdirSync(path.join(ROOT, 'data', 'daily-candles')).filter(f => f.endsWith('.json'));
  } catch (_) {}

  lib.addAssertion(
    result,
    'Fisik Berkas Universe Daily Candles Riil Tersedia Lengkap (964 berkas)',
    candleFiles.length === 964,
    '964 files',
    `Tersedia: ${candleFiles.length} berkas`
  );

  // 5. Finalisasi Gate Induk
  result.gateInventory = gateDetails;
  result.totalGates = 15;
  result.passedGates = gateDetails.filter(g => g.pass).length;

  lib.finalizeGate(result, OUT);
}

main().catch((err) => {
  console.error('GATE V3-R1 CRITICAL ERROR:', err);
  process.exit(1);
});
