'use strict';

/**
 * BRPT LPM Robustness Suite & Rigorous Statistical Testing
 * =======================================================
 * Implements:
 * 1. Corrected norm_pressure sensitivity testing (-0.05, 0.00, 0.15, 0.20, 0.25, 0.40, 0.60).
 * 2. Renamed S1 to 'S1 LPM Pressure Below Curve' and implemented 'S1b Classical Divergence'.
 * 3. Formal Statistical Tests:
 *    - Student's t-test (one-sided & two-sided)
 *    - Bootstrap resampling (20,000 iterations)
 *    - Permutation test against baseline
 *    - Random baseline distribution over 200 independent seeds
 * 4. Concentration Tests:
 *    - Performance excluding July-October 2025 rally
 *    - Performance excluding top 5 trades
 *    - Compounded equity curve simulation (compounding portfolio)
 * 5. Pre-registered Regime Filter (Close > SMA200 || SMA50 > SMA200).
 * 6. Exit Variations:
 *    - Variation A: 100% at TP1
 *    - Variation B: Scale-out 50% at TP1, 50% at TP2 with Breakeven SL
 */

const fs = require('fs');
const path = require('path');
const portEngine = require('./indicators');

const DATA_PATH = path.join(__dirname, 'data', 'brpt_combined_dataset.json');
const ROBUSTNESS_JSON_PATH = path.join(__dirname, 'data', 'robustness_results.json');

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

