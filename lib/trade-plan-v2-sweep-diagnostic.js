'use strict';

/**
 * Trade Plan V2 — Three-Day Day-Trade Trailing-Sweep Confirmation Comparison
 * ==========================================================================
 *
 * ADDITIVE research / evaluation diagnostic. Reuses the EXISTING 2026-07-20 /
 * 2026-07-21 / 2026-07-22 intraday datasets ONLY as a DAY TRADE diagnostic to
 * compare four trailing-exit CONFIRMATION policies on the deduplicated CONFIRMED
 * rank-1 (shadow_score >= min) trades:
 *
 *   1. IMMEDIATE_FIRST_TOUCH   — exit the moment price touches the trailing ref
 *   2. ONE_OBS_RECLAIM         — one-observation reclaim confirmation
 *   3. TWO_OBS_BREAKDOWN       — two-observation breakdown confirmation
 *   4. EMERGENCY_ONLY          — emergency structural stop always active (proves
 *                                the hard stop can never be disabled)
 *
 * For each policy it reports avoided false exits, additional losses caused by
 * delayed confirmation, subsequent MFE after a reclaimed sweep, final net return
 * after 50 bps, drawdown, outlier dependence, results EXCLUDING BNBR, and
 * sample-size warnings. It NEVER claims profitability.
 *
 * HARD SCOPE GUARD: DAY_TRADE only. It refuses any other screener and its output
 * states results MUST NOT calibrate Swing Konglo / Swing Non-Konglo.
 *
 * Safety: reuses the shadow safety gate + read-only primitives. No Supabase, no
 * Telegram, no cron, no mutation, no wall-clock. Deterministic. Never invents a
 * price — the emergency hard stop is always retained and never disabled.
 */

const path = require('node:path');
const bt = require('./intraday-shadow-trade-backtest');
const shadow = require('./intraday-shadow-scoring');
const idx = require('./idx-tick-normalization');
const diagnostic = require('./trade-plan-v2-daytrade-diagnostic');
const { SCREENER_PROFILES, normalizeScreenerType } = require('./trade-plan-v2');

const GENERATOR_VERSION = 'trade-plan-v2-sweep-diagnostic-v1.0';
const ROUND_TRIP_COST_BPS = 50;
const DEFAULT_MIN_SCORE = 16;
const MIN_TICK_BUFFER = 2;
const SMALL_SAMPLE_THRESHOLD = 5;
const EXCLUDED_OUTLIER_TICKER = 'BNBR';

const POLICIES = Object.freeze([
  { key: 'IMMEDIATE_FIRST_TOUCH', label: 'immediate trailing exit on first touch' },
  { key: 'ONE_OBS_RECLAIM', label: 'one-observation reclaim confirmation' },
  { key: 'TWO_OBS_BREAKDOWN', label: 'two-observation breakdown confirmation' },
  { key: 'EMERGENCY_ONLY', label: 'emergency structural stop always active' }
]);

const SAFETY_BLOCK = Object.freeze({
  DAYTRADE_INTRADAY_SCORE_ENABLED: 'false',
  DAYTRADE_WORKER_ALLOW_MUTATION: 'false',
  TELEGRAM_ENABLED: '0',
  production_scoring_enabled: false,
  mutations_performed: false,
  telegram_sent: false,
  supabase_writes: false,
  portfolio_mutated: false,
  emergency_hard_stop_always_active: true,
  source_files_rewritten: false
});

function round4(n) { return bt.round4(n); }
function median(values) { return bt.median(values); }
function mean(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((s, v) => s + v, 0) / nums.length;
}

// ---------------------------------------------------------------------------
// Single-trade simulation of one confirmation policy
// ---------------------------------------------------------------------------
/**
 * Simulate one confirmation policy over one trade's forward path.
 *
 * The trailing reference ratchets (never lowered) after activation at +1R / TP1.
 * Before activation the protective reference is the structural SL. The emergency
 * hard stop (below the SL) is ALWAYS active for every policy and is never
 * disabled by a reclaim.
 *
 * @param {object} p entry/support/resistance/atrProxy/forwardPath +
 *                    { supportBufferAtr, trailingAtr, tp1BufferAtr }
 * @param {string} policyKey
 * @returns {object} outcome
 */
