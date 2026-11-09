'use strict';

/**
 * lib/market-data-contract.js
 * ============================================================================
 * V5 P0 — SENTINEL + PROVENANCE CONTRACT for market data
 * ============================================================================
 *
 * ROOT CAUSE THIS MODULE EXISTS TO REMOVE
 *   A "plausible default" (`value || 1550`, `|| 82`, `|| 72.5`, `|| 2.0`) was
 *   substituted wherever a datum was unknown. Because `0` is falsy in JS, the
 *   same construct also destroyed genuine zeros. The result was an application
 *   that could not distinguish "the market said 0" from "nobody read the
 *   market" — and that emitted invented prices, scores and trade plans.
 *
 * THE CONTRACT (binding on every consumer)
 *   1. Unknown is `null` and only `null`. Never a believable number.
 *   2. `0`, `false`-free numerics, and `0.0` ARE known values and must survive.
 *   3. A value that survived must carry provenance (source + trade date).
 *   4. A value that cannot be validated must be quarantined, not published.
 *
 * DESIGN NOTES
 *   - No I/O. No dependency other than the Node standard library.
 *   - `Object.freeze` on the status vocabulary so a typo cannot silently
 *     invent a new state that no consumer understands.
 *   - Formatters return `'—'` (U+2014) for unknown and NEVER collapse a known
 *     `0` into the unknown marker (that is the P0-011 defect class).
 * ============================================================================
 */

/* -------------------------------------------------------------------------- */
/* Status vocabulary                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Canonical data-status vocabulary.
 *
 * AVAILABLE            read from a real source and structurally valid
 * PARTIAL              read from a real source but one or more fields absent
 * STALE                real, but the source trade date is older than today
 * NOT_PUBLISHED        the producer published nothing for this dataset
 * SOURCE_UNAVAILABLE   the source file could not be read at all
 * VALIDATION_FAILED    the row was read but violates a structural invariant
 * QUARANTINED          real, but deliberately withheld from publication
 */
const DATA_STATUS = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  PARTIAL: 'PARTIAL',
  STALE: 'STALE',
  NOT_PUBLISHED: 'NOT_PUBLISHED',
  SOURCE_UNAVAILABLE: 'SOURCE_UNAVAILABLE',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  QUARANTINED: 'QUARANTINED'
});

/** Single canonical sentinel for "no known value". */
const UNKNOWN = null;

/** Rendering of an unknown value. Never a fabricated number, never `0`. */
const UNKNOWN_DISPLAY = '\u2014';

/**
 * Constants proven to be fabricated in `audit-evidence/v5/V5_CODE_TRACE_P0.md`.
 * Used ONLY to refuse an *unbacked* value, never to reject a real one: a real
 * source row legitimately contains 1550 (DSNG) and 1420 (a genuine daytrade
 * price elsewhere), so provenance always wins.
 */
const SYNTHETIC_PRICE_CONSTANTS = Object.freeze([1550, 1420, 380, 1000, 9860, 7480, 5000]);

const KNOWN_STATUS_VALUES = Object.freeze(Object.keys(DATA_STATUS).map((k) => DATA_STATUS[k]));

/* -------------------------------------------------------------------------- */
/* Sentinels                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * True only for a finite number or a non-empty (after trim) string.
 * `0` and `0.0` ARE known. `null`, `undefined`, `NaN`, `''`, `[]` are not.
 *
 * @param {*} value
 * @returns {boolean}
 */
function isKnown(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.trim().length > 0;
  return false;
}

/**
 * The single canonical sentinel. Always `null` — callers must never invent an
 * alternative such as `0`, `-1`, or `'N/A'` for a financial field.
 *
 * @returns {null}
 */
function unknown() {
  return UNKNOWN;
}

/**
 * Coerce to a finite number, or `null` when genuinely unknown.
 * `0` is preserved (the P1-023 fix: `value || CONSTANT` conflated 0 with absent).
 *
 * @param {*} value
 * @returns {number|null}
 */
function numberOrNull(value) {
  if (!isKnown(value)) return UNKNOWN;
  const n = Number(value);
  return Number.isFinite(n) ? n : UNKNOWN;
}

/** True only for a known, finite numeric value. */
function isKnownNumber(value) {
  return numberOrNull(value) !== null;
}

/**
 * First KNOWN value in the argument list, else `null`.
 * NEVER returns a fabricated constant: this is the drop-in replacement for the
 * `a || b || 82` anti-pattern.
 *
 * @param {...*} values
 * @returns {*} known value or null
 */
