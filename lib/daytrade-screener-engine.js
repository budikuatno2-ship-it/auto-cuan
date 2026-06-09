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
// PRE-SPIKE DETECTOR (0-25 score)
// ============================================================

function scorePreSpike(data) {
  var score = 0;

  // Positive change but not too high (sweet spot: 0.3% to 4.5%)
  var chg = data.change_pct;
  if (chg >= 0.3 && chg <= 4.5) score += 7;
  else if (chg > 4.5 && chg <= 7.0) score += 4;
  else if (chg > 0 && chg < 0.3) score += 2;
  else if (chg > 7.0) score += 1; // overheat territory
  else score += 0; // negative = no pre-spike

  // Volume ratio rising (pre-spike = activity building)
  if (data.volume_ratio_20d >= 2.0) score += 6;
  else if (data.volume_ratio_20d >= 1.5) score += 5;
  else if (data.volume_ratio_20d >= 1.2) score += 3;
  else if (data.volume_ratio_20d >= 1.0) score += 2;
  else score += 0;

  // Price near resistance / high (distance to breakout small)
  if (data.distance_to_breakout_pct <= 1.0) score += 5;
  else if (data.distance_to_breakout_pct <= 2.5) score += 4;
  else if (data.distance_to_breakout_pct <= 5.0) score += 2;
  else score += 0;

  // Price above open (intraday strength)
  if (data._priceAboveOpen) score += 3;

  // Range position in upper half but not extreme
  if (data.range_position >= 60 && data.range_position <= 90) score += 4;
  else if (data.range_position >= 40 && data.range_position < 60) score += 2;
  else if (data.range_position > 90) score += 1; // too extended
  else score += 0;

  return Math.min(25, score);
}

// ============================================================
// MOMENTUM SCORE (0-20)
// ============================================================