function simulateSweepPolicy(p, policyKey) {
  const entry = p.entryPrice;
  const tickSize = idx.getIdxTickSize(entry) || 1;
  const atr = Number.isFinite(p.atrProxy) && p.atrProxy > 0 ? p.atrProxy : null;
  const tickFloor = MIN_TICK_BUFFER * tickSize;

  const slBuffer = Math.max(atr !== null ? p.supportBufferAtr * atr : 0, tickFloor);
  const sl = idx.roundToIdxTick(p.support - slBuffer, 'floor');
  const emergency = idx.roundToIdxTick(p.support - slBuffer * 2, 'floor');
  const tolerance = Math.max(tickSize, atr !== null ? 0.25 * atr : 0);

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

  const pathRows = p.forwardPath;

  let mfe = 0;
  let mae = 0;
  let highestClose = entry;
  let activated = false;
  let trailingRef = null;             // ratcheting soft trailing reference
  let exitPrice = null;
  let exitReason = null;
  let sweptAndReclaimed = false;
  let reclaimIndex = -1;
  // Policy state.
  let pendingTouch = false;           // ONE_OBS_RECLAIM: touched, awaiting next obs
  let consecBelowBuffered = 0;        // TWO_OBS_BREAKDOWN: consecutive closes < buffered

  for (let i = 0; i < pathRows.length; i++) {
    const price = pathRows[i].price;
    const excursion = price - entry;
    if (excursion > mfe) mfe = excursion;
    if (excursion < mae) mae = excursion;
    if (price > highestClose) highestClose = price;

    if (!activated && activationPrice !== null && price >= activationPrice) activated = true;
    if (activated && atr !== null) {
      const cand = highestClose - p.trailingAtr * atr;
      if (trailingRef === null || cand > trailingRef) trailingRef = cand; // never lowered
    }

    // Protective (soft) reference: structural SL until activation, then the
    // higher of the SL and the ratcheting trailing reference.
    let protectiveRef = Number.isFinite(sl) ? sl : null;
    if (activated && trailingRef !== null && (protectiveRef === null || trailingRef > protectiveRef)) {
      protectiveRef = trailingRef;
    }
    const bufferedRef = protectiveRef !== null ? protectiveRef - tolerance : null;

    // Emergency hard stop is ALWAYS active for every policy.
    if (Number.isFinite(emergency) && price <= emergency) {
      exitPrice = price; exitReason = 'EMERGENCY_STOP'; break;
    }

    if (policyKey === 'EMERGENCY_ONLY') {
      continue; // only the emergency stop can exit; hold otherwise
    }

    if (protectiveRef === null) continue;

    if (policyKey === 'IMMEDIATE_FIRST_TOUCH') {
      if (price <= protectiveRef) { exitPrice = price; exitReason = 'TRAILING_FIRST_TOUCH'; break; }
    } else if (policyKey === 'ONE_OBS_RECLAIM') {
      if (pendingTouch) {
        // The observation AFTER a touch decides: reclaim (>= ref) => continue.
        if (price >= protectiveRef) {
          sweptAndReclaimed = true;
          if (reclaimIndex < 0) reclaimIndex = i;
          pendingTouch = false;
        } else {
          exitPrice = price; exitReason = 'TRAILING_1OBS_NO_RECLAIM'; break;
        }
      } else if (price <= protectiveRef) {
        pendingTouch = true; // await the next observation before exiting
      }
    } else if (policyKey === 'TWO_OBS_BREAKDOWN') {
      if (bufferedRef !== null && price < bufferedRef) {
        consecBelowBuffered++;
        if (consecBelowBuffered >= 2) { exitPrice = price; exitReason = 'TRAILING_2OBS_BREAKDOWN'; break; }
      } else {
        if (consecBelowBuffered === 1 && price >= protectiveRef) { sweptAndReclaimed = true; if (reclaimIndex < 0) reclaimIndex = i; }
        consecBelowBuffered = 0;
      }
    }
  }

  if (exitPrice === null) {
    if (pathRows.length) { exitPrice = pathRows[pathRows.length - 1].price; exitReason = 'EOD'; }
    else return { available: false, reason: 'NO_FORWARD_PATH' };
  }

  // Subsequent MFE after a reclaimed sweep (observable continuation upside).
  let subsequentMfeAfterReclaim = null;
  if (sweptAndReclaimed && reclaimIndex >= 0) {
    let m = 0;
    for (let j = reclaimIndex; j < pathRows.length; j++) {
      const exc = pathRows[j].price - entry;
      if (exc > m) m = exc;
    }
    subsequentMfeAfterReclaim = round4((m / entry) * 100);
  }

  const grossPct = ((exitPrice - entry) / entry) * 100;
  const netPct = grossPct - ROUND_TRIP_COST_BPS / 100;

  return {
    available: true,
    policy: policyKey,
    entry_price: entry,
    structural_sl: Number.isFinite(sl) ? sl : null,
    emergency_stop: Number.isFinite(emergency) ? emergency : null,
    tp1,
    exit_price: exitPrice,
    exit_reason: exitReason,
    emergency_exit: exitReason === 'EMERGENCY_STOP',
    trailing_exit: exitReason && exitReason.indexOf('TRAILING') === 0,
    swept_and_reclaimed: sweptAndReclaimed,
    subsequent_mfe_after_reclaim_pct: subsequentMfeAfterReclaim,
    mfe_pct: round4((mfe / entry) * 100),
    mae_pct: round4((mae / entry) * 100),
    gross_return_pct: round4(grossPct),
    net_return_pct: round4(netPct)
  };
}