function pick() {
  for (let i = 0; i < arguments.length; i += 1) {
    const candidate = arguments[i];
    if (isKnown(candidate)) return candidate;
  }
  return UNKNOWN;
}

/**
 * First known *numeric* value, else null. Convenience over `pick` + `Number`.
 *
 * @param {...*} values
 * @returns {number|null}
 */
function pickNumber() {
  for (let i = 0; i < arguments.length; i += 1) {
    const n = numberOrNull(arguments[i]);
    if (n !== null) return n;
  }
  return UNKNOWN;
}

/**
 * First known non-empty *text* value, else null.
 *
 * @param {...*} values
 * @returns {string|null}
 */
function pickText() {
  for (let i = 0; i < arguments.length; i += 1) {
    const candidate = arguments[i];
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
  }
  return UNKNOWN;
}

/* -------------------------------------------------------------------------- */
/* Formatters — reuse the conventions already present in the repository       */
/* -------------------------------------------------------------------------- */

/**
 * Institutional price: `Rp 5.425` (mirrors `public/screener-v2.js` `px()` plus the
 * `'Rp '` prefix applied by its call sites). Unknown renders `'—'`.
 */
function formatPrice(value) {
  const n = numberOrNull(value);
  if (n === null) return UNKNOWN_DISPLAY;
  return 'Rp ' + Math.round(n).toLocaleString('id-ID');
}

/**
 * Signed percentage with Indonesian decimal separator, 2 dp
 * (mirrors `public/screener-v2.js` `pct()`). A known zero renders `0,00%`.
 */
