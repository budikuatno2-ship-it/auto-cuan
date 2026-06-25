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

var candleEngine = require('./candle-pattern-engine');
var idxTick = require('./idx-tick-normalization');

// ============================================================
// RUN MODE DETECTION (WIB time-based)
// ============================================================

function getRunMode(overrideMode) {
  if (overrideMode) {
    var m = String(overrideMode).toLowerCase().trim();
    if (m === 'morning') return 'MORNING_SCOUT';
    if (m === 'midday') return 'MIDDAY_CHECK';
    if (m === 'afternoon') return 'AFTERNOON_EXIT';
  }

  var now = new Date();
  var wibMs = now.getTime() + (7 * 60 * 60 * 1000);
  var wib = new Date(wibMs);
  var h = wib.getUTCHours();
  var min = wib.getUTCMinutes();
  var totalMin = h * 60 + min;

  // 09:00–10:30 WIB = 540–630
  if (totalMin >= 540 && totalMin <= 630) return 'MORNING_SCOUT';
  // 10:30–13:30 WIB = 630–810
  if (totalMin > 630 && totalMin <= 810) return 'MIDDAY_CHECK';
  // 13:30–15:00 WIB = 810–900
  if (totalMin > 810 && totalMin <= 900) return 'AFTERNOON_EXIT';
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
  var prev_close = len >= 2 ? candles[lastIdx - 1].close : last.open;
  var change_pct = prev_close > 0 ? round2((last_price - prev_close) / prev_close * 100) : 0;

  // Volume
  var volume_today = last.volume;
  var value_today = round0(last_price * volume_today); // proxy tx value

  // Averages
  var vol20 = calcMA(volumes, 20);
  var avg_volume_20d = vol20 ? round0(vol20) : 0;
  var volume_ratio_20d = avg_volume_20d > 0 ? round2(volume_today / avg_volume_20d) : 0;

  // Avg value 7d
  var last7 = candles.slice(-7);
  var avg_value_7d = round0(last7.reduce(function(s, c) { return s + c.close * c.volume; }, 0) / last7.length);

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
      var trHigh = highs[ai] - lows[ai];
      var trHighPrev = Math.abs(highs[ai] - closes[ai - 1]);
      var trLowPrev = Math.abs(lows[ai] - closes[ai - 1]);
      var tr = Math.max(trHigh, trHighPrev, trLowPrev);
      trSum += tr;
      trCount++;
    }
    if (trCount > 0) atr14 = trSum / trCount;
  }

  // === SWING LOW 5D (recent minor low for SL anchor) ===
  var swingLow5 = round0(Math.min.apply(null, lows.slice(-5)));

  // === SWING HIGH 10D (intermediate resistance for TP) ===
  var swingHigh10 = round0(Math.max.apply(null, highs.slice(-10)));

  // Range position: where is last_price within today's range (0=low, 100=high)
  var dayRange = high_price - low_price;
  var range_position = dayRange > 0 ? round2((last_price - low_price) / dayRange * 100) : 50;

  // Distance to breakout (resistance)
  var distance_to_breakout_pct = resistance > 0 ? round2((resistance - last_price) / last_price * 100) : 99;

  return {
    ticker: ticker,
    last_price: last_price,
    open_price: open_price,
    high_price: high_price,
    low_price: low_price,
    change_pct: change_pct,
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
    _priceNearHigh: dayRange > 0 ? (high_price - last_price) / dayRange < 0.2 : false,
    _fadeFromHigh: dayRange > 0 ? (high_price - last_price) / dayRange : 0,
    _aboveMA20: ma20 ? last_price >= ma20 : false,
    _aboveMA50: ma50 ? last_price >= ma50 : false,
    _overextendedMA20: ma20 ? (last_price - ma20) / ma20 > 0.08 : false
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
  else if (data.volume_ratio_20d >= 1.5) score += 6;
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
  else if (data.volume_ratio_20d >= 1.5) score += 5;
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
    else if (data.rsi14 > 80) score += 0;
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
  if (data.change_pct > 8.5) {
    penalty -= 20;
    reasons.push('Gap/kenaikan sangat tinggi (+' + data.change_pct.toFixed(1) + '%). JANGAN chase — risiko reversal besar.');
  } else if (data.change_pct > 7.0 && data.volume_ratio_20d < 2.0) {
    penalty -= 15;
    reasons.push('Overheat (+' + data.change_pct.toFixed(1) + '%) tanpa volume konfirmasi. Risiko false breakout.');
  } else if (data.change_pct > 5.0 && data.volume_ratio_20d < 1.5) {
    penalty -= 10;
    reasons.push('Sudah naik +' + data.change_pct.toFixed(1) + '% tanpa volume kuat. Tunggu pullback.');
  } else if (data.change_pct > 4.0 && data.volume_ratio_20d < 1.2) {
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
  } else if (!data._priceAboveOpen && data.volume_ratio_20d >= 1.5) {
    penalty -= 8;
    reasons.push('Price < open + volume tinggi. Indikasi distribusi.');
  } else if (!data._priceAboveOpen && data.volume_ratio_20d >= 1.2) {
    penalty -= 4;
    reasons.push('Price < open + volume meningkat. Monitor tekanan jual.');
  }

  // V4: Upper shadow with volume (rejection candle) — refined thresholds
  var dayRange = data.high_price - data.low_price;
  var upperShadow = data.high_price - Math.max(data.open_price, data.last_price);
  if (dayRange > 0 && upperShadow > dayRange * 0.5 && data.volume_ratio_20d >= 1.5) {
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
  } else if (data.rsi14 !== null && data.rsi14 > 80) {
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
  var risk_reward = finalRisk > 0 ? round2(reward1 / finalRisk) : 0;

  // === RR QUALITY GUARD ===
  var levelNote = '';
  // If RR > 5 and TP has no structural support, cap TP
  if (risk_reward > 5.0 && tp1 > resistance) {
    tp1 = round0(resistance);
    reward1 = tp1 - entryMid;
    risk_reward = finalRisk > 0 ? round2(reward1 / finalRisk) : 0;
    levelNote = 'TP dikonservatifkan — target terlalu jauh tanpa struktur.';
  }

  // Risk distance %
  var riskDistPct = entryMid > 0 ? round2(finalRisk / entryMid * 100) : 99;

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

  if (levels.risk_reward < 1.5) {
    hardFails.push('RR < 1.5');
    hasPoorRR = true;
  }

  if (levels._riskDistPct > 5.0) {
    hardFails.push('Risk jauh (' + levels._riskDistPct.toFixed(1) + '%)');
    hasRiskFar = true;
  }

  // V2 B5: Gap-up / overheat guard (stricter)
  if (data.change_pct > 8.5) {
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
  if (data.volume_ratio_20d < 1.2) {
    hasLowVolume = true;
  }

  // V2 B7: Distribution detection for day trade
  if (!data._priceAboveOpen && data.volume_ratio_20d >= 1.5) {
    hasDistribution = true;
    hardFails.push('Distribusi intraday');
  }

  if (data._overextendedMA20) {
    hardFails.push('Overextended MA20');
  }

  if (data.rsi14 !== null && data.rsi14 > 80) {
    hardFails.push('RSI overbought');
  }

  // V2 B4: Afternoon conservative mode
  var isAfternoon = (runMode === 'AFTERNOON_EXIT');

  // === SEVERE AVOID: only for truly broken cases ===
  // Score < 40 OR (score < 50 AND no meaningful activity)
  if (compositeScore < 40) {
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
  if (compositeScore >= 88 && hardFails.length === 0 && !isAfternoon &&
      data._priceAboveOpen && data.volume_ratio_20d >= 1.5 &&
      data.range_position >= 60 && levels.risk_reward >= 1.5 &&
      !hasDistribution && data.change_pct <= 7.0 && !candleDowngrade) {
    status = 'A_PLUS_SETUP';
    setup = determineSetup(data, 'ready');
    notes = 'Setup A+ — semua konfirmasi terpenuhi. Potensi naik kuat. Entry hanya jika masih di area entry, volume tetap masuk. Wajib konfirmasi manual.';
  }
  // TRADE_CANDIDATE: score >= 78, no hard fails, good setup but not all A+ confirmations
  else if (compositeScore >= 78 && hardFails.length === 0 && !isAfternoon &&
           data._priceAboveOpen && data.volume_ratio_20d >= 1.2 && !hasDistribution) {
    status = 'TRADE_CANDIDATE';
    setup = determineSetup(data, 'ready');
    notes = 'Kandidat trade — setup bagus, butuh konfirmasi chart. Entry jika price bertahan di area entry dan volume tetap masuk.';
  }
  // READY_BREAKOUT: score >= 75, NO hard fails, NOT Akselerasi, NOT afternoon
  else if (compositeScore >= 75 && hardFails.length === 0 && !isAfternoon) {
    status = 'READY_BREAKOUT';
    setup = determineSetup(data, 'ready');
    notes = 'Radar day trade. Entry hanya jika harga masih bertahan di area entry dan volume tetap masuk. Wajib konfirmasi manual di chart/orderbook.';
  }
  // Afternoon mode — downgrade READY/TRADE to MOMENTUM_CONTINUATION
  else if (compositeScore >= 75 && hardFails.length === 0 && isAfternoon) {
    status = 'MOMENTUM_CONTINUATION';
    setup = 'Late Session Momentum';
    notes = 'Late entry berisiko. Prioritaskan exit sebelum close. Jangan entry agresif kecuali sudah punya posisi dan trailing plan.';
  }
  // EARLY_RADAR: score >= 62, early signs, not yet fully confirmed — V3 new
  else if (compositeScore >= 62 && hardFails.length === 0 && !isAfternoon &&
           data.change_pct >= -0.5 && data.change_pct <= 5.0 &&
           data.distance_to_breakout_pct <= 5.0 && !hasDistribution) {
    status = 'EARLY_RADAR';
    setup = determineSetup(data, 'prespike');
    notes = 'Radar awal — ada tanda akumulasi/tekanan. Belum breakout. Monitor volume + harga. Jangan entry sebelum konfirmasi.';
  }
  // PRE_SPIKE_WATCH: score >= 70, no hard fails, V2: requires volume >= 1.2
  else if (compositeScore >= 70 && hardFails.length === 0 && !hasLowVolume && !isAfternoon) {
    if (data.change_pct > 5.0) {
      if (data.volume_ratio_20d >= 1.5 && data._priceAboveOpen) {
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
  else if (compositeScore >= 70 && hardFails.length === 0 && hasLowVolume && !isAfternoon) {
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
  else if (compositeScore >= 70 && hardFails.length === 0 && isAfternoon) {
    status = 'WAIT_PULLBACK';
    setup = 'Late Session - Wait';
    notes = 'Sesi sore, waktu breakout terbatas. Late entry berisiko. Prioritas exit.';
  }
  else if (compositeScore >= 65 && hardFails.length === 0 && data.distance_to_breakout_pct <= 3.0 && !hasLowVolume && !isAfternoon) {
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
  // V3: EARLY_RADAR catch — score 58-62 with promising signs
  else if (compositeScore >= 58 && hardFails.length === 0 && !isAfternoon &&
           data._priceAboveOpen && data.distance_to_breakout_pct <= 5.0 &&
           data.volume_ratio_20d >= 0.8 && !hasDistribution && data.change_pct >= 0) {
    status = 'EARLY_RADAR';
    setup = 'Early Radar - Building';
    notes = 'Sinyal awal sedang terbentuk. Harga di atas open, mendekati resistance. Belum cukup konfirmasi untuk entry.';
  }
  // WAIT_PULLBACK: score >= 60 but has overheat/RR/extended/gap issues
  else if (compositeScore >= 60 && (hasOverheat || hasPoorRR || hasRiskFar || hasGapUp)) {
    status = 'WAIT_PULLBACK';
    setup = hasGapUp ? 'Wait - Gap/Overheat' : (hasOverheat ? 'Wait - Overheat' : (hasPoorRR ? 'Wait - Poor RR' : 'Wait - Risk Far'));
    notes = generateWaitNotes(hardFails, hasOverheat, hasPoorRR, data);
    if (hasGapUp && !hasOverheat) {
      notes = 'Gap/kenaikan sudah tinggi (+' + data.change_pct.toFixed(1) + '%). Hindari chase, tunggu pullback/konfirmasi lanjutan.';
    }
  }
  // MOMENTUM_CONTINUATION: score >= 60, active, structurally valid
  else if (compositeScore >= 60 && data._priceAboveOpen && data.volume_ratio_20d >= 1.0 && !hasDistribution) {
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
  else if (compositeScore >= 50) {
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
  if (data.volume_ratio_20d >= 1.5 && data.change_pct > 0) {
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
  if (data.distance_to_breakout_pct <= 1.5 && data.volume_ratio_20d >= 1.5) {
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

function scoreDayTrade(data, runMode, board, candleResult) {
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

  // 12. V4: Prediction direction label — risk-aware
  var direction = 'Hindari';
  if (confidence === 'A+') direction = 'Potensi naik kuat — konfirmasi lengkap';
  else if (confidence === 'A') direction = 'Potensi naik kuat';
  else if (confidence === 'B' && compositeScore >= 72) direction = 'Potensi naik moderat';
  else if (confidence === 'B' && compositeScore >= 65) direction = 'Radar awal — belum konfirmasi';
  else if (confidence === 'B') direction = 'Masih radar awal';
  else if (classification.status === 'WAIT_PULLBACK') direction = 'Rawan gagal lanjut — jangan chase';
  else if (classification.status === 'SPECULATIVE') direction = 'Rawan gagal lanjut';
  else if (classification.status === 'AVOID') direction = 'Hindari — risiko tinggi';
  else direction = 'Masih radar awal';

  return {
    ticker: data.ticker,
    last_price: data.last_price,
    open_price: data.open_price,
    high_price: data.high_price,
    low_price: data.low_price,
    change_pct: data.change_pct,
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
    // V5: Candle pattern confirmation (computed, not DB column)
    candle_pattern: candleResult ? candleResult.pattern : null,
    candle_bias: candleResult ? candleResult.bias : null,
    candle_score: candleScore,
    // V6: Tick normalization metadata
    tick_normalized: levels.tick_normalized || false,
    tick_notes: levels.tick_notes || null
  };
}

// ============================================================
// UNIVERSE BUILDER
// ============================================================

async function buildDayTradeUniverse(supabase) {
  // Get stocks from stock_boards — ONLY Papan Utama and Pengembangan.
  // Papan Akselerasi is EXCLUDED from Day Trade screener (too risky/illiquid).
  var { data: boardStocks, error: boardErr } = await supabase
    .from('stock_boards')
    .select('ticker, board')
    .in('board', ['UTAMA', 'PENGEMBANGAN']);

  if (boardErr || !boardStocks || boardStocks.length === 0) {
    return { tickers: [], error: boardErr ? boardErr.message : 'No stocks in stock_boards' };
  }

  // Defensive: filter out any Akselerasi that might leak through
  var universe = boardStocks
    .filter(function(s) { return s.board !== 'AKSELERASI'; })
    .map(function(s) {
      return { ticker: s.ticker, board: s.board };
    });

  return { tickers: universe, error: null };
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

  return { tickers: fastUniverse, error: null };
}

// ============================================================
// BATCH RUNNER — processes a slice of tickers
// ============================================================

async function runDayTradeBatch(tickers, runMode, options) {
  var results = [];
  var failed = [];
  var isFast = (options && options.fastMode);
  var baseDelay = isFast ? 180 : 200;
  var currentDelay = baseDelay;
  var consecutiveErrors = 0;
  var MAX_DELAY = 2000;

  for (var i = 0; i < tickers.length; i++) {
    var item = tickers[i];
    try {
      var candles = await fetchDayTradeCandles(item.ticker);
      if (!candles || candles.length < 20) {
        failed.push({ ticker: item.ticker, reason: !candles ? 'no_data' : 'insufficient_candles_' + (candles ? candles.length : 0) });
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

      var scored = scoreDayTrade(analysis, runMode, item.board, candleResult);
      scored.board = item.board;
      scored.stock_name = item.stock_name || item.ticker;

      // Respect Zone: detect and refine levels
      var rzResult = detectRespectZones(candles);
      if (rzResult.notes && rzResult.notes.length > 0) {
        scored.respect_zone_notes = rzResult.notes.join('; ');
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
      var lcRange = lastCandle.high - lastCandle.low;
      var lcClosePos = lcRange > 0 ? (lastCandle.close - lastCandle.low) / lcRange : 0.5;
      var lcBodyRatio = lcRange > 0 ? Math.abs(lastCandle.close - lastCandle.open) / lcRange : 0.5;
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
      scored.volume_signal = vpaResult.volume_signal;
      scored.volume_phase = vpaResult.volume_phase;
      scored.volume_notes = vpaResult.volume_notes;

      // === V6: RISK LABEL ===
      var chaseDistPct = scored.entry_high > 0 ? ((analysis.last_price - scored.entry_high) / scored.entry_high) * 100 : 0;
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
    if (i < tickers.length - 1) {
      await delay(currentDelay);
    }
  }

  return { results: results, failed: failed };
}

// ============================================================
// HELPERS
// ============================================================

function calcMA(arr, period) {
  if (!arr || arr.length < period) return null;
  var slice = arr.slice(arr.length - period);
  var sum = 0;
  for (var i = 0; i < slice.length; i++) sum += slice[i];
  return sum / period;
}

function calcRSI(closes, period) {
  if (!closes || closes.length < period + 1) return null;
  var gains = 0, losses = 0;
  for (var i = closes.length - period; i < closes.length; i++) {
    var diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  var avgGain = gains / period;
  var avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  var rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function round2(val) { return Math.round(val * 100) / 100; }
function round0(val) { return Math.round(val); }
function delay(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }

// ============================================================
// RESPECT ZONE DETECTION (multi-window candle + volume analysis)
// Returns notes only - does NOT change Entry/SL/TP/RR.
// ============================================================

function detectRespectZones(candles) {
  if (!candles || candles.length < 5) return { notes: [] };
  var notes = [];
  var len = candles.length;
  var latest = candles[len - 1];

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
  var atrProxy = (latest.high - latest.low) || (lastPrice * 0.02);
  if (atrProxy <= 0) atrProxy = lastPrice * 0.02;

  var refined = {
    entry_low: baseLevels.entry_low,
    entry_high: baseLevels.entry_high,
    stop_loss: baseLevels.stop_loss,
    tp1: baseLevels.tp1,
    tp2: baseLevels.tp2 || baseLevels.tp1,
    risk_reward: baseLevels.risk_reward
  };

  // --- ENTRY 1 (entry_low) REFINEMENT ---
  if (demandLevel && lastPrice > 0) {
    var distFromDemand = ((lastPrice - demandLevel) / lastPrice) * 100;

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
    if (risk > 0 && (supplyLevel - entryMid) / risk >= 1.2) {
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
  if (finalRisk > 0 && refined.tp1 > finalEntryMid) {
    refined.risk_reward = Math.round(((refined.tp1 - finalEntryMid) / finalRisk) * 100) / 100;
  }

  // === SAFETY FALLBACK: validate all level orderings ===
  var valid = true;
  if (!refined.entry_low || !refined.entry_high || !refined.stop_loss || !refined.tp1) valid = false;
  if (refined.stop_loss >= refined.entry_low) valid = false;
  if (refined.entry_high < refined.entry_low) valid = false;
  if (refined.tp1 <= refined.entry_high) valid = false;
  if (refined.tp2 < refined.tp1) valid = false;
  if (isNaN(refined.risk_reward) || refined.risk_reward < minRR) valid = false;

  if (!valid) {
    // Fallback to base levels entirely
    return {
      entry_low: baseLevels.entry_low,
      entry_high: baseLevels.entry_high,
      stop_loss: baseLevels.stop_loss,
      tp1: baseLevels.tp1,
      tp2: baseLevels.tp2 || baseLevels.tp1,
      risk_reward: baseLevels.risk_reward,
      refinement_notes: 'Respect zone refinement skipped because R/R would become too weak (min ' + minRR + ').',
      respect_zone_notes: notes.length > 0 ? notes.join('; ') : null
    };
  }

  // Attach notes
  refined.refinement_notes = refinementNotes.length > 0 ? refinementNotes.join('; ') : null;
  refined.respect_zone_notes = notes.length > 0 ? notes.join('; ') : null;

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
  if (scored.refinement_notes && scored.refinement_notes.indexOf('chase') >= 0) return null;

  return 'Potensi BSJP Watch: volume, candle, momentum, dan R/R mendukung. Tetap tunggu konfirmasi intraday.';
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  getRunMode: getRunMode,
  getWibDateStr: getWibDateStr,
  getWibTimeStr: getWibTimeStr,
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
  buildFastDayTradeUniverse: buildFastDayTradeUniverse,
  runDayTradeBatch: runDayTradeBatch,
  detectRespectZones: detectRespectZones,
  refineLevelsWithRespectZones: refineLevelsWithRespectZones,
  detectBsjpPotential: detectBsjpPotential
};
