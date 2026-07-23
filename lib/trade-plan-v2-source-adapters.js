'use strict';

/**
 * Trade Plan V2 — Per-Screener Runtime Source Adapters
 * ====================================================
 *
 * The canonical Trade Plan V2 engine (lib/trade-plan-v2.js) rejects a candidate
 * with NO_STRUCTURAL_LEVEL when it cannot find real support / confirmed swing
 * low. The bug it fixes: the integration was feeding the engine the FLATTENED
 * notification/candidate row, which does NOT carry the screener's already-computed
 * market structure (support, swing low, ATR, gap areas). Each screener stores
 * that structure under DIFFERENT real field names:
 *
 *   Day Trade (analyzeDayTrade):  support, resistance, atr14, swingLow5, swingHigh10
 *   Swing Konglo (calculateIndicators): support, resistance, _atr14,
 *                                        _overheadGap{lower,upper}, _downsideGap{lower,upper}
 *   Swing Non-Konglo (calculateNkSetupScore): support, resistance, atr14
 *
 * These adapters map each screener's REAL runtime analysis object into the
 * canonical V2 input contract. They:
 *   - reuse the structure the screeners already computed (never recompute it),
 *   - NEVER infer support by reversing the legacy stop loss,
 *   - NEVER infer resistance by reversing the legacy take-profit,
 *   - NEVER invent unavailable market data (missing => null / empty),
 *   - report exactly which real structural fields were found (source_fields) so
 *     the replay tool can be honest about structural availability.
 *
 * Pure + deterministic: no IO, no Supabase, no Telegram, no wall-clock, no mutation.
 */

// Canonical V2 input keys the engine reads (see lib/trade-plan-v2.js).
// The engine also reads observations / gaps / next_resistance off the candidate.
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Confirmed pivot structure from candles (Swing screeners).
const candleStructure = require('./trade-plan-v2-candle-structure');
const {
  getLatestConfirmedSwingLow,
  getNearestConfirmedResistance,
  getNextConfirmedResistance,
  CONFIRMED_PIVOT_LOOKBACK
} = candleStructure;

/** First non-null numeric value across a priority list of (object, key) reads. */
function pickNum(sources, keys) {
  for (const src of sources) {
    if (!src) continue;
    for (const k of keys) {
      const v = num(src[k]);
      if (v !== null) return v;
    }
  }
  return null;
}

/** First defined (any type) value across a priority list of (object, key) reads. */
function pickVal(sources, keys) {
  for (const src of sources) {
    if (!src) continue;
    for (const k of keys) {
      if (src[k] !== undefined && src[k] !== null) return src[k];
    }
  }
  return undefined;
}

/** Normalise recent candles into ordered OHLC observation bars (oldest→newest). */
function buildObservations(candles, n) {
  if (!Array.isArray(candles) || !candles.length) return undefined;
  const take = n && n > 0 ? n : 10;
  return candles.slice(-take).map((c) => ({
    open: num(c.open), high: num(c.high), low: num(c.low),
    close: num(c.close != null ? c.close : c.last)
  }));
}

/**
 * Map a Swing-Konglo runtime gap object ({lower, upper, size}) to the canonical
 * gap contract ({gap_low, gap_high, gap_direction}). Returns null when prices
 * are unavailable (never invented).
 */
function mapRuntimeGap(gap, direction) {
  if (!gap) return null;
  const low = pickNum([gap], ['gap_low', 'lower', 'low']);
  const high = pickNum([gap], ['gap_high', 'upper', 'high']);
  if (low === null || high === null) return null;
  return { gap_low: low, gap_high: high, gap_direction: direction, gap_type: direction.toLowerCase() };
}

/** Record a structural source field when a value is genuinely present. */
function noteField(structural, name, value) {
  if (value !== null && value !== undefined) structural.source_fields.push(name);
}

// ---------------------------------------------------------------------------
// Day Trade adapter
// ---------------------------------------------------------------------------
/**
 * @param {object} source { analysis (analyzeDayTrade output), scored, candidate,
 *                          candles, respectContext }
 * @returns {object} { input, structural }
 */
