'use strict';

/**
 * Trade Plan V2 — Screener Integration Layer
 * ==========================================
 *
 * ONE integration seam that wires the canonical Trade Plan V2 engine
 * (lib/trade-plan-v2.js) into ALL THREE screener pipelines and BOTH presentation
 * channels, without ever recomputing prices in presentation code and without
 * touching any base-screener scoring / ranking / eligibility / candidate
 * selection.
 *
 *   Pipelines (attach a SHADOW plan, gated by TRADE_PLAN_V2_SHADOW_ENABLED):
 *     - DAY_TRADE        (lib/daytrade-screener-engine.js runDayTradeBatch)
 *     - SWING_KONGLO     (api/sector-hot.js Konglo handler)
 *     - SWING_NON_KONGLO (api/sector-hot.js Non-Konglo handler)
 *
 *   Presentation (choose plan, gated by TRADE_PLAN_V2_PUBLIC_ENABLED):
 *     - Website  (api/sector-hot.js read handlers)
 *     - Telegram (lib/telegram-templates.js formatSignalCard)
 *
 * Safety contract
 * ---------------
 *   1. `attachShadowTradePlanV2` is a NO-OP that returns the candidate untouched
 *      (no new fields) unless TRADE_PLAN_V2_SHADOW_ENABLED is explicitly true, so
 *      persisted / scored output is byte-identical by default.
 *   2. `resolvePublicTradePlan` returns the LEGACY plan UNCHANGED unless
 *      TRADE_PLAN_V2_PUBLIC_ENABLED is explicitly true, so public output never
 *      changes until the flag is flipped.
 *   3. When the public flag IS on, BOTH channels build their view-model from the
 *      SAME canonical trade_plan_v2 via the shared formatter, so displayed
 *      numbers can never diverge.
 *   4. Legacy fallback: if mandatory V2 data is missing or the V2 plan is
 *      REJECTED, the public channel falls back to the legacy plan.
 *   5. Production trailing is the canonical ATR ratcheting stop (activate at +1R
 *      or TP1, non-decreasing, emergency structural stop always active). The
 *      liquidity-sweep delayed-exit fields are advisory SHADOW-only and are never
 *      used as the production trailing mechanism (see buildProductionTrailing).
 *
 * This module performs NO Supabase / Telegram / cron / wall-clock / mutation.
 */

const tpv2 = require('./trade-plan-v2');
const fmt = require('./trade-plan-v2-formatter');
const flags = require('./trade-plan-v2-flags');

// Mode aliases used by the various pipelines / presentation callers.
const MODE_TO_SCREENER = Object.freeze({
  daytrade: 'DAY_TRADE',
  day_trade: 'DAY_TRADE',
  day: 'DAY_TRADE',
  swing: 'SWING_KONGLO',
  swing_konglo: 'SWING_KONGLO',
  konglo: 'SWING_KONGLO',
  swing_non_konglo: 'SWING_NON_KONGLO',
  swing_nonkonglo: 'SWING_NON_KONGLO',
  non_konglo: 'SWING_NON_KONGLO',
  nonkonglo: 'SWING_NON_KONGLO'
});

// Mandatory numeric fields a V2 plan MUST carry to be shown publicly. When any
// is missing (or the plan is rejected), the public channel falls back to legacy.
const MANDATORY_PUBLIC_FIELDS = Object.freeze([
  'entry_zone_high',
  'support',
  'resistance',
  'stop_loss',
  'tp1',
  'rr_to_tp1',
  'trailing_activation'
]);

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve a canonical screener type from a mode string / candidate / options.
 * Never throws; returns null when it cannot be resolved.
 */
function resolveScreenerType(input) {
  if (!input) return null;
  const raw = String(input).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (MODE_TO_SCREENER[raw]) return MODE_TO_SCREENER[raw];
  return tpv2.normalizeScreenerType(input);
}

/**
 * Extract the LEGACY trade-plan payload straight from a screener candidate row.
 * This is a pure READ — it never recomputes any price. It is the exact object
 * the public channels display today and the guaranteed fallback target.
 */
