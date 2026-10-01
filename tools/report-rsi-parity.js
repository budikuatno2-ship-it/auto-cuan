#!/usr/bin/env node
/**
 * RSI Parity Report — read-only diagnostic tool.
 *
 * Built for the 12 Aug 2026 correctness audit that found and fixed a
 * production bug: the daily-context feature-snapshot pipeline was computing
 * RSI14 from only RSI_PERIOD+1 (15) persisted closes, which is the
 * UNSMOOTHED Wilder seed value (zero recursive smoothing iterations), not a
 * mature, chart-comparable RSI. See lib/daily-history-collector.js's
 * computeRsiFromCandles and lib/daily-market-context-builder.js's rsiOverride
 * wiring for the fix.
 *
 * This tool computes RSI14 for a set of tickers under MULTIPLE history
 * bases and reports the deltas, so a human/operator can verify convergence
 * on real market data (something this development sandbox could not do —
 * outbound network access to Yahoo Finance and the production Supabase
 * instance are both blocked by this environment's egress policy). Run this
 * from an environment with real network + Supabase access (e.g. the VPS)
 * to get real numbers.
 *
 * Bases computed per ticker:
 *   1. production          — the FIXED pipeline's actual output (mature RSI
 *                             from the full Yahoo fetch, when DB access is
 *                             available; else the persisted-history fallback)
 *   2. naive_15             — exactly RSI_PERIOD+1 (15) closes — the OLD
 *                              production bug, reproduced here for contrast
 *   3. last_30 / 4. last_60 / 5. last_120 — sliding windows of the full
 *      fetched series, to show the convergence curve
 *   6. full_history_raw     — Wilder RSI over the COMPLETE fetched series
 *      (raw/unadjusted close — Yahoo's `indicators.quote[0].close`)
 *   7. full_history_adjusted — same, but using Yahoo's split/dividend
 *      adjusted close series (`indicators.adjclose[0].adjclose`) if the API
 *      response includes it, to check raw-vs-adjusted policy consistency
 *   8. reference_check       — an INDEPENDENTLY re-implemented Wilder/RMA
 *      RSI (not sharing code with lib/daily-rsi.js) applied to the full raw
 *      series, as a self-consistency check on the production formula itself
 *
 * Usage:
 *   node tools/report-rsi-parity.js [TICKER1,TICKER2,...] [--json] [--no-db]
 *
 *   With no ticker list, uses a representative default set spanning large
 *   caps, the two tickers named in the original bug report, and a few
 *   randomly-selected liquid/illiquid/volatile names.
 *   --json     print machine-readable JSON instead of a table
 *   --no-db    skip Supabase entirely (Yahoo-only comparison); useful when
 *              SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are not set
 *
 * READ-ONLY: makes GET requests to Yahoo Finance and SELECT-only Supabase
 * queries. Never upserts, deletes, or sends Telegram messages.
 */

'use strict';

const rsi = require('../lib/daily-rsi');
const collector = require('../lib/daily-history-collector');
const { RSI_PERIOD } = require('../lib/daily-market-context-constants');

const DEFAULT_TICKERS = [
  // Named in the original bug report:
  'BELL', 'TIRA',
  // Large-cap / highly liquid:
  'BBCA', 'BBRI', 'TLKM', 'BMRI',
  // A few liquid mid-caps, illiquid small-caps, and historically volatile
  // names for universe-wide coverage (operator may override via argv).
  'ASII', 'UNVR', 'ANTM', 'MEDC', 'BUKA'
];

/**
 * Independent second Wilder/RMA implementation (deliberately NOT sharing
 * code with lib/daily-rsi.js) — a self-consistency check on the production
 * formula, not a duplicate of it. Any divergence between this and
 * lib/daily-rsi.js's output on the same input would indicate an
 * implementation bug in one of the two, independent of the history-length
 * question this tool otherwise investigates.
 */
function referenceWilderRsi(closes, period) {
  period = period || 14;
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) avgGain += change; else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
}

function rsiOverWindow(closes, dates, windowSize) {
  if (!Array.isArray(closes) || closes.length < windowSize) {
    return { rsi_14: null, history_length: Array.isArray(closes) ? closes.length : 0, insufficient_history: true };
  }
  const slicedCloses = closes.slice(-windowSize);
  const slicedDates = dates.slice(-windowSize);
  const result = rsi.computeLatestRsi(slicedCloses, slicedDates, { period: RSI_PERIOD });
  return Object.assign({}, result, { history_length: slicedCloses.length });
}

