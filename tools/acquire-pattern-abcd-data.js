#!/usr/bin/env node
'use strict';

// Explicit, offline-only research downloader. Nothing in the production runtime
// imports this module. Downloaded candles and generated manifests are gitignored.
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var t1Policy = require('../lib/chart-t1-policy');
var TICKER_RE = /^[A-Z]{3,5}$/;
var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
var DEFAULT_CONCURRENCY = 3;
var MAX_CONCURRENCY = 5;
var RETRY_ATTEMPTS = 3;
var ALLOWED_FAILURES = new Set([
  'fetch_failed', 'request_timeout', 'invalid_yahoo_schema',
  'malformed_yahoo_timestamp', 'duplicate_yahoo_date',
  'unordered_yahoo_dates', 'invalid_yahoo_ohlc', 'invalid_yahoo_json'
]);

function parseArgs(argv) {
  var out = {};
  for (var i = 0; i < argv.length; i++) {
    var key = argv[i];
    if (!key.startsWith('--') || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(key + ' requires a value');
    out[key.slice(2)] = argv[++i];
  }
  return out;
}
function normalizeTicker(value) {
  var ticker = String(value == null ? '' : value).trim().toUpperCase().replace(/\.JK$/, '');
  return TICKER_RE.test(ticker) ? ticker : null;
}
function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(function(k) { return JSON.stringify(k) + ':' + canonical(value[k]); }).join(',') + '}';
  return JSON.stringify(value);
}
function validCalendarDate(value) {
  if (!DATE_RE.test(String(value || ''))) return false;
  var date = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function validateOptions(options) {
  if (!validCalendarDate(options.from) || !validCalendarDate(options.to)) throw new Error('from and to must be real YYYY-MM-DD dates');
  if (options.from > options.to) throw new Error('from must not exceed to');
  if (!Number.isInteger(options.limit) || options.limit < 30) throw new Error('limit must be an integer >= 30');
  if (!Number.isInteger(options.minCandles) || options.minCandles < 1) throw new Error('min-candles must be a positive integer');
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > MAX_CONCURRENCY) throw new Error('concurrency must be an integer from 1 through ' + MAX_CONCURRENCY);
  var jakartaToday = t1Policy.formatJakartaDate(options.now || new Date());
  if (!jakartaToday || options.to >= jakartaToday) throw new Error('to must be earlier than the current Jakarta date so only completed daily candles are acquired');
}
function yahooDate(timestamp) {
  var seconds = t1Policy.normalizeUnixTimestampSeconds(timestamp);
  if (seconds == null || !Number.isInteger(seconds) || seconds < 0) return null;
  var date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime())) return null;
  return t1Policy.formatJakartaDate(date);
}
function roundPrice(value) { return Math.round(value * 100) / 100; }
function normalizeYahoo(payload, options) {
  options = options || {};
  var result = payload && payload.chart && payload.chart.result && payload.chart.result[0];
  var quote = result && result.indicators && result.indicators.quote && result.indicators.quote[0];
  var timestamps = result && result.timestamp;
  if (!quote || !Array.isArray(timestamps)) throw new Error('invalid_yahoo_schema');
  var candles = [];
  var seen = new Set();
  var previous = null;
  timestamps.forEach(function(ts, i) {
    var time = yahooDate(ts);
    var values = ['open', 'high', 'low', 'close'].map(function(k) { return Array.isArray(quote[k]) ? quote[k][i] : null; });
    var volume = Array.isArray(quote.volume) ? quote.volume[i] : null;
    if (!time) throw new Error('malformed_yahoo_timestamp');
    if (seen.has(time)) throw new Error('duplicate_yahoo_date');
    if (previous && time < previous) throw new Error('unordered_yahoo_dates');
    previous = time;
    seen.add(time);
    if (options.from && time < options.from || options.to && time > options.to) return;
    if (!values.every(function(n) { return typeof n === 'number' && Number.isFinite(n) && n > 0; })) return;
    var candle = {
      time: time,
      open: roundPrice(values[0]),
      high: roundPrice(values[1]),
      low: roundPrice(values[2]),
      close: roundPrice(values[3]),
      volume: typeof volume === 'number' && Number.isFinite(volume) && volume >= 0 ? volume : 0
    };
    if (candle.high < Math.max(candle.open, candle.close, candle.low) || candle.low > Math.min(candle.open, candle.close)) throw new Error('invalid_yahoo_ohlc');
    candles.push(candle);
  });
  return candles;
}
function sleep(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }
function boundedFetchReason(error) {
  var message = String(error && error.message || 'fetch_failed');
  if (ALLOWED_FAILURES.has(message)) return message;
  if (/^yahoo_http_[1-5]\d\d$/.test(message)) return message;
  if (error && error.name === 'AbortError') return 'request_timeout';
  return 'fetch_failed';
}
function buildYahooUrl(ticker, options) {
  var period1 = Math.floor(Date.parse(options.from + 'T00:00:00.000Z') / 1000);
  var period2 = Math.floor((Date.parse(options.to + 'T00:00:00.000Z') + 86400000) / 1000);
  return 'https://query1.finance.yahoo.com/v8/finance/chart/' + ticker + '.JK?period1=' + period1 + '&period2=' + period2 + '&interval=1d&events=history';
}
async function fetchTicker(ticker, options) {
  var url = buildYahooUrl(ticker, options);
  var lastReason = 'fetch_failed';
  for (var attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, options.timeoutMs || 15000);
    try {
      var response = await options.fetchFn(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; auto-cuan-offline-pattern-validation/1.0)' }
      });
      if (!response || !response.ok) throw new Error('yahoo_http_' + (response && response.status || 0));
      var payload;
      try { payload = await response.json(); } catch (_) { throw new Error('invalid_yahoo_json'); }
      return normalizeYahoo(payload, { from: options.from, to: options.to });
    } catch (error) {
      lastReason = boundedFetchReason(error);
      if (attempt < RETRY_ATTEMPTS) await sleep(attempt * 500);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastReason);
}
async function mapBounded(items, concurrency, fn) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('invalid_concurrency');
  var next = 0;
  var results = new Array(items.length);
  async function worker() {
    while (next < items.length) {
      var index = next++;
      try { results[index] = { value: await fn(items[index]) }; }
      catch (error) { results[index] = { error: boundedFetchReason(error) }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
function safeReplaceDirectory(staging, output) {
  var root = path.parse(output).root;
  if (output === root) throw new Error('unsafe output directory');
  var backup = output + '.previous-' + process.pid;
  fs.rmSync(backup, { recursive: true, force: true });
  if (fs.existsSync(output)) fs.renameSync(output, backup);
  try {
    fs.renameSync(staging, output);
    fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (!fs.existsSync(output) && fs.existsSync(backup)) fs.renameSync(backup, output);
    throw error;
  }
}
async function run(options) {
  validateOptions(options);
  var universeText = fs.readFileSync(options.universe, 'utf8');
  var raw = universeText.split(/\r?\n/).map(function(line) { return line.trim(); }).filter(Boolean);
  var normalized = raw.map(normalizeTicker);
  if (normalized.some(function(value) { return !value; })) throw new Error('universe contains invalid ticker');
  var tickers = Array.from(new Set(normalized)).sort().slice(0, options.limit);
  var results = await mapBounded(tickers, options.concurrency, function(ticker) { return fetchTicker(ticker, options); });
  var entries = [];
  var failures = [];
  var datasets = [];
  results.forEach(function(result, index) {
    var ticker = tickers[index];
    if (result.error) { failures.push({ ticker: ticker, reason: result.error }); return; }
    if (result.value.length < options.minCandles) { failures.push({ ticker: ticker, reason: 'insufficient_candles', candleCount: result.value.length }); return; }
    var candleSha = sha(canonical(result.value));
    entries.push({ ticker: ticker, candleCount: result.value.length, firstDate: result.value[0].time, lastDate: result.value[result.value.length - 1].time, sha256: candleSha });
    datasets.push({ ticker: ticker, candles: result.value });
  });
  entries.sort(function(a, b) { return a.ticker.localeCompare(b.ticker); });
  failures.sort(function(a, b) { return a.ticker.localeCompare(b.ticker) || a.reason.localeCompare(b.reason); });
  datasets.sort(function(a, b) { return a.ticker.localeCompare(b.ticker); });
  var manifest = {
    schemaVersion: 2,
    source: 'Yahoo Finance chart API (.JK, production-compatible unadjusted daily OHLCV)',
    datePolicy: 'Yahoo epoch seconds converted to Asia/Jakarta calendar date; explicit completed range only',
    requestedRange: { from: options.from, to: options.to },
    selection: 'unique normalized repository universe, lexicographic first ' + options.limit,
    selectedTickers: tickers,
    universeSha256: sha(universeText),
    concurrency: options.concurrency,
    retryAttempts: RETRY_ATTEMPTS,
    minimumCandles: options.minCandles,
    entries: entries,
    failures: failures,
    datasetSha256: sha(canonical(datasets))
  };
  manifest.manifestSha256 = sha(canonical(manifest));
  var staging = options.output + '.staging-' + process.pid;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  datasets.forEach(function(dataset) { fs.writeFileSync(path.join(staging, dataset.ticker + '.json'), JSON.stringify(dataset.candles) + '\n'); });
  safeReplaceDirectory(staging, options.output);
  fs.mkdirSync(path.dirname(options.manifest), { recursive: true });
  fs.writeFileSync(options.manifest, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
async function main(argv) {
  var args = parseArgs(argv);
  if (!args.from || !args.to) throw new Error('--from and --to are required for reproducibility');
  var options = {
    universe: path.resolve(args.universe || 'data/daytrade-observe-tickers.txt'),
    output: path.resolve(args.output || 'data/abcd-validation'),
    manifest: path.resolve(args.manifest || 'data/reports/abcd-acquisition-manifest.json'),
    from: args.from,
    to: args.to,
    limit: Number(args.limit || 60),
    minCandles: Number(args['min-candles'] || 700),
    concurrency: Number(args.concurrency || DEFAULT_CONCURRENCY),
    fetchFn: fetch
  };
  var report = await run(options);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
if (require.main === module) main(process.argv.slice(2)).catch(function(error) {
  process.stderr.write('ABCD acquisition error: ' + String(error && error.message || 'acquisition_failed').slice(0, 160) + '\n');
  process.exitCode = 1;
});
module.exports = {
  normalizeTicker: normalizeTicker,
  validCalendarDate: validCalendarDate,
  validateOptions: validateOptions,
  yahooDate: yahooDate,
  normalizeYahoo: normalizeYahoo,
  boundedFetchReason: boundedFetchReason,
  buildYahooUrl: buildYahooUrl,
  mapBounded: mapBounded,
  fetchTicker: fetchTicker,
  run: run,
  canonical: canonical
};
