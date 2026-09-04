/**
 * Day Trade Screener Engine v1
 * 
 * Deterministic intraday screener:
 *   Pre-Spike Detector + Momentum Confirmation + Liquidity Guard
 *   + False Breakout Guard + Risk Guard
 *
 * No AI. No cron. No auto-trading.
 * Uses Yahoo Finance daily candles + intraday quote proxy fields.
 */

'use strict';

var crypto = require('node:crypto');
var candleEngine = require('./candle-pattern-engine');
var idxTick = require('./idx-tick-normalization');
var atrHelpers = require('./atr-report-helpers');
var intradayScoreAdjustment = require('./daytrade-intraday-score-adjustment');
var intradayAdjustmentProvider = require('./daytrade-intraday-adjustment-provider');
var tradePlanV2Integration = require('./trade-plan-v2-integration');
var DT_INITIAL = require('./daytrade-screener-constants').INITIAL_CLASSIFICATION_THRESHOLDS;

var DATA_QUALITY_LABELS = {
  OK: 'Data valid',
  SHORT_HISTORY: 'Riwayat data pendek',
  MISSING_REFERENCE: 'Butuh reference price',
  SPARSE_TRADING_DAYS: 'Data perdagangan tidak utuh',
  INVALID_CANDLE: 'Candle tidak valid',
  CORPORATE_ACTION_RISK: 'Perlu validasi corporate action',
  NEEDS_REVALIDATION: 'Perlu validasi ulang'
};

function makeDataQuality(status, note) {
  var valid = status === 'OK';
  return {
    data_quality_status: status,
    data_quality_label: DATA_QUALITY_LABELS[status] || DATA_QUALITY_LABELS.NEEDS_REVALIDATION,
    data_quality_note: note || (DATA_QUALITY_LABELS[status] || DATA_QUALITY_LABELS.NEEDS_REVALIDATION),
    data_quality_valid: valid,
    data_quality_needs_revalidation: !valid
  };
}

function finitePositive(value) {
  return typeof value === 'number' && isFinite(value) && value > 0;
}

function deriveDataQualityStatus(input) {
  input = input || {};
  var candles = Array.isArray(input.candles) ? input.candles : [];
  var minHistory = input.minHistory || 20;
  var sparseWindow = input.sparseWindow || Math.min(30, Math.max(minHistory, candles.length));
  var minTradingDays = input.minTradingDays || Math.min(20, sparseWindow);
  var extremeGapPct = input.extremeGapPct || 25;

  if (candles.length < minHistory) {
    return makeDataQuality('SHORT_HISTORY', 'Riwayat data pendek; perlu validasi ulang sebelum menjadi sinyal publik.');
  }

  var previousClose = input.previous_close != null ? input.previous_close :
    (input.previousClose != null ? input.previousClose :
      (input.reference_price != null ? input.reference_price : input.referencePrice));
  if (!finitePositive(previousClose)) {
    return makeDataQuality('MISSING_REFERENCE', 'Reference price belum valid; perlu validasi ulang.');
  }

  var tradedInWindow = 0;
  var start = Math.max(0, candles.length - sparseWindow);
  for (var i = 0; i < candles.length; i++) {
    var c = candles[i] || {};
    var open = Number(c.open);
    var high = Number(c.high);
    var low = Number(c.low);
    var close = Number(c.close);
    var volume = Number(c.volume);
    if (!finitePositive(open) || !finitePositive(high) || !finitePositive(low) || !finitePositive(close) || !isFinite(volume) || volume < 0 || high < low || close > high || close < low || open > high || open < low) {
      return makeDataQuality('INVALID_CANDLE', 'Candle tidak valid; data perlu validasi ulang.');
    }
    if (i >= start && volume > 0) tradedInWindow++;
    if (i > 0) {
      var prev = Number((candles[i - 1] || {}).close);
      if (finitePositive(prev)) {
        var closeGap = Math.abs(close - prev) / prev * 100;
        var openGap = Math.abs(open - prev) / prev * 100;
        if (closeGap > extremeGapPct || openGap > extremeGapPct) {
          return makeDataQuality('CORPORATE_ACTION_RISK', 'Gap ekstrem terdeteksi; perlu validasi corporate action sebelum menjadi sinyal publik.');
        }
      }
    }
  }

  var last = candles[candles.length - 1];
  var refGap = Math.abs(Number(last.close) - Number(previousClose)) / Number(previousClose) * 100;
  var refOpenGap = Math.abs(Number(last.open) - Number(previousClose)) / Number(previousClose) * 100;
  if (refGap > extremeGapPct || refOpenGap > extremeGapPct) {
    return makeDataQuality('CORPORATE_ACTION_RISK', 'Gap ekstrem terhadap reference price; perlu validasi corporate action.');
  }

  if (tradedInWindow < minTradingDays) {
    return makeDataQuality('SPARSE_TRADING_DAYS', 'Data perdagangan tidak utuh; perlu validasi ulang.');
  }

  return makeDataQuality('OK', 'Data valid');
}

// ============================================================
// RUN MODE DETECTION (WIB time-based)
// ============================================================

function getRunMode(overrideMode, nowValue) {
  if (overrideMode) {
    var m = String(overrideMode).toLowerCase().trim();
    if (m === 'morning') return 'MORNING_SCOUT';
    if (m === 'midday') return 'MIDDAY_CHECK';
    if (m === 'afternoon') return 'AFTERNOON_EXIT';
  }

  var now = nowValue == null ? new Date() : new Date(nowValue);
  if (Number.isNaN(now.getTime())) return 'OUTSIDE_MARKET';
  var wibMs = now.getTime() + (7 * 60 * 60 * 1000);
  var wib = new Date(wibMs);
  var h = wib.getUTCHours();
  var min = wib.getUTCMinutes();
  var totalMin = h * 60 + min;

  // 09:00–10:30 WIB = 540–630
  if (totalMin >= 540 && totalMin <= 630) return 'MORNING_SCOUT';
  // 10:30–13:30 WIB = 630–810
  if (totalMin > 630 && totalMin <= 810) return 'MIDDAY_CHECK';
  // 13:30–16:00 WIB = 810–960. Keep the conservative late-session
  // classification active for every Fast Watcher/Day Trade run through close.
  if (totalMin > 810 && totalMin <= 960) return 'AFTERNOON_EXIT';
  // Outside market
  return 'OUTSIDE_MARKET';
}

function getWibNow() {
  var now = new Date();
  var wibMs = now.getTime() + (7 * 60 * 60 * 1000);
  return new Date(wibMs);
}

function getWibDateStr() {
  return getWibNow().toISOString().slice(0, 10);
}

function getWibTimeStr() {
  var wib = getWibNow();
  return wib.toISOString().slice(11, 16) + ' WIB';
}

// ============================================================
// YAHOO FINANCE FETCHER (90-day OHLCV for Day Trade)
// ============================================================

async function fetchDayTradeCandles(ticker) {
  var symbol = ticker + '.JK';
  var url = 'https://query2.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=90d&interval=1d&includePrePost=false';

  var response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });

  if (!response.ok) return null;

  var data = await response.json();
  var result = data && data.chart && data.chart.result && data.chart.result[0];
  if (!result) return null;

  var timestamps = result.timestamp || [];
  var indicators = result.indicators && result.indicators.quote && result.indicators.quote[0];
  if (!indicators) return null;

  var opens = indicators.open || [];
  var highs = indicators.high || [];
  var lows = indicators.low || [];
  var closes = indicators.close || [];
  var volumes = indicators.volume || [];

  var candles = [];
  for (var i = 0; i < timestamps.length; i++) {
    if (closes[i] != null && opens[i] != null && highs[i] != null && lows[i] != null && volumes[i] != null) {
      candles.push({
        time: timestamps[i],
        open: opens[i],
        high: highs[i],
        low: lows[i],
        close: closes[i],
        volume: volumes[i]
      });
    }
  }

  return candles.length >= 20 ? candles : null;
}

// ============================================================
// CORE ANALYSIS — Extract all metrics from candles
// ============================================================

function analyzeDayTrade(candles, ticker) {
  var len = candles.length;
  var lastIdx = len - 1;
  var last = candles[lastIdx];

  var closes = candles.map(function(c) { return c.close; });
  var highs = candles.map(function(c) { return c.high; });
  var lows = candles.map(function(c) { return c.low; });
  var volumes = candles.map(function(c) { return c.volume; });

  // Basic price data (today's candle = last daily candle)
  var last_price = round0(last.close);
  var open_price = round0(last.open);
  var high_price = round0(last.high);
  var low_price = round0(last.low);
  var prev_close = len >= 2 ? candles[lastIdx - 1].close : null;
  var dataQuality = deriveDataQualityStatus({ candles: candles, previous_close: prev_close });
  if (!prev_close) prev_close = last.open;
  var change_pct = (prev_close && prev_close > 0 && Number.isFinite((last_price - prev_close) / prev_close)) ? round2((last_price - prev_close) / prev_close * 100) : 0;
  if (!Number.isFinite(change_pct)) change_pct = 0;

  // Volume
  var volume_today = Number(last.volume) || 0;
  var value_today = round0(last_price * volume_today); // proxy tx value

  // Averages
  var vol20 = calcMA(volumes, 20);
  var avg_volume_20d = (vol20 && Number.isFinite(vol20) && vol20 > 0) ? round0(vol20) : null;
  var volume_ratio_20d = (avg_volume_20d != null && avg_volume_20d > 0 && Number.isFinite(volume_today / avg_volume_20d)) ? round2(volume_today / avg_volume_20d) : null;

  // Avg value 7d
  var last7 = candles.slice(-7);
  var avg_value_7d = last7.length > 0 ? round0(last7.reduce(function(s, c) { return s + (Number(c.close) || 0) * (Number(c.volume) || 0); }, 0) / last7.length) : 0;
  if (!Number.isFinite(avg_value_7d)) avg_value_7d = 0;

  // MAs
  var ma20 = calcMA(closes, 20);
  var ma50 = calcMA(closes, 50);

  // RSI 14
  var rsi14 = calcRSI(closes, 14);

  // Support: lowest low of last 20 candles
  var recent20Lows = lows.slice(-20);
  var support = round0(Math.min.apply(null, recent20Lows));

  // Resistance: highest high of last 20 candles
  var recent20Highs = highs.slice(-20);
  var resistance = round0(Math.max.apply(null, recent20Highs));

  // === ATR14 CALCULATION (V1 Level Quality Upgrade) ===
  var atr14 = null;
  if (len >= 15) {
    var trSum = 0;
    var trCount = 0;
    for (var ai = lastIdx - 13; ai <= lastIdx; ai++) {
      if (ai < 1) continue;
      var trHigh = (highs[ai] || 0) - (lows[ai] || 0);
      var trHighPrev = Math.abs((highs[ai] || 0) - (closes[ai - 1] || 0));
      var trLowPrev = Math.abs((lows[ai] || 0) - (closes[ai - 1] || 0));
      var tr = Math.max(trHigh, trHighPrev, trLowPrev);
      if (Number.isFinite(tr)) {
        trSum += tr;
        trCount++;
      }
    }
    if (trCount > 0 && Number.isFinite(trSum / trCount)) atr14 = trSum / trCount;
  }

  // === SWING LOW 5D (recent minor low for SL anchor) ===
  var swingLow5 = round0(Math.min.apply(null, lows.slice(-5)));

  // === SWING HIGH 10D (intermediate resistance for TP) ===
  var swingHigh10 = round0(Math.max.apply(null, highs.slice(-10)));

  // Range position: where is last_price within today's range (0=low, 100=high)
  var dayRange = high_price - low_price;
  var range_position = (dayRange > 0 && Number.isFinite((last_price - low_price) / dayRange)) ? round2((last_price - low_price) / dayRange * 100) : 50;
  if (!Number.isFinite(range_position)) range_position = 50;

  // Distance to breakout (resistance)
  var distance_to_breakout_pct = (resistance > 0 && last_price > 0 && Number.isFinite((resistance - last_price) / last_price)) ? round2((resistance - last_price) / last_price * 100) : 99;
  if (!Number.isFinite(distance_to_breakout_pct)) distance_to_breakout_pct = 99;

  return {
    ticker: ticker,
    last_price: last_price,
    price_source: 'yahoo_chart_1d_close',
    price_asof: last.time ? new Date(last.time * 1000).toISOString() : (last.date || null),
    price_date: last.time ? new Date(last.time * 1000).toISOString().slice(0, 10) : (last.date ? String(last.date).slice(0, 10) : null),
    open_price: open_price,
    high_price: high_price,
    low_price: low_price,
    change_pct: change_pct,
    previous_close: round0(prev_close),
    data_quality_status: dataQuality.data_quality_status,
    data_quality_label: dataQuality.data_quality_label,
    data_quality_note: dataQuality.data_quality_note,
    data_quality_valid: dataQuality.data_quality_valid,
    data_quality_needs_revalidation: dataQuality.data_quality_needs_revalidation,
    volume_today: volume_today,
    value_today: value_today,
    avg_volume_20d: avg_volume_20d,
    avg_value_7d: avg_value_7d,
    volume_ratio_20d: volume_ratio_20d,
    rsi14: rsi14 !== null ? round2(rsi14) : null,
    ma20: ma20 !== null ? round0(ma20) : null,
    ma50: ma50 !== null ? round0(ma50) : null,
    resistance: resistance,
    support: support,
    range_position: range_position,
    distance_to_breakout_pct: distance_to_breakout_pct,
    // V1 Level Quality fields
    atr14: atr14 !== null ? round2(atr14) : null,
    swingLow5: swingLow5,
    swingHigh10: swingHigh10,
    // Internal analysis flags
    _priceAboveOpen: last_price > open_price,
    _priceNearHigh: dayRange > 0 && Number.isFinite((high_price - last_price) / dayRange) ? (high_price - last_price) / dayRange < 0.2 : false,
    _fadeFromHigh: dayRange > 0 && Number.isFinite((high_price - last_price) / dayRange) ? (high_price - last_price) / dayRange : 0,
    _aboveMA20: ma20 ? last_price >= ma20 : false,
    _aboveMA50: ma50 ? last_price >= ma50 : false,
    _overextendedMA20: (ma20 && ma20 > 0 && Number.isFinite((last_price - ma20) / ma20)) ? (last_price - ma20) / ma20 > 0.08 : false
  };
}

// ============================================================
// LIQUIDITY GUARD (0-25 score + hard fail)
// ============================================================

function scoreLiquidity(data) {
  var score = 0;
  var pass = true;
  var reason = '';

  // Value today (proxy transaction value)
  var valToday = data.value_today || 0;
  var avgVal7d = data.avg_value_7d || 0;

  // Minimum thresholds for day trade:
  // value_today >= 1B IDR for reasonable intraday liquidity
  // avg_value_7d >= 500M IDR
  var MIN_VALUE_TODAY = 1000000000;    // 1B
  var MIN_AVG_VALUE_7D = 500000000;   // 500M
  var STRONG_VALUE = 5000000000;       // 5B (strong)
  var EXCELLENT_VALUE = 10000000000;   // 10B (excellent)

  if (valToday < MIN_VALUE_TODAY && avgVal7d < MIN_AVG_VALUE_7D) {
    pass = false;
    reason = 'Liquidity too low (Val<1B, Avg7d<500M)';
    return { score: 0, pass: false, reason: reason };
  }

  // Volume ratio check
  if (data.volume_ratio_20d < 0.3) {
    pass = false;
    reason = 'Volume sangat rendah (ratio<0.3)';
    return { score: 0, pass: false, reason: reason };
  }

  // Score based on value
  if (valToday >= EXCELLENT_VALUE) score += 12;
  else if (valToday >= STRONG_VALUE) score += 10;
  else if (valToday >= MIN_VALUE_TODAY * 3) score += 7;
  else if (valToday >= MIN_VALUE_TODAY) score += 4;
  else score += 2;

  // Volume ratio bonus
  if (data.volume_ratio_20d >= 2.0) score += 8;
  else if (data.volume_ratio_20d >= DT_INITIAL.distribution_volume_ratio) score += 6;
  else if (data.volume_ratio_20d >= 1.0) score += 4;
  else if (data.volume_ratio_20d >= 0.7) score += 2;
  else score += 0;

  // Avg value 7d stability
  if (avgVal7d >= STRONG_VALUE) score += 5;
  else if (avgVal7d >= MIN_VALUE_TODAY) score += 3;
  else score += 1;

  score = Math.min(25, score);
  return { score: score, pass: pass, reason: reason };
}

// ============================================================
// PRE-SPIKE DETECTOR (0-30 score) — V3: more sensitive early detection
// ============================================================

function scorePreSpike(data) {
  var score = 0;

  // Positive change — more granular & sensitive for early movers
  var chg = data.change_pct;
  if (chg >= 0.5 && chg <= 3.0) score += 8;       // sweet spot: early mover
  else if (chg > 3.0 && chg <= 4.5) score += 7;   // confirmed move
  else if (chg > 4.5 && chg <= 7.0) score += 4;   // already extended
  else if (chg >= 0.1 && chg < 0.5) score += 4;   // V3: very early sign (more sensitive)
  else if (chg > 7.0) score += 1;                  // overheat
  else if (chg >= -0.5 && chg < 0.1) score += 1;  // V3: flat/consolidation near breakout gets 1pt
  else score += 0;

  // Volume ratio — more sensitive to early build-up
  if (data.volume_ratio_20d >= 2.5) score += 7;
  else if (data.volume_ratio_20d >= 2.0) score += 6;
  else if (data.volume_ratio_20d >= DT_INITIAL.distribution_volume_ratio) score += 5;
  else if (data.volume_ratio_20d >= 1.2) score += 4;
  else if (data.volume_ratio_20d >= 1.0) score += 3;  // V3: normal vol still gets points if other signs exist
  else if (data.volume_ratio_20d >= 0.8) score += 1;
  else score += 0;

  // Price near resistance / high (distance to breakout) — more sensitive
  if (data.distance_to_breakout_pct <= 0.5) score += 6;   // V3: very close
  else if (data.distance_to_breakout_pct <= 1.5) score += 5;
  else if (data.distance_to_breakout_pct <= 3.0) score += 4;
  else if (data.distance_to_breakout_pct <= 5.0) score += 2;
  else score += 0;

  // Price above open (intraday strength)
  if (data._priceAboveOpen) score += 3;

  // V3: Price reclaiming previous close (above prev close = strength)
  if (data.change_pct > 0) score += 1;

  // Range position — sensitive to close-near-high pattern
  if (data.range_position >= 75 && data.range_position <= 95) score += 4; // V3: strong close position
  else if (data.range_position >= 60 && data.range_position < 75) score += 3;
  else if (data.range_position >= 40 && data.range_position < 60) score += 2;
  else if (data.range_position > 95) score += 1; // too extended but still strong
  else score += 0;

  return Math.min(30, score); // V3: max raised from 25 to 30
}

// ============================================================
// MOMENTUM SCORE (0-25) — V3: more sensitive, rewards early strength
// ============================================================

