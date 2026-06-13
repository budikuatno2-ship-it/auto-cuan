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
// ============================================================

function calculateLevels(data) {
  var last = data.last_price;
  var open = data.open_price;
  var high = data.high_price;
  var low = data.low_price;
  var support = data.support;
  var resistance = data.resistance;

  // Day trade entry: near current price, tight zone
  // Entry low: slightly below current or at open/support (whichever is closer to price)
  var entryBase = Math.max(low, Math.min(open, last * 0.985));
  var entry_low = round0(Math.max(entryBase, last * 0.985));
  var entry_high = round0(Math.min(last * 1.005, high));

  // Ensure entry_low <= entry_high
  if (entry_low > entry_high) {
    entry_low = round0(last * 0.99);
    entry_high = round0(last * 1.005);
  }

  // Stop loss: below today's low or support, whichever is tighter
  var sl_below_low = round0(low * 0.99);
  var sl_below_support = round0(support * 0.985);
  var stop_loss = Math.max(sl_below_low, sl_below_support);

  // If SL >= entry_low, force it lower
  if (stop_loss >= entry_low) {
    stop_loss = round0(entry_low * 0.97);
  }

  // TP1: near resistance or measured move
  var entryMid = (entry_low + entry_high) / 2;
  var risk = entryMid - stop_loss;
  var tp1 = round0(Math.min(resistance, entryMid + risk * 2.0));
  var tp2 = round0(entryMid + risk * 3.0);

  // If tp1 <= entry_high, use resistance directly
  if (tp1 <= entry_high) {
    tp1 = round0(resistance);
    tp2 = round0(resistance * 1.02);
  }

  // Risk reward
  var reward1 = tp1 - entryMid;
  var risk_reward = risk > 0 ? round2(reward1 / risk) : 0;

  // Risk distance %
  var riskDistPct = entryMid > 0 ? round2(risk / entryMid * 100) : 99;

  var invalidation = 'Close < ' + round0(stop_loss) + ' atau break low ' + round0(low);

  return {
    entry_low: entry_low,
    entry_high: entry_high,
    stop_loss: stop_loss,
    tp1: tp1,
    tp2: tp2,
    risk_reward: risk_reward,
    invalidation: invalidation,
    _riskDistPct: riskDistPct
  };
}

// ============================================================
// STATUS CLASSIFICATION (with hard guards) — V2: afternoon, volume, gap guards
// ============================================================

function classifyStatus(compositeScore, data, levels, liqResult, penaltyResult, board, runMode) {
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
      !hasDistribution && data.change_pct <= 7.0) {
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

function scoreDayTrade(data, runMode, board) {
  // 1. Calculate levels
  var levels = calculateLevels(data);

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

  // Composite score (cap 0-100)
  var rawScore = liqResult.score + prespike + momentum + rrScore + trend + penaltyResult.penalty;
  var compositeScore = Math.max(0, Math.min(100, rawScore));

  // 8. Classify (pass board for Akselerasi hard guard, runMode for afternoon V2)
  var classification = classifyStatus(compositeScore, data, levels, liqResult, penaltyResult, board, runMode);

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
    notes: classification.notes,
    time_plan: timePlan,
    run_mode: runMode,
    // V3: New labels (computed, not DB columns)
    confidence: confidence,
    entry_timing: entryTiming,
    direction: direction
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
// BATCH RUNNER — processes a slice of tickers
// ============================================================

async function runDayTradeBatch(tickers, runMode) {
  var results = [];
  var failed = [];

  for (var i = 0; i < tickers.length; i++) {
    var item = tickers[i];
    try {
      var candles = await fetchDayTradeCandles(item.ticker);
      if (!candles || candles.length < 20) {
        failed.push({ ticker: item.ticker, reason: !candles ? 'no_data' : 'insufficient_candles_' + (candles ? candles.length : 0) });
        continue;
      }

      var analysis = analyzeDayTrade(candles, item.ticker);
      if (!analysis || !analysis.last_price) {
        failed.push({ ticker: item.ticker, reason: 'analysis_failed' });
        continue;
      }

      var scored = scoreDayTrade(analysis, runMode, item.board);
      scored.board = item.board;
      scored.stock_name = item.stock_name || item.ticker;
      results.push(scored);
    } catch (e) {
      failed.push({ ticker: item.ticker, reason: 'exception: ' + (e.message || 'unknown').substring(0, 60) });
    }

    // Rate limit: 200ms between requests
    if (i < tickers.length - 1) {
      await delay(200);
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
  runDayTradeBatch: runDayTradeBatch
};
