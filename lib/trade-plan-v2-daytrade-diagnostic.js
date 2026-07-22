'use strict';

/**
 * Trade Plan V2 — Three-Day Day-Trade Diagnostic (research / evaluation ONLY)
 * ===========================================================================
 *
 * Uses the EXISTING 2026-07-20 / 2026-07-21 / 2026-07-22 intraday datasets
 * ONLY as a DAY TRADE diagnostic. It replays the deduplicated CONFIRMED rank-1
 * (shadow_score >= min) candidate signals against the Trade Plan V2 SL / TP1 /
 * trailing logic under a deterministic parameter grid:
 *
 *   - support-buffer variants (ATR multiples)
 *   - TP1 resistance-buffer variants (ATR multiples)
 *   - trailing ATR variants
 *   - +60-minute vs EOD exit
 *   - 50 bps round-trip cost
 *   - independent, deduplicated trades (one per ticker per day)
 *
 * For every variant it reports MFE, MAE, stop-hit frequency, TP1-hit frequency,
 * trailing-stop exit frequency, average/median net return, profit factor,
 * drawdown and outlier dependence.
 *
 * HARD SCOPE GUARD: this diagnostic is DAY_TRADE only. It refuses any other
 * screener type and its output explicitly states the results MUST NOT be used to
 * claim calibration of Swing Konglo or Swing Non-Konglo.
 *
 * Safety: reuses the shadow safety gate + read-only primitives from the intraday
 * shadow-trade backtest. No Supabase, no Telegram, no cron, no mutation, no
 * wall-clock (deterministic, byte-identical reruns). Never invents prices.
 */

const path = require('node:path');
const bt = require('./intraday-shadow-trade-backtest');
const shadow = require('./intraday-shadow-scoring');
const idx = require('./idx-tick-normalization');
const { SCREENER_PROFILES, normalizeScreenerType } = require('./trade-plan-v2');

const GENERATOR_VERSION = 'trade-plan-v2-daytrade-diagnostic-v1.0';
const ROUND_TRIP_COST_BPS = 50; // fixed per spec
const DEFAULT_MIN_SCORE = 16;

// Deterministic parameter grid (ATR multiples). Defaults mirror the DAY_TRADE
// shadow profile (support 0.50 ATR, TP1 0.20 ATR, trailing 1.00 ATR).
const DEFAULT_SUPPORT_BUFFER_VARIANTS = Object.freeze([0.25, 0.50, 0.75]);
const DEFAULT_TP1_BUFFER_VARIANTS = Object.freeze([0.10, 0.20, 0.30]);
const DEFAULT_TRAILING_ATR_VARIANTS = Object.freeze([0.75, 1.00, 1.50]);
const EXIT_HORIZONS = Object.freeze([
  { key: 'PLUS_60M', kind: 'offset', minutes: 60, label: '+60 minutes' },
  { key: 'EOD', kind: 'eod', label: 'end-of-day' }
]);
const MIN_TICK_BUFFER = 2;
const SMALL_SAMPLE_THRESHOLD = 5;

const SAFETY_BLOCK = Object.freeze({
  DAYTRADE_INTRADAY_SCORE_ENABLED: 'false',
  DAYTRADE_WORKER_ALLOW_MUTATION: 'false',
  TELEGRAM_ENABLED: '0',
  production_scoring_enabled: false,
  mutations_performed: false,
  telegram_sent: false,
  supabase_writes: false,
  portfolio_mutated: false,
  source_files_rewritten: false
});

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------
function round4(n) { return bt.round4(n); }
function median(values) { return bt.median(values); }
function mean(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((s, v) => s + v, 0) / nums.length;
}

/** Ordered snapshot prices for a ticker on a date: [{time, minutes, price}]. */
function tickerPath(priceByTicker, ticker) {
  const m = priceByTicker.get(ticker);
  if (!m) return [];
  return Array.from(m.entries())
    .map(([time, v]) => ({ time, minutes: bt.timeToMinutes(time), price: v.price }))
    .filter((r) => Number.isFinite(r.minutes) && Number.isFinite(r.price))
    .sort((a, b) => a.minutes - b.minutes);
}

