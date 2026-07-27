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
      // A directory file has exactly one identity: its filename. A payload
      // identity that normalizes to the same ticker is an ambiguous duplicate.
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
  var out = {}; Object.keys(counts).sort().forEach(function(reason) { out[reason] = { count: counts[reason], percentagePct: total ? Math.round(counts[reason] / total * 1000000) / 10000 : 0 }; }); return out;
}
function deterministicSamples(events, scans) {
  function first(direction) { return events.filter(function(e) { return e.direction === direction; }).slice().sort(function(a, b) { return a.candidateId.localeCompare(b.candidateId); }).slice(0, 5); }
  var none = []; scans.forEach(function(scan) { none = none.concat(scan.noPatternExamples); }); none.sort(function(a, b) { return a.ticker.localeCompare(b.ticker) || a.dataDate.localeCompare(b.dataDate) || a.reason.localeCompare(b.reason); });
  return { bullish: first('bullish'), bearish: first('bearish'), noPattern: none.slice(0, 5) };
}
function tickerYearRates(events, scans) { var windows = {}, candidates = {}; scans.forEach(function(scan) { scan.windowYears.forEach(function(year) { var key = scan.ticker + '|' + year; windows[key] = (windows[key] || 0) + 1; }); }); events.forEach(function(event) { var key = event.ticker + '|' + event.firstSeenDate.slice(0, 4); candidates[key] = (candidates[key] || 0) + 1; }); return Object.keys(windows).sort().map(function(key) { var parts = key.split('|'), count = candidates[key] || 0; return { ticker: parts[0], year: Number(parts[1]), candidateCount: count, windowsScanned: windows[key], candidatesPerTickerYear: count }; }); }
function outcomeAggregate(events, hs) { var output = {}; hs.forEach(function(h) { var row = { eventCount: 0, tp1BeforeInvalidationCount: 0, tp2BeforeInvalidationCount: 0, invalidationFirstCount: 0, unresolvedCount: 0, insufficientFutureDataCount: 0, sameBarConflictCount: 0 }; events.forEach(function(e) { var o = e.outcomes[String(h)]; if (!o || o.classification === 'invalid_event_levels') return; row.eventCount++; if (o.classification === 'tp1_before_invalidation' || o.classification === 'tp2_before_invalidation') row.tp1BeforeInvalidationCount++; if (o.classification === 'tp2_before_invalidation') row.tp2BeforeInvalidationCount++; if (o.classification === 'invalidation_before_tp1') row.invalidationFirstCount++; if (o.classification === 'unresolved') row.unresolvedCount++; if (o.classification === 'insufficient_future_data') row.insufficientFutureDataCount++; if (o.sameBarConflict) row.sameBarConflictCount++; }); output[String(h)] = row; }); return output; }
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
      var quality = Validation.validateCandles(entry.candles); // validate complete source before filtering
      if (!quality.valid) { var f = failure(symbol, quality.reason); if (Number.isInteger(quality.candleIndex)) f.candleIndex = quality.candleIndex; failures.push(f); return; }
      var selected = entry.candles.filter(function(c) { return (!from || c.time >= from) && (!to || c.time <= to); });
      var scan = scanFn(selected, { ticker: symbol });
      if (!scan || scan.error) { failures.push(failure(symbol, scan && scan.error && scan.error.reason)); return; }
      var tickerEvents = [];
      try { scan.events.forEach(function(event) { event.outcomes = outcomeFn(event, selected, { horizons: hs }).horizons; tickerEvents.push(event); }); }
      catch (_) { failures.push(failure(symbol, 'outcome_exception')); return; }
      totalCandles += selected.length; scans.push({ ticker: symbol, windowsScanned: scan.windowsScanned, reasonCounts: scan.reasonCounts,
        deduplicatedObservations: scan.deduplicatedObservations, noPatternExamples: scan.noPatternExamples, windowYears: selected.map(function(c) { return c.time.slice(0, 4); }) }); events = events.concat(tickerEvents);
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
    firstSeenStatusDistribution: statuses, outcomeAggregate: outcomeAggregate(events, hs), candidatesPerTickerYear: tickerYearRates(events, scans),
    deterministicAuditSamples: deterministicSamples(events, scans), cohorts: Validation.summarizeAbcdValidation(events, { horizons: hs }) };
}
function main(argv, overrides) {
  var opt = args(argv), from, to; if (!opt.input) throw new Error('--input is required'); if (!opt.output && !opt.json) throw new Error('--output or --json is required');
  from = parseDate(opt.from, 'from'); to = parseDate(opt.to, 'to'); if (from && to && from > to) throw new Error('--from must not exceed --to');
  var hs = opt.horizons ? opt.horizons.split(',').map(Number) : Validation.DEFAULT_HORIZONS, entries = loadInput(path.resolve(opt.input));
  var processed = processEntries(entries, Object.assign({ from: from, to: to, horizons: hs }, overrides));
  var canonicalSource = JSON.stringify(entries.map(function(e) { return [normalizeTicker(e.rawTicker), e.reason || null, e.candles]; }).sort());
  var report = Object.assign({ schemaVersion: 1, methodology: 'walk-forward-truncated-daily-candles', inputSha256: crypto.createHash('sha256').update(canonicalSource).digest('hex'),
    requestedRange: { from: from || null, to: to || null }, horizons: hs.slice().sort(function(a, b) { return a - b; }) }, processed);
  var text = JSON.stringify(report, null, 2) + '\n'; if (opt.output) fs.writeFileSync(path.resolve(opt.output), text); if (opt.json) process.stdout.write(text); return report;
}
if (require.main === module) { try { main(process.argv.slice(2)); } catch (e) { process.stderr.write('ABCD validation error: ' + e.message + '\n'); process.exitCode = 1; } }
module.exports = { main: main, loadInput: loadInput, processEntries: processEntries, normalizeTicker: normalizeTicker,
  parseDate: parseDate, args: args, deterministicSamples: deterministicSamples, outcomeAggregate: outcomeAggregate };
