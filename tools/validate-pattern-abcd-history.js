#!/usr/bin/env node
'use strict';

var fs = require('fs'); var path = require('path'); var crypto = require('crypto');
var Validation = require('../lib/pattern-abcd-validation');
var TICKER_RE = /^[A-Z]{3,5}$/; var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
var FAILURE_REASONS = new Set(['file_read_error', 'json_parse_error', 'invalid_file_schema', 'invalid_ticker',
  'duplicate_normalized_ticker', 'candles_not_array', 'invalid_date', 'duplicate_date', 'unordered_dates',
  'invalid_price', 'invalid_ohlc_relationship', 'invalid_volume', 'detector_exception',
  'candidate_validation_exception', 'outcome_exception', 'ticker_processing_exception']);

function args(argv) { var out = {}; for (var i = 0; i < argv.length; i++) { if (!argv[i].startsWith('--')) throw new Error('unexpected argument: ' + argv[i]); var key = argv[i].slice(2); if (key === 'json') out.json = true; else { if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('--' + key + ' requires a value'); out[key] = argv[++i]; } } return out; }
function normalizeTicker(value) { return String(value == null ? '' : value).trim().toUpperCase().replace(/\.JK$/, ''); }
function calendarDate(value) { var d; if (!DATE_RE.test(String(value || ''))) return false; d = new Date(value + 'T00:00:00Z'); return !isNaN(d) && d.toISOString().slice(0, 10) === value; }
function parseDate(value, name) { if (value && !calendarDate(value)) throw new Error('--' + name + ' must be a real YYYY-MM-DD calendar date'); return value; }
function failure(ticker, reason) { return { ticker: TICKER_RE.test(ticker) ? ticker : null, reason: FAILURE_REASONS.has(reason) ? reason : 'ticker_processing_exception' }; }
function safeJson(file) { try { return { value: JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (e) { return { reason: e instanceof SyntaxError ? 'json_parse_error' : 'file_read_error' }; } }
function pct(n, d) { return d ? Math.round(n / d * 1000000) / 10000 : 0; }

// Entries preserve aliases until normalization, so collisions cannot be lost to
// object assignment. Paths and exception messages never enter report records.
function loadInput(input) {
  var stat; try { stat = fs.statSync(input); } catch (_) { return [{ rawTicker: null, reason: 'file_read_error' }]; }
  if (stat.isDirectory()) {
    var names; try { names = fs.readdirSync(input).filter(function(n) { return n.endsWith('.json'); }).sort(); }
    catch (_) { return [{ rawTicker: null, reason: 'file_read_error' }]; }
    return names.map(function(name) {
      var filenameTicker = path.basename(name, '.json'), parsed = safeJson(path.join(input, name));
      if (parsed.reason) return { rawTicker: filenameTicker, reason: parsed.reason };
      var value = parsed.value;
      if (value === null || typeof value !== 'object') return { rawTicker: filenameTicker, reason: 'invalid_file_schema' };
      if (!Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'ticker')) {
        if (normalizeTicker(value.ticker) === normalizeTicker(filenameTicker)) return { rawTicker: filenameTicker, reason: 'duplicate_normalized_ticker' };
        return { rawTicker: filenameTicker, reason: 'invalid_ticker' };
      }
      return { rawTicker: filenameTicker, candles: Array.isArray(value) ? value : value.candles };
    });
  }
  var parsed = safeJson(input); if (parsed.reason) return [{ rawTicker: null, reason: parsed.reason }];
  var root = parsed.value && parsed.value.tickers ? parsed.value.tickers : parsed.value;
  if (!root || typeof root !== 'object' || Array.isArray(root)) return [{ rawTicker: null, reason: 'invalid_file_schema' }];
  return Object.keys(root).sort().map(function(key) { return { rawTicker: key, candles: root[key] }; });
}
function reasonAggregate(scans, total) {
  var counts = {}; scans.forEach(function(scan) { Object.keys(scan.reasonCounts).forEach(function(reason) { counts[reason] = (counts[reason] || 0) + scan.reasonCounts[reason]; }); });
  var out = {}; Object.keys(counts).sort().forEach(function(reason) { out[reason] = { count: counts[reason], percentagePct: pct(counts[reason], total) }; }); return out;
}
function deterministicSamples(events, scans) {
  function newest(direction) {
    return events.filter(function(event) { return event.direction === direction; }).slice().sort(function(a, b) {
      return b.firstSeenDate.localeCompare(a.firstSeenDate) || a.ticker.localeCompare(b.ticker) || a.candidateId.localeCompare(b.candidateId);
    }).slice(0, 5);
  }
  var none = [];
  scans.forEach(function(scan) { none = none.concat(scan.noPatternExamples || []); });
  none.sort(function(a, b) { return b.dataDate.localeCompare(a.dataDate) || a.ticker.localeCompare(b.ticker) || a.reason.localeCompare(b.reason); });
  return { bullish: newest('bullish'), bearish: newest('bearish'), noPattern: none.slice(0, 5) };
}
function tickerYearRates(events, scans) {
  var windows = {}, candidates = {};
  scans.forEach(function(scan) { scan.windowYears.forEach(function(year) { var key = scan.ticker + '|' + year; windows[key] = (windows[key] || 0) + 1; }); });
  events.forEach(function(event) { var key = event.ticker + '|' + event.firstSeenDate.slice(0, 4); candidates[key] = (candidates[key] || 0) + 1; });
  return Object.keys(windows).sort().map(function(key) {
    var parts = key.split('|'), count = candidates[key] || 0, windowCount = windows[key];
    return { ticker: parts[0], year: Number(parts[1]), candidateCount: count, windowsScanned: windowCount,
      candidatesPerTickerYear: count, candidatesPer100Windows: pct(count, windowCount) };
  });
}
function outcomeAggregate(events, horizons) {
  var output = {};
  horizons.forEach(function(horizon) {
    var row = { candidateEventCount: 0, eventCount: 0, invalidEventCount: 0, ineligibleAtFirstSeenCount: 0,
      tp1AlreadyReachedCount: 0, tp2AlreadyReachedCount: 0, invalidationAlreadyReachedCount: 0,
      tp1BeforeInvalidationCount: 0, tp2BeforeInvalidationCount: 0, invalidationFirstCount: 0,
      unresolvedCount: 0, insufficientFutureDataCount: 0, sameBarConflictCount: 0 };
    events.forEach(function(event) {
      var outcome = event.outcomes[String(horizon)];
      if (!outcome) return;
      row.candidateEventCount++;
      if (outcome.classification === 'invalid_event_levels') { row.invalidEventCount++; return; }
      if (outcome.classification === 'ineligible_at_first_seen') {
        row.ineligibleAtFirstSeenCount++;
        if (outcome.firstSeenOutcome === 'tp1_reached_before_first_seen') row.tp1AlreadyReachedCount++;
        if (outcome.firstSeenOutcome === 'tp2_reached_before_first_seen') row.tp2AlreadyReachedCount++;
        if (outcome.firstSeenOutcome === 'invalidation_reached_before_first_seen') row.invalidationAlreadyReachedCount++;
        return;
      }
      row.eventCount++;
      if (outcome.classification === 'tp1_before_invalidation' || outcome.classification === 'tp2_before_invalidation') row.tp1BeforeInvalidationCount++;
      if (outcome.classification === 'tp2_before_invalidation') row.tp2BeforeInvalidationCount++;
      if (outcome.classification === 'invalidation_before_tp1') row.invalidationFirstCount++;
      if (outcome.classification === 'unresolved') row.unresolvedCount++;
      if (outcome.classification === 'insufficient_future_data') row.insufficientFutureDataCount++;
      if (outcome.sameBarConflict) row.sameBarConflictCount++;
    });
    row.eligibleEventRatePct = pct(row.eventCount, row.candidateEventCount);
    row.ineligibleAtFirstSeenRatePct = pct(row.ineligibleAtFirstSeenCount, row.candidateEventCount);
    row.invalidEventRatePct = pct(row.invalidEventCount, row.candidateEventCount);
    row.tp1AlreadyReachedRatePct = pct(row.tp1AlreadyReachedCount, row.candidateEventCount);
    row.tp2AlreadyReachedRatePct = pct(row.tp2AlreadyReachedCount, row.candidateEventCount);
    row.invalidationAlreadyReachedRatePct = pct(row.invalidationAlreadyReachedCount, row.candidateEventCount);
    row.tp1BeforeInvalidationRatePct = pct(row.tp1BeforeInvalidationCount, row.eventCount);
    row.tp2BeforeInvalidationRatePct = pct(row.tp2BeforeInvalidationCount, row.eventCount);
    row.invalidationFirstRatePct = pct(row.invalidationFirstCount, row.eventCount);
    row.unresolvedRatePct = pct(row.unresolvedCount, row.eventCount);
    row.insufficientFutureDataRatePct = pct(row.insufficientFutureDataCount, row.eventCount);
    row.sameBarConflictRatePct = pct(row.sameBarConflictCount, row.eventCount);
    output[String(horizon)] = row;
  });
  return output;
}
function firstSeenEligibilityDistribution(events) {
  var out = { eligible: 0, tp1_reached_before_first_seen: 0, tp2_reached_before_first_seen: 0,
    invalidation_reached_before_first_seen: 0, invalid_event_levels: 0 };
  events.forEach(function(event) {
    var key = event.firstSeenEligibility;
    if (Object.prototype.hasOwnProperty.call(out, key)) out[key]++;
    else out.invalid_event_levels++;
  });
  return out;
}
function processEntries(entries, options) {
  options = options || {}; var from = options.from, to = options.to, hs = options.horizons || Validation.DEFAULT_HORIZONS;
  var scanFn = options.walkForward || Validation.walkForwardAbcdValidation, outcomeFn = options.evaluateOutcome || Validation.evaluateAbcdOutcome;
  var normalized = entries.map(function(entry, index) { return { entry: entry, ticker: normalizeTicker(entry.rawTicker), index: index }; });
  var frequencies = {}; normalized.forEach(function(item) { if (TICKER_RE.test(item.ticker)) frequencies[item.ticker] = (frequencies[item.ticker] || 0) + 1; });
  normalized.sort(function(a, b) { return a.ticker.localeCompare(b.ticker) || String(a.entry.rawTicker).localeCompare(String(b.entry.rawTicker)) || a.index - b.index; });
  var events = [], failures = [], scans = [], totalCandles = 0;
  normalized.forEach(function(item) {
    var entry = item.entry, symbol = item.ticker;
    if (entry.reason) { failures.push(failure(symbol, entry.reason)); return; }
    if (!TICKER_RE.test(symbol)) { failures.push(failure(symbol, 'invalid_ticker')); return; }
    if (frequencies[symbol] > 1) { failures.push(failure(symbol, 'duplicate_normalized_ticker')); return; }
    try {
      var quality = Validation.validateCandles(entry.candles);
      if (!quality.valid) { var f = failure(symbol, quality.reason); if (Number.isInteger(quality.candleIndex)) f.candleIndex = quality.candleIndex; failures.push(f); return; }
      var selected = entry.candles.filter(function(c) { return (!from || c.time >= from) && (!to || c.time <= to); });
      var scan = scanFn(selected, { ticker: symbol });
      if (!scan || scan.error) { failures.push(failure(symbol, scan && scan.error && scan.error.reason)); return; }
      var tickerEvents = [];
      try {
        scan.events.forEach(function(event) {
          var evaluation = outcomeFn(event, selected, { horizons: hs });
          event.firstSeenEligibility = evaluation.firstSeenEligibility || (evaluation.invalidReason ? 'invalid_event_levels' : 'eligible');
          event.outcomes = evaluation.horizons;
          tickerEvents.push(event);
        });
      } catch (_) { failures.push(failure(symbol, 'outcome_exception')); return; }
      totalCandles += selected.length; scans.push({ ticker: symbol, windowsScanned: scan.windowsScanned, reasonCounts: scan.reasonCounts,
        deduplicatedObservations: scan.deduplicatedObservations, noPatternExamples: scan.noPatternExamples,
        windowYears: selected.map(function(c) { return c.time.slice(0, 4); }) }); events = events.concat(tickerEvents);
    } catch (_) { failures.push(failure(symbol, 'ticker_processing_exception')); }
  });
  failures.sort(function(a, b) { return String(a.ticker).localeCompare(String(b.ticker)) || a.reason.localeCompare(b.reason) || (a.candleIndex || 0) - (b.candleIndex || 0); });
  events.sort(function(a, b) { return a.firstSeenDate.localeCompare(b.firstSeenDate) || a.ticker.localeCompare(b.ticker) || a.candidateId.localeCompare(b.candidateId); });
  var totalWindows = scans.reduce(function(n, s) { return n + s.windowsScanned; }, 0), aggregate = reasonAggregate(scans, totalWindows);
  var found = aggregate.found ? aggregate.found.count : 0, directions = { bullish: 0, bearish: 0 }, statuses = { candidate: 0, confirmed: 0 };
  events.forEach(function(e) { if (directions[e.direction] !== undefined) directions[e.direction]++; if (statuses[e.firstSeenStatus] !== undefined) statuses[e.firstSeenStatus]++; });
  return { scans: scans, failures: failures, events: events, tickerCount: scans.length, failedTickerCount: failures.length,
    candleCount: totalCandles, totalWindows: totalWindows, uniqueCandidateCount: events.length,
    aggregateReasonDistribution: aggregate, totalDeduplicatedObservations: scans.reduce(function(n, s) { return n + s.deduplicatedObservations; }, 0),
    foundWindowCount: found, noPatternWindowCount: totalWindows - found, directionDistribution: directions,
    firstSeenStatusDistribution: statuses, firstSeenEligibilityDistribution: firstSeenEligibilityDistribution(events),
    outcomeAggregate: outcomeAggregate(events, hs), candidatesPerTickerYear: tickerYearRates(events, scans),
    deterministicAuditSamples: deterministicSamples(events, scans), cohorts: Validation.summarizeAbcdValidation(events, { horizons: hs }) };
}
function main(argv, overrides) {
  var opt = args(argv), from, to; if (!opt.input) throw new Error('--input is required'); if (!opt.output && !opt.json) throw new Error('--output or --json is required');
  from = parseDate(opt.from, 'from'); to = parseDate(opt.to, 'to'); if (from && to && from > to) throw new Error('--from must not exceed --to');
  var hs = opt.horizons ? opt.horizons.split(',').map(Number) : Validation.DEFAULT_HORIZONS, entries = loadInput(path.resolve(opt.input));
  var processed = processEntries(entries, Object.assign({ from: from, to: to, horizons: hs }, overrides));
  var canonicalSource = JSON.stringify(entries.map(function(e) { return [normalizeTicker(e.rawTicker), e.reason || null, e.candles]; }).sort());
  var report = Object.assign({ schemaVersion: 2, methodology: 'walk-forward-truncated-daily-candles', inputSha256: crypto.createHash('sha256').update(canonicalSource).digest('hex'),
    requestedRange: { from: from || null, to: to || null }, horizons: hs.slice().sort(function(a, b) { return a - b; }) }, processed);
  var text = JSON.stringify(report, null, 2) + '\n';
  if (opt.output) { var output = path.resolve(opt.output); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, text); }
  if (opt.json) process.stdout.write(text); return report;
}
if (require.main === module) { try { main(process.argv.slice(2)); } catch (e) { process.stderr.write('ABCD validation error: ' + e.message + '\n'); process.exitCode = 1; } }
module.exports = { main: main, loadInput: loadInput, processEntries: processEntries, normalizeTicker: normalizeTicker,
  parseDate: parseDate, args: args, deterministicSamples: deterministicSamples, outcomeAggregate: outcomeAggregate,
  firstSeenEligibilityDistribution: firstSeenEligibilityDistribution, tickerYearRates: tickerYearRates };