function buildLegacyTradePlan(candidate) {
  candidate = candidate || {};
  const pick = (keys) => {
    for (const k of keys) {
      if (candidate[k] !== undefined && candidate[k] !== null) return candidate[k];
    }
    return null;
  };
  return {
    source: 'legacy',
    plan_version: 'legacy',
    ticker: candidate.ticker ? String(candidate.ticker).toUpperCase() : null,
    entry_low: pick(['entry_low', 'entry1', 'entry_1']),
    entry_high: pick(['entry_high', 'entry2', 'entry_2']),
    tp1: pick(['tp1', 'tp1n']),
    tp2: pick(['tp2', 'tp2n']),
    stop_loss: pick(['stop_loss', 'sl']),
    risk_reward: pick(['risk_reward', 'rr']),
    support: pick(['support', 'support1', 's1']),
    resistance: pick(['resistance', 'resistance1', 'r1']),
    invalidation: pick(['invalidation'])
  };
}

/**
 * Build the canonical trade_plan_v2 object for one screener candidate.
 *
 * The candidate row already carries the base-screener output (entry_low/high,
 * support, resistance, atr14, swing_low, tp1/tp2, last_price, ...). Existing base
 * formulas are preserved — the engine reads the entry zone from the candidate and
 * only derives the structural SL / TP / trailing / RR contract.
 *
 * @param {object} candidate screener candidate row
 * @param {object} options { screener_type|mode, observations, next_resistance,
 *                           gaps, generated_at, breakout_confirmed,
 *                           breakdown_confirmed }
 * @returns {object} canonical trade_plan_v2 (always includes plan_version+status)
 */
function buildCandidatePlanV2(candidate, options) {
  candidate = candidate || {};
  options = options || {};
  const screenerType = resolveScreenerType(
    options.screener_type || options.mode || candidate.screener_type || candidate.mode || candidate.category
  );
  return tpv2.buildTradePlanV2(candidate, {
    screener_type: screenerType,
    generated_at: options.generated_at != null ? options.generated_at : (candidate.generated_at != null ? candidate.generated_at : null),
    observations: options.observations != null ? options.observations : candidate.observations,
    next_resistance: options.next_resistance != null ? options.next_resistance
      : (candidate.next_resistance != null ? candidate.next_resistance : candidate.resistance2),
    gaps: options.gaps != null ? options.gaps : candidate.gaps,
    breakout_confirmed: options.breakout_confirmed,
    breakdown_confirmed: options.breakdown_confirmed,
    ticker: candidate.ticker
  });
}

/**
 * Is a canonical plan complete + accepted enough to display publicly?
 * Rejected plans and plans missing any mandatory numeric field are NOT usable
 * (the caller then falls back to the legacy plan).
 */
function isPlanV2Usable(plan) {
  if (!plan || plan.plan_version !== tpv2.PLAN_VERSION) return false;
  if (plan.status === tpv2.STATUS.REJECTED) return false;
  for (const f of MANDATORY_PUBLIC_FIELDS) {
    if (num(plan[f]) === null) return false;
  }
  return true;
}

/**
 * Build the PRODUCTION trailing descriptor from a canonical plan.
 *
 * Production trailing is strictly the ATR ratcheting stop that activates at +1R
 * or TP1 and never decreases, with the emergency structural stop always active.
 * The liquidity-sweep delayed-exit signals (soft_exit_state / hard_exit_state /
 * trailing_sweep_state) are advisory SHADOW-only observations and are NEVER used
 * to delay or drive the production exit here.
 *
 * @returns {object} { activation, method, atr_multiplier, emergency_stop,
 *                      non_decreasing, delayed_exit_enabled:false }
 */
function buildProductionTrailing(plan) {
  plan = plan || {};
  return {
    activation: plan.trailing_activation != null ? plan.trailing_activation : null,
    reference: plan.trailing_reference != null ? plan.trailing_reference : null,
    method: plan.trailing_method || null,
    atr_multiplier: plan.trailing_atr_multiplier != null ? plan.trailing_atr_multiplier : null,
    emergency_stop: plan.emergency_stop != null ? plan.emergency_stop : null,
    non_decreasing: true,
    // Liquidity-sweep delayed exit is SHADOW-only and never enabled in production.
    delayed_exit_enabled: false,
    liquidity_sweep_shadow_only: true
  };
}

