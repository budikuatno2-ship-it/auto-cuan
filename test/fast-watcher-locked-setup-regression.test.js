'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const momentum = require('../lib/intraday-fast-watcher-momentum');
const pool = require('../lib/intraday-fast-watcher-pool');

function msky(time, overrides = {}) {
  return {
    ticker: 'MSKY', scheduled_time: time, current_status: 'WAIT_PULLBACK',
    current_price: 69, entry_low: 68, entry_high: 69, tp1: 70, sl: 66,
    high: 69, low: 62, open: 67, volume: 53264000, average_volume: 20081625,
    relative_volume: 2.65, momentum_component: 21, liquidity_component: 18, score: 62,
    plan_lock_id: 'tplock_A',
    selected_trade_plan: {
      entry_zone_low: 68, entry_zone_high: 69, stop_loss: 66, tp1: 70,
      rr_to_tp1: 0.33, minimum_rr_to_tp1: 1, plan_lock_id: 'tplock_A'
    },
    freshness: { is_stale: false },
    ...overrides
  };
}

function readyObservation(time, overrides = {}) {
  return {
    ticker: 'ZZZZ',
    scheduled_time: time,
    current_status: 'READY_BREAKOUT',
    current_price: 100,
    entry_low: 98,
    entry_high: 103,
    tp1: 112,
    stop_loss: 95,
    high: 103,
    low: 98,
    volume: 1000,
    average_volume: 700,
    relative_volume: 1.5,
    momentum_component: 14,
    liquidity_component: 16,
    risk_reward: 1.7,
    minimum_risk_reward: 1,
    plan_lock_id: 'PLAN_A',
    freshness: { is_stale: false },
    ...overrides
  };
}

function readyShortlist() {
  return [{
    ticker: 'ZZZZ',
    source_rank: 1,
    source_status: 'READY_BREAKOUT',
    source_origin: 'regression'
  }];
}

test('pool preserves source status and origin from raw payload', () => {
  const result = pool.mergePayload({ results: [{ ticker: 'BBRI', source_status: 'RADAR', source_origin: 'current_radar' }] }, null, '09:10', [], 20);
  assert.equal(result.results[0].source_status, 'RADAR');
  assert.equal(result.results[0].source_origin, 'current_radar');
});

test('metrics read canonical trade-plan RR', () => {
  const metrics = momentum.metricsFrom(msky('09:58'));
  assert.equal(metrics.risk_reward, 0.33);
  assert.equal(metrics.minimum_risk_reward, 1);
  assert.equal(metrics.plan_lock_id, 'tplock_A');
});

test('poor RR remains watch-only despite strong momentum', () => {
  const result = pool.process({
    sampleDate: '2026-08-03', scheduledTime: '09:58',
    shortlistRows: [{ ticker: 'MSKY', source_rank: 1, source_status: 'WAIT_PULLBACK', source_origin: 'current_radar' }],
    observations: [msky('09:58')], priorState: null
  });
  assert.equal(result.state.tickers.MSKY.status, 'WATCHING');
  assert.equal(result.state.tickers.MSKY.ready_streak, 0);
  assert.ok(result.state.tickers.MSKY.last_reasons.includes('risk_reward_below_minimum'));
  assert.equal(result.publishable.length, 0);
});

