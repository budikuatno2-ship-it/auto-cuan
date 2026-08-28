'use strict';

/**
 * Pure informational High R:R warning flag for Swing Non-Konglo.
 *
 * KONTEKS & TEMUAN DATA:
 * Investigasi data production (500+ sinyal historis, analisis FASE 4) menemukan
 * pola konsisten: pada Swing Non-Konglo, sinyal yang berujung SL_HIT punya
 * rata-rata risk:reward ratio (R:R) sekitar 3.3:1, sedangkan yang berujung
 * TP1_HIT rata-rata cuma 2.1:1. Semakin tinggi target R:R, semakin sering kena SL
 * dulu sebelum sempat ke TP dalam window pantau swing 3-7 hari (sample terbatas
 * 11-16 kejadian resolved).
 *
 * KEPUTUSAN PRODUK:
 * - Cuma berlaku untuk Swing Non-Konglo (BUKAN Swing Konglo atau Day Trade).
 * - Bentuknya LABEL/WARNING informasional, BUKAN blocking/filtering — sinyal
 *   dengan R:R tinggi tetap dipublish apa adanya, tidak merubah scoring,
 *   filtering, atau keputusan publish.
 * - Threshold: R:R > 2.5:1 dianggap "tinggi", dibuat sebagai konstanta bernama.
 */

// Threshold R:R di atas mana sinyal Swing Non-Konglo diberi warning informasional.
const SWING_NK_HIGH_RR_WARNING_THRESHOLD = 2.5;

function toNumber(v) {
  var n = typeof v === 'number' ? v : parseFloat(v);
  return isFinite(n) ? n : null;
}

function candidateLevels(candidate) {
  candidate = candidate || {};
  var entryLow = toNumber(
    candidate.entry_low != null
      ? candidate.entry_low
      : (candidate.entry2 != null ? candidate.entry2 : candidate.entry1)
  );
  var entryHigh = toNumber(
    candidate.entry_high != null
      ? candidate.entry_high
      : (candidate.entry1 != null ? candidate.entry1 : candidate.entry2)
  );
  if (entryLow != null && entryHigh != null && entryLow > entryHigh) {
    var t = entryLow; entryLow = entryHigh; entryHigh = t;
  }
  var entry = (entryLow != null && entryHigh != null)
    ? (entryLow + entryHigh) / 2
    : (entryLow != null ? entryLow : (entryHigh != null ? entryHigh : toNumber(candidate.entry)));
  var sl = toNumber(candidate.sl != null ? candidate.sl : candidate.stop_loss);
  var tp1 = toNumber(candidate.tp1n != null ? candidate.tp1n : (candidate.tp1 != null ? candidate.tp1 : candidate.target1));
  return {
    entry_low: entryLow,
    entry_high: entryHigh,
    entry: entry,
    sl: sl,
    tp1: tp1
  };
}

/**
 * Hitung R:R = (tp1 - entry) / (entry - sl).
 * Jika level valid tidak tersedia tapi candidate.risk_reward sudah ada, gunakan risk_reward.
 */
function calculateCandidateRiskReward(candidate) {
  candidate = candidate || {};
  var lv = candidateLevels(candidate);
  if (lv.entry != null && lv.sl != null && lv.tp1 != null) {
    var riskAmt = lv.entry - lv.sl;
    var rewardAmt = lv.tp1 - lv.entry;
    if (riskAmt > 0 && rewardAmt > 0) {
      return rewardAmt / riskAmt;
    }
  }
  var fallbackRr = toNumber(candidate.risk_reward);
  return fallbackRr != null && fallbackRr > 0 ? fallbackRr : null;
}

/**
 * Cek apakah candidate adalah kategori Swing Non-Konglo.
 */
function isSwingNonKongloCandidate(candidate, explicitCategory) {
  var cat = String(
    explicitCategory ||
    (candidate && (candidate.category || candidate.screener_type || candidate.mode || candidate.source)) ||
    ''
  ).toLowerCase().trim();

  if (cat === 'swing_nk' || cat === 'swing non-konglo' || cat === 'swing non konglo' || cat === 'nonkonglo') {
    return true;
  }
  return false;
}

/**
 * Memberikan flag high_rr_warning dan high_rr_warning_note pada candidate
 * Swing Non-Konglo jika R:R > SWING_NK_HIGH_RR_WARNING_THRESHOLD (2.5).
 *
 * SIFAT:
 * - Mutates candidate in-place dan return candidate.
 * - Tidak pernah mengubah entry/sl/tp/score/status/grade atau memfilter candidate.
 */
function annotateSwingNkHighRrWarning(candidate, opts) {
  if (!candidate || typeof candidate !== 'object') return candidate;
  opts = opts || {};

  var threshold = toNumber(opts.threshold) != null ? toNumber(opts.threshold) : SWING_NK_HIGH_RR_WARNING_THRESHOLD;
  var rr = calculateCandidateRiskReward(candidate);

  if (rr != null && rr > threshold) {
    var formattedRr = Number(rr.toFixed(1));
    candidate.high_rr_warning = true;
    candidate.high_rr_warning_note =
      'Target R:R ' + formattedRr + ':1 lebih tinggi dari rata-rata sinyal yang berhasil (2.1:1) berdasarkan data historis. ' +
      'Sinyal dengan target R:R tinggi secara historis lebih sering kena SL sebelum TP pada window pantau swing 3-7 hari.';
  } else {
    candidate.high_rr_warning = false;
    candidate.high_rr_warning_note = null;
  }

  return candidate;
}

/**
 * Helper untuk memproses array candidate.
 */
function annotateSwingNkHighRrWarnings(candidates, opts) {
  if (!Array.isArray(candidates)) return candidates || [];
  for (var i = 0; i < candidates.length; i++) {
    annotateSwingNkHighRrWarning(candidates[i], opts);
  }
  return candidates;
}

module.exports = {
  SWING_NK_HIGH_RR_WARNING_THRESHOLD: SWING_NK_HIGH_RR_WARNING_THRESHOLD,
  candidateLevels: candidateLevels,
  calculateCandidateRiskReward: calculateCandidateRiskReward,
  isSwingNonKongloCandidate: isSwingNonKongloCandidate,
  annotateSwingNkHighRrWarning: annotateSwingNkHighRrWarning,
  annotateSwingNkHighRrWarnings: annotateSwingNkHighRrWarnings
};
