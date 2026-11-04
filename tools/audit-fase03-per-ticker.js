#!/usr/bin/env node
'use strict';

/**
 * FASE 3 — Audit Level Chart 964 Saham + IHSG
 * ============================================
 * Memeriksa seluruh 964 ticker saham BEI + IHSG pada data/daily-candles/*.json.
 * Memanggil builder produksi di lib/chart-level-builder.js dan engine lib/.
 *
 * Kontrol Negatif (WAJIB):
 *   1. __NC_NAN: Mengandung NaN pada harga/indikator (Wajib FAIL)
 *   2. __NC_SL_ABOVE: Stop Loss > Entry (Wajib FAIL)
 *   3. __NC_SUP_ABOVE_RES: Support > Resistance (Wajib FAIL)
 *
 * Output:
 *   - bukti-verifikasi-final/fase03/audit-chart-per-ticker.json
 *   - bukti-verifikasi-final/fase03/audit-chart-summary.json
 */

const fs = require('fs');
const path = require('path');
const chartBuilder = require('../lib/chart-level-builder');
const idxTick = require('../lib/idx-tick-normalization');

const CANDLE_DIR = path.join(__dirname, '..', 'data', 'daily-candles');
const OUT_DIR = path.join(__dirname, '..', 'bukti-verifikasi-final', 'fase03');
const OUT_PER_TICKER = path.join(OUT_DIR, 'audit-chart-per-ticker.json');
const OUT_SUMMARY = path.join(OUT_DIR, 'audit-chart-summary.json');

// Ensure output directory exists
fs.mkdirSync(OUT_DIR, { recursive: true });

