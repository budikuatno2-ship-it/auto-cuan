'use strict';

/**
 * Trade Plan V2 — Observable Liquidity-Sweep / Trailing-Stop Diagnostics
 * ======================================================================
 *
 * ADDITIVE extension. Models observable price behaviour that traders commonly
 * describe as a "trailing-stop sweep" / "liquidity sweep": price temporarily
 * trades THROUGH a likely trailing-stop zone, then RECLAIMS the zone and
 * continues without breaking the underlying structure.
 *
 * IMPORTANT modelling principle
 * -----------------------------
 * This does NOT claim that a "bandar" intentionally hunts stops. It only detects
 * MEASURABLE behaviour from observable OHLC/close data:
 *   - price traded below the current trailing reference,
 *   - the move stayed ABOVE the emergency structural stop,
 *   - the lower wick is meaningful vs the body (when OHLC exists),
 *   - the candle/snapshot closed back ABOVE the trailing reference,
 *   - structural support or an active demand-gap area remained valid,
 *   - the following valid observation did NOT confirm a breakdown.
 *
 * A single wick below the trailing reference must NOT automatically become a
 * confirmed exit. Confirmed trailing breakdown requires a documented rule
 * (body close below buffered reference, two consecutive closes below it,
 * structural support also broken, an active demand gap failing, or another
 * explicit observable confirmation).
 *
 * The emergency hard stop is ALWAYS active and is never disabled by a reclaim.
 * A trailing stop is never lowered once raised.
 *
 * The 3% / 4% / 5% "common trailing zones" are DIAGNOSTIC zones only — not an
 * assumption about real orders, and never used as a fixed production stop.
 *
 * Pure + deterministic: no wall-clock, no IO, no mutation.
 */

const idx = require('./idx-tick-normalization');
const candle = require('./trade-plan-v2-candle-structure');

// Canonical trailing-stop sweep states.
const TRAILING_SWEEP_STATE = Object.freeze({
  NORMAL: 'TRAILING_NORMAL',
  SWEEP_PENDING: 'TRAILING_SWEEP_PENDING',
  SWEEP_RECLAIMED: 'TRAILING_SWEEP_RECLAIMED',
  STRUCTURE_WEAKENING: 'TRAILING_STRUCTURE_WEAKENING',
  BREAKDOWN_CONFIRMED: 'TRAILING_BREAKDOWN_CONFIRMED'
});

const SOFT_EXIT_STATE = Object.freeze({
  NORMAL: 'SOFT_EXIT_NORMAL',
  DELAYED: 'SOFT_EXIT_DELAYED',
  TRIGGERED: 'SOFT_EXIT_TRIGGERED'
});

const HARD_EXIT_STATE = Object.freeze({
  ACTIVE: 'HARD_STOP_ACTIVE',
  HIT: 'HARD_STOP_HIT'
});

// Common retail trailing distances (DIAGNOSTIC zones only).
const COMMON_TRAILING_ZONE_PCTS = Object.freeze([3, 4, 5]);
const MEANINGFUL_LOWER_WICK_TO_BODY = 1.0; // lower wick >= body => "meaningful"

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