// Student t-distribution CDF approximation (for p-value)
function tCdf(t, df) {
  const x = (t + Math.sqrt(t * t + df)) / (2 * Math.sqrt(t * t + df));
  // Incomplete beta function approximation via normal approximation for large df or exact erf
  // For df >= 30, standard normal is an excellent approximation
  const z = t * (1 - 1 / (4 * df)) / Math.sqrt(1 + (t * t) / (2 * df));
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function erf(x) {
  const sign = x >= 0 ? 1 : -1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

/**
 * Trade simulator with exit variations:
 * exitMode: 'tp1_only' (100% at TP1) or 'scale_out_tp2' (50% TP1, 50% TP2 with breakeven stop)
 */
function simulateTradesWithExit(candles, enrichedBars, signalFn, options = {}) {
  const {
    startIndex = 20,
    endIndex = candles.length,
    exitMode = 'tp1_only', // 'tp1_only' or 'scale_out_tp2'
    regimeFilter = null    // null, or 'bullish_sma' (close > sma200 || sma50 > sma200)
  } = options;

  const trades = [];
  let inTrade = false;
  let pos = null;

  for (let i = startIndex; i < endIndex; i++) {
    const currentBar = candles[i];
    const enriched = enrichedBars[i];

    if (inTrade && pos) {
      pos.barsHeld++;
      const high = currentBar.high;
      const low = currentBar.low;
      const close = currentBar.close;

      if (exitMode === 'tp1_only') {
        let exited = false;
        let exitPrice = 0;
        let exitReason = '';

        const slHit = low <= pos.sl;
        const tp1Hit = high >= pos.tp1;

        if (slHit && tp1Hit) {
          exited = true;
          exitPrice = Math.max(1, pos.sl - getIdxTickSize(pos.sl));
          exitReason = 'SL_INTRABAR_CONFLICT';
        } else if (slHit) {
          exited = true;
          exitPrice = Math.max(1, pos.sl - getIdxTickSize(pos.sl));
          exitReason = 'STOP_LOSS';
        } else if (tp1Hit) {
          exited = true;
          exitPrice = pos.tp1 - getIdxTickSize(pos.tp1);
          exitReason = 'TAKE_PROFIT_1';
        } else if (pos.barsHeld >= 10) {
          exited = true;
          exitPrice = Math.max(1, close - getIdxTickSize(close));
          exitReason = 'TIME_STOP_10D';
        }

        if (exited) {
          const buyFee = pos.entryPrice * 0.0015;
          const sellFee = exitPrice * 0.0025;
          const netReturnPct = (exitPrice - pos.entryPrice - buyFee - sellFee) / pos.entryPrice;
          const rMultiple = pos.risk > 0 ? (exitPrice - pos.entryPrice - buyFee - sellFee) / pos.risk : 0;

          trades.push({
            signalDate: pos.signalDate,
            entryDate: pos.entryDate,
            entryPrice: pos.entryPrice,
            sl: pos.sl,
            tp1: pos.tp1,
            tp2: pos.tp2,
            risk: pos.risk,
            exitDate: currentBar.date,
            exitPrice,
            exitReason,
            barsHeld: pos.barsHeld,
            netReturnPct: Math.round(netReturnPct * 10000) / 100,
            rMultiple: Math.round(rMultiple * 100) / 100
          });

          inTrade = false;
          pos = null;
          continue;
        }
      } else if (exitMode === 'scale_out_tp2') {
        // 50% TP1, 50% TP2 with Breakeven Stop
        let posFinished = false;

        // If TP1 has not yet been hit
        if (!pos.tp1Hit) {
          const slHit = low <= pos.sl;
          const tp1Hit = high >= pos.tp1;

          if (slHit && tp1Hit) {
            // Conservative: SL hit on entire position
            posFinished = true;
            const exitP = Math.max(1, pos.sl - getIdxTickSize(pos.sl));
            const buyFee = pos.entryPrice * 0.0015;
            const sellFee = exitP * 0.0025;
            const netReturn = (exitP - pos.entryPrice - buyFee - sellFee) / pos.entryPrice;
            const rMult = pos.risk > 0 ? (exitP - pos.entryPrice - buyFee - sellFee) / pos.risk : 0;

            trades.push({
              signalDate: pos.signalDate,
              entryDate: pos.entryDate,
              entryPrice: pos.entryPrice,
              sl: pos.sl,
              tp1: pos.tp1,
              tp2: pos.tp2,
              risk: pos.risk,
              exitDate: currentBar.date,
              exitPrice: exitP,
              exitReason: 'SL_INTRABAR_CONFLICT',
              barsHeld: pos.barsHeld,
              netReturnPct: Math.round(netReturn * 10000) / 100,
              rMultiple: Math.round(rMult * 100) / 100
            });
          } else if (slHit) {
            posFinished = true;
            const exitP = Math.max(1, pos.sl - getIdxTickSize(pos.sl));
            const buyFee = pos.entryPrice * 0.0015;
            const sellFee = exitP * 0.0025;
            const netReturn = (exitP - pos.entryPrice - buyFee - sellFee) / pos.entryPrice;
            const rMult = pos.risk > 0 ? (exitP - pos.entryPrice - buyFee - sellFee) / pos.risk : 0;

            trades.push({
              signalDate: pos.signalDate,
              entryDate: pos.entryDate,
              entryPrice: pos.entryPrice,
              sl: pos.sl,
              tp1: pos.tp1,
              tp2: pos.tp2,
              risk: pos.risk,
              exitDate: currentBar.date,
              exitPrice: exitP,
              exitReason: 'STOP_LOSS',
              barsHeld: pos.barsHeld,
              netReturnPct: Math.round(netReturn * 10000) / 100,
              rMultiple: Math.round(rMult * 100) / 100
            });
          } else if (tp1Hit) {
            // First 50% exits at TP1
            pos.tp1Hit = true;
            pos.exitPricePart1 = pos.tp1 - getIdxTickSize(pos.tp1);
            pos.exitDatePart1 = currentBar.date;
            // Move Stop Loss to Entry Price (Breakeven) for remaining 50%
            pos.activeSl = pos.entryPrice;

            // Check if TP2 also hit in the same bar
            if (high >= pos.tp2) {
              posFinished = true;
              pos.exitPricePart2 = pos.tp2 - getIdxTickSize(pos.tp2);
              pos.exitReason = 'TAKE_PROFIT_1_AND_2';
            }
          } else if (pos.barsHeld >= 10) {
            posFinished = true;
            const exitP = Math.max(1, close - getIdxTickSize(close));
            const buyFee = pos.entryPrice * 0.0015;
            const sellFee = exitP * 0.0025;
            const netReturn = (exitP - pos.entryPrice - buyFee - sellFee) / pos.entryPrice;
            const rMult = pos.risk > 0 ? (exitP - pos.entryPrice - buyFee - sellFee) / pos.risk : 0;

            trades.push({
              signalDate: pos.signalDate,
              entryDate: pos.entryDate,
              entryPrice: pos.entryPrice,
              sl: pos.sl,
              tp1: pos.tp1,
              tp2: pos.tp2,
              risk: pos.risk,
              exitDate: currentBar.date,
              exitPrice: exitP,
              exitReason: 'TIME_STOP_10D',
              barsHeld: pos.barsHeld,
              netReturnPct: Math.round(netReturn * 10000) / 100,
              rMultiple: Math.round(rMult * 100) / 100
            });
          }
        } else {
          // Part 1 already hit TP1. Managing Part 2 with Breakeven Stop
          const slHit2 = low <= pos.activeSl;
          const tp2Hit = high >= pos.tp2;

          if (slHit2 && tp2Hit) {
            posFinished = true;
            pos.exitPricePart2 = Math.max(1, pos.activeSl - getIdxTickSize(pos.activeSl));
            pos.exitReason = 'TP1_THEN_BREAKEVEN_SL_CONFLICT';
          } else if (slHit2) {
            posFinished = true;
            pos.exitPricePart2 = Math.max(1, pos.activeSl - getIdxTickSize(pos.activeSl));
            pos.exitReason = 'TP1_THEN_BREAKEVEN_SL';
          } else if (tp2Hit) {
            posFinished = true;
            pos.exitPricePart2 = pos.tp2 - getIdxTickSize(pos.tp2);
            pos.exitReason = 'TP1_AND_TP2';
          } else if (pos.barsHeld >= 10) {
            posFinished = true;
            pos.exitPricePart2 = Math.max(1, close - getIdxTickSize(close));
            pos.exitReason = 'TP1_THEN_TIME_STOP';
          }
        }

        if (posFinished && pos.tp1Hit) {
          const buyFee = pos.entryPrice * 0.0015;
          const sellFee1 = pos.exitPricePart1 * 0.0025;
          const sellFee2 = pos.exitPricePart2 * 0.0025;

          const netRetPart1 = (pos.exitPricePart1 - pos.entryPrice - buyFee - sellFee1) / pos.entryPrice;
          const netRetPart2 = (pos.exitPricePart2 - pos.entryPrice - buyFee - sellFee2) / pos.entryPrice;
          const blendedNetReturn = (netRetPart1 + netRetPart2) / 2;

          const rPart1 = (pos.exitPricePart1 - pos.entryPrice - buyFee - sellFee1) / pos.risk;
          const rPart2 = (pos.exitPricePart2 - pos.entryPrice - buyFee - sellFee2) / pos.risk;
          const blendedR = (rPart1 + rPart2) / 2;

          trades.push({
            signalDate: pos.signalDate,
            entryDate: pos.entryDate,
            entryPrice: pos.entryPrice,
            sl: pos.sl,
            tp1: pos.tp1,
            tp2: pos.tp2,
            risk: pos.risk,
            exitDate: currentBar.date,
            exitPricePart1: pos.exitPricePart1,
            exitPricePart2: pos.exitPricePart2,
            exitPrice: Math.round((pos.exitPricePart1 + pos.exitPricePart2) / 2),
            exitReason: pos.exitReason || 'TP1_AND_TP2',
            barsHeld: pos.barsHeld,
            netReturnPct: Math.round(blendedNetReturn * 10000) / 100,
            rMultiple: Math.round(blendedR * 100) / 100
          });

          inTrade = false;
          pos = null;
          continue;
        } else if (posFinished) {
          inTrade = false;
          pos = null;
          continue;
        }
      }
    }

    // New Entry Evaluation at Close of bar i
    if (!inTrade && i + 1 < endIndex) {
      if (regimeFilter === 'bullish_sma') {
        const cVal = Number(currentBar.close);
        const s50 = enriched.sma50;
        const s200 = enriched.sma200;
        const isBullishRegime = (s200 != null && cVal > s200) || (s50 != null && s200 != null && s50 > s200);
        if (!isBullishRegime) continue;
      }

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
        const tp2 = roundToIdxTick(entryPrice + risk * 2.5, 'up');
        const reward1 = tp1 - entryPrice;
        const rrRatio = risk > 0 ? Math.round((reward1 / risk) * 100) / 100 : 0;

        if (rrRatio >= 1.50) {
          inTrade = true;
          pos = {
            signalDate: currentBar.date,
            entryDate: nextBar.date,
            entryPrice,
            sl,
            tp1,
            tp2,
            risk,
            rrRatio,
            barsHeld: 0,
            tp1Hit: false,
            activeSl: sl,
            exitPricePart1: 0,
            exitPricePart2: 0
          };
        }
      }
    }
  }

  return trades;
}

function computeMetricsDetailed(trades) {
  const n = trades.length;
  if (n === 0) {
    return {
      n: 0,
      win_rate_pct: 0,
      wins: 0,
      losses: 0,
      profit_factor: 0,
      avg_r: 0,
      expectancy_pct: 0,
      max_dd_pct: 0,
      returns: [],
      warning: 'N = 0 (Data Tidak Tersedia)'
    };
  }

  const returns = trades.map(t => t.netReturnPct);
  const wins = trades.filter(t => t.netReturnPct > 0).length;
  const losses = trades.filter(t => t.netReturnPct <= 0).length;

  const grossWins = returns.filter(r => r > 0).reduce((a, b) => a + b, 0);
  const grossLosses = Math.abs(returns.filter(r => r < 0).reduce((a, b) => a + b, 0));
  const pf = grossLosses > 0 ? Math.round((grossWins / grossLosses) * 100) / 100 : (grossWins > 0 ? 999 : 0);

  const totalR = trades.reduce((a, t) => a + t.rMultiple, 0);
  const avgR = Math.round((totalR / n) * 100) / 100;

  const sumRet = returns.reduce((a, b) => a + b, 0);
  const expPct = Math.round((sumRet / n) * 100) / 100;

  // Max DD
  let peak = 0, cum = 0, maxDd = 0;
  for (const r of returns) {
    cum += r;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
  }

  return {
    n,
    win_rate_pct: Math.round((wins / n) * 1000) / 10,
    wins,
    losses,
    profit_factor: pf,
    avg_r: avgR,
    expectancy_pct: expPct,
    max_dd_pct: Math.round(maxDd * 100) / 100,
    returns,
    warning: n < 30 ? `N = ${n} (tidak cukup untuk kesimpulan)` : null
  };
}

/**
 * Formal Statistical Tests
 */
function runStatisticalTests(tradesS1, tradesRandomBaseline) {
  const returns = tradesS1.map(t => t.netReturnPct);
  const n = returns.length;

  if (n < 2) return { error: 'Insufficient sample for statistical testing' };

  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (n - 1);
  const sd = Math.sqrt(variance);
  const se = sd / Math.sqrt(n);

  const tStat = mean / se;
  const df = n - 1;

  // p-values:
  // one-sided (H1: mean > 0)
  const pOneSided = 1 - tCdf(tStat, df);
  // two-sided (H1: mean != 0)
  const pTwoSided = 2 * (1 - tCdf(Math.abs(tStat), df));

  // Bootstrap 20,000 iterations
  const B = 20000;
  let bootstrapLeZeroCount = 0;
  const bootstrapMeans = new Float64Array(B);

  // Deterministic seed for PRNG
  let seed = 123456789;
  function prng() {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  }

  for (let b = 0; b < B; b++) {
    let bSum = 0;
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(prng() * n);
      bSum += returns[idx];
    }
    const bMean = bSum / n;
    bootstrapMeans[b] = bMean;
    if (bMean <= 0) bootstrapLeZeroCount++;
  }

  const pBootstrapLeZero = bootstrapLeZeroCount / B;

  // 95% Bootstrap Confidence Interval
  const sortedBMeans = Array.from(bootstrapMeans).sort((a, b) => a - b);
  const ciLower = sortedBMeans[Math.floor(B * 0.025)];
  const ciUpper = sortedBMeans[Math.floor(B * 0.975)];

  // Permutation test against random baseline
  const randReturns = tradesRandomBaseline.map(t => t.netReturnPct);
  const nRand = randReturns.length;
  const observedDiff = mean - (randReturns.reduce((a, b) => a + b, 0) / nRand);

  const combined = returns.concat(randReturns);
  const totalN = combined.length;
  let permGreaterCount = 0;
  const PERM_ROUNDS = 10000;

  for (let p = 0; p < PERM_ROUNDS; p++) {
    // Fisher-Yates shuffle
    const shuffled = combined.slice();
    for (let i = totalN - 1; i > 0; i--) {
      const j = Math.floor(prng() * (i + 1));
      const tmp = shuffled[i];
      shuffled[i] = shuffled[j];
      shuffled[j] = tmp;
    }
    let sum1 = 0;
    for (let i = 0; i < n; i++) sum1 += shuffled[i];
    let sum2 = 0;
    for (let i = n; i < totalN; i++) sum2 += shuffled[i];

    const permDiff = (sum1 / n) - (sum2 / nRand);
    if (permDiff >= observedDiff) permGreaterCount++;
  }

  const pPermutationOneSided = permGreaterCount / PERM_ROUNDS;

  return {
    sample_size: n,
    mean_return_pct: Math.round(mean * 100) / 100,
    std_dev_pct: Math.round(sd * 100) / 100,
    std_error: Math.round(se * 100) / 100,
    t_statistic: Math.round(tStat * 100) / 100,
    degrees_of_freedom: df,
    p_value_one_sided_t_test: Math.round(pOneSided * 10000) / 10000,
    p_value_two_sided_t_test: Math.round(pTwoSided * 10000) / 10000,
    bootstrap_iterations: B,
    p_bootstrap_mean_le_zero: Math.round(pBootstrapLeZero * 10000) / 10000,
    bootstrap_95_ci: [Math.round(ciLower * 100) / 100, Math.round(ciUpper * 100) / 100],
    permutation_rounds: PERM_ROUNDS,
    observed_mean_diff_vs_random: Math.round(observedDiff * 100) / 100,
    p_permutation_one_sided: Math.round(pPermutationOneSided * 10000) / 10000
  };
}

