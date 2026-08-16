'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const lifecycle = require('../lib/reversal-breakout-lifecycle');

function base(overrides) {
  return Object.assign({
    ticker: 'TEST',
    last_price: 100,
    resistance: 103,
    support: 92,
    entry_high: 101,
    rsi14: 55,
    volume_ratio_20d: 1.25,
    change_pct: 1.2,
    data_quality_valid: true
  }, overrides || {});
}

test('classifies early reversal without promoting it into breakout', function () {
  const row = base({ status: 'RECLAIM_CANDIDATE', last_price: 96, resistance: 105, support: 92, rsi14: 42, volume_ratio_20d: 0.95, daytrade_score: 60 });
  lifecycle.applyLifecycle(row, { mode: 'daytrade' });
  assert.equal(row.setup_phase, 'REVERSAL_EARLY');
  assert.equal(row.setup_phase_number, 1);
  assert.equal(row.lifecycle_score_adjustment, 1);
  assert.equal(row.daytrade_score, 61);
});

test('classifies pressure near resistance as pre-breakout', function () {
  const row = base({ status: 'EARLY_RADAR', last_price: 101.5, resistance: 103, volume_ratio_20d: 1.1, daytrade_score: 68 });
  lifecycle.applyLifecycle(row, { mode: 'daytrade' });
  assert.equal(row.setup_phase, 'PRE_BREAKOUT');
  assert.equal(row.setup_phase_number, 2);
  assert.equal(row.lifecycle_score_adjustment, 2);
  assert.equal(row.daytrade_score, 70);
});

test('confirmed breakout gets bounded positive production adjustment', function () {
  const row = base({
    status: 'READY_BREAKOUT',
    last_price: 104,
    resistance: 103,
    volume_ratio_20d: 1.65,
    breakout_confirmation_status: 'BREAKOUT_CONFIRMED',
    daytrade_score: 77
  });
  lifecycle.applyLifecycle(row, { mode: 'daytrade' });
  assert.equal(row.setup_phase, 'BREAKOUT_CONFIRMED');
  assert.equal(row.breakout_quality, 'STRONG');
  assert.equal(row.lifecycle_score_adjustment, 3);
  assert.equal(row.daytrade_score, 80);
});

test('post-breakout continuation is penalized when chase risk is high', function () {
  const row = base({
    status: 'MOMENTUM_CONTINUATION',
    last_price: 109,
    resistance: 100,
    entry_high: 102,
    volume_ratio_20d: 1.3,
    change_pct: 7.5,
    daytrade_score: 78
  });
  lifecycle.applyLifecycle(row, { mode: 'daytrade' });
  assert.equal(row.setup_phase, 'POST_BREAKOUT_CONTINUATION');
  assert.equal(row.chase_risk, 'HIGH');
  assert.equal(row.lifecycle_score_adjustment, -1);
  assert.equal(row.daytrade_score, 77);
});

test('safety block wins and cannot add score', function () {
  const row = base({
    status: 'READY_BREAKOUT',
    last_price: 104,
    resistance: 103,
    volume_ratio_avg20: 2,
    breakout_confirmation_status: 'BREAKOUT_CONFIRMED',
    score: 82,
    corporate_action_guard: 'BLOCKED'
  });
  lifecycle.applyLifecycle(row, { mode: 'swing' });
  assert.equal(row.setup_phase, 'INVALIDATED');
  assert.equal(row.lifecycle_score_adjustment, 0);
  assert.equal(row.score, 82);
});

test('swing score is adjusted but status and trade plan are untouched', function () {
  const row = base({
    status: 'Watchlist',
    setup_type: 'VCP',
    last_price: 101.5,
    resistance: 103,
    volume_ratio_avg20: 1.25,
    score: 71,
    entry_low: 99,
    entry_high: 101,
    stop_loss: 95,
    tp1: 108,
    tp2: 112
  });
  lifecycle.applyLifecycle(row, { mode: 'swing' });
  assert.equal(row.setup_phase, 'PRE_BREAKOUT');
  assert.equal(row.score, 73);
  assert.equal(row.status, 'Watchlist');
  assert.equal(row.entry_low, 99);
  assert.equal(row.entry_high, 101);
  assert.equal(row.stop_loss, 95);
  assert.equal(row.tp1, 108);
  assert.equal(row.tp2, 112);
});

test('metadata-only read path exposes lifecycle without double-counting persisted daytrade score', function () {
  const row = base({
    status: 'READY_BREAKOUT',
    last_price: 104,
    resistance: 103,
    volume_ratio_20d: 1.65,
    breakout_confirmation_status: 'BREAKOUT_CONFIRMED',
    daytrade_score: 80
  });
  lifecycle.applyLifecycle(row, { mode: 'daytrade', applyScore: false });
  assert.equal(row.setup_phase, 'BREAKOUT_CONFIRMED');
  assert.equal(row.lifecycle_score_adjustment, 3);
  assert.equal(row.lifecycle_score_applied, false);
  assert.equal(row.daytrade_score, 80);
  assert.equal(row.daytrade_score_before_lifecycle, undefined);
});

test('lifecycle application is idempotent and never double-counts score', function () {
  const row = base({ status: 'EARLY_RADAR', daytrade_score: 70 });
  lifecycle.applyLifecycle(row, { mode: 'daytrade' });
  const once = row.daytrade_score;
  lifecycle.applyLifecycle(row, { mode: 'daytrade' });
  assert.equal(row.daytrade_score, once);
  assert.equal(row.lifecycle_version, lifecycle.VERSION);
});
