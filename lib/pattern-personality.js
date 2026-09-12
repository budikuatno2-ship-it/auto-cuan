'use strict';

/**
 * Pattern Personality Quantitative Catalog & Edge Engine
 *
 * Mengintegrasikan 10 pola historis dengan edge statistik (PF, WR, MFE, MAE)
 * untuk scoring meritokrasi screener dan notifikasi Telegram Signal Card v2.
 */

const PATTERN_PERSONALITY_CATALOG = {
  COMBO_FX_TECH_MA5: {
    key: 'COMBO_FX_TECH_MA5',
    name: 'Combo Foreign & Tech MA5',
    samples: 67,
    pf: 2.06,
    wr: 64.2,
    mfe: 9.8,
    mae: -5.9,
    description: 'Foreign Inflow + Price Above MA5'
  },
  FX_STRONG_BUY: {
    key: 'FX_STRONG_BUY',
    name: 'Foreign Strong Buy',
    samples: 67,
    pf: 1.80,
    wr: 61.2,
    mfe: 10.8,
    mae: -5.4,
    description: 'Heavy Foreign Accumulation'
  },
  TECH_ABOVE_MA20: {
    key: 'TECH_ABOVE_MA20',
    name: 'Tech Above MA20',
    samples: 137,
    pf: 1.90,
    wr: 60.6,
    mfe: 11.0,
    mae: -8.2,
    description: 'Price Above MA20 (Medium Term Uptrend)'
  },
  TECH_ABOVE_MA5: {
    key: 'TECH_ABOVE_MA5',
    name: 'Tech Above MA5',
    samples: 143,
    pf: 1.89,
    wr: 60.1,
    mfe: 10.8,
    mae: -8.9,
    description: 'Price Above MA5 (Short Term Momentum)'
  },
  VOL_WARM_1P2_1P5: {
    key: 'VOL_WARM_1P2_1P5',
    name: 'Volume Warm 1.2x-1.5x',
    samples: 15,
    pf: 1.46,
    wr: 60.0,
    mfe: 11.8,
    mae: -7.1,
    description: 'Moderate Volume Thrust (1.2x - 1.5x)'
  },
  RSI_OVERBOUGHT_65P: {
    key: 'RSI_OVERBOUGHT_65P',
    name: 'RSI Momentum 65+',
    samples: 122,
    pf: 1.73,
    wr: 59.8,
    mfe: 10.2,
    mae: -8.7,
    description: 'Momentum RSI >= 65'
  },
  COMBO_BROKER_FX: {
    key: 'COMBO_BROKER_FX',
    name: 'Combo Broker & Foreign',
    samples: 28,
    pf: 1.71,
    wr: 57.1,
    mfe: 12.3,
    mae: -5.9,
    description: 'Bandar Accumulation + Foreign Inflow'
  },
  COMBO_BROKER_TECH: {
    key: 'COMBO_BROKER_TECH',
    name: 'Combo Broker & Tech',
    samples: 66,
    pf: 1.67,
    wr: 56.1,
    mfe: 12.6,
    mae: -9.2,
    description: 'Bandar Accumulation + Price Above MA'
  },
  TRAP_CHG5_VOL3_CLIMAX: {
    key: 'TRAP_CHG5_VOL3_CLIMAX',
    name: 'Trap / Climax Change >=5% Vol >=3x',
    samples: 9,
    pf: 1.84,
    wr: 55.6,
    mfe: 29.1,
    mae: -5.9,
    description: 'Explosive Momentum (Chg >= 5% & Vol >= 3x)'
  },
  BROKER_TOP3_CONCENTRATION: {
    key: 'BROKER_TOP3_CONCENTRATION',
    name: 'Broker Top 3 Concentration',
    samples: 77,
    pf: 1.57,
    wr: 54.5,
    mfe: 11.7,
    mae: -10.3,
    description: 'Top 3 Broker Accumulation Concentration'
  }
};

const SWING_EDGE_CATALOG = {
  PULLBACK_SUPPORT_MA20: {
    key: 'PULLBACK_SUPPORT_MA20',
    name: 'Pullback Support MA20',
    samples: 115,
    pf: 1.92,
    wr: 62.5,
    mfe: 11.4,
    mae: -6.2,
    description: 'Pullback Retest MA20 Support with Healthy Volume'
  },
  BREAKOUT_RESISTANCE: {
    key: 'BREAKOUT_RESISTANCE',
    name: 'Breakout Resistance',
    samples: 98,
    pf: 1.88,
    wr: 61.0,
    mfe: 13.5,
    mae: -7.5,
    description: 'Breakout Resistance with Volume Expansion'
  },
  BULLISH_REVERSAL: {
    key: 'BULLISH_REVERSAL',
    name: 'Bullish Reversal',
    samples: 84,
    pf: 1.81,
    wr: 58.9,
    mfe: 12.0,
    mae: -6.8,
    description: 'Bullish Reversal Candlestick at Support'
  }
};