function scoreMomentum(data) {
  var score = 0;

  // RSI in healthy zone — V3: wider ideal zone for early detection
  if (data.rsi14 !== null) {
    if (data.rsi14 >= 50 && data.rsi14 <= 65) score += 7;  // V3: prime momentum zone
    else if (data.rsi14 >= 45 && data.rsi14 < 50) score += 6;
    else if (data.rsi14 >= 40 && data.rsi14 < 45) score += 5;  // V3: early accumulation
    else if (data.rsi14 > 65 && data.rsi14 <= 72) score += 5;  // V3: strong but not extreme
    else if (data.rsi14 > 72 && data.rsi14 <= 80) score += 2;
    else if (data.rsi14 > DT_INITIAL.rsi_overbought) score += 0;
    else if (data.rsi14 >= 30 && data.rsi14 < 40) score += 3;
    else score += 0;
  }

  // Price vs MA20
  if (data._aboveMA20) score += 5;
  else if (data.ma20 && data.last_price >= data.ma20 * 0.98) score += 3; // V3: near MA20 = potential reclaim

  // Price vs MA50
  if (data._aboveMA50) score += 4;
  else if (data.ma50 && data.last_price >= data.ma50 * 0.97) score += 2;

  // V3: Price near high (strong close = continuation signal)
  if (data._priceNearHigh && data._priceAboveOpen) score += 4; // V3: both = very strong
  else if (data._priceNearHigh) score += 3;

  // Change positive
  if (data.change_pct >= 1.0) score += 3;      // V3: meaningful move
  else if (data.change_pct > 0) score += 2;

  return Math.min(25, score); // V3: max raised from 20 to 25
}

// ============================================================
// RISK:REWARD SCORE (0-15)
// ============================================================

function scoreRiskReward(data, levels) {
  var score = 0;
  var rr = levels.risk_reward;

  if (rr >= 3.0) score += 15;
  else if (rr >= 2.5) score += 13;
  else if (rr >= 2.0) score += 11;
  else if (rr >= 1.5) score += 8;
  else if (rr >= 1.2) score += 5;
  else if (rr >= 1.0) score += 2;
  else score += 0;

  return Math.min(15, score);
}

// ============================================================
// TREND/POSITION SCORE (0-15) — V3: rewards consolidation near breakout
// ============================================================

function scoreTrend(data) {
  var score = 0;

  // Above both MAs = strong trend
  if (data._aboveMA20 && data._aboveMA50) score += 6;
  else if (data._aboveMA20) score += 4;
  else if (data._aboveMA50) score += 3;
  else if (data.ma20 && data.last_price >= data.ma20 * 0.97) score += 2; // V3: near MA20 from below

  // Positive change streak proxy
  if (data.change_pct >= 1.0) score += 3;
  else if (data.change_pct > 0) score += 2;

  // Range position > 50 (upper half) — V3: more granular
  if (data.range_position >= 70) score += 3;
  else if (data.range_position >= 50) score += 2;

  // Near breakout — V3: stronger reward
  if (data.distance_to_breakout_pct <= 1.0) score += 3;
  else if (data.distance_to_breakout_pct <= 2.5) score += 2;
  else if (data.distance_to_breakout_pct <= 4.0) score += 1;

  return Math.min(15, score); // V3: max raised from 10 to 15
}

// ============================================================
// PENALTY CALCULATION (-5 to -40) — V4: refined anti-chase + distribution + fade
// ============================================================

function calculatePenalty(data) {
  var penalty = 0;
  var reasons = [];

  // V4: Graduated anti-chase — penalizes increasingly with less volume support
  if (data.change_pct > DT_INITIAL.overheat_change_pct) {
    penalty -= 20;
    reasons.push('Gap/kenaikan sangat tinggi (+' + data.change_pct.toFixed(1) + '%). JANGAN chase — risiko reversal besar.');
  } else if (data.change_pct > 7.0 && data.volume_ratio_20d < 2.0) {
    penalty -= 15;
    reasons.push('Overheat (+' + data.change_pct.toFixed(1) + '%) tanpa volume konfirmasi. Risiko false breakout.');
  } else if (data.change_pct > 5.0 && data.volume_ratio_20d < 1.5) {
    penalty -= 10;
    reasons.push('Sudah naik +' + data.change_pct.toFixed(1) + '% tanpa volume kuat. Tunggu pullback.');
  } else if (data.change_pct > 4.0 && data.volume_ratio_20d < DT_INITIAL.prespike_volume_ratio) {
    penalty -= 6;
    reasons.push('Kenaikan moderat (+' + data.change_pct.toFixed(1) + '%) tapi volume belum konfirmasi.');
  }

  // V4: False breakout / fade from high — graduated
  if (data._fadeFromHigh > 0.6 && data.change_pct > 2.0) {
    penalty -= 12;
    reasons.push('Fade kuat dari high (wick ' + round0(data._fadeFromHigh * 100) + '%). Distribusi intraday.');
  } else if (data._fadeFromHigh > 0.4 && data.change_pct > 1.5) {
    penalty -= 7;
    reasons.push('Fade dari high (wick ' + round0(data._fadeFromHigh * 100) + '%). Waspadai rejection.');
  }

  // V4: Volume distribution guard — price below open with high volume
  if (!data._priceAboveOpen && data.volume_ratio_20d >= 2.0) {
    penalty -= 12;
    reasons.push('Price < open + volume sangat tinggi. Distribusi intraday kuat.');
  } else if (!data._priceAboveOpen && data.volume_ratio_20d >= DT_INITIAL.distribution_volume_ratio) {
    penalty -= 8;
    reasons.push('Price < open + volume tinggi. Indikasi distribusi.');
  } else if (!data._priceAboveOpen && data.volume_ratio_20d >= 1.2) {
    penalty -= 4;
    reasons.push('Price < open + volume meningkat. Monitor tekanan jual.');
  }

  // V4: Upper shadow with volume (rejection candle) — refined thresholds
  var dayRange = data.high_price - data.low_price;
  var upperShadow = data.high_price - Math.max(data.open_price, data.last_price);
  if (dayRange > 0 && upperShadow > dayRange * 0.5 && data.volume_ratio_20d >= DT_INITIAL.distribution_volume_ratio) {
    penalty -= 10;
    reasons.push('Upper shadow dominan + volume tinggi. Rejection candle kuat.');
  } else if (dayRange > 0 && upperShadow > dayRange * 0.4 && data.volume_ratio_20d >= 1.2) {
    penalty -= 6;
    reasons.push('Upper shadow besar + volume. Waspadai distribusi.');
  }

  // Overextended from MA20
  if (data._overextendedMA20) {
    penalty -= 8;
    reasons.push('Overextended dari MA20 (>' + (data.ma20 ? round2((data.last_price - data.ma20) / data.ma20 * 100) : 8).toFixed(1) + '%). Koreksi wajar.');
  }

  // RSI overbought — graduated
  if (data.rsi14 !== null && data.rsi14 > 85) {
    penalty -= 8;
    reasons.push('RSI extreme overbought (' + data.rsi14.toFixed(0) + '). Reversal risk sangat tinggi.');
  } else if (data.rsi14 !== null && data.rsi14 > DT_INITIAL.rsi_overbought) {
    penalty -= 5;
    reasons.push('RSI overbought (' + data.rsi14.toFixed(0) + '). Momentum bisa habis.');
  }

  // Negative change with weak volume (no interest)
  if (data.change_pct < -2.0 && data.volume_ratio_20d < 0.8) {
    penalty -= 5;
    reasons.push('Turun tanpa minat beli. Tidak ada support volume.');
  }

  // V4: Range position near floor with negative change — weak close
  if (data.range_position < 20 && data.change_pct < -1.0) {
    penalty -= 4;
    reasons.push('Close dekat low hari ini. Tekanan jual dominan.');
  }

  penalty = Math.max(-40, penalty);
  return { penalty: penalty, reasons: reasons };
}

// ============================================================
// ENTRY / SL / TP CALCULATION (Day Trade specific)
// V1 Level Quality Upgrade: ATR-aware, swing-structure-based
// ============================================================

function calculateLevels(data) {
  var last = data.last_price;
  var open = data.open_price;
  var high = data.high_price;
  var low = data.low_price;
  var support = data.support;
  var resistance = data.resistance;
  var atr = data.atr14;
  var swingLow5 = data.swingLow5;
  var swingHigh10 = data.swingHigh10;

  // ATR fallback: if not available, use today's range as proxy
  var atrProxy = atr || (high - low) || (last * 0.02);
  if (atrProxy <= 0) atrProxy = last * 0.02;

  // === ENTRY AREA (structure-based, tight for Day Trade) ===
  // Anchor entry to structural levels, not just percentage from last price
  var entryAnchor = Math.max(swingLow5 || low, Math.min(open, support));
  // entry_low: near structural floor but max 2% below current (Day Trade tight)
  var entry_low = round0(Math.max(entryAnchor, last - atrProxy * 0.7, last * 0.98));
  // entry_high: slightly above entry_low, max 0.5*ATR above entry_low
  var entry_high = round0(Math.min(entry_low + atrProxy * 0.5, last * 1.005, high));

  // Ensure entry_low <= entry_high
  if (entry_low > entry_high) {
    entry_low = round0(last - atrProxy * 0.5);
    entry_high = round0(last);
  }
  // Ensure entry_low > 0
  if (entry_low <= 0) entry_low = round0(last * 0.98);
  if (entry_high <= entry_low) entry_high = round0(entry_low + atrProxy * 0.3);

  // === STOP LOSS (ATR-aware, swing-low anchored) ===
  var entryMid = (entry_low + entry_high) / 2;
  // Base SL: below recent swing low with ATR buffer
  var sl_swing = round0((swingLow5 || low) - atrProxy * 0.3);
  // Alternative: percentage-based floor
  var sl_pct = round0(entryMid * 0.97);
  // Use the HIGHER (tighter) of the two, but ensure it's below entry
  var stop_loss = Math.max(sl_swing, sl_pct);

  // ATR validation: SL must not be too tight or too far
  var slDist = entryMid - stop_loss;
  if (slDist < atrProxy * 0.5) {
    // Too tight — widen to 0.7*ATR below entry
    stop_loss = round0(entryMid - atrProxy * 0.7);
  } else if (slDist > atrProxy * 2.5) {
    // Too far — cap at 2*ATR below entry
    stop_loss = round0(entryMid - atrProxy * 2.0);
  }

  // Safety: SL must be below entry_low
  if (stop_loss >= entry_low) {
    stop_loss = round0(entry_low - atrProxy * 0.5);
  }
  // Final cap: max 5% from entry for Day Trade
  if (stop_loss < entryMid * 0.95) {
    stop_loss = round0(entryMid * 0.95);
  }
  if (stop_loss >= entry_low) {
    stop_loss = round0(entry_low * 0.97);
  }

  // === TP1 (nearest structural target) ===
  var risk = entryMid - stop_loss;
  if (risk <= 0) risk = atrProxy * 0.7; // fallback

  // Candidates for TP1: swing high 10D, 1.5*risk measured move, resistance
  var tp1_swingHigh = swingHigh10 || resistance;
  var tp1_measured = round0(entryMid + risk * 1.5);
  var tp1_resistance = resistance;

  // Pick nearest valid target above entry that is >= 0.7*ATR away
  var tp1Candidates = [tp1_swingHigh, tp1_measured, tp1_resistance].filter(function(t) {
    return t > entryMid + atrProxy * 0.7;
  });
  tp1Candidates.sort(function(a, b) { return a - b; }); // ascending

  var tp1 = tp1Candidates.length > 0 ? round0(tp1Candidates[0]) : round0(entryMid + risk * 1.5);

  // === TP2 (extended target, ATR-capped) ===
  // Max: entry + 2.5*ATR or resistance, whichever is lower
  var tp2_measured = round0(entryMid + risk * 2.5);
  var tp2_atrCap = round0(entryMid + atrProxy * 2.5);
  var tp2 = round0(Math.min(tp2_measured, tp2_atrCap, resistance * 1.02));
  // TP2 must be > TP1
  if (tp2 <= tp1) {
    tp2 = round0(tp1 + atrProxy * 0.5);
  }

  // === TP VALIDATION: cap unrealistic targets ===
  // If TP1 > resistance, cap at resistance
  if (tp1 > resistance && resistance > entryMid) {
    tp1 = round0(resistance);
  }
  // If TP1 <= entry_high, use swing high or resistance directly
  if (tp1 <= entry_high) {
    tp1 = round0(Math.max(swingHigh10 || resistance, entryMid + atrProxy));
  }

  // === RISK REWARD (recalculated from final levels) ===
  var finalRisk = entryMid - stop_loss;
  var reward1 = tp1 - entryMid;
  var risk_reward = (finalRisk > 0 && Number.isFinite(reward1 / finalRisk)) ? round2(reward1 / finalRisk) : 0;
  if (!Number.isFinite(risk_reward) || risk_reward < 0) risk_reward = 0;

  // === RR QUALITY GUARD ===
  var levelNote = '';
  // If RR > 5 and TP has no structural support, cap TP
  if (risk_reward > 5.0 && tp1 > resistance) {
    tp1 = round0(resistance);
    reward1 = tp1 - entryMid;
    risk_reward = (finalRisk > 0 && Number.isFinite(reward1 / finalRisk)) ? round2(reward1 / finalRisk) : 0;
    if (!Number.isFinite(risk_reward) || risk_reward < 0) risk_reward = 0;
    levelNote = 'TP dikonservatifkan — target terlalu jauh tanpa struktur.';
  }

  // Risk distance %
  var riskDistPct = (entryMid > 0 && Number.isFinite(finalRisk / entryMid)) ? round2(finalRisk / entryMid * 100) : 99;
  if (!Number.isFinite(riskDistPct)) riskDistPct = 99;

  // === CATATAN (level quality explanation) ===
  if (!levelNote) {
    if (atr && sl_swing > sl_pct) {
      levelNote = 'SL berbasis swing low 5D + ATR buffer.';
    } else if (atr && slDist > atrProxy * 2.0) {
      levelNote = 'SL disesuaikan ATR — jarak wajar untuk volatilitas.';
    } else if (tp1 === swingHigh10 && swingHigh10 < resistance) {
      levelNote = 'TP1 disesuaikan ke swing high 10D terdekat.';
    } else if (risk_reward < 1.2) {
      levelNote = 'RR kurang layak, pertimbangkan tunggu setup lebih baik.';
    } else {
      levelNote = 'Entry dekat struktur, RR ' + risk_reward.toFixed(1) + ':1.';
    }
  }

  var invalidation = 'Close < ' + round0(stop_loss) + ' atau break low ' + round0(swingLow5 || low);

  return {
    entry_low: entry_low,
    entry_high: entry_high,
    stop_loss: stop_loss,
    tp1: tp1,
    tp2: tp2,
    risk_reward: risk_reward,
    invalidation: invalidation,
    level_note: levelNote,
    _riskDistPct: riskDistPct
  };
}

// ============================================================
// STATUS CLASSIFICATION (with hard guards) — V2: afternoon, volume, gap guards
// ============================================================

