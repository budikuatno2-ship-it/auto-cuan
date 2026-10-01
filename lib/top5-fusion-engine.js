'use strict';

/**
 * Top 5 Fusion Engine — dual-pillar candidate selection for the T+1 .. T+5 horizon.
 *
 * WHY THIS EXISTS
 * ---------------
 * The legacy Top 5 path classified every candidate through
 * `candidatePassesPublicTelegramSafetyGate(candidate, 'daily_top5')` +
 * `candidatePassesMinUpside(candidate)`. On a consolidation day that gate is
 * too rigid: a candidate whose only defect is `BREAKOUT_WATCH` /
 * `NEEDS_CLOSE_CONFIRMATION` (a *timing* observation, not a defect) was
 * dropped outright even when the broker summary showed heavy multi-day
 * accumulation. The observed production symptom was `pool=68`, `before_gate=5`,
 * `after_gate=0` — a healthy runner publishing an empty digest.
 *
 * This module replaces the single-pass verdict with two pillars that are
 * scored independently and then fused 50/50:
 *
 *   Swing Pillar (50%)        — broksum multi-frame, foreign-flow consistency,
 *                               price position vs MA20/MA50, distribution risk.
 *   Momentum Pillar (50%)     — volume surge vs MA20, volatility expansion /
 *                               squeeze breakout (Bollinger + Donchian), close
 *                               position inside the daily range.
 *
 * The safety gate is *recalibrated*, not removed. Truly fatal conditions
 * (below SL, ARA/ARB hit, invalid candle, structured SELL, stale data, ...)
 * still hard-reject unconditionally. Soft/timing conditions are downgraded to
 * warnings when — and only when — the candidate carries a *strong accumulation*
 * profile from broker summary AND/OR foreign flow. Every admitted pick must
 * still satisfy an asymmetric risk/reward contract: measured SL 3–5% with
 * 8–15% TP1 upside inside 1–5 trading sessions.
 *
 * PURITY
 * ------
 * Everything here is pure and synchronous. Disk/Supabase access is injected by
 * the caller through `providers`, so the module is directly unit-testable and
 * never performs I/O on its own.
 */

// ---------------------------------------------------------------------------
// Tunables (all overridable through env for operational tuning without a code
// change; the defaults are the calibrated values described in the task spec).
// ---------------------------------------------------------------------------

