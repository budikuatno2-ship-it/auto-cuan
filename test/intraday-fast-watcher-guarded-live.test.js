'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const guarded = require('../lib/intraday-fast-watcher-guarded-live');

function sourceRow(ticker, rank) {
  return {
    ticker,
    stock_name: ticker,
    status: 'EARLY_RADAR',
    daytrade_score: 62 - rank,
    source_rank: rank,
    last_price: 100,
    volume_today: 1000,
    volume_ratio_20d: 1.1,
    entry_low: 98,
    entry_high: 103,
    stop_loss: 95,
    tp1: 110,
    tp2: 115,
    liquidity_score: 12,
    momentum_score: 9,
    calculated_at: '2026-07-30T02:05:00.000Z',
    run_id: 'dt-2026-07-30-a'
  };
}

function observation(ticker, time, price, volume, relativeVolume) {
  return {
    ticker,
    scheduled_time: time,
    current_status: 'EARLY_RADAR',
    current_price: price,
    open: 99,
    high: price,
    low: 98,
    volume,
    average_volume: 900,
    relative_volume: relativeVolume,
    score: 63,
    entry_low: 98,
    entry_high: 103,
    sl: 95,
    tp1: 110,
    tp2: 115,
    liquidity_component: 12,
    momentum_component: 9,
    freshness: { is_stale: false },
    structural_context: { atr14: 2 }
  };
}

test('source selection keeps strongest non-hard-reject rows and caps the pool at 20', () => {
  const results = [];
  for (let index = 0; index < 25; index += 1) results.push(sourceRow('AAA' + String.fromCharCode(65 + index), index + 1));
  results[1].status = 'AVOID';
  const rows = guarded.extractSourceRows({ results }, 20);
  assert.equal(rows.length, 20);
  assert.equal(rows.some(row => row.status === 'AVOID'), false);
});

test('adaptive pool does not drop a candidate merely because it disappears from the next shortlist', () => {
  const state = guarded.freshPoolState('2026-07-30');
  guarded.mergePool(state, [sourceRow('PADA', 1)], { scheduledTime: '09:10', sourceTime: '09:05', maxPool: 20 });
  assert.equal(state.tickers.PADA.active, true);
  guarded.mergePool(state, [], { scheduledTime: '09:13', sourceTime: '09:05', maxPool: 20 });
  assert.equal(state.tickers.PADA.active, true);
  assert.equal(state.tickers.PADA.in_latest_source, false);
});

test('engine_not_ready context can still pass when price and volume momentum are strong', () => {
  const state = guarded.freshPoolState('2026-07-30');
  guarded.mergePool(state, [sourceRow('PADA', 1)], { scheduledTime: '09:10', sourceTime: '09:05', maxPool: 20 });
  const tracker = state.tickers.PADA;
  const result = guarded.evaluateMomentum(tracker, observation('PADA', '09:10', 101, 1120, 1.3));
  assert.equal(result.passes, true);
  assert.equal(result.publish_ready, true);
  assert.ok(result.watch_score >= 65);
  assert.equal(result.hard_reasons.length, 0);
});

test('early-session volume pace can confirm momentum even when raw daily RVOL is still below 1', () => {
  const state = guarded.freshPoolState('2026-07-30');
  const row = sourceRow('PADA', 1);
  row.volume_today = 200000;
  row.avg_volume_20d = 5000000;
  row.volume_ratio_20d = 0.04;
  guarded.mergePool(state, [row], { scheduledTime: '09:10', sourceTime: '09:05', maxPool: 20 });
  const tracker = state.tickers.PADA;
  const obs = observation('PADA', '09:10', 101, 350000, 0.07);
  obs.average_volume = 5000000;
  const result = guarded.evaluateMomentum(tracker, obs);
  assert.equal(result.passes, true);
  assert.ok(result.metrics.relative_volume_pace >= 1);
  assert.ok(result.metrics.interval_volume_pace >= 1);
});

test('stale, stop-touched, or excessive chase observations fail closed', () => {
  const state = guarded.freshPoolState('2026-07-30');
  guarded.mergePool(state, [sourceRow('PADA', 1)], { scheduledTime: '09:10', sourceTime: '09:05', maxPool: 20 });
  const tracker = state.tickers.PADA;
  const stale = observation('PADA', '09:10', 101, 1120, 1.3);
  stale.freshness.is_stale = true;
  assert.equal(guarded.evaluateMomentum(tracker, stale).passes, false);
  const stop = observation('PADA', '09:10', 94, 1120, 1.3);
  assert.ok(guarded.evaluateMomentum(tracker, stop).hard_reasons.includes('stop_touched'));
  const chase = observation('PADA', '09:10', 108, 1120, 1.3);
  assert.ok(guarded.evaluateMomentum(tracker, chase).hard_reasons.some(reason => reason.includes('chase') || reason.includes('6_pct')));
});

