'use strict';

/**
 * Trade Plan V2 — Shared, Volatility-Aware Canonical Trade-Plan Engine
 * ====================================================================
 *
 * ONE canonical engine that computes entry, structural stop loss, take-profit
 * levels, trailing-stop rules, support-test state and resistance-test state for
 * ALL three screeners:
 *
 *   - DAY_TRADE
 *   - SWING_NON_KONGLO
 *   - SWING_KONGLO
 *
 * The SAME canonical `trade_plan_v2` object is later consumed by BOTH the
 * website and Telegram (see lib/trade-plan-v2-formatter.js) so displayed numeric
 * values can never diverge. Presentation code must NEVER recompute prices — it
 * only reads fields from this object.
 *
 * Modelling principle (IMPORTANT)
 * -------------------------------
 * This engine does NOT encode an unverifiable assumption that a "bandar"
 * intentionally hunts stops. It models only OBSERVABLE market behaviour:
 *   support pierce & reclaim, failed breakdown, confirmed breakdown, repeated
 *   resistance tests, resistance rejection, confirmed breakout, breakout retest,
 *   wick structure, ATR/volatility, and — when available — liquidity, volume,
 *   momentum and price freshness. It NEVER invents unavailable market fields.
 *
 * Determinism / safety
 * --------------------
 * Pure computation. No wall-clock reads, no Supabase, no Telegram, no cron, no
 * portfolio mutation. `generated_at` is passed in (or null) so output is
 * reproducible. This module NEVER mutates a real portfolio size — the
 * REDUCE_POSITION_SIZE result is advisory metadata only.
 *
 * All prices respect the IDX stock price fraction / tick size.
 */

const idx = require('./idx-tick-normalization');
// ADDITIVE observable diagnostics (liquidity-sweep / candle-structure / gaps).
const candleStruct = require('./trade-plan-v2-candle-structure');
const gapAreasLib = require('./trade-plan-v2-gap-areas');
const sweepLib = require('./trade-plan-v2-liquidity-sweep');

const PLAN_VERSION = 'trade-plan-v2';

// -----------------------------------------------------------------------------
// Screener profiles (initial SHADOW calibration only)
// -----------------------------------------------------------------------------
// volatility_buffer_atr : ATR multiple subtracted below the structural level
// trailing_atr_multiplier: ATR multiple used by the ratcheting trailing stop
// min_rr_to_tp1          : minimum reward:risk to realistic TP1 to accept
// risk_budget_pct        : configured max stop distance (% of entry)
// reject_stop_pct        : stop distance beyond which risk "cannot be controlled"
// tp2_r_multiple         : documented R-multiple fallback for TP2
const SCREENER_PROFILES = Object.freeze({
  DAY_TRADE: Object.freeze({
    screener_type: 'DAY_TRADE',
    volatility_buffer_atr: 0.50,
    trailing_atr_multiplier: 1.00,
    min_rr_to_tp1: 1.00,
    risk_budget_pct: 4.0,
    reject_stop_pct: 7.0,
    max_structural_distance_pct: 12.0,
    emergency_max_structural_distance_pct: 30.0,
    tp1_target_r: 1.15,
    tp2_r_multiple: 2.0
  }),
  SWING_NON_KONGLO: Object.freeze({
    screener_type: 'SWING_NON_KONGLO',
    volatility_buffer_atr: 0.75,
    trailing_atr_multiplier: 1.50,
    min_rr_to_tp1: 1.20,
    risk_budget_pct: 8.0,
    reject_stop_pct: 14.0,
    max_structural_distance_pct: 18.0,
    emergency_max_structural_distance_pct: 35.0,
    tp1_target_r: 1.35,
    tp2_r_multiple: 2.0
  }),
  SWING_KONGLO: Object.freeze({
    screener_type: 'SWING_KONGLO',
    volatility_buffer_atr: 1.00,
    trailing_atr_multiplier: 2.00,
    min_rr_to_tp1: 1.20,
    risk_budget_pct: 10.0,
    reject_stop_pct: 16.0,
    max_structural_distance_pct: 22.0,
    emergency_max_structural_distance_pct: 40.0,
    tp1_target_r: 1.35,
    tp2_r_multiple: 2.0
  })
});

// Day-Trade experimental executable-candidate rule (preserved from the shadow
// backtest — this engine does NOT recompute base scores, only checks the gate).
const DAY_TRADE_CANDIDATE_RULE = Object.freeze({
  confirmation_state: 'CONFIRMED',
  confirmed_rank: 1,
  min_shadow_score: 16
});

const MIN_TICK_BUFFER = 2;          // volatility buffer must be >= 2 valid ticks
const EMERGENCY_TICK_BUFFER = 4;    // emergency buffer is deliberately deeper
const TP1_ATR_BUFFER = 0.20;        // obstacle cap sits below resistance by max(1 tick, 0.20 ATR)
const RESISTANCE_TEST_ATR_TOL = 0.25; // volatility-aware resistance/support test tolerance
const EXTENDED_FROM_SUPPORT_ATR = 3.0; // entry > this many ATR above support => extended
const HARD_MIN_RR = 1.0;            // reward below risk => reject regardless of profile

const SUPPORT_ANCHOR_TYPE = Object.freeze({
  LOCAL_SUPPORT: 'LOCAL_SUPPORT',
  CONFIRMED_SWING_LOW: 'CONFIRMED_SWING_LOW',
  DEMAND_GAP_INVALIDATION: 'DEMAND_GAP_INVALIDATION',
  MAJOR_SUPPORT: 'MAJOR_SUPPORT',
  EMERGENCY_SUPPORT: 'EMERGENCY_SUPPORT'
});

const RESISTANCE_ANCHOR_TYPE = Object.freeze({
  LOCAL_RESISTANCE: 'LOCAL_RESISTANCE',
  NEXT_RESISTANCE: 'NEXT_RESISTANCE',
  MAJOR_RESISTANCE: 'MAJOR_RESISTANCE',
  SUPPLY_GAP: 'SUPPLY_GAP'
});

const STATUS = Object.freeze({
  OK: 'OK',
  WARNING: 'WARNING',
  REDUCE_POSITION_SIZE: 'REDUCE_POSITION_SIZE',
  REJECTED: 'REJECTED'
});

const WARN = Object.freeze({
  REDUCE_POSITION_SIZE: 'REDUCE_POSITION_SIZE',
  STOP_DISTANCE_EXCEEDS_RISK_BUDGET: 'STOP_DISTANCE_EXCEEDS_RISK_BUDGET',
  ENTRY_EXTENDED_FROM_SUPPORT: 'ENTRY_EXTENDED_FROM_SUPPORT',
  ENTRY_TOO_CLOSE_TO_RESISTANCE: 'ENTRY_TOO_CLOSE_TO_RESISTANCE',
  INSUFFICIENT_RR_TO_TP1: 'INSUFFICIENT_RR_TO_TP1',
  STALE_DATA: 'STALE_DATA',
  NO_VALID_ENTRY_PRICE: 'NO_VALID_ENTRY_PRICE',
  NO_STRUCTURAL_LEVEL: 'NO_STRUCTURAL_LEVEL',
  NO_RESISTANCE_TP1_UNAVAILABLE: 'NO_RESISTANCE_TP1_UNAVAILABLE',
  TP2_REQUIRES_BREAKOUT_CONFIRMATION: 'TP2_REQUIRES_BREAKOUT_CONFIRMATION',
  RISK_CANNOT_BE_CONTROLLED: 'RISK_CANNOT_BE_CONTROLLED'
});

// Support-test states.
const SUPPORT_STATE = Object.freeze({
  HOLDING: 'SUPPORT_HOLDING',
  TEST_RECLAIMED: 'SUPPORT_TEST_RECLAIMED',
  WEAKENING: 'SUPPORT_WEAKENING',
  BREAKDOWN_PENDING: 'BREAKDOWN_PENDING_CONFIRMATION',
  BREAKDOWN_CONFIRMED: 'BREAKDOWN_CONFIRMED',
  UNKNOWN: 'SUPPORT_STATE_UNKNOWN'
});

