'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sectorHot = require('../api/sector-hot');

const {
  candidatePassesPublicTelegramSafetyGate,
  candidateTelegramEligible,
  formatCandidateBlock
} = sectorHot.__test;

function safeCandidate(overrides) {
  return Object.assign({
    ticker: 'BBRI',
    category: 'Day Trade',
    status: 'READY',
    setup: 'Signal',
    risk_label: 'Low Risk',
    risk_reward: 1.8,
    entry1: 5000,
    entry2: 5050,
    sl: 4900,
    tp1n: 5150,
    tp2n: 5300,
    tp1_upside: 3,
    last_price: 5025,
    value_today: 20000000000,
    volume_ratio_20d: 1.4,
    volume_confirmation_label: 'Volume kuat',
    liquidity_label: 'Liquid',
    trading_plan_valid: true,
    plan_quality_status: 'VALID',
    plan_quality_label: 'Plan valid',
    rr_quality_label: 'RR sehat',
    sl_quality_label: 'SL wajar',
    tp_quality_label: 'TP realistis',
    entry_quality_status: 'IN_ENTRY_AREA',
    entry_status: 'IN_ENTRY_AREA',
    entry_status_label: 'Entry area',
    signal_action_label: 'Watchlist',
    telegram_verdict: 'Watchlist — tunggu konfirmasi.'
  }, overrides || {});
}

test('public Telegram safety gate allows a valid signal candidate', () => {
  assert.equal(candidatePassesPublicTelegramSafetyGate(safeCandidate(), 'daytrade'), true);
  assert.equal(candidateTelegramEligible(safeCandidate()), true);
});

const blockedCases = [
  ['action Hindari', { action: 'Hindari' }],
  ['status AVOID', { status: 'AVOID' }],
  ['risk Very High', { risk_label: 'Very High' }],
  ['risk Very High Risk', { risk_label: 'Very High Risk' }],
  ['weak liquidity flag', { is_liquidity_risk: true }],
  ['weak liquidity reason', { liquidity_notes: 'weak liquidity' }],
  ['weak volume label', { volume_confirmation_label: 'Weak Volume' }],
  ['weak volume reason', { volume_confirmation_notes: 'weak volume' }],
  ['invalid plan flag', { trading_plan_valid: false }],
  ['invalid plan status', { plan_quality_status: 'INVALID' }],
  ['poor RR plan status', { plan_quality_status: 'POOR_RR' }],
  ['invalid plan text', { plan_quality_note: 'invalid plan' }],
  ['level not tidy plan text', { plan_quality_note: 'level belum rapi' }],
  ['stale flag', { is_stale: true }],
  ['data stale flag', { data_stale: true }],
  ['freshness stale flag', { freshness_is_stale: true }],
  ['generic stale flag', { stale: true }],
  ['setup freshness expired status', { setup_freshness_status: 'EXPIRED' }],
  ['setup freshness needs revalidation status', { setup_freshness_status: 'NEEDS_REVALIDATION' }],
  ['freshness expired status', { freshness_status: 'EXPIRED' }],
  ['freshness needs revalidation status', { freshness_status: 'NEEDS_REVALIDATION' }],
  ['Needs Revalidation status', { entry_quality_status: 'NEEDS_REVALIDATION' }],
  ['Needs Revalidation label', { setup_freshness_label: 'Needs Revalidation' }],
  ['stale freshness text', { freshness_note: 'stale setup data' }],
  ['expired freshness text', { setup_expiry_note: 'expired setup' }],
  ['needs revalidation freshness text', { setup_freshness_label: 'Needs Revalidation' }],
  ['Indonesian revalidation freshness text', { setup_expiry_note: 'Perlu validasi ulang sebelum entry.' }],
  ['Indonesian stale data freshness text', { stale_notes: 'Data basi, jangan kirim publik.' }],
  ['Indonesian too old setup freshness text', { setup_expiry_note: 'Setup terlalu lama untuk publik.' }],
  ['entry chase status', { entry_status: 'CHASE_RISK' }],
  ['extended entry status', { entry_status: 'EXTENDED' }],
  ['TP near status', { entry_status: 'TP1_NEAR' }],
  ['TP1 hit status', { entry_status: 'TP1_HIT' }],
  ['TP2 hit status', { entry_status: 'TP2_HIT' }],
  ['below SL status', { entry_status: 'INVALID_BELOW_SL' }],
  ['invalidation distance below SL status', { invalidation_distance_status: 'INVALID_BELOW_SL' }],
  ['invalidation distance too close status', { invalidation_distance_status: 'TOO_CLOSE_TO_SL' }],
  ['below SL text', { telegram_verdict: 'Wait - below SL.' }],
  ['SL kena text', { entry_status_note: 'SL kena, setup invalid.' }],
  ['invalidation hit text', { signal_verdict: 'Invalidation hit; wait.' }],
  ['invalidation terlalu dekat text', { invalidation_note: 'Invalidation terlalu dekat untuk public signal.' }],
  ['terlalu mepet text', { invalidation_note: 'Jarak SL terlalu mepet.' }],
  ['rawan noise text', { invalidation_note: 'Setup rawan noise.' }],
  ['entry status needs revalidation', { entry_status: 'NEEDS_REVALIDATION' }],
  ['chase note', { entry_timing: 'entry chase / extended' }],
  ['false breakout confirmation status', { breakout_confirmation_status: 'FALSE_BREAKOUT_RISK' }],
  ['needs close confirmation status', { breakout_confirmation_status: 'NEEDS_CLOSE_CONFIRMATION' }],
  ['breakout watch status', { breakout_confirmation_status: 'BREAKOUT_WATCH' }],
  ['false breakout risk flag', { false_breakout_risk: true }],
  ['false breakout label', { breakout_confirmation_label: 'False Breakout Risk' }],
  ['failed close breakout note', { breakout_confirmation_note: 'High pierced resistance but close failed to hold above it.' }],
  ['needs close confirmation action text', { signal_action_label: 'Signal', telegram_verdict: 'Needs close confirmation before entry.' }],
  ['false breakout action text', { action: 'False breakout risk - wait, do not entry.' }],
  ['wick pierced resistance but close failed', { high_price: 102, close: 99, resistance: 100, breakout_confirmation_note: 'Wick pierced resistance but close failed.' }],
  ['data quality valid false', { data_quality_valid: false }],
  ['data quality needs revalidation true', { data_quality_needs_revalidation: true }],
  ['data quality short history status', { data_quality_status: 'SHORT_HISTORY' }],
  ['data quality missing reference status', { data_quality_status: 'MISSING_REFERENCE' }],
  ['data quality sparse trading days status', { data_quality_status: 'SPARSE_TRADING_DAYS' }],
  ['data quality invalid candle status', { data_quality_status: 'INVALID_CANDLE' }],
  ['data quality corporate action status', { data_quality_status: 'CORPORATE_ACTION_RISK' }],
  ['data quality needs revalidation status', { data_quality_status: 'NEEDS_REVALIDATION' }],
  ['data quality unsafe wording', { data_quality_note: 'Riwayat data pendek; reference price belum valid; perlu validasi ulang.' }]
];

