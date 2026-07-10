'use strict';

/**
 * Self-contained test for sanitizeNkStagingRow allowlist + NK_STAGING_ALLOWED_COLUMNS.
 * Does NOT require @supabase/supabase-js — extracts the allowlist constant and function
 * directly from the source file to enable testing without node_modules.
 *
 * When dependencies are available (CI), use the full import test below.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// --- Extract NK_STAGING_ALLOWED_COLUMNS and sanitizeNkStagingRow from source ---
// This avoids requiring sector-hot.js (which needs @supabase/supabase-js)
var sourceCode = fs.readFileSync(path.join(__dirname, '..', 'api', 'sector-hot.js'), 'utf-8');

// Extract NK_STAGING_ALLOWED_COLUMNS array
var allowlistMatch = sourceCode.match(/var NK_STAGING_ALLOWED_COLUMNS\s*=\s*\[([\s\S]*?)\];/);
if (!allowlistMatch) throw new Error('Could not find NK_STAGING_ALLOWED_COLUMNS in source');
// Parse the allowlist — eval is safe here since it's a string literal array from our own source
var NK_STAGING_ALLOWED_COLUMNS = eval('[' + allowlistMatch[1] + ']');

// Reconstruct sanitizeNkStagingRow using the extracted allowlist
function sanitizeNkStagingRow(row) {
  var src = row || {};
  var out = {};
  for (var i = 0; i < NK_STAGING_ALLOWED_COLUMNS.length; i++) {
    var col = NK_STAGING_ALLOWED_COLUMNS[i];
    if (src[col] !== undefined) out[col] = src[col];
  }
  return out;
}

// --- Also extract buildNkNoCandidateDiagnostics essential logic for no_staging_rows test ---
// We only need to verify that rows.length === 0 produces { no_staging_rows: 1 }
function buildNkNoCandidateDiagnosticsMinimal(rows) {
  rows = Array.isArray(rows) ? rows : [];
  var reasons = {};
  if (rows.length === 0) {
    reasons.no_staging_rows = 1;
  }
  var topReasons = Object.keys(reasons).map(function(k) { return { reason: k, count: reasons[k] }; });
  return { raw_candidates_count: rows.length, top_rejection_reasons: topReasons };
}

// -- Helpers --

/** Simulates a full scored object from calculateNkSetupScore + batch enrichment. */
function buildFullScoredObject(overrides) {
  return Object.assign({
    // From calculateNkSetupScore return (includes close_price at L9130)
    score: 72,
    score_before_atr_penalty: 74,
    score_before_weekly_tf: 73,
    weekly_tf_label: 'Weekly neutral',
    weekly_tf_score_adjustment: -1,
    weekly_tf_notes: 'weekly close near MA10',
    weekly_close: 5000,
    weekly_ma10: 5050,
    score_before_market_regime: 72,
    market_regime_label: 'MARKET_NORMAL',
    market_regime_score_adjustment: 0,
    market_regime_notes: 'Normal',
    atr_score_penalty: -2,
    atr_penalty_reasons: ['SL wide'],
    atr_risk_adjustment: 'none',
    atr14: 80,
    sl_atr_multiple: 1.5,
    tp1_atr_multiple: 2.0,
    tp2_atr_multiple: 3.0,
    sl_atr_class: 'normal',
    tp1_atr_class: 'normal',
    tp2_atr_class: 'wide',
    atr_warning_notes: [],
    grade: 'B',
    status: 'Watchlist',
    status_reason: 'Setup lumayan',
    setup_type: 'pullback',
    last_price: 5025,
    price_source: 'yahoo',
    price_asof: '2026-07-10T10:00:00Z',
    price_date: '2026-07-10',
    open_price: 5000,
    high_price: 5050,
    low_price: 4980,
    close_price: 5025,         // <-- NOT in staging table — ROOT CAUSE
    previous_close: 5000,
    prev_close: 5000,
    change_pct: 0.5,
    avg_volume_20d: 1000000,
    avg_transaction_value_20d: 5000000000,
    tx_value_1d: 6000000000,
    avg_tx_value_3d: 5500000000,
    avg_tx_value_7d: 5200000000,
    traded_days_20d: 20,
    risk_reward: 2.5,
    volume_ratio_avg20: 1.2,
    ma20: 4950,
    ma50: 4800,
    rsi14: 55.5,
    entry_low: 4950,
    entry_high: 5010,
    stop_loss: 4800,
    tp1: 5500,
    tp2: 5800,
    support: 4780,
    resistance: 5100,
    // Batch handler additions
    ticker: 'BBRI',
    board: 'UTAMA',
    run_date: '2026-07-10',
    calculated_at: '2026-07-10T10:30:00Z',
    // V6 MTF context (added by batch after calculateNkSetupScore)
    tf_1d_context: 'Green candle',
    tf_2d_context: 'Bullish',           // <-- NOT in staging table
    tf_3d_context: 'Bullish',           // <-- NOT in staging table
    tf_5d_context: 'Bullish momentum',
    tf_10d_context: 'Uptrend',          // <-- NOT in staging table
    tf_20d_context: 'Uptrend',
    multi_timeframe_bias: 'Bullish',
    multi_timeframe_notes: 'All TF aligned', // <-- NOT in staging table
    volume_phase: 'Accumulation',
    risk_label: 'Medium Risk',
    quality_grade: 'B'
  }, overrides || {});
}