function classifyStatus(compositeScore, data, levels, liqResult, penaltyResult, board, runMode, candleDowngrade) {
  // === HARD GUARDS that block READY_BREAKOUT ===
  var hardFails = [];

  // Papan Akselerasi — cannot be READY, downgrade to SPECULATIVE max
  var isAkselerasi = board && board.toUpperCase() === 'AKSELERASI';
  if (isAkselerasi) {
    hardFails.push('Papan Akselerasi');
  }

  // === SEVERE HARD FAILS → always AVOID (regardless of score) ===
  // Only truly broken/dangerous cases become AVOID
  if (!liqResult.pass) {
    return { status: 'AVOID', setup: 'Avoid - Liquidity Risk', notes: 'Likuiditas kurang aman untuk day trade. Value/volume terlalu rendah.' };
  }

  // Collect soft hard fails (block READY but not necessarily AVOID)
  var hasOverheat = false;
  var hasPoorRR = false;
  var hasRiskFar = false;
  var hasGapUp = false;
  var hasLowVolume = false;
  var hasDistribution = false;

  if (levels.risk_reward < DT_INITIAL.ready_risk_reward) {
    hardFails.push('RR < 1.5');
    hasPoorRR = true;
  }

  if (levels._riskDistPct > DT_INITIAL.max_ready_risk_distance_pct) {
    hardFails.push('Risk jauh (' + levels._riskDistPct.toFixed(1) + '%)');
    hasRiskFar = true;
  }

  // V2 B5: Gap-up / overheat guard (stricter)
  if (data.change_pct > DT_INITIAL.overheat_change_pct) {
    hardFails.push('Gap/overheat >8.5%');
    hasOverheat = true;
    hasGapUp = true;
  } else if (data.change_pct > 7.0 && data.volume_ratio_20d < 2.0) {
    hardFails.push('Overheat');
    hasOverheat = true;
  } else if (data.change_pct > 5.0 && data.volume_ratio_20d < 1.5) {
    hardFails.push('Gap tinggi tanpa vol kuat');
    hasGapUp = true;
  }

  // V2 B2: PRE_SPIKE requires volume_ratio >= 1.2
  if (data.volume_ratio_20d < DT_INITIAL.prespike_volume_ratio) {
    hasLowVolume = true;
  }

  // V2 B7: Distribution detection for day trade
  if (!data._priceAboveOpen && data.volume_ratio_20d >= DT_INITIAL.distribution_volume_ratio) {
    hasDistribution = true;
    hardFails.push('Distribusi intraday');
  }

  if (data._overextendedMA20) {
    hardFails.push('Overextended MA20');
  }

  if (data.rsi14 !== null && data.rsi14 > DT_INITIAL.rsi_overbought) {
    hardFails.push('RSI overbought');
  }

  // V2 B4: Afternoon conservative mode
  var isAfternoon = (runMode === 'AFTERNOON_EXIT');

  // === SEVERE AVOID: only for truly broken cases ===
  // Score < 40 OR (score < 50 AND no meaningful activity)
  if (compositeScore < DT_INITIAL.avoid_score) {
    return { status: 'AVOID', setup: determineAvoidSetup(data, penaltyResult), notes: generateAvoidNotes(hardFails, penaltyResult, data) };
  }
  if (compositeScore < 50 && data.volume_ratio_20d < 0.5 && data.change_pct < 0) {
    return { status: 'AVOID', setup: 'Avoid - No Interest', notes: 'Tidak ada minat beli. Volume rendah, harga turun.' };
  }
  // Extreme risk distance (> 8%) with low score = truly avoid
  if (compositeScore < 50 && levels._riskDistPct > 8.0) {
    return { status: 'AVOID', setup: 'Avoid - Extreme Risk', notes: 'Jarak SL terlalu jauh (' + levels._riskDistPct.toFixed(1) + '%). Tidak layak day trade.' };
  }

  // === CLASSIFICATION (V3: 2-layer with A_PLUS_SETUP + EARLY_RADAR) ===
  var status, setup, notes;

  // A_PLUS_SETUP: score >= 88, NO hard fails, all confirmations pass, strict
  if (compositeScore >= DT_INITIAL.a_plus_score && hardFails.length === 0 && !isAfternoon &&
      data._priceAboveOpen && data.volume_ratio_20d >= DT_INITIAL.distribution_volume_ratio &&
      data.range_position >= 60 && levels.risk_reward >= 1.5 &&
      !hasDistribution && data.change_pct <= 7.0 && !candleDowngrade) {
    status = 'A_PLUS_SETUP';
    setup = determineSetup(data, 'ready');
    notes = 'Setup A+ — semua konfirmasi terpenuhi. Potensi naik kuat. Entry hanya jika masih di area entry, volume tetap masuk. Wajib konfirmasi manual.';
  }
  // TRADE_CANDIDATE: score >= 78, no hard fails, good setup but not all A+ confirmations
  else if (compositeScore >= DT_INITIAL.trade_candidate_score && hardFails.length === 0 && !isAfternoon &&
           data._priceAboveOpen && data.volume_ratio_20d >= 1.2 && !hasDistribution) {
    status = 'TRADE_CANDIDATE';
    setup = determineSetup(data, 'ready');
    notes = 'Kandidat trade — setup bagus, butuh konfirmasi chart. Entry jika price bertahan di area entry dan volume tetap masuk.';
  }
  // READY_BREAKOUT: score >= 75, NO hard fails, NOT Akselerasi, NOT afternoon
  else if (compositeScore >= DT_INITIAL.ready_score && hardFails.length === 0 && !isAfternoon) {
    status = 'READY_BREAKOUT';
    setup = determineSetup(data, 'ready');
    notes = 'Radar day trade. Entry hanya jika harga masih bertahan di area entry dan volume tetap masuk. Wajib konfirmasi manual di chart/orderbook.';
  }
  // Afternoon mode — downgrade READY/TRADE to MOMENTUM_CONTINUATION
  else if (compositeScore >= DT_INITIAL.ready_score && hardFails.length === 0 && isAfternoon) {
    status = 'MOMENTUM_CONTINUATION';
    setup = 'Late Session Momentum';
    notes = 'Late entry berisiko. Prioritaskan exit sebelum close. Jangan entry agresif kecuali sudah punya posisi dan trailing plan.';
  }
  // PRE_SPIKE_WATCH: score >= 70, no hard fails, V2: requires volume >= 1.2
  else if (compositeScore >= DT_INITIAL.prespike_score && hardFails.length === 0 && !hasLowVolume && !isAfternoon) {
    if (data.change_pct > 5.0) {
      if (data.volume_ratio_20d >= DT_INITIAL.distribution_volume_ratio && data._priceAboveOpen) {
        status = 'MOMENTUM_CONTINUATION';
        setup = 'Momentum Continuation';
        notes = 'Sudah rally (+' + data.change_pct.toFixed(1) + '%). Bukan pre-spike. Gunakan tight SL, jangan over-size.';
      } else {
        status = 'WAIT_PULLBACK';
        setup = 'Wait - Gap/Overheat';
        notes = 'Gap/kenaikan sudah tinggi (+' + data.change_pct.toFixed(1) + '%). Hindari chase, tunggu pullback/konfirmasi lanjutan.';
      }
    } else {
      status = 'PRE_SPIKE_WATCH';
      setup = determineSetup(data, 'prespike');
      notes = 'Volume mulai masuk, tunggu breakout area entry. Konfirmasi volume wajib sebelum entry.';
    }
  }
  // PRE_SPIKE blocked due to low volume but score decent
  else if (compositeScore >= DT_INITIAL.prespike_score && hardFails.length === 0 && hasLowVolume && !isAfternoon) {
    // V3: if near breakout + some signs, classify as EARLY_RADAR instead of SPECULATIVE
    if (data.distance_to_breakout_pct <= 4.0 && data.change_pct >= 0 && !hasDistribution) {
      status = 'EARLY_RADAR';
      setup = 'Early Radar - Volume Belum';
      notes = 'Dekat breakout tapi volume belum konfirmasi (vol ' + data.volume_ratio_20d.toFixed(2) + 'x). Monitor volume build-up.';
    } else {
      status = 'SPECULATIVE';
      setup = 'Speculative - Volume Belum Konfirmasi';
      notes = 'Belum ada konfirmasi volume untuk pre-spike (vol ratio ' + data.volume_ratio_20d.toFixed(2) + 'x < 1.2x). Monitor saja.';
    }
  }
  // Afternoon PRE_SPIKE → Watch/Wait
  else if (compositeScore >= DT_INITIAL.prespike_score && hardFails.length === 0 && isAfternoon) {
    status = 'WAIT_PULLBACK';
    setup = 'Late Session - Wait';
    notes = 'Sesi sore, waktu breakout terbatas. Late entry berisiko. Prioritas exit.';
  }
  else if (compositeScore >= DT_INITIAL.near_breakout_score && hardFails.length === 0 && data.distance_to_breakout_pct <= 3.0 && !hasLowVolume && !isAfternoon) {
    if (data.change_pct > 5.0) {
      status = 'WAIT_PULLBACK';
      setup = 'Wait - Extended';
      notes = 'Sudah naik tinggi (+' + data.change_pct.toFixed(1) + '%). Tunggu koreksi sebelum entry baru.';
    } else {
      status = 'PRE_SPIKE_WATCH';
      setup = determineSetup(data, 'prespike');
      notes = 'Dekat breakout zone. Monitor volume confirmation.';
    }
  }
  // EARLY_RADAR: score >= 62, early signs, not yet fully confirmed — V3 new
  else if (compositeScore >= DT_INITIAL.early_radar_score && hardFails.length === 0 && !isAfternoon &&
           data.change_pct >= -0.5 && data.change_pct <= 5.0 &&
           data.distance_to_breakout_pct <= 5.0 && !hasDistribution) {
    status = 'EARLY_RADAR';
    setup = determineSetup(data, 'prespike');
    notes = 'Radar awal — ada tanda akumulasi/tekanan. Belum breakout. Monitor volume + harga. Jangan entry sebelum konfirmasi.';
  }
  // V3: EARLY_RADAR catch — score 58-62 with promising signs
  else if (compositeScore >= DT_INITIAL.early_building_score && hardFails.length === 0 && !isAfternoon &&
           data._priceAboveOpen && data.distance_to_breakout_pct <= 5.0 &&
           data.volume_ratio_20d >= 0.8 && !hasDistribution && data.change_pct >= 0) {
    status = 'EARLY_RADAR';
    setup = 'Early Radar - Building';
    notes = 'Sinyal awal sedang terbentuk. Harga di atas open, mendekati resistance. Belum cukup konfirmasi untuk entry.';
  }
  // WAIT_PULLBACK: score >= 60 but has overheat/RR/extended/gap issues
  else if (compositeScore >= DT_INITIAL.momentum_score && (hasOverheat || hasPoorRR || hasRiskFar || hasGapUp)) {
    status = 'WAIT_PULLBACK';
    setup = hasGapUp ? 'Wait - Gap/Overheat' : (hasOverheat ? 'Wait - Overheat' : (hasPoorRR ? 'Wait - Poor RR' : 'Wait - Risk Far'));
    notes = generateWaitNotes(hardFails, hasOverheat, hasPoorRR, data);
    if (hasGapUp && !hasOverheat) {
      notes = 'Gap/kenaikan sudah tinggi (+' + data.change_pct.toFixed(1) + '%). Hindari chase, tunggu pullback/konfirmasi lanjutan.';
    }
  }
  // MOMENTUM_CONTINUATION: score >= 60, active, structurally valid
  else if (compositeScore >= DT_INITIAL.momentum_score && data._priceAboveOpen && data.volume_ratio_20d >= 1.0 && !hasDistribution) {
    if (data.ma20 && data.last_price >= data.ma20 * 0.98 && data.last_price <= data.ma20 * 1.02) {
      status = 'RECLAIM_CANDIDATE';
      setup = 'Reclaim Candidate';
      notes = 'Mencoba reclaim MA20. Entry jika confirm hold di atas.';
    } else {
      status = 'MOMENTUM_CONTINUATION';
      setup = 'Momentum Continuation';
      notes = 'Momentum aktif. Gunakan tight SL, jangan over-size.';
    }
  }
  // SPECULATIVE: score >= 50, some activity exists
  else if (compositeScore >= DT_INITIAL.persistence_score) {
    status = 'SPECULATIVE';
    setup = determineSetup(data, 'speculative');
    notes = generateSpeculativeNotes(hardFails, data);
  }
  // AVOID: only score < 50 reaches here
  else {
    status = 'AVOID';
    setup = determineAvoidSetup(data, penaltyResult);
    notes = generateAvoidNotes(hardFails, penaltyResult, data);
  }

  // Akselerasi cap: max SPECULATIVE regardless of score
  if (isAkselerasi && (status === 'A_PLUS_SETUP' || status === 'TRADE_CANDIDATE' || status === 'READY_BREAKOUT' || status === 'PRE_SPIKE_WATCH' || status === 'MOMENTUM_CONTINUATION')) {
    status = 'SPECULATIVE';
    setup = 'Speculative - Papan Akselerasi';
    notes = 'Papan Akselerasi. Likuiditas/spread berisiko untuk day trade.';
  }

  return { status: status, setup: setup, notes: notes };
}

// === NOTES GENERATORS ===

function generateWaitNotes(hardFails, hasOverheat, hasPoorRR, data) {
  if (hasOverheat) {
    return 'Sudah naik +' + data.change_pct.toFixed(1) + '%. JANGAN chase. Tunggu pullback/retest ke area entry sebelum pertimbangan entry.';
  }
  if (hasPoorRR) {
    return 'Momentum ada, tapi Risk:Reward belum layak (RR<1.5). Tunggu pullback agar entry lebih dekat SL.';
  }
  if (data.change_pct > 4.0) {
    return 'Sudah extended (+' + data.change_pct.toFixed(1) + '%). ' + hardFails[0] + '. Entry sekarang = chase.';
  }
  return 'Setup aktif tapi ' + hardFails[0] + '. Tunggu koreksi sebelum entry.';
}

function generateSpeculativeNotes(hardFails, data) {
  if (data.volume_ratio_20d >= DT_INITIAL.distribution_volume_ratio && data.change_pct > 0) {
    return 'Volume masuk tapi setup belum lengkap. Monitor — bukan entry. Tunggu konfirmasi breakout/volume sustain.';
  }
  if (data.change_pct > 3.0 && data.volume_ratio_20d < 1.0) {
    return 'Naik tanpa volume. Risiko false move. Tidak layak entry.';
  }
  if (hardFails.length > 0) {
    return 'Partial setup: ' + hardFails.slice(0, 2).join(', ') + '. Risk tinggi, hanya watchlist.';
  }
  return 'Setup belum kuat. Hanya watchlist, bukan entry. Tunggu konfirmasi multiple factor.';
}

function generateAvoidNotes(hardFails, penaltyResult, data) {
  if (penaltyResult.reasons.length > 0) {
    var r = penaltyResult.reasons[0];
    if (r.includes('Overheat') || r.includes('chase')) return 'Sudah terlalu panas. Risiko false breakout/reversal tinggi. HINDARI entry.';
    if (r.includes('Fade') || r.includes('wick')) return 'Sudah fade dari high. Distribusi intraday terlihat. Hindari entry.';
    if (r.includes('Distribusi')) return 'Tekanan jual intraday dominan. Bukan setup day trade yang aman.';
  }
  if (data.volume_ratio_20d < 0.5) return 'Likuiditas sangat rendah. Tidak layak day trade — spread/slippage risk.';
  if (data.change_pct < -3) return 'Tekanan jual dominan (turun ' + data.change_pct.toFixed(1) + '%). Tidak layak entry.';
  if (hardFails.length > 0) return hardFails.slice(0, 2).join(', ') + '. Setup tidak memenuhi kriteria day trade.';
  return 'Score rendah, setup tidak memenuhi kriteria day trade.';
}

function determineSetup(data, tier) {
  // Determine setup label based on data patterns
  if (data.distance_to_breakout_pct <= 1.5 && data.volume_ratio_20d >= DT_INITIAL.distribution_volume_ratio) {
    return 'Pre-Breakout Accumulation';
  }
  if (data.volume_ratio_20d >= 2.0 && data.change_pct >= 0.5 && data.change_pct <= 4.0) {
    return 'Volume Build-Up';
  }
  if (data.distance_to_breakout_pct <= 2.5 && data.range_position >= 70) {
    return 'Resistance Pressure';
  }
  if (data._priceAboveOpen && data.range_position >= 80 && data.change_pct >= 1.0) {
    return 'Opening Range Breakout';
  }
  if (data.change_pct >= 3.0 && data._priceNearHigh && data.volume_ratio_20d >= 1.3) {
    return 'Momentum Continuation';
  }
  if (data.rsi14 !== null && data.rsi14 <= 40 && data.change_pct >= 0) {
    return 'Rebound Support';
  }
  if (data.change_pct > 5.0 && data.volume_ratio_20d >= 2.0) {
    return 'High Volume Surge';
  }
  if (tier === 'prespike') return 'Pre-Breakout Accumulation';
  if (tier === 'speculative') return 'Speculative Setup';
  return 'Volume Build-Up';
}

function determineAvoidSetup(data, penaltyResult) {
  if (penaltyResult.reasons.length > 0) {
    var r = penaltyResult.reasons[0];
    if (r.includes('Overheat') || r.includes('tinggi')) return 'Avoid - Overheat';
    if (r.includes('Fade') || r.includes('wick')) return 'Avoid - False Breakout';
  }
  if (data.volume_ratio_20d < 0.5) return 'Avoid - Liquidity Risk';
  if (data.change_pct < -3) return 'Avoid - Weak';
  return 'Avoid - Poor Setup';
}

// ============================================================
// TIME PLAN GENERATION — V4: explicit risk warnings per status
// ============================================================

function generateTimePlan(status, runMode, data) {
  if (status === 'AVOID') return 'Tidak disarankan entry hari ini. Cari setup lain yang lebih aman.';

  var base = '';
  if (runMode === 'MORNING_SCOUT') {
    base = 'Entry pagi jika konfirmasi volume + breakout area. ';
  } else if (runMode === 'MIDDAY_CHECK') {
    base = 'Entry siang jika breakout confirm + volume sustain. ';
  } else if (runMode === 'AFTERNOON_EXIT') {
    base = 'SESI SORE — late entry sangat berisiko. Prioritas EXIT sebelum close. Jangan entry agresif kecuali trailing plan aktif. ';
  } else {
    base = 'Di luar jam pasar. Monitor sesi berikutnya. ';
  }

  if (status === 'A_PLUS_SETUP') {
    return base + 'SETUP A+ — prioritas utama. Semua konfirmasi terpenuhi. Entry area valid, volume masuk. Wajib konfirmasi manual. Exit disiplin sebelum 14:50 jika TP belum hit.';
  }
  if (status === 'TRADE_CANDIDATE') {
    return base + 'Kandidat trade kuat — butuh konfirmasi chart/orderbook. Entry jika price bertahan + volume sustain. Exit disiplin sebelum 14:50.';
  }
  if (status === 'READY_BREAKOUT') {
    return base + 'READY = kandidat prioritas, BUKAN instruksi beli otomatis. Entry area valid. Konfirmasi wajib: volume masuk + price hold. Exit sebelum 14:50.';
  }
  if (status === 'EARLY_RADAR') {
    return base + 'Radar awal — BELUM entry. Pantau volume build-up + price action. Entry HANYA jika terjadi breakout konfirmasi.';
  }
  if (status === 'PRE_SPIKE_WATCH') {
    return base + 'Tunggu volume spike + break resistance. JANGAN chase. Sabar menunggu konfirmasi.';
  }
  if (status === 'WAIT_PULLBACK') {
    return base + 'JANGAN entry sekarang — sudah extended. Tunggu pullback ke entry area. Chase = risiko tinggi.';
  }
  if (status === 'RECLAIM_CANDIDATE') {
    return base + 'Entry HANYA jika price confirm hold di atas MA20. Bukan buy di bawah.';
  }
  if (status === 'MOMENTUM_CONTINUATION') {
    return base + 'Momentum aktif. Gunakan tight SL, size kecil. Exit segera jika momentum melemah.';
  }
  return base + 'Risky setup. Small position only. Siap cut loss cepat.';
}

// ============================================================
// FULL SCORING PIPELINE
// ============================================================

