'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../lib/intraday-fast-watcher-pool');

function shortlist() {
  return [{
    ticker: 'SAFE',
    source_rank: 1,
    source_status: 'READY_BREAKOUT',
    source_origin: 'regression'
  }];
}

function observation(time, overrides = {}) {
  return {
    ticker: 'SAFE',
    scheduled_time: time,
    current_status: 'READY_BREAKOUT',
    current_price: 100,
    entry_low: 98,
    entry_high: 103,
    tp1: 112,
    stop_loss: 95,
    high: 103,
    low: 98,
    volume: 1800,
    average_volume: 700,
    relative_volume: 1.8,
    momentum_component: 16,
    liquidity_component: 16,
    risk_reward: 2,
    minimum_risk_reward: 1,
    plan_lock_id: 'SAFE_PLAN',
    freshness: { is_stale: false },
    ...overrides
  };
}

test('reported RR cannot override poorer RR derived from locked levels', () => {
  const result = pool.process({
    sampleDate: '2099-02-01',
    scheduledTime: '09:10',
    shortlistRows: shortlist(),
    observations: [observation('09:10', {
      tp1: 104,
      risk_reward: 9
    })],
    priorState: null
  });

  const state = result.state.tickers.SAFE;
  assert.equal(state.locked_risk_reward, 0.13);
  assert.equal(state.last_metrics.risk_reward, 0.13);
  assert.equal(state.status, 'WATCHING');
  assert.equal(state.ready_streak, 0);
  assert.ok(state.last_reasons.includes('risk_reward_below_minimum'));
  assert.equal(result.publishable.length, 0);
});

test('missing stop loss fails closed even when source reports strong RR', () => {
  const result = pool.process({
    sampleDate: '2099-02-02',
    scheduledTime: '09:10',
    shortlistRows: shortlist(),
    observations: [observation('09:10', {
      stop_loss: null,
      risk_reward: 5
    })],
    priorState: null
  });

  const state = result.state.tickers.SAFE;
  assert.equal(state.status, 'DROPPED_FROM_WATCH_POOL');
  assert.equal(state.ready_streak, 0);
  assert.ok(result.events.some(event => event.reasons.includes('missing_stop_loss')));
  assert.equal(result.publishable.length, 0);
});

test('invalid stop and target structures cannot become publishable', () => {
  const badStop = pool.process({
    sampleDate: '2099-02-03',
    scheduledTime: '09:10',
    shortlistRows: shortlist(),
    observations: [observation('09:10', {
      stop_loss: 99
    })],
    priorState: null
  });
  assert.ok(badStop.events.some(event => event.reasons.includes('invalid_stop_loss')));
  assert.equal(badStop.publishable.length, 0);

  const badTarget = pool.process({
    sampleDate: '2099-02-04',
    scheduledTime: '09:10',
    shortlistRows: shortlist(),
    observations: [observation('09:10', {
      tp1: 102
    })],
    priorState: null
  });
  assert.ok(badTarget.events.some(event => event.reasons.includes('invalid_tp1')));
  assert.equal(badTarget.publishable.length, 0);
});
