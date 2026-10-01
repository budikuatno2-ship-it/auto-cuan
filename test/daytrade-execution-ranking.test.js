'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ranking = require('../lib/daytrade-execution-ranking');

function row(overrides) {
  return Object.assign({
    ticker: 'TEST',
    daytrade_score: 75,
    risk_reward: 1.5,
    status: 'READY_BREAKOUT'
  }, overrides || {});
}

test('high raw score with RR below 1.0 is blocked from executable ranking', () => {
  const quality = ranking.deriveDayTradeExecutionQuality(row({
    ticker: 'BADRR',
    daytrade_score: 84,
    risk_reward: 0.1,
    status: 'READY_BREAKOUT'
  }));

  assert.equal(quality.daytrade_raw_score, 84);
  assert.equal(quality.execution_quality_status, 'BLOCKED');
  assert.equal(quality.execution_rank_bucket, 4);
  assert.equal(quality.execution_blocked, true);
  assert.equal(quality.final_executable_score, 0);
});

test('ready setup with strong RR remains executable and preserves raw score', () => {
  const quality = ranking.deriveDayTradeExecutionQuality(row({
    ticker: 'GOOD',
    daytrade_score: 78,
    risk_reward: 1.6
  }));

  assert.equal(quality.execution_quality_status, 'EXECUTABLE');
  assert.equal(quality.execution_rank_bucket, 0);
  assert.equal(quality.daytrade_raw_score, 78);
  assert.equal(quality.final_executable_score, 78);
});

test('ready setup with RR 1.00-1.19 is executable but materially penalized', () => {
  const quality = ranking.deriveDayTradeExecutionQuality(row({
    ticker: 'MARG',
    daytrade_score: 90,
    risk_reward: 1.1
  }));

  assert.equal(quality.execution_quality_status, 'EXECUTABLE_MARGINAL');
  assert.equal(quality.execution_rank_bucket, 2);
  assert.equal(quality.execution_score_adjustment, -10);
  assert.equal(quality.final_executable_score, 80);
});

test('non-ready high-score setup stays radar-only instead of outranking executable entries', () => {
  const executable = row({ ticker: 'EXEC', daytrade_score: 72, risk_reward: 1.5, status: 'READY_BREAKOUT' });
  const radar = row({ ticker: 'RADAR', daytrade_score: 95, risk_reward: 2.2, status: 'WAIT_PULLBACK' });

  const sorted = ranking.sortDayTradeByExecution([radar, executable]);
  assert.equal(sorted[0].ticker, 'EXEC');
  assert.equal(ranking.deriveDayTradeExecutionQuality(sorted[1]).execution_quality_status, 'RADAR_ONLY');
});

test('blocked rows sort below radar rows even when raw score is higher', () => {
  const blocked = row({ ticker: 'BLOCK', daytrade_score: 99, risk_reward: 0.5, status: 'READY_BREAKOUT' });
  const radar = row({ ticker: 'RAD', daytrade_score: 60, risk_reward: 2.0, status: 'PRE_SPIKE_WATCH' });

  const sorted = ranking.sortDayTradeByExecution([blocked, radar]);
  assert.equal(sorted[0].ticker, 'RAD');
  assert.equal(sorted[1].ticker, 'BLOCK');
});

test('decorate adds execution fields without mutating the source row', () => {
  const source = row({ ticker: 'DEC', daytrade_score: 82, risk_reward: 1.3 });
  const decorated = ranking.decorateDayTradeExecution(source);

  assert.notEqual(decorated, source);
  assert.equal(source.final_executable_score, undefined);
  assert.equal(decorated.daytrade_raw_score, 82);
  assert.equal(decorated.execution_quality_status, 'EXECUTABLE_ADEQUATE');
  assert.equal(decorated.execution_rank_bucket, 1);
});
