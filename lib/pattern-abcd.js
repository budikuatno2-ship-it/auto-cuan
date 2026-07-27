'use strict';

// ABCD v1 deliberately has no runtime-tunable geometry parameters. Changing a
// rule requires a new rule version so identical candles always mean identical
// output.
var PIVOT_WINDOW = 3;
var MAX_D_AGE_BARS = 25;
var MIN_BC_RETRACE = 0.618;
var MAX_BC_RETRACE = 0.786;
var MIN_CD_AB_RATIO = 0.90;
var MAX_CD_AB_RATIO = 1.10;
var RULE_VERSION = 'abcd-t1-v1';
var EPSILON = 1e-9;
var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
function rounded(value) { return Math.round(value * 1e10) / 1e10; }
function validDate(value) {
  if (!DATE_RE.test(String(value || ''))) return false;
  var parsed = new Date(value + 'T00:00:00Z');
  return !isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function validCandle(candle, previous) {
  return candle && typeof candle === 'object' && !Array.isArray(candle) && validDate(candle.time) &&
    ['open', 'high', 'low', 'close'].every(function(key) { return finite(candle[key]) && candle[key] > 0; }) &&
    candle.high >= candle.open && candle.high >= candle.close && candle.high >= candle.low &&
    candle.low <= candle.open && candle.low <= candle.close && (!previous || previous.time < candle.time);
}
function result(candidate, reason, diagnostics) {
  return { candidate: candidate || null, reason: reason, diagnostics: diagnostics || {} };
}

function discoverPivots(candles) {
  var pivots = [];
  for (var i = PIVOT_WINDOW; i < candles.length - PIVOT_WINDOW; i++) {
    var high = candles[i].high;
    var low = candles[i].low;
    var isHigh = true;
    var isLow = true;
    for (var offset = 1; offset <= PIVOT_WINDOW; offset++) {
      // Strict comparisons intentionally reject every equal-price tie in the
      // confirmation window rather than choosing an ambiguous pivot.
      isHigh = isHigh && high > candles[i - offset].high && high > candles[i + offset].high;
      isLow = isLow && low < candles[i - offset].low && low < candles[i + offset].low;
    }
    // An outside bar can satisfy both strict rules. Its direction is unknowable
    // from daily OHLC, so conservatively emit neither side of that ambiguous bar.
    if (isHigh !== isLow) pivots.push({ index: i, type: isHigh ? 'high' : 'low',
      value: isHigh ? high : low, time: candles[i].time });
  }
  pivots.sort(function(left, right) { return left.index - right.index || left.type.localeCompare(right.type); });
  return pivots;
}

function alternatePivots(pivots) {
  var reduced = [];
  pivots.forEach(function(pivot) {
    var prior = reduced[reduced.length - 1];
    if (!prior || prior.type !== pivot.type) { reduced.push(pivot); return; }
    var moreExtreme = pivot.type === 'high' ? pivot.value > prior.value : pivot.value < prior.value;
    // Equal extremes retain the earlier pivot. This is deterministic, although
    // strict discovery normally removes local equal-price ambiguity first.
    if (moreExtreme) reduced[reduced.length - 1] = pivot;
  });
  return reduced;
}

function atr14At(candles, endIndex) {
  if (endIndex < 14) return null;
  var total = 0;
  for (var i = endIndex - 13; i <= endIndex; i++) {
    var previousClose = candles[i - 1].close;
    var tr = Math.max(candles[i].high - candles[i].low,
      Math.abs(candles[i].high - previousClose), Math.abs(candles[i].low - previousClose));
    if (!finite(tr)) return null;
    total += tr;
  }
  return total / 14;
}

function point(pivot, candles) {
  return { time: pivot.time, value: candles[pivot.index][pivot.type], candleIndex: pivot.index, priceField: pivot.type };
}
function stableId(ticker, direction, ruleVersion, pivots) {
  return ['abcd', ticker, direction, ruleVersion].concat(pivots.map(function(p) { return p.time.replace(/-/g, ''); })).join('-');
}

function validatePivotSequence(pivots) {
  if (!Array.isArray(pivots) || pivots.length !== 5) return false;
  for (var i = 1; i < pivots.length; i++) {
    if (!Number.isInteger(pivots[i - 1].index) || !Number.isInteger(pivots[i].index) ||
        pivots[i - 1].index >= pivots[i].index || !validDate(pivots[i - 1].time) ||
        !validDate(pivots[i].time) || pivots[i - 1].time >= pivots[i].time) return false;
  }
  return true;
}

function inspectLifecycle(candles, dIndex, direction, confirmation, invalidation) {
  var evidence = null;
  for (var i = dIndex + 1; i < candles.length; i++) {
    var invalid = direction === 'bullish' ? candles[i].low <= invalidation + EPSILON : candles[i].high >= invalidation - EPSILON;
    var confirmed = direction === 'bullish' ? candles[i].close > confirmation : candles[i].close < confirmation;
    // On a candle satisfying both conditions, invalidation is conservatively
    // treated as first because daily OHLC cannot prove the intraday order.
    if (!evidence && invalid) return { active: false, reason: 'invalidated_before_confirmation' };
    if (!evidence && confirmed) evidence = { type: 'daily-close', date: candles[i].time };
    else if (evidence && invalid) return { active: false, reason: 'invalidated_after_confirmation' };
  }
  return { active: true, evidence: evidence };
}

function evaluateGroup(candles, pivots, options) {
  // Defense-in-depth: even test-injected or future pivot sources cannot create
  // two points on one candle or violate the renderer's chronological contract.
  if (!validatePivotSequence(pivots)) return { reason: 'ambiguous_or_duplicate_pivots' };
  var types = pivots.map(function(p) { return p.type; }).join(',');
  var direction = types === 'low,high,low,high,low' ? 'bullish' :
    (types === 'high,low,high,low,high' ? 'bearish' : null);
  if (!direction) return { reason: 'unsupported_sequence' };
  var a = pivots[1].value, b = pivots[2].value, c = pivots[3].value, d = pivots[4].value;
  var ab = Math.abs(a - b), bc = Math.abs(b - c), cd = Math.abs(c - d);
  if (![ab, bc, cd].every(function(leg) { return finite(leg) && leg > 0; })) return { reason: 'invalid_leg' };
  var bcRetracement = bc / ab, cdAbRatio = cd / ab;
  if (bcRetracement < MIN_BC_RETRACE) return { reason: 'bc_retracement_below_min' };
  if (bcRetracement > MAX_BC_RETRACE) return { reason: 'bc_retracement_above_max' };
  if (cdAbRatio < MIN_CD_AB_RATIO) return { reason: 'cd_ab_below_min' };
  if (cdAbRatio > MAX_CD_AB_RATIO) return { reason: 'cd_ab_above_max' };
  if (candles.length - 1 - pivots[4].index > MAX_D_AGE_BARS) return { reason: 'stale_d' };
  var projections = direction === 'bullish' ? [c - ab * MAX_CD_AB_RATIO, c - ab * MIN_CD_AB_RATIO] :
    [c + ab * MIN_CD_AB_RATIO, c + ab * MAX_CD_AB_RATIO];
  var prz = { low: rounded(Math.min.apply(Math, projections)), high: rounded(Math.max.apply(Math, projections)) };
  if (d < prz.low - EPSILON || d > prz.high + EPSILON) return { reason: 'd_outside_prz' };
  var atr = atr14At(candles, pivots[4].index);
  if (!finite(atr) || atr <= 0) return { reason: 'insufficient_atr' };
  var dCandle = candles[pivots[4].index];
  var confirmation = direction === 'bullish' ? dCandle.high : dCandle.low;
  var invalidation = direction === 'bullish' ? d - 0.5 * atr : d + 0.5 * atr;
  var tp1 = direction === 'bullish' ? d + 0.382 * cd : d - 0.382 * cd;
  var tp2 = direction === 'bullish' ? d + 0.618 * cd : d - 0.618 * cd;
  invalidation = rounded(invalidation); tp1 = rounded(tp1); tp2 = rounded(tp2);
  var levels = [confirmation, invalidation, tp1, tp2, candles[candles.length - 1].close];
  if (!levels.every(function(level) { return finite(level) && level > 0; })) return { reason: 'invalid_levels' };
  var sensible = direction === 'bullish' ? invalidation < d && tp2 > tp1 && tp1 > d : invalidation > d && tp2 < tp1 && tp1 < d;
  if (!sensible) return { reason: 'invalid_levels' };
  var lifecycle = inspectLifecycle(candles, pivots[4].index, direction, confirmation, invalidation);
  if (!lifecycle.active) return { reason: lifecycle.reason };
  var points = { X: point(pivots[0], candles), A: point(pivots[1], candles), B: point(pivots[2], candles),
    C: point(pivots[3], candles), D: point(pivots[4], candles) };
  var candidate = {
    id: stableId(options.ticker, direction, RULE_VERSION, pivots), ruleVersion: RULE_VERSION,
    name: direction === 'bullish' ? 'Bullish ABCD' : 'Bearish ABCD',
    status: lifecycle.evidence ? 'confirmed' : 'candidate', provenance: 'server:pattern-abcd:' + RULE_VERSION,
    ticker: options.ticker, timeframe: '1D', dataDate: options.dataDate, candles: candles, points: points, prz: prz,
    confirmation: rounded(confirmation), invalidation: invalidation, tp1: tp1, tp2: tp2,
    currentPrice: candles[candles.length - 1].close
  };
  if (lifecycle.evidence) candidate.confirmationEvidence = lifecycle.evidence;
  return { candidate: candidate, direction: direction, dIndex: pivots[4].index, cdDistance: Math.abs(cdAbRatio - 1),
    bcDistance: Math.abs(bcRetracement - (MIN_BC_RETRACE + MAX_BC_RETRACE) / 2),
    dateSequence: pivots.map(function(p) { return p.time; }).join('|'), bcRetracement: bcRetracement, cdAbRatio: cdAbRatio };
}

function detectAbcdPattern(candles, options) {
  options = options || {};
  if (!Array.isArray(candles) || candles.length < PIVOT_WINDOW * 2 + 5) return result(null, 'insufficient_candles', { candleCount: Array.isArray(candles) ? candles.length : 0 });
  for (var i = 0; i < candles.length; i++) if (!validCandle(candles[i], i ? candles[i - 1] : null)) return result(null, 'invalid_ohlc', { candleIndex: i });
  var ticker = String(options.ticker || '').trim().toUpperCase().replace(/\.JK$/, '');
  var dataDate = options.dataDate || candles[candles.length - 1].time;
  if (!/^[A-Z]{3,5}$/.test(ticker) || dataDate !== candles[candles.length - 1].time) return result(null, 'invalid_context');
  var pivots = alternatePivots(discoverPivots(candles));
  var accepted = [], lastReason = pivots.length < 5 ? 'insufficient_pivots' : 'no_ratio_match';
  for (i = 0; i <= pivots.length - 5; i++) {
    var evaluated = evaluateGroup(candles, pivots.slice(i, i + 5), { ticker: ticker, dataDate: dataDate });
    if (evaluated.candidate) accepted.push(evaluated); else if (evaluated.reason !== 'unsupported_sequence') lastReason = evaluated.reason;
  }
  accepted.sort(function(left, right) {
    return right.dIndex - left.dIndex || left.cdDistance - right.cdDistance || left.bcDistance - right.bcDistance || left.dateSequence.localeCompare(right.dateSequence);
  });
  if (!accepted.length) return result(null, lastReason, { candleCount: candles.length, pivotCount: pivots.length, groupsEvaluated: Math.max(0, pivots.length - 4) });
  var winner = accepted[0];
  return result(winner.candidate, 'found', { candleCount: candles.length, pivotCount: pivots.length, validCandidateCount: accepted.length,
    direction: winner.direction, bcRetracement: rounded(winner.bcRetracement), cdAbRatio: rounded(winner.cdAbRatio) });
}

module.exports = { detectAbcdPattern: detectAbcdPattern, discoverPivots: discoverPivots, alternatePivots: alternatePivots,
  constants: { PIVOT_WINDOW: PIVOT_WINDOW, MAX_D_AGE_BARS: MAX_D_AGE_BARS, MIN_BC_RETRACE: MIN_BC_RETRACE,
    MAX_BC_RETRACE: MAX_BC_RETRACE, MIN_CD_AB_RATIO: MIN_CD_AB_RATIO, MAX_CD_AB_RATIO: MAX_CD_AB_RATIO, RULE_VERSION: RULE_VERSION },
  __test: { stableId: stableId, validatePivotSequence: validatePivotSequence, evaluateGroup: evaluateGroup } };