function scoreDayTrade(data, runMode, board, candleResult, evaluationOptions) {
  evaluationOptions = evaluationOptions || {};
  // 1. Calculate levels
  var levels = calculateLevels(data);

  // 1b. Apply IDX tick size normalization to levels
  var tickResult = idxTick.normalizeLevelsToIdxTicks(levels, { mode: 'daytrade' });
  if (tickResult.tick_normalized) {
    levels.entry_low = tickResult.entry_low;
    levels.entry_high = tickResult.entry_high;
    levels.stop_loss = tickResult.stop_loss;
    levels.tp1 = tickResult.tp1;
    levels.tp2 = tickResult.tp2;
    levels.risk_reward = tickResult.risk_reward;
  }
  levels.tick_normalized = tickResult.tick_normalized;
  levels.tick_notes = tickResult.tick_notes;

  // 2. Liquidity Guard
  var liqResult = scoreLiquidity(data);

  // 3. Pre-Spike
  var prespike = scorePreSpike(data);

  // 4. Momentum
  var momentum = scoreMomentum(data);

  // 5. Risk:Reward
  var rrScore = scoreRiskReward(data, levels);

  // 6. Trend
  var trend = scoreTrend(data);

  // 7. Penalty
  var penaltyResult = calculatePenalty(data);

  // 8. Candle Pattern Confirmation (V1 — additive/subtractive, capped)
  var candleScore = 0;
  var candleNote = null;
  var candleDowngrade = false;
  if (candleResult && candleResult.pattern) {
    var cp = candleResult;
    var vr = data.volume_ratio_20d;

    // === POSITIVE Day Trade boosts ===
    if (cp.pattern === 'Bullish Engulfing' && vr >= 1.3) candleScore += 5;
    else if (cp.pattern === 'Bullish Engulfing') candleScore += 3;

    if (cp.pattern === 'Bullish Marubozu') candleScore += 4;
    if (cp.pattern === 'Strong breakout candle') candleScore += 6;
    if (cp.pattern === 'Three White Soldiers' && cp.risk !== 'Overextended') candleScore += 4;
    if ((cp.pattern === 'Hammer' || cp.pattern === 'Dragonfly Doji') && data.last_price <= data.support * 1.03) candleScore += 3;
    if (cp.pattern === 'Morning Star') candleScore += 4;

    // === NEGATIVE Day Trade downgrades ===
    if (cp.pattern === 'Shooting Star') { candleScore -= 5; candleDowngrade = true; }
    if (cp.pattern === 'Gravestone Doji') { candleScore -= 5; candleDowngrade = true; }
    if (cp.pattern === 'Bearish Engulfing') { candleScore -= 6; candleDowngrade = true; }
    if (cp.pattern === 'Bearish Marubozu') { candleScore -= 6; candleDowngrade = true; }
    if (cp.pattern === 'Distribution candle') { candleScore -= 7; candleDowngrade = true; }
    if (cp.pattern === 'Rejection candle') { candleScore -= 5; candleDowngrade = true; }
    if (cp.pattern === 'Failed breakout candle') { candleScore -= 6; candleDowngrade = true; }
    if (cp.pattern === 'Evening Star') { candleScore -= 5; candleDowngrade = true; }
    if (cp.pattern === 'Three Black Crows') { candleScore -= 6; candleDowngrade = true; }
    if (cp.pattern === 'Doji' && cp.risk === 'Indecision' && data.change_pct > 4) { candleScore -= 3; }
    if (cp.pattern === 'Hanging Man') { candleScore -= 4; candleDowngrade = true; }

    // Guard: candle must NOT override illiquidity
    if (vr < 0.5 && candleScore > 0) candleScore = 0;
    // Guard: candle must NOT override poor RR
    if (levels.risk_reward < 1.2 && candleScore > 0) candleScore = Math.min(candleScore, 2);

    // Cap candle contribution
    if (candleScore > 6) candleScore = 6;
    if (candleScore < -8) candleScore = -8;

    candleNote = cp.note;
  }

  // Composite score (cap 0-100)
  var rawScore = liqResult.score + prespike + momentum + rrScore + trend + penaltyResult.penalty + candleScore;
  var compositeScore = Math.max(0, Math.min(100, rawScore));

  // 8. Classify (pass board for Akselerasi hard guard, runMode for afternoon V2)
  var classification = classifyStatus(compositeScore, data, levels, liqResult, penaltyResult, board, runMode, candleDowngrade);
  // Capture before entry/plan/risk/breakout/ARA guards mutate classification.
  var evaluationInitial = null;
  if (evaluationOptions.captureEvaluationInitial === true) {
    evaluationInitial = Object.freeze({
      score_raw: rawScore, score_display: compositeScore, status: classification.status,
      score_components_raw: Object.freeze({ liquidity: liqResult.score, prespike: prespike, momentum: momentum, risk_reward: rrScore, trend: trend, penalty: penaltyResult.penalty, candle: candleScore }),
      gate_inputs: Object.freeze({ liquidity_pass: liqResult.pass, risk_reward: levels.risk_reward, risk_distance_pct: levels._riskDistPct, change_pct: data.change_pct, volume_ratio_20d: data.volume_ratio_20d, price_above_open: data._priceAboveOpen, distribution: !data._priceAboveOpen && data.volume_ratio_20d >= DT_INITIAL.distribution_volume_ratio, overextended_ma20: !!data._overextendedMA20, rsi14: data.rsi14, candle_downgrade: !!candleDowngrade, afternoon_mode: runMode === 'AFTERNOON_EXIT' }),
      levels: Object.freeze({ entry_low: levels.entry_low, entry_high: levels.entry_high, stop_loss: levels.stop_loss, tp1: levels.tp1, tp2: levels.tp2 })
    });
  }

  // 9. Time plan
  var timePlan = generateTimePlan(classification.status, runMode, data);

  // 10. V3: Confidence tier (derived from score/status, no DB column needed)
  var confidence = 'C';
  if (classification.status === 'A_PLUS_SETUP') confidence = 'A+';
  else if (classification.status === 'TRADE_CANDIDATE') confidence = 'A';
  else if (classification.status === 'READY_BREAKOUT') confidence = 'A';
  else if (classification.status === 'PRE_SPIKE_WATCH' || classification.status === 'EARLY_RADAR') confidence = 'B';
  else if (classification.status === 'MOMENTUM_CONTINUATION' || classification.status === 'RECLAIM_CANDIDATE') confidence = 'B';
  else if (classification.status === 'WAIT_PULLBACK' || classification.status === 'SPECULATIVE') confidence = 'C';
  else confidence = 'Avoid';

  // 11. V4: Entry timing label — more granular anti-chase awareness
  var entryTiming = 'Hanya pantau';
  if (classification.status === 'A_PLUS_SETUP' || classification.status === 'TRADE_CANDIDATE' || classification.status === 'READY_BREAKOUT') {
    if (data.change_pct <= 2.5 && levels._riskDistPct <= 2.5) entryTiming = 'Masih dekat entry';
    else if (data.change_pct <= 4.0 && levels._riskDistPct <= 4.0) entryTiming = 'Entry moderat — size kecil';
    else entryTiming = 'Tunggu breakout konfirmasi';
  } else if (classification.status === 'PRE_SPIKE_WATCH' || classification.status === 'EARLY_RADAR') {
    entryTiming = 'Tunggu breakout — belum entry';
  } else if (classification.status === 'WAIT_PULLBACK') {
    if (data.change_pct > 5.0) entryTiming = 'Sudah telat / JANGAN chase';
    else entryTiming = 'Tunggu pullback ke area entry';
  } else if (classification.status === 'MOMENTUM_CONTINUATION' && data.change_pct > 5.0) {
    entryTiming = 'Sudah telat / jangan chase';
  } else if (classification.status === 'MOMENTUM_CONTINUATION') {
    entryTiming = 'Masih bisa — tight SL wajib';
  } else if (classification.status === 'RECLAIM_CANDIDATE') {
    entryTiming = 'Tunggu konfirmasi reclaim MA20';
  } else if (classification.status === 'AVOID') {
    entryTiming = 'Hindari — setup tidak valid';
  }

  // Entry Status Engine v1 — conservative actionable/anti-chase guard
  var entryStatus = idxTick.deriveEntryStatus({
    current_price: data.last_price,
    last_price: data.last_price,
    entry_low: levels.entry_low,
    entry_high: levels.entry_high,
    stop_loss: levels.stop_loss,
    tp1: levels.tp1,
    tp2: levels.tp2,
    rr_reference_price: levels.rr_reference_price
  });
  var planQuality = idxTick.derivePlanQuality({
    mode: 'daytrade',
    current_price: data.last_price,
    last_price: data.last_price,
    entry_low: levels.entry_low,
    entry_high: levels.entry_high,
    stop_loss: levels.stop_loss,
    tp1: levels.tp1,
    tp2: levels.tp2,
    support: data.support,
    resistance: data.resistance,
    risk_reward: levels.risk_reward,
    tp1_upside: levels.tp1_upside,
    entry_status: entryStatus.entry_status
  });
  var invalidationDistance = idxTick.deriveInvalidationDistance({
    current_price: data.last_price,
    last_price: data.last_price,
    stop_loss: levels.stop_loss,
    invalidation: levels.invalidation
  });
  var planSanity = idxTick.validateTradingPlanSanity({
    entry_low: levels.entry_low,
    entry_high: levels.entry_high,
    stop_loss: levels.stop_loss,
    tp1: levels.tp1,
    tp2: levels.tp2,
    risk_reward: levels.risk_reward
  });
  var breakoutConfirmation = idxTick.deriveBreakoutConfirmation({
    current_price: data.last_price,
    last_price: data.last_price,
    close: data.last_price,
    high_price: data.high_price,
    resistance: data.resistance,
    breakout_trigger: data.resistance
  });
  var setupFreshness = idxTick.deriveSetupFreshness({
    calculated_at: new Date().toISOString(),
    current_price: data.last_price,
    last_price: data.last_price,
    entry_low: levels.entry_low,
    entry_high: levels.entry_high,
    stop_loss: levels.stop_loss
  });
  var guardedStatuses = { CHASE_RISK: true, EXTENDED: true, TP1_NEAR: true, TP1_HIT: true, TP2_HIT: true };
  if (guardedStatuses[entryStatus.entry_status]) {
    if (confidence === 'A+' || confidence === 'A') confidence = entryStatus.entry_status === 'EXTENDED' || entryStatus.entry_status.indexOf('TP') === 0 ? 'C' : 'B';
    if (entryTiming.indexOf('JANGAN chase') === -1) entryTiming = 'Tunggu pullback — jangan chase';
    classification.notes = classification.notes + ' Harga sudah menjauh dari entry, tunggu pullback.';
  } else if (entryStatus.entry_status === 'INVALID_BELOW_SL') {
    confidence = 'Avoid';
    entryTiming = 'Hindari — setup tidak valid';
    classification.status = 'AVOID';
    classification.setup = 'Invalid / Wait';
    classification.notes = classification.notes + ' Harga sudah menyentuh atau berada di bawah SL.';
  }
  if (!planSanity.trading_plan_valid) {
    confidence = 'C';
    entryTiming = 'Wait — level belum rapi';
    classification.status = 'WAIT_PULLBACK';
    classification.setup = 'Wait / Level belum rapi';
    classification.notes = classification.notes + ' Trading plan sanity invalid: ' + planSanity.trading_plan_note;
    planQuality.plan_quality_status = 'INVALID';
    planQuality.plan_quality_label = 'Wait / Level belum rapi';
    planQuality.plan_quality_note = planSanity.trading_plan_note;
  } else if (planQuality.plan_quality_status === 'INVALID') {
    confidence = 'C';
    entryTiming = 'Hindari — setup tidak valid';
    classification.status = 'AVOID';
    classification.setup = 'Invalid / Wait';
    classification.notes = classification.notes + ' Plan quality invalid: ' + planQuality.plan_quality_note;
  } else if (planQuality.rr_quality_label === 'RR kurang menarik') {
    if (confidence === 'A+' || confidence === 'A' || confidence === 'B') confidence = 'C';
    classification.setup = 'Wait - Poor RR';
  } else if (planQuality.sl_quality_label === 'SL terlalu mepet' || planQuality.tp_quality_label === 'TP terlalu jauh' || planQuality.tp_quality_label === 'TP ambisius') {
    if (confidence === 'A+' || confidence === 'A') confidence = 'B';
  }
  var riskV2ForGuard = idxTick.deriveRiskLabelV2(Object.assign({}, data, levels, entryStatus, planQuality, invalidationDistance, planSanity, {
    mode: 'daytrade',
    liquidity_label: liqResult.pass ? 'Liquid' : 'Likuiditas Tipis',
    volume_label: data.volume_ratio_20d >= 1 ? 'Volume valid' : 'Volume belum konfirmasi',
    board: data.board,
    risk_reward: levels.risk_reward,
    tp1_upside: levels.tp1_upside
  }));
  var guardedRiskV2 = idxTick.applyRiskV2ConfidenceGuard(Object.assign({ confidence: confidence, telegram_verdict: classification.notes }, riskV2ForGuard));
  confidence = guardedRiskV2.confidence || confidence;
  if (riskV2ForGuard.risk_label_v2 === 'Very High Risk') {
    entryTiming = 'Hindari / tunggu — risiko sangat tinggi';
    classification.status = classification.status === 'AVOID' ? classification.status : 'WAIT_PULLBACK';
  }
  if (breakoutConfirmation.breakout_confirmation_status !== 'BREAKOUT_CONFIRMED') {
    if (classification.status === 'A_PLUS_SETUP' || classification.status === 'TRADE_CANDIDATE' || classification.status === 'READY_BREAKOUT') {
      classification.status = 'EARLY_RADAR';
      classification.setup = breakoutConfirmation.false_breakout_risk ? 'False Breakout Risk' : 'Breakout Watch';
      entryTiming = 'Tunggu close confirmation — belum entry';
      if (confidence === 'A+' || confidence === 'A') confidence = 'B';
    }
    classification.notes = classification.notes + ' Breakout belum confirmed by close: ' + breakoutConfirmation.breakout_confirmation_note;
  }

  // 12. V4: Prediction direction label — risk-aware
  var direction = 'Hindari';
  if (confidence === 'A+') direction = 'Potensi naik kuat — konfirmasi lengkap';
  else if (confidence === 'A') direction = 'Potensi naik kuat';
  else if (confidence === 'B' && compositeScore >= 72) direction = 'Potensi naik moderat';
  else if (confidence === 'B' && compositeScore >= DT_INITIAL.near_breakout_score) direction = 'Radar awal — belum konfirmasi';
  else if (confidence === 'B') direction = 'Masih radar awal';
  else if (classification.status === 'WAIT_PULLBACK') direction = 'Rawan gagal lanjut — jangan chase';
  else if (classification.status === 'SPECULATIVE') direction = 'Rawan gagal lanjut';
  else if (classification.status === 'AVOID') direction = 'Hindari — risiko tinggi';
  else direction = 'Masih radar awal';

  var executionReality = idxTick.deriveCandlePotentialRange(Object.assign({}, data, levels, {
    previous_close: data.previous_close,
    prev_close: data.prev_close,
    current_price: data.last_price,
    last_price: data.last_price,
    board: board && board.board,
    mode: 'daytrade'
  }));
  if (executionReality.near_ara) {
    if (confidence === 'A+' || confidence === 'A') confidence = 'B';
    entryTiming = 'Watchlist — jangan chase dekat ARA';
    if (classification.status === 'A_PLUS_SETUP' || classification.status === 'TRADE_CANDIDATE' || classification.status === 'READY_BREAKOUT') classification.status = 'EARLY_RADAR';
    classification.notes = classification.notes + ' Harga dekat ARA; entry agresif tidak disarankan.';
  }
  if (executionReality.tp1_beyond_ara || (executionReality.candle_potential_high && levels.tp1 > executionReality.candle_potential_high)) {
    if (confidence === 'A+' || confidence === 'A') confidence = 'B';
    classification.notes = classification.notes + ' ' + (executionReality.tp_realism_note || 'TP1 butuh breakout lanjutan; potensi candle hari ini belum mendukung.');
  }

  var signalVerdict = idxTick.deriveSignalVerdict(Object.assign({}, data, levels, entryStatus, planQuality, riskV2ForGuard, executionReality, {
    mode: 'daytrade',
    confidence: confidence,
    liquidity_label: liqResult.pass ? 'Liquid' : 'Likuiditas Tipis',
    volume_label: data.volume_ratio_20d >= 1 ? 'Volume valid' : 'Volume belum konfirmasi',
    trend_label: trend >= 0 ? 'Improving Trend' : 'Weak Trend'
  }));
  if (signalVerdict.signal_confidence) confidence = signalVerdict.signal_confidence;

  return Object.assign({
    ticker: data.ticker,
    last_price: data.last_price,
    price_source: data.price_source || 'yahoo_chart_1d_close',
    price_asof: data.price_asof || null,
    price_date: data.price_date || null,
    open_price: data.open_price,
    high_price: data.high_price,
    low_price: data.low_price,
    change_pct: data.change_pct,
    previous_close: data.previous_close,
    volume_today: data.volume_today,
    value_today: data.value_today,
    avg_volume_20d: data.avg_volume_20d,
    avg_value_7d: data.avg_value_7d,
    volume_ratio_20d: data.volume_ratio_20d,
    rsi14: data.rsi14,
    ma20: data.ma20,
    ma50: data.ma50,
    resistance: data.resistance,
    support: data.support,
    range_position: data.range_position,
    distance_to_breakout_pct: data.distance_to_breakout_pct,
    // Levels
    entry_low: levels.entry_low,
    entry_high: levels.entry_high,
    stop_loss: levels.stop_loss,
    tp1: levels.tp1,
    tp2: levels.tp2,
    risk_reward: levels.risk_reward,
    invalidation: levels.invalidation,
    // Scoring breakdown
    daytrade_score: compositeScore,
    liquidity_score: liqResult.score,
    prespike_score: prespike,
    momentum_score: momentum,
    risk_reward_score: rrScore,
    trend_score: trend,
    penalty_score: penaltyResult.penalty,
    // Classification
    status: classification.status,
    setup: classification.setup,
    notes: candleNote ? classification.notes + ' | Candle: ' + candleNote : (levels.level_note ? classification.notes + ' | ' + levels.level_note : classification.notes),
    time_plan: timePlan,
    run_mode: runMode,
    // V3: New labels (computed, not DB columns)
    confidence: confidence,
    entry_timing: entryTiming,
    direction: direction,
    entry_status: entryStatus.entry_status,
    entry_status_label: entryStatus.entry_status_label,
    entry_status_note: entryStatus.entry_status_note,
    entry_quality_status: entryStatus.entry_quality_status,
    entry_quality_label: entryStatus.entry_quality_label,
    entry_safety_note: entryStatus.entry_safety_note,
    entry_distance_pct: entryStatus.entry_distance_pct,
    chase_risk_label: entryStatus.chase_risk_label,
    invalidation_distance_pct: invalidationDistance.invalidation_distance_pct,
    invalidation_distance_status: invalidationDistance.invalidation_distance_status,
    invalidation_distance_label: invalidationDistance.invalidation_distance_label,
    invalidation_note: invalidationDistance.invalidation_note,
    trading_plan_valid: planSanity.trading_plan_valid,
    trading_plan_status: planSanity.trading_plan_status,
    trading_plan_note: planSanity.trading_plan_note,
    plan_quality_status: planQuality.plan_quality_status,
    plan_quality_label: planQuality.plan_quality_label,
    plan_quality_note: planQuality.plan_quality_note,
    sl_quality_label: planQuality.sl_quality_label,
    tp_quality_label: planQuality.tp_quality_label,
    rr_quality_label: planQuality.rr_quality_label,
    risk_label_v2: riskV2ForGuard.risk_label_v2,
    risk_score_v2: riskV2ForGuard.risk_score_v2,
    risk_notes_v2: riskV2ForGuard.risk_notes_v2,
    risk_factors_v2: riskV2ForGuard.risk_factors_v2,
    breakout_confirmation_status: breakoutConfirmation.breakout_confirmation_status,
    breakout_confirmation_label: breakoutConfirmation.breakout_confirmation_label,
    breakout_confirmation_note: breakoutConfirmation.breakout_confirmation_note,
    false_breakout_risk: breakoutConfirmation.false_breakout_risk,
    setup_age_minutes: setupFreshness.setup_age_minutes,
    setup_age_hours: setupFreshness.setup_age_hours,
    setup_freshness_status: setupFreshness.setup_freshness_status,
    setup_freshness_label: setupFreshness.setup_freshness_label,
    setup_expiry_note: setupFreshness.setup_expiry_note,
    // V5: Candle pattern confirmation (computed, not DB column)
    candle_pattern: candleResult ? candleResult.pattern : null,
    candle_bias: candleResult ? candleResult.bias : null,
    candle_score: candleScore,
    // V6: Tick normalization metadata
    tick_normalized: levels.tick_normalized || false,
    tick_notes: levels.tick_notes || null,
    ara_price: executionReality.ara_price,
    arb_price: executionReality.arb_price,
    ara_pct: executionReality.ara_pct,
    arb_pct: executionReality.arb_pct,
    ara_room_pct: executionReality.ara_room_pct,
    arb_room_pct: executionReality.arb_room_pct,
    ara_band_label: executionReality.ara_band_label,
    ara_arb_source: executionReality.ara_arb_source,
    ara_arb_note: executionReality.ara_arb_note,
    near_ara: executionReality.near_ara,
    near_arb: executionReality.near_arb,
    ara_hit: executionReality.ara_hit,
    arb_hit: executionReality.arb_hit,
    entry_near_ara: executionReality.entry_near_ara,
    trigger_near_ara: executionReality.trigger_near_ara,
    execution_reality_status: executionReality.execution_reality_status,
    execution_reality_label: executionReality.execution_reality_label,
    execution_reality_note: executionReality.execution_reality_note,
    buy_execution_realistic: executionReality.buy_execution_realistic,
    sell_risk_near_arb: executionReality.sell_risk_near_arb,
    tp1_beyond_ara: executionReality.tp1_beyond_ara,
    tp2_beyond_ara: executionReality.tp2_beyond_ara,
    sl_below_arb: executionReality.sl_below_arb,
    intraday_realistic_cap: executionReality.intraday_realistic_cap,
    tp1_intraday_realistic: executionReality.tp1_intraday_realistic,
    tp2_intraday_realistic: executionReality.tp2_intraday_realistic,
    candle_potential_low: executionReality.candle_potential_low,
    candle_potential_high: executionReality.candle_potential_high,
    candle_potential_label: executionReality.candle_potential_label,
    candle_potential_note: executionReality.candle_potential_note,
    entry_basis_note: executionReality.entry_basis_note,
    tp_realism_note: executionReality.tp_realism_note
  }, evaluationInitial ? { daytrade_evaluation_initial: evaluationInitial } : {}, signalVerdict);
}