function formatPercent(value) {
  const n = numberOrNull(value);
  if (n === null) return UNKNOWN_DISPLAY;
  const body = Math.abs(n).toLocaleString('id-ID', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  const sign = n > 0 ? '+' : (n < 0 ? '\u2212' : '');
  return sign + body + '%';
}

/**
 * Compact rupiah magnitude (mirrors `lib/foreign-flow-recap.js` `formatIDR()`).
 * A known zero renders `Rp 0`; only an unknown value renders `'—'`.
 */
function formatIDR(value) {
  const n = numberOrNull(value);
  if (n === null) return UNKNOWN_DISPLAY;
  const abs = Math.abs(n);
  const sign = n < 0 ? '\u2212' : '';
  if (abs >= 1e12) return sign + 'Rp ' + (abs / 1e12).toFixed(2) + ' T';
  if (abs >= 1e9) return sign + 'Rp ' + (abs / 1e9).toFixed(2) + ' M';
  if (abs >= 1e6) return sign + 'Rp ' + (abs / 1e6).toFixed(1) + ' jt';
  return sign + 'Rp ' + Math.round(abs).toLocaleString('id-ID');
}

/* -------------------------------------------------------------------------- */
/* Volume unit contract (BUG-V5-P0-010)                                       */
/* -------------------------------------------------------------------------- */

/**
 * Volume units. BEI trades in lots; 1 lot = 100 shares (lembar). Mixing the two
 * is the P0-010 defect class: the same stored number was labelled `lot` by the
 * cockpit card and `lembar` by the chart workstation, so the two widgets
 * disagreed by a factor of 100 for one ticker.
 */
const VOLUME_UNIT = Object.freeze({
  /** Raw vendor/BEI share count. THE canonical internal unit. */
  SHARES: 'SHARES',
  /** Lot count. Only valid when the source explicitly reported lots. */
  LOTS: 'LOTS',
  /** The source did not state a unit. Never guess; render an explicit marker. */
  UNKNOWN: 'UNKNOWN'
});

/** 1 lot = 100 shares (BEI). */
const SHARES_PER_LOT = 100;

function sharesToLots(shares) {
  const n = numberOrNull(shares);
  return n === null ? UNKNOWN : n / SHARES_PER_LOT;
}

function lotsToShares(lots) {
  const n = numberOrNull(lots);
  return n === null ? UNKNOWN : n * SHARES_PER_LOT;
}

/**
 * Normalise a caller-supplied unit token.
 *
 * Defaults to `SHARES` (the canonical internal unit) when no unit is supplied,
 * because `api/candles.js` publishes share counts. `'LEMBAR'`/`'SHARE'` are
 * accepted as synonyms of `SHARES`, `'LOT'` of `LOTS`, and an empty string
 * means "the source did not state one" (`UNKNOWN`).
 *
 * Mirrors `normalizeVolumeUnit()` in `public/chart-workstation.js` exactly;
 * `test/v5/volume-unit.test.js` asserts the parity.
 */
function normalizeVolumeUnit(unit) {
  if (typeof unit !== 'string') return VOLUME_UNIT.SHARES;
  const token = unit.trim().toUpperCase();
  if (token === VOLUME_UNIT.LOTS || token === 'LOT') return VOLUME_UNIT.LOTS;
  if (token === '' || token === VOLUME_UNIT.UNKNOWN) return VOLUME_UNIT.UNKNOWN;
  if (token === VOLUME_UNIT.SHARES || token === 'LEMBAR' || token === 'SHARE') return VOLUME_UNIT.SHARES;
  return VOLUME_UNIT.UNKNOWN;
}

/** Compact magnitude without a unit suffix (`17,61 Jt`). */
function compactMagnitude(n) {
  const abs = Math.abs(n);
  const sign = n < 0 ? '\u2212' : '';
  if (abs >= 1e9) return sign + (abs / 1e9).toFixed(2).replace('.', ',') + ' Mrd';
  if (abs >= 1e6) return sign + (abs / 1e6).toFixed(2).replace('.', ',') + ' Jt';
  if (abs >= 1e3) return sign + (abs / 1e3).toFixed(1).replace('.', ',') + ' Rb';
  return sign + String(Math.round(abs));
}

/**
 * Describe a volume value: the rendered text, the unit that was actually
 * assumed, the equivalent share/lot counts, and the data status.
 *
 * The label ALWAYS follows the unit the number really carries:
 *   - `SHARES`  -> `... lembar` (no division; shares are shown as shares)
 *   - `LOTS`    -> `... lot`, plus the share equivalent in `shareCount`
 *   - `UNKNOWN` -> `... (satuan tidak diketahui)` and `data_status: PARTIAL`
 *
 * @param {*} value
 * @param {{unit?: string}} [options]
 * @returns {{display:string, unit:string, unitLabel:string|null,
 *            shareCount:number|null, lotCount:number|null,
 *            dataStatus:string, isKnown:boolean}}
 */
function describeVolume(value, options) {
  const opts = options || {};
  const unit = normalizeVolumeUnit(opts.unit === undefined ? VOLUME_UNIT.SHARES : opts.unit);
  const n = numberOrNull(value);

  if (n === null) {
    return {
      display: UNKNOWN_DISPLAY,
      unit,
      unitLabel: null,
      shareCount: UNKNOWN,
      lotCount: UNKNOWN,
      dataStatus: DATA_STATUS.NOT_PUBLISHED,
      isKnown: false
    };
  }

  if (unit === VOLUME_UNIT.LOTS) {
    return {
      display: compactMagnitude(n) + ' lot',
      unit,
      unitLabel: 'lot',
      shareCount: lotsToShares(n),
      lotCount: n,
      dataStatus: DATA_STATUS.AVAILABLE,
      isKnown: true
    };
  }

  if (unit === VOLUME_UNIT.UNKNOWN) {
    // The number is real but the unit is not stated. Never invent "lembar".
    return {
      display: compactMagnitude(n) + ' (satuan tidak diketahui)',
      unit,
      unitLabel: null,
      shareCount: UNKNOWN,
      lotCount: UNKNOWN,
      dataStatus: DATA_STATUS.PARTIAL,
      isKnown: true
    };
  }

  return {
    display: compactMagnitude(n) + ' lembar',
    unit,
    unitLabel: 'lembar',
    shareCount: n,
    lotCount: sharesToLots(n),
    dataStatus: DATA_STATUS.AVAILABLE,
    isKnown: true
  };
}

/**
 * Share volume in *lembar* (mirrors `public/chart-workstation.js`
 * `formatIndonesianVolumeCompact()`). The default unit is SHARES because
 * `api/candles.js` passes shares through. Pass `{ unit: 'LOTS' }` for a lot
 * count and `{ unit: 'UNKNOWN' }` when the source did not state one.
 *
 * Never applies a lot/shares division to a share count: a raw share count is
 * never labelled `lot`.
 */
function formatVolume(value, options) {
  return describeVolume(value, options).display;
}

/* -------------------------------------------------------------------------- */
/* Foreign flow: missing is not zero (BUG-V5-P0-011)                          */
/* -------------------------------------------------------------------------- */

/**
 * Statuses that mean "there is no published value". A value carrying one of
 * these must render the absence marker, never `Rp 0`.
 */
const ABSENCE_STATUSES = Object.freeze([
  DATA_STATUS.NOT_PUBLISHED,
  DATA_STATUS.SOURCE_UNAVAILABLE,
  DATA_STATUS.VALIDATION_FAILED,
  DATA_STATUS.QUARANTINED
]);

/**
 * Describe a foreign-flow net value.
 *
 * CONTRACT (the exact P0-011 defect this removes):
 *   - missing / not published / unavailable  -> `'—'` + `dataStatus`
 *   - explicitly measured zero               -> `'Rp 0'` + `AVAILABLE`
 *
 * `0` is therefore a real market fact; `null` is the only absence sentinel.
 * Accepts a bare value or `{ value, data_status }`.
 *
 * @param {*} value
 * @param {{status?: string}} [options]
 * @returns {{display:string, dataStatus:string, isKnown:boolean, value:*}}
 */
function describeForeignFlow(value, options) {
  const opts = options && typeof options === 'object' ? options : {};
  let raw = value;
  let status = normalizeStatus(opts.status);

  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    status = normalizeStatus(raw.data_status) || status;
    raw = raw.value !== undefined ? raw.value : raw.foreign_net;
  }

  const n = numberOrNull(raw);
  const absentStatus = !!(status && ABSENCE_STATUSES.indexOf(status) >= 0);

  if (n === null || absentStatus) {
    return {
      display: UNKNOWN_DISPLAY,
      dataStatus: status || DATA_STATUS.NOT_PUBLISHED,
      isKnown: false,
      value: UNKNOWN
    };
  }

  // A BARE zero carries no explicit provenance, and `0` is exactly what the old
  // `value || 0` defect produced. Promoting it to "Rp 0" would make absence and
  // measurement indistinguishable, so an unbacked zero stays absent. A zero
  // accompanied by an explicit AVAILABLE status is a measured market fact and
  // renders `Rp 0`.
  if (n === 0 && !status) {
    return {
      display: UNKNOWN_DISPLAY,
      dataStatus: DATA_STATUS.NOT_PUBLISHED,
      isKnown: false,
      value: UNKNOWN
    };
  }

  return {
    display: formatIDR(n),
    dataStatus: status || DATA_STATUS.AVAILABLE,
    isKnown: true,
    value: n
  };
}

