/**
 * IDX Tick Size Normalization + Risk Label + Volume-Price Action + Multi-Timeframe Context
 * 
 * Shared helper for all Auto-Cuan screeners and analysis paths.
 * No AI. No SQL. No cron. Pure deterministic logic.
 *
 * IDX tick size table:
 *   price < 200       : tick = 1
 *   200 <= price < 500: tick = 2
 *   500 <= price < 2000: tick = 5
 *   2000 <= price < 5000: tick = 10
 *   price >= 5000     : tick = 25
 */

'use strict';

// ============================================================
// SECTION 1: IDX TICK SIZE FUNCTIONS
// ============================================================

/**
 * Get IDX tick size for a given price level.
 */
function getIdxTickSize(price) {
  if (price == null || isNaN(price) || price <= 0) return 1;
  if (price < 200) return 1;
  if (price < 500) return 2;
  if (price < 2000) return 5;
  if (price < 5000) return 10;
  return 25;
}

/**
 * Round a price to valid IDX tick.
 * @param {number} price
 * @param {'nearest'|'up'|'down'} mode
 */
function roundToIdxTick(price, mode) {
  if (price == null || isNaN(price) || price <= 0) return price;
  mode = mode || 'nearest';
  var tick = getIdxTickSize(price);
  if (mode === 'up') return Math.ceil(price / tick) * tick;
  if (mode === 'down') return Math.floor(price / tick) * tick;
  return Math.round(price / tick) * tick;
}


/**
 * Normalize all trading levels to valid IDX ticks with ordering validation.
 * 
 * Entry 1 (entry_high) = upper / confirmation entry
 * Entry 2 (entry_low) = lower / pullback entry
 * 
 * Flow: raw levels -> tick normalize -> validate ordering -> return
 *
 * @param {object} levels - { entry_low, entry_high, stop_loss, tp1, tp2, risk_reward }
 * @param {object} [opts] - { mode: 'daytrade'|'swing', minRR: number }
 * @returns {object} normalized levels + meta
 */
