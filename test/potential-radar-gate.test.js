'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sectorHot = require('../api/sector-hot');

const {
  candidatePassesPublicTelegramSafetyGate,
  candidatePassesPotentialRadarGate,
  candidatePassesDayTradeRadarFallbackGate,
  getPotentialRadarReason,
  getDayTradeRadarStatus,
  formatDayTradeRadarTelegramMessage,
  sanitizeTop5ResponseForAudience,
  classifyCandidateGateBucket,
  buildGateCalibrationDiagnostics
} = sectorHot.__test;

function base(overrides) {
  return Object.assign({
    ticker: 'BBRI', category: 'Day Trade', status: 'READY', risk_label: 'Medium Risk', risk_reward: 1.4,
    entry1: 5000, entry2: 5050, sl: 4900, stop_loss: 4900, tp1n: 5150, tp1: 5150, tp2n: 5300,
    tp1_upside: 3, last_price: 5025, trading_plan_valid: true, plan_quality_status: 'VALID',
    liquidity_label: 'Liquid', volume_confirmation_label: 'Volume mulai naik', entry_status: 'IN_ENTRY_AREA',
    entry_quality_status: 'IN_ENTRY_AREA', telegram_verdict: 'Pantau, tunggu konfirmasi.'
  }, overrides || {});
}

const radarCases = [
  ['BREAKOUT_WATCH', { breakout_confirmation_status: 'BREAKOUT_WATCH', breakout_confirmation_label: 'Breakout watch' }, 'WATCH_BREAKOUT'],
  ['NEEDS_CLOSE_CONFIRMATION', { breakout_confirmation_status: 'NEEDS_CLOSE_CONFIRMATION', breakout_confirmation_label: 'Needs close confirmation' }, 'WAIT_CLOSE_CONFIRMATION'],
  ['WAIT_PULLBACK chase ringan', { entry_status: 'WAIT_PULLBACK', entry_timing: 'wait pullback, sedikit extended' }, 'WAIT_PULLBACK'],
  ['ARA/ARB monitor ringan', { execution_reality_note: 'near ara monitor ringan', telegram_verdict: 'Pantau ARA/ARB risk ringan.' }, 'ARA_ARB_MONITOR'],
  ['data revalidation ringan', { data_quality_status: 'NEEDS_REVALIDATION', data_quality_needs_revalidation: true, data_quality_note: 'missing reference ringan, perlu validasi ulang' }, 'DATA_NEEDS_REVALIDATION']
];

for (const [name, overrides, reason] of radarCases) {
  test(name + ' fails Signal gate but passes Potential Radar gate', () => {
    const c = base(overrides);
    assert.equal(candidatePassesPublicTelegramSafetyGate(Object.assign({}, c), 'daytrade'), false);
    assert.equal(candidatePassesPotentialRadarGate(c, 'daytrade'), true);
    assert.equal(getPotentialRadarReason(c), reason);
  });
}

const hardRejects = [
  ['Hindari', { action: 'Hindari' }],
  ['Avoid', { signal_action: 'AVOID' }],
  ['Very High Risk', { risk_label: 'Very High Risk' }],
  ['weak liquidity', { liquidity_notes: 'weak liquidity' }],
  ['weak volume', { volume_confirmation_label: 'weak volume' }],
  ['invalid plan', { trading_plan_valid: false }],
  ['below SL', { entry_status: 'INVALID_BELOW_SL' }],
  ['final quality gate Signal action AVOID', { action: 'AVOID', excluded_reason: 'Tidak lolos final quality gate: Signal action AVOID.' }],
  ['signal_action AVOID with breakout watch', { signal_action: 'AVOID', breakout_confirmation_status: 'BREAKOUT_WATCH' }],
  ['action_label Hindari with wait pullback', { action_label: 'Hindari', entry_status: 'WAIT_PULLBACK' }],
  ['telegram_action_label Avoid with close confirmation', { telegram_action_label: 'Avoid', breakout_confirmation_status: 'NEEDS_CLOSE_CONFIRMATION' }]
];

