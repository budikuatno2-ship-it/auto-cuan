'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MIN_RR_RATIO,
  IDEAL_RR_RATIO,
  passesRiskRewardFilter
} = require('../lib/screener-config');

test('Central Screener Config: Constants Definition', () => {
  assert.equal(MIN_RR_RATIO, 1.5, 'MIN_RR_RATIO must be 1.5');
  assert.equal(IDEAL_RR_RATIO, 2.0, 'IDEAL_RR_RATIO must be 2.0');
});

test('passesRiskRewardFilter: Incident Case SSMS (R/R 1.0x) must be rejected', () => {
  const ssmsCandidate = {
    ticker: 'SSMS',
    last_price: 1080,
    entry1: 1050,
    entry2: 1075,
    sl: 1030,
    tp1: 1100,
    risk_reward: 1.0
  };
  assert.equal(passesRiskRewardFilter(ssmsCandidate), false, 'SSMS R/R 1.0x must fail');
});

test('passesRiskRewardFilter: Sub-threshold candidates (1.2x, 1.49x) must be rejected', () => {
  assert.equal(passesRiskRewardFilter({ risk_reward: 1.2 }), false, 'R/R 1.2x must fail');
  assert.equal(passesRiskRewardFilter({ risk_reward: 1.49 }), false, 'R/R 1.49x must fail');
  assert.equal(passesRiskRewardFilter({ rr: 1.499 }), false, 'R/R 1.499x must fail');
  assert.equal(passesRiskRewardFilter({ rr_ratio: 1.3 }), false, 'R/R 1.3x must fail');
});

test('passesRiskRewardFilter: Exact threshold candidate (1.5x) must pass', () => {
  assert.equal(passesRiskRewardFilter({ risk_reward: 1.5 }), true, 'R/R 1.5x must pass');
  assert.equal(passesRiskRewardFilter({ rr: 1.5 }), true, 'R/R 1.5x via rr must pass');
  assert.equal(passesRiskRewardFilter({ rr_ratio: 1.5 }), true, 'R/R 1.5x via rr_ratio must pass');
  assert.equal(passesRiskRewardFilter({ levels: { risk_reward: 1.5 } }), true, 'R/R 1.5x nested in levels must pass');
});

test('passesRiskRewardFilter: Ideal candidates (2.0x, 2.5x, 3.0x) must pass', () => {
  assert.equal(passesRiskRewardFilter({ risk_reward: 2.0 }), true, 'R/R 2.0x must pass');
  assert.equal(passesRiskRewardFilter({ risk_reward: 2.5 }), true, 'R/R 2.5x must pass');
  assert.equal(passesRiskRewardFilter({ levels: { riskReward: 3.0 } }), true, 'R/R 3.0x must pass');
});

test('passesRiskRewardFilter: Custom threshold parameter support', () => {
  const candidate = { risk_reward: 1.8 };
  assert.equal(passesRiskRewardFilter(candidate, 1.5), true, 'Passes 1.5 threshold');
  assert.equal(passesRiskRewardFilter(candidate, 2.0), false, 'Fails 2.0 threshold');
});

test('passesRiskRewardFilter: Safe handling of edge cases without throwing', () => {
  assert.equal(passesRiskRewardFilter(null), false, 'null returns false');
  assert.equal(passesRiskRewardFilter(undefined), false, 'undefined returns false');
  assert.equal(passesRiskRewardFilter({}), false, 'empty object returns false');
  assert.equal(passesRiskRewardFilter({ risk_reward: null }), false, 'null risk_reward returns false');
  assert.equal(passesRiskRewardFilter({ risk_reward: undefined }), false, 'undefined risk_reward returns false');
  assert.equal(passesRiskRewardFilter({ risk_reward: 0 }), false, '0 risk_reward returns false');
  assert.equal(passesRiskRewardFilter({ risk_reward: -1.5 }), false, 'negative risk_reward returns false');
  assert.equal(passesRiskRewardFilter({ risk_reward: 'invalid' }), false, 'invalid string returns false');
  assert.equal(passesRiskRewardFilter({ risk_reward: NaN }), false, 'NaN returns false');
  assert.equal(passesRiskRewardFilter({ risk_reward: Infinity }), false, 'Infinity returns false');
  assert.equal(passesRiskRewardFilter({ risk_reward: '1.8' }), true, 'valid numerical string parses correctly');
  assert.equal(passesRiskRewardFilter({ risk_reward: '1.2' }), false, 'sub-threshold numerical string returns false');
});
