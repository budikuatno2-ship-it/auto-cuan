'use strict';

/**
 * Trade Plan V2 — Legacy vs V2 Replay / Preview (READ-ONLY)
 * ========================================================
 *
 * Compares the LEGACY trade plan against the canonical Trade Plan V2 for a set of
 * already-stored screener candidate rows, WITHOUT sending or mutating anything.
 *
 * It answers, for each candidate:
 *   - the legacy plan (entry / SL / TP / RR) exactly as displayed today,
 *   - the canonical V2 plan (structural SL / TP1 / TP2 / RR / trailing),
 *   - the numeric deltas between them,
 *   - whether the V2 plan is USABLE (would be shown if the public flag flipped),
 *     or whether the public channel would FALL BACK to legacy,
 *   - a web-vs-Telegram parity check on the canonical numbers.
 *
 * Determinism / safety
 * --------------------
 * Pure computation over provided rows. No Supabase, no Telegram, no cron, no
 * wall-clock, no mutation, no public-output change. The public flag is FORCED
 * off inside the comparison so a preview can never leak V2 into public output.
 */

const integration = require('./trade-plan-v2-integration');
const fmt = require('./trade-plan-v2-formatter');
const tpv2 = require('./trade-plan-v2');
const adapters = require('./trade-plan-v2-source-adapters');

// Reject reasons that are RISK-based (a real structural plan existed but was
// declined on risk grounds) vs STRUCTURE-based (no structural anchor at all).
const RISK_REJECT_REASONS = Object.freeze([
  'RISK_CANNOT_BE_CONTROLLED',
  'INSUFFICIENT_RR_TO_TP1',
  'STOP_NOT_BELOW_ENTRY'
]);
const STRUCTURE_REJECT_REASONS = Object.freeze([
  'NO_STRUCTURAL_LEVEL',
  'NO_VALID_ENTRY_PRICE',
  'UNKNOWN_SCREENER_TYPE'
]);

const GENERATOR_VERSION = 'trade-plan-v2-replay-preview-v1.0';

