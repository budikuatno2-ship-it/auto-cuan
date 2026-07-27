#!/usr/bin/env node
'use strict';

var fs = require('fs'); var path = require('path'); var crypto = require('crypto');
var Validation = require('../lib/pattern-abcd-validation');

function args(argv) { var out = {}; for (var i = 0; i < argv.length; i++) { if (!argv[i].startsWith('--')) throw new Error('unexpected argument: ' + argv[i]); var key = argv[i].slice(2); if (key === 'json') out.json = true; else { if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('--' + key + ' requires a value'); out[key] = argv[++i]; } } return out; }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error('cannot read JSON ' + file + ': ' + e.message); } }
function loadInput(input) {
  var stat = fs.statSync(input), rows = {};
  if (stat.isDirectory()) fs.readdirSync(input).filter(function(n) { return n.endsWith('.json'); }).sort().forEach(function(name) {
    var value = readJson(path.join(input, name)), symbol = String(value.ticker || path.basename(name, '.json')).toUpperCase().replace(/\.JK$/, '');
    rows[symbol] = Array.isArray(value) ? value : value.candles;
  });
  else { var value = readJson(input); rows = value.tickers || value; }
  if (!rows || typeof rows !== 'object' || Array.isArray(rows)) throw new Error('input must be a ticker map or {"tickers":{...}}');
  return rows;
}
function parseDate(value, name) { if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('--' + name + ' must be YYYY-MM-DD'); return value; }
function main(argv) {
  var opt = args(argv); if (!opt.input) throw new Error('--input is required'); if (!opt.output && !opt.json) throw new Error('--output or --json is required');
  var from = parseDate(opt.from, 'from'), to = parseDate(opt.to, 'to'); if (from && to && from > to) throw new Error('--from must not exceed --to');
  var hs = opt.horizons ? opt.horizons.split(',').map(Number) : Validation.DEFAULT_HORIZONS;
  var source = loadInput(path.resolve(opt.input)), events = [], failures = [], scans = [], totalCandles = 0;
  Object.keys(source).sort().forEach(function(symbol) {
    var all = source[symbol], selected = Array.isArray(all) ? all.filter(function(c) { return (!from || c.time >= from) && (!to || c.time <= to); }) : all;
    var scan = Validation.walkForwardAbcdValidation(selected, { ticker: symbol });
    if (scan.error) { failures.push({ ticker: symbol, reason: scan.error.reason, candleIndex: scan.error.candleIndex }); return; }
    totalCandles += selected.length; scans.push({ ticker: scan.ticker, windowsScanned: scan.windowsScanned,
      reasonCounts: scan.reasonCounts, deduplicatedObservations: scan.deduplicatedObservations, noPatternExamples: scan.noPatternExamples });
    scan.events.forEach(function(event) { event.outcomes = Validation.evaluateAbcdOutcome(event, selected, { horizons: hs }).horizons; events.push(event); });
  });
  events.sort(function(a, b) { return a.firstSeenDate.localeCompare(b.firstSeenDate) || a.ticker.localeCompare(b.ticker) || a.candidateId.localeCompare(b.candidateId); });
  var canonicalSource = JSON.stringify(Object.keys(source).sort().map(function(k) { return [k, source[k]]; }));
  var report = { schemaVersion: 1, methodology: 'walk-forward-truncated-daily-candles', inputSha256: crypto.createHash('sha256').update(canonicalSource).digest('hex'),
    requestedRange: { from: from || null, to: to || null }, horizons: hs.slice().sort(function(a, b) { return a - b; }),
    tickerCount: scans.length, failedTickerCount: failures.length, candleCount: totalCandles,
    totalWindows: scans.reduce(function(n, s) { return n + s.windowsScanned; }, 0), uniqueCandidateCount: events.length,
    scans: scans, failures: failures, events: events, cohorts: Validation.summarizeAbcdValidation(events, { horizons: hs }) };
  var text = JSON.stringify(report, null, 2) + '\n'; if (opt.output) fs.writeFileSync(path.resolve(opt.output), text); if (opt.json) process.stdout.write(text);
  return report;
}
if (require.main === module) { try { main(process.argv.slice(2)); } catch (e) { process.stderr.write('ABCD validation error: ' + e.message + '\n'); process.exitCode = 1; } }
module.exports = { main: main, loadInput: loadInput, args: args };
