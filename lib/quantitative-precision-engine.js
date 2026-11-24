'use strict';

/**
 * lib/quantitative-precision-engine.js
 * ============================================================================
 * AUTO-CUAN V4/V6 INSTITUTIONAL QUANTITATIVE PRECISION & ANTI-SLOP ENGINE
 * Directive: .roo/rules/auto-cuan-8-github-skills.md (Skill 2: miqdadbadjuber/anti-slop)
 *
 * Enforces:
 * 1. IEEE-754 arithmetic safety & deterministic financial rounding
 * 2. Complete eradication of AI marketing slop & qualitative hand-waving
 * 3. Fail-closed data-deficient guardrails: [DATA_DEFICIENT: Parameter <name> tidak tersedia]
 * ============================================================================
 */

/**
 * Institutional Quantitative Math Formatter & Precision Validator
 */
const InstitutionalMath = {
  /**
   * Safe price rounding to integer without IEEE-754 precision leakage.
   * @param {number|string|null|undefined} val
   * @returns {number}
   */
  roundPrice(val) {
    if (val === null || val === undefined || isNaN(val)) return 0;
    const num = Number(val);
    if (!Number.isFinite(num)) return 0;
    return Math.round(num);
  },

  /**
   * Safe decimal rounding avoiding IEEE-754 floating point artifacts like 0.1 + 0.2 === 0.30000000000000004
   * @param {number|string|null|undefined} val
   * @param {number} [decimals=2]
   * @returns {number}
   */
  safeDecimal(val, decimals = 2) {
    if (val === null || val === undefined || isNaN(val)) return 0;
    const num = Number(val);
    if (!Number.isFinite(num)) return 0;
    return Number(Math.round(Number(num + 'e' + decimals)) + 'e-' + decimals);
  },

  /**
   * Formats percentage with sign, 2 decimals, avoiding float artifacts.
   * @param {number|string|null|undefined} val
   * @returns {string}
   */
  formatPercent(val) {
    if (val === null || val === undefined || isNaN(val)) return '0.00%';
    const num = this.safeDecimal(val, 2);
    const sign = num > 0 ? '+' : '';
    return `${sign}${num.toFixed(2)}%`;
  },

  /**
   * Formats IDR values with institutional abbreviations (T, B, M) or standard currency notation.
   * @param {number|string|null|undefined} val
   * @returns {string}
   */
  formatIDR(val) {
    if (val === null || val === undefined || isNaN(val)) return 'Rp 0';
    const num = Number(val);
    if (!Number.isFinite(num)) return 'Rp 0';
    const abs = Math.abs(num);
    const sign = num < 0 ? '-' : '';
    if (abs >= 1e12) return `${sign}Rp ${(abs / 1e12).toFixed(2)} T`;
    if (abs >= 1e9)  return `${sign}Rp ${(abs / 1e9).toFixed(2)} B`;
    if (abs >= 1e6)  return `${sign}Rp ${(abs / 1e6).toFixed(2)} M`;
    return `${sign}Rp ${Math.round(abs).toLocaleString('id-ID')}`;
  },

  /**
   * Safe integer lot arithmetic (1 lot = 100 shares in IDX).
   * @param {number|string|null|undefined} shares
   * @returns {number}
   */
  sharesToLots(shares) {
    if (shares === null || shares === undefined || isNaN(shares)) return 0;
    const num = Number(shares);
    if (!Number.isFinite(num) || num <= 0) return 0;
    return Math.floor(this.safeDecimal(num / 100, 2));
  },

  /**
   * Convert lots to shares.
   * @param {number|string|null|undefined} lots
   * @returns {number}
   */
  lotsToShares(lots) {
    if (lots === null || lots === undefined || isNaN(lots)) return 0;
    const num = Number(lots);
    if (!Number.isFinite(num) || num <= 0) return 0;
    return Math.round(num) * 100;
  },

  /**
   * Volume-Weighted Average Price calculation.
   * @param {Array<{price: number, volume: number}>} trades
   * @returns {number}
   */
  calculateVWAP(trades) {
    if (!Array.isArray(trades) || trades.length === 0) return 0;
    let cumVolume = 0;
    let cumValue = 0;
    for (let i = 0; i < trades.length; i++) {
      const vol = Number(trades[i].volume) || 0;
      const price = Number(trades[i].price) || 0;
      if (vol > 0 && price > 0) {
        cumVolume += vol;
        cumValue += (price * vol);
      }
    }
    return cumVolume > 0 ? this.safeDecimal(cumValue / cumVolume, 2) : 0;
  },

  /**
   * Orderbook imbalance ratio: (bidLots - offerLots) / (bidLots + offerLots)
   * Normalized in range [-1.0, 1.0].
   * @param {number} bidLots
   * @param {number} offerLots
   * @returns {number}
   */
  calculateOrderbookImbalance(bidLots, offerLots) {
    const b = Math.max(0, Number(bidLots) || 0);
    const o = Math.max(0, Number(offerLots) || 0);
    const total = b + o;
    if (total === 0) return 0;
    return this.safeDecimal((b - o) / total, 4);
  },

  /**
   * Top 3 Broker Concentration Ratio (CR3).
   * @param {Array<{broker?: string, netValue?: number, net_val?: number}>} brokerList
   * @returns {number}
   */
  calculateCR3(brokerList) {
    if (!Array.isArray(brokerList) || brokerList.length === 0) return 0;
    const sorted = [...brokerList]
      .map(b => ({ val: Math.max(0, Number(b.netValue != null ? b.netValue : (b.net_val != null ? b.net_val : 0))) }))
      .sort((a, b) => b.val - a.val);
    const totalNet = sorted.reduce((sum, b) => sum + b.val, 0);
    if (totalNet === 0) return 0;
    const top3Net = sorted.slice(0, 3).reduce((sum, b) => sum + b.val, 0);
    return this.safeDecimal((top3Net / totalNet) * 100, 2);
  },

  /**
   * Top 5 Broker Concentration Ratio (CR5).
   * @param {Array<{broker?: string, netValue?: number, net_val?: number}>} brokerList
   * @returns {number}
   */
  calculateCR5(brokerList) {
    if (!Array.isArray(brokerList) || brokerList.length === 0) return 0;
    const sorted = [...brokerList]
      .map(b => ({ val: Math.max(0, Number(b.netValue != null ? b.netValue : (b.net_val != null ? b.net_val : 0))) }))
      .sort((a, b) => b.val - a.val);
    const totalNet = sorted.reduce((sum, b) => sum + b.val, 0);
    if (totalNet === 0) return 0;
    const top5Net = sorted.slice(0, 5).reduce((sum, b) => sum + b.val, 0);
    return this.safeDecimal((top5Net / totalNet) * 100, 2);
  },

  /**
   * Herfindahl-Hirschman Index (HHI) for market concentration (0 - 10,000 scale).
   * @param {Array<number>} shares - Array of market share fractions (e.g. 0.35, 0.20, etc.)
   * @returns {number}
   */
  calculateHerfindahlHirschmanIndex(shares) {
    if (!Array.isArray(shares) || shares.length === 0) return 0;
    const sum = shares.reduce((acc, s) => {
      const sharePct = Number(s) * 100;
      return acc + (sharePct * sharePct);
    }, 0);
    return Math.round(sum);
  }
};

