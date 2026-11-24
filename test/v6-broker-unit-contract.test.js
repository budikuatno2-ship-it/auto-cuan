'use strict';
// V6 RECOVERY TAHAP 2 — regression tests for the resolved broker unit contract.
// Zero network, zero production writes; pure deterministic assertions.
const test = require('node:test');
const assert = require('node:assert/strict');
const contract = require('../lib/broker-unit-contract');

test('unit arithmetic: documented bval/bvol reproduces documented price exactly', () => {
  assert.equal(contract.verifyUnitArithmetic(), true);
  const q = contract.NUMERIC_EXAMPLE.bval / contract.NUMERIC_EXAMPLE.bvol;
  assert.equal(q, 6235.53049160714);
});

test('contract freezes the resolved IDR/SHARES basis and supersedes UNCONFIRMED', () => {
  assert.equal(contract.UNIT_CONTRACT.units_label, 'IDR_SHARES');
  assert.equal(contract.UNIT_CONTRACT.value_unit, 'IDR');
  assert.equal(contract.UNIT_CONTRACT.volume_unit, 'SHARES');
  assert.equal(contract.UNIT_CONTRACT.resolved_gate, 'IDR_SHARES_CONFIRMED_BY_PRICE_ARITHMETIC');
  assert.equal(contract.UNIT_CONTRACT.evidence.provider_documentation_sha256,
    'f209060bd1840447dbb1250a8d62229ec038c8d67d52ecf20b9a38bcc11ceb6c');
  assert.throws(() => { 'use strict'; contract.UNIT_CONTRACT.volume_unit = 'LOT'; }, TypeError);
});

test('raw projection preserves all six provider fields at full precision', () => {
  const row = { bval: 245992925000, bvol: 39450200, sval: 7515232500, svol: 1205400, nval: 238477692500, nvol: 38244800 };
  const out = contract.rawProjection(row);
  assert.deepEqual(out, row);
  assert.equal(out.bval / out.bvol, 6235.53049160714);
});

test('raw projection fails closed on missing or non-finite raw fields', () => {
  assert.throws(() => contract.rawProjection(null), /RAW_ROW_MISSING/);
  assert.throws(() => contract.rawProjection({ bval: 1, bvol: 'x', sval: 0, svol: 0, nval: 0, nvol: 0 }), /RAW_FIELD_INVALID:bvol/);
  assert.throws(() => contract.rawProjection({ bval: NaN, bvol: 1, sval: 0, svol: 0, nval: 0, nvol: 0 }), /RAW_FIELD_INVALID:bval/);
  assert.throws(() => contract.rawProjection({ bval: 1, bvol: 2, sval: 3, svol: 4, nval: 5 }), /RAW_FIELD_INVALID:nvol/);
});

test('foreign flow decision fail-closes empty and missing parents as NO_FOREIGN_FLOW_PROVEN', () => {
  const blocked = [null, undefined, {}, { rows: [] }, { rows: null }, { noRows: true }];
  for (const parent of blocked) {
    const d = contract.foreignFlowDecision(parent);
    assert.equal(d.proven, false);
    assert.equal(d.status, 'NO_FOREIGN_FLOW_PROVEN');
  }
  const ok = contract.foreignFlowDecision({ rows: [{ broker_code: 'YU', bval: 1, bvol: 1, sval: 0, svol: 0, nval: 1, nvol: 1 }] });
  assert.equal(ok.proven, true);
  assert.equal(ok.status, 'FOREIGN_PROVEN');
});

test('lot display is presentation-only: 0.7 lot rounds up but shares stay exact', () => {
  const fractional = contract.lotDisplay(70);
  assert.equal(fractional.shares, 70);
  assert.equal(fractional.lot_display, 1, '70 shares = 0.7 lot displays as 1 lot');
  assert.equal(fractional.basis, 'DERIVED_PRESENTATION_ONLY');
  const exact = contract.lotDisplay(39450200);
  assert.equal(exact.shares, 39450200);
  assert.equal(exact.lot_display, 394502);
  assert.throws(() => contract.lotDisplay(-1), /LOT_INPUT_INVALID/);
  assert.throws(() => contract.lotDisplay(NaN), /LOT_INPUT_INVALID/);
});

test('contract sha256 is deterministic and bound to the frozen document', () => {
  const a = contract.contractSha256();
  const b = contract.contractSha256();
  assert.equal(a, b);
  assert.match(a, /^[a-f0-9]{64}$/);
});
