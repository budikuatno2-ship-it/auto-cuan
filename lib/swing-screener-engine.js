'use strict';

/**
 * Swing Screener Engine v2 — Quantitative Meritocracy, Penalty Engine & Edge Tagging
 * =================================================================================
 *
 * Logic & Governance:
 * 1. HARD GATE Risk/Reward:
 *    - Syarat mutlak masuk "High Conviction": R:R WAJIB >= 1.8x.
 *    - Jika R:R < 1.8x (misal JPFA 1.2x), coret dari High Conviction, downgrade ke WATCHLIST / DISCARD.
 * 2. PENALTY ENGINE pada skor keyakinan:
 *    - Trend 5D Bearish: Potong skor minimal -25 poin.
 *    - Candle 1D Merah (Close < Open): Potong skor minimal -15 poin.
 *    - Volume < 1.0x (Kering): Plafon skor maksimal 70 (mustahil dapat 90+).
 *    - Skor 90+ HANYA berhak diberikan jika: Trend Bullish/Uptrend, Candle Konfirmasi Hijau,
 *      Volume >= 1.2x, dan R:R >= 1.8x.
 * 3. ANTI-CONTRADICTION GATE:
 *    - Saham berstatus "Tunggu Pullback" / WAIT_PULLBACK DILARANG disiarkan sebagai "HIGH CONVICTION".
 * 4. SETUP EDGE TAGGING:
 *    - Jangan pernah jadikan RSI_OVERBOUGHT sebagai sinyal bullish swing.
 *    - Klasifikasikan secara benar: Pullback Support MA20, Breakout Resistance, atau Bullish Reversal.
 */

const MIN_SWING_HIGH_CONVICTION_RR = 1.8;
const MIN_SWING_HIGH_CONVICTION_SCORE = 75;
const MIN_SWING_HIGH_CONVICTION_VOLUME = 1.0;

/**
 * Deteksi apakah candle 1D adalah candle merah (Close < Open atau candle bearish)
 * @param {object} r - Candidate row
 * @returns {boolean}
 */
function isRedCandle1D(r) {
  if (!r) return false;
  // 1. Direct prices
  const close = Number(r.last_price || r.lastn || r.close || r.price || 0);
  const open = Number(r.open_price || r.open || 0);
  if (close > 0 && open > 0) {
    if (close < open) return true;
    if (close > open) return false;
  }
  // 2. Daily candle context / bias string
  const tf1 = String(r.tf_1d_context || r.daily_candle_context || r.candle_pattern || r.candle_bias || '').toLowerCase();
  if (/red\s*candle|candle\s*merah|merah|bearish\s*candle|bearish\s*marubozu/i.test(tf1)) {
    return true;
  }
  // 3. Negative change percentage with close <= open if open exists
  const chg = Number(r.change_pct != null ? r.change_pct : (r.chg_pct != null ? r.chg_pct : 0));
  if (chg < 0 && (open === 0 || close < open)) {
    return true;
  }
  if (r.is_red_candle === true || r._isLargeRed === true) {
    return true;
  }
  return false;
}

/**
 * Deteksi apakah tren 5D bearish / downtrend
 * @param {object} r - Candidate row
 * @returns {boolean}
 */
function isBearishTrend5D(r) {
  if (!r) return false;
  const tf5 = String(r.tf_5d_context || r.weekly_candle_context || r.tf_20d_context || '').toLowerCase();
  if (/bearish|downtrend|turun|down|weak|lemah/i.test(tf5)) {
    return true;
  }
  const notes = String(r.notes || r.status_reason || r.trend || '').toLowerCase();
  if (/5d\s*bearish|trend\s*turun|downtrend|5d\s*downtrend/i.test(notes)) {
    return true;
  }
  return false;
}

/**
 * Resolves volume ratio
 * @param {object} r - Candidate row
 * @returns {number|null}
 */
function getVolumeRatio(r) {
  if (!r) return null;
  const v = r.volume_ratio_20d != null ? r.volume_ratio_20d :
           (r.volume_ratio_avg20 != null ? r.volume_ratio_avg20 :
           (r.volume_ratio != null ? r.volume_ratio :
           (r.volume_pace != null ? r.volume_pace : null)));
  return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
}

/**
 * Resolves Risk/Reward ratio
 * @param {object} r - Candidate row
 * @returns {number}
 */