// ---------------------------------------------------------------------------
// Aggregate one policy across trades (with per-trade immediate comparison)
// ---------------------------------------------------------------------------
function aggregatePolicy(policyKey, trades) {
  const resolved = trades.filter((t) => t.outcomes[policyKey] && t.outcomes[policyKey].available);
  const n = resolved.length;

  let avoidedFalseExits = 0;
  let additionalLossFromDelayTotal = 0;
  let additionalLossFromDelayCount = 0;
  const subsequentMfe = [];
  const nets = [];

  for (const t of resolved) {
    const o = t.outcomes[policyKey];
    const imm = t.outcomes.IMMEDIATE_FIRST_TOUCH;
    nets.push(o.net_return_pct);
    if (o.subsequent_mfe_after_reclaim_pct !== null) subsequentMfe.push(o.subsequent_mfe_after_reclaim_pct);

    if (imm && imm.available && policyKey !== 'IMMEDIATE_FIRST_TOUCH') {
      const immExitedOnTrailing = imm.trailing_exit;
      const policyDidNotTrailingExit = !o.trailing_exit;
      // Avoided a false exit: immediate would have exited on the trailing touch,
      // this policy did not, and the delayed outcome was better.
      if (immExitedOnTrailing && policyDidNotTrailingExit && o.net_return_pct > imm.net_return_pct) {
        avoidedFalseExits++;
      }
      // Additional loss caused by waiting for confirmation.
      if (o.net_return_pct < imm.net_return_pct) {
        additionalLossFromDelayTotal += (imm.net_return_pct - o.net_return_pct);
        additionalLossFromDelayCount++;
      }
    }
  }

  // Equity / drawdown / outlier dependence on net returns.
  const ordered = resolved.slice().sort((a, b) =>
    String(a._date).localeCompare(String(b._date)) ||
    (a._entryMinutes - b._entryMinutes) ||
    String(a._ticker).localeCompare(String(b._ticker)));
  let eq = 1, peak = 1, maxDD = 0;
  for (const t of ordered) {
    eq *= (1 + t.outcomes[policyKey].net_return_pct / 100);
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? (peak - eq) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }

  const totalNet = nets.reduce((s, v) => s + v, 0);
  let best = null;
  for (const t of resolved) {
    const v = t.outcomes[policyKey].net_return_pct;
    if (best === null || v > best) best = v;
  }
  const netsExBest = (() => {
    let removed = false;
    const out = [];
    for (const t of resolved) {
      const v = t.outcomes[policyKey].net_return_pct;
      if (!removed && v === best) { removed = true; continue; }
      out.push(v);
    }
    return out;
  })();

  const emergencyExits = resolved.filter((t) => t.outcomes[policyKey].emergency_exit).length;
  const trailingExits = resolved.filter((t) => t.outcomes[policyKey].trailing_exit).length;
  const reclaims = resolved.filter((t) => t.outcomes[policyKey].swept_and_reclaimed).length;

  return {
    resolved_trades: n,
    avoided_false_exits: avoidedFalseExits,
    additional_losses_from_delayed_confirmation: {
      count: additionalLossFromDelayCount,
      total_pct: round4(additionalLossFromDelayTotal)
    },
    subsequent_mfe_after_reclaimed_sweep: {
      count: subsequentMfe.length,
      avg_pct: subsequentMfe.length ? round4(mean(subsequentMfe)) : null,
      total_pct: round4(subsequentMfe.reduce((s, v) => s + v, 0))
    },
    reclaimed_sweeps: reclaims,
    emergency_exit_count: emergencyExits,
    trailing_exit_count: trailingExits,
    avg_net_return_pct: n ? round4(mean(nets)) : null,
    median_net_return_pct: n ? round4(median(nets)) : null,
    total_net_return_pct: round4(totalNet),
    max_drawdown_pct: round4(maxDD * 100),
    outlier_dependence: {
      best_trade_net_pct: best,
      best_trade_share_of_total: (best !== null && totalNet !== 0) ? round4(best / totalNet) : null,
      avg_net_excluding_best: netsExBest.length ? round4(mean(netsExBest)) : null,
      total_net_excluding_best: round4(netsExBest.reduce((s, v) => s + v, 0))
    }
  };
}

