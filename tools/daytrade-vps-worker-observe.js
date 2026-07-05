#!/usr/bin/env node
'use strict';

/**
 * Day Trade VPS Observe Worker v1.1.
 * Observe-only: no Supabase writes, no Telegram sends, no API endpoints.
 * v1.1: Uses reusable daytrade-ohlcv-cache module for candle caching.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const engine = require('../lib/daytrade-screener-engine');
const ohlcvCache = require('../lib/daytrade-ohlcv-cache');

const VERSION = 'daytrade-vps-observe-v1.1';
const DEFAULT_CACHE_DIR = path.join(process.cwd(), 'data', 'daytrade-ohlcv-cache');
const DEFAULT_LOG_DIR = path.join(process.cwd(), 'logs', 'daytrade-vps-worker');
const DEFAULT_LOCK_FILE = path.join(process.cwd(), 'tmp', 'daytrade-vps-worker-observe.lock');
const DEFAULT_CONCURRENCY = Number(process.env.DAYTRADE_WORKER_CONCURRENCY || 4);
const DEFAULT_TIMEOUT_MS = Number(process.env.DAYTRADE_YAHOO_TIMEOUT_MS || 12000);
const CACHE_MAX_AGE_MS = Number(process.env.DAYTRADE_CACHE_MAX_AGE_MS || 12 * 60 * 60 * 1000);
const DEFAULT_LOOP_INTERVAL_MS = Number(process.env.DAYTRADE_LOOP_INTERVAL_MS || 15 * 60 * 1000);
const CIRCUIT_THRESHOLD = Number(process.env.DAYTRADE_CIRCUIT_THRESHOLD || 5);
const CIRCUIT_COOLDOWN_MS = Number(process.env.DAYTRADE_CIRCUIT_COOLDOWN_MS || 60 * 1000);
const LOCK_TTL_MS = Number(process.env.DAYTRADE_LOCK_TTL_MS || 30 * 60 * 1000);

function parseArgs(argv) {
  const args = { mode: 'observe', tickers: null, limit: null, compare: false, loop: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--compare') args.compare = true;
    else if (a === '--loop') args.loop = true;
    else if (a.indexOf('--') === 0) {
      const key = a.slice(2);
      const val = argv[i + 1] && argv[i + 1].indexOf('--') !== 0 ? argv[++i] : 'true';
      args[key] = val;
    }
  }
  if (args.tickers) args.tickers = String(args.tickers).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (args.limit) args.limit = Number(args.limit);
  return args;
}

function assertObserveOnly(mode) {
  if (mode !== 'observe') throw new Error('Day Trade VPS worker is observe-only; use --mode observe.');
  if (process.env.DAYTRADE_WORKER_ALLOW_MUTATION === 'true') throw new Error('Mutation env is forbidden for observe worker.');
  return true;
}

function safeTicker(ticker) {
  return String(ticker || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
}

function cachePath(cacheDir, ticker) { return path.join(cacheDir, safeTicker(ticker) + '.json'); }

async function readCache(cacheDir, ticker, nowMs) {
  try {
    const raw = await fsp.readFile(cachePath(cacheDir, ticker), 'utf8');
    const parsed = JSON.parse(raw);
    const candles = Array.isArray(parsed.candles) ? parsed.candles : [];
    const updatedAtMs = parsed.updated_at ? Date.parse(parsed.updated_at) : 0;
    return { hit: true, stale: !updatedAtMs || (nowMs - updatedAtMs) > CACHE_MAX_AGE_MS, candles, meta: parsed };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { hit: false, stale: true, candles: [], meta: null };
    return { hit: false, stale: true, candles: [], meta: null, error: e.message };
  }
}

async function writeCache(cacheDir, ticker, candles, source) {
  await fsp.mkdir(cacheDir, { recursive: true });
  const trimmed = normalizeCandles(candles).slice(-90);
  const payload = { version: 1, ticker: safeTicker(ticker), source: source || 'yahoo', range: '90d', interval: '1d', updated_at: new Date().toISOString(), candles: trimmed };
  await fsp.writeFile(cachePath(cacheDir, ticker), JSON.stringify(payload, null, 2) + '\n');
  return payload;
}

function candleKey(c) {
  if (!c) return null;
  if (c.date) return String(c.date).slice(0, 10);
  if (c.time) return new Date(Number(c.time) * 1000).toISOString().slice(0, 10);
  return null;
}

function normalizeCandles(candles) {
  return (Array.isArray(candles) ? candles : []).filter(Boolean).map((c) => ({
    time: Number(c.time),
    date: c.date || (c.time ? new Date(Number(c.time) * 1000).toISOString().slice(0, 10) : undefined),
    open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume)
  })).filter((c) => Number.isFinite(c.time) && Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close) && Number.isFinite(c.volume));
}

function mergeLatestCandle(cachedCandles, latestCandles) {
  const base = normalizeCandles(cachedCandles);
  const latest = normalizeCandles(latestCandles);
  if (latest.length === 0) return { candles: base.slice(-90), updated: false };
  const lc = latest[latest.length - 1];
  const lk = candleKey(lc);
  const without = base.filter((c) => candleKey(c) !== lk);
  without.push(lc);
  without.sort((a, b) => a.time - b.time);
  return { candles: without.slice(-90), updated: true, latestKey: lk };
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function jitter(ms) { return ms + Math.floor(Math.random() * Math.max(1, ms * 0.25)); }

async function fetchCandlesYahoo(ticker, opts) {
  opts = opts || {};
  const range = opts.range || '90d';
  const symbol = safeTicker(ticker) + '.JK';
  const url = 'https://query2.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=' + range + '&interval=1d&includePrePost=false';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'Auto-Cuan-DayTrade-Observe/1.0' } });
    if (!res.ok) { const err = new Error('Yahoo HTTP ' + res.status); err.status = res.status; throw err; }
    const data = await res.json();
    const r = data && data.chart && data.chart.result && data.chart.result[0];
    const q = r && r.indicators && r.indicators.quote && r.indicators.quote[0];
    if (!r || !q) return [];
    return normalizeCandles((r.timestamp || []).map((time, i) => ({ time, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] })));
  } finally { clearTimeout(timer); }
}

async function withRetry(fn, opts) {
  opts = opts || {};
  const attempts = opts.attempts || 3;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(jitter((opts.baseDelayMs || 500) * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length); let next = 0;
  async function run() { while (next < items.length) { const idx = next++; out[idx] = await worker(items[idx], idx); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

function isPidRunning(pid) {
  if (!pid || !Number.isFinite(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

async function readLockState(lockFile) {
  try {
    const raw = await fsp.readFile(lockFile, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function isLockStale(lockState, nowMs, ttlMs) {
  if (!lockState) return true;
  const startedAtMs = lockState.started_at ? Date.parse(lockState.started_at) : 0;
  if (!isPidRunning(lockState.pid)) return true;
  if (!startedAtMs || (nowMs - startedAtMs) > ttlMs) return true;
  return false;
}

async function acquireLock(lockFile, opts) {
  opts = opts || {};
  const ttlMs = Number(opts.ttlMs || LOCK_TTL_MS);
  await fsp.mkdir(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = await fsp.open(lockFile, 'wx');
      await fd.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }) + '\n');
      return async function release() { await fd.close().catch(() => {}); await fsp.unlink(lockFile).catch(() => {}); };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;

      const lockState = await readLockState(lockFile);
      if (!isLockStale(lockState, Date.now(), ttlMs)) return null;

      await fsp.unlink(lockFile).catch(function(unlinkErr) {
        if (!unlinkErr || unlinkErr.code !== 'ENOENT') throw unlinkErr;
      });
    }
  }
  return null;
}

function summarizeRejected(failed) {
  return (failed || []).reduce((acc, f) => { const r = f.reason || 'unknown'; acc[r] = (acc[r] || 0) + 1; return acc; }, {});
}

async function getDefaultTickers(limit) {
  const list = ['BBCA','BBRI','BMRI','TLKM','ASII','UNVR','BBNI','GOTO','BRIS','AMMN','ADRO','BRPT','INDF','ICBP','MDKA','PGAS','ANTM','INCO','PTBA','SMGR'];
  return list.slice(0, limit || list.length).map((ticker) => ({ ticker, board: 'UTAMA' }));
}

async function runWorker(cliArgs) {
  const started = Date.now();
  const args = Object.assign(parseArgs(process.argv), cliArgs || {});
  assertObserveOnly(args.mode);
  const cacheDir = process.env.DAYTRADE_CACHE_DIR || args.cacheDir || DEFAULT_CACHE_DIR;
  const logDir = process.env.DAYTRADE_LOG_DIR || args.logDir || DEFAULT_LOG_DIR;
  const cacheTtlMs = Number(process.env.DAYTRADE_CACHE_TTL_MS || ohlcvCache.DEFAULT_TTL_MS);
  const release = await acquireLock(process.env.DAYTRADE_LOCK_FILE || args.lockFile || DEFAULT_LOCK_FILE);
  if (!release) { console.log('Day Trade observe worker already running; skip overlap.'); return { skipped: true }; }

  // Create cache provider from reusable module (with circuit breaker wrapper)
  const breaker = { failures: 0, openedUntil: 0 };
  const cacheProvider = ohlcvCache.createCacheProvider({
    cacheDir: cacheDir,
    ttlMs: cacheTtlMs,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    fetchFn: async function(ticker, opts) {
      if (Date.now() < breaker.openedUntil) throw new Error('circuit_open');
      try {
        const result = await withRetry(() => fetchCandlesYahoo(ticker, opts), { attempts: 3 });
        breaker.failures = 0;
        return result;
      } catch (e) {
        if (/abort|timeout|429/i.test(e.message || '') || e.status === 429) breaker.failures++;
        if (breaker.failures >= CIRCUIT_THRESHOLD) breaker.openedUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
        throw e;
      }
    }
  });

  try {
    let tickers = args.tickers ? args.tickers.map((ticker) => ({ ticker, board: 'UTAMA' })) : await getDefaultTickers(args.limit);
    if (args.limit) tickers = tickers.slice(0, args.limit);
    const candleByTicker = {};
    await mapLimit(tickers, Math.max(1, Math.min(Number(args.concurrency || DEFAULT_CONCURRENCY), 5)), async (item) => {
      const ticker = item.ticker;
      try {
        const candles = await cacheProvider.fetchWithCache(ticker);
        if (candles && candles.length >= 20) {
          candleByTicker[ticker] = candles;
        } else {
          item._skipReason = 'insufficient_candles';
        }
      } catch (e) {
        item._skipReason = e.message || 'unknown';
      }
    });
    const scanTickers = tickers.filter((t) => candleByTicker[t.ticker]);
    const result = await engine.runDayTradeBatch(scanTickers, engine.getRunMode(), { fetchCandles: (ticker) => Promise.resolve(candleByTicker[ticker]), noDelay: true, observeOnly: true });
    const candidates = result.results.filter((r) => ['A_PLUS_SETUP','TRADE_CANDIDATE','READY_BREAKOUT','MOMENTUM_CONTINUATION','PRE_SPIKE_WATCH','EARLY_RADAR'].includes(r.status));
    const providerStats = cacheProvider.getStats();
    const log = {
      version: VERSION,
      mode: 'observe',
      started_at: new Date(started).toISOString(),
      ended_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      loop_interval_ms: DEFAULT_LOOP_INTERVAL_MS,
      cache_ttl_ms: cacheTtlMs,
      tickers_scanned: scanTickers.length,
      fetch_success_count: providerStats.fetchSuccess,
      fetch_fail_count: providerStats.fetchFail,
      cache_hit_count: providerStats.cacheHit,
      cache_miss_count: providerStats.cacheMiss,
      stale_fallback_count: providerStats.staleFallback,
      candidate_count: candidates.length,
      top_candidates: result.results.slice(0, 10).map((r) => ({ ticker: r.ticker, status: r.status, score: r.daytrade_score, rr: r.risk_reward })),
      rejected_reasons_summary: summarizeRejected(result.failed.concat(tickers.filter((t) => t._skipReason).map((t) => ({ ticker: t.ticker, reason: t._skipReason }))))
    };
    await fsp.mkdir(logDir, { recursive: true });
    await fsp.appendFile(path.join(logDir, 'runs.jsonl'), JSON.stringify(log) + '\n');
    console.log(JSON.stringify(log, null, 2));
    return log;
  } finally { await release(); }
}

if (require.main === module) {
  const _mainArgs = parseArgs(process.argv);
  if (_mainArgs.loop) {
    runLoop(_mainArgs).catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });
  } else {
    runWorker().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });
  }
}

/**
 * Loop mode: run observe worker repeatedly at DEFAULT_LOOP_INTERVAL_MS.
 * Observe-only guarantee is enforced on every iteration.
 * Stops on SIGINT/SIGTERM for graceful shutdown.
 *
 * Usage:
 *   node tools/daytrade-vps-worker-observe.js --mode observe --loop
 *   node tools/daytrade-vps-worker-observe.js --mode observe --loop --limit 20
 */
