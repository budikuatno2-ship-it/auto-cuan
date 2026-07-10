const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SECTOR_HOT_DISABLE_AUTO_SCHEDULER = '1';

const sectorHot = require('../api/sector-hot');

const REQUIRED_STAGING_FIELDS = [
  'ticker',
  'board',
  'last_price',
  'score',
  'grade',
  'risk_reward',
  'status',
  'status_reason',
  'setup_type',
  'entry_low',
  'entry_high',
  'stop_loss',
  'tp1',
  'tp2',
  'support',
  'resistance',
  'run_date',
  'calculated_at',
  'risk_label',
  'quality_grade'
];

function buildRow() {
  return {
    ticker: 'SAFE',
    board: 'MAIN',
    run_date: '2026-07-10',
    last_price: 1000,
    change_pct: 1.5,
    avg_volume_20d: 2000000,
    avg_transaction_value_20d: 3000000000,
    traded_days_20d: 20,
    ma20: 950,
    ma50: 900,
    rsi14: 55.5,
    volume_ratio_avg20: 1.2,
    support: 940,
    resistance: 1100,
    entry_low: 990,
    entry_high: 1010,
    stop_loss: 930,
    tp1: 1080,
    tp2: 1150,
    risk_reward: 2.1,
    score: 88,
    grade: 'A',
    status: 'BUY',
    status_reason: 'Strong setup',
    calculated_at: '2026-07-10T00:00:00.000Z',
    tf_1d_context: 'bullish',
    tf_5d_context: 'bullish',
    tf_20d_context: 'neutral',
    multi_timeframe_bias: 'bullish',
    volume_phase: 'Accumulation',
    risk_label: 'Medium Risk',
    quality_grade: 'A',
    tx_value_1d: 4000000000,
    avg_tx_value_3d: 3500000000,
    avg_tx_value_7d: 3200000000,
    setup_type: 'pullback',
    close_price: 1000,
    tf_2d_context: 'unsupported',
    tf_3d_context: 'unsupported',
    tf_10d_context: 'unsupported',
    multi_timeframe_notes: 'unsupported',
    future_runtime_field: 'unsupported',
    nested_future_payload: { unsupported: true }
  };
}

test('sanitizeNkStagingRow uses a staging column allowlist', function() {
  const sanitized = sectorHot.__test.sanitizeNkStagingRow(buildRow());

  assert.equal(Object.prototype.hasOwnProperty.call(sanitized, 'close_price'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized, 'tf_2d_context'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized, 'tf_3d_context'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized, 'tf_10d_context'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized, 'multi_timeframe_notes'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized, 'future_runtime_field'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized, 'nested_future_payload'), false);

  for (const field of REQUIRED_STAGING_FIELDS) {
    assert.equal(sanitized[field], buildRow()[field], `${field} should be preserved`);
  }

  const allowed = new Set(sectorHot.__test.nkStagingColumns);
  for (const key of Object.keys(sanitized)) {
    assert.equal(allowed.has(key), true, `${key} must be in the staging allowlist`);
  }
});

test('sanitizeNkStagingRow is idempotent', function() {
  const once = sectorHot.__test.sanitizeNkStagingRow(buildRow());
  const twice = sectorHot.__test.sanitizeNkStagingRow(once);
  assert.deepEqual(twice, once);
});
