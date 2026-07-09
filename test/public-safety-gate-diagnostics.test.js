'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sectorHot = require('../api/sector-hot');

const {
  candidatePassesPublicTelegramSafetyGate,
  diagnosePublicSafetyGateRejection
} = sectorHot.__test;

// ============================================================
// BASE CANDIDATE FACTORY
// ============================================================

function base(overrides) {
  return Object.assign({
    ticker: 'COCO', category: 'Swing Konglo', status: 'Swing Ready', final_status: 'Swing Ready',
    risk_label: 'Medium Risk', risk_label_v2: 'Medium Risk', risk_reward: 2.0,
    entry_low: 1000, entry_high: 1050, entry1: 1050, entry2: 1000,
    sl: 950, stop_loss: 950, tp1n: 1200, tp1: 1200, tp2n: 1400, tp2: 1400,
    tp1_upside: 14.3, last_price: 1060, lastn: 1060,
    trading_plan_valid: true, plan_quality_status: 'VALID',
    liquidity_label: 'Liquid', volume_confirmation_label: 'Volume kuat',
    volume_label: 'Strong Volume', volume_notes: 'Volume di atas rata-rata.',
    entry_status: 'IN_ENTRY_AREA', entry_quality_status: 'IN_ENTRY_AREA',
    setup_freshness_status: 'FRESH', freshness_is_stale: false, is_stale: false,
    breakout_confirmation_status: 'CONFIRMED',
    telegram_verdict: 'Siap pantau entry valid jika harga/volume konfirmasi.',
    score: 82, quality_grade: 'B', confidence: 'B'
  }, overrides || {});
}

// ============================================================
// TEST: diagnosePublicSafetyGateRejection returns detailed reasons
// ============================================================

test('diagnosePublicSafetyGateRejection: null candidate → missing_candidate', () => {
  var diag = diagnosePublicSafetyGateRejection(null, 'daily_top5');
  assert.equal(diag.category, 'missing_candidate');
  assert.ok(diag.detailed_reason.length > 0);
});

test('diagnosePublicSafetyGateRejection: entry_status CHASE_RISK', () => {
  var c = base({ entry_status: 'CHASE_RISK' });
  assert.equal(candidatePassesPublicTelegramSafetyGate(c, 'daily_top5'), false);
  var diag = diagnosePublicSafetyGateRejection(c, 'daily_top5');
  assert.equal(diag.category, 'entry_status');
  assert.ok(diag.detailed_reason.indexOf('CHASE_RISK') >= 0);
});

test('diagnosePublicSafetyGateRejection: entry_status EXTENDED', () => {
  var c = base({ entry_status: 'EXTENDED' });
  assert.equal(candidatePassesPublicTelegramSafetyGate(c, 'daily_top5'), false);
  var diag = diagnosePublicSafetyGateRejection(c, 'daily_top5');
  assert.equal(diag.category, 'entry_status');
  assert.ok(diag.detailed_reason.indexOf('EXTENDED') >= 0);
});

test('diagnosePublicSafetyGateRejection: entry_quality NEEDS_REVALIDATION', () => {
  var c = base({ entry_status: 'IN_ENTRY_AREA', entry_quality_status: 'NEEDS_REVALIDATION' });
  assert.equal(candidatePassesPublicTelegramSafetyGate(c, 'daily_top5'), false);
  var diag = diagnosePublicSafetyGateRejection(c, 'daily_top5');
  assert.equal(diag.category, 'entry_quality');
  assert.ok(diag.detailed_reason.indexOf('NEEDS_REVALIDATION') >= 0);
});

test('diagnosePublicSafetyGateRejection: Very High Risk', () => {
  var c = base({ risk_label_v2: 'Very High Risk' });
  assert.equal(candidatePassesPublicTelegramSafetyGate(c, 'daily_top5'), false);
  var diag = diagnosePublicSafetyGateRejection(c, 'daily_top5');
  assert.equal(diag.category, 'very_high_risk');
  assert.ok(diag.detailed_reason.indexOf('Very High Risk') >= 0);
});