function scoreMomentum(data) {
  var score = 0;

  // RSI in healthy zone (45-68 ideal for breakout)
  if (data.rsi14 !== null) {
    if (data.rsi14 >= 45 && data.rsi14 <= 68) score += 6;
    else if (data.rsi14 >= 40 && data.rsi14 < 45) score += 4;
    else if (data.rsi14 > 68 && data.rsi14 <= 75) score += 3;
    else if (data.rsi14 > 75) score += 0; // overbought
    else if (data.rsi14 >= 30 && data.rsi14 < 40) score += 2;
    else score += 0;
  }

  // Price vs MA20
  if (data._aboveMA20) score += 5;
  else if (data.ma20 && data.last_price >= data.ma20 * 0.98) score += 2;

  // Price vs MA50
  if (data._aboveMA50) score += 4;
  else if (data.ma50 && data.last_price >= data.ma50 * 0.97) score += 1;

  // Price near high (momentum continuation)
  if (data._priceNearHigh) score += 3;

  // Change positive
  if (data.change_pct > 0) score += 2;

  return Math.min(20, score);
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
// TREND/POSITION SCORE (0-10)
// ============================================================

function scoreTrend(data) {
  var score = 0;

  // Above both MAs = strong trend
  if (data._aboveMA20 && data._aboveMA50) score += 5;
  else if (data._aboveMA20) score += 3;
  else if (data._aboveMA50) score += 2;

  // Positive change streak proxy: change > 0
  if (data.change_pct > 0) score += 2;

  // Range position > 50 (upper half)
  if (data.range_position >= 50) score += 2;

  // Near breakout
  if (data.distance_to_breakout_pct <= 2.0) score += 1;

  return Math.min(10, score);
}

// ============================================================
// PENALTY CALCULATION (-5 to -40)
// ============================================================

function calculatePenalty(data) {
  var penalty = 0;
  var reasons = [];

  // Overheat: change > 7% without excellent volume
  if (data.change_pct > 7.0 && data.volume_ratio_20d < 2.0) {
    penalty -= 15;
    reasons.push('Overheat (Chg>' + data.change_pct.toFixed(1) + '% tanpa volume kuat)');
  } else if (data.change_pct > 8.5) {
    penalty -= 10;
    reasons.push('Chg% sangat tinggi (' + data.change_pct.toFixed(1) + '%)');
  }

  // False breakout: faded from high significantly
  if (data._fadeFromHigh > 0.5 && data.change_pct > 2.0) {
    penalty -= 10;
    reasons.push('Fade dari high (wick ' + round0(data._fadeFromHigh * 100) + '%)');
  }

  // Price below open despite volume (distribution)
  if (!data._priceAboveOpen && data.volume_ratio_20d >= 1.5) {
    penalty -= 8;
    reasons.push('Price < open dengan volume tinggi');
  }

  // Overextended from MA20
  if (data._overextendedMA20) {
    penalty -= 8;
    reasons.push('Overextended dari MA20');
  }

  // RSI overbought
  if (data.rsi14 !== null && data.rsi14 > 80) {
    penalty -= 5;
    reasons.push('RSI overbought (' + data.rsi14.toFixed(0) + ')');
  }

  // Negative change with weak volume (no interest)
  if (data.change_pct < -2.0 && data.volume_ratio_20d < 0.8) {
    penalty -= 5;
    reasons.push('Turun tanpa minat');
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
// STATUS CLASSIFICATION (with hard guards)
// ============================================================

function classifyStatus(compositeScore, data, levels, liqResult, penaltyResult, board) {
  // Hard guards that prevent READY_BREAKOUT regardless of score
  var hardFails = [];

  // Papan Akselerasi hard guard — cannot be READY_BREAKOUT
  if (board && board.toUpperCase() === 'AKSELERASI') {
    hardFails.push('Papan Akselerasi (excluded)');
  }

  if (!liqResult.pass) {
    return { status: 'AVOID', setup: 'Avoid - Liquidity Risk', notes: liqResult.reason };
  }

  if (levels.risk_reward < 1.5) {
    hardFails.push('RR < 1.5 (' + levels.risk_reward.toFixed(2) + ')');
  }

  if (levels._riskDistPct > 5.0) {
    hardFails.push('Risk terlalu jauh (' + levels._riskDistPct.toFixed(1) + '%)');
  }

  if (data.change_pct > 7.0 && data.volume_ratio_20d < 2.0) {
    hardFails.push('Overheat');
  }

  if (data._overextendedMA20) {
    hardFails.push('Overextended MA20');
  }

  if (data.rsi14 !== null && data.rsi14 > 80) {
    hardFails.push('RSI overbought');
  }

  // Classification
  var status, setup, notes;

  if (compositeScore >= 85 && hardFails.length === 0) {
    status = 'READY_BREAKOUT';
    setup = determineSetup(data, 'ready');
    notes = 'Setup lengkap: liquid, momentum kuat, RR layak, belum overheat.';
  } else if (compositeScore >= 75 && hardFails.length === 0) {
    status = 'PRE_SPIKE_WATCH';
    setup = determineSetup(data, 'prespike');
    notes = 'Pressure building. Tunggu konfirmasi breakout.';
  } else if (compositeScore >= 75 && hardFails.length > 0) {
    status = 'WAIT_PULLBACK';
    setup = 'Pullback Intraday';
    notes = 'Score tinggi tapi: ' + hardFails.join(', ') + '. Tunggu pullback.';
  } else if (compositeScore >= 70 && data.distance_to_breakout_pct <= 2.0) {
    status = 'PRE_SPIKE_WATCH';
    setup = determineSetup(data, 'prespike');
    notes = 'Dekat breakout zone. Monitor volume.';
  } else if (compositeScore >= 65 && data._priceAboveOpen && data.range_position >= 50) {
    // Check if reclaim candidate
    if (data.ma20 && data.last_price >= data.ma20 * 0.98 && data.last_price <= data.ma20 * 1.02) {
      status = 'RECLAIM_CANDIDATE';
      setup = 'Reclaim Candidate';
      notes = 'Mencoba reclaim MA20. Entry jika confirm above.';
    } else {
      status = 'MOMENTUM_CONTINUATION';
      setup = 'Momentum Continuation';
      notes = 'Masih bergerak. RR perlu dievaluasi.';
    }
  } else if (compositeScore >= 65) {
    status = 'SPECULATIVE';
    setup = determineSetup(data, 'speculative');
    notes = hardFails.length > 0 ? hardFails.join(', ') : 'Setup belum kuat. Risk tinggi.';
  } else {
    status = 'AVOID';
    setup = determineAvoidSetup(data, penaltyResult);
    notes = hardFails.length > 0 ? hardFails.join(', ') : (penaltyResult.reasons.length > 0 ? penaltyResult.reasons[0] : 'Score rendah, setup tidak layak.');
  }

  return { status: status, setup: setup, notes: notes };
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
  return 'Avoid - Poor RR';
}

// ============================================================
// TIME PLAN GENERATION
// ============================================================

function generateTimePlan(status, runMode, data) {
  if (status === 'AVOID') return 'Tidak disarankan entry hari ini.';

  var base = '';
  if (runMode === 'MORNING_SCOUT') {
    base = 'Entry pagi jika konfirmasi volume. ';
  } else if (runMode === 'MIDDAY_CHECK') {
    base = 'Entry siang jika breakout confirm. ';
  } else if (runMode === 'AFTERNOON_EXIT') {
    base = 'Late entry berisiko. Prioritas exit sebelum close. ';
  } else {
    base = 'Monitor sesi berikutnya. ';
  }

  if (status === 'READY_BREAKOUT') {
    return base + 'Entry area valid. Exit sebelum 14:50 jika TP belum hit.';
  }
  if (status === 'PRE_SPIKE_WATCH') {
    return base + 'Tunggu volume spike + break resistance. Jangan chase.';
  }
  if (status === 'WAIT_PULLBACK') {
    return base + 'Jangan entry sekarang. Tunggu pullback ke entry area.';
  }
  if (status === 'RECLAIM_CANDIDATE') {
    return base + 'Entry hanya jika price confirm di atas MA20.';
  }
  if (status === 'MOMENTUM_CONTINUATION') {
    return base + 'Gunakan tight SL. Exit jika momentum melemah.';
  }
  return base + 'Risky setup. Small position only.';
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

  // 8. Classify (pass board for Akselerasi hard guard)
  var classification = classifyStatus(compositeScore, data, levels, liqResult, penaltyResult, board);

  // 9. Time plan
  var timePlan = generateTimePlan(classification.status, runMode, data);

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
    run_mode: runMode
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