async function runLoop(cliArgs) {
  cliArgs = cliArgs || {};
  const intervalMs = Number(cliArgs.interval_ms || process.env.DAYTRADE_LOOP_INTERVAL_MS || DEFAULT_LOOP_INTERVAL_MS);
  let running = true;
  let iteration = 0;

  function stop() { running = false; }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  console.log('[loop] Day Trade observe loop starting. Interval: ' + Math.round(intervalMs / 1000) + 's (' + Math.round(intervalMs / 60000) + ' min). Ctrl+C to stop.');

  while (running) {
    iteration++;
    const iterStart = Date.now();
    console.log('[loop] Iteration ' + iteration + ' starting at ' + new Date().toISOString());
    try {
      await runWorker(cliArgs);
    } catch (e) {
      console.error('[loop] Iteration ' + iteration + ' error: ' + (e.message || e));
    }
    const elapsed = Date.now() - iterStart;
    const waitMs = Math.max(0, intervalMs - elapsed);

    if (!running) break;
    if (waitMs > 0) {
      console.log('[loop] Iteration ' + iteration + ' done (' + Math.round(elapsed / 1000) + 's). Next in ' + Math.round(waitMs / 1000) + 's.');
      await sleep(waitMs);
    }
  }

  console.log('[loop] Loop stopped after ' + iteration + ' iteration(s).');
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  return { iterations: iteration, stopped: true };
}

module.exports = { VERSION, DEFAULT_LOOP_INTERVAL_MS, parseArgs, assertObserveOnly, readCache, writeCache, mergeLatestCandle, acquireLock, withRetry, runWorker, runLoop, normalizeCandles, isLockStale, isPidRunning, ohlcvCache };