function normalizeLevelsToIdxTicks(levels, opts) {
  if (!levels) return levels;
  opts = opts || {};
  var minRR = opts.minRR || (opts.mode === 'daytrade' ? 1.2 : 1.5);
  var notes = [];

  // Round each level
  var entry_high = levels.entry_high ? roundToIdxTick(levels.entry_high, 'nearest') : null;
  var entry_low = levels.entry_low ? roundToIdxTick(levels.entry_low, 'nearest') : null;
  var stop_loss = levels.stop_loss ? roundToIdxTick(levels.stop_loss, 'down') : null;
  var tp1 = levels.tp1 ? roundToIdxTick(levels.tp1, 'nearest') : null;
  var tp2 = levels.tp2 ? roundToIdxTick(levels.tp2, 'nearest') : null;
  var support = levels.support ? roundToIdxTick(levels.support, 'down') : null;
  var resistance = levels.resistance ? roundToIdxTick(levels.resistance, 'up') : null;

  // === ORDERING VALIDATION ===
  // Entry 1 (entry_high) >= Entry 2 (entry_low)
  if (entry_high != null && entry_low != null && entry_high < entry_low) {
    var tmp = entry_high; entry_high = entry_low; entry_low = tmp;
    notes.push('Entry swapped');
  }

  // Stop Loss < Entry 2 (entry_low)
  var lowerEntry = entry_low || entry_high;
  if (stop_loss != null && lowerEntry != null && stop_loss >= lowerEntry) {
    var slTick = getIdxTickSize(lowerEntry);
    stop_loss = lowerEntry - slTick;
    if (stop_loss <= 0) stop_loss = slTick;
    notes.push('SL adjusted below entry');
  }

  // Target 1 > Entry 1 (entry_high)
  var upperEntry = entry_high || entry_low;
  if (tp1 != null && upperEntry != null && tp1 <= upperEntry) {
    var tpTick = getIdxTickSize(upperEntry);
    tp1 = upperEntry + tpTick;
    notes.push('TP1 adjusted above entry');
  }

  // Target 2 >= Target 1
  if (tp2 != null && tp1 != null && tp2 < tp1) {
    tp2 = tp1;
    notes.push('TP2 adjusted >= TP1');
  }

  // Recalculate RR
  var entryMid = (entry_low && entry_high) ? (entry_low + entry_high) / 2 : (entry_high || entry_low || 0);
  var risk = entryMid - (stop_loss || 0);
  var reward = (tp1 || 0) - entryMid;
  var risk_reward = (risk > 0 && reward > 0) ? Math.round((reward / risk) * 100) / 100 : 0;

  // Final NaN guard
  if (!entry_low || isNaN(entry_low)) entry_low = levels.entry_low;
  if (!entry_high || isNaN(entry_high)) entry_high = levels.entry_high;
  if (!stop_loss || isNaN(stop_loss)) stop_loss = levels.stop_loss;
  if (!tp1 || isNaN(tp1)) tp1 = levels.tp1;
  if (!tp2 || isNaN(tp2)) tp2 = levels.tp2;
  if (!risk_reward || isNaN(risk_reward) || risk_reward <= 0) risk_reward = levels.risk_reward;

  // Validity check
  var valid = true;
  if (stop_loss >= (entry_low || Infinity)) valid = false;
  if (tp1 <= (entry_high || 0)) valid = false;
  if (risk_reward <= 0 || isNaN(risk_reward)) valid = false;

  if (!valid) {
    notes.push('Tick-size normalization fallback: level ordering would become invalid.');
    // Return original levels
    return {
      entry_low: levels.entry_low, entry_high: levels.entry_high,
      stop_loss: levels.stop_loss, tp1: levels.tp1, tp2: levels.tp2,
      risk_reward: levels.risk_reward, support: levels.support, resistance: levels.resistance,
      tick_normalized: false, tick_notes: notes.join('; ')
    };
  }

  return {
    entry_low: entry_low, entry_high: entry_high,
    stop_loss: stop_loss, tp1: tp1, tp2: tp2,
    risk_reward: risk_reward, support: support, resistance: resistance,
    tick_normalized: true, tick_notes: notes.length > 0 ? notes.join('; ') : null
  };
}


// ============================================================
// SECTION 2: WEEKLY / MONTHLY CANDLE CONTEXT
// ============================================================

/**
 * Derive weekly and monthly candle context from daily candles.
 * NOTE: These are APPROXIMATIONS aggregated from daily candles, NOT real weekly/monthly OHLC data.
 * Labeled as weekly_approx_from_daily and monthly_approx_from_daily internally.
 * @param {Array} candles - daily OHLCV array (oldest first)
 * @returns {object}
 */