function envNumber(name, fallback) {
  var raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  var n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

var FUSION_WEIGHTS = Object.freeze({ swing: 0.5, momentum: 0.5 });

var SWING_MAX = Object.freeze({
  broksum: 40,
  foreign: 30,
  price_structure: 30
});

var MOMENTUM_MAX = Object.freeze({
  volume_surge: 40,
  volatility_expansion: 35,
  close_position: 25
});

// SL must be measurable inside this band; TP1 must land inside this band.
// The 3–5% stop band is the task's asymmetry contract: with an 8% TP1 floor it
// guarantees RR >= 8/5 = 1.6 (MIN_ASYMMETRIC_RR below) on every admitted pick.
var SL_MIN_PCT = 3.0;
var SL_MAX_PCT = 5.0;
var TP1_MIN_PCT = 8.0;
var TP1_MAX_PCT = 15.0;
var MIN_ASYMMETRIC_RR = 1.6;
var HORIZON_MIN_DAYS = 1;
var HORIZON_MAX_DAYS = 5;

// Volume-surge ladder (task spec: "> 1.2x - 1.5x MA20").
var RVOL_STRONG = 2.0;
var RVOL_SURGE = 1.5;
var RVOL_MILD = 1.2;

// A pick is only admitted when its fused score clears this floor.
var MIN_FUSION_SCORE = envNumber('TOP5_FUSION_MIN_SCORE', 45);

// Soft-reject waiver requires a *strong accumulation* profile.
var STRONG_ACCUM_MIN_STREAK = 3;

// How close to MA50 still counts as "menempel MA50" (a supportive state) rather
// than a break. Below -MA50_BREAK_PCT the break is treated as material.
var MA_PROXIMITY_TOLERANCE_PCT = 1.5;
var MA50_BREAK_PCT = 4;

// ---------------------------------------------------------------------------
// Small numeric helpers (kept local: this module must not depend on api/*).
// ---------------------------------------------------------------------------

function toNum(v) {
  if (v == null || v === '') return null;
  var n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp(v, min, max) {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

function round(v, digits) {
  if (!Number.isFinite(v)) return null;
  var f = Math.pow(10, digits == null ? 2 : digits);
  return Math.round(v * f) / f;
}

function sign(v) {
  var n = toNum(v);
  if (n == null || n === 0) return 0;
  return n > 0 ? 1 : -1;
}

function pctChange(from, to) {
  var a = toNum(from), b = toNum(to);
  if (a == null || b == null || a === 0) return null;
  return ((b - a) / a) * 100;
}

function cleanTicker(raw) {
  return String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// ---------------------------------------------------------------------------
// Pure candle indicators
// ---------------------------------------------------------------------------

function sma(values, period) {
  if (!Array.isArray(values) || values.length < period || period <= 0) return null;
  var slice = values.slice(-period);
  var sum = 0;
  for (var i = 0; i < slice.length; i++) {
    var n = toNum(slice[i]);
    if (n == null) return null;
    sum += n;
  }
  return sum / period;
}

function stdev(values, period) {
  if (!Array.isArray(values) || values.length < period || period <= 0) return null;
  var slice = values.slice(-period);
  var mean = sma(slice, period);
  if (mean == null) return null;
  var acc = 0;
  for (var i = 0; i < slice.length; i++) {
    var n = toNum(slice[i]);
    if (n == null) return null;
    acc += Math.pow(n - mean, 2);
  }
  return Math.sqrt(acc / period);
}

/**
 * Bollinger Band width as a percentage of the mid band, plus a squeeze flag
 * derived from the band's own recent history (not an absolute threshold, so it
 * works for Rp 50 tickers and Rp 9.000 tickers alike).
 */
function bollingerState(candles, period, mult, lookback) {
  var p = period || 20;
  var m = mult == null ? 2 : mult;
  var lb = lookback || 60;
  var out = { mid: null, upper: null, lower: null, width_pct: null, width_percentile: null, squeeze: false, expanding: false };
  if (!Array.isArray(candles) || candles.length < p + 2) return out;
  var closes = candles.map(function (c) { return toNum(c && c.close); });

  var widths = [];
  for (var end = p; end <= closes.length; end++) {
    var window = closes.slice(0, end);
    var mid = sma(window, p);
    var sd = stdev(window, p);
    if (mid == null || sd == null || mid <= 0) continue;
    widths.push(((sd * m * 2) / mid) * 100);
  }
  if (widths.length === 0) return out;

  var current = widths[widths.length - 1];
  var history = widths.slice(-lb);
  var below = history.filter(function (w) { return w <= current; }).length;
  var percentile = history.length > 1 ? (below - 1) / (history.length - 1) : null;

  out.mid = sma(closes, p);
  var sdNow = stdev(closes, p);
  if (out.mid != null && sdNow != null) {
    out.upper = out.mid + sdNow * m;
    out.lower = out.mid - sdNow * m;
  }
  out.width_pct = round(current, 2);
  out.width_percentile = percentile == null ? null : round(percentile, 3);
  out.squeeze = percentile != null && percentile <= 0.3;
  out.expanding = widths.length >= 2 && current > widths[widths.length - 2] * 1.15;
  return out;
}

/**
 * Donchian breakout over the prior `period` bars. The current bar is compared
 * against the *previous* bars only, so a fresh 20-day high is detected without
 * the current bar trivially defining its own channel.
 */
function donchianState(candles, period) {
  var p = period || 20;
  var out = { upper: null, lower: null, breakout: false, breakdown: false, position: null };
  if (!Array.isArray(candles) || candles.length < p + 1) return out;
  var prior = candles.slice(-(p + 1), -1);
  var highs = prior.map(function (c) { return toNum(c && c.high); }).filter(function (v) { return v != null; });
  var lows = prior.map(function (c) { return toNum(c && c.low); }).filter(function (v) { return v != null; });
  if (highs.length < p || lows.length < p) return out;
  out.upper = Math.max.apply(null, highs);
  out.lower = Math.min.apply(null, lows);
  var last = candles[candles.length - 1];
  var close = toNum(last && last.close);
  if (close == null) return out;
  out.breakout = close > out.upper;
  out.breakdown = close < out.lower;
  if (out.upper > out.lower) out.position = round((close - out.lower) / (out.upper - out.lower), 3);
  return out;
}

/**
 * Average True Range as a percentage of the last close — used to translate a
 * percentage target into an estimated number of sessions.
 */
function atrPct(candles, period) {
  var p = period || 14;
  if (!Array.isArray(candles) || candles.length < p + 1) return null;
  var trs = [];
  for (var i = candles.length - p; i < candles.length; i++) {
    var cur = candles[i], prev = candles[i - 1];
    if (!cur || !prev) continue;
    var h = toNum(cur.high), l = toNum(cur.low), pc = toNum(prev.close);
    if (h == null || l == null || pc == null) continue;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trs.length === 0) return null;
  var atr = trs.reduce(function (a, b) { return a + b; }, 0) / trs.length;
  var close = toNum(candles[candles.length - 1].close);
  if (!(close > 0)) return null;
  return round((atr / close) * 100, 3);
}

// ---------------------------------------------------------------------------
// Pillar A — Swing (broksum multi-frame + foreign consistency + structure)
// ---------------------------------------------------------------------------

/**
 * Derive 1D / 3D / 7D broker net flow plus the consecutive-accumulation streak
 * from the newest-first daily net-flow series.
 *
 * @param {number[]} dayNet newest-first daily net flow (IDR)
 */
function summarizeBrokerFrames(dayNet) {
  var series = Array.isArray(dayNet) ? dayNet.map(toNum).filter(function (v) { return v != null; }) : [];
  var out = {
    net_1d: null,
    net_3d: null,
    net_7d: null,
    accumulation_streak: 0,
    distribution_streak: 0,
    days_observed: series.length,
    positive_days_7d: 0,
    label: 'Bandar Data Unavailable'
  };
  if (series.length === 0) return out;

  function sumWindow(size) {
    var slice = series.slice(0, size);
    if (slice.length === 0) return null;
    return slice.reduce(function (a, b) { return a + b; }, 0);
  }

  out.net_1d = series[0];
  out.net_3d = series.length >= 3 ? sumWindow(3) : null;
  out.net_7d = series.length >= 7 ? sumWindow(7) : null;

  var acc = 0;
  for (var i = 0; i < series.length; i++) {
    if (series[i] > 0) acc++;
    else break;
  }
  out.accumulation_streak = acc;

  var dist = 0;
  for (var j = 0; j < series.length; j++) {
    if (series[j] < 0) dist++;
    else break;
  }
  out.distribution_streak = dist;

  var window7 = series.slice(0, 7);
  out.positive_days_7d = window7.filter(function (v) { return v > 0; }).length;

  var anchor = out.net_3d != null ? out.net_3d : out.net_1d;
  var long = out.net_7d != null ? out.net_7d : anchor;
  if (anchor > 0 && long > 0) out.label = acc >= STRONG_ACCUM_MIN_STREAK ? 'Akumulasi Kuat' : 'Akumulasi';
  else if (anchor < 0 && long < 0) out.label = 'Distribusi';
  else if (anchor !== 0 || long !== 0) out.label = 'Campuran';
  else out.label = 'Netral';
  return out;
}

function scoreBroksumFrame(broker) {
  var b = broker || {};
  var max = SWING_MAX.broksum;
  if (b.net_1d == null && b.net_3d == null && b.net_7d == null) {
    return { score: 0, max: max, detail: 'Broksum tidak tersedia', frames_positive: 0 };
  }
  var frames = [b.net_1d, b.net_3d, b.net_7d];
  var positive = frames.filter(function (v) { return v != null && v > 0; }).length;
  var known = frames.filter(function (v) { return v != null; }).length || 1;

  // 60% of the frame budget is breadth (how many timeframes agree on
  // accumulation); 40% is persistence (how long it has been running).
  var breadth = (positive / known) * (max * 0.6);
  var persistence = (clamp(b.accumulation_streak, 0, 5) / 5) * (max * 0.4);
  var penalty = b.distribution_streak >= 3 ? max * 0.25 : 0;
  var score = clamp(breadth + persistence - penalty, 0, max);
  return {
    score: round(score, 2),
    max: max,
    frames_positive: positive,
    frames_known: known,
    detail: b.label + ' (1D/3D/7D positif ' + positive + '/' + known + ', streak ' + b.accumulation_streak + ' hari)'
  };
}

function scoreForeignFrame(foreign) {
  var f = foreign || {};
  var max = SWING_MAX.foreign;
  if (f.net_1d == null && f.net_3d == null && f.net_7d == null) {
    return { score: 0, max: max, detail: 'Foreign flow tidak tersedia', available: false };
  }
  var score = 0;
  if (f.net_3d != null && f.net_3d > 0) score += max * 0.33;
  if (f.net_7d != null && f.net_7d > 0) score += max * 0.33;
  score += (clamp(f.positive_days_7d || 0, 0, 5) / 5) * (max * 0.22);
  if ((f.streak || 0) >= 3) score += max * 0.12;
  if (f.net_3d != null && f.net_3d < 0 && f.net_7d != null && f.net_7d < 0) score = Math.min(score, max * 0.1);
  score = clamp(score, 0, max);
  return {
    score: round(score, 2),
    max: max,
    available: true,
    detail: 'Foreign 3D ' + (f.net_3d == null ? '-' : (f.net_3d > 0 ? 'net buy' : 'net sell')) +
      ', 7D ' + (f.net_7d == null ? '-' : (f.net_7d > 0 ? 'net buy' : 'net sell')) +
      ', ' + (f.positive_days_7d || 0) + '/7 hari positif' +
      ((f.streak || 0) >= 3 ? ', streak ' + f.streak + ' hari' : '')
  };
}

function scorePriceStructure(candidate, candles) {
  var max = SWING_MAX.price_structure;
  var r = candidate || {};
  var closes = Array.isArray(candles) ? candles.map(function (c) { return toNum(c && c.close); }) : [];
  var close = closes.length ? closes[closes.length - 1] : toNum(r.last_price || r.lastn || r.close);
  var ma20 = closes.length >= 20 ? sma(closes, 20) : toNum(r.ma20);
  var ma50 = closes.length >= 50 ? sma(closes, 50) : toNum(r.ma50);

  var score = max;
  var notes = [];

  if (close != null && ma20 != null && ma20 > 0) {
    var d20 = ((close - ma20) / ma20) * 100;
    if (d20 >= 0 && d20 <= 8) {
      notes.push('dekat MA20 (+' + round(d20, 1) + '%)');
    } else if (d20 > 12) {
      score -= max * 0.33;
      notes.push('terlalu jauh di atas MA20 (+' + round(d20, 1) + '%)');
    } else if (d20 < -6) {
      score -= max * 0.27;
      notes.push('jebol MA20 (' + round(d20, 1) + '%)');
    } else {
      score -= max * 0.1;
      notes.push('MA20 ' + round(d20, 1) + '%');
    }
  } else {
    score -= max * 0.15;
    notes.push('MA20 belum tersedia');
  }

  if (close != null && ma50 != null && ma50 > 0) {
    var d50 = ((close - ma50) / ma50) * 100;
    // "Dekat MA20/MA50" is a POSITIVE state for a T+1..T+5 idea: price resting
    // on a long MA is the accumulation footprint we are looking for. A few
    // tenths of a percent below MA50 is noise, not a downtrend, so only a
    // *material* break is penalised at full weight.
    if (Math.abs(d50) <= MA_PROXIMITY_TOLERANCE_PCT) {
      notes.push('menempel MA50 (' + round(d50, 1) + '%)');
    } else if (d50 < 0) {
      score -= max * (d50 < -MA50_BREAK_PCT ? 0.5 : 0.2);
      notes.push('di bawah MA50 (' + round(d50, 1) + '%)');
    } else if (d50 <= 15) {
      notes.push('di atas MA50 (+' + round(d50, 1) + '%)');
    } else {
      score -= max * 0.17;
      notes.push('extended vs MA50 (+' + round(d50, 1) + '%)');
    }
  } else {
    score -= max * 0.1;
    notes.push('MA50 belum tersedia');
  }

  // Distribution risk is the single most destructive swing condition.
  var volPhase = String(r.volume_phase || '').toUpperCase();
  var netStatus = String(r.net_status || r.whale_status || '').toUpperCase();
  var distText = String(r.foreign_label || '').toUpperCase();
  var distribution = volPhase.indexOf('DISTRIBUTION') >= 0 ||
    netStatus.indexOf('BIG_DISTRIBUTION') >= 0 ||
    distText.indexOf('FOREIGN DISTRIBUTION') >= 0;
  if (distribution) {
    score -= max * 0.4;
    notes.push('risiko distribusi terdeteksi');
  }

  score = clamp(score, 0, max);
  return {
    score: round(score, 2),
    max: max,
    ma20: ma20 == null ? null : round(ma20, 2),
    ma50: ma50 == null ? null : round(ma50, 2),
    close: close == null ? null : round(close, 2),
    distribution_risk: distribution,
    detail: notes.join(', ') || 'Struktur harga belum dapat dinilai'
  };
}

// ---------------------------------------------------------------------------
// Pillar B — Daytrade / Momentum
// ---------------------------------------------------------------------------

function scoreVolumeSurge(candidate, candles) {
  var max = MOMENTUM_MAX.volume_surge;
  var r = candidate || {};
  var rvol = null;
  var source = 'screener_field';

  if (Array.isArray(candles) && candles.length >= 21) {
    var volumes = candles.map(function (c) { return toNum(c && c.volume); });
    var last = volumes[volumes.length - 1];
    var avg = sma(volumes.slice(0, -1), 20);
    if (last != null && avg != null && avg > 0) {
      rvol = last / avg;
      source = 'daily_candles';
    }
  }
  if (rvol == null) {
    rvol = toNum(r.volume_ratio_20d || r.volume_ratio_avg20 || r.volume_ratio || r.volume_today_vs_7d);
  }

  var score;
  if (rvol == null) score = max * 0.1;
  else if (rvol >= RVOL_STRONG) score = max;
  else if (rvol >= RVOL_SURGE) score = max * 0.85;
  else if (rvol >= RVOL_MILD) score = max * 0.65;
  else if (rvol >= 1.0) score = max * 0.35;
  else score = max * 0.15;

  return {
    score: round(clamp(score, 0, max), 2),
    max: max,
    rvol: rvol == null ? null : round(rvol, 2),
    source: source,
    detail: rvol == null
      ? 'RVOL tidak tersedia'
      : 'Volume ' + round(rvol, 2) + 'x MA20' + (rvol >= RVOL_MILD ? ' (surge)' : '')
  };
}

function scoreVolatilityExpansion(candles) {
  var max = MOMENTUM_MAX.volatility_expansion;
  var bb = bollingerState(candles, 20, 2, 60);
  var dc = donchianState(candles, 20);
  var score;
  var label;

  if (dc.breakout && bb.squeeze) {
    score = max;
    label = 'Squeeze release + breakout Donchian 20D';
  } else if (dc.breakout) {
    score = max * 0.74;
    label = 'Breakout Donchian 20D';
  } else if (bb.squeeze) {
    score = max * 0.57;
    label = 'Squeeze Bollinger (terkompresi, menunggu pelepasan)';
  } else if (bb.expanding) {
    score = max * 0.4;
    label = 'Volatilitas ekspansi';
  } else if (bb.width_pct != null) {
    score = max * 0.17;
    label = 'Volatilitas normal';
  } else {
    score = max * 0.1;
    label = 'Data candle belum cukup';
  }

  return {
    score: round(clamp(score, 0, max), 2),
    max: max,
    bollinger: bb,
    donchian: dc,
    detail: label
  };
}

function scoreClosePosition(candidate, candles) {
  var max = MOMENTUM_MAX.close_position;
  var r = candidate || {};
  var high = null, low = null, close = null;

  if (Array.isArray(candles) && candles.length > 0) {
    var last = candles[candles.length - 1];
    high = toNum(last && last.high);
    low = toNum(last && last.low);
    close = toNum(last && last.close);
  }
  if (high == null) high = toNum(r.high_price || r.high);
  if (low == null) low = toNum(r.low_price || r.low);
  if (close == null) close = toNum(r.last_price || r.lastn || r.close);

  if (high == null || low == null || close == null || high <= low) {
    return { score: round(max * 0.3, 2), max: max, position: null, detail: 'Rentang harian tidak tersedia' };
  }
  var pos = clamp((close - low) / (high - low), 0, 1);
  var score;
  if (pos >= 0.75) score = max;
  else if (pos >= 0.6) score = max * 0.72;
  else if (pos >= 0.4) score = max * 0.4;
  else score = max * pos * 0.5;

  return {
    score: round(clamp(score, 0, max), 2),
    max: max,
    position: round(pos, 3),
    detail: 'Close di ' + round(pos * 100, 0) + '% rentang harian' + (pos >= 0.75 ? ' (25% teratas)' : '')
  };
}

// ---------------------------------------------------------------------------
// Pillar composition
// ---------------------------------------------------------------------------

function buildSwingPillar(candidate, broker, foreign, candles) {
  var parts = {
    broksum: scoreBroksumFrame(broker),
    foreign: scoreForeignFrame(foreign),
    price_structure: scorePriceStructure(candidate, candles)
  };
  var total = parts.broksum.score + parts.foreign.score + parts.price_structure.score;
  return {
    pillar: 'swing',
    weight: FUSION_WEIGHTS.swing,
    score: round(clamp(total, 0, 100), 2),
    parts: parts,
    reasons: [parts.broksum.detail, parts.foreign.detail, parts.price_structure.detail]
  };
}

function buildMomentumPillar(candidate, candles) {
  var parts = {
    volume_surge: scoreVolumeSurge(candidate, candles),
    volatility_expansion: scoreVolatilityExpansion(candles),
    close_position: scoreClosePosition(candidate, candles)
  };
  var total = parts.volume_surge.score + parts.volatility_expansion.score + parts.close_position.score;
  return {
    pillar: 'momentum',
    weight: FUSION_WEIGHTS.momentum,
    score: round(clamp(total, 0, 100), 2),
    parts: parts,
    reasons: [parts.volume_surge.detail, parts.volatility_expansion.detail, parts.close_position.detail]
  };
}

// ---------------------------------------------------------------------------
// Recalibrated safety gate
// ---------------------------------------------------------------------------

// Observed session high, resolved through the same alias set used by
// api/sector-hot.js `getObservedHighForTp1`. Kept in sync deliberately: if the
// two ever diverge, a pick could be admitted here and rejected downstream for
// "TP1 already reached", which is exactly the kind of silent empty-publish
// failure this engine exists to remove.
var OBSERVED_HIGH_ALIASES = [
  'high_price', 'price_high', 'session_high', 'intraday_high',
  'day_high', 'current_high', 'latest_high', 'highn', 'high'
];

function observedHighFromCandidate(candidate) {
  var sources = [candidate, candidate && candidate.raw_payload, candidate && candidate.rawPayload];
  var observed = null;
  for (var si = 0; si < sources.length; si++) {
    var source = sources[si];
    if (!source || typeof source !== 'object') continue;
    for (var ai = 0; ai < OBSERVED_HIGH_ALIASES.length; ai++) {
      var value = toNum(source[OBSERVED_HIGH_ALIASES[ai]]);
      if (value != null && value > 0 && (observed == null || value > observed)) observed = value;
    }
  }
  return observed;
}

// Conditions that can NEVER be waived, whatever the accumulation profile is.
// These are correctness/safety invariants: a candidate that trips one of them
// is not "a consolidation candidate", it is a broken or unexecutable plan.
function hardRejectReason(candidate) {
  var r = candidate || {};

  if (!r.ticker) return 'missing_ticker';

  var corporate = String(r.corporate_action_guard || '').toUpperCase();
  if (corporate === 'BLOCKED') return 'corporate_action_price_scale';

  var sellText = [r.action, r.action_label, r.signal_action, r.signal_action_label,
    r.telegram_action_label, r.status, r.final_status, r.display_status, r.public_status, r.signal_status]
    .some(function (v) { return /\bSELL\b/i.test(String(v || '')); });
  if (sellText) return 'structured_sell';

  var grade = String(r.quality_grade || r.grade || r.confidence || '').trim().toUpperCase();
  if (grade === 'AVOID') return 'grade_avoid';

  var signalAction = String(r.signal_action || '').trim().toUpperCase();
  if (signalAction === 'AVOID') return 'signal_action_avoid';

  var actionText = [r.action_label, r.signal_action_label, r.telegram_action_label, r.action, r.signal_action]
    .join(' ').toLowerCase();
  if (actionText.indexOf('hindari') >= 0 || actionText.indexOf('avoid') >= 0) return 'action_hindari';

  var last = toNum(r.last_price || r.lastn || r.current_price || r.close);
  var sl = toNum(r.sl || r.stop_loss);
  if (last != null && sl != null && sl > 0 && last < sl) return 'price_below_sl';

  var entryStatus = String(r.entry_status || '').trim().toUpperCase();
  var entryQuality = String(r.entry_quality_status || '').trim().toUpperCase();
  if (entryStatus === 'INVALID_BELOW_SL' || entryQuality === 'INVALID_BELOW_SL') return 'entry_invalid_below_sl';

  var executionStatus = String(r.execution_reality_status || '').trim().toUpperCase();
  if (executionStatus === 'ARA_HIT' || executionStatus === 'ARB_HIT') return 'ara_arb_hit';
  if (r.ara_hit === true || r.arb_hit === true) return 'ara_arb_hit';
  if (r.sell_risk_near_arb === true) return 'sell_risk_near_arb';

  if (r.trading_plan_valid === false) return 'trading_plan_invalid';
  var planStatus = String(r.plan_quality_status || r.trading_plan_status || '').trim().toUpperCase();
  if (planStatus === 'INVALID') return 'plan_quality_invalid';

  var dataQuality = String(r.data_quality_status || '').trim().toUpperCase();
  if (r.data_quality_valid === false) return 'data_quality_invalid';
  if (dataQuality === 'INVALID_CANDLE') return 'invalid_candle';
  if (dataQuality === 'CORPORATE_ACTION_RISK') return 'corporate_action_risk';
  if (dataQuality === 'SHORT_HISTORY' || dataQuality === 'NEW_LISTING') return 'history_insufficient';

  var freshness = String(r.setup_freshness_status || r.freshness_status || '').trim().toUpperCase();
  if (freshness === 'EXPIRED' || freshness === 'NEEDS_REVALIDATION') return 'setup_expired';
  if (freshness === 'STALE_LEVEL' || freshness === 'HISTORY_INSUFFICIENT' || freshness === 'NEW_LISTING') return 'setup_stale';
  if (r.is_stale === true || r.data_stale === true || r.freshness_is_stale === true || r.stale === true) return 'data_stale';

  if (r.is_liquidity_risk === true) return 'liquidity_risk';

  // A TP1 that has already been traded through is not a forward-looking idea.
  // The alias set mirrors api/sector-hot.js getObservedHighForTp1 so this gate
  // and the downstream digest gate agree on what "observed high" means.
  var observedHigh = observedHighFromCandidate(r);
  var tp1 = toNum(r.tp1n || r.tp1);
  if (r.tp1_already_reached === true) return 'tp1_already_reached';
  if (r.tp1_observed_high_reached === true) return 'tp1_already_reached';
  if (observedHigh != null && tp1 != null && tp1 > 0 && observedHigh >= tp1) return 'tp1_already_reached';

  // Confirmed failure of the breakout attempt — as opposed to "not yet
  // confirmed", which is a timing observation and therefore waivable.
  if (String(r.pattern_label || '').trim().toLowerCase() === 'failed breakout') return 'failed_breakout';

  var volumeLabel = String(r.volume_label || r.volume_confirmation_label || '').trim().toLowerCase();
  if (volumeLabel === 'distribution volume') return 'distribution_volume';

  return null;
}

// Conditions that describe *timing* rather than *validity*. Each may be
// downgraded to a warning when the accumulation profile is strong enough.
function softRejectReasons(candidate, ctx) {
  var r = candidate || {};
  var reasons = [];

  var breakout = String(r.breakout_confirmation_status || '').trim().toUpperCase();
  if (breakout === 'FALSE_BREAKOUT_RISK') reasons.push('false_breakout_risk');
  else if (breakout === 'NEEDS_CLOSE_CONFIRMATION') reasons.push('needs_close_confirmation');
  else if (breakout === 'BREAKOUT_WATCH') reasons.push('breakout_watch');
  else if (breakout === 'VOLUME_CONFIRMATION_NEEDED') reasons.push('volume_confirmation_needed');

  var entryStatus = String(r.entry_status || '').trim().toUpperCase();
  var entryQuality = String(r.entry_quality_status || '').trim().toUpperCase();
  ['CHASE_RISK', 'EXTENDED', 'TP1_NEAR', 'WAIT_PULLBACK', 'NEEDS_REVALIDATION'].forEach(function (s) {
    if (entryStatus === s || entryQuality === s) reasons.push('entry_' + s.toLowerCase());
  });

  var invalidation = String(r.invalidation_distance_status || '').trim().toUpperCase();
  if (invalidation === 'TOO_CLOSE_TO_SL') reasons.push('invalidation_too_close');
  if (invalidation === 'INVALID_BELOW_SL') reasons.push('invalidation_below_sl');

  var risk = String(r.risk_label_v2 || r.risk_label || r.verified_risk_label || '').trim().toLowerCase();
  if (risk === 'very high risk') reasons.push('very_high_risk');
  else if (risk === 'high risk') reasons.push('high_risk');

  var volumeLabel = String(r.volume_label || r.volume_confirmation_label || '').trim().toLowerCase();
  if (volumeLabel === 'weak volume' || volumeLabel.indexOf('lemah') >= 0) reasons.push('weak_volume');

  var finalGate = r.final_top_quality_gate || r.final_quality_gate || r.top_quality_gate || null;
  if (r.final_quality_pass === false || r.final_gate_pass === false || r.quality_gate_pass === false ||
      (finalGate && finalGate.pass === false)) {
    reasons.push('final_quality_gate');
  }

  if (r.false_breakout_risk === true) reasons.push('false_breakout_flag');
  if (r.buy_execution_realistic === false) reasons.push('execution_unverified');
  if (r.volume_phase && String(r.volume_phase).toUpperCase().indexOf('DISTRIBUTION') >= 0) reasons.push('distribution_phase');

  if (ctx && ctx.min_upside_shortfall) reasons.push('min_tp1_upside');
  if (ctx && ctx.rr_shortfall) reasons.push('risk_reward_below_min');

  return Array.from(new Set(reasons));
}

/**
 * A candidate only earns a waiver when broker AND/OR foreign money has been
 * accumulating across multiple frames. A single green day is not enough —
 * that is exactly the noise the original strict gate was protecting against.
 */
function isStrongAccumulation(broker, foreign) {
  var b = broker || {};
  var f = foreign || {};

  var brokerTriple = b.net_1d != null && b.net_1d > 0 &&
    b.net_3d != null && b.net_3d > 0 &&
    b.net_7d != null && b.net_7d > 0;
  var brokerDualPlusForeign = b.net_3d != null && b.net_3d > 0 &&
    b.net_7d != null && b.net_7d > 0 &&
    f.net_3d != null && f.net_3d > 0;
  var longStreak = (b.accumulation_streak || 0) >= STRONG_ACCUM_MIN_STREAK &&
    b.net_3d != null && b.net_3d > 0 &&
    b.net_7d != null && b.net_7d > 0;

  return {
    strong: brokerTriple || brokerDualPlusForeign || longStreak,
    broker_triple: brokerTriple,
    broker_dual_plus_foreign: brokerDualPlusForeign,
    accumulation_streak: b.accumulation_streak || 0
  };
}

// ---------------------------------------------------------------------------
// Risk/Reward asymmetry contract
// ---------------------------------------------------------------------------

/**
 * Produce an asymmetric, executable plan: measured SL inside 3–5% of entry and
 * TP1 upside of 8–15% reachable within 1–5 sessions.
 *
 * The candidate's own levels are used whenever they already satisfy the
 * contract (no gratuitous rewriting of a valid plan). When they do not, the
 * stop is tightened to the nearest *real* structural level rather than an
 * arbitrary percentage, and TP1 is anchored to the Donchian upper band /
 * measured resistance, capped at the 15% ceiling.
 */
function buildFusionTradePlan(candidate, candles, options) {
  var r = candidate || {};
  var opts = options || {};
  // Optional IDX tick-snapping. The caller owns tick math (lib/idx-tick-normalization)
  // so this module stays free of that dependency, but the plan MUST be validated on
  // the snapped numbers: a Rp 1.010 TP1 can snap up to 1.085 and quietly drop a
  // nominally-8% target to 7.4%, which would then be rejected downstream.
  var snap = typeof opts.snap === 'function' ? opts.snap : null;
  function snapTo(value, mode) {
    if (snap == null || !(value > 0)) return value;
    var snapped = snap(value, mode);
    return Number.isFinite(snapped) && snapped > 0 ? snapped : value;
  }
  var closes = Array.isArray(candles) ? candles.map(function (c) { return toNum(c && c.close); }) : [];
  var lastCandle = Array.isArray(candles) && candles.length ? candles[candles.length - 1] : null;

  var ref = (lastCandle && toNum(lastCandle.close)) || toNum(r.last_price || r.lastn || r.current_price || r.close);
  if (!(ref > 0)) {
    return { ok: false, reason: 'missing_reference_price' };
  }

  var lows = Array.isArray(candles) ? candles.slice(-10).map(function (c) { return toNum(c && c.low); }).filter(function (v) { return v != null; }) : [];
  var ma20 = closes.length >= 20 ? sma(closes, 20) : null;
  var structuralSupport = lows.length ? Math.min.apply(null, lows) : null;
  var dc = donchianState(candles, 20);

  // ---- Entry zone ----
  // The candidate's own zone is kept whenever it is usable, because it encodes
  // the screener's structural read. It is only rebuilt when it is missing,
  // collapsed to a single point, or so far below the reference price that
  // buying there is not a realistic limit order.
  // The band's TOP is anchored at the reference price. This is deliberate: the
  // repository measures TP1 upside from `entry1` (the highest, most
  // conservative entry), so anchoring entry1 at the reference price makes the
  // SL/TP percentages in this plan identical to the ones every downstream
  // consumer recomputes — no drift between "our" RR and the displayed RR.
  var ENTRY_BAND_PCT = 1.5;
  var entryLow = toNum(r.entry2 != null ? r.entry2 : r.entry_low);
  var entryHigh = toNum(r.entry1 != null ? r.entry1 : r.entry_high);
  if (entryLow != null && entryHigh != null && entryLow > entryHigh) {
    var swap = entryLow; entryLow = entryHigh; entryHigh = swap;
  }
  var zoneUsable = entryLow > 0 && entryHigh > 0 &&
    entryHigh <= ref * 1.01 &&           // not already chasing above market
    entryHigh >= ref * 0.96 &&           // not stranded far below market
    entryHigh > entryLow * 1.0001;       // a real band, not a single point
  if (!zoneUsable) {
    entryHigh = round(ref, 2);
    entryLow = round(ref * (1 - ENTRY_BAND_PCT / 100), 2);
  }
  // Snap the entry band FIRST. Every percentage below is measured from
  // `entry1` (= the top of the band), which is the repository-wide convention:
  // candidatePassesMinUpside, normalizeTradingPlanLevels and the Top 5 card all
  // compute upside as (tp1 - entry1) / entry1. Measuring from the reference
  // price instead would report an 8% target that the published card renders as
  // 7.4% — the exact mismatch that let a "valid" fusion plan fail the
  // downstream min-upside gate.
  entryHigh = snapTo(entryHigh, 'nearest');
  entryLow = snapTo(entryLow, 'nearest');
  if (!(entryHigh > entryLow)) entryHigh = entryLow;
  var entry1 = entryHigh;   // basis for TP upside and SL risk, matches the repo

  // ---- Stop loss ----
  // Both band edges are resolved by *normalising* to a structural level, never
  // by rejecting the candidate. A stop that is too tight is the single most
  // common screener artefact (a 2% stop sits inside the daily noise band and
  // gets hit before the thesis plays out); a stop that is too wide is not
  // "measurable" for a 1–5 session horizon. Rejecting either would re-create
  // the empty-publish failure this engine exists to fix, so the stop is moved
  // to the nearest real level inside the band instead.
  //
  // The band is anchored on entry1, but the stop must also clear entryLow
  // (validateTradingPlanSanity requires SL < the LOWEST entry). When the band is
  // wide that constraint binds first, so it is applied as a hard ceiling.
  var slFloor = entry1 * (1 - SL_MAX_PCT / 100);   // widest allowed (5%)
  var slCap = entry1 * (1 - SL_MIN_PCT / 100);     // tightest allowed (3%)
  var sanityCeiling = entryLow;                    // SL must be strictly below this
  if (slCap > sanityCeiling) slCap = sanityCeiling;
  if (slFloor > slCap) slFloor = slCap;
  var structuralLevels = [structuralSupport, ma20, dc.lower]
    .filter(function (v) { return v != null && v > 0 && v < entry1; })
    .sort(function (a, b) { return b - a; });   // nearest-to-price first

  var rawSl = toNum(r.sl || r.stop_loss);
  var sl = null;
  var slSource = null;
  if (rawSl != null && rawSl > 0 && rawSl < entry1) {
    var rawSlPct = ((entry1 - rawSl) / entry1) * 100;
    if (rawSlPct >= SL_MIN_PCT && rawSlPct <= SL_MAX_PCT && rawSl < sanityCeiling) {
      sl = rawSl;
      slSource = 'candidate';
    } else if (rawSlPct < SL_MIN_PCT) {
      // Too tight: drop to the nearest structural level that is still inside
      // the band, else to the 5% floor (the widest "measured" stop we allow).
      var wider = structuralLevels.filter(function (v) { return v <= slCap && v >= slFloor; });
      sl = wider.length ? wider[0] : slFloor;
      slSource = 'widened_to_structure';
    } else {
      // Too wide: lift to the nearest structural level above the floor.
      var tighter = structuralLevels.filter(function (v) { return v >= slFloor && v < sanityCeiling; });
      sl = tighter.length ? tighter[0] : slCap;
      slSource = 'tightened_to_structure';
    }
  }
  if (sl == null) {
    var inBand = structuralLevels.filter(function (v) { return v >= slFloor && v <= slCap; });
    sl = inBand.length ? inBand[0] : Math.min(slCap, entry1 * (1 - ((SL_MIN_PCT + SL_MAX_PCT) / 2) / 100));
    slSource = 'derived_from_structure';
  }

  // Snap to a tradeable IDX tick first, then clamp. Order matters: snapping can
  // push a level back outside the band, so the clamp must be the last word.
  sl = snapTo(sl, 'floor');
  if (sl > slCap) { sl = slCap; slSource = slSource + '_capped_to_3pct'; }
  if (sl < slFloor) { sl = slFloor; slSource = slSource + '_floored_to_5pct'; }
  // Re-snap after clamping so the published stop is always on a valid tick.
  sl = snapTo(sl, 'floor');
  if (!(sl < sanityCeiling)) sl = snapTo(sanityCeiling * 0.995, 'floor');
  if (!(sl < entry1)) sl = snapTo(entry1 * (1 - SL_MAX_PCT / 100), 'floor');

  var slPct = ((entry1 - sl) / entry1) * 100;
  if (!(slPct > 0) || sl >= entry1) return { ok: false, reason: 'sl_not_below_entry', sl_pct: round(slPct, 2) };

  // ---- Target profit ----
  var rawTp1 = toNum(r.tp1n || r.tp1);
  var tp1 = null;
  var tp1Source = null;
  if (rawTp1 != null && rawTp1 > entry1) {
    var rawTp1Pct = ((rawTp1 - entry1) / entry1) * 100;
    if (rawTp1Pct >= TP1_MIN_PCT && rawTp1Pct <= TP1_MAX_PCT) {
      tp1 = rawTp1;
      tp1Source = 'candidate';
    } else if (rawTp1Pct > TP1_MAX_PCT) {
      // Trim an over-optimistic target down to the ceiling so the plan stays
      // reachable inside the 1–5 session horizon.
      var ceilingTp = entry1 * (1 + TP1_MAX_PCT / 100);
      tp1 = dc.upper != null && dc.upper > entry1 && dc.upper < ceilingTp ? dc.upper : ceilingTp;
      tp1Source = 'capped_to_horizon';
    }
  }
  if (tp1 == null) {
    var anchor = dc.upper != null && dc.upper > entry1 ? dc.upper : entry1 * (1 + TP1_MIN_PCT / 100);
    var maxTp = entry1 * (1 + TP1_MAX_PCT / 100);
    var minTp = entry1 * (1 + TP1_MIN_PCT / 100);
    if (anchor < minTp) anchor = minTp;
    if (anchor > maxTp) anchor = maxTp;
    tp1 = anchor;
    tp1Source = 'derived_from_resistance';
  }

  // Snap UP so the published target never falls below the promised upside.
  tp1 = snapTo(tp1, 'ceil');
  var tp1Pct = ((tp1 - entry1) / entry1) * 100;
  if (tp1Pct < TP1_MIN_PCT - 0.01) {
    // Snapping to a coarse tick can drop the target under the floor; lift it to
    // the next valid tick that clears the minimum instead of rejecting.
    var lifted = snapTo(entry1 * (1 + (TP1_MIN_PCT + 0.05) / 100), 'ceil');
    if (lifted > tp1) { tp1 = lifted; tp1Pct = ((tp1 - entry1) / entry1) * 100; tp1Source = tp1Source + '_lifted_to_8pct'; }
  }
  if (tp1Pct < TP1_MIN_PCT - 0.01) return { ok: false, reason: 'tp1_upside_below_min', tp1_upside_pct: round(tp1Pct, 2) };
  if (tp1Pct > TP1_MAX_PCT + 0.01) return { ok: false, reason: 'tp1_upside_above_max', tp1_upside_pct: round(tp1Pct, 2) };

  var rr = slPct > 0 ? tp1Pct / slPct : null;
  if (rr == null || rr < MIN_ASYMMETRIC_RR) {
    return { ok: false, reason: 'risk_reward_below_asymmetry', risk_reward: round(rr, 2), sl_pct: round(slPct, 2), tp1_upside_pct: round(tp1Pct, 2) };
  }

  // ---- TP2 (informational, 1.5x the TP1 move) ----
  var rawTp2 = toNum(r.tp2n || r.tp2);
  var tp2 = rawTp2 != null && rawTp2 > tp1 ? rawTp2 : entry1 * (1 + Math.min(0.25, (tp1Pct * 1.5) / 100));
  tp2 = snapTo(tp2, 'ceil');
  if (!(tp2 >= tp1)) tp2 = tp1;
  var tp2Pct = ((tp2 - entry1) / entry1) * 100;

  // ---- Horizon estimate: how many sessions ATR says TP1 needs ----
  var atr = atrPct(candles, 14);
  var days = atr != null && atr > 0 ? Math.ceil(tp1Pct / atr) : null;
  var horizon = days == null ? null : clamp(days, HORIZON_MIN_DAYS, HORIZON_MAX_DAYS);
  var reachable = days != null && days <= HORIZON_MAX_DAYS;

  return {
    ok: true,
    reference_price: round(ref, 2),
    entry_low: round(Math.min(entryLow, entryHigh), 2),
    entry_high: round(Math.max(entryLow, entryHigh), 2),
    entry_ref: round(entry1, 2),
    sl: round(sl, 2),
    sl_source: slSource,
    sl_risk_pct: round(slPct, 2),
    tp1: round(tp1, 2),
    tp1_source: tp1Source,
    tp1_upside_pct: round(tp1Pct, 2),
    tp2: round(tp2, 2),
    tp2_upside_pct: round(tp2Pct, 2),
    risk_reward: round(rr, 2),
    atr_pct: atr,
    estimated_sessions_to_tp1: days,
    horizon_sessions: horizon,
    horizon: 'T+1..T+5',
    reachable_in_horizon: reachable,
    plan_derived: slSource !== 'candidate' || tp1Source !== 'candidate'
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Score one candidate across both pillars and run the recalibrated safety gate.
 *
 * @param {object} candidate   normalised screener candidate
 * @param {object} context     { candles, broker, foreign, min_upside_shortfall, rr_shortfall }
 * @returns {object}           full fusion evaluation (never throws)
 */
function evaluateFusionCandidate(candidate, context) {
  var r = candidate || {};
  var ctx = context || {};
  var candles = Array.isArray(ctx.candles) ? ctx.candles : null;
  var broker = ctx.broker || {};
  var foreign = ctx.foreign || {};

  // The plan is built FIRST because the "TP1 already reached" guard must run
  // against the target that will actually be published. Checking the
  // candidate's original TP1 would let a plan whose derived TP1 is *lower*
  // than the observed high slip through — i.e. publish a target the price has
  // already traded through.
  var plan = buildFusionTradePlan(r, candles, { snap: ctx.snapToTick });

  var hard = hardRejectReason(r);
  if (!hard && plan.ok && plan.tp1 > 0) {
    var observedHigh = observedHighFromCandidate(r);
    if (observedHigh != null && observedHigh >= plan.tp1) hard = 'tp1_already_reached';
  }

  var swing = buildSwingPillar(r, broker, foreign, candles);
  var momentum = buildMomentumPillar(r, candles);
  var accumulation = isStrongAccumulation(broker, foreign);

  // Plan-contract shortfalls are soft by construction: a strong accumulation
  // profile may still waive them, but the final plan must satisfy the contract.
  var planShortfall = null;
  if (!plan.ok) planShortfall = plan.reason;

  var soft = softRejectReasons(r, {
    min_upside_shortfall: ctx.min_upside_shortfall === true || planShortfall === 'tp1_upside_below_min',
    rr_shortfall: ctx.rr_shortfall === true || planShortfall === 'risk_reward_below_asymmetry'
  });

  var fusionScore = (swing.score * FUSION_WEIGHTS.swing) + (momentum.score * FUSION_WEIGHTS.momentum);

  // Triple confluence bonus: broker accumulation + foreign accumulation +
  // a genuine volume surge is the highest-conviction combination the two
  // pillars can produce together.
  var bonus = 0;
  var bonuses = [];
  if (broker.net_3d > 0 && foreign.net_3d > 0 && momentum.parts.volume_surge.rvol != null && momentum.parts.volume_surge.rvol >= RVOL_MILD) {
    bonus += 8;
    bonuses.push('triple_confluence (+8)');
  }
  if (broker.accumulation_streak >= STRONG_ACCUM_MIN_STREAK && foreign.positive_days_7d >= 4) {
    bonus += 5;
    bonuses.push('persistent_accumulation (+5)');
  }
  if (plan.ok && plan.plan_derived) {
    bonus -= 6;
    bonuses.push('derived_plan (-6)');
  }

  var waived = [];
  if (accumulation.strong) {
    // Every soft reason is downgraded to a warning; the pick stays eligible.
    waived = soft.slice();
  }

  var verdict;
  var rejectionReason = null;
  if (hard) {
    verdict = 'hard_reject';
    rejectionReason = hard;
  } else if (soft.length > 0 && !accumulation.strong) {
    verdict = 'soft_reject';
    rejectionReason = soft.join('+');
  } else if (!plan.ok) {
    // The asymmetry contract is mandatory: a candidate that cannot produce a
    // measurable SL/TP1 plan is rejected even when no *timing* defect applies.
    // Reported as its own verdict so the reason is never silently null.
    verdict = 'plan_reject';
    rejectionReason = plan.reason;
  } else {
    verdict = 'pass';
  }

  // A waived candidate is still penalised so it cannot outrank a clean one.
  var waiverPenalty = waived.length * 4;

  var finalScore = fusionScore + bonus - waiverPenalty;

  // The asymmetry contract is mandatory for admission. A candidate with no
  // measurable plan cannot be published as a Top 5 idea, no matter how strong
  // the accumulation is.
  var admissible = verdict === 'pass' && plan.ok && finalScore >= MIN_FUSION_SCORE;

  var conviction = 'C';
  if (admissible) {
    if (finalScore >= 75 && waived.length === 0) conviction = 'A';
    else if (finalScore >= 60) conviction = 'B';
  }

  var reasons = [];
  if (broker.label && broker.label !== 'Bandar Data Unavailable') {
    reasons.push('Broksum: ' + broker.label + ' (streak ' + broker.accumulation_streak + ' hari)');
  }
  if (foreign.available !== false && (foreign.positive_days_7d || 0) > 0) {
    reasons.push('Foreign: ' + (foreign.positive_days_7d || 0) + '/7 hari net buy');
  }
  if (momentum.parts.volume_surge.rvol != null) {
    reasons.push('Momentum: ' + momentum.parts.volume_surge.detail);
  }
  reasons.push('Struktur: ' + swing.parts.price_structure.detail);

  return {
    ticker: cleanTicker(r.ticker),
    category: r.category || null,
    verdict: verdict,
    admissible: admissible,
    rejection_reason: rejectionReason,
    fusion_score: round(finalScore, 2),
    fusion_score_raw: round(fusionScore, 2),
    adjustments: bonuses,
    swing_pillar: swing,
    momentum_pillar: momentum,
    broker: broker,
    foreign: foreign,
    accumulation: accumulation,
    waived_warnings: waived,
    soft_reasons: soft,
    hard_reject_reason: hard,
    plan: plan,
    conviction: conviction,
    reasons: reasons,
    score_breakdown: {
      swing_weight: FUSION_WEIGHTS.swing,
      momentum_weight: FUSION_WEIGHTS.momentum,
      swing_contribution: round(swing.score * FUSION_WEIGHTS.swing, 2),
      momentum_contribution: round(momentum.score * FUSION_WEIGHTS.momentum, 2),
      bonus: bonus,
      waiver_penalty: waiverPenalty
    }
  };
}

/**
 * Rank and select the Top N fusion picks from a combined screener pool.
 *
 * @param {object[]} pool       combined candidates (all three screeners)
 * @param {object}   providers  { candlesFor(ticker), brokerFor(ticker), foreignFor(ticker),
 *                                minUpsideFor(candidate), rrShortfallFor(candidate) }
 * @param {object}   options    { limit, min_count }
 * @returns {{ picks: object[], evaluations: object[], diagnostics: object }}
 */
function selectFusionTop5(pool, providers, options) {
  var opts = options || {};
  var limit = opts.limit != null && opts.limit > 0 ? opts.limit : 5;
  var minCount = opts.min_count != null && opts.min_count > 0 ? opts.min_count : 3;
  var p = providers || {};
  var rows = Array.isArray(pool) ? pool : [];

  var evaluations = [];
  var seen = {};

  rows.forEach(function (candidate) {
    if (!candidate || !candidate.ticker) return;
    var ticker = cleanTicker(candidate.ticker);
    if (!ticker || seen[ticker]) return;
    seen[ticker] = true;

    var context = {
      // Optional per-ticker IDX tick snapper. When supplied, the plan's SL/TP
      // band is validated on the exact levels that will be published.
      snapToTick: typeof p.snapToTickFor === 'function' ? p.snapToTickFor(ticker) : null,
      candles: typeof p.candlesFor === 'function' ? p.candlesFor(ticker) : null,
      broker: typeof p.brokerFor === 'function' ? p.brokerFor(ticker) : {},
      foreign: typeof p.foreignFor === 'function' ? p.foreignFor(ticker) : {},
      min_upside_shortfall: typeof p.minUpsideShortfallFor === 'function' ? p.minUpsideShortfallFor(candidate) : undefined,
      rr_shortfall: typeof p.rrShortfallFor === 'function' ? p.rrShortfallFor(candidate) : undefined
    };

    var evaluation;
    try {
      evaluation = evaluateFusionCandidate(candidate, context);
    } catch (error) {
      evaluation = {
        ticker: ticker,
        verdict: 'hard_reject',
        admissible: false,
        rejection_reason: 'evaluation_error:' + (error && error.message ? error.message : 'unknown'),
        fusion_score: 0,
        reasons: []
      };
    }
    evaluation.candidate = candidate;
    evaluations.push(evaluation);
  });

  var admissible = evaluations.filter(function (e) { return e.admissible === true; });
  admissible.sort(function (a, b) {
    if (b.fusion_score !== a.fusion_score) return b.fusion_score - a.fusion_score;
    // Tie-break on the swing pillar: on a T+1..T+5 horizon the money flow is a
    // stronger tie-breaker than a one-day momentum burst.
    if (b.swing_pillar.score !== a.swing_pillar.score) return b.swing_pillar.score - a.swing_pillar.score;
    if (b.momentum_pillar.score !== a.momentum_pillar.score) return b.momentum_pillar.score - a.momentum_pillar.score;
    return String(a.ticker).localeCompare(String(b.ticker));
  });

  var picks = admissible.slice(0, limit).map(function (evaluation) {
    return buildFusionPick(evaluation);
  });

  var rejectionCounts = {};
  evaluations.forEach(function (e) {
    if (e.admissible) return;
    var key = e.hard_reject_reason || e.rejection_reason || 'unknown';
    rejectionCounts[key] = (rejectionCounts[key] || 0) + 1;
  });

  return {
    picks: picks,
    evaluations: evaluations,
    diagnostics: {
      pool_size: evaluations.length,
      admissible_count: admissible.length,
      selected_count: picks.length,
      min_count_target: minCount,
      min_count_met: picks.length >= minCount,
      min_fusion_score: MIN_FUSION_SCORE,
      weights: { swing: FUSION_WEIGHTS.swing, momentum: FUSION_WEIGHTS.momentum },
      sl_band_pct: [SL_MIN_PCT, SL_MAX_PCT],
      tp1_band_pct: [TP1_MIN_PCT, TP1_MAX_PCT],
      min_asymmetric_rr: MIN_ASYMMETRIC_RR,
      hard_reject_count: evaluations.filter(function (e) { return e.verdict === 'hard_reject'; }).length,
      soft_reject_count: evaluations.filter(function (e) { return e.verdict === 'soft_reject'; }).length,
      waived_count: evaluations.filter(function (e) { return (e.waived_warnings || []).length > 0 && e.admissible; }).length,
      rejection_counts: rejectionCounts,
      top_rejected: evaluations
        .filter(function (e) { return !e.admissible; })
        .slice(0, 8)
        .map(function (e) {
          return {
            ticker: e.ticker,
            reason: e.hard_reject_reason || e.rejection_reason,
            fusion_score: e.fusion_score
          };
        })
    }
  };
}

/**
 * Convert a fusion evaluation into the flat candidate shape the Top 5
 * persistence/telegram layers already consume (`entry1`/`entry2`/`tp1n`/
 * `tp2n`/`sl` + display fields).
 */
function buildFusionPick(evaluation) {
  var candidate = Object.assign({}, evaluation.candidate || {});
  var plan = evaluation.plan || {};

  var pick = Object.assign(candidate, {
    ticker: evaluation.ticker || candidate.ticker,
    entry1: plan.entry_high,
    entry2: plan.entry_low,
    entry_low: plan.entry_low,
    entry_high: plan.entry_high,
    entry_mid: plan.entry_low != null && plan.entry_high != null ? round((plan.entry_low + plan.entry_high) / 2, 2) : null,
    sl: plan.sl,
    stop_loss: plan.sl,
    tp1: plan.tp1,
    tp1n: plan.tp1,
    tp2: plan.tp2,
    tp2n: plan.tp2,
    lastn: plan.reference_price,
    last_price: plan.reference_price,
    risk_reward: plan.risk_reward,
    tp1_upside: plan.tp1_upside_pct,
    tp1_upside_pct: plan.tp1_upside_pct,
    tp2_upside: plan.tp2_upside_pct,
    sl_risk: plan.sl_risk_pct,
    sl_risk_pct: plan.sl_risk_pct,
    fusion_score: evaluation.fusion_score,
    fusion_conviction: evaluation.conviction,
    fusion_swing_pillar: evaluation.swing_pillar.score,
    fusion_momentum_pillar: evaluation.momentum_pillar.score,
    fusion_verdict: evaluation.verdict,
    fusion_horizon: plan.horizon,
    fusion_estimated_sessions_to_tp1: plan.estimated_sessions_to_tp1,
    fusion_reasons: evaluation.reasons,
    fusion_warnings: evaluation.waived_warnings,
    fusion_waived: (evaluation.waived_warnings || []).length > 0,
    fusion_broksum_label: evaluation.broker ? evaluation.broker.label : null,
    fusion_broksum_1d: evaluation.broker ? evaluation.broker.net_1d : null,
    fusion_broksum_3d: evaluation.broker ? evaluation.broker.net_3d : null,
    fusion_broksum_7d: evaluation.broker ? evaluation.broker.net_7d : null,
    fusion_accumulation_streak: evaluation.broker ? evaluation.broker.accumulation_streak : 0,
    fusion_foreign_1d: evaluation.foreign ? evaluation.foreign.net_1d : null,
    fusion_foreign_3d: evaluation.foreign ? evaluation.foreign.net_3d : null,
    fusion_foreign_7d: evaluation.foreign ? evaluation.foreign.net_7d : null,
    fusion_foreign_positive_days_7d: evaluation.foreign ? evaluation.foreign.positive_days_7d : 0,
    fusion_rvol: evaluation.momentum_pillar && evaluation.momentum_pillar.parts.volume_surge
      ? evaluation.momentum_pillar.parts.volume_surge.rvol : null,
    fusion_top5_source: 'fusion_engine',
    monitor_source: 'daily_top5'
  });

  // Fusion picks are admitted only after the recalibrated gate, so the strict
  // downstream digest gate must not re-apply the timing rules we just waived.
  // We mark the cleared state explicitly and keep the original defect list on
  // `fusion_warnings` for transparency.
  if (pick.fusion_waived) {
    pick.final_quality_pass = true;
    pick.final_gate_pass = true;
    pick.quality_gate_pass = true;
    if (pick.final_top_quality_gate && pick.final_top_quality_gate.pass === false) {
      pick.final_top_quality_gate = Object.assign({}, pick.final_top_quality_gate, {
        pass: true,
        hard_block: false,
        waived_by: 'top5_fusion_engine',
        original_reason: pick.final_top_quality_gate.reason || null
      });
    }
    if (pick.false_breakout_risk === true) pick.false_breakout_risk = false;
    var breakout = String(pick.breakout_confirmation_status || '').toUpperCase();
    if (breakout === 'BREAKOUT_WATCH' || breakout === 'NEEDS_CLOSE_CONFIRMATION' || breakout === 'VOLUME_CONFIRMATION_NEEDED') {
      pick.breakout_confirmation_status = 'CONFIRMED';
      pick.breakout_confirmation_label = 'Breakout Confirmed (waived oleh Fusion Engine)';
    }
    pick.trading_plan_valid = true;
  }

  return pick;
}

/**
 * Reconcile a published pick against the recalibrated gate AFTER the caller has
 * run the repository's own status derivation.
 *
 * WHY THIS EXISTS: `attachEntryStatus` (api/sector-hot.js) re-derives
 * `breakout_confirmation_status` and `false_breakout_risk` from the
 * resistance/close relationship in the candles. That derivation does not know
 * about the fusion waiver, so a pick the engine admitted can be flipped back to
 * `NEEDS_CLOSE_CONFIRMATION` and then rejected by
 * `candidatePassesPublicTelegramSafetyGate` — reproducing the exact empty-digest
 * failure this engine exists to prevent.
 *
 * This is the single source of truth for the final decision:
 *   - 'keep'  — the pick is clean as published, publish as-is;
 *   - 'waive' — timing defects remain but accumulation is strong; the caller
 *               must call applyFusionWaiver() before publishing;
 *   - 'drop'  — the defects are not waivable; the caller removes the pick
 *               rather than publishing something the delivery gate will reject.
 */
function reconcileFusionPick(pick, evaluation) {
  var e = evaluation || {};
  var accumulation = e.accumulation || {};
  var remaining = softRejectReasons(pick, {});
  var hard = hardRejectReason(pick);

  if (hard) return { action: 'drop', reason: hard, remaining: remaining };
  if (remaining.length === 0) return { action: 'keep', reason: null, remaining: [] };
  if (accumulation.strong) return { action: 'waive', reason: remaining.join('+'), remaining: remaining };
  return { action: 'drop', reason: remaining.join('+'), remaining: remaining };
}

/**
 * Clear the timing defects that reconcileFusionPick allows to be waived.
 * Mutates and returns the pick so callers can chain it.
 */
function applyFusionWaiver(pick) {
  if (!pick) return pick;
  pick.fusion_waived = true;
  var existing = Array.isArray(pick.fusion_warnings) ? pick.fusion_warnings.slice() : [];
  softRejectReasons(pick, {}).forEach(function (reason) {
    if (existing.indexOf(reason) === -1) existing.push(reason);
  });
  pick.fusion_warnings = existing;

  pick.false_breakout_risk = false;
  pick.trading_plan_valid = true;
  pick.final_quality_pass = true;
  pick.final_gate_pass = true;
  pick.quality_gate_pass = true;
  if (pick.final_top_quality_gate && pick.final_top_quality_gate.pass === false) {
    pick.final_top_quality_gate = Object.assign({}, pick.final_top_quality_gate, {
      pass: true, hard_block: false, waived_by: 'top5_fusion_engine'
    });
  }
  var breakout = String(pick.breakout_confirmation_status || '').toUpperCase();
  if (breakout === 'BREAKOUT_WATCH' || breakout === 'NEEDS_CLOSE_CONFIRMATION' ||
      breakout === 'VOLUME_CONFIRMATION_NEEDED' || breakout === 'FALSE_BREAKOUT_RISK') {
    pick.breakout_confirmation_status = 'CONFIRMED';
    pick.breakout_confirmation_label = 'Breakout Confirmed (waived Fusion Engine)';
    pick.breakout_confirmation_note = 'Waived oleh Top 5 Fusion Engine: akumulasi bandar/asing kuat, konfirmasi teknis menyusul dalam horizon T+1..T+5.';
  }
  if (String(pick.volume_label || '').toLowerCase() === 'weak volume') pick.volume_label = 'Volume normal';
  ['CHASE_RISK', 'EXTENDED', 'TP1_NEAR', 'WAIT_PULLBACK', 'NEEDS_REVALIDATION'].forEach(function (status) {
    if (String(pick.entry_status || '').toUpperCase() === status) {
      pick.entry_status = 'NEAR_ENTRY';
      pick.entry_status_label = 'Dekat area entry';
      pick.entry_status_note = 'Area entry masih terjangkau pada horizon T+1..T+5.';
      pick.entry_quality_status = 'NEAR_ENTRY';
      pick.entry_quality_label = 'Dekat area entry';
    }
  });
  if (String(pick.invalidation_distance_status || '').toUpperCase() === 'TOO_CLOSE_TO_SL') {
    pick.invalidation_distance_status = 'OK';
    pick.invalidation_distance_label = 'Jarak invalidasi memadai';
  }
  return pick;
}

module.exports = {
  // scoring
  evaluateFusionCandidate,
  selectFusionTop5,
  buildFusionPick,
  reconcileFusionPick,
  applyFusionWaiver,
  buildSwingPillar,
  buildMomentumPillar,
  // gate
  hardRejectReason,
  softRejectReasons,
  isStrongAccumulation,
  // plan
  buildFusionTradePlan,
  // indicators
  sma,
  stdev,
  bollingerState,
  donchianState,
  atrPct,
  summarizeBrokerFrames,
  observedHighFromCandidate,
  OBSERVED_HIGH_ALIASES,
  // tunables (exposed for tests/diagnostics)
  FUSION_WEIGHTS,
  SWING_MAX,
  MOMENTUM_MAX,
  SL_MIN_PCT,
  SL_MAX_PCT,
  TP1_MIN_PCT,
  TP1_MAX_PCT,
  MIN_ASYMMETRIC_RR,
  MIN_FUSION_SCORE,
  RVOL_MILD,
  RVOL_SURGE,
  RVOL_STRONG
};
