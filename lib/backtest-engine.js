'use strict';

/**
 * Historical Backtest Engine & Walk-Forward Validation
 * ===================================================
 *
 * Non-Negotiable Invariants:
 * 1. REUSE LIVE SCORING: Strictly calls pure scoring functions from
 *    lib/daytrade-screener-engine.js and lib/swing-screener-engine.js.
 * 2. ZERO LOOK-AHEAD BIAS: Sinyal hari T HANYA memakai candle T dan sebelumnya.
 *    Entry price WAJIB menggunakan harga OPEN candle T+1.
 * 3. CONSERVATIVE TP/SL ORDERING: Jika High >= TP dan Low <= SL pada candle yang sama,
 *    tetapkan asumsi konservatif bahwa SL tersentuh lebih dahulu (SL_HIT).
 * 4. WALK-FORWARD SPLIT: 70% In-Sample (terlama) dan 30% Out-of-Sample (terbaru tanpa overlap).
 * 5. SAMPLE SIZE WARNING: Bucket dengan N < 30 diberi flag "SAMPLE_TOO_SMALL".
 */

const daytradeEngine = require('./daytrade-screener-engine');
const swingEngine = require('./swing-screener-engine');
const marketRegimeEngine = require('./market-regime');
const chartIndicators = require('./chart-engine/indicators');

/**
 * Splits an array of chronological items (dates, candles, or trades)
 * into 70% In-Sample (oldest) and 30% Out-of-Sample (newest without overlap).
 *
 * @param {Array} items - Array of items sorted oldest-to-newest
 * @param {number} [inSampleRatio=0.7] - Ratio for in-sample partition
 * @returns {{ inSample: Array, outOfSample: Array, splitDate: string|null }}
 */
function splitWalkForward(items, inSampleRatio = 0.7) {
  if (!Array.isArray(items) || items.length === 0) {
    return { inSample: [], outOfSample: [], splitDate: null };
  }

  const ratio = Math.max(0.1, Math.min(0.9, Number(inSampleRatio) || 0.7));
  const splitIndex = Math.floor(items.length * ratio);

  const inSample = items.slice(0, splitIndex);
  const outOfSample = items.slice(splitIndex);

  let splitDate = null;
  if (outOfSample.length > 0) {
    const firstOut = outOfSample[0];
    splitDate = typeof firstOut === 'string' ? firstOut : (firstOut.date || firstOut.trade_date || null);
  }

  return {
    inSample,
    outOfSample,
    splitDate
  };
}

/**
 * Classifies IHSG market regime from historical daily candles up to day T.
 * Maps:
 * - RISK_ON -> 'bull'
 * - RISK_OFF -> 'bear'
 * - NEUTRAL / other -> 'sideways'
 *
 * @param {Array<object>} ihsgCandlesUpToT
 * @returns {string} 'bull' | 'sideways' | 'bear'
 */
function classifyMarketRegime(ihsgCandlesUpToT) {
  if (!Array.isArray(ihsgCandlesUpToT) || ihsgCandlesUpToT.length < 20) {
    return 'sideways';
  }

  const evalResult = marketRegimeEngine.evaluateMarketRegime(ihsgCandlesUpToT);
  const label = String(evalResult && evalResult.market_regime_label || '').toUpperCase();

  if (label === 'RISK_ON') return 'bull';
  if (label === 'RISK_OFF') return 'bear';
  return 'sideways';
}

/**
 * Evaluates trading signal at day index T with STRICT ZERO LOOK-AHEAD BIAS.
 * Slices candles strictly from 0 to dayIndex.
 *
 * @param {object} params
 * @param {string} params.ticker
 * @param {Array<object>} params.candles
 * @param {number} params.dayIndex
 * @param {string} [params.strategy='daytrade'] - 'daytrade' | 'swing'
 * @param {object} [params.board]
 * @param {string} [params.runMode='MORNING_SCOUT']
 * @returns {object|null}
 */
