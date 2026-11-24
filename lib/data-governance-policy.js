'use strict';

/**
 * lib/data-governance-policy.js
 * ============================================================================
 * DATA GOVERNANCE DIRECTIVE — PERIODE 16 NOVEMBER 2026 & ANTI-FABRIKASI
 * ============================================================================
 *
 * Kebijakan Eksplisit Data Governance Auto-Cuan V6:
 * 1. Tanggal trading terakhir yang sah, valid, dan terbukti lengkap di database
 *    adalah Jumat, 13 November 2026 (2026-11-13).
 * 2. Sesi bursa Senin, 16 November 2026 (2026-11-16) telah ditutup (15:50 WIB),
 *    tetapi pipeline EOD/Broksum upstream belum ditarik ke SQLite VPS karena
 *    jendela batch sinkronisasi resmi malam (20:30 WIB) belum/sedang berlangsung.
 * 3. INVARIAN NON-NEGOSIASI: ZERO FABRICATION & NO-MOCK. Sistem dilarang keras
 *    membuat, menyisipkan, menginterpolasi, atau memaksakan candle/data sintetis
 *    untuk 16 November 2026.
 * 4. Konsumen data (api/chart.js, api/candles.js, dsb) wajib melaporkan status
 *    secara jujur:
 *      as_of: '2026-11-13' (atau tanggal aktual terakhir yang sah)
 *      status: 'not_due' (jika dalam antrean batch) atau 'stale' (jika kedaluwarsa)
 *
 * CATATAN KASUS (TAHAP 1, 2026-11-19): nilai status memakai huruf KECIL
 * ('fresh' | 'stale' | 'not_due' | 'unavailable') agar konsisten dengan
 * `t1_status` yang sudah huruf kecil di lib/chart-t1-policy.js. Nilai dan
 * makna TIDAK berubah - hanya casing. ('NOT_DUE' -> 'not_due', 'STALE' ->
 * 'stale', 'FRESH' -> 'fresh', 'UNAVAILABLE' -> 'unavailable').
 */

const LAST_PROVEN_TRADING_DATE = '2026-11-13';
const CURRENT_SESSION_DATE = '2026-11-16';
const ZERO_FABRICATION_ENFORCED = true;

/**
 * Evaluasi status kesegaran data terhadap kebijakan 16 Nov 2026.
 *
 * @param {string|null} actualDataDate - Tanggal data terakhir yang tersedia (YYYY-MM-DD)
 * @param {Date|string|number} [now] - Waktu saat evaluasi dilakukan
 * @returns {object} Metadata kesegaran data
 */
function evaluateDataGovernance(actualDataDate, now) {
  const currentDate = CURRENT_SESSION_DATE;
  const lastProven = LAST_PROVEN_TRADING_DATE;
  const actual = actualDataDate ? String(actualDataDate).slice(0, 10) : null;

  if (!actual) {
    return {
      status: 'unavailable',
      as_of: null,
      last_proven_date: lastProven,
      current_session: currentDate,
      is_synthetic: false,
      reason: 'no_data_available'
    };
  }

  // Jika data sudah mencapai atau melampaui tanggal bursa terakhir yang terbukti
  if (actual >= lastProven) {
    if (actual === lastProven) {
      return {
        status: 'not_due', // EOD 16 Nov belum ditarik oleh batch malam
        as_of: actual,
        last_proven_date: lastProven,
        current_session: currentDate,
        is_synthetic: false,
        reason: 'awaiting_nightly_eod_pipeline_after_2030_wib'
      };
    }
    // Jika actual > lastProven (misal suatu saat nanti 16 Nov sudah masuk secara riil)
    return {
      status: 'fresh',
      as_of: actual,
      last_proven_date: lastProven,
      current_session: currentDate,
      is_synthetic: false,
      reason: 'data_current'
    };
  }

  // Jika data lebih lama dari 13 Nov 2026
  return {
    status: 'stale',
    as_of: actual,
    last_proven_date: lastProven,
    current_session: currentDate,
    is_synthetic: false,
    reason: 'actual_data_predates_last_proven_trading_session'
  };
}

module.exports = {
  LAST_PROVEN_TRADING_DATE,
  CURRENT_SESSION_DATE,
  ZERO_FABRICATION_ENFORCED,
  evaluateDataGovernance
};
