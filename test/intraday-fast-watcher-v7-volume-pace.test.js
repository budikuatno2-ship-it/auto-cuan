'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const volumePace = require('../lib/intraday-volume-pace');
const momentum = require('../lib/intraday-fast-watcher-momentum');
const pool = require('../lib/intraday-fast-watcher-pool');
const radar = require('../lib/intraday-fast-watcher-radar-publisher');
const guardedCli = require('../tools/run-intraday-fast-watcher-guarded-live');

function ticker(index) {
  const a = String.fromCharCode(65 + Math.floor(index / (26 * 26)) % 26);
  const b = String.fromCharCode(65 + Math.floor(index / 26) % 26);
  const c = String.fromCharCode(65 + index % 26);
  return `${a}${b}${c}`;
}

function completedCandles() {
  const rows = [];
  for (let index = 0; index < 20; index += 1) {
    rows.push({
      date: `2026-07-${String(12 + index).padStart(2, '0')}`,
      close: 100 + index,
      volume: 10_000_000
    });
  }
  rows.push({ date: '2026-08-03', close: 125, volume: 3_600_000 });
  return rows;
}

function spikeObservation(overrides) {
  return Object.assign({
    ticker: 'BBRI',
    scheduled_time: '10:00',
    current_status: 'READY_BREAKOUT',
    current_price: 110,
    open: 100,
    high: 111,
    low: 99,
    volume: 3_600_000,
    average_volume: 10_000_000,
    previous_day_volume: 10_000_000,
    avg_volume_20d_ex_today: 10_000_000,
    intraday_volume_pace_ratio: 2,
    volume_pace_vs_20d: 2,
    volume_pace_vs_prev_day: 2,
    volume_pace_confidence: 'HIGH',
    volume_pace_version: 'INTRADAY_VOLUME_PACE_V1',
    entry_low: 100,
    entry_high: 103,
    stop_loss: 95,
    tp1: 120,
    risk_reward: 2.1,
    minimum_risk_reward: 1,
    momentum_component: 18,
    liquidity_component: 18,
    freshness: { is_stale: false }
  }, overrides || {});
}

test('session progress counts only active WIB trading minutes', () => {
  const monday1000 = volumePace.sessionProgress('2026-08-03', '10:00');
  assert.equal(monday1000.active_trading_minutes, 60);
  assert.equal(monday1000.total_trading_minutes, 330);
  assert.equal(monday1000.session_progress_fraction, 0.18);

  const mondayBreak = volumePace.sessionProgress('2026-08-03', '12:30');
  assert.equal(mondayBreak.active_trading_minutes, 180);
  assert.equal(mondayBreak.session_progress_fraction, 0.55);
  assert.equal(mondayBreak.market_state, 'MARKET_BREAK');

  const mondayAfternoonOpen = volumePace.sessionProgress('2026-08-03', '13:30');
  assert.equal(mondayAfternoonOpen.active_trading_minutes, 180);
  assert.equal(mondayAfternoonOpen.session_progress_fraction, 0.55);

  const mondayClose = volumePace.sessionProgress('2026-08-03', '16:00');
  assert.equal(mondayClose.session_progress_fraction, 1);

  const fridayBreak = volumePace.sessionProgress('2026-08-07', '11:45');
  assert.equal(fridayBreak.active_trading_minutes, 150);
  assert.equal(fridayBreak.total_trading_minutes, 270);
  assert.equal(fridayBreak.session_progress_fraction, 0.56);
  assert.equal(fridayBreak.market_state, 'MARKET_BREAK');
});

test('completed baselines exclude the current partial candle', () => {
  const result = volumePace.deriveBaselines({
    sample_date: '2026-08-03',
    candles: completedCandles()
  });
  assert.equal(result.previous_day_volume, 10_000_000);
  assert.equal(result.avg_volume_20d_ex_today, 10_000_000);
  assert.match(result.volume_baseline_source, /completed_candles_previous_day/);
  assert.match(result.volume_baseline_source, /completed_candles_20d/);
});

test('morning partial volume resolves to full-day volume pace', () => {
  const result = volumePace.calculateVolumePace({
    sample_date: '2026-08-03',
    scheduled_time: '10:00',
    volume_today: 3_600_000,
    previous_day_volume: 10_000_000,
    avg_volume_20d_ex_today: 10_000_000
  });
  assert.equal(result.volume_pace_version, 'INTRADAY_VOLUME_PACE_V1');
  assert.equal(result.projected_full_day_volume, 20_000_000);
  assert.equal(result.volume_pace_vs_20d, 2);
  assert.equal(result.volume_pace_vs_prev_day, 2);
  assert.equal(result.intraday_volume_pace_ratio, 2);
  assert.equal(result.volume_pace_confidence, 'HIGH');
});

test('legacy average can be converted to an excluding-today baseline', () => {
  const result = volumePace.deriveBaselines({
    sample_date: '2026-08-03',
    avg_volume_20d: 9_600_000,
    avg_volume_sample_count: 20,
    volume_today: 2_000_000
  });
  assert.equal(result.avg_volume_20d_ex_today, 10_000_000);
  assert.match(result.volume_baseline_source, /derived_legacy_average_ex_today/);
});

