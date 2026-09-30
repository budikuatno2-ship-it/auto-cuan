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

async function main() {
  const tickers = shared.UNIVERSE_TICKERS.slice();
  process.stdout.write('=== PRICE WAITING RADAR BACKTEST (READ-ONLY) ===\n');
  process.stdout.write('Universe: ' + tickers.length + ' IDX liquid tickers + IHSG\n');
  process.stdout.write('Validation: 70/30 walk-forward; no look-ahead; conservative same-candle SL\n\n');

  const ihsgCandles = await shared.fetchTickerCandles1Y('^JKSE') || [];
  const candleData = {};

  for (const ticker of tickers) {
    const candles = await shared.fetchTickerCandles1Y(ticker);
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
      comparison: 'WAIT_FOR_ZONE vs CHASE_NEXT_OPEN using the same original SL/TP'
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

module.exports = { main };