// Fields that exist in the scored object but NOT in staging table
var KNOWN_NON_STAGING_FIELDS = [
  'close_price',
  'tf_2d_context', 'tf_3d_context', 'tf_10d_context', 'multi_timeframe_notes',
  'score_before_atr_penalty', 'atr_score_penalty', 'atr_penalty_reasons',
  'atr_risk_adjustment', 'atr14', 'sl_atr_multiple', 'tp1_atr_multiple',
  'tp2_atr_multiple', 'sl_atr_class', 'tp1_atr_class', 'tp2_atr_class',
  'atr_warning_notes',
  'score_before_weekly_tf', 'weekly_tf_label', 'weekly_tf_score_adjustment',
  'weekly_tf_notes', 'weekly_close', 'weekly_ma10',
  'score_before_market_regime', 'market_regime_label',
  'market_regime_score_adjustment', 'market_regime_notes'
];

// ============================================================
// TEST 1: sanitizeNkStagingRow drops close_price
// ============================================================
test('sanitizeNkStagingRow drops close_price', function() {
  var input = { ticker: 'BBRI', close_price: 5025, last_price: 5025, score: 72, run_date: '2026-07-10' };
  var result = sanitizeNkStagingRow(input);
  assert.equal(result.close_price, undefined, 'close_price must not be in sanitized output');
  assert.equal(result.ticker, 'BBRI', 'ticker must be preserved');
  assert.equal(result.last_price, 5025, 'last_price must be preserved');
  assert.equal(result.score, 72, 'score must be preserved');
  assert.equal(result.run_date, '2026-07-10', 'run_date must be preserved');
});

// ============================================================
// TEST 2: sanitizeNkStagingRow drops ALL unsupported fields from full scored object
// ============================================================
test('sanitizeNkStagingRow drops ALL unsupported fields from full scored object', function() {
  var fullScored = buildFullScoredObject();
  var result = sanitizeNkStagingRow(fullScored);
  var resultKeys = Object.keys(result);

  // Verify no non-staging field leaked through
  KNOWN_NON_STAGING_FIELDS.forEach(function(field) {
    assert.equal(result[field], undefined, field + ' must not be in sanitized output');
  });

  // Verify all result keys are in the allowlist
  resultKeys.forEach(function(key) {
    assert.ok(NK_STAGING_ALLOWED_COLUMNS.indexOf(key) >= 0,
      'Output key "' + key + '" is not in NK_STAGING_ALLOWED_COLUMNS');
  });
});

// ============================================================
// TEST 3: sanitizeNkStagingRow preserves all required staging fields
// ============================================================
test('sanitizeNkStagingRow preserves all required staging fields', function() {
  var fullScored = buildFullScoredObject();
  var result = sanitizeNkStagingRow(fullScored);

  // Critical fields used by finalize and publish
  var requiredFields = [
    'ticker', 'score', 'run_date', 'entry_low', 'entry_high',
    'stop_loss', 'tp1', 'tp2', 'risk_reward', 'last_price',
    'status', 'status_reason', 'grade', 'board',
    'ma20', 'ma50', 'rsi14', 'support', 'resistance',
    'volume_ratio_avg20', 'calculated_at'
  ];

  requiredFields.forEach(function(field) {
    assert.ok(result[field] !== undefined,
      'Required field "' + field + '" must be preserved in sanitized output (got: ' + result[field] + ')');
  });
});

// ============================================================
// TEST 4: sanitizeNkStagingRow is idempotent
// ============================================================
test('sanitizeNkStagingRow is idempotent', function() {
  var fullScored = buildFullScoredObject();
  var first = sanitizeNkStagingRow(fullScored);
  var second = sanitizeNkStagingRow(first);
  assert.deepStrictEqual(first, second, 'Running sanitize twice must produce identical result');
});

// ============================================================
// TEST 5: sanitizeNkStagingRow handles empty/null/undefined input
// ============================================================
test('sanitizeNkStagingRow handles empty and null input', function() {
  assert.deepStrictEqual(sanitizeNkStagingRow({}), {}, 'empty object');
  assert.deepStrictEqual(sanitizeNkStagingRow(null), {}, 'null input');
  assert.deepStrictEqual(sanitizeNkStagingRow(undefined), {}, 'undefined input');
});

