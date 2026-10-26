'use strict';

/**
 * S1 LPM Bullish Divergence Stability & Sensitivity Analysis
 * ==========================================================
 * Computes:
 * 1. Rolling Walk-Forward across 5 chronological windows.
 * 2. Annual performance breakdown (2022, 2023, 2024, 2025, 2026).
 * 3. Parameter sensitivity test (LPM window 19, 20, 21; normPressure 0.15, 0.20, 0.25; CMF 0.00, 0.02, 0.05).
 */

const fs = require('fs');
const path = require('path');
const portEngine = require('./indicators');

const DATA_PATH = path.join(__dirname, 'data', 'brpt_combined_dataset.json');
const STABILITY_REPORT_PATH = path.join(__dirname, 'data', 'stability_analysis.json');

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

function simulateCustomTrades(candles, enrichedBars, signalFn, startIndex, endIndex) {
  const trades = [];
  let inTrade = false;
  let currentTrade = null;

  for (let i = startIndex; i < endIndex; i++) {
    const currentBar = candles[i];

    if (inTrade && currentTrade) {
      currentTrade.barsHeld++;
      const high = currentBar.high;
      const low = currentBar.low;
      const close = currentBar.close;

      let exited = false;
      let exitPrice = 0;
      let exitReason = '';

      const slHit = low <= currentTrade.sl;
      const tp1Hit = high >= currentTrade.tp1;

      if (slHit && tp1Hit) {
        exited = true;
        exitPrice = Math.max(1, currentTrade.sl - getIdxTickSize(currentTrade.sl));
        exitReason = 'SL_INTRABAR_CONFLICT';
      } else if (slHit) {
        exited = true;
        exitPrice = Math.max(1, currentTrade.sl - getIdxTickSize(currentTrade.sl));
        exitReason = 'STOP_LOSS';
      } else if (tp1Hit) {
        exited = true;
        exitPrice = currentTrade.tp1 - getIdxTickSize(currentTrade.tp1);
        exitReason = 'TAKE_PROFIT_1';
      } else if (currentTrade.barsHeld >= 10) {
        exited = true;
        exitPrice = Math.max(1, close - getIdxTickSize(close));
        exitReason = 'TIME_STOP_10D';
      }

      if (exited) {
        currentTrade.exitDate = currentBar.date;
        currentTrade.exitPrice = exitPrice;
        currentTrade.exitReason = exitReason;

        const entryPrice = currentTrade.entryPrice;
        const buyFee = entryPrice * 0.0015;
        const sellFee = exitPrice * 0.0025;
        const netReturnPct = (exitPrice - entryPrice - buyFee - sellFee) / entryPrice;
        const rMultiple = currentTrade.risk > 0 ? (exitPrice - entryPrice - buyFee - sellFee) / currentTrade.risk : 0;

        currentTrade.netReturnPct = Math.round(netReturnPct * 10000) / 100;
        currentTrade.rMultiple = Math.round(rMultiple * 100) / 100;

        trades.push(currentTrade);
        inTrade = false;
        currentTrade = null;
        continue;
      }
    }

    if (!inTrade && i + 1 < endIndex) {
      if (signalFn(candles, enrichedBars, i)) {
        const nextBar = candles[i + 1];
        const rawEntry = nextBar.open;
        const entryTick = getIdxTickSize(rawEntry);
        const entryPrice = rawEntry + entryTick;

        let minLow5 = Infinity;
        for (let k = Math.max(0, i - 4); k <= i; k++) {
          if (candles[k].low < minLow5) minLow5 = candles[k].low;
        }

        let sl = roundToIdxTick(minLow5, 'down');
        if (sl >= entryPrice || (entryPrice - sl) / entryPrice < 0.02) {
          sl = roundToIdxTick(entryPrice * 0.96, 'down');
        }
        if ((entryPrice - sl) / entryPrice > 0.08) {
          sl = roundToIdxTick(entryPrice * 0.92, 'down');
        }

        const risk = entryPrice - sl;
        const tp1 = roundToIdxTick(entryPrice + risk * 1.5, 'up');
        const reward1 = tp1 - entryPrice;
        const rrRatio = risk > 0 ? Math.round((reward1 / risk) * 100) / 100 : 0;

        if (rrRatio >= 1.50) {
          inTrade = true;
          currentTrade = {
            signalDate: currentBar.date,
            entryDate: nextBar.date,
            entryPrice,
            sl,
            tp1,
            risk,
            rrRatio,
            barsHeld: 0
          };
        }
      }
    }
  }

  return trades;
}