function deriveMultiTimeframeContext(candles) {
  if (!candles || candles.length < 5) {
    return { daily_candle_context: null, weekly_candle_context: null, monthly_candle_context: null, multi_timeframe_bias: 'unknown', multi_timeframe_notes: 'Insufficient data', mtf_source: 'none' };
  }

  var len = candles.length;
  var latest = candles[len - 1];

  // --- DAILY context (last 1 candle) ---
  var dailyCtx = classifyCandle(latest, candles.slice(-2, -1)[0] || null);

  // --- WEEKLY context (last 5 trading days aggregated — APPROXIMATION from daily) ---
  var weekSlice = candles.slice(-5);
  var weeklyCtx = classifyAggregatedCandles(weekSlice);

  // --- MONTHLY context (last 20 trading days aggregated — APPROXIMATION from daily) ---
  var monthSlice = candles.slice(-Math.min(20, len));
  var monthlyCtx = classifyAggregatedCandles(monthSlice);

  // --- MULTI-TIMEFRAME BIAS ---
  var bias = 'neutral';
  var mtfNotes = [];

  if (dailyCtx.bias === 'bullish' && weeklyCtx.bias === 'bullish') {
    bias = 'bullish';
    mtfNotes.push('Daily+Weekly bullish aligned');
  } else if (dailyCtx.bias === 'bullish' && weeklyCtx.bias === 'bearish') {
    bias = 'mixed_caution';
    mtfNotes.push('Daily bullish tapi Weekly bearish — konfirmasi lemah');
  } else if (dailyCtx.bias === 'bearish' && weeklyCtx.bias === 'bearish') {
    bias = 'bearish';
    mtfNotes.push('Daily+Weekly bearish aligned — tekanan jual dominan');
  } else if (dailyCtx.bias === 'bearish' && weeklyCtx.bias === 'bullish') {
    bias = 'pullback';
    mtfNotes.push('Daily bearish tapi Weekly bullish — potensi pullback sehat');
  }

  // Monthly context modifier
  if (monthlyCtx.bias === 'bearish' && bias !== 'bearish') {
    mtfNotes.push('Monthly bearish — big picture tekanan turun');
    if (bias === 'bullish') bias = 'mixed_caution';
  } else if (monthlyCtx.bias === 'bullish' && bias !== 'bullish') {
    mtfNotes.push('Monthly bullish — big picture masih positif');
  }

  // Volume pressure from weekly
  if (weeklyCtx.highVolRed) {
    mtfNotes.push('Weekly red candle high-volume — swing risk increased');
  }
  if (monthlyCtx.downtrend) {
    mtfNotes.push('Monthly downtrend — hindari kesimpulan terlalu agresif');
  }

  return {
    daily_candle_context: dailyCtx.label,
    weekly_candle_context: weeklyCtx.label + ' (approx 5D)',
    monthly_candle_context: monthlyCtx.label + ' (approx 20D)',
    multi_timeframe_bias: bias,
    multi_timeframe_notes: mtfNotes.length > 0 ? mtfNotes.join('; ') : null,
    mtf_source: 'daily_aggregation',
    _daily: dailyCtx,
    _weekly: weeklyCtx,
    _monthly: monthlyCtx
  };
}

function classifyCandle(candle, prevCandle) {
  if (!candle) return { bias: 'neutral', label: 'No data', highVolRed: false };
  var o = candle.open, h = candle.high, l = candle.low, c = candle.close, v = candle.volume || 0;
  var range = h - l;
  var body = Math.abs(c - o);
  var isGreen = c > o;
  var bodyRatio = range > 0 ? body / range : 0;
  var closePos = range > 0 ? (c - l) / range : 0.5;

  var bias = 'neutral';
  var label = 'Netral';
  var highVolRed = false;

  if (isGreen && bodyRatio > 0.5 && closePos > 0.7) {
    bias = 'bullish'; label = 'Bullish candle (close near high)';
  } else if (!isGreen && bodyRatio > 0.5 && closePos < 0.3) {
    bias = 'bearish'; label = 'Bearish candle (close near low)';
    highVolRed = true;
  } else if (bodyRatio < 0.2) {
    label = 'Doji/indecision';
  } else if (isGreen) {
    bias = 'bullish'; label = 'Green candle';
  } else {
    bias = 'bearish'; label = 'Red candle'; highVolRed = true;
  }

  return { bias: bias, label: label, highVolRed: highVolRed, closePos: closePos, bodyRatio: bodyRatio };
}