// Resistance-test states.
const RESISTANCE_STATE = Object.freeze({
  APPROACHING: 'APPROACHING_RESISTANCE',
  TEST_1: 'RESISTANCE_TEST_1',
  TEST_2: 'RESISTANCE_TEST_2',
  TEST_3_PLUS: 'RESISTANCE_TEST_3_PLUS',
  REJECTION: 'RESISTANCE_REJECTION',
  BREAKOUT_PENDING: 'BREAKOUT_PENDING_CONFIRMATION',
  BREAKOUT_CONFIRMED: 'BREAKOUT_CONFIRMED',
  BREAKOUT_RETEST_HELD: 'BREAKOUT_RETEST_HELD',
  BREAKOUT_FAILED: 'BREAKOUT_FAILED',
  UNKNOWN: 'RESISTANCE_STATE_UNKNOWN'
});

// -----------------------------------------------------------------------------
// Numeric helpers
// -----------------------------------------------------------------------------
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function firstNum(obj, keys) {
  if (!obj) return null;
  for (const k of keys) {
    const n = num(obj[k]);
    if (n !== null) return n;
  }
  return null;
}

function round2(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function round4(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

/** Round a price to a valid IDX tick (defaults to nearest). Returns null when invalid. */
function tick(price, mode) {
  const r = idx.roundToIdxTick(price, mode || 'nearest');
  return Number.isFinite(r) ? r : null;
}

function normalizeScreenerType(value) {
  const s = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (s.indexOf('DAY') >= 0) return 'DAY_TRADE';
  if (s.indexOf('NON') >= 0 && s.indexOf('KONGLO') >= 0) return 'SWING_NON_KONGLO';
  if (s.indexOf('KONGLO') >= 0) return 'SWING_KONGLO';
  if (s === 'SWING' || s === 'SWING_KONGLO') return 'SWING_KONGLO';
  return null;
}

function getProfile(screenerType) {
  const key = normalizeScreenerType(screenerType);
  return key ? SCREENER_PROFILES[key] : null;
}

/**
 * Normalise a recent-observations array into ordered bars {open,high,low,close}.
 * Oldest first, newest last. Non-finite closes are dropped. Never fabricates
 * missing OHLC — a bar with only a close still counts (high/low fall back to close).
 */
function normalizeObservations(observations) {
  if (!Array.isArray(observations)) return [];
  const out = [];
  for (const o of observations) {
    if (o == null) continue;
    if (typeof o === 'number') {
      const c = num(o);
      if (c === null) continue;
      out.push({ open: c, high: c, low: c, close: c });
      continue;
    }
    const close = firstNum(o, ['close', 'c', 'last', 'price', 'current_price']);
    if (close === null) continue;
    const high = firstNum(o, ['high', 'h']);
    const low = firstNum(o, ['low', 'l']);
    const open = firstNum(o, ['open', 'o']);
    out.push({
      open: open === null ? close : open,
      high: high === null ? close : high,
      low: low === null ? close : low,
      close
    });
  }
  return out;
}

function isStale(candidate, options) {
  if (options && options.dataFresh === true) return false;
  if (options && options.stale === true) return true;
  const txt = [
    candidate && candidate.data_stale ? 'stale' : '',
    candidate && candidate.is_stale ? 'stale' : '',
    candidate && candidate.freshness_is_stale ? 'stale' : '',
    candidate && candidate.stale_label,
    candidate && candidate.freshness_label,
    candidate && candidate.freshness && candidate.freshness.is_stale ? 'stale' : ''
  ].filter(Boolean).join(' ').toLowerCase();
  return txt.indexOf('stale') >= 0;
}

// -----------------------------------------------------------------------------
// Support-test logic (observable only)
// -----------------------------------------------------------------------------
/**
 * Detect the support-test state from recent observations.
 *
 * A temporary low BELOW support is NOT a confirmed breakdown when price
 * closes/reclaims back ABOVE support (pierce & reclaim => SUPPORT_TEST_RECLAIMED).
 *
 * Confirmed breakdown requires a documented rule:
 *   - two consecutive valid closes below buffered support, OR
 *   - one close below buffered support AND an explicit confirmation flag.
 *
 * @param {object} p { support, bufferedSupport, tolerance, observations }
 */
function deriveSupportTestState(p) {
  p = p || {};
  const support = num(p.support);
  const bars = normalizeObservations(p.observations);
  if (support === null || !bars.length) {
    return { support_test_state: SUPPORT_STATE.UNKNOWN, support_tests: 0, consecutive_closes_below: 0, reason: 'insufficient support/observation data' };
  }
  const tol = num(p.tolerance) != null && p.tolerance >= 0 ? num(p.tolerance) : 0;
  const buffered = num(p.bufferedSupport) != null ? num(p.bufferedSupport) : (support - tol);
  const last = bars[bars.length - 1];

  // Consecutive closes below buffered support, counted from the newest bar.
  let consecBelow = 0;
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].close < buffered) consecBelow++;
    else break;
  }

  // Number of pierces into/below the support band (low <= support + tolerance).
  let tests = 0;
  for (const b of bars) {
    if (b.low <= support + tol) tests++;
  }

  const explicitConfirm = p.breakdown_confirmed === true;

  let state;
  let reason;
  if (consecBelow >= 2 || (consecBelow >= 1 && explicitConfirm)) {
    state = SUPPORT_STATE.BREAKDOWN_CONFIRMED;
    reason = explicitConfirm && consecBelow < 2
      ? 'close below buffered support with explicit confirmation'
      : consecBelow + ' consecutive closes below buffered support';
  } else if (last.close < buffered) {
    state = SUPPORT_STATE.BREAKDOWN_PENDING;
    reason = 'one close below buffered support — awaiting a second confirming observation';
  } else if (last.low < support && last.close >= support) {
    state = SUPPORT_STATE.TEST_RECLAIMED;
    reason = 'low pierced support but close reclaimed above it (failed breakdown)';
  } else if (tests >= 2 && last.low <= support + tol) {
    state = SUPPORT_STATE.WEAKENING;
    reason = tests + ' repeated tests of support with price sitting on the level';
  } else {
    state = SUPPORT_STATE.HOLDING;
    reason = 'price holding above support';
  }

  return { support_test_state: state, support_tests: tests, consecutive_closes_below: consecBelow, reason };
}

// -----------------------------------------------------------------------------
// Resistance-test logic (observable only, volatility-aware tolerance)
// -----------------------------------------------------------------------------
/**
 * Detect the resistance-test state from recent observations using a
 * volatility-aware tolerance. Uses wick / close-location / momentum / volume
 * ONLY when those fields are present on the observations.
 *
 * @param {object} p { resistance, tolerance, observations, breakout_confirmed }
 */
function deriveResistanceTestState(p) {
  p = p || {};
  const resistance = num(p.resistance);
  const bars = normalizeObservations(p.observations);
  if (resistance === null || !bars.length) {
    return { resistance_test_state: RESISTANCE_STATE.UNKNOWN, resistance_tests: 0, consecutive_closes_above: 0, reason: 'insufficient resistance/observation data' };
  }
  const tol = num(p.tolerance) != null && p.tolerance >= 0 ? num(p.tolerance) : 0;
  const last = bars[bars.length - 1];

  // A "test" = a bar whose high reached the resistance band but whose close
  // failed to close above resistance (rejection at the level).
  let tests = 0;
  for (const b of bars) {
    if (b.high >= resistance - tol && b.close <= resistance) tests++;
  }

  // Consecutive closes strictly above resistance from the newest bar.
  let consecAbove = 0;
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].close > resistance) consecAbove++;
    else break;
  }
  const everClosedAbove = bars.some((b) => b.close > resistance);
  const explicitConfirm = p.breakout_confirmed === true;

  // Rejection wick on the last bar: pierced above but closed in the lower part
  // of its range (only computed when a real range exists).
  const lastRange = last.high - last.low;
  const lastClosePos = lastRange > 0 ? (last.close - last.low) / lastRange : null;
  const rejectionWick = last.high > resistance && last.close <= resistance &&
    (lastClosePos === null || lastClosePos < 0.5);

  let state;
  let reason;
  if (consecAbove >= 2 || (consecAbove >= 1 && explicitConfirm)) {
    state = RESISTANCE_STATE.BREAKOUT_CONFIRMED;
    reason = explicitConfirm && consecAbove < 2
      ? 'close above resistance with explicit confirmation'
      : consecAbove + ' consecutive closes above resistance';
  } else if (last.close > resistance) {
    state = RESISTANCE_STATE.BREAKOUT_PENDING;
    reason = 'one close above resistance — awaiting a confirming observation';
  } else if (everClosedAbove && last.close >= resistance - tol) {
    state = RESISTANCE_STATE.BREAKOUT_RETEST_HELD;
    reason = 'pulled back to a prior breakout level and held on the retest';
  } else if (everClosedAbove && last.close < resistance - tol) {
    state = RESISTANCE_STATE.BREAKOUT_FAILED;
    reason = 'closed back below resistance after a prior breakout (failed breakout)';
  } else if (rejectionWick) {
    state = RESISTANCE_STATE.REJECTION;
    reason = 'upper-wick rejection at resistance (pierced high, weak close)';
  } else if (tests >= 3) {
    state = RESISTANCE_STATE.TEST_3_PLUS;
    reason = tests + ' tests of resistance without a confirmed breakout';
  } else if (tests === 2) {
    state = RESISTANCE_STATE.TEST_2;
    reason = 'second test of resistance';
  } else if (tests === 1) {
    state = RESISTANCE_STATE.TEST_1;
    reason = 'first test of resistance';
  } else if (last.high >= resistance - Math.max(tol, resistance * 0.005)) {
    state = RESISTANCE_STATE.APPROACHING;
    reason = 'price approaching resistance but not yet testing it';
  } else {
    state = RESISTANCE_STATE.APPROACHING;
    reason = 'price below resistance';
  }

  return { resistance_test_state: state, resistance_tests: tests, consecutive_closes_above: consecAbove, reason };
}