function adaptDayTrade(source) {
  source = source || {};
  const analysis = source.analysis || null;
  const scored = source.scored || source.candidate || null;
  const gen = [analysis, scored]; // priority: real analyzer first, then flattened row

  const structural = { screener_type: 'DAY_TRADE', source_fields: [], available: false };

  const ticker = pickVal(gen, ['ticker']) || null;
  const support = pickNum(gen, ['support', 'support1', 's1']);
  const localSupport = pickNum(gen, ['local_support', 'recent_support']);
  const majorSupport = pickNum(gen, ['major_support', 'support', 'support1', 's1']);
  // Confirmed swing low: Day Trade analyzer's real key is `swingLow5`.
  const swingLow = pickNum(gen, ['confirmed_swing_low', 'swing_low', 'latest_swing_low', 'swingLow5']);
  const resistance = pickNum(gen, ['resistance', 'resistance1', 'r1']);
  const majorResistance = pickNum(gen, ['major_resistance', 'resistance', 'resistance1', 'r1']);
  const explicitLocalResistance = pickNum(gen, ['local_resistance', 'nearest_local_resistance']);
  const swingHigh = pickNum(gen, ['swingHigh10', 'local_resistance', 'next_resistance', 'resistance2', 'r2']);
  const atr14 = pickNum(gen, ['atr14', 'atr', 'average_true_range']);
  const currentPrice = pickNum(gen, ['current_price', 'last_price', 'lastn', 'close']);
  const entryLow = pickNum(gen, ['entry_low', 'entry1', 'entry_1']);
  const entryHigh = pickNum(gen, ['entry_high', 'entry2', 'entry_2']);
  const localResistance = explicitLocalResistance !== null ? explicitLocalResistance
    : (swingHigh !== null && entryHigh !== null && swingHigh > entryHigh &&
      (majorResistance === null || swingHigh < majorResistance) ? swingHigh : null);
  const nextResistance = swingHigh !== null &&
    ((localResistance !== null && swingHigh > localResistance) || (localResistance === null && majorResistance !== null && swingHigh > majorResistance))
    ? swingHigh : pickNum(gen, ['next_resistance', 'resistance2', 'r2']);
  const observations = buildObservations(source.candles, 10);

  noteField(structural, 'support', support);
  noteField(structural, 'local_support', localSupport);
  noteField(structural, 'major_support', majorSupport);
  noteField(structural, 'swingLow5', swingLow);
  noteField(structural, 'resistance', resistance);
  noteField(structural, 'local_resistance', localResistance);
  noteField(structural, 'major_resistance', majorResistance);
  noteField(structural, 'swingHigh10', nextResistance);
  noteField(structural, 'atr14', atr14);
  if (observations) structural.source_fields.push('observations');
  structural.available = support !== null || localSupport !== null || majorSupport !== null || swingLow !== null || localResistance !== null || majorResistance !== null;

  const input = {
    ticker,
    entry_low: entryLow,
    entry_high: entryHigh,
    current_price: currentPrice,
    support,
    local_support: localSupport,
    major_support: majorSupport,
    swing_low: swingLow,
    resistance,
    local_resistance: localResistance,
    major_resistance: majorResistance,
    next_resistance: nextResistance,
    atr14,
    observations,
    // Day Trade has no true gap_low/gap_high pairs — never invented.
    gaps: [],
    freshness: pickVal(gen, ['freshness']),
    screener_type: 'DAY_TRADE'
  };
  return { input, structural };
}

// ---------------------------------------------------------------------------
// Swing Konglo adapter
// ---------------------------------------------------------------------------
/**
 * @param {object} source { analysis (calculateIndicators output), row (pushed
 *                          candidate), candidate, candles }
 * @returns {object} { input, structural }
 */
