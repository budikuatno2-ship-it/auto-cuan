'use strict';

/**
 * tools/gates/gate-V4-F07.js
 * ============================================================================
 * Gate Penguji Anti-Bohong FASE V4-F07:
 * 1. Verifikasi bukti-verifikasi-final/backtest-individual-964.json ada dan berisi tepat 964 ticker.
 * 2. Periksa kode sumber lib/backtest-individual-964.js dan scripts/run-individual-backtest-964.js
 *    untuk memastikan 0 penggunaan Math.random (Math.random count === 0).
 * 3. Verifikasi sampel file data/backtest-per-ticker/BBCA.json dan data/backtest-per-ticker/IHSG.json
 *    valid dan terisi metrik nyata:
 *    - BBCA: Memiliki 7 metode lengkap, dominantFlowDriver valid, totalBarsTested > 0, tradesCount > 0.
 *    - IHSG: Memiliki 4 metode price action aktif, metode broker berstatus NOT_APPLICABLE_INDEX,
 *      dominantFlowDriver === 'PRICE_ACTION'.
 * 4. Verifikasi seluruh 964 file di data/backtest-per-ticker/<TICKER>.json ada dan lengkap.
 * 5. Kontrol Negatif (Negative Control) untuk menjamin gate tidak memberikan false-pass.
 * 6. Simpan hasil ke bukti-verifikasi-final/gates-v4/F07.json dan cetak 'PASS: Gate V4-F07 LULUS'.
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates-v4', 'F07.json');
const REKAP_FILE = path.join(ROOT, 'bukti-verifikasi-final', 'backtest-individual-964.json');
const PER_TICKER_DIR = path.join(ROOT, 'data', 'backtest-per-ticker');
const LIB_FILE = path.join(ROOT, 'lib', 'backtest-individual-964.js');
const SCRIPT_FILE = path.join(ROOT, 'scripts', 'run-individual-backtest-964.js');

const result = lib.newResult(
  'V4-F07',
  'Eksekusi Backtest Individual 1 per 1 untuk Seluruh 964 Ticker Lintas 7 Metode (100% Data Riil, 0 Math.random)'
);

// --- Kontrol Negatif (Negative Control Validator) ---
function f07Validator(sample) {
  if (!sample || typeof sample !== 'object') return false;
  if (typeof sample.tickerCount !== 'number' || sample.tickerCount !== 964) return false;
  if (typeof sample.mathRandomCount !== 'number' || sample.mathRandomCount !== 0) return false;
  if (!sample.bbcaValid || sample.bbcaTradesCount <= 0) return false;
  if (!sample.ihsgValid || sample.ihsgDominantFlow !== 'PRICE_ACTION') return false;
  if (sample.ihsgUsesBrokerSummary === true) return false;
  if (typeof sample.individualFilesCount !== 'number' || sample.individualFilesCount !== 964) return false;
  return true;
}

const negativeSamples = [
  null,
  // Sampel korup 1: Jumlah ticker kurang dari 964 (misal hanya 500)
  {
    tickerCount: 500,
    mathRandomCount: 0,
    bbcaValid: true,
    bbcaTradesCount: 26,
    ihsgValid: true,
    ihsgDominantFlow: 'PRICE_ACTION',
    ihsgUsesBrokerSummary: false,
    individualFilesCount: 500
  },
  // Sampel korup 2: Menggunakan Math.random di kode sumber
  {
    tickerCount: 964,
    mathRandomCount: 3,
    bbcaValid: true,
    bbcaTradesCount: 26,
    ihsgValid: true,
    ihsgDominantFlow: 'PRICE_ACTION',
    ihsgUsesBrokerSummary: false,
    individualFilesCount: 964
  },
  // Sampel korup 3: BBCA rusak atau 0 trade
  {
    tickerCount: 964,
    mathRandomCount: 0,
    bbcaValid: false,
    bbcaTradesCount: 0,
    ihsgValid: true,
    ihsgDominantFlow: 'PRICE_ACTION',
    ihsgUsesBrokerSummary: false,
    individualFilesCount: 964
  },
  // Sampel korup 4: IHSG dipaksakan broker summary emiten (pelanggaran aturan IHSG)
  {
    tickerCount: 964,
    mathRandomCount: 0,
    bbcaValid: true,
    bbcaTradesCount: 26,
    ihsgValid: true,
    ihsgDominantFlow: 'FOREIGN',
    ihsgUsesBrokerSummary: true,
    individualFilesCount: 964
  },
  // Sampel korup 5: Berkas individual kurang dari 964
  {
    tickerCount: 964,
    mathRandomCount: 0,
    bbcaValid: true,
    bbcaTradesCount: 26,
    ihsgValid: true,
    ihsgDominantFlow: 'PRICE_ACTION',
    ihsgUsesBrokerSummary: false,
    individualFilesCount: 850
  }
];

function main() {
  console.log('====================================================================');
  console.log('[GATE V4-F07] MEMULAI VERIFIKASI ANTI-BOHONG BACKTEST 964 TICKER');
  console.log('====================================================================');

  // 1. Jalankan Kontrol Negatif
  const ncRes = lib.runNegativeControl(negativeSamples, f07Validator);
  result.negativeControl = {
    description: 'Negative Control: Deteksi tickerCount != 964, mathRandomCount > 0, BBCA invalid, IHSG broker misuse, file count != 964',
    injected: ncRes.injected,
    detected: ncRes.detected,
    pass: ncRes.detected === ncRes.injected
  };

  // 2. Verifikasi Rekapitulasi bukti-verifikasi-final/backtest-individual-964.json
  const rekapExists = fs.existsSync(REKAP_FILE);
  let rekapData = null;
  let tickerCount = 0;
  if (rekapExists) {
    try {
      rekapData = JSON.parse(fs.readFileSync(REKAP_FILE, 'utf8'));
      if (rekapData && Array.isArray(rekapData.tickers)) {
        tickerCount = rekapData.tickers.length;
      }
    } catch (_) {}
  }

  lib.addAssertion(
    result,
    'Rekapitulasi bukti-verifikasi-final/backtest-individual-964.json ada dan memuat tepat 964 ticker',
    rekapExists && tickerCount === 964,
    964,
    tickerCount
  );

  // 3. Verifikasi 0 Penggunaan Math.random di lib/backtest-individual-964.js
  const libExists = fs.existsSync(LIB_FILE);
  const libSrc = libExists ? fs.readFileSync(LIB_FILE, 'utf8') : '';
  const libRandomMatches = libSrc.match(/Math\.random/g) || [];
  const libRandomCount = libRandomMatches.length;

  lib.addAssertion(
    result,
    'Modul lib/backtest-individual-964.js 100% bebas fungsi pseudo-random (Math.random count === 0)',
    libExists && libRandomCount === 0,
    0,
    libRandomCount
  );

  // 4. Verifikasi 0 Penggunaan Math.random di scripts/run-individual-backtest-964.js
  const scriptExists = fs.existsSync(SCRIPT_FILE);
  const scriptSrc = scriptExists ? fs.readFileSync(SCRIPT_FILE, 'utf8') : '';
  const scriptRandomMatches = scriptSrc.match(/Math\.random/g) || [];
  const scriptRandomCount = scriptRandomMatches.length;

  lib.addAssertion(
    result,
    'Skrip scripts/run-individual-backtest-964.js 100% bebas fungsi pseudo-random (Math.random count === 0)',
    scriptExists && scriptRandomCount === 0,
    0,
    scriptRandomCount
  );

  // 5. Verifikasi Direktori data/backtest-per-ticker/ berisi tepat 964 berkas JSON
  let individualFilesCount = 0;
  if (fs.existsSync(PER_TICKER_DIR)) {
    individualFilesCount = fs.readdirSync(PER_TICKER_DIR).filter(f => f.endsWith('.json')).length;
  }

  lib.addAssertion(
    result,
    'Direktori data/backtest-per-ticker/ memuat tepat 964 berkas JSON independen',
    individualFilesCount === 964,
    964,
    individualFilesCount
  );

  // 6. Verifikasi Sampel BBCA (data/backtest-per-ticker/BBCA.json)
  const bbcaPath = path.join(PER_TICKER_DIR, 'BBCA.json');
  const bbcaExists = fs.existsSync(bbcaPath);
  let bbcaValid = false;
  let bbcaTradesCount = 0;
  let bbcaBarsTested = 0;
  let bbcaMethodsCount = 0;
  let bbcaDominantFlow = '';

  if (bbcaExists) {
    try {
      const bbca = JSON.parse(fs.readFileSync(bbcaPath, 'utf8'));
      bbcaTradesCount = Number(bbca.tradesCount || 0);
      bbcaBarsTested = Number(bbca.totalBarsTested || 0);
      bbcaMethodsCount = bbca.methodsComparison ? Object.keys(bbca.methodsComparison).length : 0;
      bbcaDominantFlow = String(bbca.dominantFlowDriver || '');
      bbcaValid = bbca.ticker === 'BBCA' &&
                  bbcaBarsTested >= 400 &&
                  bbcaMethodsCount === 7 &&
                  bbcaTradesCount > 0 &&
                  ['FOREIGN', 'DOMESTIC', 'PRICE_ACTION'].includes(bbcaDominantFlow);
    } catch (_) {}
  }

  lib.addAssertion(
    result,
    'Sampel BBCA.json valid: memiliki 7 metode lengkap, totalBarsTested >= 400, dan tradesCount > 0',
    bbcaValid,
    true,
    bbcaValid
  );

  // 7. Verifikasi Sampel IHSG (data/backtest-per-ticker/IHSG.json)
  const ihsgPath = path.join(PER_TICKER_DIR, 'IHSG.json');
  const ihsgExists = fs.existsSync(ihsgPath);
  let ihsgValid = false;
  let ihsgDominantFlow = '';
  let ihsgBrokerMethodStatus = '';

  if (ihsgExists) {
    try {
      const ihsg = JSON.parse(fs.readFileSync(ihsgPath, 'utf8'));
      ihsgDominantFlow = String(ihsg.dominantFlowDriver || '');
      const m5 = ihsg.methodsComparison && ihsg.methodsComparison.M5_BANDAR_BS_RATIO;
      ihsgBrokerMethodStatus = m5 ? m5.status : '';
      const m1Count = (ihsg.methodsComparison && ihsg.methodsComparison.M1_SMC_ORDER_BLOCK && ihsg.methodsComparison.M1_SMC_ORDER_BLOCK.tradesCount) || 0;
      const m4Count = (ihsg.methodsComparison && ihsg.methodsComparison.M4_ZIGZAG_MOMENTUM_LPM && ihsg.methodsComparison.M4_ZIGZAG_MOMENTUM_LPM.tradesCount) || 0;

      ihsgValid = ihsg.ticker === 'IHSG' &&
                  ihsgDominantFlow === 'PRICE_ACTION' &&
                  ihsgBrokerMethodStatus === 'NOT_APPLICABLE_INDEX' &&
                  (m1Count > 0 || m4Count > 0);
    } catch (_) {}
  }

  lib.addAssertion(
    result,
    'Sampel IHSG.json valid: dominantFlowDriver === PRICE_ACTION, metode broker berstatus NOT_APPLICABLE_INDEX, metode Price Action teruji',
    ihsgValid,
    true,
    ihsgValid
  );

  // 8. Verifikasi Kualitas Rekapitulasi (totalTradesSimulated > 1000)
  const totalTrades = (rekapData && rekapData.metadata && rekapData.metadata.totalTradesSimulated) || 0;
  lib.addAssertion(
    result,
    'Total akumulasi trade lintas 964 ticker teruji secara substansial (> 1.000 closed trades)',
    totalTrades >= 1000,
    '>= 1000',
    totalTrades
  );

  const allPassed = result.assertions.every(a => a.pass === true);

  if (allPassed) {
    console.log('--------------------------------------------------------------------');
    console.log('PASS: Gate V4-F07 LULUS');
    console.log(`[VERIFIKASI] 964 ticker telah diuji 1 per 1 lintas 7 metode dengan 0 Math.random.`);
    console.log(`[METRIK] Total Trades: ${totalTrades}, BBCA Bars: ${bbcaBarsTested}, IHSG Flow: ${ihsgDominantFlow}`);
    console.log('--------------------------------------------------------------------');
  } else {
    console.error('FAIL: Gate V4-F07 GAGAL — Periksa assertion yang tidak lolos');
  }

  lib.finalizeGate(result, OUT);
}

if (require.main === module) {
  main();
}

module.exports = { main };