for (const [name, overrides] of hardRejects) {
  test(name + ' fails Signal and Potential Radar gates', () => {
    const c = base(overrides);
    assert.equal(candidatePassesPublicTelegramSafetyGate(Object.assign({}, c), 'daytrade'), false);
    assert.equal(candidatePassesPotentialRadarGate(c, 'daytrade'), false);
  });
}


test('WAIT_PULLBACK without Avoid/Hindari remains eligible for Potential Radar', () => {
  const c = base({ status: 'WAIT_PULLBACK', action_label: 'Tunggu pullback valid', entry_status: 'WAIT_PULLBACK' });
  assert.equal(candidatePassesPotentialRadarGate(c, 'daytrade'), true);
  assert.equal(getPotentialRadarReason(c), 'WAIT_PULLBACK');
});

test('High Risk without Avoid/Hindari remains eligible for Potential Radar when plan and liquidity are valid', () => {
  const c = base({ risk_label: 'High Risk', status: 'BREAKOUT_WATCH', breakout_confirmation_status: 'BREAKOUT_WATCH' });
  assert.equal(candidatePassesPotentialRadarGate(c, 'daytrade'), true);
});

test('Very High Risk remains blocked from Potential Radar', () => {
  const c = base({ risk_label: 'Very High Risk', status: 'BREAKOUT_WATCH', breakout_confirmation_status: 'BREAKOUT_WATCH' });
  assert.equal(candidatePassesPotentialRadarGate(c, 'daytrade'), false);
});


test('Day Trade radar status scans later fields after non-radar status', () => {
  const c = base({ status: 'Hindari', action_label: 'Tunggu pullback valid' });
  assert.equal(getDayTradeRadarStatus(c), 'WAIT_PULLBACK');
  assert.equal(candidatePassesDayTradeRadarFallbackGate(c), true);
});

test('Day Trade radar status accepts Telegram Radar after AVOID status', () => {
  const c = base({ status: 'AVOID', telegram_action_label: 'Radar' });
  assert.equal(getDayTradeRadarStatus(c), 'RADAR');
  assert.equal(candidatePassesDayTradeRadarFallbackGate(c), true);
});

test('Day Trade radar status reads breakout confirmation status behind trade candidate status', () => {
  const c = base({ status: 'TRADE_CANDIDATE', breakout_confirmation_status: 'BREAKOUT_WATCH' });
  assert.equal(getDayTradeRadarStatus(c), 'BREAKOUT_WATCH');
  assert.equal(candidatePassesDayTradeRadarFallbackGate(c), true);
});

test('Day Trade radar fallback includes Very High Risk wait pullback as Radar caution, not Signal', () => {
  const c = base({ status: 'Hindari', entry_status: 'WAIT_PULLBACK', risk_label: 'Very High Risk' });
  assert.equal(candidatePassesPublicTelegramSafetyGate(Object.assign({}, c), 'daytrade'), false);
  assert.equal(getDayTradeRadarStatus(c), 'WAIT_PULLBACK');
  assert.equal(candidatePassesDayTradeRadarFallbackGate(c), true);
});

test('Day Trade radar fallback still blocks fatal invalid candle, below SL, and invalid plan', () => {
  assert.equal(candidatePassesDayTradeRadarFallbackGate(base({ status: 'RADAR', data_quality_status: 'INVALID_CANDLE' })), false);
  assert.equal(candidatePassesDayTradeRadarFallbackGate(base({ status: 'RADAR', entry_status: 'INVALID_BELOW_SL' })), false);
  assert.equal(candidatePassesDayTradeRadarFallbackGate(base({ status: 'RADAR', trading_plan_valid: false })), false);
});


test('Day Trade radar fallback blocks fatal ARA/ARB execution reality', () => {
  assert.equal(candidatePassesDayTradeRadarFallbackGate(base({ status: 'RADAR', execution_reality_status: 'UNKNOWN_LIMITS' })), false);
  assert.equal(candidatePassesDayTradeRadarFallbackGate(base({ status: 'WAIT_PULLBACK', buy_execution_realistic: false })), false);
  assert.equal(candidatePassesDayTradeRadarFallbackGate(base({ status: 'BREAKOUT_WATCH', execution_reality_status: 'ARA_HIT' })), false);
  assert.equal(candidatePassesDayTradeRadarFallbackGate(base({ status: 'RADAR', sell_risk_near_arb: true })), false);
  assert.equal(candidatePassesDayTradeRadarFallbackGate(base({ status: 'RADAR', execution_reality_note: 'impossible execution near ARA' })), false);
});

