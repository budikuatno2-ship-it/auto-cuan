'use strict';

/**
 * lib/broker-unit-contract.js
 * ============================================================================
 * V6 RECOVERY TAHAP 2 — RESOLVED BROKER UNIT CONTRACT (code + documentation).
 * ============================================================================
 *
 * WHY THIS EXISTS (the contradiction this module settles):
 *
 *   - `audit-evidence/v6_recovery_17nov/P0_PROVIDER_DOC_CONTRACT.js` retains the
 *     provider documentation projection. Its numeric example shows
 *     `bval: 245,992,925,000` with `bvol: 39,450,200` and `bavg: 6,235.53049160714`,
 *     where `bval / bvol` reproduces the broker average buy price EXACTLY.
 *   - The derived 16-18 Nov research run recorded `finalUnitGate: UNCONFIRMED`
 *     and carried `unit_basis: PROVIDER_ORIGINAL_UNCONFIRMED` as a precaution.
 *   - The night pipeline preset seeded fixture parents with
 *     `units: 'IDR_SHARES'` and presentation `sell_lot` fields produced by
 *     `Math.round(volume / 100)` — which rounds a 0.7-lot remainder up to a
 *     full lot and would misrepresent fractional shares as whole lots.
 *
 * RESOLUTION (this module is the single source of truth):
 *
 *   1. VALUE = IDR (rupiah), VOLUME = SHARES. Proof: the only unit assignment
 *      consistent with the documented example is bval(IDR) / bvol(shares) =
 *      price(IDR/share) = 6235.53049160714, matching the documented `bavg`
 *      digit-for-digit. Any other unit pairing (e.g. volume in lots) cannot
 *      reproduce that quotient.
 *   2. RAW FIELDS ARE THE CONTRACT. `bval, bvol, sval, svol, nval, nvol` are
 *      preserved at full provider precision. No rounding, scaling, truncation
 *      or normalization is ever applied to a raw stored value.
 *   3. LOT FIELDS ARE PRESENTATION-ONLY. `buy_lot / sell_lot / net_lot` values
 *      derived via `Math.round(volume / 100)` are a human-readable projection.
 *      A fractional remainder (e.g. 70 shares = 0.7 lot) rounds up to 1 lot;
 *      that approximation must never be consumed as a computation basis, never
 *      added across brokers, and never described as a verified lot count.
 *      The canonical volume unit for ALL computation is SHARES.
 *   4. FOREIGN IS FAIL-CLOSED. A missing, empty or unconfirmed Foreign (F)
 *      parent NEVER yields Foreign = 0 and NEVER allows Domestic = ALL. The
 *      issuer-date is marked `NO_FOREIGN_FLOW_PROVEN` and excluded from
 *      Domestic derivation. (The 16-18 Nov full-cohort matrix recorded these
 *      emitter-days as FOREIGN_EMPTY_UNCONFIRMED; they are the same state and
 *      stay blocked.)
 *
 * This contract is consumed by lib/v6-scheduler-adapters.cjs (real accumulation
 * and bandarmologi adapters) and is regression-tested in
 * test/v6-broker-unit-contract.test.js.
 * ============================================================================
 */

const crypto = require('node:crypto');

/** SHA-256 of the retained provider documentation projection this contract resolves. */
const PROVIDER_DOC_SHA256 = 'f209060bd1840447dbb1250a8d62229ec038c8d67d52ecf20b9a38bcc11ceb6c';

const CONTRACT_VERSION = 1;

/** The documented numeric example, retained verbatim as unit evidence. */
const NUMERIC_EXAMPLE = Object.freeze({
  bval: 245992925000,
  bvol: 39450200,
  bavg_documented: 6235.53049160714
});

const RAW_FIELDS = Object.freeze(['bval', 'bvol', 'sval', 'svol', 'nval', 'nvol']);

/**
 * The resolved contract. Frozen: consumers must not be able to mutate the
 * unit basis at runtime.
 */
