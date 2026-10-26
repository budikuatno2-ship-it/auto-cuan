'use strict';

/**
 * Liquidity Pressure Model (LPM) & Bandar Metrics Pure Indicator Engine
 * =====================================================================
 * Ported pure functions with exact Pine Script / TradingView sematics.
 * Zero network, zero Date.now(), zero global mutable state.
 *
 * Mode B Fixes documented against audit findings in audit/AUTO_CUAN_AUDIT.md (B6):
 * 1. FIX Par F: Double-counting removed (no buy+sell / 1x turnover bias; uses single-sided ratio).
 * 2. FIX Par F Fallback: Removed hardcoded 28.5% synthetic fallback (public/chart-workstation.js:687). Null returned when data absent.
 * 3. FIX CMF Warmup: Replaced 19 fabricated 0.0 bars (lib/bandar-metrics-engine.js:280) with null during warmup.
 * 4. FIX Money Flow Units: Provides both CMF ratio (-1.0 to +1.0) and nominal IDR MFV (matching TradingView -1.45B screenshot).
 * 5. FIX Foreign Flow Synthetic: Removed synthetic volume * close * 0.12 * dir fallback (public/chart-workstation.js:522).
 * 6. FIX Corr F Synthetic: Removed synthetic volume * 0.15 * dir injection (public/chart-workstation.js:645).
 */

function round(val, decimals = 4) {
  if (val == null || !Number.isFinite(val)) return null;
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

/**
 * Rolling Simple Moving Average (ta.sma)
 */
function calculateSMA(series, period) {
  const result = new Array(series.length);
  let sum = 0;
  for (let i = 0; i < series.length; i++) {
    const val = Number(series[i]);
    sum += Number.isFinite(val) ? val : 0;
    if (i >= period) {
      const oldVal = Number(series[i - period]);
      sum -= Number.isFinite(oldVal) ? oldVal : 0;
    }
    if (i < period - 1) {
      result[i] = null;
    } else {
      result[i] = sum / period;
    }
  }
  return result;
}

/**
 * Rolling Exponential Moving Average (ta.ema)
 * Seeded with SMA of the first `period` bars.
 */
function calculateEMA(series, period) {
  const result = new Array(series.length).fill(null);
  if (series.length < period) return result;

  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += Number(series[i]);
  }
  let prevEma = sum / period;
  result[period - 1] = prevEma;

  for (let i = period; i < series.length; i++) {
    const val = Number(series[i]);
    prevEma = (val - prevEma) * k + prevEma;
    result[i] = prevEma;
  }
  return result;
}

/**
 * Rolling Wilder's RMA (ta.rma) - used by RSI
 * Alpha = 1 / period. Seeded with SMA of first `period` bars.
 */
function calculateRMA(series, period) {
  const result = new Array(series.length).fill(null);
  if (series.length < period) return result;

  const alpha = 1 / period;
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += Number(series[i]);
  }
  let prevRma = sum / period;
  result[period - 1] = prevRma;

  for (let i = period; i < series.length; i++) {
    const val = Number(series[i]);
    prevRma = alpha * val + (1 - alpha) * prevRma;
    result[i] = prevRma;
  }
  return result;
}

/**
 * Pearson Correlation Coefficient between two series (ta.correlation)
 */