function evaluateSignalAtDay({ ticker, candles, dayIndex, strategy = 'daytrade', board = null, runMode = 'MORNING_SCOUT' }) {
  if (!Array.isArray(candles) || dayIndex < 19 || dayIndex >= candles.length) {
    return null;
  }

  // ZERO LOOK-AHEAD BIAS: Slicing up to dayIndex ensures no future candle data can leak.
  const candlesSlice = candles.slice(0, dayIndex + 1);
  const lastCandle = candlesSlice[candlesSlice.length - 1];

  if (strategy === 'daytrade') {
    // 1. REUSE LIVE SCORING ENGINE: Day Trade
    const analysis = daytradeEngine.analyzeDayTrade(candlesSlice, ticker);
    if (!analysis) return null;

    const scored = daytradeEngine.scoreDayTrade(analysis, runMode, board);
    if (!scored) return null;

    // Filter tradeable signals:
    // Status must be an active setup or high score without AVOID/WAIT_PULLBACK
    const tradeableStatuses = ['A_PLUS_SETUP', 'TRADE_CANDIDATE', 'READY_BREAKOUT', 'MOMENTUM_CONTINUATION'];
    const isTradeable = tradeableStatuses.includes(scored.status) || (scored.daytrade_score >= 65 && scored.status !== 'AVOID' && scored.status !== 'WAIT_PULLBACK');

    if (!isTradeable) return null;

    return {
      signal: 'BUY',
      strategy: 'daytrade',
      ticker,
      date: lastCandle.date,
      time: lastCandle.time,
      score: scored.daytrade_score,
      status: scored.status,
      stop_loss: scored.stop_loss,
      tp1: scored.tp1,
      tp2: scored.tp2,
      risk_reward: scored.risk_reward,
      raw: scored
    };
  }

  if (strategy === 'swing') {
    // 1. REUSE LIVE SCORING ENGINE: Swing Screener
    const analysis = daytradeEngine.analyzeDayTrade(candlesSlice, ticker);
    if (!analysis) return null;

    // Build swing candidate matching verifySwingHighConviction contract
    const lastPrice = Number(lastCandle.close);
    const openPrice = Number(lastCandle.open);
    const support = analysis.support || Math.round(lastPrice * 0.95);
    const resistance = analysis.resistance || Math.round(lastPrice * 1.10);
    const risk = Math.max(1, lastPrice - support);
    const reward = Math.max(1, resistance - lastPrice);
    const rr = Number((reward / risk).toFixed(2));

    const candidate = {
      ticker,
      candles: candlesSlice,
      last_price: lastPrice,
      open_price: openPrice,
      high: lastCandle.high,
      low: lastCandle.low,
      close: lastPrice,
      volume: lastCandle.volume,
      volume_ratio_20d: analysis.volume_ratio_20d,
      risk_reward: rr,
      rsi14: analysis.rsi14,
      ma20: analysis.ma20,
      ma50: analysis.ma50,
      support,
      resistance,
      status: 'SWING_SETUP',
      score: 80
    };

    const swingVerified = swingEngine.verifySwingHighConviction(candidate);
    if (!swingVerified) return null;

    return {
      signal: 'BUY',
      strategy: 'swing',
      ticker,
      date: lastCandle.date,
      time: lastCandle.time,
      score: swingVerified.conviction_score || swingVerified.score,
      status: 'SWING_HIGH_CONVICTION',
      stop_loss: support,
      tp1: resistance,
      risk_reward: swingVerified.riskReward || rr,
      raw: swingVerified
    };
  }

  return null;
}

/**
 * Simulates trade execution following signal on day T.
 *
 * Rules:
 * - Entry price: Strictly Open price of candle T+1.
 * - TP/SL tracking: Starts on candle T+1 after open.
 * - Conservative tie-breaking: If High >= TP and Low <= SL on same candle, SL_HIT wins.
 * - Max holding period: Daytrade default 10, Swing default 20 days.
 *
 * @param {object} params
 * @param {string} params.ticker
 * @param {Array<object>} params.candles
 * @param {number} params.signalIndex
 * @param {string} [params.strategy='daytrade']
 * @param {object} params.signal
 * @param {number} [params.maxHoldingDays]
 * @returns {object|null}
 */