// ============================================================
// UNIVERSE BUILDER
// ============================================================

function normalizeUniverseTicker(value) {
  var ticker = String(value || '').trim().toUpperCase().replace(/\.JK$/, '');
  return /^[A-Z0-9]{2,12}$/.test(ticker) ? ticker : '';
}

var DAYTRADE_ALLOWED_BOARDS = ['UTAMA', 'PENGEMBANGAN'];
var DAYTRADE_RESTRICTED_MARKERS = /fca|full\s*call\s*auction|call\s*auction|pemantauan\s*khusus|suspend|suspended|special\s*watch|problem\s*board|watchlist\s*board/i;

function dayTradeEligibilityReason(row, options) {
  row = row || {}; options = options || {};
  var board = String(row.board || '').trim().toUpperCase();
  var text = [row.board, row.board_status, row.market_status, row.status, row.watchlist_status, row.notes].join(' ');
  var price = Number(row.latest_price || row.last_price || row.current_price || row.close || row.price);
  var guard = String(row.corporate_action_guard || '').toUpperCase();
  var listing = String(row.listing_status || '').toUpperCase();
  if (DAYTRADE_RESTRICTED_MARKERS.test(text)) return 'restricted_board_or_status';
  if (guard === 'BLOCKED' || /stale|needs_revalidation/.test(guard.toLowerCase())) return 'corporate_action_guard';
  if (listing === 'HISTORY_INSUFFICIENT') return 'history_insufficient';
  if (!DAYTRADE_ALLOWED_BOARDS.includes(board)) return 'invalid_or_unknown_board';
  // A new listing is not itself a Day Trade restriction.  It can only enter
  // through the authoritative board master, where UTAMA/PENGEMBANGAN has
  // already been validated.  Foreign-only discovery rows have no board and
  // therefore fail the strict board gate above.
  // Price data is required when a source supplied it. Board-master rows may not
  // carry quotes; their current price is validated by the candle scan itself.
  if (options.requirePrice && !(price > 0)) return 'missing_latest_price';
  if (price > 0 && price < 50) return 'price_below_50';
  if (row.price_stale === true || String(row.price_freshness || '').toLowerCase() === 'stale') return 'stale_price';
  if (price >= 50 && options.requireLiquidity && !(Number(row.value || row.valuasi || row.value_today) > 0 && Number(row.frequency || row.freq || row.frequency_today) > 0)) return 'liquidity_unverified';
  return null;
}

function filterDayTradeUniverse(rows, options) {
  var excludedByReason = {}; var excluded = []; var eligible = [];
  (rows || []).forEach(function(row) {
    var reason = dayTradeEligibilityReason(row, options);
    if (reason) { excludedByReason[reason] = (excludedByReason[reason] || 0) + 1; excluded.push({ ticker: row.ticker, reason: reason, board: row.board || null, listing_status: row.listing_status || null }); }
    else eligible.push(row);
  });
  var includedNewListings = eligible.filter(function(row) { return String(row.listing_status || '').toUpperCase() === 'NEW_LISTING'; });
  var unknownNewListings = excluded.filter(function(row) {
    var board = String(row.board || '').trim().toUpperCase();
    return row.reason === 'invalid_or_unknown_board' && String(row.listing_status || '').toUpperCase() === 'NEW_LISTING' && board !== 'AKSELERASI' && board !== 'EKONOMI BARU';
  });
  return { tickers: eligible, diagnostics: {
    raw_universe_count: (rows || []).length,
    eligible_universe_count: eligible.length,
    excluded_count: excluded.length,
    excluded_by_reason: excludedByReason,
    board_validated_new_listing_count: includedNewListings.length,
    unknown_board_new_listing_excluded_count: unknownNewListings.length,
    excluded_akselerasi_count: excluded.filter(function(row) { return String(row.board || '').toUpperCase() === 'AKSELERASI'; }).length,
    excluded_ekonomi_baru_count: excluded.filter(function(row) { return String(row.board || '').toUpperCase() === 'EKONOMI BARU'; }).length,
    sample_included_new_listings: includedNewListings.slice(0, 20).map(function(row) { return { ticker: row.ticker, board: row.board || null }; }),
    sample_excluded: excluded.slice(0, 20)
  } };
}

async function fetchForeignUniverseTickers(supabase, knownTickers) {
  var known = knownTickers || {};
  try {
    var res = await supabase.from('foreign_watchlist_daily').select('ticker,trade_date,uploaded_at,close,volume,freq,valuasi').order('trade_date', { ascending: false }).order('uploaded_at', { ascending: false }).limit(5000);
    if (res.error) return { tickers: [], diagnostics: { foreign_universe_error: res.error.message } };
    var seen = {}; var tickers = [];
    (res.data || []).forEach(function(row) {
      var ticker = normalizeUniverseTicker(row && row.ticker);
      if (!ticker || known[ticker] || seen[ticker]) return;
      seen[ticker] = true;
      // Foreign-only names are discovery data, not strict Day Trade candidates.
      tickers.push({ ticker: ticker, board: null, close: row.close, volume: row.volume, freq: row.freq, valuasi: row.valuasi, universe_source: 'foreign_latest', listing_status: 'NEW_LISTING' });
    });
    return { tickers: tickers, diagnostics: { foreign_universe_discovered_count: tickers.length } };
  } catch (e) { return { tickers: [], diagnostics: { foreign_universe_error: e.message || String(e) } }; }
}

async function buildDayTradeUniverse(supabase) {
  var result = await supabase.from('stock_boards').select('ticker,board').in('board', DAYTRADE_ALLOWED_BOARDS);
  var boardStocks = result.data; var boardErr = result.error;
  if (boardErr || !boardStocks || boardStocks.length === 0) return { tickers: [], error: boardErr ? boardErr.message : 'No stocks in stock_boards' };
  var universe = boardStocks.map(function(s) { return { ticker: s.ticker, board: s.board, universe_source: 'stock_boards' }; });
  var known = {}; universe.forEach(function(item) { known[item.ticker] = true; });
  var foreign = await fetchForeignUniverseTickers(supabase, known);
  var filtered = filterDayTradeUniverse(universe.concat(foreign.tickers));
  filtered.diagnostics.stock_boards_allowed_count = boardStocks.length;
  filtered.diagnostics.foreign_discovered_count = foreign.diagnostics.foreign_universe_discovered_count || 0;
  filtered.diagnostics.foreign_universe_discovered_count = foreign.diagnostics.foreign_universe_discovered_count || 0;
  if (foreign.diagnostics.foreign_universe_error) filtered.diagnostics.foreign_universe_error = foreign.diagnostics.foreign_universe_error;
  return { tickers: filtered.tickers, error: null, diagnostics: filtered.diagnostics };
}

// ============================================================
// FAST UNIVERSE BUILDER — top ~150 liquid/active tickers
// Deterministic shortlist: high liquidity, high market cap,
// known active names from Papan Utama/Pengembangan only.
// ============================================================

var FAST_UNIVERSE_TICKERS = [
  'BBCA','BBRI','BMRI','TLKM','ASII','UNVR','BBNI','GOTO','BRIS','AMMN',
  'ADRO','BRPT','INDF','ICBP','MDKA','PGAS','ANTM','INCO','PTBA','SMGR',
  'KLBF','EMTK','TOWR','EXCL','ISAT','MAPI','AKRA','ACES','ARTO','BUKA',
  'INKP','TKIM','CPIN','JPFA','MYOR','UNTR','HRUM','TPIA','ESSA','BSDE',
  'SMRA','CTRA','PWON','ERAA','LSIP','INTP','HMSP','GGRM','AMRT','MNCN',
  'HEAL','ITMG','MEDC','PGEO','MBMA','NICL','AADI','BREN','DSSA','SRTG',
  'TAPG','TOBA','BUMI','ENRG','TINS','ELSA','RAJA','WIFI','SCMA','TBIG',
  'MTEL','JSMR','WIKA','WSKT','PTPP','ADHI','META','BMTR','LINK','MTDL',
  'PNBN','NISP','BDMN','BJTM','BTPS','BBTN','BBYB','BNGA','MEGA','BNLI',
  'AGRO','DNET','DCII','SIDO','KAEF','MIKA','SILO','PNLF','LPKR','DILD',
  'APLN','KIJA','MKPI','JRPT','BEST','PANI','AUTO','SMSM','IMAS','GJTL',
  'BIRD','GIAA','CMRY','ULTJ','GOOD','ROTI','ADES','STTP','TSPC','WOOD',
  'IMPC','PBID','ARNA','TOTO','FILM','NELY','MSIN','PRDA','SAME','DVLA',
  'PYFA','CLEO','HOKI','KINO','LPPF','MDIA','SOCI','SSMS','DSNG','NCKL',
  'CPRO','MLPL','CARS','BHIT','MAYA','SIMP','APII','ASSA','BSSR','FAST'
];

async function buildFastDayTradeUniverse(supabase) {
  // Use curated liquid shortlist intersected with stock_boards
  // to ensure only valid Utama/Pengembangan tickers are included
  var { data: boardStocks, error: boardErr } = await supabase
    .from('stock_boards')
    .select('ticker, board')
    .in('board', ['UTAMA', 'PENGEMBANGAN']);

  if (boardErr || !boardStocks || boardStocks.length === 0) {
    return { tickers: [], error: boardErr ? boardErr.message : 'No stocks in stock_boards for fast mode' };
  }

  // Build lookup of valid board tickers
  var boardSet = {};
  boardStocks.forEach(function(s) {
    if (s.board !== 'AKSELERASI') boardSet[s.ticker] = s.board;
  });

  // Filter fast list to only those in valid boards
  var fastUniverse = [];
  for (var i = 0; i < FAST_UNIVERSE_TICKERS.length; i++) {
    var t = FAST_UNIVERSE_TICKERS[i];
    if (boardSet[t]) {
      fastUniverse.push({ ticker: t, board: boardSet[t] });
    }
  }

  // Also add sector_hot_group_members not already included (known active konglo stocks)
  try {
    var { data: hotMembers } = await supabase
      .from('sector_hot_group_members')
      .select('ticker')
      .eq('is_active', true);
    if (hotMembers) {
      var seen = {};
      fastUniverse.forEach(function(u) { seen[u.ticker] = true; });
      hotMembers.forEach(function(m) {
        if (!seen[m.ticker] && boardSet[m.ticker]) {
          fastUniverse.push({ ticker: m.ticker, board: boardSet[m.ticker] });
          seen[m.ticker] = true;
        }
      });
    }
  } catch (e) { /* non-critical */ }

  var known = {};
  fastUniverse.forEach(function(item) { known[item.ticker] = true; });
  var foreign = await fetchForeignUniverseTickers(supabase, known);
  var filtered = filterDayTradeUniverse(fastUniverse.concat(foreign.tickers));
  filtered.diagnostics.stock_boards_allowed_count = boardStocks.length;
  filtered.diagnostics.foreign_discovered_count = foreign.diagnostics.foreign_universe_discovered_count || 0;
  filtered.diagnostics.foreign_universe_discovered_count = foreign.diagnostics.foreign_universe_discovered_count || 0;
  if (foreign.diagnostics.foreign_universe_error) filtered.diagnostics.foreign_universe_error = foreign.diagnostics.foreign_universe_error;
  return { tickers: filtered.tickers, error: null, diagnostics: filtered.diagnostics };
}

// ============================================================
// BATCH RUNNER — processes a slice of tickers
// ============================================================