function calculatePearsonCorrelation(seriesA, seriesB) {
  if (!Array.isArray(seriesA) || !Array.isArray(seriesB)) return null;
  const n = Math.min(seriesA.length, seriesB.length);
  if (n < 3) return null;

  let sumA = 0, sumB = 0;
  let sumA2 = 0, sumB2 = 0;
  let sumAB = 0;
  let count = 0;

  for (let i = 0; i < n; i++) {
    const a = Number(seriesA[i]);
    const b = Number(seriesB[i]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null; // strictly require valid pairs

    sumA += a;
    sumB += b;
    sumA2 += a * a;
    sumB2 += b * b;
    sumAB += a * b;
    count++;
  }

  if (count < 3) return null;

  const denomA = count * sumA2 - sumA * sumA;
  const denomB = count * sumB2 - sumB * sumB;

  if (denomA <= 0 || denomB <= 0) return 0.0;

  const r = (count * sumAB - sumA * sumB) / Math.sqrt(denomA * denomB);
  if (!Number.isFinite(r)) return 0.0;
  return Math.max(-1.0, Math.min(1.0, r));
}

/**
 * Chaikin Money Flow (CMF) & Money Flow Volume (MFV)
 *
 * MFM = ((Close - Low) - (High - Close)) / (High - Low)
 * MFV_shares = MFM * Volume
 * MFV_idr = MFM * Turnover (in Rupiah)
 * CMF(20) = sum(MFV_shares, 20) / sum(Volume, 20)
 *
 * Fix vs lib/bandar-metrics-engine.js:
 * - Warmup bars (< 20) return null, NOT fabricated 0.0.
 * - Provides both cmf_ratio (-1 to +1) and mfv_idr (Rupiah nominal).
 */
function calculateMoneyFlow(candles, period = 20, options = {}) {
  const { legacyWarmupZero = false } = options;
  if (!Array.isArray(candles) || candles.length === 0) return [];

  const results = [];
  const mfvList = [];
  const volList = [];
  const mfvIdrList = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const h = Number(c.high != null ? c.high : c.close);
    const l = Number(c.low != null ? c.low : c.close);
    const cl = Number(c.close);
    const v = Number(c.volume || 0);
    const turnover = c.turnover != null ? Number(c.turnover) : v * cl;

    const range = h - l;
    let mfm = 0;
    if (range > 0) {
      mfm = ((cl - l) - (h - cl)) / range;
    }
    const mfv = mfm * v;
    const mfvIdr = mfm * turnover;

    mfvList.push(mfv);
    volList.push(v);
    mfvIdrList.push(mfvIdr);

    if (i < period - 1) {
      results.push({
        time: c.time,
        date: c.date,
        mfm: round(mfm, 4),
        mfv_shares: round(mfv, 2),
        mfv_idr: round(mfvIdr, 2),
        cmf_ratio: legacyWarmupZero ? 0.0 : null,
        cmf_idr_20: legacyWarmupZero ? 0.0 : null
      });
      continue;
    }

    let sumMfv = 0;
    let sumVol = 0;
    let sumMfvIdr = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sumMfv += mfvList[j];
      sumVol += volList[j];
      sumMfvIdr += mfvIdrList[j];
    }

    const cmf = sumVol > 0 ? sumMfv / sumVol : 0.0;
    const roundedCmf = round(cmf, 3);

    results.push({
      time: c.time,
      date: c.date,
      mfm: round(mfm, 4),
      mfv_shares: round(mfv, 2),
      mfv_idr: round(mfvIdr, 2),
      cmf_ratio: roundedCmf,
      cmf_idr_20: round(sumMfvIdr, 2)
    });
  }

  return results;
}

/**
 * Intensity Histogram
 *
 * volRatio = Volume / SMA(Volume, 20)
 * bodyRatio = |Close - Open| / (High - Low)
 * rawIntensity = volRatio * (0.4 + 0.6 * bodyRatio) [Workstation magnitude]
 * signedIntensity = volRatio * (0.5 + 0.5 * bodyRatio) * (Close >= Open ? 1 : -1) [Engine signed]
 */