test('two consecutive confirmations become publishable and selection is capped at Top 3', () => {
  const state = guarded.freshPoolState('2026-07-30');
  const rows = ['AAAA', 'BBBB', 'CCCC', 'DDDD'].map((ticker, index) => sourceRow(ticker, index + 1));
  guarded.mergePool(state, rows, { scheduledTime: '09:10', sourceTime: '09:05', maxPool: 20 });
  guarded.applyObservations(state, rows.map((row, index) => observation(row.ticker, '09:10', 101 + index * 0.01, 1120, 1.3)), { sampleDate: '2026-07-30', scheduledTime: '09:10' });
  const second = guarded.applyObservations(state, rows.map((row, index) => observation(row.ticker, '09:13', 102 + index * 0.01, 1280, 1.4)), { sampleDate: '2026-07-30', scheduledTime: '09:13' });
  assert.equal(second.publishable.length, 3);
  for (const item of second.publishable) assert.equal(item.tracker.confirmation_streak, 2);
});

test('guarded live publishes to database before Telegram and deduplicates the setup', async () => {
  let memoryState = null;
  const order = [];
  const env = {
    FAST_WATCHER_LIVE_ENABLED: '1',
    FAST_WATCHER_KILL_SWITCH: '0',
    FAST_WATCHER_TELEGRAM_ENABLED: '1'
  };
  const shared = {
    env,
    sampleDate: '2026-07-30',
    shortlistFile: '/tmp/fallback.json',
    maxPool: 20,
    readSource: async () => ({ payload: { success: true, status: 'published', meta: { run_id: 'dt-a', calculated_at: '2026-07-30T02:05:00.000Z' }, results: [sourceRow('PADA', 1)] }, source: 'test' }),
    acquireLock: async () => async () => {},
    readState: async () => memoryState,
    writeState: async (_file, value) => { memoryState = JSON.parse(JSON.stringify(value)); },
    writeEvents: async () => {},
    publishCandidate: async row => { order.push('db:' + row.ticker); return { published: true, reason: 'inserted' }; },
    sendTelegram: async item => { order.push('telegram:' + item.tracker.ticker); return { sent: true }; }
  };

  const first = await guarded.runGuardedLive(Object.assign({}, shared, {
    scheduledTime: '09:10',
    collectSnapshot: async () => ({ status: 'live_shadow_collected', observations: [observation('PADA', '09:10', 101, 1120, 1.3)], completed_count: 1, failed_count: 0 })
  }));
  assert.equal(first.published_count, 0);

  const second = await guarded.runGuardedLive(Object.assign({}, shared, {
    scheduledTime: '09:13',
    collectSnapshot: async () => ({ status: 'live_shadow_collected', observations: [observation('PADA', '09:13', 102, 1280, 1.4)], completed_count: 1, failed_count: 0 })
  }));
  assert.equal(second.published_count, 1);
  assert.deepEqual(order, ['db:PADA', 'telegram:PADA']);

  const third = await guarded.runGuardedLive(Object.assign({}, shared, {
    scheduledTime: '09:14',
    collectSnapshot: async () => ({ status: 'live_shadow_collected', observations: [observation('PADA', '09:14', 102.5, 1350, 1.45)], completed_count: 1, failed_count: 0 })
  }));
  assert.equal(third.published_count, 0);
  assert.equal(third.refreshed_count, 1);
  assert.deepEqual(order, ['db:PADA', 'telegram:PADA', 'db:PADA']);
});

test('kill switch blocks publication while still evaluating the pool', async () => {
  let memoryState = null;
  let published = 0;
  const env = { FAST_WATCHER_LIVE_ENABLED: '1', FAST_WATCHER_KILL_SWITCH: '1', FAST_WATCHER_TELEGRAM_ENABLED: '1' };
  const common = {
    env,
    sampleDate: '2026-07-30',
    shortlistFile: '/tmp/fallback.json',
    maxPool: 20,
    readSource: async () => ({ payload: { meta: { calculated_at: '2026-07-30T02:05:00.000Z' }, results: [sourceRow('PADA', 1)] }, source: 'test' }),
    acquireLock: async () => async () => {},
    readState: async () => memoryState,
    writeState: async (_file, value) => { memoryState = JSON.parse(JSON.stringify(value)); },
    writeEvents: async () => {},
    publishCandidate: async () => { published += 1; return { published: true }; }
  };
  await guarded.runGuardedLive(Object.assign({}, common, { scheduledTime: '09:10', collectSnapshot: async () => ({ status: 'live_shadow_collected', observations: [observation('PADA', '09:10', 101, 1120, 1.3)], completed_count: 1, failed_count: 0 }) }));
  const result = await guarded.runGuardedLive(Object.assign({}, common, { scheduledTime: '09:13', collectSnapshot: async () => ({ status: 'live_shadow_collected', observations: [observation('PADA', '09:13', 102, 1280, 1.4)], completed_count: 1, failed_count: 0 }) }));
  assert.equal(result.status, 'guarded_live_blocked');
  assert.equal(result.live_gate.reason, 'kill_switch_enabled');
  assert.equal(published, 0);
});