async function runDayTradeBatch(tickers, runMode, options) {
  var results = [];
  var failed = [];
  options = options || {};
  var isFast = (options && options.fastMode);
  var fetchCandles = options.fetchCandles || fetchDayTradeCandles;
  var baseDelay = isFast ? 180 : 200;
  var currentDelay = baseDelay;
  var consecutiveErrors = 0;
  var MAX_DELAY = 2000;

  for (var i = 0; i < tickers.length; i++) {
    var item = tickers[i];
    try {
      var candles = await fetchCandles(item.ticker, item);
      if (!candles || candles.length < 20) {
        failed.push({ ticker: item.ticker, reason: !candles ? 'no_data' : 'insufficient_candles_' + (candles ? candles.length : 0), universe_source: item.universe_source || 'stock_boards', listing_status: item.universe_source === 'foreign_latest' ? 'HISTORY_INSUFFICIENT' : null, konglo_classification: item.konglo_classification || null });
        // Adaptive backoff: if fetch returned null (possible rate limit), slow down
        if (!candles) {
          consecutiveErrors++;
          if (consecutiveErrors >= 3) {
            currentDelay = Math.min(currentDelay + 200, MAX_DELAY);
          }
        }
        continue;
      }

      // Success: gradually restore speed (but never below base)
      consecutiveErrors = 0;
      if (currentDelay > baseDelay) {
        currentDelay = Math.max(baseDelay, currentDelay - 50);
      }

      var analysis = analyzeDayTrade(candles, item.ticker);
      if (!analysis || !analysis.last_price) {
        failed.push({ ticker: item.ticker, reason: 'analysis_failed' });
        continue;
      }

      // Candle Pattern Detection (V1 confirmation layer)
      var candleCtx = {
        volumeAvg20: analysis.avg_volume_20d || null,
        support: analysis.support || null,
        resistance: analysis.resistance || null,
        ma20: analysis.ma20 || null,
        rsi14: analysis.rsi14 || null,
        changePct: analysis.change_pct || 0,
        lastPrice: analysis.last_price || null
      };
      var candleResult = candleEngine.detectPattern(candles.slice(-3), candleCtx);

      var scored = scoreDayTrade(analysis, runMode, item.board, candleResult, { captureEvaluationInitial: options.captureEvaluationInitial === true });
      scored.board = item.board;
      scored.stock_name = item.stock_name || item.ticker;
      scored.data_quality_status = analysis.data_quality_status;
      scored.data_quality_label = analysis.data_quality_label;
      scored.data_quality_note = analysis.data_quality_note;
      scored.data_quality_valid = analysis.data_quality_valid;
      scored.data_quality_needs_revalidation = analysis.data_quality_needs_revalidation;
      if (analysis.data_quality_valid === false) {
        scored.status = 'EARLY_RADAR';
        scored.setup = analysis.data_quality_label || 'Perlu validasi ulang';
        scored.entry_timing = 'Data perlu validasi ulang — bukan sinyal publik';
      }

      // Respect Zone: detect and refine levels
      var rzResult = detectRespectZones(candles);
      var majorCtx = detectMajorRespectZoneContext(candles, analysis.last_price);
      var hcdResult = detectHalfCandleDebt(candles, analysis.last_price);
      if (rzResult.notes && rzResult.notes.length > 0) {
        scored.respect_zone_notes = rzResult.notes.join('; ');
      }
      if (majorCtx && majorCtx.major_respect_zone_notes) {
        scored.major_respect_zone_notes = majorCtx.major_respect_zone_notes;
        scored.major_demand_level = majorCtx.major_demand_level;
        scored.major_supply_level = majorCtx.major_supply_level;
        scored.major_zone_window = majorCtx.major_zone_window;
        scored.volume_profile_poc = majorCtx.volume_profile_poc;
        scored.volume_profile_note = majorCtx.volume_profile_note;
        scored.respect_zone_notes = [scored.respect_zone_notes, majorCtx.major_respect_zone_notes].filter(Boolean).join('; ');
      }
      if (hcdResult) {
        scored.half_candle_level = hcdResult.half_candle_level;
        scored.half_candle_label = hcdResult.label;
        scored.half_candle_note = hcdResult.note;
        scored.half_candle_chase_risk = hcdResult.chase_risk;
        scored.half_candle_distance_pct = hcdResult.distance_to_half_pct;
        scored.respect_zone_notes = [scored.respect_zone_notes, hcdResult.label + ': ' + hcdResult.note].filter(Boolean).join('; ');
        if (hcdResult.confidence_delta < 0) {
          if (scored.confidence === 'A+' || scored.confidence === 'A') scored.confidence = 'B';
          else if (scored.confidence === 'B') scored.confidence = 'C';
          if (hcdResult.label === 'Failed respect candle') scored.status = scored.status === 'AVOID' ? scored.status : 'WAIT_PULLBACK';
          scored.entry_timing = hcdResult.chase_risk ? 'Wait for half-candle debt area' : 'Tunggu reclaim 1/2 candle';
          scored.direction = hcdResult.chase_risk ? 'Rawan chase setelah long candle' : 'Confidence turun — respect candle gagal';
        } else if (hcdResult.confidence_delta > 0 && scored.confidence === 'C') {
          scored.entry_timing = 'Entry pullback 1/2 candle — tunggu bounce valid';
        }
      }

      // Refine levels using respect zones (adjusts entry/SL/TP/RR)
      if (scored.entry_low && scored.stop_loss && scored.tp1) {
        var baseLevels = { entry_low: scored.entry_low, entry_high: scored.entry_high, stop_loss: scored.stop_loss, tp1: scored.tp1, tp2: scored.tp2, risk_reward: scored.risk_reward };
        var refined = refineLevelsWithRespectZones(baseLevels, candles, analysis.last_price, 'daytrade');
        if (refined) {
          scored.entry_low = refined.entry_low;
          scored.entry_high = refined.entry_high;
          scored.stop_loss = refined.stop_loss;
          scored.tp1 = refined.tp1;
          scored.tp2 = refined.tp2;
          scored.risk_reward = refined.risk_reward;
          if (refined.refinement_notes) scored.refinement_notes = refined.refinement_notes;
          if (refined.respect_zone_notes) scored.respect_zone_notes = refined.respect_zone_notes;
          scored.respect_quality_score = refined.respect_quality_score;
          scored.respect_quality_label = refined.respect_quality_label;
          scored.respect_quality_factors = refined.respect_quality_factors;
          scored.respect_invalid_reason = refined.respect_invalid_reason;
          scored.bearish_respect_warning = refined.bearish_respect_warning;
        }
      }

      // === V6: FINAL IDX TICK NORMALIZATION (after respect zone refinement) ===
      var finalTickResult = idxTick.normalizeLevelsToIdxTicks(
        { entry_low: scored.entry_low, entry_high: scored.entry_high, stop_loss: scored.stop_loss, tp1: scored.tp1, tp2: scored.tp2, risk_reward: scored.risk_reward },
        { mode: 'daytrade' }
      );
      if (finalTickResult.tick_normalized) {
        scored.entry_low = finalTickResult.entry_low;
        scored.entry_high = finalTickResult.entry_high;
        scored.stop_loss = finalTickResult.stop_loss;
        scored.tp1 = finalTickResult.tp1;
        scored.tp2 = finalTickResult.tp2;
        scored.risk_reward = finalTickResult.risk_reward;
      }
      scored.tick_normalized = finalTickResult.tick_normalized;
      scored.tick_notes = finalTickResult.tick_notes;

      atrHelpers.attachAtrWarningMetadata(scored, candles);
      var atrPenalty = atrHelpers.deriveAtrScorePenalty(scored);
      scored.score_before_atr_penalty = scored.daytrade_score;
      scored.atr_score_penalty = atrPenalty.atr_score_penalty;
      scored.atr_penalty_reasons = atrPenalty.atr_penalty_reasons;
      scored.atr_risk_adjustment = atrPenalty.atr_risk_adjustment;
      if (atrPenalty.atr_score_penalty) {
        scored.daytrade_score = Math.max(0, Math.min(100, scored.daytrade_score + atrPenalty.atr_score_penalty));
      }

      // Optional precomputed intraday adjustment provider for local/VPS observe flows.
      // No 15m fetch happens here; fields are only attached from options.intradayAdjustmentByTicker.
      if (options.intradayAdjustmentByTicker) {
        scored = intradayAdjustmentProvider.attachIntradayAdjustmentFields(scored, options.intradayAdjustmentByTicker);
      }

      // Optional Day Trade intraday score adjustment hook.
      // Disabled by default; only applies fields already present on the candidate.
      scored = intradayScoreAdjustment.applyIntradayScoreAdjustment(scored, options);

      // === V6: MULTI-TIMEFRAME CONTEXT (all windows) ===
      var mtfCtx = idxTick.deriveMultiTimeframeContext(candles);
      scored.tf_1d_context = mtfCtx.tf_1d_context;
      scored.tf_2d_context = mtfCtx.tf_2d_context;
      scored.tf_3d_context = mtfCtx.tf_3d_context;
      scored.tf_5d_context = mtfCtx.tf_5d_context;
      scored.tf_10d_context = mtfCtx.tf_10d_context;
      scored.tf_20d_context = mtfCtx.tf_20d_context;
      scored.daily_candle_context = mtfCtx.tf_1d_context;
      scored.weekly_candle_context = mtfCtx.tf_5d_context;
      scored.monthly_candle_context = mtfCtx.tf_20d_context;
      scored.multi_timeframe_bias = mtfCtx.multi_timeframe_bias;
      scored.multi_timeframe_notes = mtfCtx.multi_timeframe_notes;

      // === V6: VOLUME-PRICE ACTION ===
      var lastCandle = candles[candles.length - 1];
      var lcRange = (Number(lastCandle.high) || 0) - (Number(lastCandle.low) || 0);
      var lcClosePos = (lcRange > 0 && Number.isFinite((lastCandle.close - lastCandle.low) / lcRange)) ? (lastCandle.close - lastCandle.low) / lcRange : 0.5;
      var lcBodyRatio = (lcRange > 0 && Number.isFinite(Math.abs(lastCandle.close - lastCandle.open) / lcRange)) ? Math.abs(lastCandle.close - lastCandle.open) / lcRange : 0.5;
      var lcIsGreen = lastCandle.close > lastCandle.open;
      var lcFailedBreakout = scored.candle_pattern === 'Failed breakout candle';
      var lcNearRes = analysis.distance_to_breakout_pct != null && analysis.distance_to_breakout_pct <= 1.5;
      var vpaResult = idxTick.analyzeVolumePriceAction({
        volume_today: analysis.volume_today,
        avg_volume_20d: analysis.avg_volume_20d,
        volume_3d_avg: null,
        volume_7d_avg: null,
        change_pct: analysis.change_pct,
        close_position: lcClosePos,
        body_ratio: lcBodyRatio,
        is_green: lcIsGreen,
        near_resistance: lcNearRes,
        failed_breakout: lcFailedBreakout
      });
      var finalEntryStatus = idxTick.deriveEntryStatus({
        current_price: analysis.last_price,
        last_price: analysis.last_price,
        entry_low: scored.entry_low,
        entry_high: scored.entry_high,
        stop_loss: scored.stop_loss,
        tp1: scored.tp1,
        tp2: scored.tp2
      });
      scored.entry_status = finalEntryStatus.entry_status;
      scored.entry_status_label = finalEntryStatus.entry_status_label;
      scored.entry_status_note = finalEntryStatus.entry_status_note;
      scored.entry_quality_status = finalEntryStatus.entry_quality_status;
      scored.entry_quality_label = finalEntryStatus.entry_quality_label;
      scored.entry_safety_note = finalEntryStatus.entry_safety_note;
      scored.entry_distance_pct = finalEntryStatus.entry_distance_pct;
      scored.chase_risk_label = finalEntryStatus.chase_risk_label;
      Object.assign(scored, idxTick.deriveBreakoutConfirmation({
        current_price: analysis.last_price,
        last_price: analysis.last_price,
        close: analysis.last_price,
        high_price: analysis.high_price,
        resistance: analysis.resistance,
        breakout_trigger: analysis.resistance
      }));
      Object.assign(scored, idxTick.deriveSetupFreshness({
        calculated_at: new Date().toISOString(),
        current_price: analysis.last_price,
        last_price: analysis.last_price,
        entry_low: scored.entry_low,
        entry_high: scored.entry_high,
        stop_loss: scored.stop_loss
      }));
      if (scored.breakout_confirmation_status !== 'BREAKOUT_CONFIRMED' &&
          (scored.status === 'A_PLUS_SETUP' || scored.status === 'TRADE_CANDIDATE' || scored.status === 'READY_BREAKOUT')) {
        scored.status = 'EARLY_RADAR';
        scored.setup = scored.false_breakout_risk ? 'False Breakout Risk' : 'Breakout Watch';
        scored.entry_timing = 'Tunggu close confirmation — belum entry';
      }
      Object.assign(scored, idxTick.deriveInvalidationDistance({
        current_price: analysis.last_price,
        last_price: analysis.last_price,
        stop_loss: scored.stop_loss,
        invalidation: scored.invalidation
      }));
      var finalPlanSanity = idxTick.validateTradingPlanSanity(scored);
      scored.trading_plan_valid = finalPlanSanity.trading_plan_valid;
      scored.trading_plan_status = finalPlanSanity.trading_plan_status;
      scored.trading_plan_note = finalPlanSanity.trading_plan_note;
      if (!finalPlanSanity.trading_plan_valid) {
        scored.status = 'WAIT_PULLBACK';
        scored.setup = 'Wait / Level belum rapi';
        scored.entry_timing = 'Wait — level belum rapi';
        scored.plan_quality_status = 'INVALID';
        scored.plan_quality_label = 'Wait / Level belum rapi';
        scored.plan_quality_note = finalPlanSanity.trading_plan_note;
      }

      scored.volume_signal = vpaResult.volume_signal;
      scored.volume_phase = vpaResult.volume_phase;
      scored.volume_notes = vpaResult.volume_notes;

      // === V6: RISK LABEL ===
      var chaseDistPct = (scored.entry_high > 0 && Number.isFinite((analysis.last_price - scored.entry_high) / scored.entry_high)) ? ((analysis.last_price - scored.entry_high) / scored.entry_high) * 100 : 0;
      if (!Number.isFinite(chaseDistPct)) chaseDistPct = 0;
      var riskResult = idxTick.calculateRiskLabel({
        risk_reward: scored.risk_reward,
        mode: 'daytrade',
        weekly_bias: mtfCtx._weekly ? mtfCtx._weekly.bias : null,
        monthly_bias: mtfCtx._monthly ? mtfCtx._monthly.bias : null,
        monthly_downtrend: mtfCtx._monthly ? mtfCtx._monthly.downtrend : false,
        volume_phase: vpaResult.volume_phase,
        chase_distance_pct: Math.max(0, chaseDistPct),
        supply_nearby: lcNearRes,
        volume_ratio_20d: analysis.volume_ratio_20d,
        board: item.board,
        candle_failed_breakout: lcFailedBreakout,
        rsi14: analysis.rsi14,
        multi_timeframe_bias: mtfCtx.multi_timeframe_bias
      });
      scored.risk_label = riskResult.risk_label;
      scored.risk_score = riskResult.risk_score;
      scored.risk_notes = riskResult.risk_notes ? riskResult.risk_notes.join('; ') : null;
      var riskV2Result = idxTick.deriveRiskLabelV2(scored);
      scored.risk_label_v2 = riskV2Result.risk_label_v2;
      scored.risk_score_v2 = riskV2Result.risk_score_v2;
      scored.risk_notes_v2 = riskV2Result.risk_notes_v2;
      scored.risk_factors_v2 = riskV2Result.risk_factors_v2;
      idxTick.applyRiskV2ConfidenceGuard(scored);

      // === V6: ABC QUALITY GRADE ===
      var gradeResult = idxTick.calculateQualityGrade({
        risk_reward: scored.risk_reward,
        risk_label: riskResult.risk_label,
        volume_phase: vpaResult.volume_phase,
        multi_timeframe_bias: mtfCtx.multi_timeframe_bias,
        tick_normalized: finalTickResult.tick_normalized,
        chase_distance_pct: Math.max(0, chaseDistPct),
        volume_ratio_20d: analysis.volume_ratio_20d,
        mode: 'daytrade'
      });
      scored.quality_grade = gradeResult.grade;
      scored.grade_reason = gradeResult.grade_reason;

      // Potensi BSJP detection (Day Trade only, strict criteria)
      scored.bsjp_label = detectBsjpPotential(scored, analysis);

      // Preserve the analyzer's structural context as runtime-only fields so the
      // Trade Plan V2 adapter AND future intraday sample capture receive the real
      // confirmed swing low / ATR / next resistance the analyzer already computed
      // (scoreDayTrade drops these). They are NOT in the explicit DB column
      // mappers, so they are never persisted and base scoring is untouched.
      if (scored.atr14 == null && analysis.atr14 != null) scored.atr14 = analysis.atr14;
      if (scored.swing_low == null && analysis.swingLow5 != null) scored.swing_low = analysis.swingLow5;
      if (scored.swing_high == null && analysis.swingHigh10 != null) scored.swing_high = analysis.swingHigh10;

      // Trade Plan V2 SHADOW attach (gated by TRADE_PLAN_V2_SHADOW_ENABLED; a
      // pure no-op when the flag is off, so scored/persisted output is unchanged).
      // Passes the REAL analyzer + candle context (source) so the canonical engine
      // receives actual market structure (support / swing low / ATR / OHLC) instead
      // of the flattened row — fixing NO_STRUCTURAL_LEVEL.
      tradePlanV2Integration.attachShadowTradePlanV2(scored, {
        screener_type: 'DAY_TRADE',
        env: (typeof process !== 'undefined' ? process.env : undefined),
        source: { analysis: analysis, scored: scored, candles: candles }
      });

      results.push(scored);
    } catch (e) {
      failed.push({ ticker: item.ticker, reason: 'exception: ' + (e.message || 'unknown').substring(0, 60) });
      // Adaptive backoff on exception (possible 429 / network issue)
      consecutiveErrors++;
      if (consecutiveErrors >= 2) {
        currentDelay = Math.min(currentDelay + 300, MAX_DELAY);
      }
    }

    // Rate limit: adaptive delay between requests (fast=180ms base, full=200ms base, increases on errors)
    if (!options.noDelay && i < tickers.length - 1) {
      await delay(currentDelay);
    }
  }

  return { results: results, failed: failed };
}

// ============================================================
// HELPERS
// ============================================================

function calcMA(arr, period) {
  if (!arr || arr.length < period || !period || period <= 0) return null;
  var slice = arr.slice(arr.length - period);
  var sum = 0;
  for (var i = 0; i < slice.length; i++) {
    var val = Number(slice[i]);
    if (Number.isFinite(val)) sum += val;
  }
  var ma = sum / period;
  return Number.isFinite(ma) ? ma : null;
}

function calcRSI(closes, period) {
  if (!closes || closes.length < period + 1 || !period || period <= 0) return null;
  var gains = 0, losses = 0;
  for (var i = closes.length - period; i < closes.length; i++) {
    var c1 = Number(closes[i]);
    var c0 = Number(closes[i - 1]);
    if (Number.isFinite(c1) && Number.isFinite(c0)) {
      var diff = c1 - c0;
      if (diff > 0) gains += diff;
      else losses -= diff;
    }
  }
  var avgGain = gains / period;
  var avgLoss = losses / period;
  if (!Number.isFinite(avgGain) || !Number.isFinite(avgLoss)) return null;
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  var rs = avgGain / avgLoss;
  if (!Number.isFinite(rs)) return 100;
  var rsi = 100 - (100 / (1 + rs));
  return Number.isFinite(rsi) ? rsi : null;
}

