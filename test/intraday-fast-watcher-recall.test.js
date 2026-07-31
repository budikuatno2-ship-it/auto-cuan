'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../lib/intraday-fast-watcher-pool');

function readyObservation(time, status, price, volume, relativeVolume) {
  return {
    ticker: 'TEST', scheduled_time: time, current_status: status,
    current_price: price, entry_low: 100, entry_high: 103, tp1: 112, stop_loss: 97,
    open: 100, high: 104, low: 99, volume, average_volume: 1000,
    relative_volume: relativeVolume, score: 82, momentum_component: 20,
    liquidity_component: 20, risk_reward: 2
  };
}

function run(priorState, time, observation) {
  return pool.process({
    sampleDate: '2026-07-31', scheduledTime: time,
    shortlistRows: [{ ticker: 'TEST', source_rank: 1, score: 82, source_status: 'READY_BREAKOUT', source_origin: 'current_radar' }],
    observations: [observation], priorState,
    now: null
  });
}

test('two passes in three observations confirm while one noisy miss gets grace', () => {
  const first = run(null, '09:10', readyObservation('09:10', 'READY_BREAKOUT', 101, 1400, 1.4));
  assert.equal(first.state.tickers.TEST.status, 'READY_PENDING');
  assert.deepEqual(first.state.tickers.TEST.confirmation_window, [true]);

  const noisy = run(first.state, '09:13', readyObservation('09:13', 'WAIT_PULLBACK', 101, 1400, 0.8));
  assert.equal(noisy.state.tickers.TEST.status, 'READY_PENDING');
  assert.deepEqual(noisy.state.tickers.TEST.confirmation_window, [true, false]);
  assert.ok(noisy.state.tickers.TEST.last_reasons.includes('confirmation_grace'));

  const third = run(noisy.state, '09:16', readyObservation('09:16', 'READY_BREAKOUT', 102, 1900, 1.6));
  assert.equal(third.state.tickers.TEST.status, 'READY_CONFIRMED');
  assert.deepEqual(third.state.tickers.TEST.confirmation_window, [true, false, true]);
  assert.ok(third.state.tickers.TEST.last_reasons.includes('two_of_three_confirmation'));
});

test('hard reject remains immediate and clears confirmation memory', () => {
  const first = run(null, '09:10', readyObservation('09:10', 'READY_BREAKOUT', 101, 1400, 1.4));
  const rejected = run(first.state, '09:13', readyObservation('09:13', 'AVOID', 101, 1500, 1.5));
  assert.equal(rejected.state.tickers.TEST.status, 'DROPPED_FROM_WATCH_POOL');
  assert.deepEqual(rejected.state.tickers.TEST.confirmation_window, []);
});

test('merge reserves fresh slots so weak carried rows cannot starve new candidates', () => {
  const priorState = { date: '2026-07-31', tickers: {} };
  for (let index = 0; index < 20; index += 1) {
    priorState.tickers['OL' + String.fromCharCode(65 + index)] = {
      active: true, status: 'WATCHING', shortlist_rank: index + 1,
      source_score: 55, source_status: 'WAIT_PULLBACK', last_watch_score: 20,
      ready_streak: 0, max_expires_at_minute: 700
    };
  }
  const supplemental = Array.from({ length: 10 }, (_, index) => ({
    ticker: 'NE' + String.fromCharCode(65 + index), status: 'EARLY_RADAR', daytrade_score: 80 - index
  }));
  const merged = pool.mergePayload({ results: [] }, priorState, '09:20', supplemental, 20);
  const freshRows = merged.results.filter(row => row.source_origin === 'supplemental');
  assert.ok(freshRows.length >= pool.MIN_FRESH_SHORTLIST_SLOTS);
  assert.equal(merged.diagnostics.required_fresh_slots, pool.MIN_FRESH_SHORTLIST_SLOTS);
});
