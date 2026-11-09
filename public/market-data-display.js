/**
 * public/market-data-display.js
 * ============================================================================
 * V5 P0-010 / P0-011 — ONE display helper for volume and foreign flow
 * ============================================================================
 *
 * WHY THIS FILE EXISTS
 *   BUG-V5-P0-010: `unified-cockpit-runtime.js` labelled a raw share count
 *   `"N lot"` while `chart-workstation.js` labelled the same number
 *   `"N lembar"` — a silent 100x disagreement between two widgets showing one
 *   ticker.
 *   BUG-V5-P0-011: a missing foreign-flow value was rendered `Rp 0`, which is
 *   indistinguishable from a genuinely measured zero.
 *
 *   Both bugs are unit/absence bugs, so both are fixed in one place and every
 *   renderer calls it.
 *
 * CONTRACT
 *   - Canonical internal volume unit is RAW SHARES (lembar), which is what
 *     `api/candles.js` publishes. 1 lot = 100 shares (BEI).
 *   - A volume label always describes the unit the number actually is:
 *       unit SHARES  -> "17,61 Jt lembar"
 *       unit LOTS    -> "176,1 Rb lot"  (and shareCount is the x100 value)
 *       unit UNKNOWN -> "17,61 Jt (satuan tidak diketahui)" + data_status
 *   - Missing is `null`. A missing foreign-flow value renders `'—'` with an
 *     explicit status. `0` renders `Rp 0` ONLY when the producer accompanied it
 *     with an explicit `AVAILABLE` status, because a bare `0` is exactly what
 *     the old `value || 0` defect produced.
 *
 * SINGLE SOURCE OF TRUTH
 *   In Node (tests, server) this module delegates to
 *   `lib/market-data-contract.js`. In the browser it runs the inline
 *   implementation below. `test/v5/volume-unit.test.js` compares the two
 *   implementations across a unit x magnitude matrix, so they cannot drift.
 * ============================================================================
 */