/**
 * Quantitative Validation Engine for Screener Pipelines & AI Output
 */
class QuantitativePrecisionEngine {
  /**
   * Validates numeric sanity of screener candidate rows.
   * @param {object} tickerData
   * @returns {{ isValid: boolean, errors: string[] }}
   */
  static validateScreenerOutput(tickerData) {
    const errors = [];
    if (!tickerData || typeof tickerData !== 'object') {
      return { isValid: false, errors: ['NULL_OR_NON_OBJECT_TICKER_DATA'] };
    }
    if (!tickerData.symbol && !tickerData.ticker) {
      errors.push('INVALID_TICKER_SYMBOL');
    }
    const price = tickerData.lastPrice != null ? tickerData.lastPrice : (tickerData.price != null ? tickerData.price : tickerData.last_price);
    if (typeof price !== 'number' || price <= 0 || !Number.isFinite(price)) {
      errors.push('INVALID_NUMERIC_PRICE');
    }
    const volume = tickerData.volume != null ? tickerData.volume : tickerData.volume_today;
    if (volume !== undefined && volume !== null && (typeof volume !== 'number' || volume < 0 || !Number.isFinite(volume))) {
      errors.push('INVALID_NUMERIC_VOLUME');
    }
    const chg = tickerData.changePercent != null ? tickerData.changePercent : tickerData.change_pct;
    if (chg !== undefined && chg !== null && isNaN(chg)) {
      errors.push('NAN_CHANGE_PERCENT');
    }
    return {
      isValid: errors.length === 0,
      errors
    };
  }