// ============================================================================
// VALIDATOR FUNCTION
// ============================================================================
function validateAnalysis(analysis, ticker) {
  const errors = [];
  const warnings = [];

  if (!analysis) {
    errors.push('ANALYSIS_NULL');
    return { valid: false, errors, warnings };
  }

  if (analysis.status === 'REJECTED') {
    return {
      valid: false,
      isRejected: true,
      reject_reason: analysis.reject_reason || 'UNKNOWN_REJECT',
      note: analysis.note || null,
      errors: [analysis.reject_reason || 'REJECTED'],
      warnings
    };
  }

  const ind = analysis.indicators;
  if (!ind) {
    errors.push('MISSING_INDICATORS');
    return { valid: false, errors, warnings };
  }

  // 1. Validasi non-NaN / isFinite
  const numChecks = [
    ['lastPrice', ind.lastPrice],
    ['ma20', ind.ma20],
    ['ma50', ind.ma50],
    ['atr14', ind.atr14],
    ['rsi14', ind.rsi14],
    ['support', ind.support],
    ['resistance', ind.resistance]
  ];
  for (const [name, val] of numChecks) {
    if (val == null || !Number.isFinite(val) || Number.isNaN(val)) {
      errors.push(`INVALID_NUMERIC_${name.toUpperCase()}`);
    }
  }

  // 2. Harga dalam rentang wajar & volume >= 0
  if (ind.lastPrice <= 0) errors.push('PRICE_NON_POSITIVE');
  if (ind.atr14 <= 0) errors.push('ATR14_NON_POSITIVE');
  if (ind.rsi14 < 0 || ind.rsi14 > 100) errors.push('RSI_OUT_OF_BOUNDS');

  // 3. Support < Resistance
  if (ind.support >= ind.resistance) {
    errors.push(`SUPPORT_GE_RESISTANCE (S:${ind.support} >= R:${ind.resistance})`);
  }

  // 4. Kerucut 10 hari
  const cone = analysis.cone10;
  if (!cone || !Number.isFinite(cone.p10) || !Number.isFinite(cone.p90)) {
    errors.push('INVALID_CONE10');
  } else if (cone.p10 >= cone.p90) {
    errors.push(`CONE_INVERTED (p10:${cone.p10} >= p90:${cone.p90})`);
  }

  // 5. 5 Modes (DayTrade, Swing, Scalping, Breakout, Reversal)
  const modes = analysis.modes;
  if (!modes) {
    errors.push('MISSING_MODES');
  } else {
    for (const mName of chartBuilder.FIVE_MODES) {
      const m = modes[mName];
      if (!m) {
        errors.push(`MISSING_MODE_${mName.toUpperCase()}`);
        continue;
      }
      // Validasi SL < Entry < TP1 < TP2
      if (m.sl >= m.entry) {
        errors.push(`MODE_${mName.toUpperCase()}_SL_GE_ENTRY (SL:${m.sl} >= Entry:${m.entry})`);
      }
      if (m.entry >= m.tp1) {
        errors.push(`MODE_${mName.toUpperCase()}_ENTRY_GE_TP1 (Entry:${m.entry} >= TP1:${m.tp1})`);
      }
      if (m.tp1 >= m.tp2) {
        errors.push(`MODE_${mName.toUpperCase()}_TP1_GE_TP2 (TP1:${m.tp1} >= TP2:${m.tp2})`);
      }
      // Validasi Support < Resistance
      if (m.support >= m.resistance) {
        errors.push(`MODE_${mName.toUpperCase()}_SUPPORT_GE_RESISTANCE (S:${m.support} >= R:${m.resistance})`);
      }
      // Validasi non-NaN
      if (!Number.isFinite(m.entry) || !Number.isFinite(m.sl) || !Number.isFinite(m.tp1) || !Number.isFinite(m.tp2)) {
        errors.push(`MODE_${mName.toUpperCase()}_HAS_NAN`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    isRejected: false,
    errors,
    warnings
  };
}

// ============================================================================
// 3B. KONTROL NEGATIF (WAJIB DI AWAL)
// ============================================================================
console.log('================================================================');
console.log('FASE 3 — AUDIT LEVEL CHART 964 SAHAM + IHSG & 5 MODE');
console.log('================================================================');
console.log('\n--- 3B. MENJALANKAN KONTROL NEGATIF (3 TICKER RUSAK DI MEMORI) ---');

const negativeControls = [];

// Kontrol Negatif 1: NaN pada Candle / Level
const mockNanCandles = [
  { date: '2026-10-01', open: 1000, high: 1050, low: 980, close: 1000, volume: 100000 },
  { date: '2026-10-02', open: 1000, high: 1050, low: 980, close: NaN, volume: 100000 }
];
const nanAnalysis = chartBuilder.buildFullChartAnalysis(mockNanCandles, '__NC_NAN');
// Paksa suntik NaN ke indikator untuk memverifikasi pendeteksian validator
if (nanAnalysis && nanAnalysis.indicators) nanAnalysis.indicators.lastPrice = NaN;
const nanValidation = validateAnalysis(nanAnalysis, '__NC_NAN');
const nanPassedNegativeControl = !nanValidation.valid && nanValidation.errors.some(e => e.includes('INVALID_NUMERIC') || e.includes('NAN'));
negativeControls.push({
  ticker: '__NC_NAN',
  expected: 'FAIL',
  detected: !nanValidation.valid ? 'FAIL' : 'PASS',
  passed_control: nanPassedNegativeControl,
  reasons: nanValidation.errors
});
console.log(`[NC 1] __NC_NAN: ${nanPassedNegativeControl ? 'BERHASIL DIDETEKSI FAIL' : 'GAGAL KONTROL'} ->`, nanValidation.errors);

// Kontrol Negatif 2: Stop Loss > Entry
const mockSlAboveCandles = [
  { date: '2026-10-01', open: 1000, high: 1050, low: 980, close: 1000, volume: 100000 },
  { date: '2026-10-02', open: 1000, high: 1050, low: 980, close: 1020, volume: 100000 }
];
const slAboveAnalysis = chartBuilder.buildFullChartAnalysis(mockSlAboveCandles, '__NC_SL_ABOVE');
// Paksa suntik SL > Entry di salah satu mode
if (slAboveAnalysis && slAboveAnalysis.modes && slAboveAnalysis.modes.DayTrade) {
  slAboveAnalysis.modes.DayTrade.sl = slAboveAnalysis.modes.DayTrade.entry + 100;
}
const slAboveValidation = validateAnalysis(slAboveAnalysis, '__NC_SL_ABOVE');
const slAbovePassedNegativeControl = !slAboveValidation.valid && slAboveValidation.errors.some(e => e.includes('SL_GE_ENTRY'));
negativeControls.push({
  ticker: '__NC_SL_ABOVE',
  expected: 'FAIL',
  detected: !slAboveValidation.valid ? 'FAIL' : 'PASS',
  passed_control: slAbovePassedNegativeControl,
  reasons: slAboveValidation.errors
});
console.log(`[NC 2] __NC_SL_ABOVE: ${slAbovePassedNegativeControl ? 'BERHASIL DIDETEKSI FAIL' : 'GAGAL KONTROL'} ->`, slAboveValidation.errors);

// Kontrol Negatif 3: Support > Resistance
const mockSupAboveCandles = [
  { date: '2026-10-01', open: 1000, high: 1050, low: 980, close: 1000, volume: 100000 },
  { date: '2026-10-02', open: 1000, high: 1050, low: 980, close: 1020, volume: 100000 }
];
const supAboveAnalysis = chartBuilder.buildFullChartAnalysis(mockSupAboveCandles, '__NC_SUP_ABOVE_RES');
// Paksa suntik Support > Resistance
if (supAboveAnalysis && supAboveAnalysis.indicators) {
  supAboveAnalysis.indicators.support = 2000;
  supAboveAnalysis.indicators.resistance = 1000;
}
const supAboveValidation = validateAnalysis(supAboveAnalysis, '__NC_SUP_ABOVE_RES');
const supAbovePassedNegativeControl = !supAboveValidation.valid && supAboveValidation.errors.some(e => e.includes('SUPPORT_GE_RESISTANCE'));
negativeControls.push({
  ticker: '__NC_SUP_ABOVE_RES',
  expected: 'FAIL',
  detected: !supAboveValidation.valid ? 'FAIL' : 'PASS',
  passed_control: supAbovePassedNegativeControl,
  reasons: supAboveValidation.errors
});
console.log(`[NC 3] __NC_SUP_ABOVE_RES: ${supAbovePassedNegativeControl ? 'BERHASIL DIDETEKSI FAIL' : 'GAGAL KONTROL'} ->`, supAboveValidation.errors);

const allNcPassed = negativeControls.every(nc => nc.passed_control);
if (!allNcPassed) {
  console.error('FATAL: Kontrol negatif gagal mendeteksi kerusakan yang disengaja!');
  process.exit(1);
}
console.log('>>> KONTROL NEGATIF 3/3 TERVERIFIKASI SEMPURNA (SEMUA RUSAK BERHASIL DITANDAI FAIL).\n');

// ============================================================================
// 3C. AUDIT PER TICKER (964 SAHAM + IHSG)
// ============================================================================
console.log('--- 3C. MEMULAI AUDIT 964 SAHAM + IHSG DARI data/daily-candles/ ---');
const files = fs.readdirSync(CANDLE_DIR).filter(f => f.endsWith('.json'));
console.log(`Ditemukan ${files.length} file candle di ${CANDLE_DIR}\n`);

const perTickerResults = {};
const failedTickers = [];
const rejectedTickers = [];
let passCount = 0;
let failCount = 0;
let rejectedCount = 0;

let countNan = 0;
let countSlGeEntry = 0;
let countSupGeRes = 0;

const startTime = Date.now();

for (let i = 0; i < files.length; i++) {
  const f = files[i];
  const ticker = f.replace('.json', '');
  
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(CANDLE_DIR, f), 'utf8'));
  } catch (err) {
    failCount++;
    failedTickers.push({ ticker, reason: 'JSON_PARSE_ERROR', error: err.message });
    perTickerResults[ticker] = { status: 'FAIL', errors: ['JSON_PARSE_ERROR'] };
    continue;
  }

  const candles = Array.isArray(raw) ? raw : (raw.candles || raw.data || raw.ohlcv || []);
  const analysis = chartBuilder.buildFullChartAnalysis(candles, ticker);
  const validation = validateAnalysis(analysis, ticker);

  if (validation.isRejected) {
    rejectedCount++;
    rejectedTickers.push({
      ticker,
      status: 'REJECTED',
      reason: validation.reject_reason,
      note: validation.note,
      candles_count: analysis.candles_count
    });
    perTickerResults[ticker] = {
      status: 'REJECTED',
      reject_reason: validation.reject_reason,
      note: validation.note,
      candles_count: analysis.candles_count
    };
  } else if (validation.valid) {
    passCount++;
    perTickerResults[ticker] = {
      status: 'PASS',
      candles_count: analysis.candles_count,
      lastPrice: analysis.lastPrice,
      indicators: analysis.indicators,
      cone10: analysis.cone10,
      modes: analysis.modes,
      trade_plan_v2: analysis.trade_plan_v2
    };
  } else {
    failCount++;
    failedTickers.push({
      ticker,
      status: 'FAIL',
      errors: validation.errors,
      candles_count: analysis ? analysis.candles_count : 0
    });
    if (validation.errors.some(e => e.includes('NAN') || e.includes('INVALID_NUMERIC'))) countNan++;
    if (validation.errors.some(e => e.includes('SL_GE_ENTRY'))) countSlGeEntry++;
    if (validation.errors.some(e => e.includes('SUPPORT_GE_RESISTANCE'))) countSupGeRes++;

    perTickerResults[ticker] = {
      status: 'FAIL',
      errors: validation.errors,
      candles_count: analysis ? analysis.candles_count : 0
    };
  }

  if ((i + 1) % 200 === 0 || (i + 1) === files.length) {
    console.log(`Progress: ${i + 1}/${files.length} tickers... (PASS: ${passCount}, REJECTED: ${rejectedCount}, FAIL: ${failCount})`);
  }
}