function calculateIntensity(candles, period = 20, options = {}) {
  const { mode = 'workstation', strictWarmup = false } = options; // 'workstation' or 'engine'
  if (!Array.isArray(candles) || candles.length === 0) return [];

  const volumes = candles.map(c => Number(c.volume || 0));
  const results = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    if (strictWarmup && i < period - 1) {
      results.push({
        time: c.time,
        date: c.date,
        value: null,
        direction: 0,
        vol_ratio: null,
        is_accumulation: false,
        is_distribution: false,
        is_anomaly_spike: false,
        color: null
      });
      continue;
    }

    const open = Number(c.open != null ? c.open : c.close);
    const close = Number(c.close);
    const high = Number(c.high != null ? c.high : c.close);
    const low = Number(c.low != null ? c.low : c.close);
    const vol = volumes[i];

    const p = Math.min(i + 1, period);
    let volSum = 0;
    for (let j = i - p + 1; j <= i; j++) volSum += volumes[j];
    const avgVol = volSum / p || 1;
    const volRatio = vol / avgVol;

    const range = high - low;
    const body = Math.abs(close - open);
    const bodyRatio = range > 0 ? body / range : 0.5;
    const direction = close >= open ? 1 : -1;

    let score;
    let color;

    if (mode === 'engine') {
      // lib/bandar-metrics-engine.js style (signed)
      const raw = volRatio * (0.5 + 0.5 * bodyRatio) * direction;
      score = round(raw, 2);
      if (score >= 2.0) color = '#10b981';
      else if (score > 1.0) color = '#10b98180';
      else if (score <= -2.0) color = '#ef4444';
      else if (score < -1.0) color = '#ef444480';
      else color = '#6b728040';
    } else {
      // public/chart-workstation.js style (magnitude >= 0, colored by dominance/anomaly)
      const raw = volRatio * (0.4 + 0.6 * bodyRatio);
      score = Math.max(0, round(raw, 2));
      if (score >= 2.0) color = '#f59e0b';
      else if (close < open) color = '#ef4444';
      else color = '#10b981';
    }

    results.push({
      time: c.time,
      date: c.date,
      value: score,
      direction: direction,
      vol_ratio: round(volRatio, 2),
      is_accumulation: score >= 1.5 && direction === 1,
      is_distribution: score >= 1.5 && direction === -1,
      is_anomaly_spike: Math.abs(score) >= 2.0,
      color: color
    });
  }

  return results;
}

/**
 * Volume Rotation Histogram
 *
 * turnover = Volume * Close
 * medianTurnover = Median(turnover, 20)
 * rotationRatio = turnover / medianTurnover
 *
 * options.medianMode:
 *   - 'repo' (default): upper middle element (recent[len/2])
 *   - 'pine': arithmetic average of two middle elements when len is even (ta.median)
 * options.strictWarmup:
 *   - false (default repo): starts immediately from bar 0
 *   - true (Pine Mode A): returns null for first 19 bars
 */
function calculateVolumeRotation(candles, period = 20, options = {}) {
  const { medianMode = 'repo', strictWarmup = false } = options;
  if (!Array.isArray(candles) || candles.length === 0) return [];

  const results = [];
  const turnovers = candles.map(c => Number(c.volume || 0) * Number(c.close || 0));

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    if (strictWarmup && i < period - 1) {
      results.push({
        time: c.time,
        date: c.date,
        value: null,
        turnover: turnovers[i],
        median_turnover: null,
        is_extreme_rotation: false,
        is_active_rotation: false,
        color: null
      });
      continue;
    }

    const turn = turnovers[i];
    const p = Math.min(i + 1, period);
    const recent = turnovers.slice(i - p + 1, i + 1).slice().sort((a, b) => a - b);

    let medianTurn;
    if (medianMode === 'pine' && recent.length % 2 === 0) {
      const mid1 = recent[recent.length / 2 - 1];
      const mid2 = recent[recent.length / 2];
      medianTurn = (mid1 + mid2) / 2 || 1;
    } else {
      medianTurn = recent[Math.floor(recent.length / 2)] || 1;
    }

    const ratio = round(turn / medianTurn, 2);

    const isUp = Number(c.close) >= Number(c.open != null ? c.open : c.close);
    let color = '#eab308';
    if (ratio >= 2.5) color = '#f59e0b';
    else if (ratio >= 1.5) color = isUp ? '#10b981' : '#ef4444';
    else if (ratio >= 1.0 && isUp) color = '#10b98180';

    results.push({
      time: c.time,
      date: c.date,
      value: ratio,
      turnover: turn,
      median_turnover: medianTurn,
      is_extreme_rotation: ratio >= 2.5,
      is_active_rotation: ratio >= 1.5,
      color: color
    });
  }

  return results;
}