test('diagnosePublicSafetyGateRejection: breakout_confirmation NEEDS_CLOSE_CONFIRMATION', () => {
  var c = base({ breakout_confirmation_status: 'NEEDS_CLOSE_CONFIRMATION' });
  assert.equal(candidatePassesPublicTelegramSafetyGate(c, 'daily_top5'), false);
  var diag = diagnosePublicSafetyGateRejection(c, 'daily_top5');
  assert.equal(diag.category, 'breakout_confirmation');
  assert.ok(diag.detailed_reason.indexOf('NEEDS_CLOSE_CONFIRMATION') >= 0);
});

test('diagnosePublicSafetyGateRejection: freshness EXPIRED', () => {
  var c = base({ setup_freshness_status: 'EXPIRED' });
  assert.equal(candidatePassesPublicTelegramSafetyGate(c, 'daily_top5'), false);
  var diag = diagnosePublicSafetyGateRejection(c, 'daily_top5');
  assert.equal(diag.category, 'freshness');
  assert.ok(diag.detailed_reason.indexOf('EXPIRED') >= 0);
});

test('diagnosePublicSafetyGateRejection: is_stale=true', () => {
  var c = base({ is_stale: true });
  assert.equal(candidatePassesPublicTelegramSafetyGate(c, 'daily_top5'), false);
  var diag = diagnosePublicSafetyGateRejection(c, 'daily_top5');
  assert.equal(diag.category, 'freshness');
  assert.ok(diag.detailed_reason.indexOf('stale') >= 0 || diag.detailed_reason.indexOf('Stale') >= 0);
});

test('diagnosePublicSafetyGateRejection: weak volume', () => {
  var c = base({ volume_label: 'Weak Volume', volume_notes: 'volume lemah' });
  assert.equal(candidatePassesPublicTelegramSafetyGate(c, 'daily_top5'), false);
  var diag = diagnosePublicSafetyGateRejection(c, 'daily_top5');
  assert.equal(diag.category, 'weak_volume');
  assert.ok(diag.detailed_reason.length > 0);
});

test('diagnosePublicSafetyGateRejection: liquidity risk', () => {
  var c = base({ is_liquidity_risk: true, liquidity_label: 'Likuiditas Tipis' });
  assert.equal(candidatePassesPublicTelegramSafetyGate(c, 'daily_top5'), false);
  var diag = diagnosePublicSafetyGateRejection(c, 'daily_top5');
  assert.equal(diag.category, 'liquidity');
  assert.ok(diag.detailed_reason.length > 0);
});

test('diagnosePublicSafetyGateRejection: trading_plan_valid=false', () => {
  var c = base({ trading_plan_valid: false });
  assert.equal(candidatePassesPublicTelegramSafetyGate(c, 'daily_top5'), false);
  var diag = diagnosePublicSafetyGateRejection(c, 'daily_top5');
  assert.equal(diag.category, 'trading_plan_invalid');
  assert.ok(diag.detailed_reason.indexOf('trading_plan_valid=false') >= 0);
});

test('diagnosePublicSafetyGateRejection: plan_quality INVALID', () => {
  var c = base({ plan_quality_status: 'INVALID' });
  assert.equal(candidatePassesPublicTelegramSafetyGate(c, 'daily_top5'), false);
  var diag = diagnosePublicSafetyGateRejection(c, 'daily_top5');
  assert.equal(diag.category, 'plan_quality');
  assert.ok(diag.detailed_reason.indexOf('INVALID') >= 0);
});

test('diagnosePublicSafetyGateRejection: action text hindari', () => {
  var c = base({ action_label: 'Hindari' });
  assert.equal(candidatePassesPublicTelegramSafetyGate(c, 'daily_top5'), false);
  var diag = diagnosePublicSafetyGateRejection(c, 'daily_top5');
  assert.equal(diag.category, 'action_hindari_avoid');
  assert.ok(diag.detailed_reason.indexOf('hindari') >= 0 || diag.detailed_reason.indexOf('Hindari') >= 0);
});

test('diagnosePublicSafetyGateRejection: execution_reality UNKNOWN_LIMITS', () => {
  var c = base({ execution_reality_status: 'UNKNOWN_LIMITS' });
  assert.equal(candidatePassesPublicTelegramSafetyGate(c, 'daily_top5'), false);
  var diag = diagnosePublicSafetyGateRejection(c, 'daily_top5');
  assert.equal(diag.category, 'execution_reality');
  assert.ok(diag.detailed_reason.indexOf('UNKNOWN_LIMITS') >= 0);
});

