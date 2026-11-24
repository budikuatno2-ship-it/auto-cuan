'use strict';

// F1 barrel export + shared candle validator (CHT-01/28 support).

const VERSION = 'chart-core-v1';

const pivots = require('./pivots');
const zigzag = require('./zigzag');
const supportResistance = require('./support-resistance');
const trendlines = require('./trendlines');
const fibonacci = require('./fibonacci');
const gaps = require('./gaps');
const divergence = require('./divergence');
const oscillators = require('./oscillators');
const candlestickPatterns = require('./candlestick-patterns');
const fvg = require('./fvg');
const smcStructure = require('./smc-structure');
const smcOrderBlocks = require('./smc-order-blocks');
const classicalPatterns = require('./classical-patterns');
const harmonic = require('./harmonic');
const elliott = require('./elliott');
const lifecycle = require('./lifecycle');
const multiTf = require('./multi-tf');

/**
 * Validate OHLCV candles.
 * Rules: high >= max(open, close); low <= min(open, close); volume >= 0
 * (null volume allowed but flagged); time monotonic non-decreasing.
 * @param {Array} candles
 * @returns {{valid:boolean, errors:string[], flags:string[]}}
 */
function validateCandles(candles) {
  var errors = [];
  var flags = [];
  var arr = Array.isArray(candles) ? candles : [];

  arr.forEach(function (c, i) {
    if (!c || typeof c !== 'object') {
      errors.push('bar ' + i + ': not an object');
      return;
    }
    var o = c.open, h = c.high, l = c.low, cl = c.close;
    if (![o, h, l, cl].every(function (v) { return typeof v === 'number' && Number.isFinite(v); })) {
      errors.push('bar ' + i + ': non-numeric OHLC');
      return;
    }
    if (h < Math.max(o, cl)) errors.push('bar ' + i + ': high < max(open,close)');
    if (l > Math.min(o, cl)) errors.push('bar ' + i + ': low > min(open,close)');
    if (h < l) errors.push('bar ' + i + ': high < low');
    if (c.volume === null || c.volume === undefined) {
      flags.push('bar ' + i + ': null volume');
    } else if (typeof c.volume === 'number' && c.volume < 0) {
      errors.push('bar ' + i + ': negative volume');
    } else if (typeof c.volume !== 'number') {
      errors.push('bar ' + i + ': non-numeric volume');
    }
    if (i > 0) {
      var prevTime = arr[i - 1] && arr[i - 1].time;
      if (prevTime !== undefined && c.time !== undefined && c.time < prevTime) {
        errors.push('bar ' + i + ': time not monotonic');
      }
    }
  });

  return { valid: errors.length === 0, errors: errors, flags: flags };
}

module.exports = {
  VERSION: VERSION,
  validateCandles: validateCandles,
  pivots: pivots,
  zigzag: zigzag,
  supportResistance: supportResistance,
  trendlines: trendlines,
  fibonacci: fibonacci,
  gaps: gaps,
  divergence: divergence,
  oscillators: oscillators,
  candlestickPatterns: candlestickPatterns,
  fvg: fvg,
  smcStructure: smcStructure,
  smcOrderBlocks: smcOrderBlocks,
  classicalPatterns: classicalPatterns,
  harmonic: harmonic,
  elliott: elliott,
  lifecycle: lifecycle,
  multiTf: multiTf
};