/**
 * Deterministic intraday volatility proxy: mean absolute consecutive price
 * change across the ticker's snapshot series for the day. Never fabricates when
 * there is only one point (returns null -> falls back to tick floor).
 */
function atrProxyFromPath(pathRows) {
  if (!pathRows || pathRows.length < 2) return null;
  let sum = 0;
  let n = 0;
  for (let i = 1; i < pathRows.length; i++) {
    sum += Math.abs(pathRows[i].price - pathRows[i - 1].price);
    n++;
  }
  return n ? sum / n : null;
}

// ---------------------------------------------------------------------------
// Single-trade simulation under one parameter set + exit horizon
// ---------------------------------------------------------------------------
/**
 * Simulate one deduplicated independent trade.
 *
 * @param {object} p
 *   entryPrice, entryMinutes
 *   support, resistance          derived from prices at/before entry
 *   atrProxy                     intraday volatility proxy (may be null)
 *   forwardPath                  [{minutes, price}] strictly after entry
 *   supportBufferAtr, tp1BufferAtr, trailingAtr
 *   horizon                      EXIT_HORIZONS entry
 * @returns {object} outcome
 */
function simulateTrade(p) {
  const entry = p.entryPrice;
  const tickSize = idx.getIdxTickSize(entry) || 1;
  const atr = Number.isFinite(p.atrProxy) && p.atrProxy > 0 ? p.atrProxy : null;
  const tickFloor = MIN_TICK_BUFFER * tickSize;

  // Structural SL below support: max(atr buffer, 2-tick floor).
  const slBuffer = Math.max(atr !== null ? p.supportBufferAtr * atr : 0, tickFloor);
  const sl = idx.roundToIdxTick(p.support - slBuffer, 'floor');

  // TP1 below resistance (never invented when resistance missing / <= entry).
  let tp1 = null;
  if (Number.isFinite(p.resistance)) {
    const tp1Buffer = Math.max(tickSize, atr !== null ? p.tp1BufferAtr * atr : 0);
    const cand = idx.roundToIdxTick(p.resistance - tp1Buffer, 'floor');
    if (Number.isFinite(cand) && cand > entry) tp1 = cand;
  }

  const riskAmount = Number.isFinite(sl) ? entry - sl : null;
  const oneR = riskAmount !== null ? entry + riskAmount : null;
  let activationPrice = null;
  if (oneR !== null && tp1 !== null) activationPrice = Math.min(oneR, tp1);
  else activationPrice = oneR !== null ? oneR : tp1;

  // Horizon filter on the forward path.
  const horizonRows = p.forwardPath.filter((r) => {
    if (p.horizon.kind === 'offset') return r.minutes <= p.entryMinutes + p.horizon.minutes;
    return true; // EOD => all later snapshots
  });

  let mfe = 0;
  let mae = 0;
  let tp1Hit = false;
  let activated = false;
  let trailingStop = null;
  let highestClose = entry;
  let exitPrice = null;
  let exitReason = null;

  for (const row of horizonRows) {
    const price = row.price;
    const excursion = price - entry;
    if (excursion > mfe) mfe = excursion;
    if (excursion < mae) mae = excursion;
    if (price > highestClose) highestClose = price;
    if (tp1 !== null && price >= tp1) tp1Hit = true;

    // Activation of the ratcheting trailing stop (+1R OR TP1).
    if (!activated && activationPrice !== null && price >= activationPrice) activated = true;
    if (activated && atr !== null) {
      const cand = highestClose - p.trailingAtr * atr;
      if (trailingStop === null || cand > trailingStop) trailingStop = cand; // never lowered
    }

    // Effective protective stop = max(structural SL, active trailing stop).
    let effStop = Number.isFinite(sl) ? sl : null;
    let stopKind = 'STOP';
    if (activated && trailingStop !== null && (effStop === null || trailingStop > effStop)) {
      effStop = trailingStop;
      stopKind = 'TRAILING';
    }
    if (effStop !== null && price <= effStop) {
      exitPrice = price;
      exitReason = stopKind;
      break;
    }
  }

  if (exitPrice === null) {
    // Horizon exit at the last available snapshot within the horizon.
    if (horizonRows.length) {
      exitPrice = horizonRows[horizonRows.length - 1].price;
      exitReason = p.horizon.kind === 'offset' ? 'TIME_60M' : 'EOD';
    } else {
      return { available: false, reason: 'NO_FORWARD_PATH' };
    }
  }

  const grossPct = ((exitPrice - entry) / entry) * 100;
  const netPct = grossPct - ROUND_TRIP_COST_BPS / 100;

  return {
    available: true,
    entry_price: entry,
    stop_loss: Number.isFinite(sl) ? sl : null,
    tp1,
    activation_price: activationPrice !== null ? round4(activationPrice) : null,
    exit_price: exitPrice,
    exit_reason: exitReason,
    tp1_hit: tp1Hit,
    stop_hit: exitReason === 'STOP',
    trailing_exit: exitReason === 'TRAILING',
    mfe_pct: round4((mfe / entry) * 100),
    mae_pct: round4((mae / entry) * 100),
    gross_return_pct: round4(grossPct),
    net_return_pct: round4(netPct)
  };
}