function adaptSwingKonglo(source) {
  source = source || {};
  const analysis = source.analysis || null;
  const row = source.row || source.candidate || null;
  const gen = [analysis, row];

  const structural = { screener_type: 'SWING_KONGLO', source_fields: [], available: false };

  const ticker = pickVal(gen, ['ticker']) || null;
  const support = pickNum(gen, ['support', 'support1', 's1']);
  const localSupport = pickNum(gen, ['local_support', 'recent_support']);
  const majorSupport = pickNum(gen, ['major_support']);
  // Legacy swing_low from the screener (may be null if not computed).
  const legacySwingLow = pickNum(gen, ['confirmed_swing_low', 'swing_low', 'latest_swing_low']);
  const resistance = pickNum(gen, ['resistance', 'resistance1', 'r1']);
  // Legacy resistance from the screener.
  const legacyLocalResistance = pickNum(gen, ['local_resistance', 'nearest_local_resistance']);
  const legacyNextResistance = pickNum(gen, ['next_resistance', 'resistance2', 'r2']);
  const majorResistance = pickNum(gen, ['major_resistance']);
  // Swing Konglo ATR is stored under the runtime key `_atr14`; the pushed row
  // also carries `atr14` from atr-report-helpers.
  const atr14 = pickNum(gen, ['atr14', '_atr14', 'atr', 'average_true_range']);
  const currentPrice = pickNum(gen, ['current_price', 'last_price', 'close_price', 'close']);
  const entryLow = pickNum(gen, ['entry_low', 'entry1']);
  const entryHigh = pickNum(gen, ['entry_high', 'entry2']);
  const observations = buildObservations(source.candles, 10);

  // Derive swing_low from confirmed candle structure when candles are available.
  // The confirmed pivot must be at or below entry_zone_low to be valid support.
  let swingLow = legacySwingLow;
  let swingLowFromCandles = null;
  if (entryLow !== null && source.candles && Array.isArray(source.candles)) {
    const confirmedSwingLow = getLatestConfirmedSwingLow(source.candles, entryLow, CONFIRMED_PIVOT_LOOKBACK);
    if (confirmedSwingLow) {
      swingLow = confirmedSwingLow.pivot_low;
      swingLowFromCandles = confirmedSwingLow.pivot_low;
    }
  }

  // Derive local_resistance and next_resistance from confirmed candle structure.
  let localResistance = legacyLocalResistance;
  let nextResistance = legacyNextResistance;
  let localResistanceFromCandles = null;
  let nextResistanceFromCandles = null;
  if (entryHigh !== null && source.candles && Array.isArray(source.candles)) {
    // Nearest confirmed pivot high strictly above entry_zone_high.
    const confirmedResistance = getNearestConfirmedResistance(source.candles, entryHigh, CONFIRMED_PIVOT_LOOKBACK);
    if (confirmedResistance && confirmedResistance.local_resistance > entryHigh) {
      localResistance = confirmedResistance.local_resistance;
      localResistanceFromCandles = confirmedResistance.local_resistance;
    }
    // Next confirmed pivot high above the local resistance.
    if (localResistance !== null) {
      const confirmedNext = getNextConfirmedResistance(source.candles, localResistance, CONFIRMED_PIVOT_LOOKBACK);
      if (confirmedNext) {
        nextResistance = confirmedNext.next_resistance;
        nextResistanceFromCandles = confirmedNext.next_resistance;
      }
    }
  }

  // Gap / imbalance areas already computed by the Konglo analyzer:
  //   _downsideGap = unfilled gap BELOW price  => active DEMAND area
  //   _overheadGap = unfilled gap ABOVE price  => active SUPPLY area
  const gaps = [];
  const demandGap = mapRuntimeGap(pickVal(gen, ['_downsideGap', 'downside_gap', 'demand_gap']), 'DEMAND');
  const supplyGap = mapRuntimeGap(pickVal(gen, ['_overheadGap', 'overhead_gap', 'supply_gap']), 'SUPPLY');
  if (demandGap) gaps.push(demandGap);
  if (supplyGap) gaps.push(supplyGap);

  noteField(structural, 'support', support);
  noteField(structural, 'local_support', localSupport);
  noteField(structural, 'major_support', majorSupport);
  noteField(structural, 'resistance', resistance);
  noteField(structural, 'local_resistance', localResistance);
  noteField(structural, 'major_resistance', majorResistance);
  noteField(structural, 'swing_low', swingLow);
  noteField(structural, 'next_resistance', nextResistance);
  noteField(structural, 'atr14', atr14);
  if (demandGap) structural.source_fields.push('_downsideGap');
  if (supplyGap) structural.source_fields.push('_overheadGap');
  if (observations) structural.source_fields.push('observations');
  // Report candle-derived structure in source_fields.
  if (swingLowFromCandles !== null) structural.source_fields.push('confirmed_swing_low_from_candles');
  if (localResistanceFromCandles !== null) structural.source_fields.push('local_resistance_from_candles');
  if (nextResistanceFromCandles !== null) structural.source_fields.push('next_resistance_from_candles');
  // Report 20-day support as major_support (not local support).
  if (support !== null) structural.source_fields.push('support_as_major_support');
  // Record resistance_as_major_resistance whenever the plain base-screener
  // `resistance` is actually consumed by the engine as a MAJOR_RESISTANCE anchor.
  // This mirrors the engine's exact overhead classification (lib/trade-plan-v2.js):
  // a lone `resistance` is promoted to MAJOR_RESISTANCE when an explicit major OR
  // a local resistance is ALSO present (otherwise it stays a local obstacle).
  // Previously this only fired for an explicit `major_resistance` input — which the
  // swing adapters never populate — so the diagnostic under-reported the resistance
  // the engine really mapped to major_resistance. This corrects the DIAGNOSTIC ONLY
  // and never changes any numeric input passed to the engine.
  const resistanceMappedToMajor = resistance !== null &&
    (majorResistance !== null || localResistance !== null);
  if (resistanceMappedToMajor) structural.source_fields.push('resistance_as_major_resistance');
  structural.available = support !== null || localSupport !== null || majorSupport !== null || swingLow !== null || localResistance !== null || majorResistance !== null || demandGap !== null;

  const input = {
    ticker,
    entry_low: entryLow,
    entry_high: entryHigh,
    current_price: currentPrice,
    support,
    local_support: localSupport,
    major_support: majorSupport,
    swing_low: swingLow,
    resistance,
    local_resistance: localResistance,
    major_resistance: majorResistance,
    next_resistance: nextResistance,
    atr14,
    observations,
    gaps,
    freshness: pickVal(gen, ['freshness']),
    screener_type: 'SWING_KONGLO'
  };
  return { input, structural };
}

