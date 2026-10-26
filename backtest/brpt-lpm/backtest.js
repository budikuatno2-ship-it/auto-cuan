'use strict';

/**
 * BRPT 1D Honest Backtest Engine (Pure Quantitative Execution)
 * ============================================================
 * Implements strict, conservative backtest rules:
 * - Signals evaluated strictly at Close of bar [t].
 * - Trade entry strictly at Open of bar [t+1] + 1 tick slippage.
 * - Stop Loss and Take Profit levels rounded to official IDX tick brackets.
 * - Gate R/R >= 1.50x strictly enforced (trades below gate rejected).
 * - Intra-bar conflict rule: if both High >= TP1 and Low <= SL in the same bar,
 *   assumes SL hit first (conservative).
 * - Fees: 0.15% Buy, 0.25% Sell. Slippage: 1 tick entry, 1 tick exit.
 * - Maximum holding duration: 10 trading sessions (exit on Close of 10th session).
 * - Walk-Forward Chronological Split: 70% In-Sample / 30% Out-of-Sample.
 * - Baselines: Buy-and-Hold and Pseudo-Random Baseline.
 */

const fs = require('fs');
const path = require('path');
const portEngine = require('./indicators');

const DATA_PATH = path.join(__dirname, 'data', 'brpt_combined_dataset.json');
const RESULTS_PATH = path.join(__dirname, 'data', 'backtest_results.json');
const TRADES_CSV_PATH = path.join(__dirname, 'trades.csv');

function getIdxTickSize(price) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return 1;
  if (p < 200) return 1;
  if (p < 500) return 2;
  if (p < 2000) return 5;
  if (p < 5000) return 10;
  return 25;
}

function roundToIdxTick(price, direction) {
  const raw = Number(price);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const p = Math.max(1, Math.round(raw));
  const tick = getIdxTickSize(p);
  let snapped;
  if (direction === 'up') snapped = Math.ceil(p / tick) * tick;
  else if (direction === 'down') snapped = Math.floor(p / tick) * tick;
  else snapped = Math.round(p / tick) * tick;
  return snapped < 1 ? 1 : snapped;
}