function simulateTradeExecution({ ticker, candles, signalIndex, strategy = 'daytrade', signal, maxHoldingDays }) {
  if (!Array.isArray(candles) || signalIndex < 0 || signalIndex + 1 >= candles.length) {
    return null; // Cannot execute without candle T+1
  }

  const maxHolding = Math.max(1, Number(maxHoldingDays) || (strategy === 'swing' ? 20 : 10));

  // Invariant 2: Entry price WAJIB menggunakan harga OPEN candle T+1
  const entryCandle = candles[signalIndex + 1];
  const entryPrice = Number(entryCandle.open);
  const entryDate = entryCandle.date;

  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    return null;
  }

  // Safety levels setup
  let sl = Number(signal.stop_loss);
  let tp = Number(signal.tp1);

  if (!Number.isFinite(sl) || sl >= entryPrice) {
    sl = Math.round(entryPrice * 0.95); // default 5% SL
  }
  if (!Number.isFinite(tp) || tp <= entryPrice) {
    tp = Math.round(entryPrice * 1.05); // default 5% TP
  }

  const initialRisk = entryPrice - sl;

  let outcome = 'TIMEOUT';
  let exitPrice = entryPrice;
  let exitDate = entryDate;
  let holdingDays = 0;

  const endIndex = Math.min(candles.length - 1, signalIndex + maxHolding);

  // Evaluate execution from candle T+1 onwards
  for (let k = signalIndex + 1; k <= endIndex; k++) {
    const c = candles[k];
    const currentHigh = Number(c.high);
    const currentLow = Number(c.low);
    const daysElapsed = k - signalIndex;

    const hitTp = currentHigh >= tp;
    const hitSl = currentLow <= sl;

    // Invariant 3: URUTAN TP/SL KONSERVATIF
    // Jika High menyentuh TP dan Low menyentuh SL pada candle yang sama, SL_HIT terlebih dahulu.
    if (hitTp && hitSl) {
      outcome = 'SL_HIT';
      exitPrice = sl;
      exitDate = c.date;
      holdingDays = daysElapsed;
      break;
    } else if (hitSl) {
      outcome = 'SL_HIT';
      exitPrice = sl;
      exitDate = c.date;
      holdingDays = daysElapsed;
      break;
    } else if (hitTp) {
      outcome = 'TP_HIT';
      exitPrice = tp;
      exitDate = c.date;
      holdingDays = daysElapsed;
      break;
    }

    // If last holding day reached without hit
    if (k === endIndex) {
      outcome = 'TIMEOUT';
      exitPrice = Number(c.close);
      exitDate = c.date;
      holdingDays = daysElapsed;
      break;
    }
  }

  const pnl = exitPrice - entryPrice;
  const pnlPct = Number(((pnl / entryPrice) * 100).toFixed(2));
  const rMultiple = initialRisk > 0 ? Number((pnl / initialRisk).toFixed(2)) : 0;

  return {
    ticker,
    strategy,
    signal_date: candles[signalIndex].date,
    entry_date: entryDate,
    entry_price: entryPrice,
    exit_date: exitDate,
    exit_price: exitPrice,
    stop_loss: sl,
    tp1: tp,
    outcome,
    holding_days: holdingDays,
    pnl,
    pnl_pct: pnlPct,
    r_multiple: rMultiple,
    signal_score: signal.score,
    signal_status: signal.status
  };
}

/**
 * Computes aggregate performance metrics from a set of executed trades.
 * Adds explicit "SAMPLE_TOO_SMALL" warning if sample size N < 30.
 *
 * @param {Array<object>} trades
 * @returns {object}
 */