const UNIT_CONTRACT = Object.freeze({
  schemaVersion: CONTRACT_VERSION,
  value_unit: 'IDR',
  volume_unit: 'SHARES',
  units_label: 'IDR_SHARES',
  resolved_gate: 'IDR_SHARES_CONFIRMED_BY_PRICE_ARITHMETIC',
  raw_fields: RAW_FIELDS,
  lot_fields_policy: 'DERIVED_PRESENTATION_ONLY',
  lot_rounding_note:
    'lot = Math.round(volume / 100) is a human-readable projection only. ' +
    'Fractional remainders round up (70 shares = 0.7 lot displays as 1 lot). ' +
    'Lots are never a computation basis; the canonical volume unit is SHARES.',
  foreign_empty_policy: Object.freeze({
    status: 'NO_FOREIGN_FLOW_PROVEN',
    rule:
      'A missing, empty or unconfirmed Foreign (F) parent never yields ' +
      'Foreign = 0 and never allows Domestic = ALL. The issuer-date is ' +
      'fail-closed as NO_FOREIGN_FLOW_PROVEN and excluded from Domestic derivation.',
    forbidden: Object.freeze(['zero_fill', 'foreign_equals_all'])
  }),
  evidence: Object.freeze({
    provider_documentation_sha256: PROVIDER_DOC_SHA256,
    numeric_example: NUMERIC_EXAMPLE,
    rationale:
      'bval(IDR) / bvol(shares) = price(IDR/share) reproduces the documented ' +
      'broker average buy price exactly; no other unit pairing can.',
    supersedes: 'unit-contract-review.json finalUnitGate: UNCONFIRMED'
  })
});

/**
 * Fail-closed decision for a Foreign parent.
 * @param {object|null|undefined} foreignParent - Foreign flow parent payload with `.rows`.
 * @returns {{proven: boolean, status: string}} proven=false when Foreign data
 *   must not be treated as numeric input (absent, non-object, or zero rows).
 */
function foreignFlowDecision(foreignParent) {
  const hasRows = foreignParent &&
    typeof foreignParent === 'object' &&
    Array.isArray(foreignParent.rows) &&
    foreignParent.rows.length > 0;
  if (!hasRows) return { proven: false, status: UNIT_CONTRACT.foreign_empty_policy.status };
  return { proven: true, status: 'FOREIGN_PROVEN' };
}

/**
 * Project the raw provider fields of a broker row at full precision.
 * Throws when a raw field is absent or non-finite — silently coercing to 0
 * would violate the full-precision preservation rule.
 * @param {object} row - broker row carrying the raw provider fields.
 * @returns {{bval:number,bvol:number,sval:number,svol:number,nval:number,nvol:number}}
 */
function rawProjection(row) {
  if (!row || typeof row !== 'object') throw new Error('UNIT_CONTRACT_RAW_ROW_MISSING');
  const out = {};
  for (const field of RAW_FIELDS) {
    const value = row[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('UNIT_CONTRACT_RAW_FIELD_INVALID:' + field);
    }
    out[field] = value; // full precision, untouched
  }
  return out;
}

/**
 * Presentation-only lot projection. Never mutates or replaces the shares
 * value; the returned object always retains the exact share count.
 * @param {number} shares - volume in shares (canonical unit).
 * @returns {{shares: number, lot_display: number, basis: string}}
 */
function lotDisplay(shares) {
  if (typeof shares !== 'number' || !Number.isFinite(shares) || shares < 0) {
    throw new Error('UNIT_CONTRACT_LOT_INPUT_INVALID');
  }
  return {
    shares, // exact, canonical
    lot_display: Math.round(shares / 100), // presentation only, rounds 0.7 up
    basis: UNIT_CONTRACT.lot_fields_policy
  };
}

/**
 * Verify the contract's unit arithmetic against the documented example.
 * @returns {boolean} true when bval/bvol reproduces the documented price.
 */
function verifyUnitArithmetic() {
  const quotient = NUMERIC_EXAMPLE.bval / NUMERIC_EXAMPLE.bvol;
  return quotient === NUMERIC_EXAMPLE.bavg_documented;
}

/** Content digest of the contract document itself (evidence binding). */
function contractSha256() {
  return crypto.createHash('sha256')
    .update(JSON.stringify(UNIT_CONTRACT))
    .digest('hex');
}

module.exports = {
  UNIT_CONTRACT,
  CONTRACT_VERSION,
  PROVIDER_DOC_SHA256,
  NUMERIC_EXAMPLE,
  RAW_FIELDS,
  foreignFlowDecision,
  rawProjection,
  lotDisplay,
  verifyUnitArithmetic,
  contractSha256
};