/**
 * Mengembalikan objek data pola berdasarkan key atau data input.
 * @param {string|object} patternKey
 * @returns {object|null}
 */
function getPatternPersonality(patternKey) {
  if (!patternKey) return null;
  if (typeof patternKey === 'object') {
    if (patternKey.key && (PATTERN_PERSONALITY_CATALOG[patternKey.key] || SWING_EDGE_CATALOG[patternKey.key])) {
      return PATTERN_PERSONALITY_CATALOG[patternKey.key] || SWING_EDGE_CATALOG[patternKey.key];
    }
    if (patternKey.pf != null && patternKey.wr != null) {
      return patternKey;
    }
  }
  const cleanKey = String(patternKey).trim().toUpperCase();
  return PATTERN_PERSONALITY_CATALOG[cleanKey] || SWING_EDGE_CATALOG[cleanKey] || null;
}

/**
 * Menghitung bonus skor screener berdasarkan Profit Factor (PF) pola:
 * - PF >= 2.0 -> +15 poin
 * - PF >= 1.8 -> +10 poin
 * - PF >= 1.6 -> +6 poin
 * - lainnya (valid pattern) -> +3 poin
 * - null/invalid -> 0 poin
 * @param {string|object} patternKey
 * @returns {number}
 */
function calculatePatternScoreBonus(patternKey) {
  const pattern = getPatternPersonality(patternKey);
  if (!pattern || typeof pattern.pf !== 'number' || isNaN(pattern.pf)) return 0;
  if (pattern.pf >= 2.0) return 15;
  if (pattern.pf >= 1.8) return 10;
  if (pattern.pf >= 1.6) return 6;
  return 3;
}

/**
 * Menghasilkan string baris Telegram Edge:
 * Contoh: "COMBO_FX_TECH_MA5 · WR 64.2% · PF 2.06 (MFE +9.8% · MAE -5.9%)"
 * @param {string|object} patternDataOrKey
 * @returns {string|null}
 */
function formatPatternPersonalityLine(patternDataOrKey) {
  const pattern = getPatternPersonality(patternDataOrKey);
  if (!pattern) return null;
  const key = pattern.key || String(patternDataOrKey);
  const wr = Number(pattern.wr).toFixed(1) + '%';
  const pf = Number(pattern.pf).toFixed(2);
  const mfeVal = Number(pattern.mfe);
  const mfeStr = (mfeVal > 0 ? '+' : '') + mfeVal.toFixed(1) + '%';
  const maeVal = Number(pattern.mae);
  const maeStr = (maeVal > 0 ? '+' : '') + maeVal.toFixed(1) + '%';
  return `${key} · WR ${wr} · PF ${pf} (MFE ${mfeStr} · MAE ${maeStr})`;
}

/**
 * Mencocokkan indikator teknikal/foreign/broker yang ada pada kandidat ke key pola yang sesuai.
 * @param {object} r - Candidate row
 * @returns {string|null} Matched pattern key
 */