function computeMetrics(trades) {
  const sample = Array.isArray(trades) ? trades : [];
  const N = sample.length;

  const isSampleSmall = N < 30;
  const sampleWarning = isSampleSmall ? 'SAMPLE_TOO_SMALL' : null;
  const flags = isSampleSmall ? ['SAMPLE_TOO_SMALL'] : [];

  if (N === 0) {
    return {
      sample_size: 0,
      wins: 0,
      losses: 0,
      win_rate_pct: 0,
      expectancy_r: 0,
      avg_holding_days: 0,
      max_drawdown_pct: 0,
      warning: sampleWarning,
      flags,
      sample_size_warning: sampleWarning
    };
  }

  const wins = sample.filter(t => (t.pnl_pct != null ? t.pnl_pct > 0 : t.outcome === 'TP_HIT')).length;
  const losses = sample.filter(t => (t.pnl_pct != null ? t.pnl_pct < 0 : t.outcome === 'SL_HIT')).length;
  const winRate = Number(((wins / N) * 100).toFixed(2));

  const totalR = sample.reduce((sum, t) => sum + (Number(t.r_multiple) || 0), 0);
  const expectancyR = Number((totalR / N).toFixed(2));

  const totalHolding = sample.reduce((sum, t) => sum + (Number(t.holding_days) || 0), 0);
  const avgHoldingDays = Number((totalHolding / N).toFixed(1));

  // Max Drawdown calculation from simulated cumulative equity curve
  let peak = 100;
  let equity = 100;
  let maxDd = 0;

  for (const t of sample) {
    equity = equity * (1 + (Number(t.pnl_pct) || 0) / 100);
    if (equity > peak) {
      peak = equity;
    }
    const currentDd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    if (currentDd > maxDd) {
      maxDd = currentDd;
    }
  }

  const maxDrawdownPct = Number(maxDd.toFixed(2));

  return {
    sample_size: N,
    wins,
    losses,
    win_rate_pct: winRate,
    expectancy_r: expectancyR,
    avg_holding_days: avgHoldingDays,
    max_drawdown_pct: maxDrawdownPct,
    warning: sampleWarning,
    flags,
    sample_size_warning: sampleWarning
  };
}

/**
 * Runs full historical backtest across a date range and universe of tickers.
 * Integrates walk-forward split (70% in-sample / 30% out-of-sample)
 * and IHSG market regime tagging.
 *
 * @param {object} options
 * @param {string} [options.strategy='daytrade']
 * @param {Array<string>} options.tickers
 * @param {object} options.candleData - Map of ticker -> Array<candle>
 * @param {Array<object>} [options.ihsgCandles=[]] - Daily IHSG candles
 * @param {number} [options.inSampleRatio=0.7]
 * @param {number} [options.maxHoldingDays]
 * @param {string} [options.startDate]
 * @param {string} [options.endDate]
 * @returns {object} Structured backtest result
 */