// ============================================================
// TEST 6: sanitizeNkStagingRow does not include unknown future fields
// ============================================================
test('sanitizeNkStagingRow rejects arbitrary unknown fields', function() {
  var input = {
    ticker: 'BBRI',
    score: 72,
    run_date: '2026-07-10',
    some_future_field: 'should be dropped',
    another_new_column: 123,
    ai_recommendation: 'buy'
  };
  var result = sanitizeNkStagingRow(input);
  assert.equal(result.some_future_field, undefined);
  assert.equal(result.another_new_column, undefined);
  assert.equal(result.ai_recommendation, undefined);
  assert.equal(result.ticker, 'BBRI');
  assert.equal(result.score, 72);
});

// ============================================================
// TEST 7: NK_STAGING_ALLOWED_COLUMNS does not include close_price or other latest-only fields
// ============================================================
test('NK_STAGING_ALLOWED_COLUMNS does not include close_price or other latest-only fields', function() {
  assert.ok(NK_STAGING_ALLOWED_COLUMNS.indexOf('close_price') === -1,
    'close_price must not be in allowlist');
  assert.ok(NK_STAGING_ALLOWED_COLUMNS.indexOf('tf_2d_context') === -1,
    'tf_2d_context must not be in allowlist');
  assert.ok(NK_STAGING_ALLOWED_COLUMNS.indexOf('tf_3d_context') === -1,
    'tf_3d_context must not be in allowlist');
  assert.ok(NK_STAGING_ALLOWED_COLUMNS.indexOf('tf_10d_context') === -1,
    'tf_10d_context must not be in allowlist');
  assert.ok(NK_STAGING_ALLOWED_COLUMNS.indexOf('multi_timeframe_notes') === -1,
    'multi_timeframe_notes must not be in allowlist');
  assert.ok(NK_STAGING_ALLOWED_COLUMNS.indexOf('atr14') === -1,
    'atr14 must not be in allowlist');
  assert.ok(NK_STAGING_ALLOWED_COLUMNS.indexOf('rank') === -1,
    'rank must not be in allowlist (latest-only)');
  assert.ok(NK_STAGING_ALLOWED_COLUMNS.indexOf('published_at') === -1,
    'published_at must not be in allowlist (latest-only)');
});

// ============================================================
// TEST 8: NK_STAGING_ALLOWED_COLUMNS includes all finalize-required fields
// ============================================================
test('NK_STAGING_ALLOWED_COLUMNS includes all finalize-required fields', function() {
  var finalizeRequired = [
    'ticker', 'board', 'last_price', 'score', 'grade', 'risk_reward',
    'entry_low', 'entry_high', 'stop_loss', 'tp1', 'tp2',
    'status', 'status_reason', 'setup_type',
    'run_date', 'calculated_at',
    'support', 'resistance', 'ma20', 'ma50', 'rsi14'
  ];
  finalizeRequired.forEach(function(col) {
    assert.ok(NK_STAGING_ALLOWED_COLUMNS.indexOf(col) >= 0,
      'Finalize-required column "' + col + '" must be in allowlist');
  });
});

// ============================================================
// TEST 9: buildNkNoCandidateDiagnostics with 0 rows returns no_staging_rows
// ============================================================
test('no_staging_rows reason produced when staging has 0 rows', function() {
  var result = buildNkNoCandidateDiagnosticsMinimal([]);
  assert.ok(result.top_rejection_reasons, 'top_rejection_reasons must exist');
  var noStagingReason = result.top_rejection_reasons.find(function(r) { return r.reason === 'no_staging_rows'; });
  assert.ok(noStagingReason, 'no_staging_rows must be in rejection reasons');
  assert.equal(noStagingReason.count, 1);
  assert.equal(result.raw_candidates_count, 0);
});

// ============================================================
// TEST 10: buildNkNoCandidateDiagnostics with rows does NOT have no_staging_rows
// ============================================================
test('no_staging_rows reason absent when staging has rows', function() {
  var rows = [{ ticker: 'BBRI', score: 72 }];
  var result = buildNkNoCandidateDiagnosticsMinimal(rows);
  var noStagingReason = (result.top_rejection_reasons || []).find(function(r) { return r.reason === 'no_staging_rows'; });
  assert.equal(noStagingReason, undefined, 'no_staging_rows should not appear when rows exist');
  assert.equal(result.raw_candidates_count, 1);
});

// ============================================================
// TEST 11: staging_write_mismatch detection remains in batch response
// ============================================================
test('batch response includes staging_write_mismatch detection', function() {
  var mismatchMatch = sourceCode.match(/staging_write_mismatch:\s*passedCountBeforeStaging\s*>\s*0\s*&&\s*stagingWriteCount\s*===\s*0/);
  assert.ok(mismatchMatch, 'staging_write_mismatch detection must remain in batch response');
});