test('Day Trade radar fallback can include caution radar status when Potential Radar gate fails', () => {
  const c = base({ status: 'WAIT_PULLBACK', action_label: 'Hindari', entry_status: 'WAIT_PULLBACK' });
  assert.equal(getPotentialRadarReason(c), 'WAIT_PULLBACK');
  assert.equal(candidatePassesPotentialRadarGate(c, 'daytrade'), false);
  assert.equal(candidatePassesDayTradeRadarFallbackGate(c), true);
});


test('Day Trade secondary radar fallback selection still uses the stricter fallback gate', () => {
  const lowUpside = base({ ticker: 'LOWU', status: 'WAIT_PULLBACK', action_label: 'Tunggu pullback valid', entry_status: 'WAIT_PULLBACK', tp1: 5010, tp1n: 5010, tp1_upside: 0.2 });
  const valid = base({ ticker: 'GOOD', status: 'BREAKOUT_WATCH', breakout_confirmation_status: 'BREAKOUT_WATCH', breakout_confirmation_label: 'Breakout watch' });
  assert.equal(candidatePassesPotentialRadarGate(lowUpside, 'daytrade'), true);
  assert.equal(candidatePassesDayTradeRadarFallbackGate(lowUpside), false);
  const selected = [lowUpside, valid].filter(function(r) { return candidatePassesDayTradeRadarFallbackGate(r); });
  assert.deepEqual(selected.map(function(r) { return r.ticker; }), ['GOOD']);
});

test('low-upside or invalid TP1 candidates are not public Day Trade radar fallback candidates', () => {
  const lowUpside = base({ status: 'WAIT_PULLBACK', action_label: 'Tunggu pullback valid', entry_status: 'WAIT_PULLBACK', tp1: 5010, tp1n: 5010, tp1_upside: 0.2 });
  const invalidTp = base({ status: 'BREAKOUT_WATCH', breakout_confirmation_status: 'BREAKOUT_WATCH', tp1: 4990, tp1n: 4990, tp1_upside: -0.2 });
  assert.equal(candidatePassesPotentialRadarGate(lowUpside, 'daytrade'), true);
  assert.equal(candidatePassesPotentialRadarGate(invalidTp, 'daytrade'), true);
  assert.equal(candidatePassesDayTradeRadarFallbackGate(lowUpside), false);
  assert.equal(candidatePassesDayTradeRadarFallbackGate(invalidTp), false);
});

test('Day Trade radar fallback gate accepts valid borderline BREAKOUT_WATCH/WAIT_PULLBACK candidates', () => {
  assert.equal(candidatePassesDayTradeRadarFallbackGate(base({ status: 'BREAKOUT_WATCH', breakout_confirmation_status: 'BREAKOUT_WATCH', breakout_confirmation_label: 'Breakout watch' })), true);
  assert.equal(candidatePassesDayTradeRadarFallbackGate(base({ status: 'WAIT_PULLBACK', action_label: 'Tunggu pullback valid', entry_status: 'WAIT_PULLBACK' })), true);
});

test('Day Trade candidate formatter includes risk volume pullback and Hindari warnings', () => {
  const msg = formatDayTradeRadarTelegramMessage([
    base({ ticker: 'VHIG', status: 'WAIT_PULLBACK', risk_label: 'Very High Risk', entry_status: 'WAIT_PULLBACK', action_label: 'Tunggu pullback valid' }),
    base({ ticker: 'WEAK', status: 'RADAR', volume_confirmation_label: 'Weak Volume' }),
    base({ ticker: 'HIND', status: 'WAIT_PULLBACK', action_label: 'Hindari - Tunggu pullback valid', entry_status: 'WAIT_PULLBACK', mtf_status: 'MTF mixed', plan_quality_note: 'SL rawan noise' })
  ]);
  assert.match(msg, /Day Trade Signal Candidate/);
  assert.match(msg, /Very High Risk/);
  assert.match(msg, /Weak Volume/);
  assert.match(msg, /Hindari/);
  assert.match(msg, /Tunggu pullback/);
  assert.match(msg, /MTF mixed/);
  assert.match(msg, /SL rawan noise/);
});

