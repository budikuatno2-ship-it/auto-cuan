#!/usr/bin/env node
'use strict';

/**
 * Read-only Price Waiting Radar historical validation.
 *
 * Fetches the same one-year Yahoo daily-candle universe used by the existing
 * historical backtest report, then compares:
 *   WAIT_FOR_ZONE   vs   CHASE_NEXT_OPEN
 *
 * No Supabase writes, no Telegram, no UI, no cron.
 */

const fs = require('node:fs');
const path = require('node:path');
const waiting = require('../lib/price-waiting-backtest');
const shared = require('./generate-backtest-report');

async function fetchTickerCandlesRange(symbol, range) {
  const isIndex = symbol.startsWith('^');
  const yahooSymbol = isIndex ? encodeURIComponent(symbol) : symbol + '.JK';
  const url = 'https://query2.finance.yahoo.com/v8/finance/chart/' + yahooSymbol +
    '?range=' + encodeURIComponent(range || '5y') +
    '&interval=1d&includePrePost=false&events=div%2Csplits';

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AutoCuanPriceWaitingBacktest/1.0' }
  });
  if (!res.ok) return null;

  const json = await res.json();
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result) return null;

  const timestamps = result.timestamp || [];
  const quote = result.indicators && result.indicators.quote && result.indicators.quote[0];
  if (!quote) return null;

  const splitDates = new Set();
  const splits = result.events && result.events.splits ? result.events.splits : {};
  for (const key of Object.keys(splits)) {
    const event = splits[key] || {};
    const ts = Number(event.date || key);
    if (!Number.isFinite(ts)) continue;
    splitDates.add(new Date((ts * 1000) + (7 * 3600 * 1000)).toISOString().slice(0, 10));
  }

  const candles = [];
  for (let i = 0; i < timestamps.length; i++) {
    const open = quote.open && quote.open[i];
    const high = quote.high && quote.high[i];
    const low = quote.low && quote.low[i];
    const close = quote.close && quote.close[i];
    if ([open, high, low, close].some(v => v == null || !Number.isFinite(Number(v)))) continue;

    const timeSec = timestamps[i];
    const date = new Date((timeSec * 1000) + (7 * 3600 * 1000)).toISOString().slice(0, 10);
    candles.push({
      time: timeSec,
      date,
      open: Math.round(open),
      high: Math.round(high),
      low: Math.round(low),
      close: Math.round(close),
      volume: Math.round((quote.volume && quote.volume[i]) || 0),
      split_event: splitDates.has(date)
    });
  }
  return candles.length >= 220 ? candles : null;
}

async function main() {
  const tickers = shared.UNIVERSE_TICKERS.slice();
  process.stdout.write('=== PRICE WAITING RADAR BACKTEST (READ-ONLY) ===\n');
  process.stdout.write('Universe: ' + tickers.length + ' IDX liquid tickers + IHSG\n');
  process.stdout.write('History: 5 years daily; 200-session post-split hygiene window\n');
  process.stdout.write('Validation: 70/30 walk-forward; no look-ahead; conservative same-candle SL\n\n');

  const historyRange = '5y';
  const ihsgCandles = await fetchTickerCandlesRange('^JKSE', historyRange) || [];
  const candleData = {};

  for (const ticker of tickers) {
    const candles = await fetchTickerCandlesRange(ticker, historyRange);
    if (candles && candles.length >= 50) {
      candleData[ticker] = candles;
      process.stdout.write('[data] ' + ticker + ' ' + candles.length + ' candles\n');
    } else {
      process.stdout.write('[skip] ' + ticker + ' insufficient history\n');
    }
  }

  const validTickers = Object.keys(candleData);
  const sweep = waiting.runParameterSweep({
    tickers: validTickers,
    candleData,
    ihsgCandles,
    inSampleRatio: 0.7,
    minRiskReward: 1.2,
    maxHoldingDays: 20,
    minHistoryDays: 200,
    splitHygieneLookback: 200,
    scoreThresholds: [65, 70, 75],
    waitDays: [3, 5, 10]
  });

  const payload = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    purpose: 'validate good-setup-but-wait-for-price hypothesis before any product rollout',
    universe: validTickers,
    methodology: {
      live_scoring_reused: true,
      zero_lookahead_candidate_selection: true,
      waiting_begins_next_session: true,
      same_candle_tp_sl_ordering: 'SL_FIRST',
      gap_below_sl_before_fill: 'INVALID_BEFORE_ENTRY',
      comparison: 'WAIT_FOR_ZONE vs CHASE_NEXT_OPEN using the same original SL/TP',
      history_range: historyRange,
      min_history_days: 200,
      post_split_hygiene_sessions: 200
    },
    sweep
  };

  const reportDir = path.resolve(__dirname, '..', 'data', 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, 'price-waiting-backtest-latest.json');
  fs.writeFileSync(reportPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  process.stdout.write('\n=== PARAMETER SWEEP ===\n');
  for (const run of sweep.runs) {
    const w = run.waiting.out_of_sample;
    const c = run.chase_baseline.out_of_sample;
    process.stdout.write(
      'score>=' + run.min_score +
      ' wait=' + run.max_wait_days + 'd' +
      ' | WAIT N=' + w.candidates +
      ' fill=' + w.fill_rate_pct + '%' +
      ' expectancy=' + w.trade_metrics.expectancy_r + 'R' +
      ' win=' + w.trade_metrics.win_rate_pct + '%' +
      ' DD=' + w.trade_metrics.max_drawdown_pct + '%' +
      ' | CHASE N=' + c.candidates +
      ' fill=' + c.fill_rate_pct + '%' +
      ' expectancy=' + c.trade_metrics.expectancy_r + 'R' +
      ' win=' + c.trade_metrics.win_rate_pct + '%' +
      ' DD=' + c.trade_metrics.max_drawdown_pct + '%\n'
    );
  }

  process.stdout.write('\nReport: ' + reportPath + '\n');
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write('Price Waiting backtest failed: ' + String(err && err.message || err) + '\n');
    process.exitCode = 1;
  });
}

module.exports = { fetchTickerCandlesRange, main };