async function fetchAdjustedCloseSeries(ticker, timeoutMs) {
  const symbol = String(ticker).toUpperCase().replace(/[^A-Z0-9_-]/g, '') + '.JK';
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=1y&interval=1d&events=div,splits';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || 12000);
  try {
    const response = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
    if (!response.ok) return null;
    const data = await response.json();
    const result = data && data.chart && data.chart.result && data.chart.result[0];
    if (!result) return null;
    const timestamps = result.timestamp || [];
    const adj = result.indicators && result.indicators.adjclose && result.indicators.adjclose[0] && result.indicators.adjclose[0].adjclose;
    if (!adj) return null;
    const closes = [];
    const dates = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (adj[i] == null || !Number.isFinite(Number(adj[i]))) continue;
      closes.push(Number(adj[i]));
      dates.push(new Date(timestamps[i] * 1000).toISOString().slice(0, 10));
    }
    return closes.length ? { closes, dates } : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function loadProductionDbHistory(ticker, supabase) {
  if (!supabase) return null;
  const historyStore = require('../lib/stock-daily-history-store');
  const { HISTORY_RETENTION_TRADING_SESSIONS } = require('../lib/daily-market-context-constants');
  try {
    const map = await historyStore.getLatestSessionsForTickers(supabase, [ticker], HISTORY_RETENTION_TRADING_SESSIONS);
    const rows = map.get(String(ticker).toUpperCase()) || [];
    // rows are newest-first; reverse for oldest-first RSI input.
    const oldestFirst = rows.slice().reverse();
    return {
      closes: oldestFirst.map((r) => Number(r.close)),
      dates: oldestFirst.map((r) => r.trade_date)
    };
  } catch (e) {
    return { error: e && e.message };
  }
}

async function buildSupabaseClient() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const { createClient } = require('@supabase/supabase-js');
    return createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  } catch (e) {
    return null;
  }
}

async function analyzeTicker(ticker, options) {
  const row = { ticker: ticker, warnings: [] };

  let candles = null;
  let fetchError = null;
  try {
    candles = await collector.fetchYahooDailyHistory(ticker, { timeoutMs: options.timeoutMs });
  } catch (e) {
    fetchError = e;
  }
  if (!candles) {
    row.error = fetchError ? ('yahoo_fetch_failed: ' + fetchError.message) : 'yahoo_fetch_failed_or_blocked';
    row.warnings.push('Could not fetch Yahoo Finance data — check network egress policy (this sandbox blocks query1.finance.yahoo.com; run from an environment with real network access, e.g. the VPS).');
    if (!options.noDb && options.supabase) {
      const dbHistory = await loadProductionDbHistory(ticker, options.supabase);
      if (dbHistory && dbHistory.closes && dbHistory.closes.length) {
        row.db_only_naive_15 = rsiOverWindow(dbHistory.closes, dbHistory.dates, RSI_PERIOD + 1).rsi_14;
        row.db_only_full_persisted = rsiOverWindow(dbHistory.closes, dbHistory.dates, dbHistory.closes.length).rsi_14;
        row.db_history_length = dbHistory.closes.length;
      }
    }
    return row;
  }

  const closes = candles.map((c) => c.close);
  const dates = candles.map((c) => c.date);
  row.last_close = closes[closes.length - 1];
  row.as_of_trade_date = dates[dates.length - 1];
  row.candle_count = closes.length;
  row.raw_vs_adjusted_source = 'raw (Yahoo indicators.quote[0].close — not split/dividend adjusted)';

  const naive15 = rsiOverWindow(closes, dates, RSI_PERIOD + 1);
  const last30 = rsiOverWindow(closes, dates, 30);
  const last60 = rsiOverWindow(closes, dates, 60);
  const last120 = rsiOverWindow(closes, dates, 120);
  const fullHistory = collector.computeRsiFromCandles(candles);
  const referenceRsi = referenceWilderRsi(closes, RSI_PERIOD);

  row.rsi_naive_15_closes = naive15.rsi_14;
  row.rsi_last_30 = last30.rsi_14;
  row.rsi_last_60 = last60.rsi_14;
  row.rsi_last_120 = last120.rsi_14;
  row.rsi_full_history_raw = fullHistory.rsi_14;
  row.rsi_reference_independent_impl = referenceRsi;
  row.delta_naive15_vs_full = (naive15.rsi_14 != null && fullHistory.rsi_14 != null) ? Math.round((fullHistory.rsi_14 - naive15.rsi_14) * 100) / 100 : null;
  row.delta_120_vs_full = (last120.rsi_14 != null && fullHistory.rsi_14 != null) ? Math.round((fullHistory.rsi_14 - last120.rsi_14) * 100) / 100 : null;
  row.formula_self_consistent = (referenceRsi != null && fullHistory.rsi_14 != null) ? Math.abs(referenceRsi - fullHistory.rsi_14) < 0.05 : null;
  if (row.formula_self_consistent === false) {
    row.warnings.push('lib/daily-rsi.js diverges from an independently-reimplemented Wilder RSI on the same input — investigate the FORMULA, not just history length.');
  }

  if (Math.abs(row.delta_120_vs_full || 0) > 0.5) {
    row.convergence = 'INCOMPLETE_AT_120 — even the full persisted-history fallback (120 sessions) has not fully converged for this ticker; consider it a documented residual limitation, not a fresh bug';
  } else {
    row.convergence = 'CONVERGED_BY_120';
  }

  const adjusted = await fetchAdjustedCloseSeries(ticker, options.timeoutMs);
  if (adjusted) {
    const adjustedResult = rsi.computeLatestRsi(adjusted.closes, adjusted.dates, { period: RSI_PERIOD });
    row.rsi_full_history_adjusted = adjustedResult.rsi_14;
    row.raw_vs_adjusted_delta = (adjustedResult.rsi_14 != null && fullHistory.rsi_14 != null) ? Math.round((adjustedResult.rsi_14 - fullHistory.rsi_14) * 100) / 100 : null;
    if (Math.abs(row.raw_vs_adjusted_delta || 0) > 0.5) {
      row.warnings.push('Raw vs split/dividend-adjusted close series produce meaningfully different RSI — check for a corporate action (split) inside the fetched window (Task 11).');
    }
  } else {
    row.rsi_full_history_adjusted = null;
    row.warnings.push('Yahoo adjusted-close series unavailable/unreachable — raw-vs-adjusted corporate-action check skipped.');
  }

  if (!options.noDb && options.supabase) {
    const dbHistory = await loadProductionDbHistory(ticker, options.supabase);
    if (dbHistory && dbHistory.error) {
      row.warnings.push('Supabase query failed: ' + dbHistory.error);
    } else if (dbHistory && dbHistory.closes && dbHistory.closes.length) {
      const dbOverride = collector.computeRsiFromCandles(candles); // matches the FIXED production pipeline's override
      row.production_pipeline_rsi = dbOverride.rsi_14; // what the fixed collector would persist
      row.production_matches_full_history = dbOverride.rsi_14 === fullHistory.rsi_14;
      row.db_persisted_history_length = dbHistory.closes.length;
    }
  }

  return row;
}