test('locked setup blocks shifted target after original TP1 is reached', () => {
  const firstObs = msky('09:58', {
    current_status: 'EARLY_RADAR',
    selected_trade_plan: { entry_zone_low: 68, entry_zone_high: 69, stop_loss: 66, tp1: 70, rr_to_tp1: 1.5, minimum_rr_to_tp1: 1, plan_lock_id: 'tplock_A' }
  });
  const first = pool.process({
    sampleDate: '2026-08-03', scheduledTime: '09:58',
    shortlistRows: [{ ticker: 'MSKY', source_rank: 1, source_status: 'EARLY_RADAR', source_origin: 'current_radar' }],
    observations: [firstObs], priorState: null
  });
  assert.equal(first.state.tickers.MSKY.locked_plan_lock_id, 'tplock_A');
  assert.equal(first.state.tickers.MSKY.locked_tp1, 70);

  const secondObs = msky('10:01', {
    current_status: 'EARLY_RADAR', current_price: 70, entry_low: 69, entry_high: 70, tp1: 71, sl: 67,
    high: 71, volume: 65802700, relative_volume: 3.18, score: 65, plan_lock_id: 'tplock_B',
    selected_trade_plan: { entry_zone_low: 69, entry_zone_high: 70, stop_loss: 67, tp1: 71, rr_to_tp1: 1.5, minimum_rr_to_tp1: 1, plan_lock_id: 'tplock_B' }
  });
  const second = pool.process({
    sampleDate: '2026-08-03', scheduledTime: '10:01',
    shortlistRows: [{ ticker: 'MSKY', source_rank: 1, source_status: 'EARLY_RADAR', source_origin: 'current_radar' }],
    observations: [secondObs], priorState: first.state
  });
  assert.equal(second.state.tickers.MSKY.status, 'DROPPED_FROM_WATCH_POOL');
  assert.equal(second.state.tickers.MSKY.locked_plan_lock_id, 'tplock_A');
  assert.equal(second.state.tickers.MSKY.locked_tp1, 70);
  assert.ok(second.events.some(event => event.reasons.includes('tp1_already_reached')));
  assert.ok(second.events.some(event => event.reasons.includes('source_plan_changed_locked_setup_preserved')));
  assert.equal(second.publishable.length, 0);
});

test('plan lock change resets confirmation streak before another pass', () => {
  const first = pool.process({
    sampleDate: '2099-01-01',
    scheduledTime: '09:10',
    shortlistRows: readyShortlist(),
    observations: [readyObservation('09:10')],
    priorState: null
  });
  assert.equal(first.state.tickers.ZZZZ.status, 'READY_PENDING');
  assert.equal(first.state.tickers.ZZZZ.ready_streak, 1);

  const second = pool.process({
    sampleDate: '2099-01-01',
    scheduledTime: '09:13',
    shortlistRows: readyShortlist(),
    observations: [readyObservation('09:13', {
      current_price: 101,
      volume: 1800,
      relative_volume: 1.8,
      entry_low: 99,
      entry_high: 104,
      tp1: 113,
      stop_loss: 96,
      plan_lock_id: 'PLAN_B'
    })],
    priorState: first.state
  });

  const state = second.state.tickers.ZZZZ;
  assert.equal(state.locked_plan_lock_id, 'PLAN_A');
  assert.equal(state.status, 'READY_PENDING');
  assert.equal(state.ready_streak, 1);
  assert.deepEqual(state.confirmation_window, [true]);
  assert.ok(state.last_reasons.includes('source_plan_changed_locked_setup_preserved'));
  assert.ok(state.last_reasons.includes('confirmation_reset_source_setup_changed'));
  assert.equal(second.publishable.length, 0);
});

test('material source setup change resets confirmation even without plan lock ids', () => {
  const first = pool.process({
    sampleDate: '2099-01-02',
    scheduledTime: '09:10',
    shortlistRows: readyShortlist(),
    observations: [readyObservation('09:10', { plan_lock_id: null })],
    priorState: null
  });
  assert.equal(first.state.tickers.ZZZZ.ready_streak, 1);

  const second = pool.process({
    sampleDate: '2099-01-02',
    scheduledTime: '09:13',
    shortlistRows: readyShortlist(),
    observations: [readyObservation('09:13', {
      current_price: 101,
      volume: 1800,
      relative_volume: 1.8,
      entry_low: 99,
      entry_high: 104,
      tp1: 113,
      stop_loss: 96,
      plan_lock_id: null
    })],
    priorState: first.state
  });

  const state = second.state.tickers.ZZZZ;
  assert.equal(state.status, 'READY_PENDING');
  assert.equal(state.ready_streak, 1);
  assert.deepEqual(state.confirmation_window, [true]);
  assert.ok(state.last_reasons.includes('source_setup_changed_locked_setup_preserved'));
  assert.ok(state.last_reasons.includes('confirmation_reset_source_setup_changed'));
  assert.equal(second.publishable.length, 0);
});
