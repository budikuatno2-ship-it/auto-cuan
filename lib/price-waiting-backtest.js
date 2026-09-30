'use strict';

/**
 * Price Waiting Radar — historical validation only.
 *
 * Purpose:
 * Evaluate the hypothesis "good setup, but do not chase; wait for the planned
 * entry zone" without changing any live screener, UI, alert, or persistence path.
 *
 * Invariants:
 * - Reuses live Day Trade scoring at day T.
 * - Uses only candles <= T to qualify a candidate.
 * - Waiting starts at T+1.
 * - A fill is only assumed when a future daily candle actually overlaps the
 *   pre-existing entry zone.
 * - If entry and SL can both have happened inside one candle, SL wins.
 * - If price gaps below SL before a valid fill, the setup is invalidated.
 */

const daytradeEngine = require('./daytrade-screener-engine');
const backtestEngine = require('./backtest-engine');

function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function extractPlan(scored) {
  if (!scored || typeof scored !== 'object') return null;
  const entryLow = num(scored.entry_low);
  const entryHigh = num(scored.entry_high);
  const stopLoss = num(scored.stop_loss);
  const tp1 = num(scored.tp1);
  const currentPrice = num(scored.last_price);
  if (![entryLow, entryHigh, stopLoss, tp1, currentPrice].every(Number.isFinite)) return null;
  if (!(stopLoss < entryLow && entryLow <= entryHigh && entryHigh < tp1)) return null;
  return {
    entry_low: entryLow,
    entry_high: entryHigh,
    stop_loss: stopLoss,
    tp1,
    current_price: currentPrice
  };
}

function isEligibleWaitCandidate(scored, options) {
  options = options || {};
  if (!scored || typeof scored !== 'object') return false;
  const plan = extractPlan(scored);
  if (!plan) return false;

  const minScore = Number.isFinite(Number(options.minScore)) ? Number(options.minScore) : 65;
  const minRiskReward = Number.isFinite(Number(options.minRiskReward)) ? Number(options.minRiskReward) : 1.2;
  const score = num(scored.daytrade_score);
  const rr = num(scored.risk_reward);

  if (score == null || score < minScore) return false;
  if (rr == null || rr < minRiskReward) return false;
  if (scored.status === 'AVOID') return false;
  if (scored.trading_plan_valid === false) return false;
  if (String(scored.plan_quality_status || '').toUpperCase() === 'INVALID') return false;
  if (String(scored.risk_label_v2 || '').toUpperCase() === 'VERY HIGH RISK') return false;

  // This feature is specifically for a setup whose price is already above the
  // planned entry zone. Candidates already inside/below the zone belong to the
  // normal execution flow, not the waiting radar.
  return plan.current_price > plan.entry_high;
}

function evaluateWaitCandidateAtDay(params) {
  params = params || {};
  const ticker = params.ticker;
  const candles = Array.isArray(params.candles) ? params.candles : [];
  const dayIndex = Number(params.dayIndex);
  if (!ticker || !Number.isInteger(dayIndex) || dayIndex < 20 || dayIndex >= candles.length) return null;

  const slice = candles.slice(0, dayIndex + 1);
  const analysis = daytradeEngine.analyzeDayTrade(slice, ticker);
  if (!analysis) return null;

  const scored = daytradeEngine.scoreDayTrade(
    analysis,
    params.runMode || 'MORNING_SCOUT',
    params.board || null,
    null,
    { marketRegime: params.marketRegime || null, ticker }
  );
  if (!isEligibleWaitCandidate(scored, params)) return null;

  const plan = extractPlan(scored);
  return {
    ticker,
    signal_date: candles[dayIndex].date || null,
    signal_index: dayIndex,
    signal_price: plan.current_price,
    entry_low: plan.entry_low,
    entry_high: plan.entry_high,
    stop_loss: plan.stop_loss,
    tp1: plan.tp1,
    score: num(scored.daytrade_score),
    risk_reward: num(scored.risk_reward),
    source_status: scored.status || null,
    source_entry_status: scored.entry_status || null,
    source_entry_timing: scored.entry_timing || null
  };
}