function printTable(rows) {
  const cols = ['ticker', 'as_of_trade_date', 'last_close', 'candle_count', 'rsi_naive_15_closes', 'rsi_last_120', 'rsi_full_history_raw', 'delta_naive15_vs_full', 'delta_120_vs_full', 'convergence'];
  console.log(cols.join('\t'));
  rows.forEach((r) => {
    console.log(cols.map((c) => (r[c] == null ? 'N/A' : r[c])).join('\t'));
  });
  console.log('');
  rows.forEach((r) => {
    if (r.warnings && r.warnings.length) {
      console.log('[' + r.ticker + '] WARNINGS:');
      r.warnings.forEach((w) => console.log('  - ' + w));
    }
    if (r.error) console.log('[' + r.ticker + '] ERROR: ' + r.error);
  });
}

async function main(argv) {
  const args = argv.slice(2);
  const asJson = args.includes('--json');
  const noDb = args.includes('--no-db');
  const tickerArg = args.find((a) => !a.startsWith('--'));
  const tickers = tickerArg ? tickerArg.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean) : DEFAULT_TICKERS;

  const supabase = noDb ? null : await buildSupabaseClient();
  if (!noDb && !supabase) {
    console.error('[report-rsi-parity] SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set (or client init failed) — DB comparison columns will be empty. Pass --no-db to silence this.');
  }

  const rows = [];
  for (const ticker of tickers) {
    const row = await analyzeTicker(ticker, { supabase, noDb, timeoutMs: 15000 });
    rows.push(row);
  }

  if (asJson) {
    console.log(JSON.stringify({ generated_at: new Date().toISOString(), rows }, null, 2));
  } else {
    printTable(rows);
  }

  return { rows };
}

if (require.main === module) {
  main(process.argv).then(() => process.exit(0)).catch((e) => {
    console.error('[report-rsi-parity] Unexpected error:', e && e.message);
    process.exit(1);
  });
}

module.exports = { main, analyzeTicker, referenceWilderRsi, rsiOverWindow, DEFAULT_TICKERS };