// ---------------------------------------------------------------------------
// Swing Non-Konglo adapter
// ---------------------------------------------------------------------------
/**
 * @param {object} source { scored (calculateNkSetupScore output, BEFORE the ATR
 *                          fields are stripped), candidate, candles }
 * @returns {object} { input, structural }
 */
function adaptSwingNonKonglo(source) {
  source = source || {};
  const scored = source.scored || source.candidate || source.row || null;
  const gen = [scored];

  const structural = { screener_type: 'SWING_NON_KONGLO', source_fields: [], available: false };

  const ticker = pickVal(gen, ['ticker']) || null;
  const support = pickNum(gen, ['support', 'support1', 's1']);
  const localSupport = pickNum(gen, ['local_support', 'recent_support']);
  const majorSupport = pickNum(gen, ['major_support']);
  // Legacy swing_low from the screener (may be null if not computed).
  const legacySwingLow = pickNum(gen, ['confirmed_swing_low', 'swing_low', 'latest_swing_low']);
  const resistance = pickNum(gen, ['resistance', 'resistance1', 'r1']);
  // Legacy resistance from the screener.
  const legacyLocalResistance = pickNum(gen, ['local_resistance', 'nearest_local_resistance']);
  const legacyNextResistance = pickNum(gen, ['next_resistance', 'resistance2', 'r2']);
  const majorResistance = pickNum(gen, ['major_resistance']);
  const atr14 = pickNum(gen, ['atr14', 'atr', 'average_true_range']);
  const currentPrice = pickNum(gen, ['current_price', 'last_price', 'close_price', 'close']);
  const entryLow = pickNum(gen, ['entry_low', 'entry1']);
  const entryHigh = pickNum(gen, ['entry_high', 'entry2']);
  const observations = buildObservations(source.candles, 10);

  // Derive swing_low from confirmed candle structure when candles are available.
  // The confirmed pivot must be at or below entry_zone_low to be valid support.
  let swingLow = legacySwingLow;
  let swingLowFromCandles = null;
  if (entryLow !== null && source.candles && Array.isArray(source.candles)) {
    const confirmedSwingLow = getLatestConfirmedSwingLow(source.candles, entryLow, CONFIRMED_PIVOT_LOOKBACK);
    if (confirmedSwingLow) {
      swingLow = confirmedSwingLow.pivot_low;
      swingLowFromCandles = confirmedSwingLow.pivot_low;
    }
  }

  // Derive local_resistance and next_resistance from confirmed candle structure.
  let localResistance = legacyLocalResistance;
  let nextResistance = legacyNextResistance;
  let localResistanceFromCandles = null;
  let nextResistanceFromCandles = null;
  if (entryHigh !== null && source.candles && Array.isArray(source.candles)) {
    // Nearest confirmed pivot high strictly above entry_zone_high.
    const confirmedResistance = getNearestConfirmedResistance(source.candles, entryHigh, CONFIRMED_PIVOT_LOOKBACK);
    if (confirmedResistance && confirmedResistance.local_resistance > entryHigh) {
      localResistance = confirmedResistance.local_resistance;
      localResistanceFromCandles = confirmedResistance.local_resistance;
    }
    // Next confirmed pivot high above the local resistance.
    if (localResistance !== null) {
      const confirmedNext = getNextConfirmedResistance(source.candles, localResistance, CONFIRMED_PIVOT_LOOKBACK);
      if (confirmedNext) {
        nextResistance = confirmedNext.next_resistance;
        nextResistanceFromCandles = confirmedNext.next_resistance;
      }
    }
  }

  // Map Non-Konglo runtime gaps. These may use various aliases:
  // Downside gap: DEMAND (below price) => demand gap invalidation
  // Overhead gap: SUPPLY (above price) => supply gap obstacle
  const gaps = [];
  // Try all possible field name aliases for downside gap
  const downsideGapObj = pickVal(gen, [
    '_downsideGap', 'downside_gap', 'demand_gap', 'nkDownsideGap',
    '_demandGap', 'demand_gap_lower', 'gap_downside'
  ]);
  const demandGap = mapRuntimeGap(downsideGapObj, 'DEMAND');
  // Try all possible field name aliases for overhead gap
  const overheadGapObj = pickVal(gen, [
    '_overheadGap', 'overhead_gap', 'supply_gap', 'nkOverheadGap',
    '_supplyGap', 'supply_gap_upper', 'gap_overhead'
  ]);
  const supplyGap = mapRuntimeGap(overheadGapObj, 'SUPPLY');
  if (demandGap) gaps.push(demandGap);
  if (supplyGap) gaps.push(supplyGap);

  noteField(structural, 'support', support);
  noteField(structural, 'local_support', localSupport);
  noteField(structural, 'major_support', majorSupport);
  noteField(structural, 'resistance', resistance);
  noteField(structural, 'local_resistance', localResistance);
  noteField(structural, 'major_resistance', majorResistance);
  noteField(structural, 'swing_low', swingLow);
  noteField(structural, 'next_resistance', nextResistance);
  noteField(structural, 'atr14', atr14);
  if (observations) structural.source_fields.push('observations');
  // Report candle-derived structure in source_fields.
  if (swingLowFromCandles !== null) structural.source_fields.push('confirmed_swing_low_from_candles');
  if (localResistanceFromCandles !== null) structural.source_fields.push('local_resistance_from_candles');
  if (nextResistanceFromCandles !== null) structural.source_fields.push('next_resistance_from_candles');
  // Report 20-day support as major_support (not local support).
  if (support !== null) structural.source_fields.push('support_as_major_support');
  // Record resistance_as_major_resistance whenever the plain base-screener
  // `resistance` is actually consumed by the engine as a MAJOR_RESISTANCE anchor.
  // This mirrors the engine's exact overhead classification (lib/trade-plan-v2.js):
  // a lone `resistance` is promoted to MAJOR_RESISTANCE when an explicit major OR
  // a local resistance is ALSO present (otherwise it stays a local obstacle).
  // Previously this only fired for an explicit `major_resistance` input — which the
  // swing adapters never populate — so the diagnostic under-reported the resistance
  // the engine really mapped to major_resistance. This corrects the DIAGNOSTIC ONLY
  // and never changes any numeric input passed to the engine.
  const resistanceMappedToMajor = resistance !== null &&
    (majorResistance !== null || localResistance !== null);
  if (resistanceMappedToMajor) structural.source_fields.push('resistance_as_major_resistance');
  // Report Non-Konglo runtime gaps.
  if (demandGap) structural.source_fields.push('_downsideGap');
  if (supplyGap) structural.source_fields.push('_overheadGap');
  structural.available = support !== null || localSupport !== null || majorSupport !== null || swingLow !== null || localResistance !== null || majorResistance !== null || demandGap !== null;

  const input = {
    ticker,
    entry_low: entryLow,
    entry_high: entryHigh,
    current_price: currentPrice,
    support,
    local_support: localSupport,
    major_support: majorSupport,
    swing_low: swingLow,
    resistance,
    local_resistance: localResistance,
    major_resistance: majorResistance,
    next_resistance: nextResistance,
    atr14,
    observations,
    gaps,
    freshness: pickVal(gen, ['freshness']),
    screener_type: 'SWING_NON_KONGLO'
  };
  return { input, structural };
}