const SAFETY_BLOCK = Object.freeze({
  read_only: true,
  telegram_sent: false,
  supabase_writes: false,
  portfolio_mutated: false,
  public_output_changed: false,
  source_files_rewritten: false
});

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round4(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

function delta(a, b) {
  const na = num(a);
  const nb = num(b);
  if (na === null || nb === null) return null;
  return round4(nb - na);
}

/**
 * Compare the legacy plan and the canonical V2 plan for ONE candidate row.
 * @param {object} candidate stored screener row
 * @param {object} options { screener_type|mode, observations, generated_at }
 * @returns {object} single comparison record
 */
function compareCandidate(candidate, options) {
  options = options || {};
  const legacy = integration.buildLegacyTradePlan(candidate);

  // Resolve the screener type and run the per-screener adapter so EVERY
  // support/resistance/swing/ATR/gap alias + nested runtime field is recognised.
  // This guarantees NO_STRUCTURAL_LEVEL is never reported merely because the
  // adapter ignored an available alias — and structure is NEVER reverse-derived
  // from the legacy SL/TP.
  const screenerType = adapters.normalizeType(options.screener_type || options.mode) || 'DAY_TRADE';
  const built = integration.buildPlanFromSource(screenerType, {
    analysis: candidate, scored: candidate, row: candidate, candidate: candidate,
    candles: options.observations
  }, options);
  const planV2 = built.plan;
  const structural = built.structural || { available: false, source_fields: [] };
  const usable = integration.isPlanV2Usable(planV2);

  // Classify WHY a plan is not usable: genuinely missing structure vs declined
  // on risk grounds (a real structural plan existed).
  const rejectReason = planV2.reject_reason || null;
  const structureMissing = !structural.available ||
    STRUCTURE_REJECT_REASONS.indexOf(rejectReason) >= 0;
  const rejectedByRisk = planV2.status === tpv2.STATUS.REJECTED &&
    RISK_REJECT_REASONS.indexOf(rejectReason) >= 0;

  // Parity: BOTH channels must produce byte-identical canonical numbers.
  const web = fmt.buildWebViewModel(planV2);
  const tg = fmt.buildTelegramViewModel(planV2);
  const parity = fmt.diffViewModels(web, tg);

  // The V2 reference (fill) price is the entry_zone_high (see engine).
  const legacyEntryRef = num(legacy.entry_high) !== null ? num(legacy.entry_high) : num(legacy.entry_low);

  return {
    ticker: legacy.ticker || (candidate && candidate.ticker) || null,
    screener_type: planV2.screener_type,
    v2_status: planV2.status,
    v2_usable: usable,
    // Which plan the PUBLIC channel would show once the flag is enabled.
    public_would_use: usable ? 'trade_plan_v2' : 'legacy_fallback',
    structural_context_available: !!structural.available,
    structural_source_fields: Array.isArray(structural.source_fields) ? structural.source_fields.slice() : [],
    structure_missing: structureMissing,
    rejected_by_risk: rejectedByRisk,
    legacy: {
      entry_low: num(legacy.entry_low),
      entry_high: num(legacy.entry_high),
      stop_loss: num(legacy.stop_loss),
      tp1: num(legacy.tp1),
      tp2: num(legacy.tp2),
      risk_reward: num(legacy.risk_reward),
      support: num(legacy.support),
      resistance: num(legacy.resistance)
    },
    trade_plan_v2: {
      entry_zone_low: planV2.entry_zone_low,
      entry_zone_high: planV2.entry_zone_high,
      support: planV2.support,
      support_source: planV2.support_source,
      resistance: planV2.resistance,
      resistance_source: planV2.resistance_source,
      stop_loss: planV2.stop_loss,
      stop_loss_reason: planV2.stop_loss_reason,
      stop_anchor_type: planV2.stop_anchor_type,
      stop_anchor_price: planV2.stop_anchor_price,
      structural_invalidation: planV2.structural_invalidation,
      emergency_stop: planV2.emergency_stop,
      emergency_anchor_type: planV2.emergency_anchor_type,
      emergency_anchor_price: planV2.emergency_anchor_price,
      stop_distance_pct: planV2.stop_distance_pct,
      tp1: planV2.tp1,
      tp1_anchor_type: planV2.tp1_anchor_type,
      tp1_target_r: planV2.tp1_target_r,
      tp1_reason: planV2.tp1_reason,
      nearest_local_resistance: planV2.nearest_local_resistance,
      tp2: planV2.tp2,
      tp2_anchor_type: planV2.tp2_anchor_type,
      major_resistance: planV2.major_resistance,
      tp2_reason: planV2.tp2_reason,
      rr_to_tp1: planV2.rr_to_tp1,
      rr_to_tp2: planV2.rr_to_tp2,
      trailing_activation: planV2.trailing_activation,
      trailing_method: planV2.trailing_method,
      plan_version: planV2.plan_version,
      warnings: Array.isArray(planV2.warnings) ? planV2.warnings.slice() : [],
      reject_reason: planV2.reject_reason || null
    },
    // Production trailing is ATR ratcheting; liquidity-sweep delayed exit is
    // SHADOW-only and never enabled here.
    production_trailing: integration.buildProductionTrailing(planV2),
    deltas: {
      stop_loss: delta(legacy.stop_loss, planV2.stop_loss),
      tp1: delta(legacy.tp1, planV2.tp1),
      tp2: delta(legacy.tp2, planV2.tp2),
      rr_to_tp1: delta(legacy.risk_reward, planV2.rr_to_tp1),
      entry_ref: delta(legacyEntryRef, planV2.entry_zone_high)
    },
    web_telegram_parity_equal: parity.equal,
    web_telegram_parity_mismatches: parity.mismatches
  };
}

/**
 * Replay a set of stored candidate rows and produce the comparison report.
 *
 * @param {object} params { candidates:[], screener_type|mode, observationsByTicker,
 *                          generated_at }
 * @returns {object} report ({ status, summary, comparisons, safety })
 */
function replayCandidates(params) {
  params = params || {};
  const rows = Array.isArray(params.candidates) ? params.candidates : [];
  if (!rows.length) {
    return { status: 'error', errors: ['no candidate rows provided'], safety: SAFETY_BLOCK };
  }
  const obsByTicker = params.observationsByTicker || {};
  const comparisons = [];
  for (const row of rows) {
    const ticker = row && row.ticker ? String(row.ticker).toUpperCase() : null;
    comparisons.push(compareCandidate(row, {
      screener_type: params.screener_type,
      mode: params.mode,
      observations: (ticker && obsByTicker[ticker]) || row.observations,
      generated_at: params.generated_at != null ? params.generated_at : null
    }));
  }

  const total = comparisons.length;
  const usableCount = comparisons.filter((c) => c.v2_usable).length;
  const fallbackCount = total - usableCount;
  const parityFailures = comparisons.filter((c) => !c.web_telegram_parity_equal);
  const rejected = comparisons.filter((c) => c.v2_status === tpv2.STATUS.REJECTED);

  // Structural-availability accounting (honest reporting).
  const structuralAvailable = comparisons.filter((c) => c.structural_context_available).length;
  const structuralMissing = total - structuralAvailable;
  const rejectedByRisk = comparisons.filter((c) => c.rejected_by_risk).length;
  // Legacy fallbacks that occurred specifically because structure was missing
  // (NOT because a real structural plan was declined on risk grounds).
  const legacyFallbackMissingStructure = comparisons.filter((c) => !c.v2_usable && c.structure_missing).length;

  // Honest historical-structure verdict: if NO candidate carried real structural
  // context, the stored files genuinely did not capture it — report it plainly
  // rather than fabricating support/resistance from the legacy SL/TP.
  let historicalStructureStatus;
  if (structuralAvailable === 0 && total > 0) {
    historicalStructureStatus = 'HISTORICAL_STRUCTURE_NOT_CAPTURED';
  } else if (structuralMissing > 0) {
    historicalStructureStatus = 'HISTORICAL_STRUCTURE_PARTIALLY_CAPTURED';
  } else {
    historicalStructureStatus = 'STRUCTURE_PRESENT';
  }

  return {
    status: 'success',
    generator_version: GENERATOR_VERSION,
    mode: 'legacy_vs_trade_plan_v2_preview',
    safety: SAFETY_BLOCK,
    historical_structure_status: historicalStructureStatus,
    summary: {
      candidates: total,
      structural_context_available: structuralAvailable,
      structural_context_missing: structuralMissing,
      v2_usable: usableCount,
      v2_rejected: rejected.length,
      v2_rejected_by_risk: rejectedByRisk,
      legacy_fallback: fallbackCount,
      legacy_fallback_missing_structure: legacyFallbackMissingStructure,
      web_telegram_parity_ok: parityFailures.length === 0,
      parity_failures: parityFailures.map((c) => c.ticker)
    },
    comparisons,
    disclaimer: 'Read-only preview comparing the legacy trade plan against Trade Plan V2 on already-stored data. Structural context is read only from real screener fields — never reverse-derived from the legacy SL/TP. No public output changed; nothing sent or mutated. Not investment advice.'
  };
}

module.exports = {
  GENERATOR_VERSION,
  SAFETY_BLOCK,
  compareCandidate,
  replayCandidates
};