/**
 * 200 Seed Random Baseline Monte Carlo
 */
function runRandomBaseline200Seeds(candles, enrichedBars) {
  const seedCount = 200;
  const results = [];

  for (let s = 1; s <= seedCount; s++) {
    let seed = s * 7919;
    function prng() {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    }
    const randSig = () => prng() < 0.04;
    const trades = simulateTradesWithExit(candles, enrichedBars, randSig, { startIndex: 20, endIndex: candles.length });
    const m = computeMetricsDetailed(trades);
    results.push(m);
  }

  const valid = results.filter(r => r.n > 0);
  const winRates = valid.map(r => r.win_rate_pct).sort((a, b) => a - b);
  const pfs = valid.map(r => r.profit_factor).sort((a, b) => a - b);
  const expects = valid.map(r => r.expectancy_pct).sort((a, b) => a - b);
  const tradeCounts = valid.map(r => r.n).sort((a, b) => a - b);

  function getStats(arr) {
    const sum = arr.reduce((a, b) => a + b, 0);
    const mean = sum / arr.length;
    const median = arr[Math.floor(arr.length / 2)];
    const p5 = arr[Math.floor(arr.length * 0.05)];
    const p95 = arr[Math.floor(arr.length * 0.95)];
    const min = arr[0];
    const max = arr[arr.length - 1];
    return {
      mean: Math.round(mean * 100) / 100,
      median: Math.round(median * 100) / 100,
      p5: Math.round(p5 * 100) / 100,
      p95: Math.round(p95 * 100) / 100,
      min: Math.round(min * 100) / 100,
      max: Math.round(max * 100) / 100
    };
  }

  return {
    seed_count: seedCount,
    trade_counts: getStats(tradeCounts),
    win_rate_distribution: getStats(winRates),
    profit_factor_distribution: getStats(pfs),
    expectancy_distribution: getStats(expects)
  };
}

