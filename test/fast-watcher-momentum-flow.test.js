'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const momentum = require('../lib/intraday-fast-watcher-momentum');
const publisher = require('../lib/intraday-fast-watcher-publisher');

function observation(extra) {
  return {
    ticker: 'SSIA',
    scheduled_time: '09:13',
    current_price: 103,
    entry_low: 98,
    entry_high: 104,
    tp1: 112,
    stop_loss: 95,
    current_status: 'EARLY_RADAR',
    volume: 2600000,
    average_volume: 12000000,
    relative_volume: 1.8,
    momentum_component: 16,
    liquidity_component: 17,
    risk_reward: 1.8,
    high: 104,
    low: 98,
    freshness: { is_stale: false },
    ...(extra || {})
  };
}

test('Momentum Flow Proxy scores live price-volume strength without orderbook claims', () => {
  const tracker = {
    first_price: 100,
    last_price: 101,
    last_volume: 1000000,
    last_volume_rate: 120000,
    last_observation_minute: 550,
    in_latest_shortlist: true
  };
  const result = momentum.scoreObservation(observation(), tracker);
  assert.equal(result.metrics.momentum_flow_proxy, true);
  assert.equal(result.metrics.momentum_flow_version, 'MOMENTUM_FLOW_PROXY_V1');
  assert.ok(result.metrics.momentum_flow_score >= 60);
  assert.ok(['MENINGKAT', 'KUAT'].includes(result.metrics.momentum_flow_label));
  assert.ok(result.metrics.momentum_flow_publish_bonus >= 2);
  assert.ok(result.metrics.momentum_flow_publish_bonus <= 6);
  assert.ok(result.metrics.price_velocity_pct_per_min > 0);
});

test('weak flow receives only a bounded penalty and cannot manufacture readiness', () => {
  const tracker = {
    first_price: 100,
    last_price: 101,
    last_volume: 2000000,
    last_volume_rate: 300000,
    last_observation_minute: 550,
    in_latest_shortlist: true
  };
  const result = momentum.evaluate(observation({
    current_price: 99,
    volume: 2010000,
    relative_volume: 0.6,
    high: 104,
    low: 98
  }), tracker);
  assert.ok(result.metrics.momentum_flow_score < 45);
  assert.ok(result.metrics.momentum_flow_publish_bonus >= -4);
  assert.ok(result.metrics.momentum_flow_publish_bonus <= -2);
  assert.notEqual(result.status, 'READY_PASS');
});

test('hard chase guard remains authoritative even with strong flow data', () => {
  const tracker = {
    first_price: 100,
    last_price: 102,
    last_volume: 1000000,
    last_volume_rate: 100000,
    last_observation_minute: 550,
    in_latest_shortlist: true
  };
  const result = momentum.evaluate(observation({
    current_price: 110,
    entry_high: 112,
    tp1: 120,
    volume: 4000000,
    relative_volume: 3,
    high: 111,
    low: 98
  }), tracker);
  assert.equal(result.status, 'BLOCKED_CHASE');
});

test('live Telegram copy names the metric as a proxy and exposes its components', () => {
  const item = {
    ticker: 'SSIA',
    ready_streak: 2,
    watch_score: 82,
    publish_score: 88,
    observation: observation({
      metrics: {
        current_price: 103,
        entry_low: 98,
        entry_high: 104,
        tp1: 112,
        stop_loss: 95,
        momentum_flow_score: 81,
        momentum_flow_label: 'KUAT',
        momentum_flow_confidence: 'HIGH',
        price_velocity_pct_per_min: 0.22,
        volume_acceleration: 0.45,
        volume_rate_vs_average: 3.2,
        range_position: 0.88,
        price_change_pct: 0.65,
        relative_volume: 1.8
      }
    })
  };
  const message = publisher.buildTelegramMessage(item, '2026-07-31', '09:13');
  assert.match(message, /Momentum Flow: 81\/100 \(KUAT\)/);
  assert.match(message, /proxy harga-volume/);
  assert.match(message, /bukan pembacaan orderbook\/HAKA\/OFI/);
  assert.match(message, /Kecepatan harga:/);
  assert.match(message, /Akselerasi volume:/);
});


test('initial snapshot stays neutral until temporal flow exists', () => {
  const result = momentum.scoreObservation(
    observation({
      scheduled_time: '09:10',
      current_price: 100,
      volume: 1000,
      average_volume: 700,
      relative_volume: 1.5,
      high: 103,
      low: 98
    }),
    {
      first_price: 100,
      in_latest_shortlist: true
    }
  );

  assert.equal(
    result.metrics.momentum_flow_label,
    'DATA_AWAL'
  );

  assert.equal(
    result.metrics.momentum_flow_publish_bonus,
    0
  );
});