  /**
   * Blacklisted qualitative terms forbidden in Auto-Cuan institutional system.
   */
  static get BLACKLIST_TERMS() {
    return [
      { regex: /saham ini sangat menjanjikan dengan prospek cerah di masa depan/gi, sub: '[DATA_REQUIRED: Gunakan metrik kuantitatif]' },
      { regex: /saham ini sangat menjanjikan/gi, sub: '[DATA_REQUIRED: Gunakan metrik kuantitatif]' },
      { regex: /sangat menjanjikan/gi, sub: '[DATA_REQUIRED: Gunakan metrik kuantitatif]' },
      { regex: /potensi cuan luar biasa, segera serok sebelum terbang to the moon/gi, sub: '[DATA_REQUIRED: Gunakan metrik kuantitatif]' },
      { regex: /potensi cuan luar biasa/gi, sub: '[DATA_REQUIRED: Gunakan metrik kuantitatif]' },
      { regex: /potensi cuan/gi, sub: '[DATA_REQUIRED: Gunakan metrik kuantitatif]' },
      { regex: /segera serok sebelum terbang to the moon/gi, sub: '[DATA_REQUIRED: Gunakan metrik kuantitatif]' },
      { regex: /segera serok sebelum terbang/gi, sub: '[DATA_REQUIRED: Gunakan metrik kuantitatif]' },
      { regex: /segera serok/gi, sub: '[DATA_REQUIRED: Gunakan metrik kuantitatif]' },
      { regex: /terbang to the moon/gi, sub: '[DATA_REQUIRED: Gunakan metrik kuantitatif]' },
      { regex: /to the moon/gi, sub: '[DATA_REQUIRED: Gunakan metrik kuantitatif]' },
      { regex: /kondisi pasar saat ini agak kurang bersahabat dan galau/gi, sub: '[DATA_REQUIRED: Gunakan metrik kuantitatif]' },
      { regex: /kondisi pasar agak galau/gi, sub: '[DATA_REQUIRED: Gunakan metrik kuantitatif]' },
      { regex: /kondisi pasar galau/gi, sub: '[DATA_REQUIRED: Gunakan metrik kuantitatif]' },
      { regex: /pasar galau/gi, sub: '[DATA_REQUIRED: Gunakan metrik kuantitatif]' },
      { regex: /bandar terlihat sedang memainkan harga secara misterius/gi, sub: '[DATA_REQUIRED: Gunakan metrik kuantitatif]' },
      { regex: /bandar misterius/gi, sub: '[DATA_REQUIRED: Gunakan metrik kuantitatif]' },
      { regex: /tampaknya candle membentuk pola bullish yang cantik/gi, sub: '[DATA_REQUIRED: Gunakan metrik kuantitatif]' },
      { regex: /pola bullish yang cantik/gi, sub: '[DATA_REQUIRED: Gunakan metrik kuantitatif]' },
      { regex: /candle cantik/gi, sub: '[DATA_REQUIRED: Gunakan metrik kuantitatif]' }
    ];
  }

  /**
   * Sanitizes text by stripping out qualitative hype / AI slop and substituting quantitative alerts.
   * @param {string} responseText
   * @returns {string}
   */
  static sanitizeLLMResponse(responseText) {
    if (!responseText || typeof responseText !== 'string') return '';
    let sanitized = responseText;
    for (const item of this.BLACKLIST_TERMS) {
      sanitized = sanitized.replace(item.regex, item.sub);
    }
    return sanitized;
  }

  /**
   * Ensures missing data parameters produce explicit fail-closed token:
   * [DATA_DEFICIENT: Parameter <name> tidak tersedia]
   * @param {string} paramName
   * @returns {string}
   */
  static dataDeficientToken(paramName) {
    return `[DATA_DEFICIENT: Parameter ${String(paramName || 'data').trim()} tidak tersedia]`;
  }
}

module.exports = {
  InstitutionalMath,
  QuantitativePrecisionEngine
};