function resolveFillPrice(candle, plan) {
  const open = num(candle && candle.open);
  const high = num(candle && candle.high);
  const low = num(candle && candle.low);
  if (![open, high, low].every(Number.isFinite)) return null;

  // Daily candle must overlap the planned zone.
  if (low > plan.entry_high || high < plan.entry_low) return null;

  // Conservative deterministic fill:
  // - opening above zone and trading down -> fill at upper zone edge
  // - opening inside zone -> fill at open
  // - gap below zone but rebound into it -> fill at lower zone edge
  if (open > plan.entry_high) return plan.entry_high;
  if (open >= plan.entry_low) return open;
  if (high >= plan.entry_low) return plan.entry_low;
  return null;
}

function simulateWaitingSetup(params) {
  params = params || {};
  const ticker = params.ticker;
  const candles = Array.isArray(params.candles) ? params.candles : [];
  const signal = params.signal;
  const signalIndex = Number(params.signalIndex != null ? params.signalIndex : signal && signal.signal_index);
  const maxWaitDays = Math.max(1, Number(params.maxWaitDays) || 5);
  const maxHoldingDays = Math.max(1, Number(params.maxHoldingDays) || 20);

  if (!signal || !Number.isInteger(signalIndex) || signalIndex < 0 || signalIndex + 1 >= candles.length) return null;
  const plan = {
    entry_low: num(signal.entry_low),
    entry_high: num(signal.entry_high),
    stop_loss: num(signal.stop_loss),
    tp1: num(signal.tp1)
  };
  if (![plan.entry_low, plan.entry_high, plan.stop_loss, plan.tp1].every(Number.isFinite)) return null;

  const waitEnd = Math.min(candles.length - 1, signalIndex + maxWaitDays);
  let entryIndex = -1;
  let entryPrice = null;

  for (let k = signalIndex + 1; k <= waitEnd; k++) {
    const c = candles[k] || {};
    const open = num(c.open);
    const low = num(c.low);
    if (open == null || low == null) continue;

    // A gap through the invalidation level means the original setup is broken
    // before we can claim a valid planned-zone fill.
    if (open <= plan.stop_loss) {
      return {
        ticker,
        signal_date: signal.signal_date,
        resolution: 'INVALID_BEFORE_ENTRY',
        filled: false,
        wait_days: k - signalIndex,
        resolved_index: k,
        entry_price: null,
        pnl_pct: null,
        r_multiple: null
      };
    }

    const fill = resolveFillPrice(c, plan);
    if (fill != null) {
      entryIndex = k;
      entryPrice = fill;
      break;
    }

    // If the session traded through SL but never overlapped the entry zone
    // (e.g. a downside gap whose high stayed below entry_low), fail closed.
    if (low <= plan.stop_loss) {
      return {
        ticker,
        signal_date: signal.signal_date,
        resolution: 'INVALID_BEFORE_ENTRY',
        filled: false,
        wait_days: k - signalIndex,
        resolved_index: k,
        entry_price: null,
        pnl_pct: null,
        r_multiple: null
      };
    }
  }

  if (entryIndex < 0) {
    return {
      ticker,
      signal_date: signal.signal_date,
      resolution: 'EXPIRED_NO_ENTRY',
      filled: false,
      wait_days: waitEnd - signalIndex,
      resolved_index: waitEnd,
      entry_price: null,
      pnl_pct: null,
      r_multiple: null
    };
  }

  const risk = entryPrice - plan.stop_loss;
  if (!(risk > 0)) return null;

  const holdEnd = Math.min(candles.length - 1, entryIndex + maxHoldingDays - 1);
  let outcome = 'TIMEOUT';
  let exitIndex = holdEnd;
  let exitPrice = num(candles[holdEnd] && candles[holdEnd].close);
  if (exitPrice == null) exitPrice = entryPrice;

  for (let k = entryIndex; k <= holdEnd; k++) {
    const c = candles[k] || {};
    const high = num(c.high);
    const low = num(c.low);
    if (high == null || low == null) continue;

    const hitSl = low <= plan.stop_loss;
    const hitTp = high >= plan.tp1;

    // Conservative intraday ordering when daily OHLC cannot tell which was first.
    if (hitSl) {
      outcome = 'SL_HIT';
      exitIndex = k;
      exitPrice = plan.stop_loss;
      break;
    }
    if (hitTp) {
      outcome = 'TP_HIT';
      exitIndex = k;
      exitPrice = plan.tp1;
      break;
    }
  }

  const pnl = exitPrice - entryPrice;
  const signalPrice = num(signal.signal_price);
  return {
    ticker,
    signal_date: signal.signal_date,
    resolution: outcome,
    filled: true,
    entry_date: candles[entryIndex] && candles[entryIndex].date || null,
    entry_price: round2(entryPrice),
    exit_date: candles[exitIndex] && candles[exitIndex].date || null,
    exit_price: round2(exitPrice),
    stop_loss: plan.stop_loss,
    tp1: plan.tp1,
    wait_days: entryIndex - signalIndex,
    holding_days: exitIndex - entryIndex + 1,
    resolved_index: exitIndex,
    entry_discount_pct: signalPrice && signalPrice > 0 ? round2(((signalPrice - entryPrice) / signalPrice) * 100) : null,
    pnl_pct: round2((pnl / entryPrice) * 100),
    r_multiple: round2(pnl / risk),
    signal_score: signal.score,
    signal_risk_reward: signal.risk_reward,
    source_status: signal.source_status,
    source_entry_status: signal.source_entry_status
  };
}

