'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const adapter = require('../lib/daytrade-screener-engine-v7');

function candles(options) {
  const opts = options || {};
  const rows = [];
  for (let index = 0; index < 20; index += 1) {
    const day = 8 + index;
    const month = day <= 31 ? '07' : '08';
    const dateDay = day <= 31 ? day : day - 31;
    const close = 100 + Math.floor(index / 10);
    rows.push({
      date: `2026-${month}-${String(dateDay).padStart(2, '0')}`,
      open: close - 1,
      high: close + 2,
      low: close - 2,
      close,
      volume: 10_000_000
    });
  }
  rows.push({
    date: opts.currentDate || '2026-08-03',
    open: opts.open ?? 100,
    high: opts.high ?? 105,
    low: opts.low ?? 99,
    close: opts.close ?? 104,
    volume: opts.volume ?? 3_600_000
  });
  return rows;
}

function baseResult(overrides) {
  return Object.assign({
    ticker: 'BBRI',
    board: 'UTAMA',
    status: 'SPECULATIVE',
    setup: 'Speculative Setup',
    notes: 'Legacy raw-volume result.',
    daytrade_score: 52,
    liquidity_score: 6,
    prespike_score: 12,
    momentum_score: 12,
    penalty_score: 0,
    candle_score: 0,
    candle_pattern: null,
    last_price: 104,
    open_price: 100,
    high_price: 105,
    low_price: 99,
    stop_loss: 95,
    tp1: 112,
    risk_reward: 1.8,
    entry_status: 'IN_ENTRY',
    trading_plan_valid: true,
    data_quality_valid: true,
    data_quality_needs_revalidation: false
  }, overrides || {});
}

test('full-scan adapter recognizes strong morning pace but caps recall below READY', () => {
  const result = adapter.applyVolumePaceRecall(
    baseResult(),
    candles(),
    { sampleDate: '2026-08-03', scheduledTime: '10:00', runMode: 'MORNING_SCOUT' }
  );
  assert.equal(result.intraday_volume_pace_ratio, 2);
  assert.equal(result.raw_volume_ratio_20d < 1, true);
  assert.equal(result.volume_signal_source, 'intraday_volume_pace');
  assert.ok(result.daytrade_score <= 74);
  assert.equal(adapter.ENTRY_READY_STATUSES.has(result.status), false);
  assert.equal(result.volume_pace_recall_applied, true);
});

test('missing current-session candle disables projection and recall', () => {
  const historyOnly = candles({ currentDate: '2026-08-02' });
  const result = adapter.applyVolumePaceRecall(
    baseResult(),
    historyOnly,
    { sampleDate: '2026-08-03', scheduledTime: '10:00', runMode: 'MORNING_SCOUT' }
  );
  assert.equal(result.current_session_candle_present, false);
  assert.equal(result.intraday_volume_pace_ratio, null);
  assert.equal(result.volume_pace_recall_applied, false);
  assert.equal(result.status, 'SPECULATIVE');
});

test('data-quality failure remains blocked from recall promotion', () => {
  const result = adapter.applyVolumePaceRecall(
    baseResult({ data_quality_valid: false, status: 'EARLY_RADAR' }),
    candles(),
    { sampleDate: '2026-08-03', scheduledTime: '10:00', runMode: 'MORNING_SCOUT' }
  );
  assert.equal(result.volume_pace_recall_applied, false);
  assert.equal(result.volume_pace_recall_reason, 'safety_structure_blocked');
  assert.equal(result.status, 'EARLY_RADAR');
});

test('stop and TP1 boundaries cannot be overridden by volume pace', () => {
  const stopped = adapter.applyVolumePaceRecall(
    baseResult({ last_price: 95, stop_loss: 95, status: 'AVOID' }),
    candles(),
    { sampleDate: '2026-08-03', scheduledTime: '10:00', runMode: 'MORNING_SCOUT' }
  );
  assert.equal(stopped.volume_pace_recall_applied, false);
  assert.equal(stopped.status, 'AVOID');

  const targetHit = adapter.applyVolumePaceRecall(
    baseResult({ last_price: 112, tp1: 112, status: 'WAIT_PULLBACK' }),
    candles(),
    { sampleDate: '2026-08-03', scheduledTime: '10:00', runMode: 'MORNING_SCOUT' }
  );
  assert.equal(targetHit.volume_pace_recall_applied, false);
  assert.equal(targetHit.status, 'WAIT_PULLBACK');
});

test('existing entry-ready decision remains authoritative', () => {
  const original = baseResult({ status: 'READY_BREAKOUT', daytrade_score: 78 });
  const result = adapter.applyVolumePaceRecall(
    original,
    candles(),
    { sampleDate: '2026-08-03', scheduledTime: '10:00', runMode: 'MORNING_SCOUT' }
  );
  assert.equal(result.status, 'READY_BREAKOUT');
  assert.equal(result.daytrade_score, 78);
});

test('high pace below open never becomes an entry-ready status', () => {
  const result = adapter.applyVolumePaceRecall(
    baseResult({ last_price: 98, open_price: 102, high_price: 104, low_price: 97 }),
    candles({ open: 102, high: 104, low: 97, close: 98, volume: 6_000_000 }),
    { sampleDate: '2026-08-03', scheduledTime: '10:00', runMode: 'MORNING_SCOUT' }
  );
  assert.equal(adapter.ENTRY_READY_STATUSES.has(result.status), false);
  assert.ok(result.penalty_score <= 0);
});