function simulateTrades(candles, enrichedBars, signalGenerator, strategyName, sampleName, startIndex, endIndex) {
  const trades = [];
  let inTrade = false;
  let currentTrade = null;

  for (let i = startIndex; i < endIndex; i++) {
    const currentBar = candles[i];
    const enriched = enrichedBars[i];

    // If already in a position, manage exit
    if (inTrade && currentTrade) {
      currentTrade.barsHeld++;
      const high = currentBar.high;
      const low = currentBar.low;
      const close = currentBar.close;

      let exited = false;
      let exitPrice = 0;
      let exitReason = '';

      // Check intra-bar conflict: both SL and TP touched
      const slHit = low <= currentTrade.sl;
      const tp1Hit = high >= currentTrade.tp1;

      if (slHit && tp1Hit) {
        // Conservative assumption: SL touched first
        exited = true;
        exitPrice = Math.max(1, currentTrade.sl - getIdxTickSize(currentTrade.sl)); // slippage
        exitReason = 'SL_INTRABAR_CONFLICT';
      } else if (slHit) {
        exited = true;
        exitPrice = Math.max(1, currentTrade.sl - getIdxTickSize(currentTrade.sl));
        exitReason = 'STOP_LOSS';
      } else if (tp1Hit) {
        exited = true;
        exitPrice = currentTrade.tp1 - getIdxTickSize(currentTrade.tp1); // conservative fill inside tick
        exitReason = 'TAKE_PROFIT_1';
      } else if (currentTrade.barsHeld >= 10) {
        exited = true;
        exitPrice = Math.max(1, close - getIdxTickSize(close));
        exitReason = 'TIME_STOP_10D';
      }

      if (exited) {
        currentTrade.exitDate = currentBar.date;
        currentTrade.exitTime = currentBar.time;
        currentTrade.exitPrice = exitPrice;
        currentTrade.exitReason = exitReason;

        // Financial calculations
        const entryPrice = currentTrade.entryPrice;
        const buyFee = entryPrice * 0.0015;
        const sellFee = exitPrice * 0.0025;
        const grossReturnPct = (exitPrice - entryPrice) / entryPrice;
        const netReturnPct = (exitPrice - entryPrice - buyFee - sellFee) / entryPrice;
        const rMultiple = currentTrade.risk > 0 ? (exitPrice - entryPrice - buyFee - sellFee) / currentTrade.risk : 0;

        currentTrade.buyFee = buyFee;
        currentTrade.sellFee = sellFee;
        currentTrade.totalFee = buyFee + sellFee;
        currentTrade.grossReturnPct = Math.round(grossReturnPct * 10000) / 100;
        currentTrade.netReturnPct = Math.round(netReturnPct * 10000) / 100;
        currentTrade.rMultiple = Math.round(rMultiple * 100) / 100;

        trades.push(currentTrade);
        inTrade = false;
        currentTrade = null;
        continue;
      }
    }

    // Check for new entry signal only if not currently holding a trade
    // Signal evaluated at Close of bar i, executed at Open of bar i+1
    if (!inTrade && i + 1 < endIndex) {
      const isSignal = signalGenerator(candles, enrichedBars, i);
      if (isSignal) {
        const nextBar = candles[i + 1];
        // Entry is Open of next bar + 1 tick slippage
        const rawEntry = nextBar.open;
        const entryTick = getIdxTickSize(rawEntry);
        const entryPrice = rawEntry + entryTick;

        // Calculate SL based on 5-bar swing low
        let minLow5 = Infinity;
        for (let k = Math.max(0, i - 4); k <= i; k++) {
          if (candles[k].low < minLow5) minLow5 = candles[k].low;
        }

        let sl = roundToIdxTick(minLow5, 'down');
        // If SL is too close (< 2%) or above entry, enforce 4% max buffer
        if (sl >= entryPrice || (entryPrice - sl) / entryPrice < 0.02) {
          sl = roundToIdxTick(entryPrice * 0.96, 'down');
        }
        // If SL is too wide (> 8%), cap at 8%
        if ((entryPrice - sl) / entryPrice > 0.08) {
          sl = roundToIdxTick(entryPrice * 0.92, 'down');
        }

        const risk = entryPrice - sl;
        const tp1 = roundToIdxTick(entryPrice + risk * 1.5, 'up');
        const tp2 = roundToIdxTick(entryPrice + risk * 2.5, 'up');

        const reward1 = tp1 - entryPrice;
        const rrRatio = risk > 0 ? Math.round((reward1 / risk) * 100) / 100 : 0;

        // Risk Gate Bagian J: R/R >= 1.50x
        if (rrRatio >= 1.50) {
          inTrade = true;
          currentTrade = {
            strategy: strategyName,
            sample: sampleName,
            signalDate: currentBar.date,
            signalBar: i,
            entryDate: nextBar.date,
            entryTime: nextBar.time,
            entryPrice: entryPrice,
            sl: sl,
            tp1: tp1,
            tp2: tp2,
            risk: risk,
            reward1: reward1,
            rrRatio: rrRatio,
            barsHeld: 0
          };
        }
      }
    }
  }

  return trades;
}