function round4(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

function tick(price, mode) {
  const r = idx.roundToIdxTick(price, mode || 'floor');
  return Number.isFinite(r) ? r : null;
}

function normalizeObservations(observations) {
  if (!Array.isArray(observations)) return [];
  const out = [];
  for (const o of observations) {
    if (o == null) continue;
    if (typeof o === 'number') {
      const c = num(o);
      if (c !== null) out.push({ open: c, high: c, low: c, close: c, has_ohlc: false });
      continue;
    }
    const close = firstNum(o, ['close', 'c', 'last', 'price', 'current_price']);
    if (close === null) continue;
    const high = firstNum(o, ['high', 'h']);
    const low = firstNum(o, ['low', 'l']);
    const open = firstNum(o, ['open', 'o']);
    const hasOhlc = high !== null && low !== null && open !== null;
    out.push({
      open: open === null ? close : open,
      high: high === null ? close : high,
      low: low === null ? close : low,
      close,
      has_ohlc: hasOhlc
    });
  }
  return out;
}

/**
 * Build the common retail trailing-stop zones (DIAGNOSTIC only) below a
 * reference price, plus an ATR-based trailing reference when ATR is available.
 *
 * @param {object} p { referencePrice, atr, atrMultiplier }
 * @returns {object} { diagnostic_only, reference_price, zones:[...] , disclaimer }
 */
function buildCommonTrailingZones(p) {
  p = p || {};
  const ref = num(p.referencePrice);
  const atr = num(p.atr);
  const atrMult = num(p.atrMultiplier);
  const zones = [];
  if (ref !== null) {
    for (const pct of COMMON_TRAILING_ZONE_PCTS) {
      const level = ref * (1 - pct / 100);
      zones.push({
        type: 'PCT',
        pct,
        level: tick(level, 'floor'),
        distance_pct: pct,
        diagnostic_only: true
      });
    }
    if (atr !== null && atrMult !== null) {
      const level = ref - atrMult * atr;
      zones.push({
        type: 'ATR',
        atr_multiplier: atrMult,
        level: tick(level, 'floor'),
        distance_pct: ref > 0 ? round4(((ref - level) / ref) * 100) : null,
        diagnostic_only: true
      });
    }
  }
  return {
    diagnostic_only: true,
    reference_price: ref,
    zones,
    disclaimer: 'Common trailing zones (3/4/5 percent and an ATR reference) are DIAGNOSTIC zones only, not assumptions about real orders, and are never used as a fixed production trailing stop.'
  };
}

/**
 * Detect observable events at each common trailing zone across the observations.
 * For every zone reports whether a candle pierced it, reclaimed it, closed
 * below it, later resumed the prior trend, or later confirmed structural failure.
 *
 * @param {object} p { zones:[{level,...}], observations, resumeReference }
 * @returns {Array} one event summary per zone
 */
function detectTrailingZoneEvents(p) {
  p = p || {};
  const zones = Array.isArray(p.zones) ? p.zones : [];
  const bars = normalizeObservations(p.observations);
  const events = [];
  for (const z of zones) {
    const level = num(z.level);
    if (level === null || !bars.length) {
      events.push({ zone_type: z.type, zone_pct: z.pct != null ? z.pct : null, level: z.level, pierced: false, reclaimed: false, closed_below: false, resumed_trend: false, structure_failed: false, diagnostic_only: true });
      continue;
    }
    let pierced = false;
    let reclaimed = false;
    let closedBelow = false;
    let firstPierceIdx = -1;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (b.low < level) {
        pierced = true;
        if (firstPierceIdx < 0) firstPierceIdx = i;
      }
    }
    if (pierced) {
      const last = bars[bars.length - 1];
      closedBelow = last.close < level;
      // Reclaim: a bar pierced the zone but a later close is back above it.
      if (firstPierceIdx >= 0) {
        for (let j = firstPierceIdx; j < bars.length; j++) {
          if (bars[j].close >= level) { reclaimed = true; break; }
        }
      }
    }
    // Trend resumption after a reclaim: a close makes a new high above the
    // pre-pierce high (observable continuation).
    let resumed = false;
    if (reclaimed && firstPierceIdx > 0) {
      const priorHigh = Math.max.apply(null, bars.slice(0, firstPierceIdx).map((b) => b.high));
      const lastClose = bars[bars.length - 1].close;
      resumed = lastClose > priorHigh;
    }
    // Structural failure: the final close is below the zone by more than one
    // step and never reclaimed.
    const structureFailed = closedBelow && !reclaimed;

    events.push({
      zone_type: z.type,
      zone_pct: z.pct != null ? z.pct : null,
      level,
      pierced,
      reclaimed,
      closed_below: closedBelow,
      resumed_trend: resumed,
      structure_failed: structureFailed,
      diagnostic_only: true
    });
  }
  return events;
}

/**
 * Derive the trailing-stop sweep state from observable data.
 *
 * @param {object} p
 *   trailingReference     current trailing/protective reference level
 *   emergencyStop         emergency hard-stop level (always active)
 *   structuralSupport     structural support level (optional)
 *   tolerance             volatility-aware buffer for the reference
 *   observations          recent bars (OHLC when available)
 *   demandGapActive       boolean — an active demand gap still supports price
 *   demandGapFailed       boolean — an active demand gap has failed
 *   breakdownConfirmed    boolean — explicit external confirmation
 * @returns {object}
 */