const FORMATTERS = Object.freeze({
  price: formatPrice,
  pct: formatPercent,
  percent: formatPercent,
  idr: formatIDR,
  rupiah: formatIDR,
  volume: formatVolume
});

/**
 * Uniform formatter. Unknown always renders `'—'`; a known value is delegated
 * to the unit-specific formatter above. With no unit, numbers use the id-ID
 * grouping and strings pass through untouched.
 *
 * @param {*} value
 * @param {{unit?: string}} [options]
 * @returns {string}
 */
function formatValue(value, options) {
  const opts = options || {};
  const unit = typeof opts.unit === 'string' ? opts.unit.toLowerCase() : null;
  if (!isKnown(value)) return UNKNOWN_DISPLAY;
  if (unit && FORMATTERS[unit]) return FORMATTERS[unit](value);
  const n = numberOrNull(value);
  if (n !== null) return n.toLocaleString('id-ID');
  return String(value);
}

/* -------------------------------------------------------------------------- */
/* Provenance                                                                 */
/* -------------------------------------------------------------------------- */

/** Normalise a caller-supplied status to the frozen vocabulary (or null). */
function normalizeStatus(status) {
  if (typeof status !== 'string') return null;
  const upper = status.trim().toUpperCase();
  return KNOWN_STATUS_VALUES.indexOf(upper) >= 0 ? upper : null;
}

function isoOrNull(value) {
  if (!isKnown(value)) return UNKNOWN;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? UNKNOWN : d.toISOString();
}

function textOrNull(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : UNKNOWN;
}

/**
 * Attach an explicit provenance record. Never throws; absent fields become
 * explicit `null` so a consumer can tell "not supplied" from "supplied empty".
 *
 * @param {object} record
 * @param {{source?:string, tradeDate?:string, sourceTimestamp?:string,
 *          ingestionTimestamp?:string, status?:string, extra?:object}} [provenance]
 * @returns {object} a new record with `data_status` and `provenance`
 */
