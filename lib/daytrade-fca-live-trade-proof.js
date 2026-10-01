'use strict';

const fs = require('node:fs');
const path = require('node:path');
const fsp = fs.promises;
const calendar = require('./idx-trading-calendar');
const fcaTransition2026 = require('./fca-transition-2026');

const DEFAULT_TIMEOUT_MS = 1800;
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_MIN_POSITIVE_BARS = 2;
const DEFAULT_RECENT_WINDOW_MS = 30 * 60 * 1000;
const DEFAULT_LATEST_TRADE_MAX_AGE_MS = 20 * 60 * 1000;
const DEFAULT_MAX_FUTURE_SKEW_MS = 2 * 60 * 1000;
const DEFAULT_STATE_FILENAME = 'daytrade-fca-live-trade-proof.json';

let memorySnapshot = null;

function normalizeTicker(value) {
  return fcaTransition2026.normalizeTicker(value);
}

function getSuspendedExitTickers() {
  return Array.from(new Set(
    ((fcaTransition2026.manifest && fcaTransition2026.manifest.suspended_as_of_status_date) || [])
      .map(normalizeTicker)
      .filter(Boolean)
  )).sort();
}

function toEpochMs(value) {
  if (value == null || value === '') return NaN;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return NaN;
    return value < 1000000000000 ? value * 1000 : value;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(value).trim() !== '') {
    return numeric < 1000000000000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function normalizeBars(rawBars) {
  return (Array.isArray(rawBars) ? rawBars : []).map(function (bar) {
    const ts = toEpochMs(bar && (bar.time != null ? bar.time : (bar.timestamp != null ? bar.timestamp : bar.date)));
    const close = Number(bar && (bar.close != null ? bar.close : bar.c));
    const volume = Number(bar && (bar.volume != null ? bar.volume : bar.v));
    return {
      time_ms: ts,
      close: close,
      volume: volume
    };
  }).filter(function (bar) {
    return Number.isFinite(bar.time_ms) &&
      Number.isFinite(bar.close) && bar.close > 0 &&
      Number.isFinite(bar.volume) && bar.volume >= 0;
  }).sort(function (a, b) { return a.time_ms - b.time_ms; });
}

function evaluateLiveTradeProof(ticker, rawBars, options) {
  options = options || {};
  const nowMs = toEpochMs(options.now != null ? options.now : Date.now());
  const cleanTicker = normalizeTicker(ticker);
  const minPositiveBars = Math.max(2, Number(options.minPositiveBars) || DEFAULT_MIN_POSITIVE_BARS);
  const recentWindowMs = Math.max(5 * 60 * 1000, Number(options.recentWindowMs) || DEFAULT_RECENT_WINDOW_MS);
  const latestTradeMaxAgeMs = Math.max(5 * 60 * 1000, Number(options.latestTradeMaxAgeMs) || DEFAULT_LATEST_TRADE_MAX_AGE_MS);
  const maxFutureSkewMs = Math.max(0, Number(options.maxFutureSkewMs) || DEFAULT_MAX_FUTURE_SKEW_MS);

  if (!cleanTicker || !Number.isFinite(nowMs)) {
    return { ticker: cleanTicker || null, verified: false, reason: 'invalid_input' };
  }

  const todayWib = calendar.toDateKey(new Date(nowMs));
  const bars = normalizeBars(rawBars).filter(function (bar) {
    if (bar.time_ms > nowMs + maxFutureSkewMs) return false;
    return calendar.toDateKey(new Date(bar.time_ms)) === todayWib;
  });

  if (!bars.length) {
    return { ticker: cleanTicker, verified: false, reason: 'no_today_intraday_bars', checked_at: new Date(nowMs).toISOString() };
  }

  const positiveBars = bars.filter(function (bar) { return bar.volume > 0; });
  if (!positiveBars.length) {
    return {
      ticker: cleanTicker,
      verified: false,
      reason: 'no_positive_volume_bars',
      checked_at: new Date(nowMs).toISOString(),
      today_bar_count: bars.length
    };
  }

  const latestPositive = positiveBars[positiveBars.length - 1];
  const latestAgeMs = Math.max(0, nowMs - latestPositive.time_ms);
  if (latestAgeMs > latestTradeMaxAgeMs) {
    return {
      ticker: cleanTicker,
      verified: false,
      reason: 'latest_trade_stale',
      checked_at: new Date(nowMs).toISOString(),
      latest_trade_at: new Date(latestPositive.time_ms).toISOString(),
      latest_trade_age_ms: latestAgeMs,
      positive_bar_count: positiveBars.length
    };
  }

  const recentPositiveBars = positiveBars.filter(function (bar) {
    const age = nowMs - bar.time_ms;
    return age >= -maxFutureSkewMs && age <= recentWindowMs;
  });

  const uniqueTimes = new Set(recentPositiveBars.map(function (bar) { return bar.time_ms; }));
  if (uniqueTimes.size < minPositiveBars) {
    return {
      ticker: cleanTicker,
      verified: false,
      reason: 'insufficient_recent_trade_bars',
      checked_at: new Date(nowMs).toISOString(),
      latest_trade_at: new Date(latestPositive.time_ms).toISOString(),
      latest_trade_age_ms: latestAgeMs,
      recent_positive_bar_count: uniqueTimes.size,
      required_positive_bar_count: minPositiveBars
    };
  }

  const recentVolume = recentPositiveBars.reduce(function (sum, bar) { return sum + bar.volume; }, 0);
  const uniquePrices = new Set(recentPositiveBars.map(function (bar) { return bar.close; }));

  return {
    ticker: cleanTicker,
    verified: true,
    reason: 'fresh_intraday_trades_verified',
    checked_at: new Date(nowMs).toISOString(),
    latest_trade_at: new Date(latestPositive.time_ms).toISOString(),
    latest_trade_age_ms: latestAgeMs,
    recent_positive_bar_count: uniqueTimes.size,
    recent_volume_sum: recentVolume,
    price_changed_in_window: uniquePrices.size > 1,
    proof_source: 'yahoo_chart_5m'
  };
}

async function fetchYahooIntradayBars(ticker, options) {
  options = options || {};
  const cleanTicker = normalizeTicker(ticker);
  if (!cleanTicker) return [];

  const timeoutMs = Math.max(500, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  const symbol = cleanTicker + '.JK';
  const url = 'https://query2.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(symbol) +
    '?range=1d&interval=5m&includePrePost=false';

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AutoCuan-DayTrade-FCA-Proof/1.0)' }
    });
    if (!response.ok) {
      const err = new Error('Yahoo HTTP ' + response.status);
      err.status = response.status;
      throw err;
    }

    const payload = await response.json();
    const result = payload && payload.chart && payload.chart.result && payload.chart.result[0];
    const quote = result && result.indicators && result.indicators.quote && result.indicators.quote[0];
    if (!result || !quote) return [];

    const timestamps = result.timestamp || [];
    const closes = quote.close || [];
    const volumes = quote.volume || [];
    const bars = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (timestamps[i] == null || closes[i] == null || volumes[i] == null) continue;
      bars.push({ time: timestamps[i], close: closes[i], volume: volumes[i] });
    }
    return bars;
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, worker) {
  const source = Array.isArray(items) ? items : [];
  const concurrency = Math.max(1, Math.min(source.length || 1, Number(limit) || 1));
  let cursor = 0;
  const output = new Array(source.length);

  async function runWorker() {
    while (true) {
      const index = cursor++;
      if (index >= source.length) return;
      output[index] = await worker(source[index], index);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, runWorker));
  return output;
}