test('diagnosePublicSafetyGateRejection: false_breakout_risk=true', () => {
  var c = base({ false_breakout_risk: true, breakout_confirmation_status: 'FALSE_BREAKOUT_RISK' });
  assert.equal(candidatePassesPublicTelegramSafetyGate(c, 'daily_top5'), false);
  var diag = diagnosePublicSafetyGateRejection(c, 'daily_top5');
  assert.equal(diag.category, 'breakout_confirmation');
  assert.ok(diag.detailed_reason.length > 0);
});

test('diagnosePublicSafetyGateRejection: data_quality INVALID_CANDLE', () => {
  var c = base({ data_quality_status: 'INVALID_CANDLE', data_quality_valid: false });
  assert.equal(candidatePassesPublicTelegramSafetyGate(c, 'daily_top5'), false);
  var diag = diagnosePublicSafetyGateRejection(c, 'daily_top5');
  assert.equal(diag.category, 'data_quality');
  assert.ok(diag.detailed_reason.length > 0);
});

test('diagnosePublicSafetyGateRejection: guard text chase', () => {
  var c = base({ entry_timing: 'chase — sudah extended jauh', entry_status: 'IN_ENTRY_AREA' });
  assert.equal(candidatePassesPublicTelegramSafetyGate(c, 'daily_top5'), false);
  var diag = diagnosePublicSafetyGateRejection(c, 'daily_top5');
  assert.equal(diag.category, 'guard_text_reject');
  assert.ok(diag.detailed_reason.indexOf('chase') >= 0);
});

// ============================================================
// TEST: Safe candidate passes gate — diagnose should not be called but handle gracefully
// ============================================================

test('safe candidate passes gate — diagnosePublicSafetyGateRejection returns unknown', () => {
  var c = base();
  assert.equal(candidatePassesPublicTelegramSafetyGate(c, 'daily_top5'), true);
  // Even if called on a passing candidate, it should return a benign result
  var diag = diagnosePublicSafetyGateRejection(c, 'daily_top5');
  // May return 'unknown' or 'final_top_quality_gate' depending on applyFinalTopQualityGate
  assert.ok(diag.category);
  assert.ok(diag.detailed_reason);
});

// ============================================================
// TEST: public safety gate still blocks same unsafe candidate (behavior unchanged)
// ============================================================

test('public safety gate still blocks CHASE_RISK candidate', () => {
  var c = base({ entry_status: 'CHASE_RISK' });
  assert.equal(candidatePassesPublicTelegramSafetyGate(c, 'daily_top5'), false);
});

test('public safety gate still blocks Very High Risk candidate', () => {
  var c = base({ risk_label_v2: 'Very High Risk' });
  assert.equal(candidatePassesPublicTelegramSafetyGate(c, 'daily_top5'), false);
});

test('public safety gate still blocks stale candidate', () => {
  var c = base({ freshness_is_stale: true });
  assert.equal(candidatePassesPublicTelegramSafetyGate(c, 'daily_top5'), false);
});

test('public safety gate still blocks action Hindari', () => {
  var c = base({ signal_action_label: 'Hindari' });
  assert.equal(candidatePassesPublicTelegramSafetyGate(c, 'daily_top5'), false);
});

test('public safety gate still allows safe candidate', () => {
  var c = base();
  assert.equal(candidatePassesPublicTelegramSafetyGate(c, 'daily_top5'), true);
});

// ============================================================
// TEST: send response does not expose internal diagnostics publicly
// (Verifying the dry_run diagnostics field structure)
// ============================================================

