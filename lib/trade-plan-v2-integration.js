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

const crypto = require('node:crypto');
const tpv2 = require('./trade-plan-v2');
const fmt = require('./trade-plan-v2-formatter');
const flags = require('./trade-plan-v2-flags');
const adapters = require('./trade-plan-v2-source-adapters');

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
  'stop_anchor_price',
  'tp1',
  'rr_to_tp1',
  'trailing_activation'
]);

const MANDATORY_PUBLIC_LABEL_FIELDS = Object.freeze([
  'stop_anchor_type',
  'tp1_anchor_type'
]);

const MANDATORY_PUBLIC_WARNINGS = Object.freeze([
  tpv2.WARN.STALE_DATA,
  tpv2.WARN.NO_VALID_ENTRY_PRICE,
  tpv2.WARN.NO_STRUCTURAL_LEVEL,
  tpv2.WARN.NO_RESISTANCE_TP1_UNAVAILABLE,
  tpv2.WARN.RISK_CANNOT_BE_CONTROLLED,
  'STOP_NOT_BELOW_ENTRY'
]);

// Warnings that indicate structural impossibility — their presence means the
// plan can never be publicly usable regardless of status or RR.
const MANDATORY_REJECTION_WARNINGS = Object.freeze([
  tpv2.WARN.STALE_DATA,
  tpv2.WARN.NO_VALID_ENTRY_PRICE,
  tpv2.WARN.NO_STRUCTURAL_LEVEL,
  tpv2.WARN.NO_RESISTANCE_TP1_UNAVAILABLE,
  tpv2.WARN.RISK_CANNOT_BE_CONTROLLED,
  'STOP_NOT_BELOW_ENTRY'
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
 * Build a canonical trade_plan_v2 from a REAL screener runtime `source` (the
 * pre-flatten analysis / scored object + candles) via the per-screener adapter.
 *
 * This is the fix for NO_STRUCTURAL_LEVEL: the adapter maps the screener's
 * already-computed structure (support, confirmed swing low, resistance, ATR,
 * demand/supply gaps, OHLC) into the canonical input — instead of the flattened
 * notification row which lacks those fields. It NEVER derives support from the
 * legacy SL or resistance from the legacy TP.
 *
 * @param {string} screenerType DAY_TRADE | SWING_KONGLO | SWING_NON_KONGLO
 * @param {object} source { analysis, scored, row, candidate, candles, ... }
 * @param {object} options { generated_at, breakout_confirmed, breakdown_confirmed }
 * @returns {object} { plan, structural, input }
 */
function buildPlanFromSource(screenerType, source, options) {
  options = options || {};
  const adapted = adapters.adaptByScreenerType(screenerType, source || {});
  const input = adapted.input || {};
  const plan = tpv2.buildTradePlanV2(input, {
    screener_type: resolveScreenerType(screenerType),
    generated_at: options.generated_at != null ? options.generated_at : null,
    observations: input.observations,
    next_resistance: input.next_resistance,
    gaps: input.gaps,
    breakout_confirmed: options.breakout_confirmed,
    breakdown_confirmed: options.breakdown_confirmed,
    ticker: input.ticker
  });
  return { plan, structural: adapted.structural, input };
}

/**
 * Is a canonical plan complete + accepted enough to display publicly?
 *
 * Status handling:
 *   - OK: usable when mandatory validity checks pass.
 *   - WARNING: usable when mandatory validity checks pass.
 *   - REDUCE_POSITION_SIZE: usable only when mandatory validity checks,
 *     including minimum RR, pass.
 *   - REJECTED: never usable.
 *   - STALE_DATA: never usable (captured via data_freshness.is_stale).
 *   - NO_STRUCTURAL_LEVEL: never usable (captured via reject_reason).
 *   - No valid TP1: never usable.
 *
 * A plan that meets all mandatory checks is usable — the caller then falls back
 * to the legacy plan only when this returns false.
 */
function isPlanV2Usable(plan) {
  if (!plan || plan.plan_version !== tpv2.PLAN_VERSION) return false;
  // REJECTED status is never usable regardless of reason.
  if (plan.status === tpv2.STATUS.REJECTED) return false;
  // Stale data is never usable.
  if (!plan.data_freshness || plan.data_freshness.is_stale !== false) return false;
  // Mandatory numeric fields must be present.
  for (const f of MANDATORY_PUBLIC_FIELDS) {
    if (num(plan[f]) === null) return false;
  }
  // Mandatory label fields must be present.
  for (const f of MANDATORY_PUBLIC_LABEL_FIELDS) {
    if (typeof plan[f] !== 'string' || !plan[f].trim()) return false;
  }
  // Per-screener minimum RR check: rr_to_tp1 must meet the profile minimum.
  const profileMinRr = plan.profile ? num(plan.profile.min_rr_to_tp1) : null;
  if (profileMinRr === null || num(plan.rr_to_tp1) === null || num(plan.rr_to_tp1) < profileMinRr) return false;
  // Mandatory rejection warnings: these indicate structural impossibility, not
  // merely suboptimal risk. Any of these present means the plan cannot be used.
  const warnings = Array.isArray(plan.warnings) ? plan.warnings : [];
  for (const w of MANDATORY_REJECTION_WARNINGS) {
    if (warnings.indexOf(w) >= 0) return false;
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

  // Prefer the REAL runtime `source` (analysis + candles) so the canonical engine
  // receives actual market structure (support / swing low / ATR / gaps) instead
  // of the flattened row. Falls back to the candidate itself for callers that do
  // not (yet) supply a source.
  if (options.source) {
    const screenerType = options.screener_type || options.mode || candidate.screener_type;
    const built = buildPlanFromSource(screenerType, options.source, options);
    candidate.trade_plan_v2 = built.plan;
    candidate.trade_plan_v2_structural = built.structural;
  } else {
    candidate.trade_plan_v2 = buildCandidatePlanV2(candidate, options);
  }
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

// ---------------------------------------------------------------------------
// Canonical trade-plan selector (ONE shared decision for every consumer)
// ---------------------------------------------------------------------------
/**
 * The canonical selected-plan contract. Every consumer — website, Telegram,
 * intraday sample writers, and progress monitoring — reads THESE numbers so they
 * can never diverge. Presentation / observation code must never recalculate any
 * of these values; it reads them straight from this object.
 */
const CANONICAL_PLAN_FIELDS = Object.freeze([
  'source', 'public_v2_enabled',
  'entry_zone_low', 'entry_zone_high',
  'stop_loss', 'structural_invalidation', 'emergency_stop',
  'tp1', 'tp2',
  'rr_to_tp1', 'minimum_rr_to_tp1',
  'stop_anchor_type', 'stop_anchor_price', 'tp1_anchor_type',
  'status', 'warnings', 'generated_at', 'data_freshness'
]);

/** Normalise a trading date to YYYY-MM-DD (drops any time component). */
function normalizeTradingDate(value) {
  if (value == null) return '';
  const s = String(value);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : s;
}

/** Build the canonical contract from a usable V2 plan (numbers read verbatim). */
function canonicalFromV2(plan, source, publicEnabled) {
  plan = plan || {};
  return {
    source: source,
    public_v2_enabled: !!publicEnabled,
    entry_zone_low: plan.entry_zone_low != null ? plan.entry_zone_low : null,
    entry_zone_high: plan.entry_zone_high != null ? plan.entry_zone_high : null,
    stop_loss: plan.stop_loss != null ? plan.stop_loss : null,
    structural_invalidation: plan.structural_invalidation != null ? plan.structural_invalidation : null,
    emergency_stop: plan.emergency_stop != null ? plan.emergency_stop : null,
    tp1: plan.tp1 != null ? plan.tp1 : null,
    tp2: plan.tp2 != null ? plan.tp2 : null,
    rr_to_tp1: plan.rr_to_tp1 != null ? plan.rr_to_tp1 : null,
    minimum_rr_to_tp1: plan.minimum_rr_to_tp1 != null ? plan.minimum_rr_to_tp1 : null,
    stop_anchor_type: plan.stop_anchor_type != null ? plan.stop_anchor_type : null,
    stop_anchor_price: plan.stop_anchor_price != null ? plan.stop_anchor_price : null,
    tp1_anchor_type: plan.tp1_anchor_type != null ? plan.tp1_anchor_type : null,
    status: plan.status != null ? plan.status : null,
    warnings: Array.isArray(plan.warnings) ? plan.warnings.slice() : [],
    generated_at: plan.generated_at != null ? plan.generated_at : null,
    data_freshness: plan.data_freshness != null ? plan.data_freshness : null
  };
}

/**
 * Build the canonical contract from the UNCHANGED legacy plan. V2-only structural
 * fields (structural_invalidation / emergency_stop / anchor labels) are null
 * because the legacy plan genuinely does not carry them — they are never
 * fabricated. `minimum_rr_to_tp1` is the screener's fixed profile minimum (a
 * documented constant, NOT a recalculated value).
 */
function canonicalFromLegacy(legacy, source, publicEnabled, screenerType, planV2, generatedAt) {
  legacy = legacy || {};
  const profile = tpv2.getProfile(screenerType);
  return {
    source: source,
    public_v2_enabled: !!publicEnabled,
    entry_zone_low: num(legacy.entry_low),
    entry_zone_high: num(legacy.entry_high),
    stop_loss: num(legacy.stop_loss),
    structural_invalidation: num(legacy.invalidation),
    emergency_stop: null,
    tp1: num(legacy.tp1),
    tp2: num(legacy.tp2),
    rr_to_tp1: num(legacy.risk_reward),
    minimum_rr_to_tp1: profile ? profile.min_rr_to_tp1 : null,
    stop_anchor_type: null,
    stop_anchor_price: null,
    tp1_anchor_type: null,
    status: source === 'legacy_fallback' ? 'LEGACY_FALLBACK' : 'LEGACY',
    // For a legacy fallback, surface WHY V2 was declined (diagnostic only).
    warnings: (source === 'legacy_fallback' && planV2 && Array.isArray(planV2.warnings)) ? planV2.warnings.slice() : [],
    generated_at: generatedAt != null ? generatedAt : null,
    data_freshness: (planV2 && planV2.data_freshness) || null
  };
}

/**
 * THE single canonical plan selection every consumer must use.
 *
 *   - TRADE_PLAN_V2_PUBLIC_ENABLED false (default) => source 'legacy'
 *     (the unchanged legacy numbers; public output stays byte-identical).
 *   - flag true + usable V2 plan                   => source 'trade_plan_v2'.
 *   - flag true + missing/rejected/stale/unsafe/below-min-RR V2 => source
 *     'legacy_fallback' (a COMPLETE legacy plan — never null SL/TP).
 *
 * Returns the canonical contract (CANONICAL_PLAN_FIELDS). Web, Telegram, intraday
 * writers and the progress monitor all consume this SAME object.
 *
 * @param {object} candidate screener candidate row
 * @param {object} options { mode|screener_type, env, planV2, generated_at, ... }
 */
function selectCanonicalTradePlan(candidate, options) {
  options = options || {};
  const env = options.env;
  const screenerType = resolveScreenerType(
    options.screener_type || options.mode ||
    (candidate && (candidate.screener_type || candidate.mode || candidate.category))
  );
  const legacy = buildLegacyTradePlan(candidate);
  const generatedAt = options.generated_at != null ? options.generated_at
    : (candidate && candidate.generated_at != null ? candidate.generated_at : null);

  if (!flags.isPublicEnabled(env)) {
    return canonicalFromLegacy(legacy, 'legacy', false, screenerType, null, generatedAt);
  }

  let planV2 = options.planV2 || (candidate && candidate.trade_plan_v2) || null;
  if (!isPlanV2Usable(planV2)) {
    planV2 = buildCandidatePlanV2(candidate, options);
  }
  if (!isPlanV2Usable(planV2)) {
    return canonicalFromLegacy(legacy, 'legacy_fallback', true, screenerType, planV2, generatedAt);
  }
  const c = canonicalFromV2(planV2, 'trade_plan_v2', true);
  if (c.generated_at == null && generatedAt != null) c.generated_at = generatedAt;
  return c;
}

/**
 * Deterministic plan-lock identifier. Derived ONLY from the stable identity of a
 * selected plan (screener type, ticker, screener trading date, selected source,
 * entry range, stop loss, emergency stop, TP1, TP2). Volatile runtime fields
 * (timestamps, current price, warnings, freshness) are DELIBERATELY excluded so a
 * later observation that merely re-runs produces the SAME id, while a genuinely
 * new screener snapshot that changes the plan produces a NEW id.
 */
function computePlanLockId(fields) {
  fields = fields || {};
  const parts = [
    resolveScreenerType(fields.screener_type) || String(fields.screener_type || '').toUpperCase(),
    fields.ticker ? String(fields.ticker).toUpperCase() : '',
    normalizeTradingDate(fields.trading_date),
    fields.source || '',
    fields.entry_zone_low == null ? '' : String(fields.entry_zone_low),
    fields.entry_zone_high == null ? '' : String(fields.entry_zone_high),
    fields.stop_loss == null ? '' : String(fields.stop_loss),
    fields.emergency_stop == null ? '' : String(fields.emergency_stop),
    fields.tp1 == null ? '' : String(fields.tp1),
    fields.tp2 == null ? '' : String(fields.tp2)
  ];
  const hash = crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
  return 'tplock_' + hash;
}

/**
 * Build the LOCKED trade-plan record persisted / exposed by the intraday system
 * and read by progress monitoring. Uses the canonical selector, exposes the exact
 * intraday field names the collector/observer/monitor persist, and stamps a
 * deterministic plan_lock_id so later monitoring can never silently switch between
 * legacy and V2 for the same snapshot.
 *
 * @param {object} candidate screener candidate/result row
 * @param {object} options { mode|screener_type, env, planV2, trading_date, generated_at }
 * @returns {object} locked record (canonical numbers + plan_lock_id + identity)
 */
function buildLockedTradePlan(candidate, options) {
  options = options || {};
  const screenerType = resolveScreenerType(
    options.screener_type || options.mode ||
    (candidate && (candidate.screener_type || candidate.mode || candidate.category))
  );
  const ticker = (candidate && candidate.ticker) ? String(candidate.ticker).toUpperCase() : (options.ticker || null);
  const tradingDateRaw = options.trading_date != null ? options.trading_date
    : (candidate && (candidate.trading_date || candidate.locked_date || candidate.date || candidate.trade_date)) || null;
  const canonical = selectCanonicalTradePlan(candidate, options);
  const plan_lock_id = computePlanLockId({
    screener_type: screenerType,
    ticker: ticker,
    trading_date: tradingDateRaw,
    source: canonical.source,
    entry_zone_low: canonical.entry_zone_low,
    entry_zone_high: canonical.entry_zone_high,
    stop_loss: canonical.stop_loss,
    emergency_stop: canonical.emergency_stop,
    tp1: canonical.tp1,
    tp2: canonical.tp2
  });
  return {
    trade_plan_source: canonical.source,
    entry_zone_low: canonical.entry_zone_low,
    entry_zone_high: canonical.entry_zone_high,
    stop_loss: canonical.stop_loss,
    structural_invalidation: canonical.structural_invalidation,
    emergency_stop: canonical.emergency_stop,
    tp1: canonical.tp1,
    tp2: canonical.tp2,
    rr_to_tp1: canonical.rr_to_tp1,
    minimum_rr_to_tp1: canonical.minimum_rr_to_tp1,
    stop_anchor_type: canonical.stop_anchor_type,
    stop_anchor_price: canonical.stop_anchor_price,
    tp1_anchor_type: canonical.tp1_anchor_type,
    plan_status: canonical.status,
    plan_warnings: canonical.warnings,
    plan_generated_at: canonical.generated_at,
    plan_lock_id: plan_lock_id,
    screener_type: screenerType,
    ticker: ticker,
    trading_date: tradingDateRaw != null ? normalizeTradingDate(tradingDateRaw) : null
  };
}

module.exports = {
  MODE_TO_SCREENER,
  CANONICAL_PLAN_FIELDS,
  MANDATORY_PUBLIC_FIELDS,
  MANDATORY_PUBLIC_LABEL_FIELDS,
  MANDATORY_PUBLIC_WARNINGS,
  MANDATORY_REJECTION_WARNINGS,
  resolveScreenerType,
  buildLegacyTradePlan,
  buildCandidatePlanV2,
  buildPlanFromSource,
  isPlanV2Usable,
  buildProductionTrailing,
  attachShadowTradePlanV2,
  resolvePublicTradePlan,
  decorateRowsForWeb,
  selectCanonicalTradePlan,
  computePlanLockId,
  buildLockedTradePlan,
  normalizeTradingDate,
  adapters
};