function deriveTrailingSweepState(p) {
  p = p || {};
  const trailingRef = num(p.trailingReference);
  const emergency = num(p.emergencyStop);
  const support = num(p.structuralSupport);
  const bars = normalizeObservations(p.observations);
  const tol = num(p.tolerance) != null && p.tolerance >= 0 ? num(p.tolerance) : 0;

  if (trailingRef === null || !bars.length) {
    return {
      trailing_sweep_state: TRAILING_SWEEP_STATE.NORMAL,
      reason: 'insufficient trailing-reference/observation data — defaulting to NORMAL',
      consecutive_closes_below: 0,
      tests: 0,
      meaningful_lower_wick: false
    };
  }

  const buffered = trailingRef - tol;
  const last = bars[bars.length - 1];

  // Consecutive closes below the buffered trailing reference (from newest).
  let consecBelow = 0;
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].close < buffered) consecBelow++;
    else break;
  }
  // Tests: bars whose low pierced the trailing reference band.
  let tests = 0;
  for (const b of bars) if (b.low <= trailingRef + tol) tests++;

  // Meaningful lower wick on the last bar (only when it carries real OHLC).
  let meaningfulLowerWick = false;
  if (last.has_ohlc) {
    const cls = candle.analyzeCandleStructure(last);
    if (cls.available) {
      meaningfulLowerWick = (cls.lower_wick_to_body_ratio !== null && cls.lower_wick_to_body_ratio >= MEANINGFUL_LOWER_WICK_TO_BODY) ||
        (cls.body === 0 && cls.lower_wick > 0);
    }
  }

  const structuralSupportBroken = support !== null && last.close < support;
  const explicitConfirm = p.breakdownConfirmed === true;
  const demandGapFailed = p.demandGapFailed === true;
  const demandGapActive = p.demandGapActive === true;

  // Emergency breach => confirmed breakdown regardless of anything else.
  if (emergency !== null && last.close < emergency) {
    return {
      trailing_sweep_state: TRAILING_SWEEP_STATE.BREAKDOWN_CONFIRMED,
      reason: 'close below the emergency hard stop — confirmed breakdown',
      consecutive_closes_below: consecBelow,
      tests,
      meaningful_lower_wick: meaningfulLowerWick
    };
  }

  let state;
  let reason;
  // Confirmed trailing breakdown: documented rules.
  if (consecBelow >= 2) {
    state = TRAILING_SWEEP_STATE.BREAKDOWN_CONFIRMED;
    reason = consecBelow + ' consecutive closes below the buffered trailing reference';
  } else if (last.close < buffered && (explicitConfirm || structuralSupportBroken || demandGapFailed)) {
    state = TRAILING_SWEEP_STATE.BREAKDOWN_CONFIRMED;
    reason = 'body close below buffered trailing reference with ' +
      (structuralSupportBroken ? 'structural support also broken' : (demandGapFailed ? 'an active demand gap failing' : 'explicit confirmation'));
  } else if (last.close < buffered) {
    // One body close below the buffered reference (but structure not yet broken).
    state = TRAILING_SWEEP_STATE.SWEEP_PENDING;
    reason = 'one close below the buffered trailing reference — awaiting a confirming observation (single wick/close is NOT a confirmed exit)';
  } else if (last.low < trailingRef && last.close >= trailingRef) {
    // Pierced below then closed back above — a reclaim, provided structure holds.
    const structureValid = (support === null || last.close >= support) && !demandGapFailed;
    if (structureValid) {
      state = TRAILING_SWEEP_STATE.SWEEP_RECLAIMED;
      reason = 'low swept below the trailing reference but the close reclaimed it' +
        (demandGapActive ? ' with an active demand gap supporting the reclaim' : '') +
        (meaningfulLowerWick ? ' (meaningful lower wick)' : '');
    } else {
      state = TRAILING_SWEEP_STATE.STRUCTURE_WEAKENING;
      reason = 'swept the trailing reference but the underlying structure is no longer clean';
    }
  } else if (tests >= 2 && last.low <= trailingRef + tol) {
    state = TRAILING_SWEEP_STATE.STRUCTURE_WEAKENING;
    reason = tests + ' repeated tests of the trailing reference with price sitting on it';
  } else {
    state = TRAILING_SWEEP_STATE.NORMAL;
    reason = 'price holding comfortably above the trailing reference';
  }

  return {
    trailing_sweep_state: state,
    reason,
    consecutive_closes_below: consecBelow,
    tests,
    meaningful_lower_wick: meaningfulLowerWick
  };
}

/**
 * Summarise the observable evidence for a likely (reclaimed) liquidity sweep.
 * Every field is an OBSERVED boolean; `likely_reclaimed_sweep` is true only when
 * the full bullish-reclaim pattern holds. This is explicitly NOT a claim about
 * intentional stop-hunting.
 */
