'use strict';

// Offline-only, pure historical validation. Pattern geometry deliberately stays
// in pattern-abcd; the optional injections exist solely for isolated tests.
var detector = require('./pattern-abcd').detectAbcdPattern;
var PatternMap = require('../public/pattern-map');
var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
var DEFAULT_HORIZONS = [5, 10, 20];
var ALLOWED_REASONS = new Set(['insufficient_candles', 'invalid_ohlc', 'invalid_context', 'insufficient_pivots',
  'no_ratio_match', 'bc_retracement_below_min', 'bc_retracement_above_max', 'cd_ab_below_min',
  'cd_ab_above_max', 'd_outside_prz', 'stale_d', 'insufficient_atr', 'invalid_levels',
  'invalidated_before_confirmation', 'invalidated_after_confirmation', 'ambiguous_or_duplicate_pivots',
  'found', 'renderer_contract_rejected', 'other_detector_reason']);

function finite(n) { return typeof n === 'number' && Number.isFinite(n); }
function validDate(s) { var d; if (!DATE_RE.test(String(s || ''))) return false; d = new Date(s + 'T00:00:00Z'); return !isNaN(d) && d.toISOString().slice(0, 10) === s; }
function ticker(value) { return String(value || '').trim().toUpperCase().replace(/\.JK$/, ''); }
function horizons(value) {
  var out = (value || DEFAULT_HORIZONS).map(Number);
  if (!out.length || out.some(function(n) { return !Number.isInteger(n) || n < 1 || n > 1000; })) throw new Error('horizons must be integers from 1 through 1000');
  return Array.from(new Set(out)).sort(function(a, b) { return a - b; });
}
function validateCandles(candles) {
  if (!Array.isArray(candles)) return { valid: false, reason: 'candles_not_array' };
  for (var i = 0; i < candles.length; i++) {
    var c = candles[i], previous = candles[i - 1];
    if (!c || typeof c !== 'object' || Array.isArray(c) || !validDate(c.time)) return { valid: false, reason: 'invalid_date', candleIndex: i };
    if (previous && previous.time >= c.time) return { valid: false, reason: previous.time === c.time ? 'duplicate_date' : 'unordered_dates', candleIndex: i };
    if (!['open', 'high', 'low', 'close'].every(function(k) { return finite(c[k]) && c[k] > 0; })) return { valid: false, reason: 'invalid_price', candleIndex: i };
    if (c.high < c.open || c.high < c.close || c.high < c.low || c.low > c.open || c.low > c.close) return { valid: false, reason: 'invalid_ohlc_relationship', candleIndex: i };
    if (c.volume !== undefined && (!finite(c.volume) || c.volume < 0)) return { valid: false, reason: 'invalid_volume', candleIndex: i };
  }
  return { valid: true };
}
function boundedReason(reason) { return ALLOWED_REASONS.has(reason) ? reason : 'other_detector_reason'; }
function publicEvent(candidate, diagnostics, firstSeenDate) {
  var names = ['X', 'A', 'B', 'C', 'D'], dates = {}, indexes = {}, values = {};
  names.forEach(function(name) { dates[name] = candidate.points[name].time; indexes[name] = candidate.points[name].candleIndex; values[name] = candidate.points[name].value; });
  return { ticker: ticker(candidate.ticker), candidateId: candidate.id, ruleVersion: candidate.ruleVersion,
    direction: candidate.name.indexOf('Bullish') === 0 ? 'bullish' : 'bearish', patternName: candidate.name,
    firstSeenDate: firstSeenDate, firstSeenStatus: candidate.status, dataDate: candidate.dataDate,
    dDate: candidate.points.D.time, dIndexWithinAsOfData: candidate.points.D.candleIndex,
    confirmationEvidenceDate: candidate.confirmationEvidence ? candidate.confirmationEvidence.date : null,
    currentPriceAtFirstSeen: candidate.currentPrice, confirmation: candidate.confirmation,
    invalidation: candidate.invalidation, tp1: candidate.tp1, tp2: candidate.tp2,
    przLow: candidate.prz.low, przHigh: candidate.prz.high, pivotDates: dates, pivotIndexes: indexes,
    pivotValues: values, bcRetracement: diagnostics.bcRetracement, cdAbRatio: diagnostics.cdAbRatio };
}
function walkForwardAbcdValidation(candles, options) {
  options = options || {}; var symbol = ticker(options.ticker), quality = validateCandles(candles);
  if (!quality.valid) return { ticker: symbol, events: [], windowsScanned: 0, reasonCounts: {}, deduplicatedObservations: 0, error: quality };
  var findPattern = options.detectPattern || detector, validate = options.validateCandidate || PatternMap.validateCandidate;
  var events = [], seen = new Set(), reasonCounts = {}, duplicateCount = 0, examples = [];
  for (var i = 0; i < candles.length; i++) {
    var asOf = candles.slice(0, i + 1), date = asOf[asOf.length - 1].time;
    var result;
    try { result = findPattern(asOf, { ticker: symbol, dataDate: date }); }
    catch (_) { return { ticker: symbol, events: [], windowsScanned: i, reasonCounts: reasonCounts,
      deduplicatedObservations: duplicateCount, error: { valid: false, reason: 'detector_exception' } }; }
    var reason = boundedReason(result && result.reason);
    if (result && result.candidate) {
      var contract;
      try { contract = validate(result.candidate, { ticker: symbol, timeframe: '1D', dataDate: date, candles: asOf }); }
      catch (_) { return { ticker: symbol, events: [], windowsScanned: i, reasonCounts: reasonCounts,
        deduplicatedObservations: duplicateCount, error: { valid: false, reason: 'candidate_validation_exception' } }; }
      if (!contract.valid) reason = 'renderer_contract_rejected';
      else if (seen.has(result.candidate.id)) duplicateCount++;
      else { seen.add(result.candidate.id); events.push(publicEvent(result.candidate, result.diagnostics || {}, date)); }
    }
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    if (reason !== 'found' && examples.length < 20) examples.push({ ticker: symbol, dataDate: date, reason: reason });
  }
  events.sort(function(a, b) { return a.firstSeenDate.localeCompare(b.firstSeenDate) || a.ticker.localeCompare(b.ticker) || a.candidateId.localeCompare(b.candidateId); });
  return { ticker: symbol, events: events, windowsScanned: candles.length, reasonCounts: reasonCounts,
    deduplicatedObservations: duplicateCount, noPatternExamples: examples };
}