// ---------------------------------------------------------------------------
// Build the per-trade outcomes for every policy
// ---------------------------------------------------------------------------
function buildTrades(perDate, variant) {
  const trades = [];
  for (const d of perDate) {
    for (const sig of d.signals) {
      if (!sig.entry.available) continue;
      const common = {
        entryPrice: sig.entry.entry_price,
        support: sig.support,
        resistance: sig.resistance,
        atrProxy: sig.atrProxy,
        forwardPath: sig.forwardPath,
        supportBufferAtr: variant.supportBufferAtr,
        trailingAtr: variant.trailingAtr,
        tp1BufferAtr: variant.tp1BufferAtr
      };
      const outcomes = {};
      for (const pol of POLICIES) outcomes[pol.key] = simulateSweepPolicy(common, pol.key);
      trades.push({
        _date: d.date,
        _ticker: sig.ticker,
        _entryMinutes: bt.timeToMinutes(sig.entry.entry_time),
        outcomes
      });
    }
  }
  return trades;
}

function aggregateAllPolicies(trades) {
  const out = {};
  for (const pol of POLICIES) out[pol.key] = { label: pol.label, metrics: aggregatePolicy(pol.key, trades) };
  return out;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
async function runSweepConfirmationDiagnostic(rawOpts) {
  rawOpts = rawOpts || {};
  const env = rawOpts.env || process.env;

  // HARD SCOPE GUARD: DAY_TRADE only.
  const requested = rawOpts.screenerType != null ? normalizeScreenerType(rawOpts.screenerType) : 'DAY_TRADE';
  if (requested !== 'DAY_TRADE') {
    return {
      status: 'rejected_scope',
      errors: ['sweep-confirmation diagnostic is DAY_TRADE only; refusing screener_type ' + JSON.stringify(rawOpts.screenerType)],
      note: 'These three intraday days must NOT be used to claim calibration of Swing Konglo or Swing Non-Konglo.'
    };
  }

  const safety = shadow.assertShadowSafety(env);
  if (!safety.safe) return { status: 'safety_violation', errors: safety.errors };

  const missing = [];
  if (!rawOpts.shadowRoot) missing.push('shadowRoot');
  if (!rawOpts.sampleRoot) missing.push('sampleRoot');
  if (!Array.isArray(rawOpts.dates) || !rawOpts.dates.length) missing.push('dates');
  if (missing.length) return { status: 'error', errors: ['missing required argument(s): ' + missing.join(', ')] };

  const validated = [];
  for (const d of rawOpts.dates) {
    const v = shadow.validateDateFormat(d);
    if (!v.valid) return { status: 'rejected', reason: v.reason, errors: ['invalid date: ' + JSON.stringify(d)] };
    if (validated.includes(v.date)) return { status: 'rejected', reason: 'duplicate_date', errors: ['duplicate date: ' + JSON.stringify(v.date)] };
    validated.push(v.date);
  }

  const minScore = Number.isFinite(Number(rawOpts.minScore)) ? Number(rawOpts.minScore) : DEFAULT_MIN_SCORE;

  // Reuse the DAY_TRADE diagnostic's read-only per-date preparation.
  const perDate = [];
  for (const date of validated) {
    perDate.push(await diagnostic.prepareDate(
      path.join(rawOpts.shadowRoot, date),
      path.join(rawOpts.sampleRoot, date),
      date, minScore));
  }

  // Baseline DAY_TRADE profile parameters (support 0.50 ATR, TP1 0.20 ATR,
  // trailing 1.00 ATR). Swing parameters are NEVER calibrated here.
  const dayProfile = SCREENER_PROFILES.DAY_TRADE;
  const variant = {
    supportBufferAtr: dayProfile.volatility_buffer_atr,
    tp1BufferAtr: 0.20,
    trailingAtr: dayProfile.trailing_atr_multiplier
  };

  const allTrades = buildTrades(perDate, variant);
  const tradesExBnbr = allTrades.filter((t) => t._ticker !== EXCLUDED_OUTLIER_TICKER);
  const bnbrPresent = allTrades.some((t) => t._ticker === EXCLUDED_OUTLIER_TICKER);

  const uniqueIndependentTrades = allTrades.length;

  const warnings = [];
  if (uniqueIndependentTrades < SMALL_SAMPLE_THRESHOLD) {
    warnings.push('SMALL_INDEPENDENT_TRADE_SAMPLE: only ' + uniqueIndependentTrades +
      ' independent trade(s); results are NOT statistically meaningful and NO profitability is claimed.');
  }
  if (perDate.some((d) => d.missing_files.length)) warnings.push('MISSING_SOURCE_FILES: see counts.per_date.');
  if (!bnbrPresent) {
    warnings.push('BNBR_NOT_PRESENT: ' + EXCLUDED_OUTLIER_TICKER +
      ' is not present in these datasets; the excluding-' + EXCLUDED_OUTLIER_TICKER + ' results equal the all-trades results.');
  }

  return {
    status: 'success',
    generator_version: GENERATOR_VERSION,
    mode: 'daytrade_sweep_confirmation_shadow_diagnostic_only',
    screener_type: 'DAY_TRADE',
    dates: validated,
    safety: SAFETY_BLOCK,
    parameters: {
      candidate_rule: { confirmation_state: 'CONFIRMED', confirmed_rank: 1, min_shadow_score: minScore },
      day_trade_profile: {
        support_buffer_atr: variant.supportBufferAtr,
        tp1_resistance_buffer_atr: variant.tp1BufferAtr,
        trailing_atr: variant.trailingAtr
      },
      round_trip_cost_bps: ROUND_TRIP_COST_BPS,
      confirmation_policies: POLICIES.map((p) => ({ key: p.key, label: p.label })),
      emergency_hard_stop_always_active: true,
      independent_deduplicated_trades: true
    },
    counts: {
      unique_independent_trades: uniqueIndependentTrades,
      unique_independent_trades_excluding_bnbr: tradesExBnbr.length,
      per_date: perDate.map((d) => ({ date: d.date, signals: d.signals.length, entered: d.signals.filter((x) => x.entry.available).length }))
    },
    policy_comparison_all_trades: aggregateAllPolicies(allTrades),
    policy_comparison_excluding_bnbr: aggregateAllPolicies(tradesExBnbr),
    excluding_bnbr_note: bnbrPresent
      ? EXCLUDED_OUTLIER_TICKER + ' excluded from the excluding-BNBR comparison.'
      : EXCLUDED_OUTLIER_TICKER + ' was not present in these datasets; excluding-BNBR results are identical to all-trades results.',
    warnings,
    scope_disclaimer: 'DAY TRADE sweep-confirmation diagnostic only. The emergency hard stop is always active for every policy and is never disabled by a reclaim. These three intraday days must NOT be used to claim calibration of Swing Konglo or Swing Non-Konglo. Shadow research on already-collected data; not investment advice; small samples are flagged and NO profitability is claimed.'
  };
}

module.exports = {
  GENERATOR_VERSION,
  ROUND_TRIP_COST_BPS,
  DEFAULT_MIN_SCORE,
  EXCLUDED_OUTLIER_TICKER,
  POLICIES,
  SAFETY_BLOCK,
  simulateSweepPolicy,
  aggregatePolicy,
  aggregateAllPolicies,
  buildTrades,
  runSweepConfirmationDiagnostic
};