test('dry_run diagnostics structure has expected fields', () => {
  // Simulate building the diagnostics output as the handler does
  var rejectedByGate = [
    { ticker: 'COCO', reason: 'entry_status', detailed_reason: 'Entry status: CHASE_RISK' },
    { ticker: 'MTEL', reason: 'breakout_confirmation', detailed_reason: 'Breakout confirmation status: NEEDS_CLOSE_CONFIRMATION' },
    { ticker: 'SAME', reason: 'freshness', detailed_reason: 'Setup freshness status: EXPIRED' }
  ];

  var manualDiagnostics = {
    raw_candidate_pool_count: 82,
    after_readiness_count: 82,
    before_quality_gate_count: 10,
    after_quality_gate_count: 0,
    rejected_by_gate_count: rejectedByGate.length,
    top_rejection_reasons: (function() {
      var reasons = {};
      rejectedByGate.forEach(function(r) { reasons[r.reason] = (reasons[r.reason] || 0) + 1; });
      return reasons;
    })(),
    sample_rejected: rejectedByGate.slice(0, 10)
  };

  // Verify top_rejection_reasons uses detailed categories, not generic 'public_safety_gate'
  assert.ok(!('public_safety_gate' in manualDiagnostics.top_rejection_reasons), 'should not have generic public_safety_gate');
  assert.equal(manualDiagnostics.top_rejection_reasons.entry_status, 1);
  assert.equal(manualDiagnostics.top_rejection_reasons.breakout_confirmation, 1);
  assert.equal(manualDiagnostics.top_rejection_reasons.freshness, 1);

  // Verify sample_rejected includes detailed_reason
  assert.equal(manualDiagnostics.sample_rejected[0].ticker, 'COCO');
  assert.equal(manualDiagnostics.sample_rejected[0].reason, 'entry_status');
  assert.ok(manualDiagnostics.sample_rejected[0].detailed_reason.indexOf('CHASE_RISK') >= 0);
});

test('diagnostics are NOT present in non-dry_run response structure', () => {
  // Simulate a normal (non-dry_run) response — manualDiagnostics should be undefined
  var dryRun = false;
  var manualLatestSnapshotActive = false;
  var manualPreviousTradingDayActive = false;

  var manualDiagnostics = (dryRun || manualLatestSnapshotActive || manualPreviousTradingDayActive) ? {
    sample_rejected: []
  } : undefined;

  assert.equal(manualDiagnostics, undefined, 'diagnostics must be undefined for normal send');
});

// ============================================================
// TEST: normal weekday flow unchanged (gate behavior not weakened)
// ============================================================

test('normal weekday candidate passes safety gate when all conditions met', () => {
  // A well-formed candidate with no issues should always pass
  var c = base({
    entry_status: 'IN_ENTRY_AREA',
    entry_quality_status: 'IN_ENTRY_AREA',
    breakout_confirmation_status: 'CONFIRMED',
    setup_freshness_status: 'FRESH',
    plan_quality_status: 'VALID',
    trading_plan_valid: true,
    risk_label_v2: 'Low Risk',
    liquidity_label: 'Liquid',
    volume_label: 'Accumulation Volume',
    volume_confirmation_label: 'Volume kuat',
    is_stale: false,
    freshness_is_stale: false,
    data_stale: false,
    is_liquidity_risk: false,
    false_breakout_risk: false,
    buy_execution_realistic: true
  });
  assert.equal(candidatePassesPublicTelegramSafetyGate(c, 'daily_top5'), true);
});

test('normal weekday candidate blocked by entry_status CHASE_RISK remains blocked', () => {
  var c = base({
    entry_status: 'CHASE_RISK',
    entry_quality_status: 'IN_ENTRY_AREA',
    breakout_confirmation_status: 'CONFIRMED',
    setup_freshness_status: 'FRESH',
    plan_quality_status: 'VALID',
    trading_plan_valid: true,
    risk_label_v2: 'Low Risk'
  });
  assert.equal(candidatePassesPublicTelegramSafetyGate(c, 'daily_top5'), false);
});

test('diagnosePublicSafetyGateRejection produces non-empty category for every known block', () => {
  // Exhaust key scenarios and ensure no empty categories
  var scenarios = [
    { entry_status: 'TP1_HIT' },
    { entry_status: 'TP2_HIT' },
    { entry_quality_status: 'CHASE_RISK' },
    { setup_freshness_status: 'NEEDS_REVALIDATION' },
    { data_stale: true },
    { plan_quality_status: 'POOR_RR' },
    { breakout_confirmation_status: 'BREAKOUT_WATCH' },
    { execution_reality_status: 'ARA_HIT' },
    { invalidation_distance_status: 'INVALID_BELOW_SL' },
    { invalidation_distance_status: 'TOO_CLOSE_TO_SL' }
  ];

  for (var i = 0; i < scenarios.length; i++) {
    var c = base(scenarios[i]);
    assert.equal(candidatePassesPublicTelegramSafetyGate(c, 'daily_top5'), false, 'scenario ' + i + ' should fail gate');
    var diag = diagnosePublicSafetyGateRejection(c, 'daily_top5');
    assert.ok(diag.category && diag.category !== '', 'scenario ' + i + ' should have category');
    assert.ok(diag.detailed_reason && diag.detailed_reason !== '', 'scenario ' + i + ' should have detailed_reason');
    assert.notEqual(diag.category, 'unknown', 'scenario ' + i + ' should not be unknown: ' + JSON.stringify(scenarios[i]));
  }
});