function computeMetrics(trades) {
  const n = trades.length;
  if (n === 0) {
    return {
      n: 0,
      win_rate: 0,
      profit_factor: 0,
      avg_r: 0,
      expectancy_pct: 0,
      max_dd_pct: 0,
      warning: 'N = 0'
    };
  }

  const wins = trades.filter(t => t.exitReason === 'TAKE_PROFIT_1').length;
  const grossWins = trades.filter(t => t.netReturnPct > 0).reduce((acc, t) => acc + t.netReturnPct, 0);
  const grossLosses = Math.abs(trades.filter(t => t.netReturnPct < 0).reduce((acc, t) => acc + t.netReturnPct, 0));
  const pf = grossLosses > 0 ? Math.round((grossWins / grossLosses) * 100) / 100 : (grossWins > 0 ? 999 : 0);

  const totalR = trades.reduce((acc, t) => acc + t.rMultiple, 0);
  const avgR = Math.round((totalR / n) * 100) / 100;

  const totalReturn = trades.reduce((acc, t) => acc + t.netReturnPct, 0);
  const expPct = Math.round((totalReturn / n) * 100) / 100;

  let peak = 0;
  let cum = 0;
  let maxDd = 0;
  for (const t of trades) {
    cum += t.netReturnPct;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
  }

  return {
    n,
    win_rate_pct: Math.round((wins / n) * 1000) / 10,
    profit_factor: pf,
    avg_r: avgR,
    expectancy_pct: expPct,
    max_dd_pct: Math.round(maxDd * 100) / 100,
    warning: n < 30 ? `N = ${n} (tidak cukup untuk kesimpulan)` : null
  };
}