// ---------------------------------------------------------------------------
// Generic stored-row adapter (used by the replay tool)
// ---------------------------------------------------------------------------
/**
 * Map an already-stored candidate row into the canonical V2 input, recognising
 * every support/resistance/swing/ATR/gap alias so structural availability is
 * detected honestly — WITHOUT ever deriving structure from the legacy SL/TP.
 */
function adaptStoredRow(screenerType, row) {
  const key = normalizeType(screenerType);
  if (key === 'DAY_TRADE') return adaptDayTrade({ scored: row, candidate: row });
  if (key === 'SWING_KONGLO') return adaptSwingKonglo({ row: row, candidate: row });
  if (key === 'SWING_NON_KONGLO') return adaptSwingNonKonglo({ scored: row, candidate: row });
  // Unknown type: still probe all common aliases generically.
  return adaptDayTrade({ scored: row, candidate: row });
}

function normalizeType(t) {
  const s = String(t || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (s.indexOf('DAY') >= 0) return 'DAY_TRADE';
  if (s.indexOf('NON') >= 0 && s.indexOf('KONGLO') >= 0) return 'SWING_NON_KONGLO';
  if (s.indexOf('KONGLO') >= 0) return 'SWING_KONGLO';
  return null;
}

/**
 * Dispatch to the correct adapter by screener type.
 * @returns {object} { input, structural }
 */
function adaptByScreenerType(screenerType, source) {
  const key = normalizeType(screenerType);
  if (key === 'DAY_TRADE') return adaptDayTrade(source);
  if (key === 'SWING_KONGLO') return adaptSwingKonglo(source);
  if (key === 'SWING_NON_KONGLO') return adaptSwingNonKonglo(source);
  // Unknown — best-effort generic probe from any provided object.
  const s = source || {};
  return adaptDayTrade({ analysis: s.analysis, scored: s.scored || s.candidate || s.row, candles: s.candles });
}

module.exports = {
  buildObservations,
  mapRuntimeGap,
  adaptDayTrade,
  adaptSwingKonglo,
  adaptSwingNonKonglo,
  adaptStoredRow,
  adaptByScreenerType,
  normalizeType
};
