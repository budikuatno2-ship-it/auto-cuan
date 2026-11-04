'use strict';

/**
 * V3-F04 Screener Konglo — filter konfluensi ketat pemenang V3-F03.
 * =================================================================
 * Selaras dengan engine aktual:
 *   - Skor: lib/backtest-multifactor-964.js scoreBar (100% data riil)
 *   - Loader params: lib/v3-f03-winning-params.js (config/v3-f03-winning-params.json)
 *   - Badge: lib/screener-eod-badge.js (0 Stale)
 *
 * Aturan V3-F04 (ketat, anti 165/165 lolos mentah):
 *   - skor >= 62 (naik dari 60 pemenang)
 *   - R/R struktural >= 1.50
 *   - likuiditas aktif: valueAvg20 >= Rp5M (MACHINE_DEFAULTS konglo)
 *   - akumulasi bandar mendukung: bsMax == null (netral, data hilang) ATAU bsMax >= bsMin pemenang
 *   - publishedCount <= ceil(universe * 0.35), urut skor desc
 *   - Toggle eksplisit "Tampilkan seluruh universe mentah" saja yang boleh membuka universe mentah.
 */

const mf964 = require('./backtest-multifactor-964');
const v3f03 = require('./v3-f03-winning-params');

// V3-F04 marker.
const V3_F04 = 'V3-F04';
const SCORE_MIN = 62;
const RR_MIN = 1.5;
const CAP_RATIO = 0.35;
const UNIVERSE_SIZE = 165;
const SHOW_RAW_TOGGLE_LABEL = 'Tampilkan seluruh universe mentah';

function getStrictParams() {
  const base = v3f03.getMachineParams('konglo');
  return {
    scoreMin: Math.max(SCORE_MIN, Number(base.scoreMin) || 60),
    bsMin: Number(base.bsMin) || 1.0,
    volMin: Number(base.volMin) || 1.0,
    rrMin: Math.max(RR_MIN, Number(base.rrMin) || 1.5),
    horizon: Number(base.horizon) || 7
  };
}

function passesStrictConfluence(feat, scored) {
  if (!feat || !scored) return false;
  if (scored.pass !== true) return false;
  if (!(scored.score >= SCORE_MIN)) return false;
  if (!(scored.structuralRR >= RR_MIN)) return false;
  // Likuiditas aktif (konglo >= Rp5M).
  if (!(feat.valueAvg20 >= 5000000000)) return false;
  // Akumulasi bandar mendukung: null = netral (data hilang), selain itu wajib >= bsMin.
  const params = getStrictParams();
  const bsMax = mf964.maxBs(feat.bs);
  if (bsMax !== null && !(bsMax >= params.bsMin)) return false;
  return true;
}

function capAndSort(rows, universeCount) {
  const cap = Math.ceil(Number(universeCount || rows.length) * CAP_RATIO);
  const sorted = (rows || []).slice().sort((a, b) => {
    const sa = Number(a.score != null ? a.score : a.daytrade_score) || 0;
    const sb = Number(b.score != null ? b.score : b.daytrade_score) || 0;
    if (sb !== sa) return sb - sa;
    return String(a.ticker || '').localeCompare(String(b.ticker || ''));
  });
  return { capped: sorted.slice(0, cap), cap };
}

function filterPublished(scoredRows, universeCount, opts) {
  const showRaw = !!(opts && opts.showRawUniverse === true);
  if (showRaw) return { published: scoredRows, capped: false, reason: SHOW_RAW_TOGGLE_LABEL };
  const strict = (scoredRows || []).filter((r) => r && r.v3f04_strict_pass === true);
  const out = capAndSort(strict, universeCount || UNIVERSE_SIZE);
  return { published: out.capped, capped: true, cap: out.cap, reason: 'v3f04_strict' };
}

module.exports = {
  V3_F04,
  SCORE_MIN,
  RR_MIN,
  CAP_RATIO,
  UNIVERSE_SIZE,
  SHOW_RAW_TOGGLE_LABEL,
  getStrictParams,
  passesStrictConfluence,
  capAndSort,
  filterPublished
};
