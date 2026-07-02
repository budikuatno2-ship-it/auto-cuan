'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sectorHot = require('../api/sector-hot');

const {
  candidatePassesPublicTelegramSafetyGate,
  candidatePassesPotentialRadarGate,
  candidatePassesDayTradeRadarFallbackGate,
  getPotentialRadarReason,
  formatDayTradeRadarTelegramMessage,
  sanitizeTop5ResponseForAudience
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

test('Day Trade radar fallback gate cannot be bypassed by radar status when Potential Radar gate fails', () => {
  const c = base({ status: 'WAIT_PULLBACK', action_label: 'Hindari', entry_status: 'WAIT_PULLBACK' });
  assert.equal(getPotentialRadarReason(c), 'WAIT_PULLBACK');
  assert.equal(candidatePassesPotentialRadarGate(c, 'daytrade'), false);
  assert.equal(candidatePassesDayTradeRadarFallbackGate(c), false);
});

test('Day Trade radar fallback gate accepts valid borderline BREAKOUT_WATCH/WAIT_PULLBACK candidates', () => {
  assert.equal(candidatePassesDayTradeRadarFallbackGate(base({ status: 'BREAKOUT_WATCH', breakout_confirmation_status: 'BREAKOUT_WATCH', breakout_confirmation_label: 'Breakout watch' })), true);
  assert.equal(candidatePassesDayTradeRadarFallbackGate(base({ status: 'WAIT_PULLBACK', action_label: 'Tunggu pullback valid', entry_status: 'WAIT_PULLBACK' })), true);
});

test('radar fallback message is clearly not a Signal and does not leak diagnostics', () => {
  const msg = formatDayTradeRadarTelegramMessage([base({ breakout_confirmation_status: 'BREAKOUT_WATCH', sample_rejected: [{ ticker: 'BAD' }], stageByTicker: { BBRI: {} }, debug_notes: 'secret' })]);
  assert.match(msg, /\[RADAR — BUKAN SINYAL ENTRY\]/);
  assert.match(msg, /Bukan rekomendasi beli/);
  for (const forbidden of ['sample_rejected', 'stageByTicker', 'debug_notes', 'secret', '[object Object]']) assert.equal(msg.includes(forbidden), false);
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
