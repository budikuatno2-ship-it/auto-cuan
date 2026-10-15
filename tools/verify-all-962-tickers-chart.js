'use strict';

/**
 * Audit 1-per-1 Seluruh 962 Saham BEI (Fase 6.5)
 *
 * Menguji setiap emiten (dari AADI hingga ZYRX) melalui pipeline:
 * 1. Pemuatan candle harian (getCandles)
 * 2. Kalkulasi moving average dan RSI 14
 * 3. Kalkulasi Bandar Metrics (LPM, CMF, Intensity, Volume Rotation)
 * 4. Pengecekan ketat: 0 exception, 0 NaN, penanganan fallback riwayat pendek.
 *
 * Menghasilkan artefak bukti audit: `docs/evidence/fase-6/TICKER_962_AUDIT.json`.
 */

const fs = require('node:fs');
const path = require('node:path');
const store = require('../lib/local-market-subset-store');
const bandarMetricsEngine = require('../lib/bandar-metrics-engine');

const OUTPUT_JSON_PATH = path.join(__dirname, '..', 'docs', 'evidence', 'fase-6', 'TICKER_962_AUDIT.json');

function containsNaN(obj) {
  if (obj === null || obj === undefined) return false;
  if (typeof obj === 'number') return Number.isNaN(obj);
  if (typeof obj === 'string' || typeof obj === 'boolean') return false;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (containsNaN(obj[i])) return true;
    }
    return false;
  }
  if (typeof obj === 'object') {
    for (const key of Object.keys(obj)) {
      if (containsNaN(obj[key])) return true;
    }
  }
  return false;
}

function auditAll962Tickers() {
  console.log('=== MEMULAI AUDIT 1-PER-1 SELURUH 962 SAHAM BEI ===');
  console.time('Total Audit Runtime');

  const tickers = store.getAllTickers();
  console.log(`Jumlah emiten yang akan diaudit: ${tickers.length}`);

  const results = {
    audit_date: '2026-10-15',
    total_tickers: tickers.length,
    passed_count: 0,
    failed_count: 0,
    tickers_with_candles: 0,
    tickers_without_candles: 0,
    nan_occurrences: 0,
    exceptions_thrown: 0,
    ticker_details: []
  };

  let processed = 0;

  for (const ticker of tickers) {
    processed++;
    if (processed % 200 === 0 || processed === tickers.length) {
      console.log(`Audit progres: ${processed}/${tickers.length} (${ticker})...`);
    }

    const detail = {
      ticker,
      has_candles: false,
      candle_count: 0,
      latest_date: null,
      latest_close: null,
      has_nan: false,
      has_exception: false,
      exception_message: null,
      audit_status: 'PENDING'
    };

    try {
      const candleData = store.getCandles(ticker);

      if (!candleData || !candleData.candles || candleData.candles.length === 0) {
        detail.has_candles = false;
        detail.audit_status = 'NO_CANDLE_DATA_CLEAN_FALLBACK';
        results.tickers_without_candles++;
      } else {
        detail.has_candles = true;
        detail.candle_count = candleData.candles.length;
        detail.latest_date = candleData.latest ? candleData.latest.date : null;
        detail.latest_close = candleData.latest ? candleData.latest.last : null;
        results.tickers_with_candles++;

        // Uji metrik teknikal
        const hasNanInMetrics = containsNaN(candleData.metrics);

        // Uji Bandar Metrics Engine
        const bandarMetrics = bandarMetricsEngine.calculateBandarMetrics({
          candles: candleData.candles
        });

        const hasNanInBandar = containsNaN(bandarMetrics);

        if (hasNanInMetrics || hasNanInBandar) {
          detail.has_nan = true;
          detail.audit_status = 'NAN_DETECTED';
          results.nan_occurrences++;
          results.failed_count++;
        } else {
          detail.audit_status = 'AUDITED_OK';
          results.passed_count++;
        }
      }
    } catch (err) {
      detail.has_exception = true;
      detail.exception_message = err.message;
      detail.audit_status = 'EXCEPTION_THROWN';
      results.exceptions_thrown++;
      results.failed_count++;
    }

    results.ticker_details.push(detail);
  }

  console.timeEnd('Total Audit Runtime');

  console.log('\n=== HASIL AUDIT 1-PER-1 962 SAHAM BEI ===');
  console.log(`Total Emiten: ${results.total_tickers}`);
  console.log(`Emiten dengan Candle Riil: ${results.tickers_with_candles}`);
  console.log(`Emiten Riwayat Kosong / Dorman (Fallback Bersih): ${results.tickers_without_candles}`);
  console.log(`Lulus Verifikasi (AUDITED_OK): ${results.passed_count}`);
  console.log(`Kemunculan Nilai NaN: ${results.nan_occurrences}`);
  console.log(`Exception Dilempar: ${results.exceptions_thrown}`);
  console.log(`Status Audit Keseluruhan: ${results.failed_count === 0 ? '100% LULUS (ZERO REGRESSION)' : 'GAGAL'}`);

  fs.mkdirSync(path.dirname(OUTPUT_JSON_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_JSON_PATH, JSON.stringify(results, null, 2), 'utf8');
  console.log(`Laporan JSON audit tersimpan di: ${OUTPUT_JSON_PATH}`);

  return results;
}

if (require.main === module) {
  auditAll962Tickers();
}

module.exports = { auditAll962Tickers };