function computeMetrics(trades, candles, startIndex, endIndex) {
  const n = trades.length;
  if (n === 0) {
    return {
      trade_count: 0,
      win_rate_pct: 0,
      wins: 0,
      losses: 0,
      time_exits: 0,
      profit_factor: 0,
      avg_r: 0,
      expectancy_pct: 0,
      max_drawdown_pct: 0,
      avg_duration_bars: 0,
      sample_size_warning: 'N = 0 (Data Tidak Tersedia)'
    };
  }

  const wins = trades.filter(t => t.exitReason === 'TAKE_PROFIT_1').length;
  const losses = trades.filter(t => t.exitReason.startsWith('STOP_LOSS') || t.exitReason.startsWith('SL_')).length;
  const timeExits = trades.filter(t => t.exitReason.startsWith('TIME_STOP')).length;

  const grossWins = trades.filter(t => t.netReturnPct > 0).reduce((acc, t) => acc + t.netReturnPct, 0);
  const grossLosses = Math.abs(trades.filter(t => t.netReturnPct < 0).reduce((acc, t) => acc + t.netReturnPct, 0));
  const profitFactor = grossLosses > 0 ? Math.round((grossWins / grossLosses) * 100) / 100 : grossWins > 0 ? 999 : 0;

  const totalR = trades.reduce((acc, t) => acc + t.rMultiple, 0);
  const avgR = Math.round((totalR / n) * 100) / 100;

  const totalNetReturn = trades.reduce((acc, t) => acc + t.netReturnPct, 0);
  const expectancyPct = Math.round((totalNetReturn / n) * 100) / 100;

  const totalDuration = trades.reduce((acc, t) => acc + t.barsHeld, 0);
  const avgDuration = Math.round((totalDuration / n) * 10) / 10;

  // Max Drawdown of cumulative returns
  let peak = 0;
  let cumReturn = 0;
  let maxDd = 0;
  for (const t of trades) {
    cumReturn += t.netReturnPct;
    if (cumReturn > peak) peak = cumReturn;
    const dd = peak - cumReturn;
    if (dd > maxDd) maxDd = dd;
  }

  return {
    trade_count: n,
    win_rate_pct: Math.round((wins / n) * 1000) / 10,
    wins: wins,
    losses: losses,
    time_exits: timeExits,
    profit_factor: profitFactor,
    avg_r: avgR,
    expectancy_pct: expectancyPct,
    max_drawdown_pct: Math.round(maxDd * 100) / 100,
    avg_duration_bars: avgDuration,
    sample_size_warning: n < 30 ? `N = ${n} (Ukuran sampel kecil, tidak cukup untuk kesimpulan definitif)` : null
  };
}

function computeBuyAndHold(candles, startIndex, endIndex) {
  if (endIndex <= startIndex) return { return_pct: 0, max_drawdown_pct: 0 };
  const startClose = candles[startIndex].close;
  const endClose = candles[endIndex - 1].close;
  const buyFee = startClose * 0.0015;
  const sellFee = endClose * 0.0025;
  const netReturn = ((endClose - startClose - buyFee - sellFee) / startClose) * 100;

  let peak = startClose;
  let maxDd = 0;
  for (let i = startIndex; i < endIndex; i++) {
    const c = candles[i].close;
    if (c > peak) peak = c;
    const dd = ((peak - c) / peak) * 100;
    if (dd > maxDd) maxDd = dd;
  }

  return {
    start_date: candles[startIndex].date,
    end_date: candles[endIndex - 1].date,
    start_price: startClose,
    end_price: endClose,
    net_return_pct: Math.round(netReturn * 100) / 100,
    max_drawdown_pct: Math.round(maxDd * 100) / 100
  };
}