function invalidLevels(event) {
  var levels = ['currentPriceAtFirstSeen', 'invalidation', 'tp1', 'tp2'];
  var risk, rr1, rr2;
  if (!levels.every(function(k) { return finite(event[k]) && event[k] > 0; })) return 'non_finite_or_non_positive_level';
  if (event.direction === 'bullish' && !(event.invalidation < event.currentPriceAtFirstSeen && event.currentPriceAtFirstSeen < event.tp1 && event.tp1 < event.tp2) ||
      event.direction === 'bearish' && !(event.invalidation > event.currentPriceAtFirstSeen && event.currentPriceAtFirstSeen > event.tp1 && event.tp1 > event.tp2) ||
      event.direction !== 'bullish' && event.direction !== 'bearish') return 'nonsensical_level_order';
  risk = Math.abs(event.currentPriceAtFirstSeen - event.invalidation);
  rr1 = Math.abs(event.tp1 - event.currentPriceAtFirstSeen) / risk;
  rr2 = Math.abs(event.tp2 - event.currentPriceAtFirstSeen) / risk;
  if (!finite(risk) || risk <= 0 || !finite(rr1) || !finite(rr2)) return 'nonsensical_level_order';
  return null;
}
function evaluateAbcdOutcome(event, futureCandles, options) {
  options = options || {}; var hs = horizons(options.horizons), bad = invalidLevels(event);
  var after = (futureCandles || []).filter(function(c) { return c.time > event.firstSeenDate; });
  var output = { invalidReason: bad, horizons: {} };
  hs.forEach(function(horizon) {
    if (bad) { output.horizons[String(horizon)] = { classification: 'invalid_event_levels', sameBarConflict: false }; return; }
    var available = Math.min(horizon, after.length), tp1Bar = null, tp2Bar = null, invalidBar = null, conflict = false;
    var mfe = 0, mae = 0, terminal = null;
    for (var i = 0; i < available; i++) {
      var c = after[i], bullish = event.direction === 'bullish';
      var hit1 = bullish ? c.high >= event.tp1 : c.low <= event.tp1;
      var hit2 = bullish ? c.high >= event.tp2 : c.low <= event.tp2;
      var hitInvalid = bullish ? c.low <= event.invalidation : c.high >= event.invalidation;
      var favorable = bullish ? c.high - event.currentPriceAtFirstSeen : event.currentPriceAtFirstSeen - c.low;
      var adverse = bullish ? event.currentPriceAtFirstSeen - c.low : c.high - event.currentPriceAtFirstSeen;
      mfe = Math.max(mfe, favorable); mae = Math.max(mae, adverse);
      if (hit1 && tp1Bar === null) tp1Bar = i + 1;
      if (hit2 && tp2Bar === null) tp2Bar = i + 1;
      if (hitInvalid && invalidBar === null) invalidBar = i + 1;
      if (hitInvalid && (hit1 || hit2)) conflict = true;
      if (hitInvalid) { terminal = tp1Bar !== null && tp1Bar < i + 1 ? 'tp1_before_invalidation' : 'invalidation_before_tp1'; break; }
      if (hit2) { terminal = 'tp2_before_invalidation'; break; }
    }
    var classification = terminal || (tp1Bar !== null ? 'tp1_before_invalidation' :
      (after.length < horizon ? 'insufficient_future_data' : 'unresolved'));
    var risk = Math.abs(event.currentPriceAtFirstSeen - event.invalidation);
    output.horizons[String(horizon)] = { classification: classification, sameBarConflict: conflict, barsEvaluated: available,
      barsToTp1: tp1Bar, barsToTp2: tp2Bar, barsToInvalidation: invalidBar, maximumFavorableExcursion: mfe,
      maximumAdverseExcursion: mae, mfePercent: mfe / event.currentPriceAtFirstSeen * 100,
      maePercent: mae / event.currentPriceAtFirstSeen * 100, riskDistance: risk,
      tp1RewardRisk: Math.abs(event.tp1 - event.currentPriceAtFirstSeen) / risk,
      tp2RewardRisk: Math.abs(event.tp2 - event.currentPriceAtFirstSeen) / risk };
  });
  return output;
}
function pct(n, d) { return d ? Math.round(n / d * 1000000) / 10000 : 0; }
function summarizeAbcdValidation(events, options) {
  var hs = horizons(options && options.horizons), cohorts = {};
  (events || []).forEach(function(event) {
    hs.forEach(function(h) {
      var outcome = event.outcomes && event.outcomes[String(h)]; if (!outcome || outcome.classification === 'invalid_event_levels') return;
      var key = [event.direction, event.firstSeenStatus, h].join('|');
      var c = cohorts[key] || (cohorts[key] = { direction: event.direction, firstSeenStatus: event.firstSeenStatus, horizonBars: h,
        eventCount: 0, tp1BeforeInvalidationCount: 0, tp2BeforeInvalidationCount: 0, invalidationFirstCount: 0,
        unresolvedCount: 0, insufficientFutureDataCount: 0, sameBarConflictCount: 0 });
      c.eventCount++; if (outcome.classification === 'tp1_before_invalidation') c.tp1BeforeInvalidationCount++;
      if (outcome.classification === 'tp2_before_invalidation') { c.tp2BeforeInvalidationCount++; c.tp1BeforeInvalidationCount++; }
      if (outcome.classification === 'invalidation_before_tp1') c.invalidationFirstCount++;
      if (outcome.classification === 'unresolved') c.unresolvedCount++;
      if (outcome.classification === 'insufficient_future_data') c.insufficientFutureDataCount++;
      if (outcome.sameBarConflict) c.sameBarConflictCount++;
    });
  });
  return Object.keys(cohorts).sort().map(function(k) { var c = cohorts[k]; c.tp1BeforeInvalidationRatePct = pct(c.tp1BeforeInvalidationCount, c.eventCount);
    c.tp2BeforeInvalidationRatePct = pct(c.tp2BeforeInvalidationCount, c.eventCount); c.invalidationFirstRatePct = pct(c.invalidationFirstCount, c.eventCount);
    c.unresolvedRatePct = pct(c.unresolvedCount, c.eventCount); c.sameBarConflictRatePct = pct(c.sameBarConflictCount, c.eventCount); return c; });
}

module.exports = { walkForwardAbcdValidation: walkForwardAbcdValidation, evaluateAbcdOutcome: evaluateAbcdOutcome,
  summarizeAbcdValidation: summarizeAbcdValidation, validateCandles: validateCandles, DEFAULT_HORIZONS: DEFAULT_HORIZONS };