/**
 * Liquidity Pressure Model (LPM) Series & Rolling Level
 *
 * Method 1: Continuous Projection Curve (public/chart-workstation.js:811)
 * liqPressure = MFM * Turnover
 * cumLiq = sum(liqPressure)
 * normPressure = (cumLiq - avg(cumLiq, 20)) / halfRange(cumLiq, 20) [-1.5 to +1.5]
 * lpmCurve = avgPrice + (normPressure * halfPriceRange * 1.35)
 *
 * Method 2: Discrete Rolling 20-bar Typical VWAP (lib/bandar-metrics-engine.js:196)
 * lpmLevel = sum(typicalPrice * volume, 20) / sum(volume, 20)
 *
 * options.strictWarmup: if true, returns null for first 19 bars.
 * options.pressureThreshold: default 0.20, threshold for is_bullish_pressure.
 */
function calculateLPMSeries(candles, windowPeriod = 20, options = {}) {
  const { strictWarmup = false, pressureThreshold = 0.20 } = options;
  if (!Array.isArray(candles) || candles.length === 0) return [];

  const out = [];
  let cumLiq = 0;
  const cumLiqArr = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const high = Number(c.high != null ? c.high : c.close);
    const low = Number(c.low != null ? c.low : c.close);
    const close = Number(c.close);
    const vol = Number(c.volume || 0);
    const turnover = c.turnover != null ? Number(c.turnover) : vol * close;
    const range = high - low;
    const mfMult = range > 0 ? ((close - low) - (high - close)) / range : 0;
    const liqPressure = mfMult * turnover;
    cumLiq += liqPressure;
    cumLiqArr.push(cumLiq);
  }

  for (let i = 0; i < candles.length; i++) {
    if (strictWarmup && i < windowPeriod - 1) {
      out.push({
        time: candles[i].time,
        date: candles[i].date,
        lpm_curve: null,
        lpm_vwap20: null,
        norm_pressure: null,
        cum_liq_idr: round(cumLiqArr[i], 2),
        is_bullish_pressure: false,
        is_bearish_pressure: false
      });
      continue;
    }

    const p = Math.min(i + 1, windowPeriod);
    const startIdx = i - p + 1;

    let pSum = 0;
    let pMin = Infinity;
    let pMax = -Infinity;
    let clSum = 0;
    let clMin = Infinity;
    let clMax = -Infinity;

    let volSum20 = 0;
    let typicalVolSum20 = 0;

    for (let j = startIdx; j <= i; j++) {
      const cj = Number(candles[j].close);
      const hj = Number(candles[j].high != null ? candles[j].high : cj);
      const lj = Number(candles[j].low != null ? candles[j].low : cj);
      const vj = Number(candles[j].volume || 0);
      const typ = (hj + lj + cj) / 3;

      pSum += cj;
      if (lj < pMin) pMin = lj;
      if (hj > pMax) pMax = hj;

      volSum20 += vj;
      typicalVolSum20 += typ * vj;

      const cl = cumLiqArr[j];
      clSum += cl;
      if (cl < clMin) clMin = cl;
      if (cl > clMax) clMax = cl;
    }

    const pAvg = pSum / p;
    const clAvg = clSum / p;
    const halfPriceRange = Math.max((pMax - pMin) / 2, pAvg * 0.02);
    const clHalfRange = (clMax - clMin) / 2;

    let normPressure = clHalfRange > 0 ? (cumLiqArr[i] - clAvg) / clHalfRange : 0;
    if (normPressure > 1.5) normPressure = 1.5;
    if (normPressure < -1.5) normPressure = -1.5;

    const lpmCurve = Math.round(pAvg + (normPressure * halfPriceRange * 1.35));
    const lpmVwap20 = volSum20 > 0 ? Math.round(typicalVolSum20 / volSum20) : Math.round(pAvg);

    // Bullish Pressure: close is below LPM curve, and normPressure meets threshold
    const isBullishPressure = lpmCurve > candles[i].close && normPressure >= pressureThreshold;
    const isBearishPressure = lpmCurve < candles[i].close && normPressure <= -pressureThreshold;

    out.push({
      time: candles[i].time,
      date: candles[i].date,
      lpm_curve: lpmCurve,
      lpm_vwap20: lpmVwap20,
      norm_pressure: round(normPressure, 3),
      cum_liq_idr: round(cumLiqArr[i], 2),
      is_bullish_pressure: isBullishPressure,
      is_bearish_pressure: isBearishPressure
    });
  }

  return out;
}