const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(2);
console.log(`\nAudit selesai dalam ${elapsedSeconds} detik.`);
console.log(`TOTAL TICKER: ${files.length}`);
console.log(`PASS: ${passCount}`);
console.log(`REJECTED: ${rejectedCount}`);
console.log(`FAIL: ${failCount}`);

// ============================================================================
// 3D. RINGKASAN & BUKTI ARTEFAK
// ============================================================================
const summaryData = {
  meta: {
    fase: 3,
    title: 'Audit Level Chart 964 Saham + IHSG; 5 Mode & Kerucut 10 Hari',
    version: 'fase03-verified-v2',
    timestamp: new Date().toISOString(),
    elapsedSeconds: Number(elapsedSeconds),
    source_dir: CANDLE_DIR
  },
  negative_controls: {
    status: allNcPassed ? 'ALL_PASSED' : 'FAILED',
    total: negativeControls.length,
    passed: negativeControls.filter(x => x.passed_control).length,
    controls: negativeControls
  },
  counts: {
    total: files.length,
    pass: passCount,
    rejected: rejectedCount,
    fail: failCount,
    nan_occurrences: countNan,
    sl_ge_entry_occurrences: countSlGeEntry,
    support_ge_resistance_occurrences: countSupGeRes
  },
  rejected_summary: {
    total: rejectedCount,
    breakdown: {
      EMPTY_CANDLES: rejectedTickers.filter(t => t.reason === 'EMPTY_CANDLES').length,
      STOP_NOT_BELOW_ENTRY: rejectedTickers.filter(t => t.reason === 'STOP_NOT_BELOW_ENTRY').length
    },
    tickers: rejectedTickers
  },
  failed_summary: {
    total: failCount,
    tickers: failedTickers
  }
};

const perTickerData = {
  meta: summaryData.meta,
  summary_counts: summaryData.counts,
  negative_controls: summaryData.negative_controls,
  rejected_list: rejectedTickers,
  failed_list: failedTickers,
  per_ticker: perTickerResults
};

fs.writeFileSync(OUT_PER_TICKER, JSON.stringify(perTickerData, null, 2));
fs.writeFileSync(OUT_SUMMARY, JSON.stringify(summaryData, null, 2));

const perTickerSize = (fs.statSync(OUT_PER_TICKER).size / 1024).toFixed(1);
const summarySize = (fs.statSync(OUT_SUMMARY).size / 1024).toFixed(1);

console.log('\n--- ARTEFAK TERSIMPAN ---');
console.log(`1. ${OUT_PER_TICKER} (${perTickerSize} KB)`);
console.log(`2. ${OUT_SUMMARY} (${summarySize} KB)`);
console.log('================================================================');