function classifyAggregatedCandles(slice) {
  if (!slice || slice.length === 0) return { bias: 'neutral', label: 'No data', highVolRed: false, downtrend: false };
  var first = slice[0], last = slice[slice.length - 1];
  var aggOpen = first.open;
  var aggClose = last.close;
  var aggHigh = -Infinity, aggLow = Infinity, aggVol = 0;
  for (var i = 0; i < slice.length; i++) {
    if (slice[i].high > aggHigh) aggHigh = slice[i].high;
    if (slice[i].low < aggLow) aggLow = slice[i].low;
    aggVol += (slice[i].volume || 0);
  }
  var range = aggHigh - aggLow;
  var body = Math.abs(aggClose - aggOpen);
  var isGreen = aggClose > aggOpen;
  var bodyRatio = range > 0 ? body / range : 0;
  var closePos = range > 0 ? (aggClose - aggLow) / range : 0.5;
  var changePct = aggOpen > 0 ? ((aggClose - aggOpen) / aggOpen) * 100 : 0;

  var bias = 'neutral';
  var label = 'Sideways';
  var highVolRed = false;
  var downtrend = false;

  if (isGreen && changePct > 1) {
    bias = 'bullish'; label = 'Bullish (' + changePct.toFixed(1) + '%)';
  } else if (!isGreen && changePct < -1) {
    bias = 'bearish'; label = 'Bearish (' + changePct.toFixed(1) + '%)';
    highVolRed = !isGreen && closePos < 0.3;
    downtrend = changePct < -3;
  } else if (isGreen) {
    bias = 'bullish'; label = 'Slight bullish';
  } else if (!isGreen) {
    bias = 'bearish'; label = 'Slight bearish';
    downtrend = changePct < -2;
  }

  return { bias: bias, label: label, highVolRed: highVolRed, downtrend: downtrend, changePct: changePct, closePos: closePos };
}


// ============================================================
// SECTION 3: VOLUME-PRICE ACTION LOGIC
// ============================================================

/**
 * Deterministic volume-price action interpretation.
 * @param {object} params
 * @returns {object} { volume_signal, volume_phase, volume_notes, volume_score }
 */
function analyzeVolumePriceAction(params) {
  if (!params) return { volume_signal: 'UNKNOWN', volume_phase: 'NORMAL', volume_notes: '', volume_score: 0 };

  var volToday = params.volume_today || 0;
  var volAvg20 = params.avg_volume_20d || 1;
  var volAvg3 = params.volume_3d_avg || volAvg20;
  var volAvg7 = params.volume_7d_avg || volAvg20;
  var changePct = params.change_pct || 0;
  var closePos = params.close_position || 0.5; // 0=low, 1=high
  var bodyRatio = params.body_ratio || 0.5;
  var isGreen = params.is_green !== false;
  var nearResistance = params.near_resistance || false;
  var failedBreakout = params.failed_breakout || false;

  var volRatio20 = volAvg20 > 0 ? volToday / volAvg20 : 1;
  var volRatio3 = volAvg3 > 0 ? volToday / volAvg3 : 1;
  var volRatio7 = volAvg7 > 0 ? volToday / volAvg7 : 1;

  var isHighVol = volRatio20 >= 1.5;
  var isLowVol = volRatio20 < 0.7;

  var signal = 'NORMAL';
  var phase = 'NORMAL';
  var notes = [];
  var score = 0; // -20 to +20

  // Case 1: High volume + price falls deeply / red close near low
  if (isHighVol && !isGreen && closePos < 0.3 && changePct < -1) {
    signal = 'DISTRIBUTION';
    phase = 'DISTRIBUTION_RISK';
    notes.push('Vol tinggi + red close near low: distribusi/supply pressure');
    score = -15;
  }
  // Case 2: High volume + price rises / green close near high
  else if (isHighVol && isGreen && closePos > 0.7 && changePct > 0.5) {
    signal = 'ACCUMULATION';
    phase = 'MARKUP_CONFIRMATION';
    notes.push('Vol tinggi + green close near high: markup/akumulasi');
    score = 10;
    // But if overextended, reduce
    if (changePct > 5) { score = 3; notes.push('Tapi sudah extended +' + changePct.toFixed(1) + '%'); }
  }
  // Case 3: High volume + mixed candle / long wicks
  else if (isHighVol && bodyRatio < 0.3) {
    signal = 'ABSORPTION';
    phase = 'ABSORPTION';
    notes.push('Vol tinggi + narrow body/long wicks: absorption/battle zone');
    score = 0;
  }
  // Case 4: High volume + failed breakout
  else if (isHighVol && failedBreakout) {
    signal = 'FAILED_BREAKOUT';
    phase = 'FAILED_BREAKOUT_RISK';
    notes.push('Vol tinggi + failed breakout: bull trap/distribution risk');
    score = -18;
  }
  // Case 4b: High volume near resistance + rejection
  else if (isHighVol && nearResistance && closePos < 0.5) {
    signal = 'REJECTION';
    phase = 'FAILED_BREAKOUT_RISK';
    notes.push('Vol tinggi dekat resistance + rejection: waspadai bull trap');
    score = -12;
  }
  // Case 5: Low volume + price rises
  else if (isLowVol && changePct > 0.5) {
    signal = 'WEAK_RALLY';
    phase = 'WEAK_VOLUME';
    notes.push('Vol rendah + naik: rally lemah, bukan breakout kuat');
    score = -5;
  }
  // Case 6: Low volume + price falls mildly
  else if (isLowVol && changePct < 0 && changePct > -2) {
    signal = 'NORMAL_PULLBACK';
    phase = 'NORMAL';
    notes.push('Vol rendah + turun ringan: pullback normal jika support hold');
    score = 0;
  }
  // High volume accumulation watch (volume building but not decisive yet)
  else if (volRatio3 >= 1.3 && volRatio7 >= 1.2 && isGreen) {
    signal = 'VOLUME_BUILDUP';
    phase = 'ACCUMULATION_WATCH';
    notes.push('Volume build-up 3D/7D: possible accumulation');
    score = 5;
  }
  // Default
  else {
    phase = 'NORMAL';
    score = 0;
  }

  return {
    volume_signal: signal,
    volume_phase: phase,
    volume_notes: notes.join('; '),
    volume_score: score,
    volume_today_vs_3d: Math.round(volRatio3 * 100) / 100,
    volume_today_vs_7d: Math.round(volRatio7 * 100) / 100,
    volume_today_vs_20d: Math.round(volRatio20 * 100) / 100
  };
}