test('Day Trade fallback blocks missing SL, invalid plan, below SL, and impossible ARA/ARB', () => {
  assert.equal(candidatePassesDayTradeRadarFallbackGate(base({ status: 'WAIT_PULLBACK', sl: null, stop_loss: null })), false);
  assert.equal(candidatePassesDayTradeRadarFallbackGate(base({ status: 'RADAR', trading_plan_valid: false })), false);
  assert.equal(candidatePassesDayTradeRadarFallbackGate(base({ status: 'RADAR', last_price: 4800, sl: 4900, stop_loss: 4900 })), false);
  assert.equal(candidatePassesDayTradeRadarFallbackGate(base({ status: 'RADAR', execution_reality_status: 'UNKNOWN_LIMITS' })), false);
});

test('Day Trade fallback message is Signal Candidate and does not leak diagnostics', () => {
  const msg = formatDayTradeRadarTelegramMessage([base({ breakout_confirmation_status: 'BREAKOUT_WATCH', sample_rejected: [{ ticker: 'BAD' }], stageByTicker: { BBRI: {} }, debug_notes: 'secret' })]);
  assert.match(msg, /Day Trade Signal Candidate/);
  assert.doesNotMatch(msg, /RADAR — BUKAN SINYAL ENTRY/);
  assert.doesNotMatch(msg, /Belum ada kandidat Entry valid yang lolos final safety gate/);
  assert.match(msg, /Bukan rekomendasi beli otomatis\. Konfirmasi manual wajib\./);
  for (const forbidden of ['sample_rejected', 'stageByTicker', 'debug_notes', 'secret', '[object Object]', 'SL: -', 'EntryQ: -', 'PlanQ: -', 'undefined', 'null']) assert.equal(msg.includes(forbidden), false);
});

test('public Top 5 sanitizer hides admin potential radar diagnostics from guest', () => {
  const payload = sanitizeTop5ResponseForAudience({
    success: true,
    top5_locked: false,
    admin_next_top5_potential_radar_preview: [{ ticker: 'POT', debug_notes: 'secret' }],
    admin_next_top5_excluded_preview: [{ ticker: 'BAD', sample_rejected: [] }],
    admin_next_top5_potential_radar_count: 1,
    admin_next_top5_preview_note: 'admin only'
  }, { allowAdminPreview: false });
  assert.equal(Object.hasOwn(payload, 'admin_next_top5_potential_radar_preview'), false);
  assert.equal(Object.hasOwn(payload, 'admin_next_top5_excluded_preview'), false);
  assert.equal(Object.hasOwn(payload, 'admin_next_top5_potential_radar_count'), false);
});

test('admin Top 5 sanitizer keeps Potential Radar / Watchlist bucket safely', () => {
  const payload = sanitizeTop5ResponseForAudience({
    admin_next_top5_potential_radar_preview: [{ ticker: 'POT', is_preview: true, debug_notes: 'secret', radar_reason: 'WATCH_BREAKOUT' }]
  }, { allowAdminPreview: true });
  assert.equal(payload.admin_next_top5_potential_radar_preview.length, 1);
  assert.equal(payload.admin_next_top5_potential_radar_preview[0].ticker, 'POT');
  assert.equal(payload.admin_next_top5_potential_radar_preview[0].radar_reason, 'WATCH_BREAKOUT');
  assert.equal(Object.hasOwn(payload.admin_next_top5_potential_radar_preview[0], 'debug_notes'), false);
});


test('gate bucket classifier marks valid Signal as SIGNAL', () => {
  const c = base({ telegram_verdict: 'Entry valid dengan risk terukur.', status: 'READY_BREAKOUT', breakout_confirmation_status: 'CONFIRMED' });
  assert.equal(classifyCandidateGateBucket(c, 'daytrade').gate_bucket, 'SIGNAL');
});

