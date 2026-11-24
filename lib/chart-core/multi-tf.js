'use strict';

// F2 advanced detector: multi-timeframe alignment.
// Given detector results on 2-3 timeframes (e.g. 1D + 1W), compute:
//   - trend structure alignment (same direction)
//   - S/R confluence (zones within tolerance)
//   - divergence agreement
// NO fake intraday: only the TFs provided are evaluated; requested-but-
// missing TFs are reported as TIMEFRAME_DATA_UNAVAILABLE — never synthesized.

const VERSION = 'chart-core-multi-tf-v1';

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

/**
 * Compute multi-timeframe alignment.
 * @param {object} inputs
 *   inputs.timeframes: Array<{tf:string, data:object|null}> where data:
 *     { trend:'up'|'down'|'range',
 *       srZones?: Array<{top:number,bottom:number}>,
 *       divergence?: 'bullish'|'bearish'|null }
 *   inputs.requested: Array<string> all TFs the caller wants (optional).
 *   inputs.zoneTolerancePct: relative tolerance for S/R confluence (default 0.01)
 * @returns {{aligned:boolean, agreements:Array, conflicts:Array,
 *            unavailable:Array<{tf, reason:'TIMEFRAME_DATA_UNAVAILABLE'}>}}
 */
function computeAlignment(inputs) {
  if (!inputs || !Array.isArray(inputs.timeframes)) {
    throw new Error('timeframes array required');
  }
  var tolerance = isNum(inputs.zoneTolerancePct) ? inputs.zoneTolerancePct : 0.01;
  var agreements = [];
  var conflicts = [];
  var unavailable = [];

  var provided = inputs.timeframes.filter(function (t) {
    return t && t.tf && t.data;
  });
  inputs.timeframes.forEach(function (t) {
    if (!t || !t.tf) return;
    if (!t.data) {
      unavailable.push({ tf: t.tf, reason: 'TIMEFRAME_DATA_UNAVAILABLE' });
    }
  });

  // Requested-but-not-provided TFs are also unavailable (never synthesized).
  if (Array.isArray(inputs.requested)) {
    inputs.requested.forEach(function (tf) {
      var found = inputs.timeframes.some(function (t) { return t && t.tf === tf; });
      if (!found) unavailable.push({ tf: tf, reason: 'TIMEFRAME_DATA_UNAVAILABLE' });
    });
  }

  if (provided.length < 2) {
    return {
      aligned: false,
      agreements: agreements,
      conflicts: conflicts,
      unavailable: unavailable,
      note: 'INSUFFICIENT_TIMEFRAMES'
    };
  }

  // ---- Trend structure alignment ----
  var trends = provided.map(function (t) { return { tf: t.tf, trend: t.data.trend || 'range' }; });
  var directional = trends.filter(function (t) { return t.trend === 'up' || t.trend === 'down'; });
  if (directional.length >= 2) {
    var allSame = directional.every(function (t) { return t.trend === directional[0].trend; });
    if (allSame) {
      agreements.push({
        kind: 'trend',
        direction: directional[0].trend,
        timeframes: directional.map(function (t) { return t.tf; })
      });
    } else {
      conflicts.push({
        kind: 'trend',
        detail: directional
      });
    }
  }

  // ---- S/R confluence: zones within tolerance across TFs ----
  var withZones = provided.filter(function (t) {
    return Array.isArray(t.data.srZones) && t.data.srZones.length > 0;
  });
  for (var i = 0; i < withZones.length; i += 1) {
    for (var j = i + 1; j < withZones.length; j += 1) {
      var a = withZones[i], b = withZones[j];
      a.data.srZones.forEach(function (za) {
        b.data.srZones.forEach(function (zb) {
          var mid = (za.top + za.bottom + zb.top + zb.bottom) / 4;
          if (mid <= 0) return;
          var overlap = za.bottom <= zb.top && zb.bottom <= za.top;
          var near = Math.abs(za.top - zb.top) / mid <= tolerance &&
                     Math.abs(za.bottom - zb.bottom) / mid <= tolerance;
          if (overlap || near) {
            agreements.push({
              kind: 'sr-confluence',
              timeframes: [a.tf, b.tf],
              zone: {
                top: Math.min(za.top, zb.top),
                bottom: Math.max(za.bottom, zb.bottom)
              }
            });
          }
        });
      });
    }
  }

  // ---- Divergence agreement ----
  var withDiv = provided.filter(function (t) {
    return t.data.divergence === 'bullish' || t.data.divergence === 'bearish';
  });
  if (withDiv.length >= 2) {
    var allSameDiv = withDiv.every(function (t) { return t.data.divergence === withDiv[0].data.divergence; });
    if (allSameDiv) {
      agreements.push({
        kind: 'divergence',
        direction: withDiv[0].data.divergence,
        timeframes: withDiv.map(function (t) { return t.tf; })
      });
    } else {
      conflicts.push({
        kind: 'divergence',
        detail: withDiv.map(function (t) { return { tf: t.tf, divergence: t.data.divergence }; })
      });
    }
  }

  var aligned = conflicts.length === 0 && agreements.length > 0;
  return {
    aligned: aligned,
    agreements: agreements,
    conflicts: conflicts,
    unavailable: unavailable
  };
}

module.exports = { VERSION: VERSION, computeAlignment: computeAlignment };
