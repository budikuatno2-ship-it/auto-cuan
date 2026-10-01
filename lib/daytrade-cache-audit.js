'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const ohlcvCache = require('./daytrade-ohlcv-cache');

const DEFAULT_CACHE_DIR = path.resolve(process.cwd(), 'data', 'daytrade-ohlcv-cache');
const DEFAULT_LOGS_FILE = path.resolve(process.cwd(), 'logs', 'daytrade-vps-worker', 'runs.jsonl');
const DEFAULT_REPORTS_DIR = path.resolve(process.cwd(), 'data', 'reports');
const DEFAULT_TTL_MINUTES = 15;

function ageBucket(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return 'unknown';
  if (ageMs < 15 * 60 * 1000) return '<15m';
  if (ageMs < 60 * 60 * 1000) return '15m-1h';
  if (ageMs < 12 * 60 * 60 * 1000) return '1h-12h';
  return '>12h';
}

function parseCachePayload(raw, fileName, nowMs, ttlMs) {
  const parsed = JSON.parse(raw);
  const candles = ohlcvCache.normalizeCandles(parsed.candles);
  const updatedAtMs = parsed.updated_at ? Date.parse(parsed.updated_at) : 0;
  const ageMs = updatedAtMs ? nowMs - updatedAtMs : Infinity;
  const ticker = parsed.ticker || path.basename(fileName || '', '.json');
  return {
    file: fileName,
    ticker,
    valid: true,
    candle_count: candles.length,
    has_min_candles: candles.length >= 20,
    interval: parsed.interval || null,
    range: parsed.range || null,
    interval_range_mismatch: parsed.interval !== '1d' || parsed.range !== '90d',
    updated_at: parsed.updated_at || null,
    updated_at_ms: updatedAtMs,
    fresh: updatedAtMs ? ohlcvCache.isCacheFresh(updatedAtMs, nowMs, ttlMs) : false,
    age_ms: ageMs,
    age_bucket: ageBucket(ageMs),
    source: parsed.source || null
  };
}

async function auditCache(opts) {
  opts = opts || {};
  const cacheDir = opts.cacheDir || DEFAULT_CACHE_DIR;
  const nowMs = Number(opts.nowMs || Date.now());
  const ttlMs = Number(opts.ttlMs || (Number(opts.ttlMinutes || DEFAULT_TTL_MINUTES) * 60 * 1000));
  const limitSamples = Number(opts.limitSamples == null ? 10 : opts.limitSamples);
  const summary = {
    cache_dir: cacheDir,
    total_cache_files: 0,
    valid_cache_files: 0,
    invalid_corrupt_cache_files: 0,
    tickers_with_gte_20_candles: 0,
    tickers_with_lt_20_candles: 0,
    interval_range_mismatch: 0,
    average_candle_count: 0,
    min_updated_at: null,
    max_updated_at: null,
    fresh_count: 0,
    stale_count: 0,
    stale_fallback_indications: 0,
    cache_age_buckets: { '<15m': 0, '15m-1h': 0, '1h-12h': 0, '>12h': 0, unknown: 0 },
    samples: { invalid: [], lt_20_candles: [], interval_range_mismatch: [], stale: [] }
  };

  let files;
  try {
    files = (await fs.readdir(cacheDir)).filter((f) => f.endsWith('.json')).sort();
  } catch (e) {
    if (e && e.code === 'ENOENT') return Object.assign(summary, { cache_dir_found: false });
    throw e;
  }
  summary.cache_dir_found = true;
  summary.total_cache_files = files.length;
  let candleTotal = 0;
  const updatedAts = [];

  for (const file of files) {
    try {
      const item = parseCachePayload(await fs.readFile(path.join(cacheDir, file), 'utf8'), file, nowMs, ttlMs);
      summary.valid_cache_files++;
      candleTotal += item.candle_count;
      if (item.has_min_candles) summary.tickers_with_gte_20_candles++; else {
        summary.tickers_with_lt_20_candles++;
        pushSample(summary.samples.lt_20_candles, item, limitSamples);
      }
      if (item.interval_range_mismatch) { summary.interval_range_mismatch++; pushSample(summary.samples.interval_range_mismatch, item, limitSamples); }
      if (item.updated_at_ms) updatedAts.push(item.updated_at_ms);
      if (item.fresh) summary.fresh_count++; else { summary.stale_count++; pushSample(summary.samples.stale, item, limitSamples); }
      summary.cache_age_buckets[item.age_bucket] = (summary.cache_age_buckets[item.age_bucket] || 0) + 1;
    } catch (e) {
      summary.invalid_corrupt_cache_files++;
      pushSample(summary.samples.invalid, { file, error: e.message }, limitSamples);
    }
  }
  summary.average_candle_count = summary.valid_cache_files ? Number((candleTotal / summary.valid_cache_files).toFixed(2)) : 0;
  if (updatedAts.length) {
    summary.min_updated_at = new Date(Math.min.apply(null, updatedAts)).toISOString();
    summary.max_updated_at = new Date(Math.max.apply(null, updatedAts)).toISOString();
  }
  return summary;
}

function pushSample(arr, item, limit) {
  if (limit > 0 && arr.length < limit) arr.push(item);
}

