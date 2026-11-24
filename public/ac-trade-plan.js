/**
 * public/ac-trade-plan.js
 * ============================================================================
 * TASK 5 — Official IDX tick fractions + ONE canonical trade-plan source.
 * ============================================================================
 *
 * This is the SINGLE source of truth for:
 *   1. IDX/BEI tick fractions:
 *        < 200        => Rp 1
 *        200 - 499    => Rp 2
 *        500 - 1.999  => Rp 5
 *        2.000 - 4.999 => Rp 10
 *        >= 5.000     => Rp 25
 *   2. Rounding any price level onto the official fraction.
 *   3. Deriving R/R from the ROUNDED levels (never from a stale metadata field).
 *   4. `acCanonicalTradePlan(row)` — the object BOTH the Top5/Top20 table and
 *      the right detail panel consume, so a mismatch is structurally impossible.
 *
 * UMD: works as `require('...')` in Node and as `window.acCanonicalTradePlan`
 * in the browser. No network, no provider calls, no DB access.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.AutoCuanTradePlan = api;
    // Global function name used by inline onclick / legacy renderers.
    root.acCanonicalTradePlan = api.acCanonicalTradePlan;
    root.idxTickSize = api.idxTickSize;
    root.roundToIdxTick = api.roundToIdxTick;
    root.isIdxTickValid = api.isIdxTickValid;
    root.rrFromLevels = api.rrFromLevels;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function () {
  'use strict';

  var EPS = 1e-9;

  /** Official IDX tick size for a price. */
  function idxTickSize(price) {
    var p = Number(price);
    if (!Number.isFinite(p)) return null;
    if (p < 200) return 1;
    if (p < 500) return 2;
    if (p < 2000) return 5;
    if (p < 5000) return 10;
    return 25;
  }

  /** True when `price` sits exactly on its band's official tick fraction. */
  function isIdxTickValid(price) {
    var p = Number(price);
    var t = idxTickSize(p);
    if (t == null || !Number.isFinite(p)) return false;
    var q = p / t;
    return Math.abs(q - Math.round(q)) < EPS;
  }

  /** Round to the nearest official tick (half away from zero). */
  function roundToIdxTick(price) {
    var p = Number(price);
    var t = idxTickSize(p);
    if (t == null) return null;
    var rounded = Math.round(p / t) * t;
    // A boundary crossing can land in a different band with a different tick.
    // Re-round at most 3 times; every IDX boundary is divisible by both
    // adjacent ticks, so this converges immediately in practice.
    for (var i = 0; i < 3 && !isIdxTickValid(rounded); i++) {
      rounded = Math.round(rounded / idxTickSize(rounded)) * idxTickSize(rounded);
    }
    return Number(rounded.toFixed(6));
  }

  /** Smallest on-tick price >= `price`. */
  function roundUpToIdxTick(price) {
    var p = Number(price);
    var t = idxTickSize(p);
    if (t == null) return null;
    var rounded = Math.ceil(p / t - EPS) * t;
    for (var i = 0; i < 3 && !isIdxTickValid(rounded); i++) {
      var nt = idxTickSize(rounded);
      rounded = Math.ceil(rounded / nt - EPS) * nt;
    }
    return Number(rounded.toFixed(6));
  }

  /** Largest on-tick price <= `price`. */
  function roundDownToIdxTick(price) {
    var p = Number(price);
    var t = idxTickSize(p);
    if (t == null) return null;
    var rounded = Math.floor(p / t + EPS) * t;
    for (var i = 0; i < 3 && !isIdxTickValid(rounded); i++) {
      var nt = idxTickSize(rounded);
      rounded = Math.floor(rounded / nt + EPS) * nt;
    }
    return Number(rounded.toFixed(6));
  }

  /** One official tick below `price`. */
  function tickBelow(price) {
    var p = Number(price);
    var t = idxTickSize(p);
    return t == null ? null : roundDownToIdxTick(p - t);
  }

  /** One official tick above `price`. */
  function tickAbove(price) {
    var p = Number(price);
    var t = idxTickSize(p);
    return t == null ? null : roundUpToIdxTick(p + t);
  }

  /** R/R derived from levels. Returns a 4-decimal number or null. */
  function rrFromLevels(entryHigh, sl, tp1) {
    var e = Number(entryHigh), s = Number(sl), t = Number(tp1);
    if (![e, s, t].every(Number.isFinite)) return null;
    if (!(e > s && s > 0 && t > e)) return null;
    var rr = (t - e) / (e - s);
    return Number.isFinite(rr) && rr > 0 ? Number(rr.toFixed(4)) : null;
  }

  function finiteOrNull(v) {
    var n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * THE canonical plan object. Every table cell and every detail-panel cell
   * for prices / Entry / SL / TP1 / TP2 / R:R must come from this one object.
   *
   * Stale metadata (`risk_reward`, `rr`, `rr_at_max_entry`) is IGNORED: R/R is
   * always recomputed from the rounded levels so the two surfaces cannot drift.
   */
  function acCanonicalTradePlan(row) {
    if (!row || typeof row !== 'object') return null;

    var lastPrice = finiteOrNull(row.last_price != null ? row.last_price
      : (row.close != null ? row.close : row.current_price));

    var rawLow = finiteOrNull(row.entry_low != null ? row.entry_low
      : (row.entry2 != null ? row.entry2 : row.buy_low));
    var rawHigh = finiteOrNull(row.entry_high != null ? row.entry_high
      : (row.entry1 != null ? row.entry1 : (row.entry != null ? row.entry : row.buy_high)));
    if (rawLow == null) rawLow = lastPrice;
    if (rawHigh == null) rawHigh = lastPrice;

    var entryLow = roundToIdxTick(rawLow);
    var entryHigh = roundToIdxTick(rawHigh);
    if (entryLow == null || entryHigh == null) return null;
    if (entryLow > entryHigh) {
      var swap = entryLow; entryLow = entryHigh; entryHigh = swap;
    }

    var rawSl = finiteOrNull(row.sl != null ? row.sl : row.stop_loss);
    var rawTp1 = finiteOrNull(row.tp1 != null ? row.tp1 : row.tp);
    var rawTp2 = finiteOrNull(row.tp2);

    var sl = rawSl == null ? null : roundToIdxTick(rawSl);
    var tp1 = rawTp1 == null ? null : roundToIdxTick(rawTp1);
    var tp2 = rawTp2 == null ? null : roundToIdxTick(rawTp2);

    // Enforce structural ordering on the tick grid (never publish an invalid
    // plan just because rounding collapsed two levels onto the same tick).
    if (sl != null && !(sl < entryHigh)) sl = tickBelow(entryHigh);
    if (tp1 != null && !(tp1 > entryHigh)) tp1 = tickAbove(entryHigh);
    if (tp2 != null && tp1 != null && !(tp2 > tp1)) tp2 = tickAbove(tp1);

    var rr = rrFromLevels(entryHigh, sl, tp1);

    return {
      ticker: row.ticker || null,
      last_price: lastPrice == null ? null : roundToIdxTick(lastPrice),
      entry_low: entryLow,
      entry_high: entryHigh,
      sl: sl,
      tp1: tp1,
      tp2: tp2,
      rr: rr,
      rr_display: rr == null ? null : Number(rr.toFixed(2)),
      tick_size: idxTickSize(entryHigh),
      source: 'acCanonicalTradePlan/idx-tick/v1'
    };
  }

  return {
    idxTickSize: idxTickSize,
    isIdxTickValid: isIdxTickValid,
    roundToIdxTick: roundToIdxTick,
    roundUpToIdxTick: roundUpToIdxTick,
    roundDownToIdxTick: roundDownToIdxTick,
    tickBelow: tickBelow,
    tickAbove: tickAbove,
    rrFromLevels: rrFromLevels,
    acCanonicalTradePlan: acCanonicalTradePlan
  };
});