function runBacktest(options = {}) {
  const strategy = options.strategy || 'daytrade';
  const tickers = Array.isArray(options.tickers) ? options.tickers : [];
  const candleData = options.candleData || {};
  const ihsgCandles = Array.isArray(options.ihsgCandles) ? options.ihsgCandles : [];
  const inSampleRatio = Number(options.inSampleRatio) || 0.7;
  const maxHoldingDays = options.maxHoldingDays;

  // Build IHSG date map for regime lookup with zero look-ahead
  const ihsgDateMap = new Map();
  ihsgCandles.forEach((c, idx) => {
    if (c.date) ihsgDateMap.set(c.date, idx);
  });

  // Collect all unique trade dates across universe to establish chronological timeline
  const allDateSet = new Set();
  for (const ticker of tickers) {
    const candles = candleData[ticker] || [];
    for (const c of candles) {
      if (c && c.date) allDateSet.add(c.date);
    }
  }

  const allDates = Array.from(allDateSet).sort();
  const walkForwardSplit = splitWalkForward(allDates, inSampleRatio);
  const inSampleDateSet = new Set(walkForwardSplit.inSample);
  const outOfSampleDateSet = new Set(walkForwardSplit.outOfSample);

  const allTrades = [];

  for (const ticker of tickers) {
    const rawCandles = candleData[ticker] || [];
    if (!Array.isArray(rawCandles) || rawCandles.length < 25) {
      continue;
    }

    // Sort candles chronologically
    const sortedCandles = rawCandles.slice().sort((a, b) => {
      const da = a.date || (a.time ? new Date(a.time * 1000).toISOString().slice(0, 10) : '');
      const db = b.date || (b.time ? new Date(b.time * 1000).toISOString().slice(0, 10) : '');
      return da.localeCompare(db);
    });

    let activeTradeUntilIndex = -1;

    // Chronological replay: evaluate day T, enter on day T+1
    for (let dayIndex = 20; dayIndex < sortedCandles.length - 1; dayIndex++) {
      // Avoid overlapping position on the same ticker if already in trade
      if (dayIndex <= activeTradeUntilIndex) {
        continue;
      }

      const currentDate = sortedCandles[dayIndex].date;
      if (options.startDate && currentDate < options.startDate) continue;
      if (options.endDate && currentDate > options.endDate) continue;

      // Sinyal evaluation at day T
      const signal = evaluateSignalAtDay({
        ticker,
        candles: sortedCandles,
        dayIndex,
        strategy
      });

      if (!signal) continue;

      // Simulate execution starting at T+1
      const trade = simulateTradeExecution({
        ticker,
        candles: sortedCandles,
        signalIndex: dayIndex,
        strategy,
        signal,
        maxHoldingDays
      });

      if (!trade) continue;

      // Determine market regime at day T using IHSG candles up to day T
      let regime = 'sideways';
      const ihsgIdx = ihsgDateMap.get(currentDate);
      if (ihsgIdx != null && ihsgIdx >= 19) {
        regime = classifyMarketRegime(ihsgCandles.slice(0, ihsgIdx + 1));
      }

      trade.market_regime = regime;
      trade.is_in_sample = inSampleDateSet.has(trade.signal_date);
      trade.is_out_of_sample = outOfSampleDateSet.has(trade.signal_date);

      allTrades.push(trade);

      // Lock position until trade exit
      activeTradeUntilIndex = dayIndex + trade.holding_days;
    }
  }

  // Partition trades
  const inSampleTrades = allTrades.filter(t => t.is_in_sample);
  const outOfSampleTrades = allTrades.filter(t => t.is_out_of_sample);

  const bullTrades = allTrades.filter(t => t.market_regime === 'bull');
  const sidewaysTrades = allTrades.filter(t => t.market_regime === 'sideways');
  const bearTrades = allTrades.filter(t => t.market_regime === 'bear');

  return {
    strategy,
    tickers,
    date_range: {
      start_date: allDates[0] || null,
      end_date: allDates[allDates.length - 1] || null,
      total_trading_days: allDates.length,
      split_date: walkForwardSplit.splitDate
    },
    walk_forward: {
      in_sample_ratio: inSampleRatio,
      in_sample_days: walkForwardSplit.inSample.length,
      out_of_sample_days: walkForwardSplit.outOfSample.length
    },
    metrics: {
      overall: computeMetrics(allTrades),
      in_sample: computeMetrics(inSampleTrades),
      out_of_sample: computeMetrics(outOfSampleTrades),
      by_regime: {
        bull: computeMetrics(bullTrades),
        sideways: computeMetrics(sidewaysTrades),
        bear: computeMetrics(bearTrades)
      }
    },
    trades: allTrades
  };
}

module.exports = {
  splitWalkForward,
  classifyMarketRegime,
  evaluateSignalAtDay,
  simulateTradeExecution,
  computeMetrics,
  runBacktest
};