test('gate bucket classifier keeps soft Signal failures in RADAR', () => {
  const cases = [
    base({ final_quality_pass: false, breakout_confirmation_status: 'BREAKOUT_WATCH', breakout_confirmation_label: 'Breakout watch' }),
    base({ final_quality_pass: false, breakout_confirmation_status: 'NEEDS_CLOSE_CONFIRMATION', breakout_confirmation_label: 'Needs close confirmation' }),
    base({ final_quality_pass: false, status: 'WAIT_PULLBACK', action_label: 'Tunggu pullback valid', entry_status: 'WAIT_PULLBACK' }),
    base({ final_quality_pass: false, risk_label: 'High Risk', status: 'BREAKOUT_WATCH', breakout_confirmation_status: 'BREAKOUT_WATCH' })
  ];
  assert.deepEqual(cases.map((c) => classifyCandidateGateBucket(c, 'daytrade').gate_bucket), ['RADAR', 'RADAR', 'RADAR', 'RADAR']);
});

test('gate bucket classifier keeps unsafe candidates in HARD_REJECT', () => {
  const cases = [
    base({ action: 'Hindari' }),
    base({ risk_label: 'Very High Risk' }),
    base({ liquidity_notes: 'weak liquidity' }),
    base({ trading_plan_valid: false }),
    base({ entry_status: 'INVALID_BELOW_SL' }),
    base({ data_quality_status: 'INVALID_CANDLE' })
  ];
  assert.deepEqual(cases.map((c) => classifyCandidateGateBucket(c, 'daytrade').gate_bucket), ['HARD_REJECT', 'HARD_REJECT', 'HARD_REJECT', 'HARD_REJECT', 'HARD_REJECT', 'HARD_REJECT']);
});

test('gate calibration diagnostics classifies every candidate into one bucket', () => {
  const candidates = [
    base({ ticker: 'SIG', telegram_verdict: 'Entry valid dengan risk terukur.', status: 'READY_BREAKOUT', breakout_confirmation_status: 'CONFIRMED' }),
    base({ ticker: 'RAD', final_quality_pass: false, breakout_confirmation_status: 'BREAKOUT_WATCH', breakout_confirmation_label: 'Breakout watch' }),
    base({ ticker: 'BAD', action: 'Hindari' })
  ];
  const d = buildGateCalibrationDiagnostics(candidates, 'daytrade');
  assert.equal(d.signal_count + d.radar_count + d.hard_reject_count, candidates.length);
  assert.equal(d.signal_candidates, 1);
  assert.equal(d.radar_candidates, 1);
  assert.equal(d.hard_reject_candidates, 1);
  assert.equal(d.excluded_by_guard, 1);
  assert.equal(d.top_radar_reasons.WATCH_BREAKOUT, 1);
});

test('Hard Reject with raw score 100 produces capped blocked display score', () => {
  const display = sectorHot.__test.normalizeCandidateScoreForGate(base({ daytrade_score: 100, action_label: 'Hindari' }), 'daytrade');
  assert.equal(display.gate_bucket, 'HARD_REJECT');
  assert.equal(display.display_score, 60);
  assert.equal(display.raw_score, 100);
  assert.equal(display.score_capped_by_gate, true);
});

test('Radar with raw score 100 remains Radar display and not Signal', () => {
  const display = sectorHot.__test.normalizeCandidateScoreForGate(base({ daytrade_score: 100, final_quality_pass: false, final_quality_status: 'needs close confirmation', status: 'WAIT_PULLBACK' }), 'daytrade');
  assert.equal(display.gate_bucket, 'RADAR');
  assert.equal(display.display_score, 100);
  assert.equal(display.score_display_label, 'Radar / Watchlist, bukan Signal');
});

test('Signal valid keeps normal display score', () => {
  const display = sectorHot.__test.normalizeCandidateScoreForGate(base({ daytrade_score: 91, telegram_verdict: 'Entry valid dengan risk terukur.', status: 'READY_BREAKOUT', breakout_confirmation_status: 'CONFIRMED' }), 'daytrade');
  assert.equal(display.gate_bucket, 'SIGNAL');
  assert.equal(display.display_score, 91);
  assert.equal(display.score_capped_by_gate, false);
});
