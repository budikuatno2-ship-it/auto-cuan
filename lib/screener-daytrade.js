'use strict';

/**
 * V3-F04 Screener DayTrade — filter konfluensi ketat pemenang V3-F03 + Radar hidup.
 * Selaras: lib/backtest-multifactor-964.js + lib/v3-f03-winning-params.js.
 * Aturan: skor>=62, R/R>=1.50, likuiditas aktif valueAvg20>=Rp1M,
 * bandar netral/lolos bsMin, publishedCount <= ceil(universe*0.35), urut skor desc.
 * Toggle mentah: "Tampilkan seluruh universe mentah" saja.
 *
 * Radar hidup (hapus pengunci no_final_signal_but_radar_disabled):
 * bila 0 kandidat TRADE kelas A lolos, terbitkan kandidat RADAR/WATCH terbaik
 * (skor tertinggi di bawah gate, maks 3) tanpa macet — reason RADAR_FALLBACK.
 */

const mf964 = require('./backtest-multifactor-964');
const v3f03 = require('./v3-f03-winning-params');

const V3_F04 = 'V3-F04';
const SCORE_MIN = 62;
const RR_MIN = 1.5;
const CAP_RATIO = 0.35;
const UNIVERSE_SIZE = 165;
const SHOW_RAW_TOGGLE_LABEL = 'Tampilkan seluruh universe mentah';
const RADAR_FALLBACK_REASON = 'RADAR_FALLBACK';
const LEGACY_RADAR_LOCK = 'no_final_signal_but_radar_disabled';

function getStrictParams() {
  const base = v3f03.getMachineParams('daytrade');
  return {
    scoreMin: Math.max(SCORE_MIN, Number(base.scoreMin) || 60),
    bsMin: Number(base.bsMin) || 1.0,
    volMin: Number(base.volMin) || 1.0,
    rrMin: Math.max(RR_MIN, Number(base.rrMin) || 1.5),
    horizon: Number(base.horizon) || 2
  };
}

function passesStrictConfluence(feat, scored) {
  if (!feat || !scored) return false;
  if (scored.pass !== true) return false;
  if (!(scored.score >= SCORE_MIN)) return false;
  if (!(scored.structuralRR >= RR_MIN)) return false;
  if (!(feat.valueAvg20 >= 1000000000)) return false;
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
  if (showRaw) return { published: scoredRows, capped: false, reason: SHOW_RAW_TOGGLE_LABEL, radar: [] };
  const strict = (scoredRows || []).filter((r) => r && r.v3f04_strict_pass === true);
  const out = capAndSort(strict, universeCount || UNIVERSE_SIZE);
  // Radar hidup: bila 0 TRADE kelas A, terbitkan RADAR/WATCH terbaik (maks 3) tanpa macet.
  let radar = [];
  if (out.capped.length === 0) {
    radar = (scoredRows || [])
      .filter((r) => r && r.v3f04_strict_pass !== true)
      .slice()
      .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
      .slice(0, 3)
      .map((r) => Object.assign({}, r, { tier: 'RADAR', radar_reason: RADAR_FALLBACK_REASON }));
  }
  return { published: out.capped, capped: true, cap: out.cap, reason: out.capped.length > 0 ? 'v3f04_strict' : RADAR_FALLBACK_REASON, radar };
}

module.exports = {
  V3_F04,
  SCORE_MIN,
  RR_MIN,
  CAP_RATIO,
  UNIVERSE_SIZE,
  SHOW_RAW_TOGGLE_LABEL,
  RADAR_FALLBACK_REASON,
  LEGACY_RADAR_LOCK,
  getStrictParams,
  passesStrictConfluence,
  capAndSort,
  filterPublished
};