function round2(val) {
  var n = Number(val);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function round0(val) {
  var n = Number(val);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function delay(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }


function getRecentAverageRange(candles, endIdx, lookback) {
  if (!candles || !candles.length) return null;
  var start = Math.max(0, endIdx - lookback);
  var sum = 0;
  var count = 0;
  for (var i = start; i < endIdx; i++) {
    if (candles[i]) {
      var r = (Number(candles[i].high) || 0) - (Number(candles[i].low) || 0);
      if (r > 0 && Number.isFinite(r)) { sum += r; count++; }
    }
  }
  return (count > 0 && Number.isFinite(sum / count)) ? (sum / count) : null;
}

function detectHalfCandleDebt(candles, lastPrice) {
  if (!candles || candles.length < 8) return null;
  var len = candles.length;
  var latest = candles[len - 1];
  var best = null;
  var from = Math.max(5, len - 6);
  var lastImpulseIdx = len - 2; // latest candle is reserved for validation/pullback confirmation

  for (var i = from; i <= lastImpulseIdx; i++) {
    var c = candles[i];
    var range = (Number(c.high) || 0) - (Number(c.low) || 0);
    var body = (Number(c.close) || 0) - (Number(c.open) || 0);
    if (range <= 0 || body <= 0) continue;
    var avgRange = getRecentAverageRange(candles, i, 10);
    if (!avgRange || avgRange <= 0 || !Number.isFinite(avgRange)) continue;
    var rangeRatio = range / avgRange;
    var bodyRatio = body / range;
    if (!Number.isFinite(rangeRatio) || !Number.isFinite(bodyRatio)) continue;
    if (bodyRatio < 0.58 || rangeRatio < 1.45) continue;

    var rawHalf = (Number(c.low) || 0) + (range * 0.5);
    var half = idxTick.roundToIdxTick(rawHalf, 'nearest');
    if (!half || !idxTick.getIdxTickSize(half)) continue;
    var priceToCompare = Number(lastPrice || latest.close || c.close) || 0;
    var distPct = (half > 0 && Number.isFinite((priceToCompare - half) / half)) ? round2((priceToCompare - half) / half * 100) : 0;
    var lowRounded = idxTick.roundToIdxTick(c.low, 'down') || round0(c.low);
    var highRounded = idxTick.roundToIdxTick(c.high, 'up') || round0(c.high);
    var nearHalf = Math.abs(distPct) <= 1.5;
    var brokeHalf = (latest.low < half && latest.close < half);
    var recoveredHalf = (latest.low <= half * 1.01 && latest.close >= half);
    var invalid = latest.close < lowRounded || latest.low < lowRounded;
    var label = 'Entry pullback 1/2 candle';
    var note = 'Half-candle debt area ' + half + ' dari impulse bullish ' + lowRounded + '-' + highRounded + '.';
    var confidence_delta = 0;
    var chaseRisk = false;

    if (invalid) {
      label = 'Failed respect candle';
      note += ' Break di bawah low impulse — setup invalid/high risk.';
      confidence_delta = -12;
    } else if (brokeHalf) {
      label = 'Failed respect candle';
      note += ' Close masih di bawah 1/2 candle — confidence turun.';
      confidence_delta = -7;
    } else if (recoveredHalf || nearHalf) {
      label = 'Pullback-to-midpoint candle';
      note += ' Price tap area 1/2 candle dan close/recover di atasnya — konfirmasi lebih baik.';
      confidence_delta = 5;
    } else if (distPct > 3.0) {
      label = 'Chase candle / extended candle';
      note += ' Chase risk: price has not paid 1/2 candle yet; tunggu half-candle debt area.';
      confidence_delta = -5;
      chaseRisk = true;
    } else {
      note += ' Wait for half-candle debt area sebelum entry agresif.';
    }

    var candidate = {
      pattern: 'Long bullish impulse candle',
      label: label,
      half_candle_level: half,
      impulse_low: lowRounded,
      impulse_high: highRounded,
      impulse_body_ratio: round2(bodyRatio),
      impulse_range_ratio: round2(rangeRatio),
      distance_to_half_pct: distPct,
      chase_risk: chaseRisk,
      confidence_delta: confidence_delta,
      note: note
    };
    if (!best || candidate.impulse_range_ratio > best.impulse_range_ratio) best = candidate;
  }
  return best;
}

// ============================================================
// RESPECT ZONE DETECTION (multi-window candle + volume analysis)
// Returns notes only - does NOT change Entry/SL/TP/RR.
// ============================================================

function detectRespectZones(candles) {
  if (!candles || candles.length < 5) return { notes: [] };
  var notes = [];
  var len = candles.length;
  var latest = candles[len - 1];
  var recentAvgRange = getRecentAverageRange(candles, len - 1, Math.min(10, len - 1));

  // Sharper respect-candle patterns: midpoint/base/reclaim/wick behavior.
  for (var rc = Math.max(0, len - 8); rc < len - 1; rc++) {
    var base = candles[rc];
    var bRange = (base.high || 0) - (base.low || 0);
    var bBody = (base.close || 0) - (base.open || 0);
    if (bRange <= 0 || bBody <= 0) continue;
    var bBodyRatio = bBody / bRange;
    var bMid = idxTick.roundToIdxTick(base.low + bRange * 0.5, 'nearest') || round0(base.low + bRange * 0.5);
    var isStrong = bBodyRatio >= 0.55;
    var isBreakout = recentAvgRange && bRange >= recentAvgRange * 1.35 && base.close >= base.low + bRange * 0.7;
    var tappedMid = latest.low <= bMid * 1.01 && latest.high >= bMid * 0.99;
    var heldMid = tappedMid && latest.close >= bMid;
    var brokeMidWeak = latest.close < bMid && latest.close < latest.open;
    var heldBase = latest.low <= base.low * 1.015 && latest.close > base.low;
    var wickReject = latest.low <= Math.min(bMid, base.low * 1.015) && latest.close > bMid && latest.close > latest.open;
    if (isStrong && heldMid) notes.push('Pullback-to-midpoint candle: previous strong bullish candle midpoint ' + bMid + ' di-respect');
    if (isStrong && brokeMidWeak) notes.push('Failed respect candle: close lemah di bawah midpoint candle ' + bMid);
    if (isBreakout && latest.low <= base.open * 1.02 && latest.close >= base.open) notes.push('Breakout candle base retest: base ' + Math.round(base.open) + ' masih hold');
    if (heldBase) notes.push('Demand reaction candle: demand low/high area ' + Math.round(base.low) + '-' + Math.round(base.high) + ' di-respect');
    if (wickReject) notes.push('Wick rejection candle: tap zone lalu close balik di atas midpoint ' + bMid);
  }
  if (len >= 2) {
    var prev = candles[len - 2];
    if (latest.open < prev.close && latest.close > prev.close && latest.close > latest.open) {
      notes.push('Reclaim candle: price reclaim level ' + Math.round(prev.close));
    }
  }

  // Analyze multiple windows (1D, 2D, 3D, 4-7D, 10D, 20D/1M)
  var windows = [
    { name: '1D', size: 1 },
    { name: '2D', size: 2 },
    { name: '3D', size: 3 },
    { name: '5D', size: 5 },
    { name: '7D', size: 7 },
    { name: '10D', size: 10 },
    { name: '20D', size: Math.min(20, len) }
  ];

  for (var w = 0; w < windows.length; w++) {
    var win = windows[w];
    if (len < win.size) continue;
    var slice = candles.slice(len - win.size);

    // --- Demand/support zone ---
    var lows = slice.map(function(c) { return c.low; });
    var minLow = Math.min.apply(null, lows);
    var tolerance = minLow * 0.015;
    var touchCount = 0;
    var closeHolds = 0;
    for (var i = 0; i < slice.length; i++) {
      if (slice[i].low <= minLow + tolerance) {
        touchCount++;
        if (slice[i].close > minLow + tolerance) closeHolds++;
      }
    }
    if (touchCount >= 2 && closeHolds >= 1 && win.size >= 5) {
      notes.push('Demand zone ' + win.name + ' (' + Math.round(minLow) + ') di-respect ' + touchCount + 'x, close hold ' + closeHolds + 'x');
    }

    // --- 1D/2D candle context ---
    if (win.size <= 2) {
      var c = slice[slice.length - 1];
      var cRange = c.high - c.low;
      var cBody = Math.abs(c.close - c.open);
      var isGreen = c.close > c.open;
      if (cRange > 0 && cBody / cRange > 0.6 && isGreen && c.volume > 0) {
        notes.push(win.name + ': Bullish candle, body kuat');
      } else if (cRange > 0 && cBody / cRange > 0.6 && !isGreen) {
        notes.push(win.name + ': Bearish candle, tekanan jual');
      } else if (cRange > 0 && cBody / cRange < 0.3) {
        notes.push(win.name + ': Narrow range/doji, pasar belum putuskan arah');
      }
    }

    // --- Supply/resistance zone ---
    var highs = slice.map(function(c) { return c.high; });
    var maxHigh = Math.max.apply(null, highs);
    var resTol = maxHigh * 0.015;
    var rejectCount = 0;
    var failBreak = 0;
    for (var j = 0; j < slice.length; j++) {
      if (slice[j].high >= maxHigh - resTol) {
        rejectCount++;
        if (slice[j].close < maxHigh - resTol) failBreak++;
      }
    }
    if (rejectCount >= 2 && failBreak >= 1 && win.size >= 5) {
      notes.push('Supply zone ' + win.name + ' (' + Math.round(maxHigh) + ') rejected ' + rejectCount + 'x');
    }

    // --- High-volume patterns (only check latest candle in window) ---
    if (win.size <= 5) {
      var avgVol = 0;
      for (var k = 0; k < slice.length; k++) avgVol += slice[k].volume;
      avgVol = avgVol / slice.length;
      var latVol = latest.volume;
      var isRed = latest.close < latest.open;
      var range = latest.high - latest.low;
      var bodyRatio = range > 0 ? Math.abs(latest.close - latest.open) / range : 0;

      if (latVol > avgVol * 1.5 && isRed) {
        var closeNearLow = range > 0 && (latest.close - latest.low) / range < 0.3;
        if (closeNearLow) {
          notes.push('Volume tinggi + red close near low: tekanan supply/distribusi');
        } else {
          notes.push('Volume tinggi + red tapi close recover: possible absorption/support defense');
        }
      }
      if (latVol > avgVol * 1.3 && bodyRatio < 0.3 && win.name === '3D') {
        notes.push('Volume tinggi + narrow range: area partisipasi tinggi, tunggu arah');
      }
    }

    // --- Multi-day volume-price (3D and 5D) ---
    if (win.size >= 3 && win.size <= 5) {
      var last3 = slice.slice(-3);
      if (last3.length === 3) {
        var risingVol = last3[2].volume > last3[1].volume && last3[1].volume > last3[0].volume;
        var risingClose = last3[2].close > last3[1].close && last3[1].close > last3[0].close;
        var fallingClose = last3[2].close < last3[1].close && last3[1].close < last3[0].close;
        var fallingVol = last3[2].volume < last3[1].volume && last3[1].volume < last3[0].volume;

        if (risingVol && risingClose) notes.push('Vol naik + close naik ' + win.name + ': possible accumulation/momentum');
        if (risingVol && fallingClose) notes.push('Vol naik + close turun ' + win.name + ': supply pressure/distribusi');
        if (fallingVol && fallingClose && win.name === '5D') notes.push('Vol turun saat pullback ' + win.name + ': koreksi lebih sehat');
      }
    }
  }

  // Deduplicate similar notes
  var unique = [];
  var seen = {};
  for (var n = 0; n < notes.length; n++) {
    var key = notes[n].substring(0, 30);
    if (!seen[key]) { seen[key] = true; unique.push(notes[n]); }
  }

  return { notes: unique.slice(0, 4) };
}

function detectMajorRespectZoneContext(candles, lastPrice) {
  if (!candles || candles.length < 60) return { notes: [], major_respect_zone_notes: null };
  var len = candles.length;
  var price = Number(lastPrice || (candles[len - 1] && candles[len - 1].close) || 0);
  var windows = [];
  if (len >= 60) windows.push({ name: '60D', size: 60 });
  if (len >= 90) windows.push({ name: '90D', size: 90 });
  var bestDemand = null;
  var bestSupply = null;
  var notes = [];

  function avgVol(slice) {
    var sum = 0, count = 0;
    for (var i = 0; i < slice.length; i++) if (slice[i].volume > 0) { sum += slice[i].volume; count++; }
    return (count && Number.isFinite(sum / count)) ? sum / count : null;
  }
  function pctDist(a, b) { return (b > 0 && Number.isFinite(Math.abs(a - b) / b)) ? Math.abs(a - b) / b * 100 : 99; }
  function betterDemand(a, b) {
    if (!b) return true;
    return (a.quality_score > b.quality_score) || (a.quality_score === b.quality_score && a.window_size > b.window_size);
  }
  function betterSupply(a, b) {
    if (!b) return true;
    return (a.risk_score > b.risk_score) || (a.risk_score === b.risk_score && a.window_size > b.window_size);
  }

  for (var w = 0; w < windows.length; w++) {
    var win = windows[w];
    var slice = candles.slice(len - win.size);
    var av = avgVol(slice);
    var lows = slice.map(function(c) { return c.low; });
    var highs = slice.map(function(c) { return c.high; });
    var minLow = Math.min.apply(null, lows);
    var maxHigh = Math.max.apply(null, highs);
    var demandTol = Math.max(minLow * 0.018, (idxTick.getIdxTickSize(minLow) || 1) * 2);
    var supplyTol = Math.max(maxHigh * 0.018, (idxTick.getIdxTickSize(maxHigh) || 1) * 2);
    var demandTouches = 0, closeHolds = 0, recoveries = 0, recentDemand = false, demandWeakVol = 0;
    var supplyTouches = 0, failedCloses = 0, upperRejects = 0, recentSupply = false, supplyWeakVol = 0;

    for (var i = 0; i < slice.length; i++) {
      var c = slice[i];
      var range = c.high - c.low;
      var lowerWick = Math.min(c.open, c.close) - c.low;
      var upperWick = c.high - Math.max(c.open, c.close);
      var nearDemand = c.low <= minLow + demandTol;
      var nearSupply = c.high >= maxHigh - supplyTol;
      var weakVol = av && c.volume > 0 && c.volume < av * 0.8;
      if (nearDemand) {
        demandTouches++;
        if (c.close >= minLow + demandTol * 0.35) closeHolds++;
        if (range > 0 && lowerWick >= range * 0.28 && c.close >= minLow + demandTol * 0.5) recoveries++;
        if (i >= slice.length - 10) recentDemand = true;
        if (weakVol) demandWeakVol++;
      }
      if (nearSupply) {
        supplyTouches++;
        if (c.close <= maxHigh - supplyTol * 0.35) failedCloses++;
        if (range > 0 && upperWick >= range * 0.28 && c.close <= maxHigh - supplyTol * 0.5) upperRejects++;
        if (i >= slice.length - 10) recentSupply = true;
        if (weakVol) supplyWeakVol++;
      }
    }

    if (demandTouches >= 3 && closeHolds >= 1) {
      var dq = 45 + demandTouches * 6 + closeHolds * 5 + recoveries * 8 + (recentDemand ? 12 : -18) - demandWeakVol * 7;
      var demandValid = recentDemand && demandWeakVol < Math.ceil(demandTouches / 2);
      var d = {
        type: 'demand', window: win.name, window_size: win.size,
        level: idxTick.roundToIdxTick(minLow, 'nearest') || round0(minLow),
        touches: demandTouches, close_holds: closeHolds, recoveries: recoveries,
        fresh_retest: recentDemand, weak_volume_touches: demandWeakVol,
        quality_score: clampRespectScore(dq), valid_context: demandValid
      };
      d.note = 'Major demand ' + d.window + ' ' + d.level + ' respected ' + d.touches + 'x, close hold ' + d.close_holds + 'x' + (d.recoveries ? ', wick recovery ' + d.recoveries + 'x' : '') + (d.fresh_retest ? '' : ' (old/no fresh retest)') + (demandWeakVol ? ', weak volume reduces quality' : '');
      if (betterDemand(d, bestDemand)) bestDemand = d;
    }
    if (supplyTouches >= 3 && failedCloses >= 1) {
      var sq = 45 + supplyTouches * 6 + failedCloses * 5 + upperRejects * 8 + (recentSupply ? 12 : -8) - supplyWeakVol * 3;
      var sObj = {
        type: 'supply', window: win.name, window_size: win.size,
        level: idxTick.roundToIdxTick(maxHigh, 'nearest') || round0(maxHigh),
        touches: supplyTouches, failed_closes: failedCloses, upper_rejections: upperRejects,
        fresh_interaction: recentSupply, weak_volume_touches: supplyWeakVol,
        risk_score: clampRespectScore(sq), active_warning: recentSupply || (price > 0 && pctDist(maxHigh, price) <= 4)
      };
      sObj.note = 'Major supply ' + sObj.window + ' ' + sObj.level + ' rejected ' + sObj.touches + 'x, failed close ' + sObj.failed_closes + 'x' + (sObj.upper_rejections ? ', upper-wick warning ' + sObj.upper_rejections + 'x' : '') + (sObj.fresh_interaction ? '' : ' (old/no fresh interaction)');
      if (betterSupply(sObj, bestSupply)) bestSupply = sObj;
    }
  }

  var profile = detectVolumeProfilePoc(candles, price);
  if (bestDemand) notes.push(bestDemand.note);
  if (bestSupply && bestSupply.active_warning) notes.push(bestSupply.note);
  if (profile && profile.note) notes.push(profile.note);
  return {
    notes: notes.slice(0, 4),
    major_respect_zone_notes: notes.length ? notes.slice(0, 4).join('; ') : null,
    major_demand_level: bestDemand ? bestDemand.level : null,
    major_supply_level: bestSupply ? bestSupply.level : null,
    major_zone_window: bestDemand && bestSupply ? (bestDemand.window_size >= bestSupply.window_size ? bestDemand.window : bestSupply.window) : (bestDemand ? bestDemand.window : (bestSupply ? bestSupply.window : null)),
    major_demand: bestDemand,
    major_supply: bestSupply,
    volume_profile_poc: profile ? profile.volume_profile_poc : null,
    volume_profile_note: profile ? profile.note : null,
    volume_profile_window: profile ? profile.window : null
  };
}

function detectVolumeProfilePoc(candles, lastPrice) {
  if (!candles || candles.length < 60) return null;
  var len = candles.length;
  var winSize = len >= 90 ? 90 : 60;
  var slice = candles.slice(len - winSize);
  var price = Number(lastPrice || (slice[slice.length - 1] && slice[slice.length - 1].close) || 0);
  var buckets = {};
  for (var i = 0; i < slice.length; i++) {
    var c = slice[i];
    var typical = (Number(c.high) + Number(c.low) + Number(c.close)) / 3;
    if (!typical || !isFinite(typical) || !c.volume) continue;
    var tick = idxTick.getIdxTickSize(typical) || 1;
    var bucketSize = Math.max(tick * 5, typical * 0.005);
    if (!bucketSize || !isFinite(bucketSize)) continue;
    var raw = Math.round(typical / bucketSize) * bucketSize;
    var level = idxTick.roundToIdxTick(raw, 'nearest') || round0(raw);
    buckets[level] = (buckets[level] || 0) + Number(c.volume);
  }
  var poc = null, maxVol = 0;
  Object.keys(buckets).forEach(function(k) { if (buckets[k] > maxVol) { maxVol = buckets[k]; poc = Number(k); } });
  if (!poc) return null;
  var dist = (price > 0 && Number.isFinite((price - poc) / price)) ? round2((price - poc) / price * 100) : null;
  var near = dist != null && Math.abs(dist) <= 2.5;
  var note = 'Volume profile PoC ' + winSize + 'D sekitar ' + poc + (near ? ' — price near PoC, area sticky/congested' : ' — high-volume reference only') + (dist != null ? ' (' + dist + '% dari last)' : '') + '. Context only, bukan sinyal beli.';
  return { volume_profile_poc: poc, volume_profile_volume: maxVol, volume_profile_distance_pct: dist, volume_profile_near_price: near, window: winSize + 'D', note: note };
}


function clampRespectScore(n) {
  if (isNaN(n) || n == null || !isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function addRespectFactor(factors, text) {
  if (!text || factors.length >= 4) return;
  if (factors.indexOf(text) === -1) factors.push(text);
}

function classifyRespectVolume(volume, avgVolume) {
  volume = Number(volume);
  avgVolume = Number(avgVolume);
  if (!volume || !avgVolume || volume <= 0 || avgVolume <= 0 || !Number.isFinite(volume) || !Number.isFinite(avgVolume)) {
    return { label: 'unavailable', ratio: null, score: 5, factor: 'Volume neutral/unavailable' };
  }
  var ratio = volume / avgVolume;
  if (!Number.isFinite(ratio)) {
    return { label: 'unavailable', ratio: null, score: 5, factor: 'Volume neutral/unavailable' };
  }
  if (ratio < 1) return { label: 'weak', ratio: round2(ratio), score: 3, factor: 'Volume weak < avg' };
  if (ratio < 1.5) return { label: 'normal', ratio: round2(ratio), score: 8, factor: 'Volume normal ' + round2(ratio) + 'x' };
  if (ratio < 2) return { label: 'strong', ratio: round2(ratio), score: 12, factor: 'Volume strong ' + round2(ratio) + 'x' };
  return { label: 'very strong', ratio: round2(ratio), score: 15, factor: 'Volume very strong ' + round2(ratio) + 'x' };
}

function scoreRespectCandleQuality(candles, levels, context) {
  if (!candles || candles.length < 2) return null;
  levels = levels || {};
  context = context || {};
  var len = candles.length;
  var latest = candles[len - 1];
  var prev = candles[len - 2];
  var o = Number(latest.open) || 0, h = Number(latest.high) || 0, l = Number(latest.low) || 0, c = Number(latest.close) || 0;
  var range = h - l;
  if (range <= 0 || !c || !Number.isFinite(range)) return null;

  var body = Math.abs(c - o);
  var lowerWick = Math.min(o, c) - l;
  var upperWick = h - Math.max(o, c);
  var closePos = Number.isFinite((c - l) / range) ? (c - l) / range : 0.5;
  var factors = [];
  var invalid = [];
  var score = 0;
  var keyLevel = null;
  var keyType = null;
  var lookback = candles.slice(Math.max(0, len - 20));
  var avgVol = 0, avgVolCount = 0;
  for (var av = 0; av < lookback.length - 1; av++) {
    var v = Number(lookback[av].volume);
    if (v > 0 && Number.isFinite(v)) { avgVol += v; avgVolCount++; }
  }
  avgVol = avgVolCount > 0 && Number.isFinite(avgVol / avgVolCount) ? avgVol / avgVolCount : null;

  var demand = [];
  var supply = [];
  function pushLevel(list, type, value) {
    value = Number(value);
    if (value > 0 && Number.isFinite(value)) {
      var dist = Number.isFinite(Math.abs(c - value) / value) ? Math.abs(c - value) / value : 99;
      list.push({ type: type, value: value, dist: dist });
    }
  }
  pushLevel(demand, 'support/demand', levels.support);
  pushLevel(demand, 'support/demand', levels.entry_low);
  pushLevel(demand, 'midpoint / half-candle', levels.half_candle_level);
  if (prev && prev.low) pushLevel(demand, 'previous low', prev.low);
  pushLevel(supply, 'resistance/supply', levels.resistance);
  pushLevel(supply, 'resistance/supply', levels.tp1);
  if (prev && prev.high) pushLevel(supply, 'previous high', prev.high);
  if (prev && prev.close && o < prev.close && c > prev.close) pushLevel(demand, 'reclaim level', prev.close);
  for (var bi = Math.max(0, len - 8); bi < len - 1; bi++) {
    var base = candles[bi];
    var br = (Number(base.high) || 0) - (Number(base.low) || 0);
    if (br <= 0 || !Number.isFinite(br)) continue;
    var bBody = (Number(base.close) || 0) - (Number(base.open) || 0);
    if (bBody > 0 && Number.isFinite(bBody / br) && bBody / br >= 0.55) pushLevel(demand, 'midpoint / half-candle', base.low + br * 0.5);
    if (bBody > 0 && base.close >= base.low + br * 0.7) pushLevel(demand, 'breakout base', base.open);
  }
  demand.sort(function(a, b) { return a.dist - b.dist; });
  supply.sort(function(a, b) { return a.dist - b.dist; });

  var bull = demand[0] || null;
  var bear = supply[0] || null;
  var bullTap = bull && l <= bull.value * 1.012 && h >= bull.value * 0.988;
  var bullRecover = bullTap && c >= bull.value;
  var bearTap = bear && h >= bear.value * 0.988 && l <= bear.value * 1.012;
  var bearReject = bearTap && c <= bear.value;
  var bullishQuality = bullRecover && lowerWick >= upperWick && closePos >= 0.5;
  var bearishQuality = bearReject && upperWick >= lowerWick && closePos <= 0.5;
  var bearishWarning = null;

  if (bullishQuality || (!bearishQuality && bullRecover)) {
    keyLevel = bull.value;
    keyType = bull.type;
    score += Math.min(20, bull.dist <= 0.015 ? 20 : 14);
    addRespectFactor(factors, 'Level valid: ' + keyType);
    var candleScore = 6;
    if (lowerWick >= body * 1.2) candleScore += 6;
    if (closePos >= 0.6) candleScore += 5;
    if (c > o) candleScore += 3;
    score += Math.min(20, candleScore);
    addRespectFactor(factors, 'Bullish reject + close upper half');
    if (c < keyLevel) invalid.push('Close below support/demand after respect attempt');
    if (keyType === 'midpoint / half-candle' && c < keyLevel) invalid.push('Close below half-candle without reclaim');
    if (lowerWick < upperWick || closePos < 0.5) invalid.push('Wick rejection with weak close');
  } else if (bearishQuality || bearReject) {
    keyLevel = bear.value;
    keyType = bear.type;
    score += Math.min(20, bear.dist <= 0.015 ? 20 : 14);
    addRespectFactor(factors, 'Level valid: ' + keyType);
    var bCandleScore = 6;
    if (upperWick >= body * 1.2) bCandleScore += 6;
    if (closePos <= 0.45) bCandleScore += 5;
    if (c < o) bCandleScore += 3;
    score += Math.min(20, bCandleScore);
    addRespectFactor(factors, 'Bearish supply rejection');
    bearishWarning = 'Bearish respect near supply: take-profit warning / avoid chasing; wait pullback, not short signal.';
  }

  var volInfo = classifyRespectVolume(latest.volume, avgVol);
  score += volInfo.score;
  addRespectFactor(factors, volInfo.factor);
  if (volInfo.label === 'weak') invalid.push('Volume too small / below average');

  var mtf = context.multi_timeframe_bias || context.trend_bias || '';
  if (mtf === 'bullish') { score += 15; addRespectFactor(factors, 'Trend/structure supportive'); }
  else if (mtf === 'neutral' || !mtf) score += 7;
  else score += 3;

  if (context.rsi14 != null) {
    var rsi = Number(context.rsi14);
    if (rsi >= 45 && rsi <= 70) score += 10;
    else if (rsi > 70) { score += 3; invalid.push('Respect appears extended/chase'); }
    else score += 5;
  } else score += 5;

  var rr = Number(levels.risk_reward || context.risk_reward || 0);
  if (rr >= 1.8) score += 10;
  else if (rr >= 1.2) score += 6;
  else { score += 1; invalid.push('Risk/reward poor'); }

  var liqLabel = String(context.liquidity_label || '').toLowerCase();
  var avgTx = Number(context.avg_tx_value_7d || context.avg_value || 0);
  if ((avgTx && avgTx >= 500000000) || /liquid|aman/.test(liqLabel)) score += 10;
  else if ((avgTx && avgTx >= 100000000) || !avgTx) score += 5;
  else { score += 1; invalid.push('Illiquid / weak transaction value'); }
  if (context.is_stale) invalid.push('Stale data');
  if (levels.resistance && c > 0 && levels.resistance > c && Number.isFinite((levels.resistance - c) / c) && ((levels.resistance - c) / c) <= 0.025) invalid.push('Resistance/supply too close above entry');
  if (levels.entry_high && c > levels.entry_high * 1.04) invalid.push('Respect appears after price extended/chase');

  score = clampRespectScore(score);
  if (invalid.length) score = Math.min(score, 49);
  var label = score >= 80 ? 'Strong Respect' : (score >= 65 ? 'Valid Respect' : (score >= 45 ? 'Watchlist Respect' : 'Weak / Ignore'));
  if (invalid.length && score < 45) label = 'Weak / Ignore';
  return {
    respect_quality_score: score,
    respect_quality_label: label,
    respect_quality_factors: factors.slice(0, 4),
    respect_invalid_reason: (invalid.length || label === 'Weak / Ignore') ? (invalid[0] || 'Respect quality weak') : null,
    bearish_respect_warning: bearishWarning,
    respect_key_level: keyLevel ? idxTick.roundToIdxTick(keyLevel, 'nearest') || round0(keyLevel) : null,
    respect_key_level_type: keyType,
    respect_volume_label: volInfo.label,
    respect_volume_ratio: volInfo.ratio
  };
}

// ============================================================
// LEVEL REFINEMENT WITH RESPECT ZONES
// Takes existing base levels and adjusts using detected zones.
// Does NOT replace existing calculation — refines after it.
// ============================================================

function refineLevelsWithRespectZones(baseLevels, candles, lastPrice, context) {
  if (!candles || candles.length < 10 || !baseLevels) return baseLevels;
  if (!baseLevels.entry_low || !baseLevels.stop_loss || !baseLevels.tp1) return baseLevels;

  // RR minimum per context
  var ctx = context || 'daytrade';
  var minRR = (ctx === 'konglo' || ctx === 'nonkonglo') ? 1.5 : 1.2;

  var rzResult = detectRespectZones(candles);
  var notes = rzResult.notes || [];
  var majorCtx = detectMajorRespectZoneContext(candles, lastPrice);
  if (majorCtx && majorCtx.notes && majorCtx.notes.length) notes = notes.concat(majorCtx.notes);
  var hcdResult = detectHalfCandleDebt(candles, lastPrice);
  if (hcdResult) notes.push(hcdResult.label + ': ' + hcdResult.note);
  var len = candles.length;
  var refinementNotes = [];

  // Find demand and supply zones from 5D-10D window
  var demandLevel = null;
  var supplyLevel = null;

  var lookback = Math.min(10, len);
  var recentSlice = candles.slice(len - lookback);
  var lows = recentSlice.map(function(c) { return c.low; });
  var highs = recentSlice.map(function(c) { return c.high; });
  var minLow = Math.min.apply(null, lows);
  var maxHigh = Math.max.apply(null, highs);

  // Count touches near min low (demand zone)
  var demandTolerance = minLow * 0.015;
  var demandTouches = 0;
  for (var i = 0; i < recentSlice.length; i++) {
    if (recentSlice[i].low <= minLow + demandTolerance) demandTouches++;
  }
  if (demandTouches >= 2) demandLevel = minLow;

  // Count touches near max high (supply zone)
  var supplyTolerance = maxHigh * 0.015;
  var supplyRejects = 0;
  for (var j = 0; j < recentSlice.length; j++) {
    if (recentSlice[j].high >= maxHigh - supplyTolerance && recentSlice[j].close < maxHigh - supplyTolerance) supplyRejects++;
  }
  if (supplyRejects >= 2) supplyLevel = maxHigh;

  // ATR proxy
  var latest = candles[len - 1];
  var atrProxy = (Number(latest.high) - Number(latest.low)) || (lastPrice * 0.02);
  if (!atrProxy || atrProxy <= 0 || !Number.isFinite(atrProxy)) atrProxy = (lastPrice > 0 ? lastPrice * 0.02 : 1);

  var refined = {
    entry_low: baseLevels.entry_low,
    entry_high: baseLevels.entry_high,
    stop_loss: baseLevels.stop_loss,
    tp1: baseLevels.tp1,
    tp2: baseLevels.tp2 || baseLevels.tp1,
    risk_reward: baseLevels.risk_reward
  };

  // --- HALF-CANDLE DEBT ENTRY REFINEMENT ---
  if (hcdResult && hcdResult.half_candle_level && lastPrice > 0) {
    var halfLevel = hcdResult.half_candle_level;
    if (lastPrice >= halfLevel && lastPrice <= halfLevel * 1.035) {
      refined.entry_low = idxTick.roundToIdxTick(Math.max(halfLevel * 0.99, hcdResult.impulse_low), 'nearest') || refined.entry_low;
      refined.entry_high = idxTick.roundToIdxTick(Math.min(halfLevel * 1.015, lastPrice), 'nearest') || refined.entry_high;
      refinementNotes.push('Entry pullback 1/2 candle: area half-candle debt divalidasi fraksi IDX');
    } else if (lastPrice > halfLevel * 1.035) {
      refinementNotes.push('Chase risk: price has not paid 1/2 candle yet — tunggu area ' + halfLevel);
    } else if (lastPrice < halfLevel && lastPrice >= hcdResult.impulse_low) {
      refinementNotes.push('Break below 1/2 candle — confidence turun sampai reclaim ' + halfLevel);
    } else if (lastPrice < hcdResult.impulse_low) {
      refinementNotes.push('Break impulse low — setup invalid/high risk');
    }
  }

  // --- ENTRY 1 (entry_low) REFINEMENT ---
  if (demandLevel && lastPrice > 0) {
    var distFromDemand = Number.isFinite(((lastPrice - demandLevel) / lastPrice) * 100) ? ((lastPrice - demandLevel) / lastPrice) * 100 : 0;

    if (distFromDemand <= 3.0) {
      // Price near demand — anchor Entry 1 to demand
      var newEntryLow = Math.round(Math.max(demandLevel, lastPrice * 0.97));
      if (newEntryLow > 0 && newEntryLow < lastPrice) {
        refined.entry_low = newEntryLow;
        refinementNotes.push('Entry 1 disesuaikan ke area demand yang di-respect');
      }
    } else if (distFromDemand > 5.0) {
      refinementNotes.push('Harga jauh di atas demand zone - jangan chase, tunggu pullback');
    }
  }

  // --- ENTRY 2 (entry_high) REFINEMENT ---
  // Entry 2 should be >= Entry 1 and represent upper entry / breakout area
  if (refined.entry_low > refined.entry_high) {
    // Entry 1 was moved — adjust Entry 2 to maintain valid range
    refined.entry_high = Math.round(refined.entry_low + atrProxy * 0.4);
    refinementNotes.push('Entry 2 disesuaikan agar tetap di atas Entry 1');
  }
  // If entry range is too wide (> 3% of price), cap it
  if (refined.entry_high > refined.entry_low * 1.03) {
    refined.entry_high = Math.round(refined.entry_low * 1.025);
  }

  // --- STOP LOSS REFINEMENT ---
  if (demandLevel) {
    var slBelowDemand = Math.round(demandLevel - atrProxy * 0.4);
    if (slBelowDemand > refined.stop_loss && slBelowDemand < refined.entry_low) {
      refined.stop_loss = slBelowDemand;
      refinementNotes.push('SL di bawah area demand/support volume tinggi');
    }
  }

  // --- TP1 REFINEMENT ---
  if (supplyLevel && supplyLevel > lastPrice * 1.005) {
    var entryMid = (refined.entry_low + refined.entry_high) / 2;
    var risk = entryMid - refined.stop_loss;
    if (risk > 0 && Number.isFinite((supplyLevel - entryMid) / risk) && (supplyLevel - entryMid) / risk >= 1.2) {
      refined.tp1 = Math.round(supplyLevel);
      refinementNotes.push('TP1 mengarah ke supply zone terdekat');
    }
  }

  // --- TP2 REFINEMENT ---
  if (len >= 20) {
    var slice20 = candles.slice(len - 20);
    var highs20 = slice20.map(function(c) { return c.high; });
    var max20 = Math.max.apply(null, highs20);
    if (max20 > refined.tp1 * 1.01 && max20 > lastPrice * 1.02) {
      refined.tp2 = Math.round(max20);
      refinementNotes.push('TP2 mengarah ke resistance 20D');
    }
  }

  // --- RECALCULATE R/R ---
  var finalEntryMid = (refined.entry_low + refined.entry_high) / 2;
  var finalRisk = finalEntryMid - refined.stop_loss;
  if (finalRisk > 0 && refined.tp1 > finalEntryMid && Number.isFinite((refined.tp1 - finalEntryMid) / finalRisk)) {
    refined.risk_reward = Math.round(((refined.tp1 - finalEntryMid) / finalRisk) * 100) / 100;
  }
  if (!Number.isFinite(refined.risk_reward) || refined.risk_reward < 0) {
    refined.risk_reward = 0;
  }

  // === SAFETY FALLBACK: validate all level orderings ===
  var valid = true;
  if (!refined.entry_low || !refined.entry_high || !refined.stop_loss || !refined.tp1) valid = false;
  if (refined.stop_loss >= refined.entry_low) valid = false;
  if (refined.entry_high < refined.entry_low) valid = false;
  if (refined.tp1 <= refined.entry_high) valid = false;
  if (refined.tp2 < refined.tp1) valid = false;
  if (isNaN(refined.risk_reward) || !Number.isFinite(refined.risk_reward) || refined.risk_reward < minRR) valid = false;

  if (!valid) {
    // Fallback to base levels entirely
    var fallback = {
      entry_low: baseLevels.entry_low,
      entry_high: baseLevels.entry_high,
      stop_loss: baseLevels.stop_loss,
      tp1: baseLevels.tp1,
      tp2: baseLevels.tp2 || baseLevels.tp1,
      risk_reward: baseLevels.risk_reward,
      refinement_notes: 'Respect zone refinement skipped because R/R would become too weak (min ' + minRR + ').',
      respect_zone_notes: notes.length > 0 ? notes.join('; ') : null
    };
    var fallbackQuality = scoreRespectCandleQuality(candles, fallback, { risk_reward: fallback.risk_reward });
    if (fallbackQuality) Object.assign(fallback, fallbackQuality);
    return fallback;
  }

  // Attach notes
  refined.refinement_notes = refinementNotes.length > 0 ? refinementNotes.join('; ') : null;
  if (hcdResult) {
    refined.half_candle_level = hcdResult.half_candle_level;
    refined.half_candle_label = hcdResult.label;
    refined.half_candle_note = hcdResult.note;
    refined.half_candle_chase_risk = hcdResult.chase_risk;
  }
  refined.respect_zone_notes = notes.length > 0 ? notes.join('; ') : null;
  var respectQuality = scoreRespectCandleQuality(candles, Object.assign({}, refined, {
    support: baseLevels.support,
    resistance: baseLevels.resistance
  }), { risk_reward: refined.risk_reward });
  if (respectQuality) Object.assign(refined, respectQuality);

  return refined;
}

// ============================================================
// BSJP POTENTIAL DETECTION (Day Trade only)
// Returns label string or null. Strict criteria.
// ============================================================

function detectBsjpPotential(scored, analysis) {
  if (!scored || !analysis) return null;
  var score = scored.daytrade_score || 0;
  var volRatio = analysis.volume_ratio_20d || 0;
  var rr = scored.risk_reward || 0;
  var status = scored.status || '';
  var changePct = analysis.change_pct || 0;
  var distBreakout = analysis.distance_to_breakout_pct;

  // Must be strong setup
  if (score < 72) return null;
  // Volume must be strong
  if (volRatio < 1.3) return null;
  // R/R must be acceptable
  if (rr < 1.3) return null;
  // Must not be weak/wait/avoid status
  if (status === 'AVOID' || status === 'WAIT_PULLBACK' || status === 'SPECULATIVE' || status === 'EARLY_RADAR' || status.indexOf('WAIT') >= 0 || status.indexOf('AVOID') >= 0) return null;
  // Chase guard: if already extended too much
  if (changePct > 5.5) return null;
  // Must be near breakout if available
  if (distBreakout != null && distBreakout > 4.0) return null;
  // Check for chase warning in refinement notes
  if (scored.refinement_notes && String(scored.refinement_notes).toLowerCase().indexOf('chase') >= 0) return null;

  return 'Potensi BSJP Watch: volume, candle, momentum, dan R/R mendukung. Tetap tunggu konfirmasi intraday.';
}

function getDayTradeEvaluationConfiguration(runMode, options) {
  options = options || {};
  function sourceHash(fn) { return crypto.createHash('sha256').update(Function.prototype.toString.call(fn)).digest('hex'); }
  return {
    schema_version: 1, strategy: 'DAY_TRADE', run_mode: runMode,
    fast_mode: !!options.fastMode, batch_size: options.fastMode ? 75 : 50,
    persistence_score_min: 50, score_cap: { min: 0, max: 100 },
    classification_thresholds: DT_INITIAL,
    decision_source_sha256: { scoring: sourceHash(scoreDayTrade), classification: sourceHash(classifyStatus), levels: sourceHash(calculateLevels), atr_adjustment: sourceHash(atrHelpers.deriveAtrScorePenalty), optional_intraday_adjustment: sourceHash(intradayScoreAdjustment.applyIntradayScoreAdjustment) },
    intraday_score_enabled: String(options.intradayScoreEnabled || '').toLowerCase() === 'true'
  };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  getDayTradeEvaluationConfiguration: getDayTradeEvaluationConfiguration,
  getRunMode: getRunMode,
  getWibDateStr: getWibDateStr,
  getWibTimeStr: getWibTimeStr,
  normalizeUniverseTicker: normalizeUniverseTicker,
  fetchDayTradeCandles: fetchDayTradeCandles,
  analyzeDayTrade: analyzeDayTrade,
  scoreDayTrade: scoreDayTrade,
  scoreLiquidity: scoreLiquidity,
  scorePreSpike: scorePreSpike,
  scoreMomentum: scoreMomentum,
  scoreRiskReward: scoreRiskReward,
  scoreTrend: scoreTrend,
  calculatePenalty: calculatePenalty,
  calculateLevels: calculateLevels,
  classifyStatus: classifyStatus,
  generateTimePlan: generateTimePlan,
  buildDayTradeUniverse: buildDayTradeUniverse,
  filterDayTradeUniverse: filterDayTradeUniverse,
  dayTradeEligibilityReason: dayTradeEligibilityReason,
  buildFastDayTradeUniverse: buildFastDayTradeUniverse,
  fetchForeignUniverseTickers: fetchForeignUniverseTickers,
  runDayTradeBatch: runDayTradeBatch,
  detectRespectZones: detectRespectZones,
  detectMajorRespectZoneContext: detectMajorRespectZoneContext,
  detectVolumeProfilePoc: detectVolumeProfilePoc,
  scoreRespectCandleQuality: scoreRespectCandleQuality,
  detectHalfCandleDebt: detectHalfCandleDebt,
  refineLevelsWithRespectZones: refineLevelsWithRespectZones,
  detectBsjpPotential: detectBsjpPotential,
  deriveDataQualityStatus: deriveDataQualityStatus,
  calcRSI: calcRSI
};
