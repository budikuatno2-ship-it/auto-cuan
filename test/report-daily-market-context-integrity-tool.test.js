'use strict';

// Correctness coverage for the daily-context integrity diagnostic tool
// (tools/report-daily-market-context-integrity.js), built for Task 4/15 of
// the 12 Aug 2026 correctness audit. Live Supabase access is unavailable in
// this sandbox — these tests cover the pure classification/detection
// functions with synthetic rows shaped like real stock_daily_features rows.

const test = require('node:test');
const assert = require('node:assert/strict');

const tool = require('../tools/report-daily-market-context-integrity');

function baseRow(overrides) {
  return Object.assign({
    ticker: 'BBCA', as_of_trade_date: '2026-08-12', last_price: 9500,
    rsi_14: 55, rsi_state: 'NEUTRAL',
    week52_high: 10000, week52_low: 8000, week52_high_dist_pct: -5,
    volume_today: 1000, volume_previous_session: 900, volume_avg_7d: 950, volume_median_7d: 940,
    volume_ratio_vs_previous: 1.1, volume_ratio_vs_7d_avg: 1.05,
    foreign_net_7d: 12000, updated_at: '2026-08-12T09:30:00Z', data_freshness: 'current'
  }, overrides || {});
}

test('a clean row classifies as ok with no warnings', () => {
  const result = tool.classifyRow(baseRow());
  assert.equal(result.data_quality, 'ok');
  assert.deepEqual(result.warnings, []);
});

test('RSI out of [0,100] range is flagged as an error', () => {
  const result = tool.classifyRow(baseRow({ rsi_14: 140 }));
  assert.equal(result.data_quality, 'error');
  assert.ok(result.warnings.some((w) => w.startsWith('RSI_OUT_OF_RANGE')));
});

test('rsi_state inconsistent with rsi_14 is flagged (e.g. rsi_14=20 but state says NEUTRAL)', () => {
  const result = tool.classifyRow(baseRow({ rsi_14: 20, rsi_state: 'NEUTRAL' }));
  assert.ok(result.warnings.some((w) => w.startsWith('RSI_STATE_MISMATCH')));
});

test('week52_high below week52_low is flagged as an error', () => {
  const result = tool.classifyRow(baseRow({ week52_high: 7000, week52_low: 8000 }));
  assert.equal(result.data_quality, 'error');
  assert.ok(result.warnings.some((w) => w.startsWith('WEEK52_HIGH_BELOW_LOW')));
});

test('last_price above week52_high is flagged (raw/adjusted price-basis mismatch signal)', () => {
  const result = tool.classifyRow(baseRow({ last_price: 11000, week52_high: 10000 }));
  assert.ok(result.warnings.some((w) => w.startsWith('PRICE_ABOVE_52W_HIGH')));
});

test('a positive week52_high_dist_pct is flagged (price cannot exceed its own measured high)', () => {
  const result = tool.classifyRow(baseRow({ week52_high_dist_pct: 3.2 }));
  assert.ok(result.warnings.some((w) => w.startsWith('WEEK52_HIGH_DIST_POSITIVE')));
});

test('negative volume/ratio fields are flagged', () => {
  const result = tool.classifyRow(baseRow({ volume_today: -500 }));
  assert.ok(result.warnings.some((w) => w.startsWith('NEGATIVE_VOLUME_TODAY')));
  const result2 = tool.classifyRow(baseRow({ volume_ratio_vs_7d_avg: -1 }));
  assert.ok(result2.warnings.some((w) => w.startsWith('NEGATIVE_RATIO')));
});

test('a malformed ticker string is flagged', () => {
  const result = tool.classifyRow(baseRow({ ticker: 'bad ticker!!' }));
  assert.ok(result.warnings.some((w) => w.startsWith('MALFORMED_TICKER')));
});

test('null fields stay null in the classified row, never fabricated as zero', () => {
  const result = tool.classifyRow(baseRow({ rsi_14: null, foreign_net_7d: null }));
  assert.equal(result.rsi_current, null);
  assert.equal(result.foreign_net_7d, null);
  assert.equal(result.data_quality, 'ok'); // absence alone is not an anomaly
});

test('detectMixedDates: a coherent single-date batch is not flagged as mixed', () => {
  const rows = [baseRow({ ticker: 'A' }), baseRow({ ticker: 'B' }), baseRow({ ticker: 'C' })];
  const info = tool.detectMixedDates(rows);
  assert.equal(info.mixed, false);
  assert.equal(info.latest, '2026-08-12');
});

test('detectMixedDates: detects a mixed-date batch and reports per-date counts', () => {
  const rows = [
    baseRow({ ticker: 'A', as_of_trade_date: '2026-08-12' }),
    baseRow({ ticker: 'B', as_of_trade_date: '2026-08-12' }),
    baseRow({ ticker: 'C', as_of_trade_date: '2026-08-11' })
  ];
  const info = tool.detectMixedDates(rows);
  assert.equal(info.mixed, true);
  assert.equal(info.latest, '2026-08-12');
  assert.deepEqual(info.dates, ['2026-08-11', '2026-08-12']);
  assert.equal(info.counts['2026-08-11'], 1);
  assert.equal(info.counts['2026-08-12'], 2);
});

test('run(): missing Supabase credentials returns a clean non-zero exit without throwing', async () => {
  const result = await tool.run({ supabaseUrl: '', supabaseKey: '' });
  assert.equal(result.exitCode, 1);
  assert.ok(result.error);
});