/**
 * Attach a SHADOW canonical trade_plan_v2 (and its legacy counterpart) to a
 * candidate — but ONLY when TRADE_PLAN_V2_SHADOW_ENABLED is explicitly true.
 *
 * When the shadow flag is off (default) the candidate is returned completely
 * untouched (no new fields), so scored / persisted output stays byte-identical.
 * This NEVER mutates any scoring / ranking / eligibility field — it only adds the
 * additive `trade_plan_v2`, `trade_plan_legacy` and `trade_plan_v2_shadow` fields.
 *
 * @param {object} candidate screener candidate row (mutated in place, additively)
 * @param {object} options { screener_type|mode, env, ...buildCandidatePlanV2 opts }
 * @returns {object} the same candidate reference
 */
function attachShadowTradePlanV2(candidate, options) {
  options = options || {};
  const env = options.env;
  if (!candidate || !flags.isShadowEnabled(env)) return candidate;
  const plan = buildCandidatePlanV2(candidate, options);
  candidate.trade_plan_v2 = plan;
  candidate.trade_plan_legacy = buildLegacyTradePlan(candidate);
  candidate.trade_plan_v2_shadow = true;
  return candidate;
}

/**
 * Decide which trade plan the PUBLIC channel (website OR Telegram) should show
 * for a candidate, and build the correct view-model for the channel.
 *
 * Behaviour:
 *   - TRADE_PLAN_V2_PUBLIC_ENABLED false (default) => return legacy UNCHANGED.
 *   - flag true + usable V2 plan  => return the V2 view-model (same canonical
 *     numbers for both channels).
 *   - flag true + missing/rejected V2 => FALL BACK to the legacy plan.
 *
 * @param {object} candidate screener candidate row
 * @param {object} options { channel:'web'|'telegram', mode|screener_type, env,
 *                           planV2 (optional precomputed), ...build opts }
 * @returns {object} { source, public_v2_enabled, fallback, payload, planV2 }
 */
function resolvePublicTradePlan(candidate, options) {
  options = options || {};
  const channel = options.channel === 'telegram' ? 'telegram' : 'web';
  const env = options.env;
  const legacy = buildLegacyTradePlan(candidate);

  if (!flags.isPublicEnabled(env)) {
    return { source: 'legacy', public_v2_enabled: false, fallback: false, payload: legacy, planV2: null };
  }

  // Reuse an already-attached shadow plan when present + usable; else build one.
  let planV2 = options.planV2 || (candidate && candidate.trade_plan_v2) || null;
  if (!isPlanV2Usable(planV2)) {
    planV2 = buildCandidatePlanV2(candidate, options);
  }

  if (!isPlanV2Usable(planV2)) {
    // Mandatory data unavailable or plan rejected => legacy fallback.
    return { source: 'legacy_fallback', public_v2_enabled: true, fallback: true, payload: legacy, planV2: planV2 || null };
  }

  const vm = channel === 'telegram' ? fmt.buildTelegramViewModel(planV2) : fmt.buildWebViewModel(planV2);
  // Attach the production trailing descriptor (ATR ratcheting, sweep shadow-only).
  vm.production_trailing = buildProductionTrailing(planV2);
  return { source: 'trade_plan_v2', public_v2_enabled: true, fallback: false, payload: vm, planV2: planV2 };
}

/**
 * Decorate an array of candidate rows for the WEBSITE response.
 *
 * When the public flag is off (default) the rows are returned untouched (the
 * SAME array reference) so the web payload is byte-identical. When the flag is
 * on, each row gains an additive `trade_plan_public` field carrying the canonical
 * view-model (or the legacy fallback), which the front-end may consume. Base
 * fields are never removed or recomputed.
 *
 * @param {Array} rows
 * @param {object} options { mode|screener_type, env }
 * @returns {Array} rows (same reference when the flag is off)
 */
function decorateRowsForWeb(rows, options) {
  options = options || {};
  if (!Array.isArray(rows) || !flags.isPublicEnabled(options.env)) return rows;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const resolved = resolvePublicTradePlan(row, {
      channel: 'web',
      mode: options.mode,
      screener_type: options.screener_type,
      env: options.env,
      observations: row.observations,
      generated_at: options.generated_at
    });
    row.trade_plan_public = resolved.payload;
    row.trade_plan_public_source = resolved.source;
  }
  return rows;
}

module.exports = {
  MODE_TO_SCREENER,
  MANDATORY_PUBLIC_FIELDS,
  resolveScreenerType,
  buildLegacyTradePlan,
  buildCandidatePlanV2,
  isPlanV2Usable,
  buildProductionTrailing,
  attachShadowTradePlanV2,
  resolvePublicTradePlan,
  decorateRowsForWeb
};