function runBacktestSuite() {
  console.log('====================================================');
  console.log('BRPT 1D HONEST BACKTEST EXECUTION');
  console.log('====================================================');

  const candles = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const enrichedBars = portEngine.calculateAllIndicators(candles);

  const totalBars = candles.length;
  const splitIndex = Math.floor(totalBars * 0.70); // 70/30 chronological split

  console.log(`Total Bars: ${totalBars}`);
  console.log(`In-Sample Period: 0 to ${splitIndex - 1} (${candles[0].date} to ${candles[splitIndex - 1].date}) [${splitIndex} bars]`);
  console.log(`Out-of-Sample Period: ${splitIndex} to ${totalBars - 1} (${candles[splitIndex].date} to ${candles[totalBars - 1].date}) [${totalBars - splitIndex} bars]`);

  // Signal Definitions:
  // S1: Bullish LPM Pressure Setup
  // Condition: LPM curve is above Price Close (normPressure > 0.15), CMF > 0, Volume Rotation >= 1.0
  const signalS1 = (cList, eList, i) => {
    const bar = eList[i];
    if (!bar || !bar.lpm || !bar.money_flow) return false;
    const lpmBullish = bar.lpm.is_bullish_pressure && bar.lpm.norm_pressure >= 0.20;
    const cmfPositive = bar.money_flow.cmf_ratio != null && bar.money_flow.cmf_ratio > 0.02;
    const activeVol = bar.volume_rotation && bar.volume_rotation.value >= 1.0;
    return lpmBullish && cmfPositive && activeVol;
  };

  // S2: Momentum Accumulation Spike
  // Condition: Intensity >= 1.50 + Volume Rotation >= 1.50 + Green Candle
  const signalS2 = (cList, eList, i) => {
    const bar = eList[i];
    if (!bar || !bar.intensity || !bar.volume_rotation) return false;
    const isAccum = bar.intensity.value >= 1.50 && bar.intensity.direction === 1;
    const isHighRot = bar.volume_rotation.value >= 1.50;
    const isGreen = bar.close > bar.open;
    return isAccum && isHighRot && isGreen;
  };

  // S3: Foreign Flow Turnaround (evaluated on foreign window)
  const signalS3 = (cList, eList, i) => {
    const bar = eList[i];
    if (!bar || !bar.foreign_flow || bar.foreign_flow.foreign_net == null) return false;
    if (i < 1) return false;
    const prevBar = eList[i - 1];
    const prevNet = prevBar.foreign_flow && prevBar.foreign_flow.foreign_net != null ? prevBar.foreign_flow.foreign_net : null;
    const currentNet = bar.foreign_flow.foreign_net;
    // Turnaround: previous negative, current positive
    const turnedPositive = prevNet !== null && prevNet < 0 && currentNet > 0;
    const cmfPositive = bar.money_flow && bar.money_flow.cmf_ratio > 0;
    return turnedPositive && cmfPositive;
  };

  const allTrades = [];

  // Run S1
  const s1In = simulateTrades(candles, enrichedBars, signalS1, 'S1_LPM_Bullish_Divergence', 'IN_SAMPLE', 20, splitIndex);
  const s1Out = simulateTrades(candles, enrichedBars, signalS1, 'S1_LPM_Bullish_Divergence', 'OUT_OF_SAMPLE', splitIndex, totalBars);
  allTrades.push(...s1In, ...s1Out);

  // Run S2
  const s2In = simulateTrades(candles, enrichedBars, signalS2, 'S2_Momentum_Accumulation_Spike', 'IN_SAMPLE', 20, splitIndex);
  const s2Out = simulateTrades(candles, enrichedBars, signalS2, 'S2_Momentum_Accumulation_Spike', 'OUT_OF_SAMPLE', splitIndex, totalBars);
  allTrades.push(...s2In, ...s2Out);

  // Run S3 (Full history & Foreign Window)
  const s3All = simulateTrades(candles, enrichedBars, signalS3, 'S3_Foreign_Flow_Turnaround', 'FULL_HISTORY', 20, totalBars);
  allTrades.push(...s3All);

  // Pseudo-Random Baseline Generator (seed-deterministic)
  let seed = 42;
  function pseudoRandom() {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  }
  const signalRandom = (cList, eList, i) => {
    return pseudoRandom() < 0.04; // ~4% probability per bar
  };
  const randIn = simulateTrades(candles, enrichedBars, signalRandom, 'BASELINE_RANDOM', 'IN_SAMPLE', 20, splitIndex);
  const randOut = simulateTrades(candles, enrichedBars, signalRandom, 'BASELINE_RANDOM', 'OUT_OF_SAMPLE', splitIndex, totalBars);
  allTrades.push(...randIn, ...randOut);

  // Buy and Hold
  const bnhIn = computeBuyAndHold(candles, 0, splitIndex);
  const bnhOut = computeBuyAndHold(candles, splitIndex, totalBars);
  const bnhFull = computeBuyAndHold(candles, 0, totalBars);

  // Aggregate results
  const results = {
    metadata: {
      ticker: 'BRPT',
      timeframe: '1D',
      total_bars: totalBars,
      in_sample_range: { start: candles[0].date, end: candles[splitIndex - 1].date, count: splitIndex },
      out_of_sample_range: { start: candles[splitIndex].date, end: candles[totalBars - 1].date, count: totalBars - splitIndex },
      assumptions: {
        buy_fee_pct: 0.15,
        sell_fee_pct: 0.25,
        slippage_ticks: 1,
        max_holding_days: 10,
        risk_gate_min_rr: 1.50,
        intrabar_conflict_rule: 'SL_FIRST_CONSERVATIVE'
      }
    },
    strategies: {
      S1_LPM_Bullish_Divergence: {
        in_sample: computeMetrics(s1In, candles, 20, splitIndex),
        out_of_sample: computeMetrics(s1Out, candles, splitIndex, totalBars),
        full_sample: computeMetrics([...s1In, ...s1Out], candles, 20, totalBars)
      },
      S2_Momentum_Accumulation_Spike: {
        in_sample: computeMetrics(s2In, candles, 20, splitIndex),
        out_of_sample: computeMetrics(s2Out, candles, splitIndex, totalBars),
        full_sample: computeMetrics([...s2In, ...s2Out], candles, 20, totalBars)
      },
      S3_Foreign_Flow_Turnaround: {
        full_sample: computeMetrics(s3All, candles, 20, totalBars)
      },
      BASELINE_RANDOM: {
        in_sample: computeMetrics(randIn, candles, 20, splitIndex),
        out_of_sample: computeMetrics(randOut, candles, splitIndex, totalBars),
        full_sample: computeMetrics([...randIn, ...randOut], candles, 20, totalBars)
      },
      BASELINE_BUY_AND_HOLD: {
        in_sample: bnhIn,
        out_of_sample: bnhOut,
        full_sample: bnhFull
      }
    }
  };

  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));

  // Write trades.csv
  const csvHeaders = [
    'strategy', 'sample', 'signal_date', 'entry_date', 'entry_price',
    'sl', 'tp1', 'tp2', 'risk', 'rr_ratio', 'exit_date', 'exit_price',
    'exit_reason', 'bars_held', 'r_multiple', 'gross_return_pct', 'net_return_pct', 'total_fee'
  ];

  const csvRows = [csvHeaders.join(',')];
  for (const t of allTrades) {
    csvRows.push([
      t.strategy,
      t.sample,
      t.signalDate,
      t.entryDate,
      t.entryPrice,
      t.sl,
      t.tp1,
      t.tp2,
      t.risk,
      t.rrRatio,
      t.exitDate,
      t.exitPrice,
      t.exitReason,
      t.barsHeld,
      t.rMultiple,
      t.grossReturnPct,
      t.netReturnPct,
      Math.round(t.totalFee)
    ].join(','));
  }

  fs.writeFileSync(TRADES_CSV_PATH, csvRows.join('\n'));

  console.log('\n--- BACKTEST RESULTS SUMMARY ---');
  console.log('S1 LPM Bullish Divergence:');
  console.log('  In-Sample:    ', results.strategies.S1_LPM_Bullish_Divergence.in_sample);
  console.log('  Out-Of-Sample:', results.strategies.S1_LPM_Bullish_Divergence.out_of_sample);
  console.log('\nS2 Momentum Accumulation Spike:');
  console.log('  In-Sample:    ', results.strategies.S2_Momentum_Accumulation_Spike.in_sample);
  console.log('  Out-Of-Sample:', results.strategies.S2_Momentum_Accumulation_Spike.out_of_sample);
  console.log('\nS3 Foreign Flow Turnaround:');
  console.log('  Full Sample:  ', results.strategies.S3_Foreign_Flow_Turnaround.full_sample);
  console.log('\nBuy & Hold Baseline:');
  console.log('  Full Return:  ', bnhFull.net_return_pct, '%, Max DD:', bnhFull.max_drawdown_pct, '%');
  console.log(`\nSaved results to: ${RESULTS_PATH}`);
  console.log(`Saved trades to:  ${TRADES_CSV_PATH}`);
  console.log('====================================================\n');
}

runBacktestSuite();