/**
 * Compounding Equity Curve Simulation
 * Starts with Rp 100,000,000 portfolio.
 * Each trade risks 2.0% of current equity (or 1R = 2% of portfolio).
 * If trade gains +1.5R net, portfolio gains +3.0%.
 */
function simulateCompoundingEquity(trades, initialEquity = 100000000, riskPctPerTrade = 0.02) {
  let equity = initialEquity;
  let peak = initialEquity;
  let maxDdPct = 0;
  const equityPoints = [{ date: 'START', equity: initialEquity }];

  for (const t of trades) {
    // Return in terms of R multiple times riskPct
    const returnPct = t.rMultiple * riskPctPerTrade;
    equity = equity * (1 + returnPct);

    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / peak) * 100;
    if (dd > maxDdPct) maxDdPct = dd;

    equityPoints.push({
      date: t.exitDate,
      equity: Math.round(equity),
      r: t.rMultiple,
      drawdownPct: Math.round(dd * 100) / 100
    });
  }

  const totalReturnPct = ((equity - initialEquity) / initialEquity) * 100;
  return {
    initial_equity: initialEquity,
    final_equity: Math.round(equity),
    total_return_pct: Math.round(totalReturnPct * 100) / 100,
    max_compounded_drawdown_pct: Math.round(maxDdPct * 100) / 100
  };
}

