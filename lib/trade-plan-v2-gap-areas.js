'use strict';

/**
 * Trade Plan V2 — Gap / Imbalance Area Contract (OBSERVABLE only)
 * ==============================================================
 *
 * ADDITIVE extension. Preserves ALL existing gap logic in the screeners — this
 * module only produces a NEW canonical active-gap contract for the shared
 * trade_plan_v2 object, computed from gap inputs the caller already has.
 *
 * A gap is NEVER invented: when the required historical prices (gap_low /
 * gap_high) are unavailable, the gap is reported GAP_UNAVAILABLE and receives no
 * active-zone weight.
 *
 * Weighting rules:
 *   - An active DEMAND gap is supporting evidence for a bullish reclaim.
 *   - An active SUPPLY gap is a realistic obstacle for entry and TP.
 *   - Once a gap is FULLY FILLED or FAILED it is marked inactive and MUST NOT
 *     continue to receive active-zone weight.
 *
 * Pure + deterministic: no wall-clock, no IO, no mutation.
 */

const GAP_STATE = Object.freeze({
  DEMAND_GAP_ACTIVE: 'DEMAND_GAP_ACTIVE',
  SUPPLY_GAP_ACTIVE: 'SUPPLY_GAP_ACTIVE',
  GAP_PARTIALLY_FILLED: 'GAP_PARTIALLY_FILLED',
  GAP_FULLY_FILLED: 'GAP_FULLY_FILLED',
  GAP_RECLAIMED: 'GAP_RECLAIMED',
  GAP_FAILED: 'GAP_FAILED',
  GAP_UNAVAILABLE: 'GAP_UNAVAILABLE'
});

const GAP_DIRECTION = Object.freeze({ DEMAND: 'DEMAND', SUPPLY: 'SUPPLY' });

// A gap counted as "fully filled" once price penetrates this fraction of it.
const FULL_FILL_THRESHOLD = 1.0;

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