test('volume pace is preferred over the legacy full-day ratio', () => {
  const metrics = momentum.metricsFrom(spikeObservation({
    intraday_volume_pace_ratio: 2.2,
    relative_volume: 0.4,
    volume_ratio_20d: 0.4
  }));
  assert.equal(metrics.relative_volume, 2.2);
  assert.equal(metrics.legacy_relative_volume, 0.4);
  assert.equal(metrics.volume_signal_source, 'intraday_volume_pace');
});

test('adaptive pool selects at most 30 and preserves at least ten fresh rows', () => {
  const freshRows = Array.from({ length: 12 }, (_, index) => ({ ticker: ticker(index), score: 100 - index }));
  const carriedRows = Array.from({ length: 30 }, (_, index) => [ticker(100 + index), {
    active: true,
    status: 'WATCHING',
    shortlist_rank: index + 1,
    source_score: 70,
    source_status: 'WATCHING',
    last_watch_score: 100,
    last_publish_score: 100,
    ready_streak: 0,
    max_expires_at_minute: null
  }]);
  const priorState = {
    date: '2026-08-03',
    rule_version: pool.RULE_VERSION,
    tickers: Object.fromEntries(carriedRows)
  };
  const merged = pool.mergePayload({ results: freshRows }, priorState, '10:00', [], 30);
  assert.equal(merged.results.length, 30);
  assert.equal(new Set(merged.results.map(row => row.ticker)).size, 30);
  assert.ok(merged.results.filter(row => row.source_origin !== 'carried_pool').length >= 10);
  assert.equal(merged.diagnostics.applied_limit, 30);
});

test('process hard-caps active state at 30 and resets V6 state', () => {
  const shortlistRows = Array.from({ length: 35 }, (_, index) => ({
    ticker: ticker(index),
    source_rank: index + 1,
    source_origin: 'current_radar'
  }));
  const priorState = {
    schema_version: 3,
    date: '2026-08-03',
    rule_version: 'FAST_WATCHER_ADAPTIVE_MOMENTUM_V6',
    tickers: { OLD: { active: true, status: 'READY_CONFIRMED' } }
  };
  const result = pool.process({
    sampleDate: '2026-08-03',
    scheduledTime: '10:00',
    shortlistRows,
    observations: [],
    priorState,
    now: '2026-08-03T03:00:00Z'
  });
  assert.equal(result.state.rule_version, 'FAST_WATCHER_VOLUME_PACE_V7');
  assert.equal(result.state.shortlist.length, 30);
  assert.equal(result.active_pool_count, 30);
  assert.equal(result.state.tickers.OLD, undefined);
});

test('strong late entry becomes informational SPIKE_RADAR, never confirmation', () => {
  const observation = spikeObservation();
  const result = pool.process({
    sampleDate: '2026-08-03',
    scheduledTime: '10:00',
    shortlistRows: [{ ticker: 'BBRI', source_rank: 1, source_origin: 'current_radar' }],
    observations: [observation],
    now: '2026-08-03T03:00:00Z'
  });
  const item = result.state.tickers.BBRI;
  assert.equal(item.status, 'SPIKE_RADAR');
  assert.equal(item.ready_streak, 0);
  assert.deepEqual(item.confirmation_window, []);
  assert.equal(result.confirmed.length, 0);
  assert.equal(result.publishable.length, 0);
  assert.equal(result.informational_spikes.length, 1);
  assert.ok(item.last_reasons.includes('not_entry_eligible_do_not_chase'));

  const radarRows = radar.selectRadarCandidates(result.state);
  assert.equal(radarRows.length, 1);
  assert.equal(radarRows[0].internal_status, 'SPIKE_RADAR');
  const message = radar.buildRadarTelegramMessage(radarRows, '2026-08-03', '10:00');
  assert.match(
    message,
    /Momentum sudah bergerak\. Bukan sinyal entry baru; jangan mengejar harga\./
  );
});

test('TP1 touched remains blocked and is never promoted to spike radar', () => {
  const result = momentum.evaluate(spikeObservation({
    current_price: 120,
    high: 121,
    entry_high: 115,
    tp1: 120
  }), {
    first_price: 100,
    last_price: 118,
    last_observation_minute: 598,
    highest_price_since_lock: 121
  });
  assert.equal(result.status, 'BLOCKED_CHASE');
  assert.equal(result.informational_spike, false);
  assert.deepEqual(result.reasons, ['tp1_already_reached']);
});

test('guarded-live CLI defaults to 30 and rejects values above 30', async () => {
  assert.equal(guardedCli.parseArgs(['node', 'tool']).maxShortlist, 30);
  assert.match(guardedCli.USAGE, /--max-shortlist 30/);
  const code = await guardedCli.main([
    'node', 'tool',
    '--sample-date', '2026-08-03',
    '--scheduled-time', '10:00',
    '--shortlist-file', 'ignored',
    '--max-shortlist', '31'
  ]);
  assert.equal(code, 2);
});