/**
 * Classical Bullish Divergence Detector (S1b)
 *
 * Pre-registered definition:
 * 1. Identifies 3-bar local swing lows in price (Low[k-1] >= Low[k] <= Low[k+1]).
 * 2. Lookback window N = 20 bars. Finds the two most recent swing lows:
 *    Pivot 1 (older at p1) and Pivot 2 (newer at p2, p1 < p2 <= i).
 * 3. Price makes Lower Low: Low[p2] < Low[p1].
 * 4. Indicator (cum_liq OR CMF) makes Higher Low:
 *    cum_liq[p2] > cum_liq[p1] OR CMF[p2] > CMF[p1].
 * 5. Trigger bar i: Candle closes green (Close[i] > Open[i]), Close[i] > Low[p2],
 *    and CMF[i] > -0.05.
 */
function calculateClassicalDivergence(candles, options = {}) {
  const { lookback = 20 } = options;
  if (!Array.isArray(candles) || candles.length < 5) return [];

  const lpm = calculateLPMSeries(candles, 20);
  const cmf = calculateMoneyFlow(candles, 20);
  const results = new Array(candles.length).fill(null);

  // Identify all 3-bar swing lows
  const swingLows = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const prevL = candles[i - 1].low;
    const currL = candles[i].low;
    const nextL = candles[i + 1].low;
    if (currL <= prevL && currL <= nextL) {
      swingLows.push({
        bar: i,
        date: candles[i].date,
        priceLow: currL,
        cumLiq: lpm[i] ? lpm[i].cum_liq_idr : 0,
        cmfRatio: cmf[i] ? cmf[i].cmf_ratio : 0
      });
    }
  }

  for (let i = 0; i < candles.length; i++) {
    // Find swing lows within lookback window ending before or at bar i
    const windowStart = Math.max(0, i - lookback);
    const validPivots = swingLows.filter(p => p.bar >= windowStart && p.bar <= i);

    if (validPivots.length >= 2) {
      const p2 = validPivots[validPivots.length - 1]; // most recent pivot low
      const p1 = validPivots[validPivots.length - 2]; // older pivot low

      // Condition 1: Lower Low in Price
      const priceLowerLow = p2.priceLow < p1.priceLow;
      // Condition 2: Higher Low in cum_liq OR CMF
      const indicatorHigherLow = (p2.cumLiq > p1.cumLiq) || (p2.cmfRatio != null && p1.cmfRatio != null && p2.cmfRatio > p1.cmfRatio);

      // Trigger condition at bar i
      const c = candles[i];
      const isGreen = c.close > (c.open != null ? c.open : c.close);
      const aboveP2 = c.close > p2.priceLow;
      const cmfNonNegative = cmf[i] && cmf[i].cmf_ratio != null && cmf[i].cmf_ratio > -0.05;

      const isDivergence = priceLowerLow && indicatorHigherLow && isGreen && aboveP2 && cmfNonNegative;

      results[i] = {
        time: c.time,
        date: c.date,
        is_classical_divergence: isDivergence,
        p1: p1,
        p2: p2,
        price_diff_pct: round(((p2.priceLow - p1.priceLow) / p1.priceLow) * 100, 2),
        cum_liq_diff: round(p2.cumLiq - p1.cumLiq, 2)
      };
    } else {
      results[i] = {
        time: candles[i].time,
        date: candles[i].date,
        is_classical_divergence: false,
        p1: null,
        p2: null
      };
    }
  }

  return results;
}