// ---------------------------------------------------------------------------
// Aggregate metrics across independent trades
// ---------------------------------------------------------------------------
function aggregate(trades) {
  const resolved = trades.filter((t) => t.available);
  const n = resolved.length;
  const nets = resolved.map((t) => t.net_return_pct);
  const stopHits = resolved.filter((t) => t.stop_hit).length;
  const tp1Hits = resolved.filter((t) => t.tp1_hit).length;
  const trailingExits = resolved.filter((t) => t.trailing_exit).length;

  let grossProfit = 0;
  let grossLoss = 0;
  for (const v of nets) {
    if (v > 0) grossProfit += v;
    else if (v < 0) grossLoss += -v;
  }
  let profitFactor = null;
  let profitFactorNote = null;
  if (grossLoss > 0) profitFactor = round4(grossProfit / grossLoss);
  else if (grossProfit > 0) profitFactorNote = 'no_losing_trades_profit_factor_undefined';
  else profitFactorNote = 'no_resolved_pnl';

  // Max drawdown on ordered equity curve (chronological by date then entry).
  const ordered = resolved.slice().sort((a, b) =>
    String(a._date).localeCompare(String(b._date)) ||
    (a._entryMinutes - b._entryMinutes) ||
    String(a._ticker).localeCompare(String(b._ticker)));
  let eq = 1, peak = 1, maxDD = 0;
  for (const t of ordered) {
    eq *= (1 + t.net_return_pct / 100);
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? (peak - eq) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }

  // Outlier dependence: contribution of the single best trade to the total.
  const totalNet = nets.reduce((s, v) => s + v, 0);
  let best = null;
  for (const t of resolved) if (best === null || t.net_return_pct > best.net_return_pct) best = t;
  const bestNet = best ? best.net_return_pct : null;
  const netsExBest = best ? nets.filter((v, i) => resolved[i] !== best) : nets.slice();
  const outlierDependence = {
    best_trade_net_pct: bestNet,
    total_net_pct: round4(totalNet),
    best_trade_share_of_total: (bestNet !== null && totalNet !== 0) ? round4(bestNet / totalNet) : null,
    avg_net_excluding_best: netsExBest.length ? round4(mean(netsExBest)) : null,
    total_net_excluding_best: round4(netsExBest.reduce((s, v) => s + v, 0))
  };

  return {
    resolved_trades: n,
    stop_hit_frequency: n ? round4(stopHits / n) : null,
    tp1_hit_frequency: n ? round4(tp1Hits / n) : null,
    trailing_stop_exit_frequency: n ? round4(trailingExits / n) : null,
    avg_mfe_pct: n ? round4(mean(resolved.map((t) => t.mfe_pct))) : null,
    avg_mae_pct: n ? round4(mean(resolved.map((t) => t.mae_pct))) : null,
    avg_net_return_pct: n ? round4(mean(nets)) : null,
    median_net_return_pct: n ? round4(median(nets)) : null,
    profit_factor: profitFactor,
    profit_factor_note: profitFactorNote,
    max_drawdown_pct: round4(maxDD * 100),
    outlier_dependence: outlierDependence
  };
}