for (const [name, overrides] of blockedCases) {
  test('public Telegram safety gate blocks ' + name, () => {
    assert.equal(candidatePassesPublicTelegramSafetyGate(safeCandidate(overrides), 'daytrade'), false);
    assert.equal(candidateTelegramEligible(safeCandidate(overrides)), false);
  });
}

test('public Telegram formatter does not expose unsafe/internal diagnostics text', async () => {
  const candidate = safeCandidate({
    top_rejection_reasons: ['internal'],
    sample_rejected: [{ ticker: 'BAD' }],
    stageByTicker: { BBRI: { debug: true } },
    debug_notes: 'raw debug/internal notes',
    internal_diagnostics: { leak: true },
    notes: undefined,
    status_reason: null
  });
  const text = await formatCandidateBlock(null, candidate, 1, true);
  const forbidden = [
    'undefined',
    'null',
    '[object Object]',
    'top_rejection_reasons',
    'sample_rejected',
    'stageByTicker',
    'raw debug/internal notes',
    'internal_diagnostics'
  ];
  for (const needle of forbidden) {
    assert.equal(text.includes(needle), false, 'formatter leaked ' + needle + '\n' + text);
  }
});

test('Telegram risk label normalization variants stay canonical and unsafe stays unsafe', () => {
  const normalize = sectorHot.__test.normalizeTelegramRiskLabel;
  const cases = [
    ['LOW', 'Low Risk'],
    ['low risk', 'Low Risk'],
    ['MEDIUM', 'Medium Risk'],
    ['moderate_risk', 'Medium Risk'],
    ['HIGH-RISK', 'High Risk'],
    ['very high', 'Very High Risk'],
    ['EXTREME_RISK', 'Very High Risk'],
    ['Risiko Sangat Tinggi', 'Very High Risk']
  ];
  for (const [input, expected] of cases) assert.equal(normalize(input), expected);
  assert.equal(candidatePassesPublicTelegramSafetyGate(safeCandidate({ risk_label: 'EXTREME_RISK' }), 'daytrade'), false);
  assert.equal(candidatePassesPublicTelegramSafetyGate(safeCandidate({ risk_label: 'Risiko Sangat Tinggi' }), 'daytrade'), false);
});