function buildLiquiditySweepEvidence(p) {
  p = p || {};
  const trailingRef = num(p.trailingReference);
  const emergency = num(p.emergencyStop);
  const support = num(p.structuralSupport);
  const bars = normalizeObservations(p.observations);
  const last = bars.length ? bars[bars.length - 1] : null;

  const piercedTrailing = !!(last && trailingRef !== null && last.low < trailingRef);
  const aboveEmergency = !!(last && emergency !== null ? last.close > emergency : (last != null));
  const closedBackAbove = !!(last && trailingRef !== null && last.close >= trailingRef);
  const structuralSupportValid = support === null ? null : !!(last && last.close >= support);
  const demandGapActive = p.demandGapActive === true;
  const nextConfirmsBreakdown = p.nextObservationConfirmsBreakdown === true;

  let meaningfulLowerWick = false;
  if (last && last.has_ohlc) {
    const cls = candle.analyzeCandleStructure(last);
    if (cls.available) {
      meaningfulLowerWick = (cls.lower_wick_to_body_ratio !== null && cls.lower_wick_to_body_ratio >= MEANINGFUL_LOWER_WICK_TO_BODY) ||
        (cls.body === 0 && cls.lower_wick > 0);
    }
  }

  const likelyReclaimedSweep = piercedTrailing && aboveEmergency && closedBackAbove &&
    (structuralSupportValid !== false) && !nextConfirmsBreakdown;

  return {
    pierced_trailing_reference: piercedTrailing,
    above_emergency_stop: aboveEmergency,
    meaningful_lower_wick: meaningfulLowerWick,
    closed_back_above_reference: closedBackAbove,
    structural_support_valid: structuralSupportValid,
    demand_gap_active: demandGapActive,
    next_observation_confirms_breakdown: nextConfirmsBreakdown,
    likely_reclaimed_sweep: likelyReclaimedSweep,
    modelling_note: 'Observable behaviour only. This does NOT assert that any party intentionally hunts stops.'
  };
}

/**
 * Resolve the soft/hard exit states from the trailing sweep state.
 *
 * - The emergency HARD stop is ALWAYS active; it is only HIT when the close is
 *   below the emergency level. A reclaim can delay a SOFT exit but can NEVER
 *   disable the hard stop.
 * - `structure_confirmation_required` is true whenever an exit decision should
 *   wait for confirmation (pending or reclaimed sweep).
 *
 * @param {object} p { sweepState, emergencyStop, lastClose }
 * @returns {object} { soft_exit_state, hard_exit_state, structure_confirmation_required, emergency_stop_active }
 */
function resolveSoftHardExit(p) {
  p = p || {};
  const state = p.sweepState;
  const emergency = num(p.emergencyStop);
  const lastClose = num(p.lastClose);
  const emergencyHit = emergency !== null && lastClose !== null && lastClose < emergency;

  let soft;
  let confirmationRequired;
  switch (state) {
    case TRAILING_SWEEP_STATE.BREAKDOWN_CONFIRMED:
      soft = SOFT_EXIT_STATE.TRIGGERED;
      confirmationRequired = false;
      break;
    case TRAILING_SWEEP_STATE.SWEEP_RECLAIMED:
      soft = SOFT_EXIT_STATE.DELAYED; // a reclaimed sweep delays the soft exit
      confirmationRequired = true;
      break;
    case TRAILING_SWEEP_STATE.SWEEP_PENDING:
      soft = SOFT_EXIT_STATE.DELAYED;
      confirmationRequired = true;
      break;
    case TRAILING_SWEEP_STATE.STRUCTURE_WEAKENING:
      soft = SOFT_EXIT_STATE.DELAYED;
      confirmationRequired = true;
      break;
    default:
      soft = SOFT_EXIT_STATE.NORMAL;
      confirmationRequired = false;
  }

  return {
    soft_exit_state: soft,
    hard_exit_state: emergencyHit ? HARD_EXIT_STATE.HIT : HARD_EXIT_STATE.ACTIVE,
    structure_confirmation_required: confirmationRequired,
    emergency_stop_active: true // NEVER disabled
  };
}

module.exports = {
  TRAILING_SWEEP_STATE,
  SOFT_EXIT_STATE,
  HARD_EXIT_STATE,
  COMMON_TRAILING_ZONE_PCTS,
  MEANINGFUL_LOWER_WICK_TO_BODY,
  buildCommonTrailingZones,
  detectTrailingZoneEvents,
  deriveTrailingSweepState,
  buildLiquiditySweepEvidence,
  resolveSoftHardExit
};