function getRiskReward(r) {
  if (!r) return 0;
  const rr = Number(r.risk_reward != null ? r.risk_reward : (r.rr != null ? r.rr : (r.rr_to_tp1 != null ? r.rr_to_tp1 : 0)));
  return Number.isFinite(rr) ? rr : 0;
}

/**
 * Terapkan PENALTY ENGINE pada skor keyakinan swing:
 * 1. Trend 5D Bearish: Potong skor minimal -25 poin.
 * 2. Candle 1D Merah (Close < Open): Potong skor minimal -15 poin.
 * 3. Volume < 1.0x (Kering): Plafon skor maksimal 70 (mustahil dapat 90+).
 * 4. Skor 90+ HANYA berhak diberikan jika:
 *    - Trend Bullish/Uptrend (TIDAK Bearish)
 *    - Candle Konfirmasi Hijau (TIDAK Merah)
 *    - Volume >= 1.2x (Bukan kering)
 *    - R:R >= 1.8x
 * @param {number} baseScore - Skor dasar sebelum penalti
 * @param {object} candidate - Objek kandidat
 * @returns {object} { score, penaltiesApplied, is5DBearish, is1DRed, volRatio, riskReward, qualifiesFor90Plus }
 */
function applySwingScoringPenalties(baseScore, candidate) {
  let score = Number(baseScore) || 0;
  const penaltiesApplied = [];

  const is5DBearish = isBearishTrend5D(candidate);
  const is1DRed = isRedCandle1D(candidate);
  const vol = getVolumeRatio(candidate);
  const rr = getRiskReward(candidate);

  // 1. Trend 5D Bearish: -25 poin
  if (is5DBearish) {
    score -= 25;
    penaltiesApplied.push('PENALTY_5D_BEARISH (-25)');
  }

  // 2. Candle 1D Merah: -15 poin
  if (is1DRed) {
    score -= 15;
    penaltiesApplied.push('PENALTY_1D_RED_CANDLE (-15)');
  }

  // 3. Volume < 1.0x (Kering): Plafon skor maksimal 70
  if (vol != null && vol < 1.0) {
    if (score > 70) {
      score = 70;
      penaltiesApplied.push('CEILING_VOLUME_DRY_MAX_70');
    }
  }

  // 4. Skor 90+ Meritocracy Lock
  const qualifiesFor90Plus = !is5DBearish && !is1DRed && (vol != null && vol >= 1.2) && (rr >= 1.8);
  if (score >= 90 && !qualifiesFor90Plus) {
    score = 89;
    penaltiesApplied.push('CAPPED_BELOW_90_CRITERIA_UNMET');
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score,
    penaltiesApplied,
    is5DBearish,
    is1DRed,
    volRatio: vol,
    riskReward: rr,
    qualifiesFor90Plus
  };
}

/**
 * Klasifikasikan Setup Edge Swing secara benar:
 * - Pullback Support MA20
 * - Breakout Resistance
 * - Bullish Reversal
 * JANGAN PERNAH jadikan RSI_OVERBOUGHT sebagai sinyal bullish swing!
 * @param {object} r - Objek kandidat
 * @returns {string|null}
 */
function classifySwingEdge(r) {
  if (!r) return null;
  const last = Number(r.last_price || r.lastn || r.close || r.price || 0);
  const ma20 = Number(r.ma20 || (r.indicators && r.indicators.ma20) || 0);
  const resistance = Number(r.resistance || 0);
  const support = Number(r.support || 0);
  const vol = getVolumeRatio(r);
  const rsi = Number(r.rsi14 != null ? r.rsi14 : (r.rsi || 0));
  const candlePattern = String(r.candle_pattern || r.pattern_label || '').toLowerCase();
  const setupType = String(r.setupType || r.setup_type || '').toLowerCase();
  const breakoutLabel = String(r.breakout_confirmation_label || '').toLowerCase();

  // RSI Overbought (> 70) adalah kondisi rawan koreksi / exhaustion — DILARANG menjadi entry edge!
  if (rsi >= 70) {
    return null;
  }

  // 1. Breakout Resistance: Harga menguji/menembus resistance dengan ekspansi volume
  if (setupType === 'breakout' || breakoutLabel.includes('breakout') || (resistance > 0 && last >= resistance * 0.99)) {
    if (vol != null && vol >= 1.2) {
      return 'BREAKOUT_RESISTANCE';
    }
  }

  // 2. Pullback Support MA20: Retest MA20 dengan RSI sehat (45 - 68)
  if (setupType === 'pullback' || (ma20 > 0 && last >= ma20 * 0.98 && last <= ma20 * 1.05)) {
    if (rsi >= 45 && rsi <= 68) {
      return 'PULLBACK_SUPPORT_MA20';
    }
  }

  // 3. Bullish Reversal: Pola candle reversal di support atau oversold rebound
  if (/hammer|morning star|bullish engulfing|dragonfly doji|tweezer bottom/i.test(candlePattern) ||
      setupType === 'rebound' || (support > 0 && last >= support * 0.99 && last <= support * 1.03 && rsi >= 30 && rsi <= 45)) {
    return 'BULLISH_REVERSAL';
  }

  // 4. Default structural check
  if (ma20 > 0 && last >= ma20) {
    return 'TECH_ABOVE_MA20';
  }

  return null;
}