function resolveStatePath(options) {
  options = options || {};
  if (options.statePath) return path.resolve(String(options.statePath));
  const runnerDir = process.env.AUTO_CUAN_RUNNER_DIR || '/home/ubuntu/auto-cuan-runner';
  return path.join(runnerDir, 'state', DEFAULT_STATE_FILENAME);
}

async function readPersistedSnapshot(options) {
  const statePath = resolveStatePath(options);
  try {
    const parsed = JSON.parse(await fsp.readFile(statePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

async function persistSnapshot(snapshot, options) {
  const statePath = resolveStatePath(options);
  try {
    await fsp.mkdir(path.dirname(statePath), { recursive: true });
    const tmpPath = statePath + '.tmp-' + process.pid + '-' + Date.now();
    await fsp.writeFile(tmpPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
    await fsp.rename(tmpPath, statePath);
    return true;
  } catch (_) {
    return false;
  }
}

function snapshotMatchesRun(snapshot, runId) {
  return !!(snapshot && String(snapshot.run_id || '') === String(runId || ''));
}

async function getCachedSnapshot(runId, options) {
  if (snapshotMatchesRun(memorySnapshot, runId)) {
    return Object.assign({}, memorySnapshot, { cache_source: 'memory' });
  }
  const persisted = await readPersistedSnapshot(options);
  if (snapshotMatchesRun(persisted, runId)) {
    memorySnapshot = persisted;
    return Object.assign({}, persisted, { cache_source: 'disk' });
  }
  return null;
}

async function refreshSuspendedExitProof(options) {
  options = options || {};
  const runId = String(options.runId || '');
  const nowMs = toEpochMs(options.now != null ? options.now : Date.now());
  const force = options.force === true;

  if (!runId) throw new Error('runId is required for FCA live-trade proof');

  if (!force) {
    const cached = await getCachedSnapshot(runId, options);
    if (cached) return cached;
  }

  const tickers = (Array.isArray(options.tickers) ? options.tickers : getSuspendedExitTickers())
    .map(normalizeTicker)
    .filter(Boolean);
  const fetcher = options.fetcher || fetchYahooIntradayBars;
  const concurrency = Math.max(1, Number(options.concurrency) || DEFAULT_CONCURRENCY);
  const byTicker = {};

  await mapLimit(tickers, concurrency, async function (ticker) {
    try {
      const bars = await fetcher(ticker, {
        timeoutMs: options.timeoutMs,
        now: nowMs
      });
      byTicker[ticker] = evaluateLiveTradeProof(ticker, bars, {
        now: nowMs,
        minPositiveBars: options.minPositiveBars,
        recentWindowMs: options.recentWindowMs,
        latestTradeMaxAgeMs: options.latestTradeMaxAgeMs,
        maxFutureSkewMs: options.maxFutureSkewMs
      });
    } catch (error) {
      byTicker[ticker] = {
        ticker: ticker,
        verified: false,
        reason: 'fetch_error',
        error: String(error && error.message || error),
        checked_at: new Date(nowMs).toISOString()
      };
    }
  });

  const verifiedTickers = tickers.filter(function (ticker) {
    return byTicker[ticker] && byTicker[ticker].verified === true;
  });

  const snapshot = {
    schema_version: 1,
    run_id: runId,
    checked_at: new Date(nowMs).toISOString(),
    proof_source: 'yahoo_chart_5m',
    policy: {
      min_positive_bars: Math.max(2, Number(options.minPositiveBars) || DEFAULT_MIN_POSITIVE_BARS),
      recent_window_ms: Math.max(5 * 60 * 1000, Number(options.recentWindowMs) || DEFAULT_RECENT_WINDOW_MS),
      latest_trade_max_age_ms: Math.max(5 * 60 * 1000, Number(options.latestTradeMaxAgeMs) || DEFAULT_LATEST_TRADE_MAX_AGE_MS)
    },
    checked_count: tickers.length,
    verified_count: verifiedTickers.length,
    verified_tickers: verifiedTickers,
    by_ticker: byTicker
  };

  memorySnapshot = snapshot;
  snapshot.persisted = await persistSnapshot(snapshot, options);
  return Object.assign({}, snapshot, { cache_source: 'fresh' });
}

function isTickerLiveTradeVerified(ticker, proofByTicker) {
  const cleanTicker = normalizeTicker(ticker);
  const proof = proofByTicker && proofByTicker[cleanTicker];
  return !!(proof && proof.verified === true);
}

function resetMemoryCache() {
  memorySnapshot = null;
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_CONCURRENCY,
  DEFAULT_MIN_POSITIVE_BARS,
  DEFAULT_RECENT_WINDOW_MS,
  DEFAULT_LATEST_TRADE_MAX_AGE_MS,
  getSuspendedExitTickers,
  normalizeBars,
  evaluateLiveTradeProof,
  fetchYahooIntradayBars,
  refreshSuspendedExitProof,
  getCachedSnapshot,
  isTickerLiveTradeVerified,
  resolveStatePath,
  resetMemoryCache
};