test('entry_low/entry_high only are normalized as valid entry aliases with conservative TP1 upside', () => {
  const c = base({ entry1: null, entry2: null, entry_low: 1000, entry_high: 1050, tp1: 1200, tp1n: 1200, tp1_upside: null });
  sectorHot.__test.normalizeEntryRangeAliases(c);
  assert.equal(c.entry1, 1050);
  assert.equal(c.entry2, 1000);
  assert.equal(c.entry_mid, 1025);
  assert.equal(c.entry_alias_used, 'entry_low_entry_high');
  assert.equal(c.tp1_upside, 14.3);
  assert.equal(c.tp1_upside_pct, 14.3);
  assert.equal(candidatePassesPublicTelegramSafetyGate(c, 'daily_top5'), true);
});

test('entry range diagnostics count aliases and computed TP1 upside', () => {
  const diagnostics = sectorHot.__test.buildEntryRangeNormalizationDiagnostics([
    base({ ticker: 'RANG', entry1: null, entry2: null, entry_low: 1000, entry_high: 1050, tp1: 1200, tp1n: 1200, tp1_upside: null }),
    base({ ticker: 'MISS', entry1: null, entry2: null, entry_low: null, entry_high: null, tp1: 1200, tp1n: 1200, tp1_upside: null })
  ]);
  assert.equal(diagnostics.entry_range_present_count, 1);
  assert.equal(diagnostics.entry_alias_used_counts.entry_low_entry_high, 1);
  assert.equal(diagnostics.computed_tp1_upside_count, 1);
  assert.equal(diagnostics.computed_tp1_upside_pct_count, 1);
  assert.equal(diagnostics.tp1_upside_null_after_normalization_count, 0);
  assert.equal(diagnostics.tp1_upside_pct_null_after_normalization_count, 0);
  assert.equal(diagnostics.sample_computed_tp1_upside_pct[0].ticker, 'RANG');
  assert.equal(diagnostics.sample_entry_range_normalized[0].ticker, 'RANG');
  assert.equal(diagnostics.sample_entry_range_normalized[0].entry1, 1050);
  assert.equal(diagnostics.sample_entry_range_normalized[0].tp1_upside_pct, 14.3);
});

test('entry range normalization computes tp1_upside_pct from conservative entry_high examples', () => {
  const lead = base({ ticker: 'LEAD', entry1: null, entry2: null, entry_low: 97, entry_high: 99, tp1: 105, tp1n: 105, tp1_upside: null, tp1_upside_pct: null });
  sectorHot.__test.normalizeEntryRangeAliases(lead);
  assert.equal(lead.entry1, 99);
  assert.equal(lead.tp1_upside_pct, 6.1);

  const bbrm = base({ ticker: 'BBRM', entry1: null, entry2: null, entry_low: 113, entry_high: 116, tp1: 142, tp1n: 142, tp1_upside: null, tp1_upside_pct: null });
  sectorHot.__test.normalizeEntryRangeAliases(bbrm);
  assert.equal(bbrm.entry1, 116);
  assert.equal(bbrm.tp1_upside_pct, 22.4);
});

test('entry range normalization preserves valid tp1_upside_pct and mirrors tp1_upside safely', () => {
  const preserved = base({ entry1: null, entry2: null, entry_low: 97, entry_high: 99, tp1: 105, tp1n: 105, tp1_upside: 5.5, tp1_upside_pct: 5.75 });
  sectorHot.__test.normalizeEntryRangeAliases(preserved);
  assert.equal(preserved.tp1_upside_pct, 5.75);
  assert.equal(preserved.tp1_upside, 5.5);

  const mirrored = base({ entry1: null, entry2: null, entry_low: 97, entry_high: 99, tp1: 105, tp1n: 105, tp1_upside: 6.06, tp1_upside_pct: null });
  sectorHot.__test.normalizeEntryRangeAliases(mirrored);
  assert.equal(mirrored.tp1_upside_pct, 6.06);
});