(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module && module.exports) {
    module.exports = factory(root);
    return;
  }
  if (root) root.AutoCuanMarketDataDisplay = factory(root);
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function (root) {
  'use strict';

  var UNKNOWN_DISPLAY = '\u2014';
  var SHARES_PER_LOT = 100;

  var VOLUME_UNIT = Object.freeze({
    SHARES: 'SHARES',
    LOTS: 'LOTS',
    UNKNOWN: 'UNKNOWN'
  });

  var DATA_STATUS = Object.freeze({
    AVAILABLE: 'AVAILABLE',
    PARTIAL: 'PARTIAL',
    STALE: 'STALE',
    NOT_PUBLISHED: 'NOT_PUBLISHED',
    SOURCE_UNAVAILABLE: 'SOURCE_UNAVAILABLE',
    VALIDATION_FAILED: 'VALIDATION_FAILED',
    QUARANTINED: 'QUARANTINED'
  });

  // Node: use the canonical implementation so there is exactly one behaviour.
  var canonical = null;
  if (typeof module === 'object' && module && module.exports) {
    try {
      canonical = require('../lib/market-data-contract.js');
    } catch (_) {
      canonical = null;
    }
  }

  function toNumberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
      var t = value.trim();
      if (!t) return null;
      var n = Number(t);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  function normalizeVolumeUnit(unit) {
    if (typeof unit !== 'string') return VOLUME_UNIT.SHARES;
    var token = unit.trim().toUpperCase();
    if (token === 'LOTS' || token === 'LOT') return VOLUME_UNIT.LOTS;
    if (token === '' || token === 'UNKNOWN') return VOLUME_UNIT.UNKNOWN;
    if (token === 'SHARES' || token === 'LEMBAR' || token === 'SHARE') return VOLUME_UNIT.SHARES;
    return VOLUME_UNIT.UNKNOWN;
  }

  function compactMagnitude(n) {
    var abs = Math.abs(n);
    var sign = n < 0 ? '\u2212' : '';
    if (abs >= 1e12) return sign + (abs / 1e12).toFixed(2).replace('.', ',') + ' T';
    if (abs >= 1e9) return sign + (abs / 1e9).toFixed(2).replace('.', ',') + ' Mrd';
    if (abs >= 1e6) return sign + (abs / 1e6).toFixed(2).replace('.', ',') + ' Jt';
    if (abs >= 1e3) return sign + (abs / 1e3).toFixed(1).replace('.', ',') + ' Rb';
    return sign + String(Math.round(abs));
  }

  function sharesToLots(shares) {
    var n = toNumberOrNull(shares);
    return n === null ? null : n / SHARES_PER_LOT;
  }

  function lotsToShares(lots) {
    var n = toNumberOrNull(lots);
    return n === null ? null : n * SHARES_PER_LOT;
  }

  /**
   * Describe a volume value together with the unit it really carries.
   * @param {*} value
   * @param {{unit?: string}} [options]
   * @returns {{display:string, unit:string, unitLabel:string|null,
   *            shareCount:number|null, lotCount:number|null,
   *            dataStatus:string, isKnown:boolean}}
   */
  function describeVolume(value, options) {
    var opts = options && typeof options === 'object' ? options : {};
    var unit = normalizeVolumeUnit(opts.unit === undefined ? VOLUME_UNIT.SHARES : opts.unit);
    var n = toNumberOrNull(value);

    if (n === null) {
      return {
        display: UNKNOWN_DISPLAY, unit: unit, unitLabel: null,
        shareCount: null, lotCount: null,
        dataStatus: DATA_STATUS.NOT_PUBLISHED, isKnown: false
      };
    }

    if (unit === VOLUME_UNIT.LOTS) {
      return {
        display: compactMagnitude(n) + ' lot', unit: unit, unitLabel: 'lot',
        shareCount: n * SHARES_PER_LOT, lotCount: n,
        dataStatus: DATA_STATUS.AVAILABLE, isKnown: true
      };
    }

    if (unit === VOLUME_UNIT.UNKNOWN) {
      // A real number whose unit the source never stated. Guessing "lembar"
      // would recreate P0-010 with a confident-looking wrong label.
      return {
        display: compactMagnitude(n) + ' (satuan tidak diketahui)', unit: unit, unitLabel: null,
        shareCount: null, lotCount: null,
        dataStatus: DATA_STATUS.PARTIAL, isKnown: true
      };
    }

    return {
      display: compactMagnitude(n) + ' lembar', unit: unit, unitLabel: 'lembar',
      shareCount: n, lotCount: n / SHARES_PER_LOT,
      dataStatus: DATA_STATUS.AVAILABLE, isKnown: true
    };
  }

  /**
   * Volume display string. Default unit SHARES (no lot division).
   * @param {*} value
   * @param {{unit?: string}} [options]
   * @returns {string}
   */
  function formatVolume(value, options) {
    return describeVolume(value, options).display;
  }

  /**
   * Foreign flow: missing is not zero.
   *
   * @param {*} value raw net (rupiah), or `null` when nothing was published
   * @param {{status?: string}} [options] explicit provenance
   * @returns {{display:string, dataStatus:string, isKnown:boolean, value:number|null}}
   */
  function describeForeignFlow(value, options) {
    var opts = options && typeof options === 'object' ? options : {};
    var status = typeof opts.status === 'string' ? opts.status.trim().toUpperCase() : null;
    var n = toNumberOrNull(value);

    if (n === null) {
      return {
        display: UNKNOWN_DISPLAY,
        dataStatus: status || DATA_STATUS.NOT_PUBLISHED,
        isKnown: false,
        value: null
      };
    }

    if (n === 0 && !status) {
      // A bare 0 cannot be told apart from the old `|| 0` default. Demand an
      // explicit status before claiming a measured zero.
      return {
        display: UNKNOWN_DISPLAY,
        dataStatus: DATA_STATUS.NOT_PUBLISHED,
        isKnown: false,
        value: null
      };
    }

    var idr = canonical ? canonical.formatIDR(n) : compactRupiah(n);
    return {
      display: idr,
      dataStatus: status || DATA_STATUS.AVAILABLE,
      isKnown: true,
      value: n
    };
  }

  /** Compact signed rupiah, used only when the canonical module is absent. */
  function compactRupiah(n) {
    var abs = Math.abs(n);
    var sign = n < 0 ? '\u2212' : '';
    if (abs >= 1e12) return sign + 'Rp ' + (abs / 1e12).toFixed(2) + ' T';
    if (abs >= 1e9) return sign + 'Rp ' + (abs / 1e9).toFixed(2) + ' M';
    if (abs >= 1e6) return sign + 'Rp ' + (abs / 1e6).toFixed(1) + ' jt';
    return sign + 'Rp ' + Math.round(abs).toLocaleString('id-ID');
  }

  /** Foreign-flow display string. Missing renders `'—'`, never `Rp 0`. */
  function formatForeignFlow(value, options) {
    return describeForeignFlow(value, options).display;
  }

  return {
    UNKNOWN_DISPLAY: UNKNOWN_DISPLAY,
    SHARES_PER_LOT: SHARES_PER_LOT,
    VOLUME_UNIT: VOLUME_UNIT,
    DATA_STATUS: DATA_STATUS,
    normalizeVolumeUnit: normalizeVolumeUnit,
    sharesToLots: sharesToLots,
    lotsToShares: lotsToShares,
    describeVolume: describeVolume,
    formatVolume: formatVolume,
    describeForeignFlow: describeForeignFlow,
    formatForeignFlow: formatForeignFlow
  };
});