'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const momentum = require('../lib/intraday-fast-watcher-momentum');
const pool = require('../lib/intraday-fast-watcher-pool');
const radarPublisher = require('../lib/intraday-fast-watcher-radar-publisher');

function makeObservation(ticker, time, extra) {
  return Object.assign({
    ticker,
    scheduled_time: time,
    current_price: 1000,
    open: 980,
    high: 1020,
    low: 980,
    entry_low: 990,
    entry_high: 1010,
    tp1: 1100,
    stop_loss: 950,
    current_status: 'READY_BREAKOUT',
    volume: 5000000,
    average_volume: 3000000,
    relative_volume: 1.8,
    momentum_component: 16,
    liquidity_component: 16,
    risk_reward: 2.5,
    freshness: { is_stale: false }
  }, extra || {});
}

test('Opening Range Velocity Guard - Window Detection (09:16 - 09:30 WIB)', () => {
  // Edge tests
  assert.equal(momentum.isOpeningRangeVelocityWindow('09:15'), false, '09:15 WIB must be outside velocity window');
  assert.equal(momentum.isOpeningRangeVelocityWindow('09:16'), true, '09:16 WIB must be inside velocity window (inclusive start)');
  assert.equal(momentum.isOpeningRangeVelocityWindow('09:20'), true, '09:20 WIB must be inside velocity window');
  assert.equal(momentum.isOpeningRangeVelocityWindow('09:30'), true, '09:30 WIB must be inside velocity window (inclusive end)');
  assert.equal(momentum.isOpeningRangeVelocityWindow('09:31'), false, '09:31 WIB must be outside velocity window');
  assert.equal(momentum.isOpeningRangeVelocityWindow('09:45'), false, '09:45 WIB must be outside velocity window');
  assert.equal(momentum.isOpeningRangeVelocityWindow('10:00'), false, '10:00 WIB must be outside velocity window');
});

test('Opening Range Velocity Guard - Board Differentiation Thresholds', () => {
  // Main / Development Board: threshold 250M
  const mainGuard200M = momentum.evaluateOpeningVelocityGuard({
    time: '09:20',
    board: 'UTAMA',
    obs: { delta_turnover_5m: 200_000_000 }
  });
  assert.equal(mainGuard200M.threshold, 250_000_000);
  assert.equal(mainGuard200M.passes, false, '200M should fail on Main Board (min 250M)');

  const mainGuard300M = momentum.evaluateOpeningVelocityGuard({
    time: '09:20',
    board: 'UTAMA',
    obs: { delta_turnover_5m: 300_000_000 }
  });
  assert.equal(mainGuard300M.passes, true, '300M should pass on Main Board');

  // Acceleration Board: threshold 100M
  const accelGuard80M = momentum.evaluateOpeningVelocityGuard({
    time: '09:20',
    board: 'AKSELERASI',
    obs: { delta_turnover_5m: 80_000_000 }
  });
  assert.equal(accelGuard80M.threshold, 100_000_000);
  assert.equal(accelGuard80M.passes, false, '80M should fail on Acceleration Board (min 100M)');

  const accelGuard150M = momentum.evaluateOpeningVelocityGuard({
    time: '09:20',
    board: 'AKSELERASI',
    obs: { delta_turnover_5m: 150_000_000 }
  });
  assert.equal(accelGuard150M.threshold, 100_000_000);
  assert.equal(accelGuard150M.passes, true, '150M should pass on Acceleration Board (threshold 100M)');
});