function clamp01(n) {
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function normalizeDirection(raw, gapLow, gapHigh, currentPrice) {
  const s = String(raw || '').trim().toUpperCase();
  if (s.indexOf('DEMAND') >= 0 || s === 'UP' || s === 'BULL' || s === 'BULLISH') return GAP_DIRECTION.DEMAND;
  if (s.indexOf('SUPPLY') >= 0 || s === 'DOWN' || s === 'BEAR' || s === 'BEARISH') return GAP_DIRECTION.SUPPLY;
  // Infer from geometry only when a current price is available: a gap below
  // price acts as demand; a gap above price acts as supply.
  if (currentPrice !== null && gapLow !== null && gapHigh !== null) {
    if (gapHigh <= currentPrice) return GAP_DIRECTION.DEMAND;
    if (gapLow >= currentPrice) return GAP_DIRECTION.SUPPLY;
  }
  return null;
}

function normalizeObservations(observations) {
  if (!Array.isArray(observations)) return [];
  const out = [];
  for (const o of observations) {
    if (o == null) continue;
    if (typeof o === 'number') {
      const c = num(o);
      if (c !== null) out.push({ high: c, low: c, close: c });
      continue;
    }
    const close = firstNum(o, ['close', 'c', 'last', 'price', 'current_price']);
    if (close === null) continue;
    const high = firstNum(o, ['high', 'h']);
    const low = firstNum(o, ['low', 'l']);
    out.push({ high: high === null ? close : high, low: low === null ? close : low, close });
  }
  return out;
}

/**
 * Build the canonical status for one gap from observable data.
 *
 * @param {object} rawGap  { gap_type/type, gap_low/low, gap_high/high,
 *                           gap_direction/direction, gap_status/status,
 *                           gap_fill_pct, gap_test_count }
 * @param {object} ctx     { currentPrice, observations }
 * @returns {object} canonical gap contract
 */
function classifyGap(rawGap, ctx) {
  ctx = ctx || {};
  rawGap = rawGap || {};
  const gapLow = firstNum(rawGap, ['gap_low', 'low', 'lower', 'bottom']);
  const gapHigh = firstNum(rawGap, ['gap_high', 'high', 'upper', 'top']);
  const gapType = rawGap.gap_type || rawGap.type || null;

  // Required prices missing => unavailable (never invented).
  if (gapLow === null || gapHigh === null || gapHigh < gapLow) {
    return {
      gap_type: gapType,
      gap_low: null,
      gap_high: null,
      gap_direction: null,
      gap_status: GAP_STATE.GAP_UNAVAILABLE,
      gap_fill_pct: null,
      gap_test_count: null,
      active: false,
      reason: 'required gap prices unavailable — no active-zone weight'
    };
  }

  const currentPrice = firstNum(ctx, ['currentPrice', 'current_price', 'price']);
  const direction = normalizeDirection(rawGap.gap_direction || rawGap.direction, gapLow, gapHigh, currentPrice);
  const gapSize = gapHigh - gapLow;
  const bars = normalizeObservations(ctx.observations);

  // Test count: bars whose range intersects the gap band. Prefer an explicit
  // provided count when present (never overwrite caller-supplied observability).
  let testCount = num(rawGap.gap_test_count);
  if (testCount === null) {
    testCount = 0;
    for (const b of bars) {
      if (b.low <= gapHigh && b.high >= gapLow) testCount++;
    }
  }

  // Fill / penetration.
  let fillPct = num(rawGap.gap_fill_pct);
  let closedBeyond = false;   // demand: closed below gap_low; supply: closed above gap_high
  let reclaimed = false;      // demand: dipped in then closed back above gap_high
  if (bars.length && gapSize > 0) {
    if (direction === GAP_DIRECTION.DEMAND) {
      const lowestLow = Math.min.apply(null, bars.map((b) => b.low));
      const penetration = (gapHigh - lowestLow) / gapSize;
      if (fillPct === null) fillPct = clamp01(penetration);
      const last = bars[bars.length - 1];
      if (last.close < gapLow) closedBeyond = true;
      // Reclaim: price entered the gap (low below gap_high) but the last close
      // is back above the gap_high.
      if (lowestLow < gapHigh && last.close > gapHigh) reclaimed = true;
    } else if (direction === GAP_DIRECTION.SUPPLY) {
      const highestHigh = Math.max.apply(null, bars.map((b) => b.high));
      const penetration = (highestHigh - gapLow) / gapSize;
      if (fillPct === null) fillPct = clamp01(penetration);
      const last = bars[bars.length - 1];
      if (last.close > gapHigh) closedBeyond = true;
    }
  }
  if (fillPct === null) fillPct = 0;
  fillPct = clamp01(fillPct);

  // Resolve status + active flag.
  let status;
  let active;
  let reason;
  if (direction === GAP_DIRECTION.DEMAND) {
    if (closedBeyond) {
      status = GAP_STATE.GAP_FAILED; active = false;
      reason = 'demand gap failed — closed below gap_low; no more active-zone weight';
    } else if (reclaimed) {
      status = GAP_STATE.GAP_RECLAIMED; active = true;
      reason = 'price dipped into the demand gap and closed back above it (reclaim)';
    } else if (fillPct >= FULL_FILL_THRESHOLD) {
      status = GAP_STATE.GAP_FULLY_FILLED; active = false;
      reason = 'demand gap fully filled; no more active-zone weight';
    } else if (fillPct > 0) {
      status = GAP_STATE.GAP_PARTIALLY_FILLED; active = true;
      reason = 'demand gap partially filled and still active as support';
    } else {
      status = GAP_STATE.DEMAND_GAP_ACTIVE; active = true;
      reason = 'demand gap untested and active as support';
    }
  } else if (direction === GAP_DIRECTION.SUPPLY) {
    if (closedBeyond || fillPct >= FULL_FILL_THRESHOLD) {
      status = closedBeyond ? GAP_STATE.GAP_FAILED : GAP_STATE.GAP_FULLY_FILLED;
      active = false;
      reason = closedBeyond
        ? 'supply gap overcome — closed above gap_high; no more active-zone weight'
        : 'supply gap fully filled; no more active-zone weight';
    } else if (fillPct > 0) {
      status = GAP_STATE.GAP_PARTIALLY_FILLED; active = true;
      reason = 'supply gap partially filled and still an active obstacle';
    } else {
      status = GAP_STATE.SUPPLY_GAP_ACTIVE; active = true;
      reason = 'supply gap untested and active as an obstacle';
    }
  } else {
    status = GAP_STATE.GAP_UNAVAILABLE; active = false;
    reason = 'gap direction indeterminate — no active-zone weight';
  }

  return {
    gap_type: gapType,
    gap_low: round4(gapLow),
    gap_high: round4(gapHigh),
    gap_direction: direction,
    gap_status: status,
    gap_fill_pct: round4(fillPct),
    gap_test_count: testCount,
    active,
    reason
  };
}

/**
 * Build the active-gap area contract for the plan.
 *
 * @param {object} p { gaps: [rawGap...], currentPrice, entry, observations }
 * @returns {object} { active_gap_areas, nearest_demand_gap, nearest_supply_gap }
 */
function buildActiveGapAreas(p) {
  p = p || {};
  const gaps = Array.isArray(p.gaps) ? p.gaps : [];
  const currentPrice = firstNum(p, ['currentPrice', 'current_price', 'price']);
  const entry = firstNum(p, ['entry', 'entry_price', 'reference']);
  const anchor = entry !== null ? entry : currentPrice;

  const classified = gaps.map((g) => classifyGap(g, { currentPrice, observations: p.observations }));

  // Nearest ACTIVE demand gap at/below the anchor (support side).
  let nearestDemand = null;
  // Nearest ACTIVE supply gap at/above the anchor (obstacle side).
  let nearestSupply = null;
  for (const g of classified) {
    if (!g.active) continue; // filled/failed gaps carry no active weight
    if (g.gap_direction === 'DEMAND' && (anchor === null || g.gap_high <= anchor || g.gap_low <= anchor)) {
      if (nearestDemand === null || g.gap_high > nearestDemand.gap_high) nearestDemand = g;
    } else if (g.gap_direction === 'SUPPLY' && (anchor === null || g.gap_low >= anchor || g.gap_high >= anchor)) {
      if (nearestSupply === null || g.gap_low < nearestSupply.gap_low) nearestSupply = g;
    }
  }

  return {
    active_gap_areas: classified,
    nearest_demand_gap: nearestDemand,
    nearest_supply_gap: nearestSupply
  };
}

module.exports = {
  GAP_STATE,
  GAP_DIRECTION,
  FULL_FILL_THRESHOLD,
  classifyGap,
  buildActiveGapAreas
};
