'use strict';

/**
 * Chart Engine — Volume Analyzer
 *
 * Pure volume math: MA20 volume and Relative Volume (RVOL), plus a surge
 * ratio used as breakout confirmation. No I/O.
 */

/**
 * Simple moving average of volumes.
 * @param {number[]} volumes oldest-first
 * @param {number} period
 * @returns {number|null}
 */
function maVolume(volumes, period) {
  if (!Array.isArray(volumes) || volumes.length < period || period <= 0) return null;
  var slice = volumes.slice(-period);
  var sum = 0;
  for (var i = 0; i < slice.length; i += 1) {
    var v = Number(slice[i]);
    if (!Number.isFinite(v)) return null;
    sum += v;
  }
  return sum / period;
}

/**
 * Relative Volume: latest volume / MA20(volume).
 * @param {number[]} volumes oldest-first
 * @param {number} period
 * @returns {number|null}
 */
function relativeVolume(volumes, period) {
  var p = period || 20;
  if (!Array.isArray(volumes) || volumes.length < p) return null;
  var avg = maVolume(volumes, p);
  var last = Number(volumes[volumes.length - 1]);
  if (!avg || avg <= 0 || !Number.isFinite(last)) return null;
  return last / avg;
}

/**
 * Volume surge classification used as breakout confirmation.
 * @param {number|null} rvol
 * @returns {{surge_score:number, is_surge:boolean, label:string}}
 */
function volumeSurge(rvol) {
  var v = Number(rvol);
  if (!Number.isFinite(v) || v < 1.0) return { surge_score: 0, is_surge: false, label: 'NORMAL' };
  if (v >= 2.0) return { surge_score: 30, is_surge: true, label: 'STRONG_SURGE' };
  if (v >= 1.5) return { surge_score: 20, is_surge: true, label: 'SURGE' };
  if (v >= 1.25) return { surge_score: 10, is_surge: true, label: 'MILD_SURGE' };
  return { surge_score: 0, is_surge: false, label: 'NORMAL' };
}

/**
 * Convenience: analyze a candle array in one call.
 * @param {Array<{volume:number}>} candles oldest-first
 * @returns {{ma20:number|null, rvol:number|null, surge_score:number, is_surge:boolean, label:string}}
 */
function analyze(candles) {
  var volumes = Array.isArray(candles) ? candles.map(function (c) { return Number(c && c.volume); }) : [];
  var rvol = relativeVolume(volumes, 20);
  var surge = volumeSurge(rvol);
  return { ma20: maVolume(volumes, 20), rvol: rvol, surge_score: surge.surge_score, is_surge: surge.is_surge, label: surge.label };
}

module.exports = { maVolume, relativeVolume, volumeSurge, analyze };