test('Skenario A: 09:20 WIB dengan Δ turnover Rp 500 jt -> Lolos CONFIRMED BUY', () => {
  // 3 distinct snapshots fulfilling Phase 1 criteria (publish_score >= 68, confirmation count >= 3)
  // and delta turnover = 500M (>= 250M threshold)
  const first = pool.process({
    sampleDate: '2026-09-11',
    scheduledTime: '09:16',
    shortlistRows: [{ ticker: 'BBCA', source_rank: 1 }],
    observations: [makeObservation('BBCA', '09:16', {
      delta_turnover_5m: 500_000_000,
      current_price: 1000
    })],
    priorState: null
  });
  assert.equal(first.state.tickers.BBCA.status, 'READY_PENDING');

  const second = pool.process({
    sampleDate: '2026-09-11',
    scheduledTime: '09:18',
    shortlistRows: [{ ticker: 'BBCA', source_rank: 1 }],
    observations: [makeObservation('BBCA', '09:18', {
      delta_turnover_5m: 500_000_000,
      current_price: 1005
    })],
    priorState: first.state
  });
  assert.equal(second.state.tickers.BBCA.status, 'READY_PENDING');

  const third = pool.process({
    sampleDate: '2026-09-11',
    scheduledTime: '09:20',
    shortlistRows: [{ ticker: 'BBCA', source_rank: 1 }],
    observations: [makeObservation('BBCA', '09:20', {
      delta_turnover_5m: 500_000_000,
      current_price: 1010
    })],
    priorState: second.state
  });

  // Verification
  const bbcaState = third.state.tickers.BBCA;
  assert.equal(bbcaState.status, 'READY_CONFIRMED', 'Status must be READY_CONFIRMED');
  assert.equal(bbcaState.ready_streak, 3, 'Streak must be 3');
  assert.equal(third.confirmed.length, 1, 'Must be in confirmed pool');
  assert.equal(third.publishable.length, 1, 'Must be in publishable list');
  assert.equal(third.publishable[0].ticker, 'BBCA');
  assert.ok(bbcaState.last_reasons.includes('opening_range_velocity_passed'), 'Reasons must include velocity passed');
  assert.ok(bbcaState.last_reasons.includes('opening_range_velocity_confirmed'), 'Reasons must include velocity confirmed');
});

test('Skenario B: 09:20 WIB dengan Δ turnover Rp 50 jt -> DITAHAN (tidak CONFIRMED BUY, radar/pending)', () => {
  // 3 observations but delta turnover is only 50M (< 250M threshold)
  const first = pool.process({
    sampleDate: '2026-09-11',
    scheduledTime: '09:16',
    shortlistRows: [{ ticker: 'BBRI', source_rank: 1 }],
    observations: [makeObservation('BBRI', '09:16', {
      delta_turnover_5m: 50_000_000,
      current_price: 1000
    })],
    priorState: null
  });

  const second = pool.process({
    sampleDate: '2026-09-11',
    scheduledTime: '09:18',
    shortlistRows: [{ ticker: 'BBRI', source_rank: 1 }],
    observations: [makeObservation('BBRI', '09:18', {
      delta_turnover_5m: 50_000_000,
      current_price: 1005
    })],
    priorState: first.state
  });

  const third = pool.process({
    sampleDate: '2026-09-11',
    scheduledTime: '09:20',
    shortlistRows: [{ ticker: 'BBRI', source_rank: 1 }],
    observations: [makeObservation('BBRI', '09:20', {
      delta_turnover_5m: 50_000_000,
      current_price: 1010
    })],
    priorState: second.state
  });

  // Verification: DITAHAN
  const bbriState = third.state.tickers.BBRI;
  assert.notEqual(bbriState.status, 'READY_CONFIRMED', 'Status must NOT be promoted to READY_CONFIRMED');
  assert.ok(
    ['WAIT_PULLBACK', 'READY_PENDING', 'PENDING_VELOCITY', 'RADAR'].includes(bbriState.status),
    `Status must be held as WAIT_PULLBACK / READY_PENDING / RADAR, got: ${bbriState.status}`
  );
  assert.equal(third.confirmed.length, 0, 'Confirmed pool must be empty (no confirmed buy)');
  assert.equal(third.publishable.length, 0, 'Publishable list must be empty (no signal sent)');
  assert.ok(
    bbriState.last_reasons.includes('opening_range_velocity_insufficient') ||
    bbriState.last_reasons.includes('opening_range_velocity_gate_blocked'),
    'Reasons must note velocity insufficiency / gate blocked'
  );

  // Still eligible for radar
  const radarCandidates = radarPublisher.selectRadarCandidates(third.state);
  assert.ok(
    radarCandidates.some(c => c.ticker === 'BBRI'),
    'BBRI must remain eligible for radar / watchlist monitoring'
  );
});

