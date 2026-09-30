'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const waiting = require('../lib/price-waiting-backtest');

function candle(date, open, high, low, close) {
  return { date, open, high, low, close, volume: 1000000 };
}

test('resolveFillPrice only fills when candle overlaps the pre-existing entry zone', () => {
  const plan = { entry_low: 95, entry_high: 100 };
  assert.equal(waiting.resolveFillPrice(candle('2026-01-02', 110, 112, 105, 106), plan), null);
  assert.equal(waiting.resolveFillPrice(candle('2026-01-03', 108, 110, 99, 100), plan), 100);
  assert.equal(waiting.resolveFillPrice(candle('2026-01-04', 98, 102, 96, 101), plan), 98);
  assert.equal(waiting.resolveFillPrice(candle('2026-01-05', 92, 96, 90, 95), plan), 95);
});

test('simulateWaitingSetup waits for the zone and preserves a measurable entry discount', () => {
  const candles = [
    candle('2026-01-01', 108, 111, 106, 110),
    candle('2026-01-02', 109, 110, 103, 104),
    candle('2026-01-03', 103, 104, 99, 100),
    candle('2026-01-04', 101, 108, 100, 107),
    candle('2026-01-05', 108, 121, 107, 120)
  ];
  const signal = {
    signal_date: '2026-01-01',
    signal_index: 0,
    signal_price: 110,
    entry_low: 95,
    entry_high: 100,
    stop_loss: 90,
    tp1: 120,
    score: 75,
    risk_reward: 2
  };

  const result = waiting.simulateWaitingSetup({
    ticker: 'TEST',
    candles,
    signalIndex: 0,
    signal,
    maxWaitDays: 3,
    maxHoldingDays: 5
  });

  assert.equal(result.filled, true);
  assert.equal(result.entry_date, '2026-01-03');
  assert.equal(result.entry_price, 100);
  assert.equal(result.wait_days, 2);
  assert.equal(result.entry_discount_pct, 9.09);
  assert.equal(result.resolution, 'TP_HIT');
  assert.equal(result.pnl_pct, 20);
  assert.equal(result.r_multiple, 2);
});

test('same-candle TP and SL after entry resolves conservatively to SL', () => {
  const candles = [
    candle('2026-01-01', 108, 111, 106, 110),
    candle('2026-01-02', 100, 125, 88, 115)
  ];
  const signal = {
    signal_date: '2026-01-01',
    signal_index: 0,
    signal_price: 110,
    entry_low: 95,
    entry_high: 100,
    stop_loss: 90,
    tp1: 120,
    score: 80,
    risk_reward: 2
  };

  const result = waiting.simulateWaitingSetup({
    ticker: 'TEST',
    candles,
    signalIndex: 0,
    signal,
    maxWaitDays: 2,
    maxHoldingDays: 5
  });

  assert.equal(result.filled, true);
  assert.equal(result.resolution, 'SL_HIT');
  assert.equal(result.exit_price, 90);
  assert.equal(result.r_multiple, -1);
});

test('gap below stop before a planned-zone fill invalidates the setup', () => {
  const candles = [
    candle('2026-01-01', 108, 111, 106, 110),
    candle('2026-01-02', 88, 92, 84, 90)
  ];
  const signal = {
    signal_date: '2026-01-01',
    signal_index: 0,
    signal_price: 110,
    entry_low: 95,
    entry_high: 100,
    stop_loss: 90,
    tp1: 120
  };

  const result = waiting.simulateWaitingSetup({
    ticker: 'TEST',
    candles,
    signalIndex: 0,
    signal,
    maxWaitDays: 2,
    maxHoldingDays: 5
  });

  assert.equal(result.filled, false);
  assert.equal(result.resolution, 'INVALID_BEFORE_ENTRY');
});

test('waiting setup expires honestly when price never reaches the entry zone', () => {
  const candles = [
    candle('2026-01-01', 108, 111, 106, 110),
    candle('2026-01-02', 109, 112, 105, 111),
    candle('2026-01-03', 112, 115, 108, 114),
    candle('2026-01-04', 114, 118, 110, 117)
  ];
  const signal = {
    signal_date: '2026-01-01',
    signal_index: 0,
    signal_price: 110,
    entry_low: 95,
    entry_high: 100,
    stop_loss: 90,
    tp1: 120
  };

  const result = waiting.simulateWaitingSetup({
    ticker: 'TEST',
    candles,
    signalIndex: 0,
    signal,
    maxWaitDays: 3,
    maxHoldingDays: 5
  });

  assert.equal(result.filled, false);
  assert.equal(result.resolution, 'EXPIRED_NO_ENTRY');
  assert.equal(result.wait_days, 3);
});

test('chase baseline enters next open using the exact original SL and TP geometry', () => {
  const candles = [
    candle('2026-01-01', 108, 111, 106, 110),
    candle('2026-01-02', 110, 121, 109, 120)
  ];
  const signal = {
    signal_date: '2026-01-01',
    signal_index: 0,
    stop_loss: 90,
    tp1: 120,
    score: 75,
    risk_reward: 2
  };

  const result = waiting.simulateChaseSetup({
    ticker: 'TEST',
    candles,
    signalIndex: 0,
    signal,
    maxHoldingDays: 3
  });

  assert.equal(result.filled, true);
  assert.equal(result.entry_price, 110);
  assert.equal(result.resolution, 'TP_HIT');
  assert.equal(result.pnl_pct, 9.09);
  assert.equal(result.r_multiple, 0.5);
});