// -----------------------------------------------------------------------------
// Trailing-stop logic (ratcheting, non-decreasing)
// -----------------------------------------------------------------------------
/**
 * Compute the next ratcheting trailing stop. Activates ONLY after price has
 * reached at least +1R OR TP1. Never lowers an already-raised trailing stop.
 *
 * newStop = max( highestClose - atr*mult,
 *                latestSwingLow - swingBuffer,
 *                priorTrailingStop )   [ratchet]
 *
 * Uses highest CLOSE (not a transient intrabar high) when available.
 *
 * @param {object} p { entry, riskAmount, tp1, activationPrice, currentPrice,
 *                      highestClose, atr, atrMultiplier, latestSwingLow,
 *                      swingBuffer, priorTrailingStop }
 * @returns {object} { active, trailing_stop, basis, reason }
 */
function computeTrailingStop(p) {
  p = p || {};
  const entry = num(p.entry);
  const riskAmount = num(p.riskAmount);
  const tp1 = num(p.tp1);
  const currentPrice = num(p.currentPrice);
  const highestClose = num(p.highestClose);
  const atr = num(p.atr);
  const mult = num(p.atrMultiplier);
  const latestSwingLow = num(p.latestSwingLow);
  const swingBuffer = num(p.swingBuffer) != null ? num(p.swingBuffer) : 0;
  const prior = num(p.priorTrailingStop);

  // Activation price: +1R or TP1, whichever comes first (lower price).
  let activationPrice = num(p.activationPrice);
  if (activationPrice === null) {
    const oneR = (entry !== null && riskAmount !== null) ? entry + riskAmount : null;
    if (oneR !== null && tp1 !== null) activationPrice = Math.min(oneR, tp1);
    else activationPrice = oneR !== null ? oneR : tp1;
  }

  const reached = currentPrice !== null && activationPrice !== null && currentPrice >= activationPrice;
  if (!reached) {
    return {
      active: false,
      trailing_stop: prior !== null ? prior : null,
      activation_price: activationPrice !== null ? tick(activationPrice, 'nearest') : null,
      basis: 'not_activated',
      reason: 'trailing not activated — price has not reached +1R or TP1'
    };
  }

  const candidates = [];
  if (highestClose !== null && atr !== null && mult !== null) {
    candidates.push({ value: highestClose - atr * mult, basis: 'highest_close_minus_atr' });
  }
  if (latestSwingLow !== null) {
    candidates.push({ value: latestSwingLow - swingBuffer, basis: 'latest_swing_low_minus_buffer' });
  }
  if (!candidates.length) {
    return {
      active: true,
      trailing_stop: prior !== null ? prior : null,
      activation_price: tick(activationPrice, 'nearest'),
      basis: 'no_trailing_inputs',
      reason: 'trailing active but no highest-close/swing-low inputs available'
    };
  }

  // Highest of the candidate stops (tightest protective, still below price).
  let best = candidates[0];
  for (const c of candidates) if (c.value > best.value) best = c;
  let raw = best.value;
  let basis = best.basis;

  // Ratchet: never below the prior trailing stop.
  if (prior !== null && prior > raw) {
    raw = prior;
    basis = 'ratchet_hold_prior';
  }

  const trailing = tick(raw, 'floor');
  return {
    active: true,
    trailing_stop: trailing,
    activation_price: tick(activationPrice, 'nearest'),
    basis,
    reason: 'trailing active; ratcheting stop = ' + basis + ' (never lowered)'
  };
}

// -----------------------------------------------------------------------------
// Day-Trade experimental candidate gate (does NOT recompute base scores)
// -----------------------------------------------------------------------------
/**
 * Evaluate the preserved Day-Trade experimental candidate rule against an
 * already-computed shadow row. Pure gate check — no scoring re-derivation.
 */
function evaluateDayTradeCandidateRule(row, opts) {
  opts = opts || {};
  const minScore = num(opts.minScore) != null ? num(opts.minScore) : DAY_TRADE_CANDIDATE_RULE.min_shadow_score;
  row = row || {};
  const state = String(row.confirmation_state || '').trim().toUpperCase();
  const rank = num(row.confirmed_rank);
  const score = num(row.shadow_score);
  const reasons = [];
  let eligible = true;
  if (state !== DAY_TRADE_CANDIDATE_RULE.confirmation_state) { eligible = false; reasons.push('confirmation_state != CONFIRMED'); }
  if (rank !== DAY_TRADE_CANDIDATE_RULE.confirmed_rank) { eligible = false; reasons.push('confirmed_rank != 1'); }
  if (!(score !== null && score >= minScore)) { eligible = false; reasons.push('shadow_score < ' + minScore); }
  return {
    eligible,
    confirmation_state: state || null,
    confirmed_rank: rank,
    shadow_score: score,
    min_shadow_score: minScore,
    executable_only_next_snapshot: true,
    max_one_per_day: true,
    reasons: eligible ? ['CONFIRMED rank-1 with shadow_score >= ' + minScore] : reasons
  };
}

// -----------------------------------------------------------------------------
// Structural-level hierarchy helpers
// -----------------------------------------------------------------------------
function normalizedAnchorType(raw) {
  return raw == null ? null : String(raw).trim().toUpperCase().replace(/[\s-]+/g, '_');
}

function normalizeStructuralLevel(raw, type, source) {
  if (raw === null || raw === undefined || raw === '') return null;
  const object = raw && typeof raw === 'object' ? raw : null;
  const value = num(object
    ? firstNum(object, ['price', 'level', 'value', 'support', 'resistance', 'low', 'gap_low'])
    : raw);
  if (value === null) return null;
  const explicitType = object && (object.anchor_type || object.level_type || object.type);
  return {
    value,
    type: explicitType ? normalizedAnchorType(explicitType) : type,
    source,
    confirmed: object && object.confirmed === false ? false : true,
    defended: object && object.defended === false ? false : true,
    stale: object && object.stale === true,
    failed: object && (object.failed === true || object.active === false),
    valid: object && object.valid === false ? false : true
  };
}

function addStructuralLevels(out, raw, type, source) {
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const level = normalizeStructuralLevel(item, type, source);
      if (level) out.push(level);
    }
    return;
  }
  const level = normalizeStructuralLevel(raw, type, source);
  if (level) out.push(level);
}

function structuralDistancePct(entryLow, level) {
  return entryLow > 0 ? ((entryLow - level) / entryLow) * 100 : Infinity;
}

function isUsableStructuralLevel(level, entryLow, maxDistancePct) {
  return !!(level && level.valid && level.confirmed && level.defended &&
    !level.stale && !level.failed && level.value <= entryLow &&
    structuralDistancePct(entryLow, level.value) <= maxDistancePct);
}

// Emergency structure is diagnostic protection, not a normal-risk anchor. Keep
// a valid major/emergency level even when it is too distant for the profile's
// normal structural-distance budget; the public plan may still fall back to
// legacy when no acceptable normal anchor exists.
function isUsableEmergencyStructuralLevel(level, entryLow) {
  return !!(level && level.valid && level.confirmed && level.defended &&
    !level.stale && !level.failed && level.value < entryLow);
}