async function summarizeLogs(opts) {
  opts = opts || {};
  const logsFile = opts.logsFile || DEFAULT_LOGS_FILE;
  const limitSamples = Number(opts.limitSamples == null ? 10 : opts.limitSamples);
  const summary = { logs_file: logsFile, logs_found: false, total_runs: 0, latest_run_timestamp: null, latest: {}, totals: { ticker_count: 0, processed_count: 0, cache_hit: 0, cache_miss: 0, fetch_fail: 0, stale_fallback: 0 }, top_errors: [] };
  let raw;
  try { raw = await fs.readFile(logsFile, 'utf8'); } catch (e) { if (e && e.code === 'ENOENT') return summary; throw e; }
  summary.logs_found = true;
  const errors = new Map();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch (e) { errors.set('invalid_jsonl', (errors.get('invalid_jsonl') || 0) + 1); continue; }
    summary.total_runs++;
    const ts = row.ended_at || row.started_at || row.timestamp || row.created_at || null;
    if (ts && (!summary.latest_run_timestamp || Date.parse(ts) > Date.parse(summary.latest_run_timestamp))) {
      summary.latest_run_timestamp = ts;
      summary.latest = row;
    }
    summary.totals.ticker_count += Number(row.ticker_count || row.tickers_count || row.tickers_scanned || 0);
    summary.totals.processed_count += Number(row.processed_count || row.tickers_scanned || 0);
    summary.totals.cache_hit += Number(row.cache_hit_count || row.cacheHit || 0);
    summary.totals.cache_miss += Number(row.cache_miss_count || row.cacheMiss || 0);
    summary.totals.fetch_fail += Number(row.fetch_fail_count || row.fetchFail || 0);
    summary.totals.stale_fallback += Number(row.stale_fallback_count || row.staleFallback || 0);
    const rejected = row.rejected_reasons_summary || {};
    for (const [reason, count] of Object.entries(rejected)) errors.set(reason, (errors.get(reason) || 0) + Number(count || 0));
    if (row.error) errors.set(row.error, (errors.get(row.error) || 0) + 1);
  }
  summary.top_errors = Array.from(errors.entries()).sort((a, b) => b[1] - a[1]).slice(0, limitSamples).map(([error, count]) => ({ error, count }));
  return summary;
}

function markdownReport(report) {
  const c = report.cache;
  const l = report.logs;
  return `# Day Trade Cache Audit — ${report.date}\n\n## Cache Health\n\n- cache_dir: \`${c.cache_dir}\`\n- cache_dir_found: ${c.cache_dir_found}\n- total cache files: ${c.total_cache_files}\n- valid cache files: ${c.valid_cache_files}\n- invalid/corrupt cache files: ${c.invalid_corrupt_cache_files}\n- tickers with >=20 candles: ${c.tickers_with_gte_20_candles}\n- tickers with <20 candles: ${c.tickers_with_lt_20_candles}\n- interval/range mismatch: ${c.interval_range_mismatch}\n- average candle count: ${c.average_candle_count}\n- min updated_at: ${c.min_updated_at || 'n/a'}\n- max updated_at: ${c.max_updated_at || 'n/a'}\n- fresh count: ${c.fresh_count}\n- stale count: ${c.stale_count}\n- stale fallback indications: ${c.stale_fallback_indications}\n\n### Cache Age Buckets\n\n- <15m: ${c.cache_age_buckets['<15m']}\n- 15m-1h: ${c.cache_age_buckets['15m-1h']}\n- 1h-12h: ${c.cache_age_buckets['1h-12h']}\n- >12h: ${c.cache_age_buckets['>12h']}\n\n## Observe Worker Log Health\n\n- logs_file: \`${l.logs_file}\`\n- logs_found: ${l.logs_found}\n- total runs: ${l.total_runs}\n- latest run timestamp: ${l.latest_run_timestamp || 'n/a'}\n- ticker_count total: ${l.totals.ticker_count}\n- processed_count total: ${l.totals.processed_count}\n- cache hit/miss/fetch fail/stale fallback: ${l.totals.cache_hit}/${l.totals.cache_miss}/${l.totals.fetch_fail}/${l.totals.stale_fallback}\n- top errors: ${l.top_errors.length ? l.top_errors.map((e) => `${e.error} (${e.count})`).join(', ') : 'none'}\n`;
}

async function writeReports(report, opts) {
  opts = opts || {};
  const reportsDir = opts.reportsDir || DEFAULT_REPORTS_DIR;
  await fs.mkdir(reportsDir, { recursive: true });
  const base = path.join(reportsDir, 'daytrade-cache-audit-' + report.date);
  const mdPath = base + '.md';
  await fs.writeFile(mdPath, markdownReport(report));
  let jsonPath = null;
  if (opts.writeJson) { jsonPath = base + '.json'; await fs.writeFile(jsonPath, JSON.stringify(report, null, 2) + '\n'); }
  return { markdown: mdPath, json: jsonPath };
}

module.exports = { DEFAULT_CACHE_DIR, DEFAULT_LOGS_FILE, DEFAULT_REPORTS_DIR, DEFAULT_TTL_MINUTES, ageBucket, parseCachePayload, auditCache, summarizeLogs, markdownReport, writeReports };