function attachProvenance(record, provenance) {
  const base = record && typeof record === 'object' ? record : {};
  const p = provenance && typeof provenance === 'object' ? provenance : {};

  const source = textOrNull(p.source);
  const status = normalizeStatus(p.status) ||
    normalizeStatus(base.data_status) ||
    (source === null ? DATA_STATUS.SOURCE_UNAVAILABLE : DATA_STATUS.AVAILABLE);

  const prov = {
    source,
    tradeDate: textOrNull(p.tradeDate),
    sourceTimestamp: isoOrNull(p.sourceTimestamp),
    ingestionTimestamp: isoOrNull(p.ingestionTimestamp) || new Date().toISOString(),
    status,
    // Explicit, machine-checkable statement that this record is not synthetic.
    synthetic: false
  };
  if (p.extra && typeof p.extra === 'object') prov.extra = Object.assign({}, p.extra);

  return Object.assign({}, base, { data_status: status, provenance: prov });
}

/* -------------------------------------------------------------------------- */
/* OHLCV structural validation                                               */
/* -------------------------------------------------------------------------- */

/**
 * Validate one candle/bar against the structural invariants the V5 contract
 * requires (N6): high >= low, low <= open <= high, low <= close <= high,
 * volume >= 0.
 *
 * @param {object} bar
 * @returns {{valid: boolean, errors: string[]}}
 */
function validateOhlcv(bar) {
  const errors = [];
  if (!bar || typeof bar !== 'object') {
    return { valid: false, errors: ['BAR_NOT_OBJECT'] };
  }

  const open = numberOrNull(bar.open);
  const high = numberOrNull(bar.high);
  const low = numberOrNull(bar.low);
  const close = numberOrNull(bar.close);

  if (open === null) errors.push('OPEN_NOT_NUMERIC');
  if (high === null) errors.push('HIGH_NOT_NUMERIC');
  if (low === null) errors.push('LOW_NOT_NUMERIC');
  if (close === null) errors.push('CLOSE_NOT_NUMERIC');

  // Only structural comparisons are meaningful once the four prices are known.
  // An unknown price is already reported above; it is never coerced to 0.
  if (errors.length === 0) {
    if (high < low) errors.push('HIGH_BELOW_LOW');
    if (open < low || open > high) errors.push('OPEN_OUTSIDE_LOW_HIGH');
    if (close < low || close > high) errors.push('CLOSE_OUTSIDE_LOW_HIGH');
  }

  if (isKnown(bar.volume)) {
    const volume = numberOrNull(bar.volume);
    if (volume === null) errors.push('VOLUME_NOT_NUMERIC');
    else if (volume < 0) errors.push('NEGATIVE_VOLUME');
  }

  return { valid: errors.length === 0, errors };
}

/* -------------------------------------------------------------------------- */
/* Synthetic-constant guard                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Refuse a price that equals a known synthetic constant **when it carries no
 * source provenance**. A real row whose source file really says 1550 is
 * accepted (pass `options.provenance`); an invented one is rejected.
 *
 * @param {*} value
 * @param {number[]} [forbidden]
 * @param {{provenance?:*, throwOnViolation?:boolean}} [options]
 * @returns {null|Error} null when acceptable; an Error (or thrown) on violation
 */
function guardConstantPrice(value, forbidden, options) {
  const opts = options || {};
  const n = numberOrNull(value);
  if (n === null) return null;

  const list = (Array.isArray(forbidden) && forbidden.length
    ? forbidden
    : SYNTHETIC_PRICE_CONSTANTS).map(Number);

  if (list.indexOf(n) < 0) return null;
  // Backed by a real source row => it is a genuine market print, not a default.
  if (isKnown(opts.provenance)) return null;

  const err = new Error(
    'SYNTHETIC_PRICE_CONSTANT: ' + n + ' published without source provenance'
  );
  err.code = 'SYNTHETIC_PRICE_CONSTANT';
  err.value = n;
  err.forbidden = list;

  if (opts.throwOnViolation === false) return err;
  throw err;
}

/* -------------------------------------------------------------------------- */
/* Exports                                                                    */
/* -------------------------------------------------------------------------- */

module.exports = {
  DATA_STATUS,
  UNKNOWN,
  UNKNOWN_DISPLAY,
  SYNTHETIC_PRICE_CONSTANTS,
  ABSENCE_STATUSES,
  VOLUME_UNIT,
  SHARES_PER_LOT,

  isKnown,
  isKnownNumber,
  unknown,
  numberOrNull,
  pick,
  pickNumber,
  pickText,

  formatValue,
  formatPrice,
  formatPercent,
  formatIDR,
  formatVolume,
  describeVolume,
  normalizeVolumeUnit,
  sharesToLots,
  lotsToShares,
  describeForeignFlow,

  attachProvenance,
  normalizeStatus,
  validateOhlcv,
  guardConstantPrice
};