function chooseNearestLevel(levels) {
  let selected = null;
  for (const level of levels) {
    if (!selected || level.value > selected.value) selected = level;
  }
  return selected;
}

function chooseDeepestLevel(levels) {
  let selected = null;
  for (const level of levels) {
    if (!selected || level.value < selected.value) selected = level;
  }
  return selected;
}

function normalizeOverheadLevel(raw, type, source) {
  const level = normalizeStructuralLevel(raw, type, source);
  if (!level) return null;
  level.value = num(level.value);
  return level;
}

function isUsableOverheadLevel(level, entryHigh, tolerance) {
  return !!(level && level.valid && level.confirmed && level.defended &&
    !level.stale && !level.failed && level.value > entryHigh);
}

function chooseNearestOverhead(levels) {
  let selected = null;
  for (const level of levels) {
    if (!selected || level.value < selected.value) selected = level;
  }
  return selected;
}

// -----------------------------------------------------------------------------
// Canonical trade-plan builder
// -----------------------------------------------------------------------------
/**
 * Build the canonical trade_plan_v2 object for one long candidate.
 *
 * @param {object} candidate  base-screener output (entry_low/entry_high, support,
 *                            resistance, atr14, swing_low, current_price, volume,
 *                            momentum, freshness, ...). Existing base formulas are
 *                            preserved — entry zone is taken from the candidate.
 * @param {object} options
 *   screener_type   required — DAY_TRADE | SWING_NON_KONGLO | SWING_KONGLO
 *   generated_at    optional — ISO string (deterministic; never wall-clock here)
 *   observations    optional — recent bars for support/resistance-test detection
 *   next_resistance optional — the next valid resistance for TP2
 *   breakdown_confirmed / breakout_confirmed — optional observable confirmations
 * @returns {object} canonical trade_plan_v2 (always includes plan_version + status)
 */