test('Skenario C: 09:45 WIB kondisi normal -> Lolos CONFIRMED BUY (aturan Phase 1 normal)', () => {
  // At 09:45 WIB, velocity guard is outside the 09:16-09:30 window
  const first = pool.process({
    sampleDate: '2026-09-11',
    scheduledTime: '09:35',
    shortlistRows: [{ ticker: 'TLKM', source_rank: 1 }],
    observations: [makeObservation('TLKM', '09:35', { current_price: 1000 })],
    priorState: null
  });
  assert.equal(first.state.tickers.TLKM.status, 'READY_PENDING');

  const second = pool.process({
    sampleDate: '2026-09-11',
    scheduledTime: '09:40',
    shortlistRows: [{ ticker: 'TLKM', source_rank: 1 }],
    observations: [makeObservation('TLKM', '09:40', { current_price: 1005 })],
    priorState: first.state
  });
  assert.equal(second.state.tickers.TLKM.status, 'READY_PENDING');

  const third = pool.process({
    sampleDate: '2026-09-11',
    scheduledTime: '09:45',
    shortlistRows: [{ ticker: 'TLKM', source_rank: 1 }],
    observations: [makeObservation('TLKM', '09:45', { current_price: 1010 })],
    priorState: second.state
  });

  const tlkmState = third.state.tickers.TLKM;
  assert.equal(tlkmState.status, 'READY_CONFIRMED', 'Status must be READY_CONFIRMED at 09:45 WIB');
  assert.equal(tlkmState.ready_streak, 3, 'Streak must reach 3');
  assert.equal(third.confirmed.length, 1, 'Must be in confirmed pool');
  assert.equal(third.publishable.length, 1, 'Must be in publishable list');
  assert.equal(third.publishable[0].ticker, 'TLKM');
});

test('Opening Range Velocity Guard - Accumulated Turnover Difference Calculation', () => {
  // Test sequential accumulated turnover difference across 5-minute interval
  const first = pool.process({
    sampleDate: '2026-09-11',
    scheduledTime: '09:15',
    shortlistRows: [{ ticker: 'ASII', source_rank: 1 }],
    observations: [makeObservation('ASII', '09:15', {
      turnover: 1_000_000_000,
      current_price: 1000
    })],
    priorState: null
  });

  const second = pool.process({
    sampleDate: '2026-09-11',
    scheduledTime: '09:18',
    shortlistRows: [{ ticker: 'ASII', source_rank: 1 }],
    observations: [makeObservation('ASII', '09:18', {
      turnover: 1_300_000_000,
      current_price: 1005
    })],
    priorState: first.state
  });

  // At 09:20, turnover reaches 1.6 Billion -> Delta = 1.6B - 1.0B = 600M >= 250M
  const third = pool.process({
    sampleDate: '2026-09-11',
    scheduledTime: '09:20',
    shortlistRows: [{ ticker: 'ASII', source_rank: 1 }],
    observations: [makeObservation('ASII', '09:20', {
      turnover: 1_600_000_000,
      current_price: 1010
    })],
    priorState: second.state
  });

  assert.equal(third.state.tickers.ASII.status, 'READY_CONFIRMED');
  assert.equal(third.publishable.length, 1);
});

test('Opening Range Velocity Guard - Proxy VolumeRate * Price Calculation', () => {
  // Proxy volume_rate (300,000 shares/min) * price (1000) = 300,000,000 (300M >= 250M)
  const first = pool.process({
    sampleDate: '2026-09-11',
    scheduledTime: '09:16',
    shortlistRows: [{ ticker: 'MDKA', source_rank: 1 }],
    observations: [makeObservation('MDKA', '09:16', {
      volume_rate: 300_000,
      current_price: 1000
    })],
    priorState: null
  });

  const second = pool.process({
    sampleDate: '2026-09-11',
    scheduledTime: '09:18',
    shortlistRows: [{ ticker: 'MDKA', source_rank: 1 }],
    observations: [makeObservation('MDKA', '09:18', {
      volume_rate: 300_000,
      current_price: 1005
    })],
    priorState: first.state
  });

  const third = pool.process({
    sampleDate: '2026-09-11',
    scheduledTime: '09:20',
    shortlistRows: [{ ticker: 'MDKA', source_rank: 1 }],
    observations: [makeObservation('MDKA', '09:20', {
      volume_rate: 300_000,
      current_price: 1010
    })],
    priorState: second.state
  });

  assert.equal(third.state.tickers.MDKA.status, 'READY_CONFIRMED');
  assert.equal(third.publishable.length, 1);
});
