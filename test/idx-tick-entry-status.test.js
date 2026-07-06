'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveEntryStatus } = require('../lib/idx-tick-normalization');

function candidate(overrides) {
  return Object.assign({
    current_price: 100,
    entry_low: 100,
    entry_high: 102,
    stop_loss: 95,
    target_1: 110,
    target_2: 120
  }, overrides || {});
}

const cases = [
  ['price below entry area', { current_price: 99 }, 'BELOW_ENTRY'],
  ['price inside entry area', { current_price: 101 }, 'IN_ENTRY_AREA'],
  ['price slightly above entry but still acceptable', { current_price: 103 }, 'NEAR_ENTRY'],
  ['price above entry but not chase', { current_price: 104 }, 'ABOVE_ENTRY'],
  ['price more than chase threshold', { current_price: 106 }, 'CHASE_RISK'],
  ['price more than extended threshold', { current_price: 108 }, 'EXTENDED'],
  ['price near TP1', { current_price: 109 }, 'TP1_NEAR'],
  ['price at or above TP1', { current_price: 110 }, 'TP1_HIT'],
  ['price at or above TP2', { current_price: 120 }, 'TP2_HIT'],
  ['price at or below SL', { current_price: 95 }, 'INVALID_BELOW_SL']
];

for (const [name, overrides, expected] of cases) {
  test('deriveEntryStatus: ' + name + ' -> ' + expected, () => {
    const status = deriveEntryStatus(candidate(overrides));
    assert.equal(status.entry_status, expected);
    assert.equal(status.entry_quality_status, expected);
    assert.equal(typeof status.entry_status_label, 'string');
    assert.equal(typeof status.entry_status_note, 'string');
    assert.equal(typeof status.entry_quality_label, 'string');
    assert.equal(typeof status.entry_distance_pct, 'number');
    assert.equal(typeof status.chase_risk_label, 'string');
  });
}

test('deriveEntryStatus: stale candidate -> NEEDS_REVALIDATION', () => {
  const status = deriveEntryStatus(candidate({ is_stale: true, current_price: 101 }));
  assert.equal(status.entry_status, 'NEEDS_REVALIDATION');
  assert.equal(status.entry_quality_status, 'NEEDS_REVALIDATION');
  assert.equal(status.entry_status_label, 'Needs Revalidation');
  assert.match(status.entry_status_note, /validasi ulang/i);
});
