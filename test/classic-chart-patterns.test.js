'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const detector = require('../lib/classic-chart-patterns');
const smart = require('../lib/smart-setup-labels');
const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

function candle(index, values) {
  const close = values.close;
  return {
    time: `2026-01-${String((index % 28) + 1).padStart(2, '0')}`,
    open: values.open == null ? close - 0.2 : values.open,
    high: values.high,
    low: values.low,
    close,
    volume: values.volume == null ? 1_000_000 : values.volume
  };
}

function ascendingTriangle() {
  return Array.from({ length: 36 }, (_, index) => candle(index, {
    open: 107.5,
    high: 110 + ((index % 5) * 0.01),
    low: 88 + index * 0.45,
    close: 108.8 + index * 0.015,
    volume: 1_000_000
  }));
}

function bullFlag() {
  const filler = Array.from({ length: 20 }, (_, index) => candle(index, {
    high: 101.2 + index * 0.02,
    low: 98.8 + index * 0.02,
    close: 100 + index * 0.02
  }));
  const pole = Array.from({ length: 12 }, (_, index) => candle(index + 20, {
    high: 101.5 + index * 1.35,
    low: 99.2 + index * 1.35,
    close: 100 + index * 1.35,
    volume: 1_600_000
  }));
  const flag = Array.from({ length: 9 }, (_, index) => candle(index + 32, {
    high: 115.2 - index * 0.24,
    low: 112.8 - index * 0.24,
    close: 114.5 - index * 0.24,
    volume: 700_000
  }));
  return filler.concat(pole, flag);
}

function gapUp() {
  const rows = Array.from({ length: 24 }, (_, index) => candle(index, {
    high: 102 + index * 0.05,
    low: 99 + index * 0.05,
    close: 100.5 + index * 0.05
  }));
  const previous = rows[rows.length - 1];
  rows.push(candle(24, {
    open: previous.high * 1.025,
    high: previous.high * 1.055,
    low: previous.high * 1.02,
    close: previous.high * 1.045,
    volume: 1_800_000
  }));
  return rows;
}

test('classic detector finds an ascending triangle from converging T-1 structure', () => {
  const result = detector.detectClassicChartPatterns(ascendingTriangle(), { ticker:'TEST' });
  assert.ok(result.patterns.some(pattern => pattern.type === 'ASCENDING_TRIANGLE'));
  assert.ok(result.score_adjustment >= 0 && result.score_adjustment <= detector.MAX_SCORE_ADJUSTMENT);
});

test('classic detector finds a bull flag after a strong pole', () => {
  const result = detector.detectClassicChartPatterns(bullFlag(), { ticker:'TEST' });
  assert.ok(result.patterns.some(pattern => pattern.type === 'BULL_FLAG' || pattern.type === 'BULL_PENNANT'));
  assert.ok(result.patterns.some(pattern => pattern.bias === 'Bullish'));
});

test('classic detector identifies a bounded gap context and fails closed on short history', () => {
  const result = detector.detectClassicChartPatterns(gapUp(), { ticker:'TEST' });
  assert.ok(result.patterns.some(pattern => pattern.type === 'GAP_UP'));
  assert.ok(result.score_adjustment <= detector.MAX_SCORE_ADJUSTMENT);
  const short = detector.detectClassicChartPatterns(gapUp().slice(-10));
  assert.deepEqual(short.patterns, []);
  assert.equal(short.score_adjustment, 0);
  assert.ok(short.diagnostics.includes('history_insufficient'));
});

test('detector source includes every requested classic formation family', () => {
  const source = read('lib/classic-chart-patterns.js');
  for (const marker of [
    'ASCENDING_TRIANGLE', 'DESCENDING_TRIANGLE', 'SYMMETRICAL_TRIANGLE',
    'BULL_FLAG', 'BEAR_FLAG', 'BULL_PENNANT', 'BEAR_PENNANT',
    'CUP_AND_HANDLE', 'INVERTED_CUP_AND_HANDLE',
    'RISING_WEDGE', 'FALLING_WEDGE',
    'HEAD_AND_SHOULDERS', 'INVERSE_HEAD_AND_SHOULDERS',
    'DOUBLE_TOP', 'DOUBLE_BOTTOM', 'GAP_UP', 'GAP_DOWN'
  ]) assert.match(source, new RegExp(marker));
  assert.doesNotMatch(source, /sendTelegram|telegramNotifier|supabase|createOrder|action_label\s*=/i);
});

test('Swing pattern bonus is bounded, idempotent, and cannot bypass safety', () => {
  const positive = {
    ticker:'SAFE', swing_tier:'SWING_READY', tradeability:'High', score:70,
    last_price:100, ma20:99, ma50:95, risk_reward:2, rsi14:52, avg_tx_value_7d:1_000_000_000,
    classic_chart_patterns:[{ label:'Cup and Handle', type:'CUP_AND_HANDLE', bias:'Bullish', score_adjustment:4 }]
  };
  smart.applySmartSetupLabels(positive, { mode:'swing' });
  assert.equal(positive.score_before_pattern_adjustment, 70);
  assert.equal(positive.score, 75);
  assert.equal(positive.swing_pattern_score_adjustment, 5);
  smart.applySmartSetupLabels(positive, { mode:'swing' });
  assert.equal(positive.score, 75);

  const blocked = {
    ticker:'BLOCK', swing_tier:'SWING_READY', tradeability:'High', score:70, status:'AVOID',
    last_price:100, ma20:99, ma50:95, risk_reward:2, rsi14:52,
    classic_chart_patterns:[{ label:'Double Bottom', type:'DOUBLE_BOTTOM', bias:'Bullish', score_adjustment:4 }]
  };
  smart.applySmartSetupLabels(blocked, { mode:'swing' });
  assert.equal(blocked.score, 70);
  assert.equal(blocked.swing_pattern_score_adjustment, 0);
  assert.equal(blocked.status, 'AVOID');
});

test('bearish pattern may reduce Swing ranking but Day Trade score remains unchanged', () => {
  const swing = {
    ticker:'BEAR', swing_tier:'WATCHLIST', score:70, last_price:100,
    classic_chart_patterns:[{ label:'Head and Shoulders', type:'HEAD_AND_SHOULDERS', bias:'Bearish', score_adjustment:-4 }]
  };
  smart.applySmartSetupLabels(swing, { mode:'swing' });
  assert.equal(swing.score, 66);
  assert.equal(swing.swing_pattern_score_adjustment, -4);

  const daytrade = {
    ticker:'FAST', daytrade_score:80, score:80, last_price:100,
    classic_chart_patterns:[{ label:'Cup and Handle', type:'CUP_AND_HANDLE', bias:'Bullish', score_adjustment:4 }]
  };
  smart.applySmartSetupLabels(daytrade, { mode:'daytrade' });
  assert.equal(daytrade.score, 80);
  assert.equal(daytrade.swing_pattern_score_adjustment, undefined);
});