/**
 * Foreign Flow Cumulative Series (Pure, AntiSlop)
 *
 * Strictly accumulates verified foreign_net IDR.
 * If bar has no foreign data, returns null for foreign_net and preserves cum_foreign_flow
 * or null if no baseline established. NEVER synthesizes 0.12 * volume.
 */
function calculateForeignFlow(candles, options = {}) {
  const { legacySyntheticFallback = false } = options;
  if (!Array.isArray(candles) || candles.length === 0) return [];

  let cum = 0;
  let hasEncounteredAny = false;
  const results = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    let net = null;

    if (c.foreign_net != null && Number.isFinite(Number(c.foreign_net))) {
      net = Number(c.foreign_net);
      cum += net;
      hasEncounteredAny = true;
    } else if (legacySyntheticFallback) {
      // Historical flawed behavior in chart-workstation.js:522
      const dir = Number(c.close) >= Number(c.open || c.close) ? 1 : -1;
      net = Number(c.volume || 0) * Number(c.close || 0) * 0.12 * dir;
      cum += net;
      hasEncounteredAny = true;
    }

    results.push({
      time: c.time,
      date: c.date,
      foreign_net: net != null ? round(net, 2) : null,
      cum_foreign_flow: hasEncounteredAny ? round(cum, 2) : null,
      has_foreign_data: net != null && !legacySyntheticFallback
    });
  }

  return results;
}

/**
 * Corr F: 14-period Rolling Pearson Correlation (Pure, AntiSlop)
 *
 * Computes Pearson r between price percentage change and foreign_net.
 * If foreign flow is missing or all 0 within window, returns null (NO synthetic 0.15).
 */
function calculateCorrForeign(candles, windowPeriod = 14, options = {}) {
  const { legacySyntheticFallback = false } = options;
  if (!Array.isArray(candles) || candles.length === 0) return [];

  const results = [];
  const priceChanges = [0]; // bar 0 has 0 change

  for (let i = 1; i < candles.length; i++) {
    const prev = Number(candles[i - 1].close);
    const curr = Number(candles[i].close);
    priceChanges.push(prev > 0 ? (curr - prev) / prev : 0);
  }

  for (let i = 0; i < candles.length; i++) {
    if (i < 2) {
      results.push({
        time: candles[i].time,
        date: candles[i].date,
        value: null,
        status: 'DATA_TIDAK_TERSEDIA'
      });
      continue;
    }

    const p = Math.min(i + 1, windowPeriod);
    const startIdx = i - p + 1;

    const pSlice = priceChanges.slice(startIdx, i + 1);
    const fSlice = [];
    let hasNull = false;

    for (let j = startIdx; j <= i; j++) {
      const c = candles[j];
      let net = c.foreign_net != null ? Number(c.foreign_net) : null;
      if (net === null && legacySyntheticFallback) {
        const dir = Number(c.close) >= Number(c.open || c.close) ? 1 : -1;
        net = Number(c.volume || 0) * 0.15 * dir;
      }
      if (net === null) {
        hasNull = true;
        break;
      }
      fSlice.push(net);
    }

    if (hasNull || fSlice.length < 3 || fSlice.every(v => v === 0)) {
      results.push({
        time: candles[i].time,
        date: candles[i].date,
        value: null,
        status: 'DATA_TIDAK_TERSEDIA'
      });
      continue;
    }

    const corr = calculatePearsonCorrelation(pSlice, fSlice);
    const roundedCorr = corr != null ? round(corr, 3) : null;

    let status = 'NETRAL';
    if (roundedCorr != null) {
      if (roundedCorr >= 0.6) status = 'KORELASI_POSITIF_TINGGI';
      else if (roundedCorr >= 0.25) status = 'KORELASI_POSITIF_MODERAT';
      else if (roundedCorr <= -0.6) status = 'KORELASI_NEGATIF_TINGGI';
      else if (roundedCorr <= -0.25) status = 'KORELASI_NEGATIF_MODERAT';
    }

    results.push({
      time: candles[i].time,
      date: candles[i].date,
      value: roundedCorr,
      status: status
    });
  }

  return results;
}