// ============================================================
// SECTION 4: RISK LABEL (Deterministic, strengthened for swing)
// ============================================================

/**
 * Calculate risk label.
 * @param {object} p - parameters
 * @param {string} p.mode - 'daytrade' | 'swing'
 * @returns {object} { risk_label, risk_score, risk_notes }
 */
function calculateRiskLabel(p) {
  if (!p) return { risk_label: 'High Risk', risk_score: 70, risk_notes: ['No data'] };
  var score = 0;
  var notes = [];
  var mode = p.mode || 'swing';
  var isSwing = (mode !== 'daytrade');
  var minRR = isSwing ? 1.5 : 1.2;

  // 1. R/R
  var rr = p.risk_reward || 0;
  if (rr < 1.0) { score += 25; notes.push('RR sangat rendah (' + rr.toFixed(2) + ')'); }
  else if (rr < minRR) { score += 15; notes.push('RR < min ' + minRR + ' (' + rr.toFixed(2) + ')'); }
  else if (rr >= 2.5) { score -= 5; }

  // 2. Weekly candle alignment (swing weight)
  if (p.weekly_bias === 'bearish' && isSwing) { score += 12; notes.push('Weekly bearish'); }
  else if (p.weekly_bias === 'bullish') { score -= 3; }

  // 3. Monthly trend context (swing weight)
  if (p.monthly_bias === 'bearish' && isSwing) { score += 10; notes.push('Monthly bearish'); }
  if (p.monthly_downtrend && isSwing) { score += 5; notes.push('Monthly downtrend'); }

  // 4. High-volume distribution
  if (p.volume_phase === 'DISTRIBUTION_RISK') { score += 18; notes.push('Distribusi terdeteksi'); }
  else if (p.volume_phase === 'FAILED_BREAKOUT_RISK') { score += 15; notes.push('Failed breakout risk'); }

  // 5. Chase risk (distance from entry)
  var chaseDistPct = p.chase_distance_pct || 0;
  if (chaseDistPct > 5) { score += 20; notes.push('Chase risk tinggi (+' + chaseDistPct.toFixed(1) + '%)'); }
  else if (chaseDistPct > 3) { score += 10; notes.push('Harga di atas entry +' + chaseDistPct.toFixed(1) + '%'); }

  // 6. Nearby supply
  if (p.supply_nearby) { score += 8; notes.push('Supply/resistance dekat'); }

  // 7. ATR / volatility
  if (p.atr_pct > 5 && isSwing) { score += 8; notes.push('Volatilitas tinggi (ATR ' + p.atr_pct.toFixed(1) + '%)'); }

  // 8. Liquidity
  if (p.avg_tx_value_7d != null && p.avg_tx_value_7d < 500000000) {
    score += 10; notes.push('Likuiditas rendah');
  } else if (p.volume_ratio_20d != null && p.volume_ratio_20d < 0.5) {
    score += 10; notes.push('Volume sangat rendah');
  }

  // 9. Board
  if (p.board === 'AKSELERASI') { score += 15; notes.push('Papan Akselerasi'); }
  else if (p.board === 'PEMANTAUAN_KHUSUS' || p.is_fca) { score += 30; notes.push('FCA/Pemantauan Khusus'); }

  // 10. Data stale
  if (p.data_stale) { score += 8; notes.push('Data stale'); }

  // 11. Failed breakout (candle pattern)
  if (p.candle_failed_breakout) { score += 12; notes.push('Candle failed breakout'); }

  // 12. RSI extreme
  if (p.rsi14 != null && p.rsi14 > 80) { score += 8; notes.push('RSI overbought ' + Math.round(p.rsi14)); }
  else if (p.rsi14 != null && p.rsi14 < 25) { score += 5; notes.push('RSI sangat oversold'); }

  // 13. Multi-timeframe misalignment for swing
  if (isSwing && p.multi_timeframe_bias === 'mixed_caution') {
    score += 8; notes.push('Multi-timeframe mixed');
  }

  // Volume weak for swing
  if (isSwing && p.volume_ratio_20d != null && p.volume_ratio_20d < 0.8 && p.volume_ratio_20d >= 0.5) {
    score += 5; notes.push('Volume di bawah rata-rata');
  }

  // Positive factors (reduce score)
  if (p.volume_phase === 'MARKUP_CONFIRMATION' && rr >= minRR) { score -= 5; }
  if (p.multi_timeframe_bias === 'bullish' && rr >= 1.5) { score -= 5; }

  score = Math.max(0, Math.min(100, score));

  var label;
  if (score >= 60) label = 'Very High Risk';
  else if (score >= 40) label = 'High Risk';
  else if (score >= 20) label = 'Medium Risk';
  else label = 'Low Risk';

  return { risk_label: label, risk_score: score, risk_notes: notes.length > 0 ? notes : ['Tidak ada faktor risiko signifikan'] };
}


