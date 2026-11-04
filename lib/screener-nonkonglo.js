'use strict';

/**
 * V3-F04 Screener Non-Konglo — filter konfluensi ketat pemenang V3-F03.
 * Selaras: lib/backtest-multifactor-964.js + lib/v3-f03-winning-params.js.
 * Aturan: skor>=62, R/R>=1.50 (pemenang nonkonglo 1.8, diambil max ketat 1.8),
 * likuiditas aktif valueAvg20 < Rp5M (partisi nonkonglo), bandar netral/lolos bsMin,
 * publishedCount <= ceil(universe*0.35), urut skor desc.
 * Toggle mentah: "Tampilkan seluruh universe mentah" saja.
 */

const mf964 = require('./backtest-multifactor-964');
const v3f03 = require('./v3-f03-winning-params');

const V3_F04 = 'V3-F04';
const SCORE_MIN = 62;
const RR_MIN = 1.5;
const CAP_RATIO = 0.35;
const UNIVERSE_SIZE = 165;
const SHOW_RAW_TOGGLE_LABEL = 'Tampilkan seluruh universe mentah';

function getStrictParams() {
  const base = v3f03.getMachineParams('nonkonglo');
  return {
    scoreMin: Math.max(SCORE_MIN, Number(base.scoreMin) || 60),
    bsMin: Number(base.bsMin) || 1.0,
    volMin: Number(base.volMin) || 1.5,
    rrMin: Math.max(RR_MIN, Number(base.rrMin) || 1.8),
    horizon: Number(base.horizon) || 5
  };
}

function passesStrictConfluence(feat, scored) {
  if (!feat || !scored) return false;
  if (scored.pass !== true) return false;
  if (!(scored.score >= SCORE_MIN)) return false;
  if (!(scored.structuralRR >= RR_MIN)) return false;
  // Likuiditas aktif partisi nonkonglo: valueAvg20 < Rp5M (dan > 0).
  if (!(feat.valueAvg20 > 0 && feat.valueAvg20 < 5000000000)) return false;
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