// ---------------------------------------------------------------------------
// Build independent trades for a single (variant, horizon) across all dates
// ---------------------------------------------------------------------------
function buildTradesForVariant(perDate, variant, horizon) {
  const trades = [];
  for (const d of perDate) {
    for (const sig of d.signals) {
      if (!sig.entry.available) continue;
      const outcome = simulateTrade({
        entryPrice: sig.entry.entry_price,
        entryMinutes: bt.timeToMinutes(sig.entry.entry_time),
        support: sig.support,
        resistance: sig.resistance,
        atrProxy: sig.atrProxy,
        forwardPath: sig.forwardPath,
        supportBufferAtr: variant.supportBufferAtr,
        tp1BufferAtr: variant.tp1BufferAtr,
        trailingAtr: variant.trailingAtr,
        horizon
      });
      outcome._date = d.date;
      outcome._ticker = sig.ticker;
      outcome._entryMinutes = bt.timeToMinutes(sig.entry.entry_time);
      trades.push(outcome);
    }
  }
  return trades;
}

// ---------------------------------------------------------------------------
// Per-date preparation: detect + dedup signals, resolve entry, derive levels
// ---------------------------------------------------------------------------
async function prepareDate(shadowDateDir, sampleDateDir, dateStr, minScore) {
  const scoresRead = await shadow.readJsonlSafe(path.join(shadowDateDir, 'shadow-scores.jsonl'));
  const priceMap = await bt.buildSamplePriceMap(sampleDateDir);
  const detection = bt.detectSignals(scoresRead.records, minScore);

  const signals = [];
  for (const signal of detection.signals) {
    const entry = bt.resolveEntry(priceMap.priceByTicker, signal);
    const pathRows = tickerPath(priceMap.priceByTicker, signal.ticker);
    const atrProxy = atrProxyFromPath(pathRows);

    let support = null;
    let resistance = null;
    let forwardPath = [];
    if (entry.available) {
      const entryMinutes = bt.timeToMinutes(entry.entry_time);
      // Support / resistance from OBSERVED prices at or before entry (never future).
      const upto = pathRows.filter((r) => r.minutes <= entryMinutes).map((r) => r.price);
      if (upto.length) {
        support = Math.min.apply(null, upto);
        resistance = Math.max.apply(null, upto);
        // If entry sits at the running high, allow a modest ATR-based resistance
        // projection so a TP1 can exist; otherwise leave as observed high.
        if (resistance <= entry.entry_price && Number.isFinite(atrProxy) && atrProxy > 0) {
          resistance = entry.entry_price + 2 * atrProxy;
        }
      }
      forwardPath = pathRows.filter((r) => r.minutes > entryMinutes);
    }
    signals.push({ ticker: signal.ticker, signal, entry, support, resistance, atrProxy, forwardPath });
  }

  return {
    date: dateStr,
    missing_files: [scoresRead.missing ? 'shadow-scores.jsonl' : null, priceMap.missing ? 'candidates.jsonl' : null].filter(Boolean),
    detection,
    signals
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
/**
 * Run the three-day Day-Trade diagnostic.
 *
 * @param {object} rawOpts
 *   shadowRoot, sampleRoot   required (read-only source roots)
 *   dates                    required (the three intraday dates)
 *   minScore                 optional (default 16)
 *   supportBufferVariants / tp1BufferVariants / trailingAtrVariants  optional
 *   screenerType             optional — MUST be DAY_TRADE (guarded)
 *   env                      optional — safety env
 * @returns diagnostic result
 */
async function runDaytradeDiagnostic(rawOpts) {
  rawOpts = rawOpts || {};
  const env = rawOpts.env || process.env;

  // HARD SCOPE GUARD: DAY_TRADE only.
  const requested = rawOpts.screenerType != null ? normalizeScreenerType(rawOpts.screenerType) : 'DAY_TRADE';
  if (requested !== 'DAY_TRADE') {
    return {
      status: 'rejected_scope',
      errors: ['three-day intraday diagnostic is DAY_TRADE only; refusing screener_type ' + JSON.stringify(rawOpts.screenerType)],
      note: 'These three intraday days must NOT be used to claim calibration of Swing Konglo or Swing Non-Konglo.'
    };
  }

  // Safety gate (shared with the shadow evaluator).
  const safety = shadow.assertShadowSafety(env);
  if (!safety.safe) return { status: 'safety_violation', errors: safety.errors };

  const missing = [];
  if (!rawOpts.shadowRoot) missing.push('shadowRoot');
  if (!rawOpts.sampleRoot) missing.push('sampleRoot');
  if (!Array.isArray(rawOpts.dates) || !rawOpts.dates.length) missing.push('dates');
  if (missing.length) return { status: 'error', errors: ['missing required argument(s): ' + missing.join(', ')] };

  // Validate + dedup dates.
  const validated = [];
  for (const d of rawOpts.dates) {
    const v = shadow.validateDateFormat(d);
    if (!v.valid) return { status: 'rejected', reason: v.reason, errors: ['invalid date: ' + JSON.stringify(d)] };
    if (validated.includes(v.date)) return { status: 'rejected', reason: 'duplicate_date', errors: ['duplicate date: ' + JSON.stringify(v.date)] };
    validated.push(v.date);
  }

  const minScore = Number.isFinite(Number(rawOpts.minScore)) ? Number(rawOpts.minScore) : DEFAULT_MIN_SCORE;
  const supportVariants = Array.isArray(rawOpts.supportBufferVariants) && rawOpts.supportBufferVariants.length
    ? rawOpts.supportBufferVariants.map(Number).filter((n) => Number.isFinite(n) && n >= 0)
    : DEFAULT_SUPPORT_BUFFER_VARIANTS.slice();
  const tp1Variants = Array.isArray(rawOpts.tp1BufferVariants) && rawOpts.tp1BufferVariants.length
    ? rawOpts.tp1BufferVariants.map(Number).filter((n) => Number.isFinite(n) && n >= 0)
    : DEFAULT_TP1_BUFFER_VARIANTS.slice();
  const trailingVariants = Array.isArray(rawOpts.trailingAtrVariants) && rawOpts.trailingAtrVariants.length
    ? rawOpts.trailingAtrVariants.map(Number).filter((n) => Number.isFinite(n) && n >= 0)
    : DEFAULT_TRAILING_ATR_VARIANTS.slice();

  // Prepare each date (read-only).
  const perDate = [];
  for (const date of validated) {
    perDate.push(await prepareDate(
      path.join(rawOpts.shadowRoot, date),
      path.join(rawOpts.sampleRoot, date),
      date, minScore));
  }

  const uniqueIndependentTrades = perDate.reduce((s, d) => s + d.signals.filter((x) => x.entry.available).length, 0);

  // Parameter grid.
  const grid = [];
  for (const sb of supportVariants) {
    for (const tb of tp1Variants) {
      for (const tr of trailingVariants) {
        const variant = { supportBufferAtr: sb, tp1BufferAtr: tb, trailingAtr: tr };
        const byHorizon = {};
        for (const horizon of EXIT_HORIZONS) {
          const trades = buildTradesForVariant(perDate, variant, horizon);
          byHorizon[horizon.key] = aggregate(trades);
        }
        grid.push({
          variant: {
            support_buffer_atr: sb,
            tp1_resistance_buffer_atr: tb,
            trailing_atr: tr,
            round_trip_cost_bps: ROUND_TRIP_COST_BPS
          },
          by_exit_horizon: byHorizon
        });
      }
    }
  }

  // Baseline = the DAY_TRADE shadow profile defaults.
  const dayProfile = SCREENER_PROFILES.DAY_TRADE;
  const baselineVariant = {
    supportBufferAtr: dayProfile.volatility_buffer_atr,
    tp1BufferAtr: 0.20,
    trailingAtr: dayProfile.trailing_atr_multiplier
  };
  const baseline = {};
  for (const horizon of EXIT_HORIZONS) {
    baseline[horizon.key] = aggregate(buildTradesForVariant(perDate, baselineVariant, horizon));
  }

  const warnings = [];
  if (uniqueIndependentTrades < SMALL_SAMPLE_THRESHOLD) {
    warnings.push('SMALL_INDEPENDENT_TRADE_SAMPLE: only ' + uniqueIndependentTrades +
      ' independent trade(s); results are NOT statistically meaningful and NO profitability is claimed.');
  }
  if (perDate.some((d) => d.missing_files.length)) warnings.push('MISSING_SOURCE_FILES: see per_date.');

  return {
    status: 'success',
    generator_version: GENERATOR_VERSION,
    mode: 'daytrade_shadow_diagnostic_only',
    screener_type: 'DAY_TRADE',
    dates: validated,
    safety: SAFETY_BLOCK,
    parameters: {
      candidate_rule: { confirmation_state: 'CONFIRMED', confirmed_rank: 1, min_shadow_score: minScore },
      support_buffer_atr_variants: supportVariants,
      tp1_resistance_buffer_atr_variants: tp1Variants,
      trailing_atr_variants: trailingVariants,
      exit_horizons: EXIT_HORIZONS.map((h) => ({ key: h.key, label: h.label })),
      round_trip_cost_bps: ROUND_TRIP_COST_BPS,
      independent_deduplicated_trades: true
    },
    counts: {
      unique_independent_trades: uniqueIndependentTrades,
      per_date: perDate.map((d) => ({ date: d.date, signals: d.signals.length, entered: d.signals.filter((x) => x.entry.available).length }))
    },
    baseline_day_trade_profile: {
      variant: {
        support_buffer_atr: baselineVariant.supportBufferAtr,
        tp1_resistance_buffer_atr: baselineVariant.tp1BufferAtr,
        trailing_atr: baselineVariant.trailingAtr,
        round_trip_cost_bps: ROUND_TRIP_COST_BPS
      },
      by_exit_horizon: baseline
    },
    parameter_grid: grid,
    warnings,
    scope_disclaimer: 'DAY TRADE diagnostic only. These three intraday days must NOT be used to claim calibration of Swing Konglo or Swing Non-Konglo. Shadow research on already-collected data; not investment advice; small samples are flagged and no profitability is claimed.'
  };
}

module.exports = {
  GENERATOR_VERSION,
  ROUND_TRIP_COST_BPS,
  DEFAULT_MIN_SCORE,
  DEFAULT_SUPPORT_BUFFER_VARIANTS,
  DEFAULT_TP1_BUFFER_VARIANTS,
  DEFAULT_TRAILING_ATR_VARIANTS,
  EXIT_HORIZONS,
  SAFETY_BLOCK,
  // helpers
  tickerPath,
  atrProxyFromPath,
  simulateTrade,
  aggregate,
  buildTradesForVariant,
  prepareDate,
  // orchestration
  runDaytradeDiagnostic
};
