'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../lib/daytrade-screener-engine');

test('Day Trade keeps conservative afternoon mode through 16:00 WIB', () => {
  assert.equal(engine.getRunMode(null, '2026-07-31T08:05:00.000Z'), 'AFTERNOON_EXIT');
  assert.equal(engine.getRunMode(null, '2026-07-31T09:00:00.000Z'), 'AFTERNOON_EXIT');
  assert.equal(engine.getRunMode(null, '2026-07-31T09:01:00.000Z'), 'OUTSIDE_MARKET');
  assert.equal(engine.getRunMode(null, 'not-a-date'), 'OUTSIDE_MARKET');
});
