#!/usr/bin/env node
'use strict';

// Explicit, offline-only research downloader. Nothing in the production runtime
// imports this module. Downloaded candles and generated manifests are gitignored.
var fs = require('fs'); var path = require('path'); var crypto = require('crypto');
var TICKER_RE = /^[A-Z]{3,5}$/; var DEFAULT_CONCURRENCY = 3; var MAX_CONCURRENCY = 5;

function parseArgs(argv) { var out = {}; for (var i = 0; i < argv.length; i++) { var key = argv[i]; if (!key.startsWith('--') || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(key + ' requires a value'); out[key.slice(2)] = argv[++i]; } return out; }
function normalizeTicker(value) { var ticker = String(value || '').trim().toUpperCase().replace(/\.JK$/, ''); return TICKER_RE.test(ticker) ? ticker : null; }
function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function canonical(value) { if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'; if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(function(k) { return JSON.stringify(k) + ':' + canonical(value[k]); }).join(',') + '}'; return JSON.stringify(value); }
function yahooDate(timestamp) { if (!Number.isInteger(timestamp) || timestamp < 0) return null; var d = new Date(timestamp * 1000); if (!Number.isFinite(d.getTime()) || d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0 || d.getUTCSeconds() !== 0) return null; return d.toISOString().slice(0, 10); }
function normalizeYahoo(payload) {
  var result = payload && payload.chart && payload.chart.result && payload.chart.result[0]; var quote = result && result.indicators && result.indicators.quote && result.indicators.quote[0]; var timestamps = result && result.timestamp;
  if (!quote || !Array.isArray(timestamps)) throw new Error('invalid_yahoo_schema');
  var candles = []; var seen = new Set(); timestamps.forEach(function(ts, i) { var time = yahooDate(ts), values = ['open', 'high', 'low', 'close'].map(function(k) { return quote[k] && quote[k][i]; }); var volume = quote.volume && quote.volume[i];
    if (!time) throw new Error('malformed_yahoo_timestamp'); if (seen.has(time)) throw new Error('duplicate_yahoo_date');
    if (!values.every(function(n) { return Number.isFinite(n) && n > 0; })) return;
    var c = { time: time, open: values[0], high: values[1], low: values[2], close: values[3], volume: Number.isFinite(volume) && volume >= 0 ? volume : 0 };
    if (c.high < Math.max(c.open, c.close, c.low) || c.low > Math.min(c.open, c.close)) throw new Error('invalid_yahoo_ohlc'); seen.add(time); candles.push(c);
  }); return candles;
}
function sleep(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }
async function fetchTicker(ticker, options) { var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + ticker + '.JK?period1=' + Math.floor(Date.parse(options.from + 'T00:00:00Z') / 1000) + '&period2=' + Math.floor((Date.parse(options.to + 'T00:00:00Z') + 86400000) / 1000) + '&interval=1d&events=history'; var last;
  for (var attempt = 1; attempt <= 3; attempt++) { try { var controller = new AbortController(), timer = setTimeout(function() { controller.abort(); }, 15000); var response = await options.fetchFn(url, { signal: controller.signal, headers: { 'User-Agent': 'auto-cuan-offline-pattern-validation/1.0' } }); clearTimeout(timer); if (!response.ok) throw new Error('yahoo_http_' + response.status); return normalizeYahoo(await response.json()); } catch (e) { last = e; if (attempt < 3) await sleep(attempt * 500); } } throw last;
}
async function mapBounded(items, concurrency, fn) { var next = 0, results = new Array(items.length); async function worker() { while (next < items.length) { var i = next++; try { results[i] = { value: await fn(items[i]) }; } catch (e) { results[i] = { error: String(e && e.message || 'fetch_failed').slice(0, 80) }; } } } await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker)); return results; }
async function run(options) { var raw = fs.readFileSync(options.universe, 'utf8').split(/\r?\n/).filter(Boolean), normalized = raw.map(normalizeTicker); if (normalized.some(function(t) { return !t; })) throw new Error('universe contains invalid ticker'); var tickers = Array.from(new Set(normalized)).sort().slice(0, options.limit); fs.mkdirSync(options.output, { recursive: true });
  var results = await mapBounded(tickers, options.concurrency, function(t) { return fetchTicker(t, options); }); var entries = [], failures = [];
  results.forEach(function(result, i) { var ticker = tickers[i]; if (result.error) { failures.push({ ticker: ticker, reason: result.error }); return; } if (result.value.length < options.minCandles) { failures.push({ ticker: ticker, reason: 'insufficient_candles_' + result.value.length }); return; } fs.writeFileSync(path.join(options.output, ticker + '.json'), JSON.stringify(result.value) + '\n'); entries.push({ ticker: ticker, candleCount: result.value.length, firstDate: result.value[0].time, lastDate: result.value[result.value.length - 1].time, sha256: sha(canonical(result.value)) }); });
  var manifest = { schemaVersion: 1, source: 'Yahoo Finance chart API (.JK, unadjusted daily OHLCV)', acquisitionDateUtc: new Date().toISOString(), requestedRange: { from: options.from, to: options.to }, selection: 'unique normalized repository universe, lexicographic first ' + options.limit, universeSha256: sha(raw.join('\n') + '\n'), concurrency: options.concurrency, retryAttempts: 3, minimumCandles: options.minCandles, entries: entries, failures: failures };
  manifest.datasetSha256 = sha(canonical(entries)); manifest.manifestSha256 = sha(canonical(manifest)); fs.writeFileSync(options.manifest, JSON.stringify(manifest, null, 2) + '\n'); return manifest;
}
async function main(argv) { var a = parseArgs(argv), options = { universe: path.resolve(a.universe || 'data/daytrade-observe-tickers.txt'), output: path.resolve(a.output || 'data/abcd-validation'), manifest: path.resolve(a.manifest || 'data/reports/abcd-acquisition-manifest.json'), from: a.from || '2023-01-01', to: a.to || new Date().toISOString().slice(0, 10), limit: Number(a.limit || 60), minCandles: Number(a['min-candles'] || 700), concurrency: Math.min(MAX_CONCURRENCY, Math.max(1, Number(a.concurrency || DEFAULT_CONCURRENCY))), fetchFn: fetch }; if (!Number.isInteger(options.limit) || options.limit < 30 || !Number.isInteger(options.minCandles) || options.minCandles < 1) throw new Error('limit must be >= 30 and min-candles positive'); var report = await run(options); process.stdout.write(JSON.stringify(report, null, 2) + '\n'); }
if (require.main === module) main(process.argv.slice(2)).catch(function(e) { process.stderr.write('ABCD acquisition error: ' + e.message + '\n'); process.exitCode = 1; });
module.exports = { normalizeTicker: normalizeTicker, yahooDate: yahooDate, normalizeYahoo: normalizeYahoo, mapBounded: mapBounded, fetchTicker: fetchTicker, run: run, canonical: canonical };