// ============================================================
// SECTION 5: ABC / QUALITY RATING
// ============================================================

/**
 * Calculate quality grade (A/B/C/Avoid) based on combined factors.
 * @param {object} p
 * @returns {object} { grade, grade_reason }
 */
function calculateQualityGrade(p) {
  if (!p) return { grade: 'C', grade_reason: 'No data' };

  var mode = p.mode || 'swing';
  var minRR = (mode === 'daytrade') ? 1.2 : 1.5;
  var rr = p.risk_reward || 0;
  var riskLabel = p.risk_label || 'Medium Risk';
  var volPhase = p.volume_phase || 'NORMAL';
  var mtfBias = p.multi_timeframe_bias || 'neutral';
  var tickNormalized = p.tick_normalized !== false;
  var chaseDistPct = p.chase_distance_pct || 0;

  // Avoid conditions
  if (riskLabel === 'Very High Risk') return { grade: 'Avoid', grade_reason: 'Risk sangat tinggi' };
  if (volPhase === 'DISTRIBUTION_RISK') return { grade: 'Avoid', grade_reason: 'Distribusi terdeteksi' };
  if (volPhase === 'FAILED_BREAKOUT_RISK') return { grade: 'Avoid', grade_reason: 'Failed breakout' };
  if (rr < 1.0) return { grade: 'Avoid', grade_reason: 'RR tidak valid (<1.0)' };
  if (p.data_stale) return { grade: 'C', grade_reason: 'Data stale — perlu validasi' };
  if (!tickNormalized) return { grade: 'C', grade_reason: 'Tick normalization gagal — level tidak valid' };

  // Grade A conditions (all must pass)
  var isA = (
    rr >= minRR &&
    tickNormalized &&
    (riskLabel === 'Low Risk' || riskLabel === 'Medium Risk') &&
    volPhase !== 'WEAK_VOLUME' &&
    volPhase !== 'DISTRIBUTION_RISK' &&
    volPhase !== 'FAILED_BREAKOUT_RISK' &&
    (mtfBias === 'bullish' || mtfBias === 'pullback' || mtfBias === 'neutral') &&
    chaseDistPct <= 3 &&
    (p.volume_ratio_20d == null || p.volume_ratio_20d >= 0.8)
  );

  if (isA && riskLabel === 'Low Risk' && rr >= 2.0 && mtfBias === 'bullish') {
    return { grade: 'A', grade_reason: 'Setup kuat — RR baik, MTF aligned, volume ok' };
  }
  if (isA) {
    return { grade: 'A', grade_reason: 'Setup valid — RR ok, risk terkontrol, konfirmasi cukup' };
  }

  // Grade B conditions
  var isB = (
    rr >= minRR * 0.8 &&
    riskLabel !== 'Very High Risk' &&
    riskLabel !== 'High Risk' &&
    volPhase !== 'DISTRIBUTION_RISK' &&
    volPhase !== 'FAILED_BREAKOUT_RISK' &&
    chaseDistPct <= 5
  );

  if (isB) {
    var bReason = [];
    if (rr < minRR) bReason.push('RR sedikit di bawah ideal');
    if (mtfBias === 'mixed_caution') bReason.push('MTF mixed');
    if (chaseDistPct > 3) bReason.push('sedikit extended');
    if (p.volume_ratio_20d != null && p.volume_ratio_20d < 0.8) bReason.push('volume kurang');
    return { grade: 'B', grade_reason: bReason.length > 0 ? bReason.join(', ') : 'Setup usable, ada weakness' };
  }

  // Grade C (everything else that's not Avoid)
  if (riskLabel === 'High Risk') {
    return { grade: 'C', grade_reason: 'High risk — watchlist only, perlu konfirmasi' };
  }
  return { grade: 'C', grade_reason: 'Setup belum lengkap — tunggu konfirmasi' };
}


// ============================================================
// SECTION 6: EXPORTS
// ============================================================

module.exports = {
  // Tick size
  getIdxTickSize: getIdxTickSize,
  roundToIdxTick: roundToIdxTick,
  normalizeLevelsToIdxTicks: normalizeLevelsToIdxTicks,
  // Multi-timeframe
  deriveMultiTimeframeContext: deriveMultiTimeframeContext,
  classifyCandle: classifyCandle,
  classifyAggregatedCandles: classifyAggregatedCandles,
  // Volume-Price Action
  analyzeVolumePriceAction: analyzeVolumePriceAction,
  // Risk Label
  calculateRiskLabel: calculateRiskLabel,
  // Quality Grade
  calculateQualityGrade: calculateQualityGrade
};