function buildTradePlanV2(candidate, options) {
  candidate = candidate || {};
  options = options || {};
  const screenerType = normalizeScreenerType(options.screener_type || candidate.screener_type || candidate.mode || candidate.category);
  const profile = screenerType ? SCREENER_PROFILES[screenerType] : null;
  const warnings = [];
  const generatedAt = options.generated_at != null ? options.generated_at
    : (candidate.generated_at != null ? candidate.generated_at : null);
  const ticker = String(candidate.ticker || options.ticker || '').trim().toUpperCase() || null;

  function base(extra) {
    return Object.assign({
      plan_version: PLAN_VERSION,
      screener_type: screenerType,
      ticker,
      generated_at: generatedAt,
      entry_zone_low: null,
      entry_zone_high: null,
      entry_trigger: null,
      entry_reason: null,
      support: null,
      support_source: null,
      resistance: null,
      resistance_source: null,
      stop_loss: null,
      stop_loss_reason: null,
      stop_anchor_type: null,
      stop_anchor_price: null,
      structural_invalidation: null,
      emergency_stop: null,
      emergency_anchor_type: null,
      emergency_anchor_price: null,
      stop_distance_pct: null,
      tp1: null,
      tp1_anchor_type: null,
      tp1_target_r: null,
      minimum_rr_to_tp1: profile ? profile.min_rr_to_tp1 : null,
      tp1_reason: null,
      nearest_local_resistance: null,
      tp2: null,
      tp2_anchor_type: null,
      major_resistance: null,
      tp2_reason: null,
      trailing_activation: null,
      trailing_method: null,
      trailing_atr_multiplier: profile ? profile.trailing_atr_multiplier : null,
      risk_amount: null,
      reward_to_tp1: null,
      reward_to_tp2: null,
      rr_to_tp1: null,
      rr_to_tp2: null,
      support_test_state: null,
      resistance_test_state: null,
      warnings,
      data_freshness: null,
      status: STATUS.OK,
      reject_reason: null,
      profile: profile ? Object.assign({}, profile) : null,
      // --- ADDITIVE liquidity-sweep / candle-structure / gap-area schema ---
      trailing_sweep_state: null,
      trailing_reference: null,
      common_trailing_zones: null,
      trailing_zone_events: [],
      candle_structure: null,
      active_gap_areas: [],
      nearest_demand_gap: null,
      nearest_supply_gap: null,
      liquidity_sweep_evidence: null,
      structure_confirmation_required: false,
      soft_exit_state: null,
      hard_exit_state: null
    }, extra || {});
  }

  if (!profile) {
    return base({ status: STATUS.REJECTED, reject_reason: 'UNKNOWN_SCREENER_TYPE' });
  }

  // --- Data freshness -------------------------------------------------------
  const stale = isStale(candidate, options);
  const dataFreshness = {
    is_stale: stale,
    label: stale ? 'STALE' : 'FRESH',
    source: candidate.freshness && candidate.freshness.provider ? candidate.freshness.provider : (candidate.freshness_source || null)
  };
  if (stale) warnings.push(WARN.STALE_DATA);

  // --- Entry (preserve base screener formulas) ------------------------------
  let entryLow = firstNum(candidate, ['entry_low', 'entry1', 'entry_1']);
  let entryHigh = firstNum(candidate, ['entry_high', 'entry2', 'entry_2']);
  const currentPrice = firstNum(candidate, ['current_price', 'last_price', 'lastn', 'close', 'reference_entry_price']);
  if (entryLow !== null && entryHigh !== null && entryLow > entryHigh) {
    const t = entryLow; entryLow = entryHigh; entryHigh = t;
  }
  if (entryLow === null && entryHigh === null && currentPrice !== null) {
    entryLow = currentPrice;
    entryHigh = currentPrice;
  }
  entryLow = entryLow !== null ? tick(entryLow, 'nearest') : null;
  entryHigh = entryHigh !== null ? tick(entryHigh, 'nearest') : null;
  const entryRef = entryHigh !== null ? entryHigh : (entryLow !== null ? entryLow : (currentPrice !== null ? tick(currentPrice, 'nearest') : null));

  if (entryRef === null) {
    warnings.push(WARN.NO_VALID_ENTRY_PRICE);
    return base({
      status: STATUS.REJECTED,
      reject_reason: WARN.NO_VALID_ENTRY_PRICE,
      data_freshness: dataFreshness,
      entry_zone_low: entryLow,
      entry_zone_high: entryHigh
    });
  }

  const entryTrigger = firstNum(candidate, ['breakout_trigger', 'trigger_price', 'reclaim_level']);
  const entryTriggerLevel = entryTrigger !== null ? tick(entryTrigger, 'ceil') : entryHigh;

  // --- Support / resistance -------------------------------------------------
  const rawSupport = firstNum(candidate, ['support', 'support1', 's1']);
  const rawResistance = firstNum(candidate, ['resistance', 'resistance1', 'r1']);
  const atr = firstNum(candidate, ['atr14', 'atr', 'average_true_range']);
  const tickSize = idx.getIdxTickSize(entryRef) || 1;

  // Keep the old scalar fields as fallbacks, but do not assume that the
  // numerically lowest support or the most distant resistance is the useful
  // trading level. Explicit hierarchy fields take precedence when present.
  const supportLevels = [];
  function collectSupport(raw, type, source) { addStructuralLevels(supportLevels, raw, type, source); }
  collectSupport(candidate.local_support, SUPPORT_ANCHOR_TYPE.LOCAL_SUPPORT, 'local_support');
  collectSupport(candidate.local_supports, SUPPORT_ANCHOR_TYPE.LOCAL_SUPPORT, 'local_supports');
  collectSupport(candidate.nearest_local_support, SUPPORT_ANCHOR_TYPE.LOCAL_SUPPORT, 'nearest_local_support');
  collectSupport(candidate.confirmed_swing_low, SUPPORT_ANCHOR_TYPE.CONFIRMED_SWING_LOW, 'confirmed_swing_low');
  collectSupport(candidate.swing_low, SUPPORT_ANCHOR_TYPE.CONFIRMED_SWING_LOW, 'swing_low');
  collectSupport(candidate.latest_swing_low, SUPPORT_ANCHOR_TYPE.CONFIRMED_SWING_LOW, 'latest_swing_low');
  collectSupport(candidate.swing_lows, SUPPORT_ANCHOR_TYPE.CONFIRMED_SWING_LOW, 'swing_lows');
  collectSupport(candidate.swingLow5, SUPPORT_ANCHOR_TYPE.CONFIRMED_SWING_LOW, 'swingLow5');
  collectSupport(candidate.demand_gap_invalidation, SUPPORT_ANCHOR_TYPE.DEMAND_GAP_INVALIDATION, 'demand_gap_invalidation');
  collectSupport(candidate.demand_gap_invalidations, SUPPORT_ANCHOR_TYPE.DEMAND_GAP_INVALIDATION, 'demand_gap_invalidations');
  collectSupport(candidate.active_demand_gap, SUPPORT_ANCHOR_TYPE.DEMAND_GAP_INVALIDATION, 'active_demand_gap');
  if (Array.isArray(candidate.structural_levels)) {
    for (const rawLevel of candidate.structural_levels) {
      const levelType = normalizedAnchorType(rawLevel && (rawLevel.anchor_type || rawLevel.level_type || rawLevel.type));
      if (levelType === SUPPORT_ANCHOR_TYPE.LOCAL_SUPPORT || levelType === SUPPORT_ANCHOR_TYPE.CONFIRMED_SWING_LOW ||
          levelType === SUPPORT_ANCHOR_TYPE.MAJOR_SUPPORT || levelType === SUPPORT_ANCHOR_TYPE.EMERGENCY_SUPPORT) {
        collectSupport(rawLevel, String(levelType).toUpperCase(), 'structural_levels');
      }
    }
  }
  collectSupport(candidate.major_support, SUPPORT_ANCHOR_TYPE.MAJOR_SUPPORT, 'major_support');
  collectSupport(candidate.major_supports, SUPPORT_ANCHOR_TYPE.MAJOR_SUPPORT, 'major_supports');
  collectSupport(candidate.emergency_support, SUPPORT_ANCHOR_TYPE.EMERGENCY_SUPPORT, 'emergency_support');
  collectSupport(candidate.emergency_supports, SUPPORT_ANCHOR_TYPE.EMERGENCY_SUPPORT, 'emergency_supports');
  // A legacy scalar support is a major/reference level unless an explicit
  // local support was supplied. This is what prevents a distant 20-day low
  // from displacing a recent confirmed swing low.
  if (rawSupport !== null) collectSupport(rawSupport, SUPPORT_ANCHOR_TYPE.MAJOR_SUPPORT, 'base_screener_support');

  const rawSwingLow = firstNum(candidate, ['swing_low', 'latest_swing_low', 'confirmed_swing_low', 'swingLow5']);
  const rawMajorSupport = firstNum(candidate, ['major_support', 'support', 'support1', 's1']);
  const rawEmergencySupport = firstNum(candidate, ['emergency_support']);

  const overheadLevels = [];
  function collectOverhead(raw, type, source) {
    if (Array.isArray(raw)) {
      for (const item of raw) {
        const level = normalizeOverheadLevel(item, type, source);
        if (level) overheadLevels.push(level);
      }
    } else {
      const level = normalizeOverheadLevel(raw, type, source);
      if (level) overheadLevels.push(level);
    }
  }
  collectOverhead(candidate.local_resistance, RESISTANCE_ANCHOR_TYPE.LOCAL_RESISTANCE, 'local_resistance');
  collectOverhead(candidate.local_resistances, RESISTANCE_ANCHOR_TYPE.LOCAL_RESISTANCE, 'local_resistances');
  collectOverhead(candidate.nearest_local_resistance, RESISTANCE_ANCHOR_TYPE.LOCAL_RESISTANCE, 'nearest_local_resistance');
  collectOverhead(candidate.local_resistance_levels, RESISTANCE_ANCHOR_TYPE.LOCAL_RESISTANCE, 'local_resistance_levels');
  if (Array.isArray(candidate.resistance_levels)) {
    for (const rawLevel of candidate.resistance_levels) {
      const levelType = normalizedAnchorType(rawLevel && (rawLevel.anchor_type || rawLevel.level_type || rawLevel.type));
      if (levelType === RESISTANCE_ANCHOR_TYPE.LOCAL_RESISTANCE || levelType === RESISTANCE_ANCHOR_TYPE.NEXT_RESISTANCE ||
          levelType === RESISTANCE_ANCHOR_TYPE.MAJOR_RESISTANCE || levelType === RESISTANCE_ANCHOR_TYPE.SUPPLY_GAP) {
        collectOverhead(rawLevel, String(levelType).toUpperCase(), 'resistance_levels');
      }
    }
  }
  collectOverhead(options.next_resistance != null ? options.next_resistance : candidate.next_resistance,
    RESISTANCE_ANCHOR_TYPE.NEXT_RESISTANCE, 'next_resistance');
  collectOverhead(candidate.resistance2, RESISTANCE_ANCHOR_TYPE.NEXT_RESISTANCE, 'resistance2');
  collectOverhead(candidate.major_resistance, RESISTANCE_ANCHOR_TYPE.MAJOR_RESISTANCE, 'major_resistance');
  collectOverhead(candidate.major_resistances, RESISTANCE_ANCHOR_TYPE.MAJOR_RESISTANCE, 'major_resistances');
  // Backward compatibility: a lone resistance remains the nearest local
  // obstacle. Adapters can explicitly mark it as major when appropriate.
  if (rawResistance !== null && (candidate.major_resistance == null && candidate.local_resistance == null &&
      candidate.local_resistances == null && candidate.local_resistance_levels == null)) {
    collectOverhead(rawResistance, RESISTANCE_ANCHOR_TYPE.LOCAL_RESISTANCE, 'base_screener_resistance');
  } else if (rawResistance !== null) {
    collectOverhead(rawResistance, RESISTANCE_ANCHOR_TYPE.MAJOR_RESISTANCE, 'base_screener_resistance');
  }

  const support = rawSupport !== null ? tick(rawSupport, 'floor') : null;
  const resistanceTolerance = Math.max(tickSize, atr !== null ? RESISTANCE_TEST_ATR_TOL * atr : 0);
  const validNearbySupports = supportLevels.filter((level) =>
    [SUPPORT_ANCHOR_TYPE.LOCAL_SUPPORT, SUPPORT_ANCHOR_TYPE.CONFIRMED_SWING_LOW, SUPPORT_ANCHOR_TYPE.DEMAND_GAP_INVALIDATION]
      .includes(level.type) && isUsableStructuralLevel(level, entryLow, profile.max_structural_distance_pct));
  const validMajorSupports = supportLevels.filter((level) =>
    [SUPPORT_ANCHOR_TYPE.MAJOR_SUPPORT, SUPPORT_ANCHOR_TYPE.EMERGENCY_SUPPORT]
      .includes(level.type) && isUsableStructuralLevel(level, entryLow, profile.max_structural_distance_pct));
  let normalSupportCandidate = chooseNearestLevel(validNearbySupports.length ? validNearbySupports : validMajorSupports);
  let supportSource = normalSupportCandidate ? normalSupportCandidate.type : null;

  let resistanceCandidates = overheadLevels.filter((level) =>
    isUsableOverheadLevel(level, entryHigh, resistanceTolerance));
  let nearestResistanceCandidate = chooseNearestOverhead(resistanceCandidates);
  let resistance = nearestResistanceCandidate ? tick(nearestResistanceCandidate.value, 'ceil') : null;
  let resistanceSource = nearestResistanceCandidate ? nearestResistanceCandidate.source : null;
  let majorResistanceCandidate = chooseNearestOverhead(resistanceCandidates.filter((level) =>
    level.type === RESISTANCE_ANCHOR_TYPE.MAJOR_RESISTANCE));
  let nearestLocalResistance = chooseNearestOverhead(resistanceCandidates.filter((level) =>
    level.type === RESISTANCE_ANCHOR_TYPE.LOCAL_RESISTANCE));
  let majorResistance = majorResistanceCandidate ? tick(majorResistanceCandidate.value, 'ceil') : null;
  let nextResistanceCandidate = nearestResistanceCandidate
    ? chooseNearestOverhead(resistanceCandidates.filter((level) =>
      level !== nearestResistanceCandidate && level.value > nearestResistanceCandidate.value))
    : null;
  // Preserves ALL existing gap logic — this only builds the NEW canonical
  // active-gap contract from gap inputs the caller already has. When no gap data
  // is supplied, this is inert and every existing field stays byte-identical.
  const rawGaps = Array.isArray(options.gaps) ? options.gaps
    : (Array.isArray(candidate.gaps) ? candidate.gaps : []);
  const gapAreas = gapAreasLib.buildActiveGapAreas({
    gaps: rawGaps,
    currentPrice: currentPrice,
    entry: entryRef,
    observations: options.observations
  });
  const nearestDemandGap = gapAreas.nearest_demand_gap;
  const nearestSupplyGap = gapAreas.nearest_supply_gap;
  const supplyGapBlocksEntry = !!(nearestSupplyGap && nearestSupplyGap.active &&
    nearestSupplyGap.gap_low != null && nearestSupplyGap.gap_high != null &&
    nearestSupplyGap.gap_low <= entryLow + resistanceTolerance && nearestSupplyGap.gap_high >= entryLow);

  // Active gaps are structural levels too: a demand gap invalidates below its
  // lower edge, while a supply gap is an overhead obstacle at its lower edge.
  if (nearestDemandGap && nearestDemandGap.active && nearestDemandGap.gap_low != null) {
    const demandLevel = normalizeStructuralLevel({
      price: nearestDemandGap.gap_low,
      confirmed: true,
      defended: true,
      stale: false,
      failed: nearestDemandGap.gap_status === gapAreasLib.GAP_STATE.GAP_FAILED
    }, SUPPORT_ANCHOR_TYPE.DEMAND_GAP_INVALIDATION, 'active_demand_gap_invalidation');
    if (demandLevel) supportLevels.push(demandLevel);
  }
  if (nearestSupplyGap && nearestSupplyGap.active && nearestSupplyGap.gap_low != null) {
    const supplyLevel = normalizeOverheadLevel({ price: nearestSupplyGap.gap_low }, RESISTANCE_ANCHOR_TYPE.SUPPLY_GAP, 'active_supply_gap');
    if (supplyLevel) overheadLevels.push(supplyLevel);
  }

  const refreshedNearbySupports = supportLevels.filter((level) =>
    [SUPPORT_ANCHOR_TYPE.LOCAL_SUPPORT, SUPPORT_ANCHOR_TYPE.CONFIRMED_SWING_LOW, SUPPORT_ANCHOR_TYPE.DEMAND_GAP_INVALIDATION]
      .includes(level.type) && isUsableStructuralLevel(level, entryLow, profile.max_structural_distance_pct));
  const refreshedMajorSupports = supportLevels.filter((level) =>
    [SUPPORT_ANCHOR_TYPE.MAJOR_SUPPORT, SUPPORT_ANCHOR_TYPE.EMERGENCY_SUPPORT]
      .includes(level.type) && isUsableStructuralLevel(level, entryLow, profile.max_structural_distance_pct));
  normalSupportCandidate = chooseNearestLevel(refreshedNearbySupports.length ? refreshedNearbySupports : refreshedMajorSupports);
  supportSource = normalSupportCandidate ? normalSupportCandidate.type : null;

  // Keep valid major/emergency structure available for diagnostics even when
  // it is too distant to serve as the normal-risk anchor. This is intentionally
  // independent of the normal profile distance cap.
  const emergencyStructuralCandidates = supportLevels.filter((level) =>
    [SUPPORT_ANCHOR_TYPE.MAJOR_SUPPORT, SUPPORT_ANCHOR_TYPE.EMERGENCY_SUPPORT, SUPPORT_ANCHOR_TYPE.DEMAND_GAP_INVALIDATION].includes(level.type) &&
    isUsableEmergencyStructuralLevel(level, entryLow));
  const emergencyDiagnosticCandidate = chooseDeepestLevel(emergencyStructuralCandidates);
  const atrBuffer = atr !== null ? profile.volatility_buffer_atr * atr : 0;
  const tickFloor = MIN_TICK_BUFFER * tickSize;
  const volatilityBuffer = Math.max(atrBuffer, tickFloor);
  const emergencyBuffer = Math.max(volatilityBuffer * 2, EMERGENCY_TICK_BUFFER * tickSize);
  const emergencyDiagnosticStop = emergencyDiagnosticCandidate
    ? tick(emergencyDiagnosticCandidate.value - emergencyBuffer, 'floor') : null;

  if (!normalSupportCandidate) {
    warnings.push(WARN.NO_STRUCTURAL_LEVEL);
    return base({
      status: STATUS.REJECTED,
      reject_reason: WARN.NO_STRUCTURAL_LEVEL,
      data_freshness: dataFreshness,
      entry_zone_low: entryLow,
      entry_zone_high: entryHigh,
      entry_trigger: entryTriggerLevel,
      support, resistance: null, support_source: supportSource, resistance_source: null,
      emergency_stop: emergencyDiagnosticStop,
      emergency_anchor_type: emergencyDiagnosticCandidate ? emergencyDiagnosticCandidate.type : null,
      emergency_anchor_price: emergencyDiagnosticCandidate ? tick(emergencyDiagnosticCandidate.value, 'floor') : null
    });
  }

  resistanceCandidates = overheadLevels.filter((level) =>
    isUsableOverheadLevel(level, entryHigh, resistanceTolerance));
  nearestResistanceCandidate = chooseNearestOverhead(resistanceCandidates);
  resistance = nearestResistanceCandidate ? tick(nearestResistanceCandidate.value, 'ceil') : null;
  resistanceSource = nearestResistanceCandidate ? nearestResistanceCandidate.source : null;
  majorResistanceCandidate = chooseNearestOverhead(resistanceCandidates.filter((level) =>
    level.type === RESISTANCE_ANCHOR_TYPE.MAJOR_RESISTANCE));
  nearestLocalResistance = chooseNearestOverhead(resistanceCandidates.filter((level) =>
    level.type === RESISTANCE_ANCHOR_TYPE.LOCAL_RESISTANCE));
  majorResistance = majorResistanceCandidate ? tick(majorResistanceCandidate.value, 'ceil') : null;
  nextResistanceCandidate = nearestResistanceCandidate
    ? chooseNearestOverhead(resistanceCandidates.filter((level) =>
      level !== nearestResistanceCandidate && level.value > nearestResistanceCandidate.value))
    : null;
  // Structural stop hierarchy: normal risk and emergency protection are
  // separate anchors. The latter never replaces the former.
  const structuralLevel = normalSupportCandidate.value;
  const stopAnchor = structuralLevel;
  const stopAnchorType = normalSupportCandidate.type;
  const emergencyCandidates = supportLevels.filter((level) =>
    [SUPPORT_ANCHOR_TYPE.MAJOR_SUPPORT, SUPPORT_ANCHOR_TYPE.EMERGENCY_SUPPORT, SUPPORT_ANCHOR_TYPE.DEMAND_GAP_INVALIDATION].includes(level.type) &&
    level.value < stopAnchor && isUsableEmergencyStructuralLevel(level, entryLow));
  const emergencyAnchorCandidate = chooseDeepestLevel(emergencyCandidates) || normalSupportCandidate;
  const emergencyAnchorPrice = emergencyAnchorCandidate.value;
  const emergencyAnchorType = emergencyAnchorCandidate === normalSupportCandidate
    ? stopAnchorType : emergencyAnchorCandidate.type;

  const stopLoss = tick(stopAnchor - volatilityBuffer, 'floor');
  const structuralInvalidation = tick(structuralLevel, 'floor');
  const emergencyStop = tick(emergencyAnchorPrice - emergencyBuffer, 'floor');

  const riskAmount = (stopLoss !== null && entryRef !== null) ? round2(entryRef - stopLoss) : null;
  const stopDistancePct = (riskAmount !== null && entryRef > 0) ? round2((riskAmount / entryRef) * 100) : null;
  const anchorLabel = stopAnchorType + ' (' + stopAnchor + ')';
  const stopLossReason = atr !== null
    ? anchorLabel + ' minus ' + profile.volatility_buffer_atr + ' ATR volatility buffer (>= ' + MIN_TICK_BUFFER + ' ticks)'
    : anchorLabel + ' minus ' + MIN_TICK_BUFFER + '-tick floor buffer (ATR unavailable)';

  if (stopLoss === null || stopLoss >= entryLow) {
    return base({
      status: STATUS.REJECTED,
      reject_reason: 'STOP_NOT_BELOW_ENTRY',
      data_freshness: dataFreshness,
      entry_zone_low: entryLow, entry_zone_high: entryHigh, entry_trigger: entryTriggerLevel,
      support, resistance, support_source: supportSource, resistance_source: resistanceSource,
      stop_loss: stopLoss, stop_loss_reason: stopLossReason,
      stop_anchor_type: stopAnchorType, stop_anchor_price: tick(stopAnchor, 'floor'),
      structural_invalidation: structuralInvalidation, emergency_stop: emergencyStop,
      emergency_anchor_type: emergencyAnchorType, emergency_anchor_price: tick(emergencyAnchorPrice, 'floor'),
      stop_distance_pct: stopDistancePct, risk_amount: riskAmount
    });
  }


  // --- Take-profit ----------------------------------------------------------
  // TP1 starts from a realistic profile R target and is capped before the
  // nearest valid local resistance or active supply gap. It never jumps to a
  // distant major level merely to improve displayed reward/risk.
  let tp1 = null;
  let tp1AnchorType = null;
  let tp1TargetR = null;
  let tp1Reason = null;
  if (supplyGapBlocksEntry) {
    tp1Reason = 'active supply gap overlaps the executable entry zone — no valid TP1 room';
    warnings.push(WARN.ENTRY_TOO_CLOSE_TO_RESISTANCE);
  } else if (resistance !== null && riskAmount !== null && riskAmount > 0) {
    tp1TargetR = profile.tp1_target_r;
    const baseTp1 = tick(entryRef + tp1TargetR * riskAmount, 'floor');
    const obstacleBuffer = Math.max(tickSize, atr !== null ? TP1_ATR_BUFFER * atr : 0);
    const cappedTp1 = tick(resistance - obstacleBuffer, 'floor');
    tp1 = baseTp1;
    tp1AnchorType = 'R_TARGET';
    tp1Reason = 'realistic ' + tp1TargetR + 'R base target';
    if (cappedTp1 !== null && cappedTp1 < tp1) {
      tp1 = cappedTp1;
      tp1AnchorType = nearestResistanceCandidate.type;
      tp1Reason = nearestResistanceCandidate.type === RESISTANCE_ANCHOR_TYPE.SUPPLY_GAP
        ? 'capped before active supply gap (' + resistance + '); buffer = max(1 tick, ' + TP1_ATR_BUFFER + ' ATR)'
        : 'capped before ' + nearestResistanceCandidate.type + ' (' + resistance + '); buffer = max(1 tick, ' + TP1_ATR_BUFFER + ' ATR)';
    }
    if (tp1 === null || tp1 <= entryRef) {
      tp1 = null;
      tp1AnchorType = null;
      tp1Reason = 'nearest valid resistance is too close to entry — no valid TP1 above entry';
      warnings.push(WARN.ENTRY_TOO_CLOSE_TO_RESISTANCE);
    }
  } else {
    warnings.push(WARN.NO_RESISTANCE_TP1_UNAVAILABLE);
    tp1Reason = 'no valid resistance available — TP1 intentionally not invented';
  }

  // --- Support / resistance test states -------------------------------------
  const testTol = Math.max(tickSize, atr !== null ? RESISTANCE_TEST_ATR_TOL * atr : 0);
  const supportState = deriveSupportTestState({
    support: structuralInvalidation,
    bufferedSupport: structuralInvalidation !== null ? structuralInvalidation - testTol : null,
    tolerance: testTol,
    observations: options.observations,
    breakdown_confirmed: options.breakdown_confirmed
  });
  const resistanceState = deriveResistanceTestState({
    resistance,
    tolerance: testTol,
    observations: options.observations,
    breakout_confirmed: options.breakout_confirmed
  });

  // TP2 allowed ONLY on a confirmed breakout or a held breakout retest.
  let tp2 = null;
  let tp2AnchorType = null;
  let tp2Reason = null;
  const breakoutOk = resistanceState.resistance_test_state === RESISTANCE_STATE.BREAKOUT_CONFIRMED ||
    resistanceState.resistance_test_state === RESISTANCE_STATE.BREAKOUT_RETEST_HELD ||
    options.breakout_confirmed === true;
  if (breakoutOk) {
    if (nextResistanceCandidate && nextResistanceCandidate.value > (tp1 !== null ? tp1 : entryRef)) {
      tp2 = tick(nextResistanceCandidate.value, 'floor');
      tp2AnchorType = nextResistanceCandidate.type;
      tp2Reason = 'next/major resistance after confirmed breakout / held retest';
    } else if (riskAmount !== null) {
      tp2 = tick(entryRef + profile.tp2_r_multiple * riskAmount, 'floor');
      tp2AnchorType = 'R_TARGET';
      tp2Reason = 'documented ' + profile.tp2_r_multiple + 'R target after confirmed breakout (no next/major resistance available)';
    }
    if (tp2 !== null && tp1 !== null && tp2 < tp1) {
      tp2 = null;
      tp2AnchorType = null;
      tp2Reason = 'computed TP2 below TP1 — omitted';
    }
  } else {
    tp2Reason = 'TP2 withheld: requires a confirmed breakout or a held breakout retest';
    warnings.push(WARN.TP2_REQUIRES_BREAKOUT_CONFIRMATION);
  }

  // --- Rewards / RR ---------------------------------------------------------
  const rewardToTp1 = tp1 !== null ? round2(tp1 - entryRef) : null;
  const rewardToTp2 = tp2 !== null ? round2(tp2 - entryRef) : null;
  const rrToTp1 = (rewardToTp1 !== null && riskAmount) ? round4(rewardToTp1 / riskAmount) : null;
  const rrToTp2 = (rewardToTp2 !== null && riskAmount) ? round4(rewardToTp2 / riskAmount) : null;

  // --- Trailing -------------------------------------------------------------
  const oneR = round2(entryRef + riskAmount);
  const trailingActivation = tp1 !== null ? tick(Math.min(oneR, tp1), 'nearest') : tick(oneR, 'nearest');
  const trailingMethod = 'ratcheting_non_decreasing: max(highest_close - ' + profile.trailing_atr_multiplier +
    ' ATR, latest_swing_low - buffer); activate at +1R or TP1';

  // --- Entry-quality warnings ----------------------------------------------
  // Entry excessively extended from support (observable, ATR-based).
  if (atr !== null && atr > 0 && structuralInvalidation !== null) {
    const extAtr = (entryRef - structuralInvalidation) / atr;
    if (extAtr > EXTENDED_FROM_SUPPORT_ATR) warnings.push(WARN.ENTRY_EXTENDED_FROM_SUPPORT);
  }
  // Entry too close to resistance.
  if (resistance !== null) {
    const roomToRes = resistance - entryRef;
    const minRoom = Math.max(tickSize, atr !== null ? 0.5 * atr : 0);
    if (roomToRes < minRoom && warnings.indexOf(WARN.ENTRY_TOO_CLOSE_TO_RESISTANCE) < 0) {
      warnings.push(WARN.ENTRY_TOO_CLOSE_TO_RESISTANCE);
    }
  }

  // --- Status resolution (risk budget + RR) ---------------------------------
  let status = STATUS.OK;
  let rejectReason = null;

  // Risk budget: excessive stop distance => reduce size, or reject when
  // uncontrollable. Position size is NEVER actually mutated here.
  if (stopDistancePct !== null && stopDistancePct > profile.reject_stop_pct) {
    status = STATUS.REJECTED;
    rejectReason = WARN.RISK_CANNOT_BE_CONTROLLED;
    if (warnings.indexOf(WARN.STOP_DISTANCE_EXCEEDS_RISK_BUDGET) < 0) warnings.push(WARN.STOP_DISTANCE_EXCEEDS_RISK_BUDGET);
  } else if (stopDistancePct !== null && stopDistancePct > profile.risk_budget_pct) {
    if (warnings.indexOf(WARN.STOP_DISTANCE_EXCEEDS_RISK_BUDGET) < 0) warnings.push(WARN.STOP_DISTANCE_EXCEEDS_RISK_BUDGET);
    if (warnings.indexOf(WARN.REDUCE_POSITION_SIZE) < 0) warnings.push(WARN.REDUCE_POSITION_SIZE);
    if (status === STATUS.OK) status = STATUS.REDUCE_POSITION_SIZE;
  }

  // Reward to realistic TP1 insufficient.
  if (tp1 === null) {
    // Cannot assess RR without a TP1; keep as warning unless already rejected.
    if (status === STATUS.OK) status = STATUS.WARNING;
  } else if (rrToTp1 !== null) {
    if (rrToTp1 < HARD_MIN_RR) {
      status = STATUS.REJECTED;
      rejectReason = rejectReason || WARN.INSUFFICIENT_RR_TO_TP1;
      if (warnings.indexOf(WARN.INSUFFICIENT_RR_TO_TP1) < 0) warnings.push(WARN.INSUFFICIENT_RR_TO_TP1);
    } else if (rrToTp1 < profile.min_rr_to_tp1) {
      if (warnings.indexOf(WARN.INSUFFICIENT_RR_TO_TP1) < 0) warnings.push(WARN.INSUFFICIENT_RR_TO_TP1);
      if (status === STATUS.OK) status = STATUS.WARNING;
    }
  }

  // Stale data downgrades an otherwise-OK plan to WARNING.
  if (stale && status === STATUS.OK) status = STATUS.WARNING;
  // Any entry-quality warning downgrades OK to WARNING.
  if (status === STATUS.OK && (warnings.indexOf(WARN.ENTRY_EXTENDED_FROM_SUPPORT) >= 0 ||
      warnings.indexOf(WARN.ENTRY_TOO_CLOSE_TO_RESISTANCE) >= 0)) {
    status = STATUS.WARNING;
  }

  const entryReason = 'entry zone preserved from base ' + screenerType + ' screener; reference (fill) price = entry_zone_high';

  // --- ADDITIVE observable liquidity-sweep / candle-structure diagnostics ----
  // Computed from observations/gaps the caller already has. When no observation
  // or gap data is supplied these resolve to safe neutral defaults and do NOT
  // affect any existing numeric field.
  const barsForSweep = normalizeObservations(options.observations);
  const lastBar = barsForSweep.length ? barsForSweep[barsForSweep.length - 1] : null;
  const trailingReference = num(options.trailing_reference) != null
    ? tick(num(options.trailing_reference), 'floor')
    : stopLoss;
  const demandGapActive = !!(nearestDemandGap && nearestDemandGap.active);
  const demandGapFailed = !!(nearestDemandGap && nearestDemandGap.gap_status === gapAreasLib.GAP_STATE.GAP_FAILED);

  const commonTrailingZones = sweepLib.buildCommonTrailingZones({
    referencePrice: entryRef,
    atr: atr,
    atrMultiplier: profile.trailing_atr_multiplier
  });
  const trailingZoneEvents = sweepLib.detectTrailingZoneEvents({
    zones: commonTrailingZones.zones,
    observations: options.observations
  });
  const sweep = sweepLib.deriveTrailingSweepState({
    trailingReference,
    emergencyStop,
    structuralSupport: structuralInvalidation,
    tolerance: testTol,
    observations: options.observations,
    demandGapActive,
    demandGapFailed,
    breakdownConfirmed: options.breakdown_confirmed
  });
  const sweepEvidence = sweepLib.buildLiquiditySweepEvidence({
    trailingReference,
    emergencyStop,
    structuralSupport: structuralInvalidation,
    observations: options.observations,
    demandGapActive,
    nextObservationConfirmsBreakdown: options.next_observation_confirms_breakdown
  });
  // "Do not chase" an extended recovery candle (observable, additive advisory).
  sweepEvidence.do_not_chase_extended_recovery = !!(
    lastBar &&
    candleStruct.classifyCandle(lastBar, { resistance, referenceLevel: trailingReference }).pattern === candleStruct.CANDLE_PATTERN.FULL_BODY_BREAKOUT &&
    atr !== null && atr > 0 && structuralInvalidation !== null && (entryRef - structuralInvalidation) / atr > EXTENDED_FROM_SUPPORT_ATR
  );
  const softHard = sweepLib.resolveSoftHardExit({
    sweepState: sweep.trailing_sweep_state,
    emergencyStop,
    lastClose: lastBar ? lastBar.close : null
  });
  const candleStructure = lastBar
    ? candleStruct.classifyCandle(lastBar, { resistance, referenceLevel: trailingReference })
    : null;

  return base({
    entry_zone_low: entryLow,
    entry_zone_high: entryHigh,
    entry_trigger: entryTriggerLevel,
    entry_reason: entryReason,
    support,
    support_source: supportSource,
    resistance,
    resistance_source: resistanceSource,
    stop_loss: stopLoss,
    stop_loss_reason: stopLossReason,
    stop_anchor_type: stopAnchorType,
    stop_anchor_price: tick(stopAnchor, 'floor'),
    structural_invalidation: structuralInvalidation,
    emergency_stop: emergencyStop,
    emergency_anchor_type: emergencyAnchorType,
    emergency_anchor_price: tick(emergencyAnchorPrice, 'floor'),
    stop_distance_pct: stopDistancePct,
    tp1,
    tp1_anchor_type: tp1AnchorType,
    tp1_target_r: tp1TargetR,
    minimum_rr_to_tp1: profile.min_rr_to_tp1,
    tp1_reason: tp1Reason,
    nearest_local_resistance: nearestLocalResistance ? tick(nearestLocalResistance.value, 'ceil') : null,
    tp2,
    tp2_anchor_type: tp2AnchorType,
    major_resistance: majorResistance,
    tp2_reason: tp2Reason,
    trailing_activation: trailingActivation,
    trailing_method: trailingMethod,
    trailing_atr_multiplier: profile.trailing_atr_multiplier,
    risk_amount: riskAmount,
    reward_to_tp1: rewardToTp1,
    reward_to_tp2: rewardToTp2,
    rr_to_tp1: rrToTp1,
    rr_to_tp2: rrToTp2,
    support_test_state: supportState.support_test_state,
    resistance_test_state: resistanceState.resistance_test_state,
    data_freshness: dataFreshness,
    status,
    reject_reason: rejectReason,
    // --- ADDITIVE canonical schema (observable sweep / candle / gap) ---
    trailing_sweep_state: sweep.trailing_sweep_state,
    trailing_reference: trailingReference,
    common_trailing_zones: commonTrailingZones,
    trailing_zone_events: trailingZoneEvents,
    candle_structure: candleStructure,
    active_gap_areas: gapAreas.active_gap_areas,
    nearest_demand_gap: nearestDemandGap,
    nearest_supply_gap: nearestSupplyGap,
    liquidity_sweep_evidence: sweepEvidence,
    structure_confirmation_required: softHard.structure_confirmation_required,
    soft_exit_state: softHard.soft_exit_state,
    hard_exit_state: softHard.hard_exit_state,
    // Diagnostic detail (not part of the display contract).
    _detail: {
      volatility_buffer: round4(volatilityBuffer),
      tick_size: tickSize,
      atr: atr,
      structural_level: structuralLevel,
      stop_anchor: stopAnchor,
      stop_anchor_type: stopAnchorType,
      emergency_anchor: emergencyAnchorPrice,
      emergency_anchor_type: emergencyAnchorType,
      one_r_price: oneR,
      support_test: supportState,
      resistance_test: resistanceState,
      trailing_sweep: sweep
    }
  });
}

module.exports = {
  PLAN_VERSION,
  SCREENER_PROFILES,
  DAY_TRADE_CANDIDATE_RULE,
  MIN_TICK_BUFFER,
  EMERGENCY_TICK_BUFFER,
  TP1_ATR_BUFFER,
  SUPPORT_ANCHOR_TYPE,
  RESISTANCE_ANCHOR_TYPE,
  STATUS,
  WARN,
  SUPPORT_STATE,
  RESISTANCE_STATE,
  // ADDITIVE observable-diagnostic state enums (re-exported for convenience)
  TRAILING_SWEEP_STATE: sweepLib.TRAILING_SWEEP_STATE,
  SOFT_EXIT_STATE: sweepLib.SOFT_EXIT_STATE,
  HARD_EXIT_STATE: sweepLib.HARD_EXIT_STATE,
  GAP_STATE: gapAreasLib.GAP_STATE,
  CANDLE_PATTERN: candleStruct.CANDLE_PATTERN,
  // helpers
  normalizeScreenerType,
  getProfile,
  normalizeObservations,
  // core
  deriveSupportTestState,
  deriveResistanceTestState,
  computeTrailingStop,
  evaluateDayTradeCandidateRule,
  buildTradePlanV2
};