function runAnalysis() {
  console.log('====================================================');
  console.log('RUNNING S1 STABILITY & SENSITIVITY SUITE');
  console.log('====================================================\n');

  const candles = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const totalBars = candles.length;

  const baseEnriched = portEngine.calculateAllIndicators(candles);
  const baseSignal = (cList, eList, i) => {
    const bar = eList[i];
    if (!bar || !bar.lpm || !bar.money_flow) return false;
    const lpmBullish = bar.lpm.is_bullish_pressure && bar.lpm.norm_pressure >= 0.20;
    const cmfPositive = bar.money_flow.cmf_ratio != null && bar.money_flow.cmf_ratio > 0.02;
    const activeVol = bar.volume_rotation && bar.volume_rotation.value >= 1.0;
    return lpmBullish && cmfPositive && activeVol;
  };

  // 1. Rolling 5 Windows
  console.log('[1/3] Computing 5 Rolling Walk-Forward Windows...');
  const windowSize = Math.floor(totalBars / 5);
  const rollingWindows = [];

  for (let w = 0; w < 5; w++) {
    const start = w * windowSize;
    const end = w === 4 ? totalBars : (w + 1) * windowSize;
    const wTrades = simulateCustomTrades(candles, baseEnriched, baseSignal, start, end);
    const m = computeMetrics(wTrades);
    rollingWindows.push({
      window: w + 1,
      start_bar: start,
      end_bar: end - 1,
      start_date: candles[start].date,
      end_date: candles[end - 1].date,
      metrics: m
    });
    console.log(`  Window ${w + 1} (${candles[start].date} to ${candles[end - 1].date}): N=${m.n}, WR=${m.win_rate_pct}%, PF=${m.profit_factor}, Exp=${m.expectancy_pct}%`);
  }

  // 2. Annual Breakdown
  console.log('\n[2/3] Computing Annual Performance Breakdown...');
  const years = ['2022', '2023', '2024', '2025', '2026'];
  const annualResults = {};

  const fullTrades = simulateCustomTrades(candles, baseEnriched, baseSignal, 20, totalBars);

  for (const yr of years) {
    const yrTrades = fullTrades.filter(t => t.entryDate.startsWith(yr));
    annualResults[yr] = computeMetrics(yrTrades);
    console.log(`  Year ${yr}: N=${annualResults[yr].n}, WR=${annualResults[yr].win_rate_pct}%, PF=${annualResults[yr].profit_factor}, Exp=${annualResults[yr].expectancy_pct}%`);
  }

  // 3. Sensitivity Analysis (±1 parameter divergence)
  console.log('\n[3/3] Running Parameter Sensitivity Tests...');
  const sensitivityResults = {};

  // Variation A: LPM Lookback Window (19 vs 20 vs 21)
  const lpmWindows = [19, 20, 21];
  sensitivityResults.lpm_window = {};
  for (const win of lpmWindows) {
    const enrichedWin = portEngine.calculateAllIndicators(candles); // custom window
    const customLpm = portEngine.calculateLPMSeries(candles, win);
    const sigLpmWin = (cList, eList, i) => {
      const bar = eList[i];
      const lpmItem = customLpm[i];
      if (!bar || !lpmItem || !bar.money_flow) return false;
      const lpmBullish = lpmItem.is_bullish_pressure && lpmItem.norm_pressure >= 0.20;
      const cmfPositive = bar.money_flow.cmf_ratio != null && bar.money_flow.cmf_ratio > 0.02;
      const activeVol = bar.volume_rotation && bar.volume_rotation.value >= 1.0;
      return lpmBullish && cmfPositive && activeVol;
    };
    const t = simulateCustomTrades(candles, enrichedWin, sigLpmWin, 20, totalBars);
    sensitivityResults.lpm_window[`window_${win}`] = computeMetrics(t);
    console.log(`  Sensitivity LPM Window=${win}: N=${sensitivityResults.lpm_window[`window_${win}`].n}, WR=${sensitivityResults.lpm_window[`window_${win}`].win_rate_pct}%, PF=${sensitivityResults.lpm_window[`window_${win}`].profit_factor}`);
  }

  // Variation B: normPressure Threshold (0.15 vs 0.20 vs 0.25)
  const pressureThresholds = [0.15, 0.20, 0.25];
  sensitivityResults.norm_pressure = {};
  for (const th of pressureThresholds) {
    const sigTh = (cList, eList, i) => {
      const bar = eList[i];
      if (!bar || !bar.lpm || !bar.money_flow) return false;
      const lpmBullish = bar.lpm.is_bullish_pressure && bar.lpm.norm_pressure >= th;
      const cmfPositive = bar.money_flow.cmf_ratio != null && bar.money_flow.cmf_ratio > 0.02;
      const activeVol = bar.volume_rotation && bar.volume_rotation.value >= 1.0;
      return lpmBullish && cmfPositive && activeVol;
    };
    const t = simulateCustomTrades(candles, baseEnriched, sigTh, 20, totalBars);
    sensitivityResults.norm_pressure[`pressure_${th}`] = computeMetrics(t);
    console.log(`  Sensitivity normPressure=${th}: N=${sensitivityResults.norm_pressure[`pressure_${th}`].n}, WR=${sensitivityResults.norm_pressure[`pressure_${th}`].win_rate_pct}%, PF=${sensitivityResults.norm_pressure[`pressure_${th}`].profit_factor}`);
  }

  // Variation C: CMF Threshold (0.00 vs 0.02 vs 0.05)
  const cmfThresholds = [0.00, 0.02, 0.05];
  sensitivityResults.cmf_threshold = {};
  for (const cmfTh of cmfThresholds) {
    const sigCmf = (cList, eList, i) => {
      const bar = eList[i];
      if (!bar || !bar.lpm || !bar.money_flow) return false;
      const lpmBullish = bar.lpm.is_bullish_pressure && bar.lpm.norm_pressure >= 0.20;
      const cmfPositive = bar.money_flow.cmf_ratio != null && bar.money_flow.cmf_ratio > cmfTh;
      const activeVol = bar.volume_rotation && bar.volume_rotation.value >= 1.0;
      return lpmBullish && cmfPositive && activeVol;
    };
    const t = simulateCustomTrades(candles, baseEnriched, sigCmf, 20, totalBars);
    sensitivityResults.cmf_threshold[`cmf_${cmfTh}`] = computeMetrics(t);
    console.log(`  Sensitivity CMF Threshold=${cmfTh}: N=${sensitivityResults.cmf_threshold[`cmf_${cmfTh}`].n}, WR=${sensitivityResults.cmf_threshold[`cmf_${cmfTh}`].win_rate_pct}%, PF=${sensitivityResults.cmf_threshold[`cmf_${cmfTh}`].profit_factor}`);
  }

  const output = {
    rolling_windows_5: rollingWindows,
    annual_breakdown: annualResults,
    sensitivity_tests: sensitivityResults
  };

  fs.writeFileSync(STABILITY_REPORT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nStability analysis saved to ${STABILITY_REPORT_PATH}`);
  console.log('====================================================\n');
}

runAnalysis();