function runSuite() {
  console.log('====================================================');
  console.log('STARTING BRPT ROBUSTNESS & RIGOROUS TESTING SUITE');
  console.log('====================================================\n');

  const candles = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const enriched = portEngine.calculateAllIndicators(candles);
  const totalBars = candles.length;
  const splitIdx = Math.floor(totalBars * 0.70);

  // ---------------------------------------------------------------
  // 1. KOREKSI SENSITIVITAS NORM_PRESSURE (Tersambung Langsung)
  // ---------------------------------------------------------------
  console.log('[1/6] Running Corrected norm_pressure Sensitivity...');
  const pressureLevels = [-0.05, 0.00, 0.15, 0.20, 0.25, 0.40, 0.60];
  const pressureSensitivity = {};

  for (const th of pressureLevels) {
    const sigPressure = (cList, eList, i) => {
      const bar = eList[i];
      if (!bar || !bar.lpm || !bar.money_flow) return false;
      // CONNECT DIRECTLY to norm_pressure:
      const normP = bar.lpm.norm_pressure;
      const belowLpm = bar.lpm.lpm_curve != null && bar.close < bar.lpm.lpm_curve;
      const passPressure = normP != null && normP >= th;
      const cmfPositive = bar.money_flow.cmf_ratio != null && bar.money_flow.cmf_ratio > 0.02;
      const activeVol = bar.volume_rotation && bar.volume_rotation.value >= 1.0;
      return belowLpm && passPressure && cmfPositive && activeVol;
    };
    const t = simulateTradesWithExit(candles, enriched, sigPressure, { startIndex: 20, endIndex: totalBars });
    const m = computeMetricsDetailed(t);
    pressureSensitivity[`threshold_${th.toFixed(2)}`] = {
      threshold: th,
      n: m.n,
      win_rate_pct: m.win_rate_pct,
      profit_factor: m.profit_factor,
      avg_r: m.avg_r,
      expectancy_pct: m.expectancy_pct,
      max_dd_pct: m.max_dd_pct
    };
    console.log(`  Threshold ${th.toFixed(2)}: N=${m.n}, WR=${m.win_rate_pct}%, PF=${m.profit_factor}, Exp=${m.expectancy_pct}%`);
  }

  // ---------------------------------------------------------------
  // 2. S1 (LPM Pressure Below Curve) & S1b (Classical Divergence)
  // ---------------------------------------------------------------
  console.log('\n[2/6] Running S1, S1b, S2, and Baselines...');

  // S1: LPM Pressure Below Curve
  const sigS1 = (cList, eList, i) => {
    const bar = eList[i];
    if (!bar || !bar.lpm || !bar.money_flow) return false;
    const belowCurve = bar.lpm.lpm_curve != null && bar.close < bar.lpm.lpm_curve;
    const pressureOk = bar.lpm.norm_pressure != null && bar.lpm.norm_pressure >= 0.20;
    const cmfOk = bar.money_flow.cmf_ratio != null && bar.money_flow.cmf_ratio > 0.02;
    const volOk = bar.volume_rotation && bar.volume_rotation.value >= 1.0;
    return belowCurve && pressureOk && cmfOk && volOk;
  };

  // S1b: Classical Bullish Divergence
  const sigS1b = (cList, eList, i) => {
    const bar = eList[i];
    return bar && bar.classical_divergence && bar.classical_divergence.is_classical_divergence === true;
  };

  const s1In = simulateTradesWithExit(candles, enriched, sigS1, { startIndex: 20, endIndex: splitIdx });
  const s1Out = simulateTradesWithExit(candles, enriched, sigS1, { startIndex: splitIdx, endIndex: totalBars });
  const s1Full = simulateTradesWithExit(candles, enriched, sigS1, { startIndex: 20, endIndex: totalBars });

  const s1bIn = simulateTradesWithExit(candles, enriched, sigS1b, { startIndex: 20, endIndex: splitIdx });
  const s1bOut = simulateTradesWithExit(candles, enriched, sigS1b, { startIndex: splitIdx, endIndex: totalBars });
  const s1bFull = simulateTradesWithExit(candles, enriched, sigS1b, { startIndex: 20, endIndex: totalBars });

  // ---------------------------------------------------------------
  // 3. PRE-REGISTERED REGIME FILTER (Close > SMA200 || SMA50 > SMA200)
  // ---------------------------------------------------------------
  console.log('\n[3/6] Running S1 with Pre-Registered Regime Filter...');
  const s1RegimeIn = simulateTradesWithExit(candles, enriched, sigS1, { startIndex: 20, endIndex: splitIdx, regimeFilter: 'bullish_sma' });
  const s1RegimeOut = simulateTradesWithExit(candles, enriched, sigS1, { startIndex: splitIdx, endIndex: totalBars, regimeFilter: 'bullish_sma' });
  const s1RegimeFull = simulateTradesWithExit(candles, enriched, sigS1, { startIndex: 20, endIndex: totalBars, regimeFilter: 'bullish_sma' });

  // ---------------------------------------------------------------
  // 4. VARIATION OF EXITS (100% TP1 vs Scale-out TP1 + TP2)
  // ---------------------------------------------------------------
  console.log('\n[4/6] Running S1 Exit Variations (100% TP1 vs 50% TP1 + 50% TP2 Breakeven)...');
  const s1ScaleOutIn = simulateTradesWithExit(candles, enriched, sigS1, { startIndex: 20, endIndex: splitIdx, exitMode: 'scale_out_tp2' });
  const s1ScaleOutOut = simulateTradesWithExit(candles, enriched, sigS1, { startIndex: splitIdx, endIndex: totalBars, exitMode: 'scale_out_tp2' });
  const s1ScaleOutFull = simulateTradesWithExit(candles, enriched, sigS1, { startIndex: 20, endIndex: totalBars, exitMode: 'scale_out_tp2' });

  // ---------------------------------------------------------------
  // 5. CONCENTRATION TESTS
  // ---------------------------------------------------------------
  console.log('\n[5/6] Running Concentration Tests...');
  // A. Exclude Jul-Oct 2025 trades
  const s1WithoutJulOct2025 = s1Full.filter(t => {
    return !(t.entryDate >= '2025-07-01' && t.entryDate <= '2025-10-31');
  });

  // B. Exclude top 5 trades
  const sortedByReturn = s1Full.slice().sort((a, b) => b.netReturnPct - a.netReturnPct);
  const top5Trades = sortedByReturn.slice(0, 5);
  const s1WithoutTop5 = sortedByReturn.slice(5);

  // C. Compounded equity curves
  const compoundS1 = simulateCompoundingEquity(s1Full);
  const compoundS1WithoutRally = simulateCompoundingEquity(s1WithoutJulOct2025);
  const compoundS1Regime = simulateCompoundingEquity(s1RegimeFull);
  const compoundS1ScaleOut = simulateCompoundingEquity(s1ScaleOutFull);

  // ---------------------------------------------------------------
  // 6. FORMAL STATISTICAL TESTS & RANDOM BASELINE 200 SEEDS
  // ---------------------------------------------------------------
  console.log('\n[6/6] Computing Formal Statistical Tests & 200-Seed Monte Carlo...');
  const randomBaselineFull = simulateTradesWithExit(candles, enriched, () => Math.random() < 0.04, { startIndex: 20, endIndex: totalBars });
  const statTestsS1 = runStatisticalTests(s1Full, randomBaselineFull);
  const random200Distribution = runRandomBaseline200Seeds(candles, enriched);

  const results = {
    metadata: {
      timestamp: new Date().toISOString(),
      ticker: 'BRPT',
      timeframe: '1D',
      total_bars: totalBars
    },
    pressure_sensitivity_corrected: pressureSensitivity,
    strategies_comparison: {
      S1_LPM_Pressure_Below_Curve: {
        in_sample: computeMetricsDetailed(s1In),
        out_of_sample: computeMetricsDetailed(s1Out),
        full_sample: computeMetricsDetailed(s1Full)
      },
      S1b_Classical_Divergence: {
        in_sample: computeMetricsDetailed(s1bIn),
        out_of_sample: computeMetricsDetailed(s1bOut),
        full_sample: computeMetricsDetailed(s1bFull)
      },
      S1_With_Regime_Filter_SMA: {
        in_sample: computeMetricsDetailed(s1RegimeIn),
        out_of_sample: computeMetricsDetailed(s1RegimeOut),
        full_sample: computeMetricsDetailed(s1RegimeFull)
      },
      S1_ScaleOut_50TP1_50TP2: {
        in_sample: computeMetricsDetailed(s1ScaleOutIn),
        out_of_sample: computeMetricsDetailed(s1ScaleOutOut),
        full_sample: computeMetricsDetailed(s1ScaleOutFull)
      }
    },
    concentration_tests: {
      s1_without_jul_oct_2025: computeMetricsDetailed(s1WithoutJulOct2025),
      s1_without_top5_trades: computeMetricsDetailed(s1WithoutTop5),
      top5_trades_details: top5Trades.map(t => ({
        entryDate: t.entryDate,
        exitDate: t.exitDate,
        netReturnPct: t.netReturnPct,
        rMultiple: t.rMultiple,
        exitReason: t.exitReason
      })),
      compounding_simulations: {
        s1_full_compounded: compoundS1,
        s1_without_rally_compounded: compoundS1WithoutRally,
        s1_regime_compounded: compoundS1Regime,
        s1_scale_out_compounded: compoundS1ScaleOut
      }
    },
    statistical_tests_s1: statTestsS1,
    random_baseline_200_seeds: random200Distribution
  };

  fs.writeFileSync(ROBUSTNESS_JSON_PATH, JSON.stringify(results, null, 2));
  console.log(`\nRobustness results successfully saved to ${ROBUSTNESS_JSON_PATH}`);
  console.log('====================================================\n');

  return results;
}

runSuite();