/**
 * Par F: Foreign Participation (Pure, AntiSlop)
 *
 * Single-sided foreign turnover / Total turnover * 100%.
 * If foreign turnover is missing, returns null (NO 28.5% synthetic fallback).
 */
function calculateParForeign(candles, options = {}) {
  const { legacySyntheticFallback = false } = options;
  if (!Array.isArray(candles) || candles.length === 0) return [];

  const results = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const totalTurn = c.turnover != null ? Number(c.turnover) : Number(c.volume || 0) * Number(c.close || 0);

    let foreignTurn = null;
    if (c.foreign_turnover != null) {
      foreignTurn = Number(c.foreign_turnover);
    } else if (c.foreign_buy_val != null && c.foreign_sell_val != null) {
      // Single-sided average turnover
      foreignTurn = (Number(c.foreign_buy_val) + Number(c.foreign_sell_val)) / 2;
    }

    if (foreignTurn == null && legacySyntheticFallback) {
      foreignTurn = totalTurn * 0.285;
    }

    if (foreignTurn == null || totalTurn <= 0) {
      results.push({
        time: candles[i].time,
        date: candles[i].date,
        percentage: null,
        status: 'DATA_TIDAK_TERSEDIA'
      });
      continue;
    }

    const pct = round(Math.min(100, Math.max(0, (foreignTurn / totalTurn) * 100)), 2);
    let status = 'RENDAH';
    if (pct >= 40.0) status = 'SANGAT_TINGGI';
    else if (pct >= 25.0) status = 'TINGGI';
    else if (pct >= 15.0) status = 'MODERAT';

    results.push({
      time: candles[i].time,
      date: candles[i].date,
      percentage: pct,
      status: status
    });
  }

  return results;
}

/**
 * Master Indicator Suite Calculator (Pure Function)
 */
function calculateAllIndicators(candles, options = {}) {
  if (!Array.isArray(candles) || candles.length === 0) return [];

  const moneyFlow = calculateMoneyFlow(candles, 20, options);
  const intensity = calculateIntensity(candles, 20, options);
  const rotation = calculateVolumeRotation(candles, 20, options);
  const lpm = calculateLPMSeries(candles, 20, options);
  const classicalDiv = calculateClassicalDivergence(candles, options);
  const foreignFlow = calculateForeignFlow(candles, options);
  const corrF = calculateCorrForeign(candles, 14, options);
  const parF = calculateParForeign(candles, options);

  // Moving averages for regime filters
  const closeSeries = candles.map(c => Number(c.close));
  const sma50 = calculateSMA(closeSeries, 50);
  const sma200 = calculateSMA(closeSeries, 200);

  const combined = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    combined.push({
      time: c.time,
      date: c.date,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      turnover: c.turnover,
      // Indicators
      money_flow: moneyFlow[i],
      intensity: intensity[i],
      volume_rotation: rotation[i],
      lpm: lpm[i],
      classical_divergence: classicalDiv[i],
      foreign_flow: foreignFlow[i],
      corr_foreign: corrF[i],
      par_foreign: parF[i],
      // Moving averages
      sma50: sma50[i],
      sma200: sma200[i]
    });
  }

  return combined;
}

module.exports = {
  round,
  calculateSMA,
  calculateEMA,
  calculateRMA,
  calculatePearsonCorrelation,
  calculateMoneyFlow,
  calculateIntensity,
  calculateVolumeRotation,
  calculateLPMSeries,
  calculateClassicalDivergence,
  calculateForeignFlow,
  calculateCorrForeign,
  calculateParForeign,
  calculateAllIndicators
};