/**
 * Hard Gate Risk/Reward & Confirmation for High Conviction Swing
 * - Syarat mutlak masuk "High Conviction": R:R WAJIB >= 1.8x.
 * - Jika R:R < 1.8x (seperti JPFA 1.2x): CORET dari High Conviction, downgrade ke WATCHLIST / DISCARD.
 * - Jika status adalah "Tunggu Pullback" / "WAIT_PULLBACK": DILARANG lolos ke High Conviction.
 * - Skor setelah penalty engine harus >= MIN_SWING_HIGH_CONVICTION_SCORE (75).
 * @param {object} candidate - Objek kandidat
 * @param {object} options - Opsi evaluasi
 * @returns {object|null}
 */
function verifySwingHighConviction(candidate, options = {}) {
  if (!candidate) return null;
  const r = Object.assign({}, candidate);
  const rr = getRiskReward(r);
  const status = String(r.status || r.final_status || '').toUpperCase();
  const action = String(r.telegram_action_label || r.action_label || r.action || '').toLowerCase();
  const notes = String(r.notes || r.status_reason || r.telegram_verdict || '').toLowerCase();

  // 1. HARD GATE: Status Tunggu Pullback DILARANG masuk High Conviction
  if (status.includes('WAIT_PULLBACK') || status.includes('WAIT PULLBACK') ||
      action.includes('tunggu pullback') || action.includes('wait pullback') ||
      notes.includes('tunggu pullback') || notes.includes('wait pullback')) {
    return null; // Fatal contradiction: Tidak boleh menyiarkan status "Tunggu Pullback" dalam High Conviction!
  }

  // 2. HARD GATE: Risk/Reward WAJIB >= 1.8x
  if (rr < MIN_SWING_HIGH_CONVICTION_RR) {
    return null; // Failed R:R gate! Downgrade / Discard.
  }

  // 3. HARD GATE: Distribution / Failed notes
  if (/failed|gagal|distribusi|distribution|chase/i.test(notes) && !/akumulasi/i.test(notes)) {
    return null;
  }

  // 4. Hitung skor terkoreksi dengan Penalty Engine
  const initialScore = Number(r.conviction_score || r.score || r.telegram_conviction_score || 50);
  const evaluation = applySwingScoringPenalties(initialScore, r);

  r.conviction_score = evaluation.score;
  r.telegram_conviction_score = evaluation.score;
  r.score = evaluation.score;

  // 5. Hard threshold skor High Conviction
  if (evaluation.score < MIN_SWING_HIGH_CONVICTION_SCORE) {
    return null;
  }

  // 6. Setup Edge classification
  const classifiedEdge = classifySwingEdge(r);
  if (classifiedEdge) {
    r.pattern_personality = classifiedEdge;
    r.pattern_key = classifiedEdge;
  } else if (r.pattern_personality && String(r.pattern_personality).includes('RSI_OVERBOUGHT')) {
    delete r.pattern_personality;
    delete r.pattern_key;
  }

  return r;
}

module.exports = {
  MIN_SWING_HIGH_CONVICTION_RR,
  MIN_SWING_HIGH_CONVICTION_SCORE,
  MIN_SWING_HIGH_CONVICTION_VOLUME,
  isRedCandle1D,
  isBearishTrend5D,
  getVolumeRatio,
  getRiskReward,
  applySwingScoringPenalties,
  classifySwingEdge,
  verifySwingHighConviction
};