test('summarizeResolutions reports fill rate separately from trade performance', () => {
  const summary = waiting.summarizeResolutions([
    { filled: true, resolution: 'TP_HIT', pnl_pct: 10, r_multiple: 2, holding_days: 3, wait_days: 2, entry_discount_pct: 5 },
    { filled: true, resolution: 'SL_HIT', pnl_pct: -5, r_multiple: -1, holding_days: 1, wait_days: 1, entry_discount_pct: 4 },
    { filled: false, resolution: 'EXPIRED_NO_ENTRY', wait_days: 5 },
    { filled: false, resolution: 'INVALID_BEFORE_ENTRY', wait_days: 2 }
  ]);

  assert.equal(summary.candidates, 4);
  assert.equal(summary.filled, 2);
  assert.equal(summary.fill_rate_pct, 50);
  assert.equal(summary.expired_no_entry, 1);
  assert.equal(summary.invalid_before_entry, 1);
  assert.equal(summary.avg_entry_discount_pct, 4.5);
  assert.equal(summary.avg_wait_days, 1.5);
  assert.equal(summary.trade_metrics.sample_size, 2);
});

test('waiting result is right-censored instead of expired when full wait horizon is unavailable', () => {
  const candles = [
    candle('2026-01-01', 110, 112, 108, 111),
    candle('2026-01-02', 111, 113, 109, 112)
  ];
  const signal = {
    signal_date: '2026-01-01', signal_index: 0, signal_price: 110,
    entry_low: 95, entry_high: 100, stop_loss: 90, tp1: 120
  };
  const result = waiting.simulateWaitingSetup({
    ticker: 'TEST', candles, signalIndex: 0, signal, maxWaitDays: 5, maxHoldingDays: 10
  });
  assert.equal(result.resolution, 'CENSORED_WAIT');
  assert.equal(result.censored, true);
  assert.equal(result.filled, false);
});

test('filled trade near end of history is right-censored instead of early TIMEOUT', () => {
  const candles = [
    candle('2026-01-01', 110, 112, 108, 111),
    candle('2026-01-02', 100, 105, 98, 104),
    candle('2026-01-03', 104, 108, 102, 107)
  ];
  const signal = {
    signal_date: '2026-01-01', signal_index: 0, signal_price: 110,
    entry_low: 95, entry_high: 100, stop_loss: 90, tp1: 120, score: 75, risk_reward: 2
  };
  const result = waiting.simulateWaitingSetup({
    ticker: 'TEST', candles, signalIndex: 0, signal, maxWaitDays: 2, maxHoldingDays: 10
  });
  assert.equal(result.resolution, 'CENSORED_HOLD');
  assert.equal(result.censored, true);
  assert.equal(result.filled, true);
  assert.equal(result.pnl_pct, null);
});

test('post-entry stop gap exits at the executable open price for wait and chase', () => {
  const candles = [
    candle('2026-01-01', 110, 112, 108, 111),
    candle('2026-01-02', 100, 105, 98, 104),
    candle('2026-01-03', 80, 85, 75, 82)
  ];
  const signal = {
    signal_date: '2026-01-01', signal_index: 0, signal_price: 110,
    entry_low: 95, entry_high: 100, stop_loss: 90, tp1: 120, score: 75, risk_reward: 2
  };
  const waited = waiting.simulateWaitingSetup({
    ticker: 'TEST', candles, signalIndex: 0, signal, maxWaitDays: 2, maxHoldingDays: 5
  });
  assert.equal(waited.resolution, 'SL_GAP');
  assert.equal(waited.exit_price, 80);
  assert.equal(waited.r_multiple, -2);

  const chaseCandles = [
    candle('2026-01-01', 110, 112, 108, 111),
    candle('2026-01-02', 100, 105, 98, 104),
    candle('2026-01-03', 80, 85, 75, 82)
  ];
  const chased = waiting.simulateChaseSetup({
    ticker: 'TEST', candles: chaseCandles, signalIndex: 0, signal, maxHoldingDays: 5
  });
  assert.equal(chased.resolution, 'SL_GAP');
  assert.equal(chased.exit_price, 80);
  assert.equal(chased.r_multiple, -2);
});

test('chronological drawdown metric is invariant to input ticker ordering', () => {
  const recordsA = [
    { ticker: 'ZZZ', filled: true, exit_date: '2026-01-03', pnl_pct: -10, r_multiple: -1, holding_days: 2 },
    { ticker: 'AAA', filled: true, exit_date: '2026-01-02', pnl_pct: 10, r_multiple: 1, holding_days: 1 },
    { ticker: 'BBB', filled: true, exit_date: '2026-01-03', pnl_pct: 4, r_multiple: 0.4, holding_days: 2 }
  ];
  const a = waiting.computeChronologicalTradeMetrics(recordsA);
  const b = waiting.computeChronologicalTradeMetrics(recordsA.slice().reverse());
  assert.equal(a.max_drawdown_pct, b.max_drawdown_pct);
  assert.equal(a.expectancy_r, b.expectancy_r);
  assert.equal(a.drawdown_method, 'EQUAL_WEIGHT_REALIZED_EXIT_DATE');
});

test('historical replay exports an explicit neutral confluence sentinel', () => {
  assert.equal(waiting.NEUTRAL_HISTORICAL_CONFLUENCE.confluence_penalty, 0);
  assert.equal(waiting.NEUTRAL_HISTORICAL_CONFLUENCE.confluence_flag, 'NETRAL_HISTORICAL_REPLAY');
});