function matchTickerPattern(r) {
  if (!r || typeof r !== 'object') return null;

  // Jika candidate sudah memiliki key tersemat langsung
  if (r.pattern_personality) {
    const direct = getPatternPersonality(r.pattern_personality);
    if (direct) return direct.key;
  }
  if (r.pattern_key) {
    const directKey = getPatternPersonality(r.pattern_key);
    if (directKey) return directKey.key;
  }

  const last = Number(r.last_price || r.lastn || r.close || r.price || 0);
  const ma5 = Number(r.ma5 || (r.indicators && r.indicators.ma5) || 0);
  const ma20 = Number(r.ma20 || (r.indicators && r.indicators.ma20) || 0);

  const isAboveMa5 = r.above_ma5 === true || (last > 0 && ma5 > 0 && last >= ma5);
  const isAboveMa20 = r.above_ma20 === true || (last > 0 && ma20 > 0 && last >= ma20);

  // Foreign indicators
  const foreignNet = Number(r.foreign_net || r.foreign_1d || r.foreign_flow || r.foreign_buy || 0);
  const foreignLabel = String(r.foreign_label || r.foreign_status || '');
  const hasForeignInflow = foreignNet > 0 || /buy|akum|inflow/i.test(foreignLabel) || r.foreign_grade === 'A' || r.foreign_grade === 'B';
  const hasStrongForeignBuy = r.foreign_grade === 'A' || /strong\s*buy|akumulasi\s*besar/i.test(foreignLabel) || foreignNet >= 1000000000;

  // Broker / Bandar indicators
  const bandarNet = Number(r.bandar_net_flow || r.broker_net_flow || r.cr3_flow || 0);
  const bandarLabel = String(r.bandar_flow_label || r.broker_accumulation_label || r.bandarmologi_status || '');
  const cr3 = Number(r.cr3 != null ? r.cr3 : (r.cr3_flow != null ? r.cr3_flow : 0));
  const hasBrokerAccum = bandarNet > 0 || /akumulasi/i.test(bandarLabel) || r.bandarmologi_score > 0;
  const hasBrokerTop3 = cr3 >= 50 || r.broker_top3_concentration === true || (r.cr3_flow != null && Number(r.cr3_flow) > 0) || /top3|cr3|konsentrasi/i.test(bandarLabel);

  // Volume & Change & RSI
  const volRatio = Number(r.volume_ratio_20d != null ? r.volume_ratio_20d : (r.volume_ratio_avg20 != null ? r.volume_ratio_avg20 : (r.volume_ratio != null ? r.volume_ratio : 0)));
  const chgPct = Number(r.change_pct != null ? r.change_pct : (r.chg_pct != null ? r.chg_pct : (r.pct_change != null ? r.pct_change : (r.d1_change != null ? r.d1_change : 0))));
  const rsi = Number(r.rsi14 != null ? r.rsi14 : (r.rsi_14 != null ? r.rsi_14 : (r.rsi != null ? r.rsi : 0)));

  // Evaluasi secara prioritas (konfluensi dan pola berbobot tinggi lebih dahulu)

  // 1. COMBO_FX_TECH_MA5 (PF 2.06): Inflow asing + di atas MA5
  if (hasForeignInflow && isAboveMa5) {
    return 'COMBO_FX_TECH_MA5';
  }

  // 2. TRAP_CHG5_VOL3_CLIMAX (PF 1.84): Kenaikan >= 5% dan volume ratio >= 3.0x
  if (chgPct >= 5.0 && volRatio >= 3.0) {
    return 'TRAP_CHG5_VOL3_CLIMAX';
  }

  // 3. FX_STRONG_BUY (PF 1.80): Akumulasi asing masif
  if (hasStrongForeignBuy) {
    return 'FX_STRONG_BUY';
  }

  // 4. COMBO_BROKER_FX (PF 1.71): Akumulasi broker + inflow asing
  if (hasBrokerAccum && hasForeignInflow) {
    return 'COMBO_BROKER_FX';
  }

  // 5. COMBO_BROKER_TECH (PF 1.67): Akumulasi broker + teknikal di atas MA5 atau MA20
  if (hasBrokerAccum && (isAboveMa5 || isAboveMa20)) {
    return 'COMBO_BROKER_TECH';
  }

  // Edge Structure: Pullback Support MA20 / Breakout Resistance / Bullish Reversal
  const resistance = Number(r.resistance || 0);
  const support = Number(r.support || 0);
  const candlePattern = String(r.candle_pattern || r.pattern_label || '').toLowerCase();
  const setupType = String(r.setupType || r.setup_type || '').toLowerCase();
  const breakoutLabel = String(r.breakout_confirmation_label || '').toLowerCase();

  // Breakout Resistance
  if (setupType === 'breakout' || breakoutLabel.includes('breakout') || (resistance > 0 && last >= resistance * 0.99)) {
    if (volRatio >= 1.2) {
      return 'BREAKOUT_RESISTANCE';
    }
  }

  // Pullback Support MA20
  if (setupType === 'pullback' || (ma20 > 0 && last >= ma20 * 0.98 && last <= ma20 * 1.05)) {
    if (rsi >= 45 && rsi <= 68) {
      return 'PULLBACK_SUPPORT_MA20';
    }
  }

  // Bullish Reversal
  if (/hammer|morning star|bullish engulfing|dragonfly doji|tweezer bottom/i.test(candlePattern) ||
      setupType === 'rebound' || (support > 0 && last >= support * 0.99 && last <= support * 1.03 && rsi >= 30 && rsi <= 45)) {
    return 'BULLISH_REVERSAL';
  }

  // RSI Overbought >= 70 is EXHAUSTION / OVEREXTENDED: NEVER return as a bullish entry edge!
  if (rsi >= 70) {
    return null;
  }

  // 6. RSI_OVERBOUGHT_65P (PF 1.73): Momentum RSI 65 - 69 only (when not overbought >= 70)
  if (rsi >= 65 && rsi < 70) {
    return 'RSI_OVERBOUGHT_65P';
  }

  // 7. VOL_WARM_1P2_1P5 (PF 1.46): Volume manis di kisaran 1.2x - 1.5x
  if (volRatio >= 1.2 && volRatio <= 1.5) {
    return 'VOL_WARM_1P2_1P5';
  }

  // 8. BROKER_TOP3_CONCENTRATION (PF 1.57): Konsentrasi broker top 3
  if (hasBrokerTop3) {
    return 'BROKER_TOP3_CONCENTRATION';
  }

  // 9. TECH_ABOVE_MA20 (PF 1.90): Di atas MA20
  if (isAboveMa20) {
    return 'TECH_ABOVE_MA20';
  }

  // 10. TECH_ABOVE_MA5 (PF 1.89): Di atas MA5
  if (isAboveMa5) {
    return 'TECH_ABOVE_MA5';
  }

  return null;
}

module.exports = {
  PATTERN_PERSONALITY_CATALOG,
  getPatternPersonality,
  calculatePatternScoreBonus,
  formatPatternPersonalityLine,
  matchTickerPattern
};
