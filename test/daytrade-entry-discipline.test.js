'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const discipline = require('../lib/daytrade-entry-discipline');
const ranking = require('../lib/daytrade-execution-ranking');

function row(overrides) {
  return Object.assign({
    ticker: 'TEST',
    entry_low: 100,
    entry_high: 105,
    last_price: 103,
    daytrade_score: 80,
    risk_reward: 1.6,
    status: 'READY_BREAKOUT'
  }, overrides || {});
}

test('inside canonical entry range stays executable without forced pullback', () => {
  const q = discipline.deriveDayTradeEntryDiscipline(row());
  assert.equal(q.entry_discipline_status, 'WITHIN_ENTRY_RANGE');
  assert.equal(q.entry_executable_now, true);
});

test('above entry high becomes WAIT_PULLBACK and cannot outrank executable setup', () => {
  const chased = row({ ticker: 'CHASED', daytrade_score: 95, last_price: 106 });
  const valid = row({ ticker: 'VALID', daytrade_score: 70, last_price: 104 });
  const q = ranking.deriveDayTradeExecutionQuality(chased);
  assert.equal(q.entry_discipline_status, 'WAIT_PULLBACK');
  assert.equal(q.execution_quality_status, 'RADAR_ONLY');
  assert.equal(q.entry_executable_now, false);
  assert.equal(ranking.sortDayTradeByExecution([chased, valid])[0].ticker, 'VALID');
});

test('below entry does not require arbitrary 0.5 percent pullback', () => {
  const q = discipline.deriveDayTradeEntryDiscipline(row({ last_price: 99.8 }));
  assert.equal(q.entry_discipline_status, 'AT_OR_BELOW_ENTRY');
  assert.equal(q.entry_executable_now, true);
});

test('missing canonical entry fails closed', () => {
  const q = ranking.deriveDayTradeExecutionQuality(row({ entry_high: null }));
  assert.equal(q.entry_discipline_status, 'ENTRY_UNVERIFIED');
  assert.equal(q.execution_quality_status, 'BLOCKED');
  assert.equal(q.entry_executable_now, false);
});