function summarizeResolutions(records) {
  const rows = Array.isArray(records) ? records : [];
  const filled = rows.filter(r => r && r.filled);
  const invalid = rows.filter(r => r && r.resolution === 'INVALID_BEFORE_ENTRY');
  const expired = rows.filter(r => r && r.resolution === 'EXPIRED_NO_ENTRY');
  const discounts = filled.map(r => num(r.entry_discount_pct)).filter(Number.isFinite);
  const waits = filled.map(r => num(r.wait_days)).filter(Number.isFinite);
  const tradeMetrics = backtestEngine.computeMetrics(filled);

  return {
    candidates: rows.length,
    filled: filled.length,
    fill_rate_pct: rows.length ? round2((filled.length / rows.length) * 100) : 0,
    invalid_before_entry: invalid.length,
    expired_no_entry: expired.length,
    avg_entry_discount_pct: discounts.length ? round2(discounts.reduce((a,b)=>a+b,0) / discounts.length) : null,
    avg_wait_days: waits.length ? round2(waits.reduce((a,b)=>a+b,0) / waits.length) : null,
    trade_metrics: tradeMetrics
  };
}

function runPriceWaitingBacktest(options) {
  options = options || {};
  const tickers = Array.isArray(options.tickers) ? options.tickers : [];
  const candleData = options.candleData || {};
  const ihsgCandles = Array.isArray(options.ihsgCandles) ? options.ihsgCandles : [];
  const inSampleRatio = Number(options.inSampleRatio) || 0.7;

  const allDates = Array.from(new Set(tickers.flatMap(t =>
    (Array.isArray(candleData[t]) ? candleData[t] : []).map(c => c && c.date).filter(Boolean)
  ))).sort();
  const split = backtestEngine.splitWalkForward(allDates, inSampleRatio);
  const inSet = new Set(split.inSample);
  const outSet = new Set(split.outOfSample);

  const ihsgDateMap = new Map();
  ihsgCandles.forEach((c, i) => { if (c && c.date) ihsgDateMap.set(c.date, i); });

  const records = [];

  for (const ticker of tickers) {
    const candles = (Array.isArray(candleData[ticker]) ? candleData[ticker] : []).slice()
      .sort((a,b) => String(a.date || '').localeCompare(String(b.date || '')));
    if (candles.length < 30) continue;

    let lockedUntil = -1;
    for (let dayIndex = 20; dayIndex < candles.length - 1; dayIndex++) {
      if (dayIndex <= lockedUntil) continue;
      const date = candles[dayIndex] && candles[dayIndex].date;
      if (!date) continue;
      if (options.startDate && date < options.startDate) continue;
      if (options.endDate && date > options.endDate) continue;

      let regime = 'sideways';
      const ihsgIdx = ihsgDateMap.get(date);
      if (ihsgIdx != null && ihsgIdx >= 19) {
        regime = backtestEngine.classifyMarketRegime(ihsgCandles.slice(0, ihsgIdx + 1));
      }

      const signal = evaluateWaitCandidateAtDay({
        ticker,
        candles,
        dayIndex,
        marketRegime: regime,
        minScore: options.minScore,
        minRiskReward: options.minRiskReward
      });
      if (!signal) continue;

      const resolved = simulateWaitingSetup({
        ticker,
        candles,
        signalIndex: dayIndex,
        signal,
        maxWaitDays: options.maxWaitDays,
        maxHoldingDays: options.maxHoldingDays
      });
      if (!resolved) continue;

      resolved.market_regime = regime;
      resolved.is_in_sample = inSet.has(signal.signal_date);
      resolved.is_out_of_sample = outSet.has(signal.signal_date);
      records.push(resolved);
      lockedUntil = Math.max(dayIndex, resolved.resolved_index || dayIndex);
    }
  }

  const inSample = records.filter(r => r.is_in_sample);
  const outSample = records.filter(r => r.is_out_of_sample);
  return {
    strategy: 'price_waiting_radar',
    parameters: {
      min_score: Number.isFinite(Number(options.minScore)) ? Number(options.minScore) : 65,
      min_risk_reward: Number.isFinite(Number(options.minRiskReward)) ? Number(options.minRiskReward) : 1.2,
      max_wait_days: Math.max(1, Number(options.maxWaitDays) || 5),
      max_holding_days: Math.max(1, Number(options.maxHoldingDays) || 20)
    },
    date_range: {
      start_date: allDates[0] || null,
      end_date: allDates[allDates.length - 1] || null,
      split_date: split.splitDate
    },
    walk_forward: {
      in_sample_ratio: inSampleRatio,
      in_sample_days: split.inSample.length,
      out_of_sample_days: split.outOfSample.length
    },
    metrics: {
      overall: summarizeResolutions(records),
      in_sample: summarizeResolutions(inSample),
      out_of_sample: summarizeResolutions(outSample)
    },
    records
  };
}

function runParameterSweep(options) {
  options = options || {};
  const scores = Array.isArray(options.scoreThresholds) && options.scoreThresholds.length
    ? options.scoreThresholds : [65, 70, 75];
  const waitDays = Array.isArray(options.waitDays) && options.waitDays.length
    ? options.waitDays : [3, 5, 10];

  const runs = [];
  for (const minScore of scores) {
    for (const maxWaitDays of waitDays) {
      const result = runPriceWaitingBacktest(Object.assign({}, options, { minScore, maxWaitDays }));
      runs.push({
        min_score: minScore,
        max_wait_days: maxWaitDays,
        overall: result.metrics.overall,
        in_sample: result.metrics.in_sample,
        out_of_sample: result.metrics.out_of_sample
      });
    }
  }
  return {
    strategy: 'price_waiting_radar_parameter_sweep',
    score_thresholds: scores,
    wait_days: waitDays,
    runs
  };
}

module.exports = {
  extractPlan,
  isEligibleWaitCandidate,
  evaluateWaitCandidateAtDay,
  resolveFillPrice,
  simulateWaitingSetup,
  summarizeResolutions,
  runPriceWaitingBacktest,
  runParameterSweep
};
