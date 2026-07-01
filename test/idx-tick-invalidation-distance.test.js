'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveInvalidationDistance } = require('../lib/idx-tick-normalization');

function candidate(overrides) {
  return Object.assign({
    current_price: 100,
    stop_loss: 95
  }, overrides || {});
}

const cases = [
  ['missing price', { current_price: null }, 'NO_DATA', null],
  ['missing SL', { stop_loss: null }, 'NO_DATA', null],
  ['price at SL', { current_price: 95, stop_loss: 95 }, 'INVALID_BELOW_SL', 0],
  ['price below SL', { current_price: 94, stop_loss: 95 }, 'INVALID_BELOW_SL', -1.06],
  ['price very close to SL within too-close threshold', { current_price: 100, stop_loss: 99.25 }, 'TOO_CLOSE_TO_SL', 0.75],
  ['price near invalidation but not too close', { current_price: 100, stop_loss: 98 }, 'INVALIDATION_NEAR', 2],
  ['price with healthy distance from SL', { current_price: 100, stop_loss: 95 }, 'HEALTHY_BUFFER', 5]
];

for (const [name, overrides, expectedStatus, expectedDistance] of cases) {
  test('deriveInvalidationDistance: ' + name + ' -> ' + expectedStatus, () => {
    const result = deriveInvalidationDistance(candidate(overrides));
    assert.equal(result.invalidation_distance_status, expectedStatus);
    assert.equal(result.invalidation_distance_pct, expectedDistance);
    assert.equal(typeof result.invalidation_distance_label, 'string');
    assert.equal(typeof result.invalidation_note, 'string');
    assert.ok(result.invalidation_distance_label.length > 0);
    assert.ok(result.invalidation_note.length > 0);
  });
}
