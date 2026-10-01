'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sectorHot = require('../api/sector-hot');

const {
  getObservedHighForTp1,
  candidateHasTp1AlreadyReachedByObservedHigh,
  applyObservedHighTp1Status,
  candidatePassesPublicTelegramSafetyGate,
  diagnosePublicSafetyGateRejection,
  getSwingPublicSignalSafetyRejectionReason,
  candidatePassesTelegramCandidateDigestGate,
  candidatePassesDayTradeRadarFallbackGate,
  diagnoseSwingMonitorCandidate
} = sectorHot.__test;

function baseCandidate(overrides) {
  return Object.assign({
    ticker: 'TEST',
    category: 'Day Trade',
    status: 'READY',
    final_status: 'READY',
    setup: 'Signal',
    risk_label: 'Low Risk',
    risk_reward: 2,
    entry_low: 100,
    entry_high: 102,
    entry1: 102,
    entry2: 100,
    stop_loss: 95,
    sl: 95,
    tp1: 110,
    tp1n: 110,
    tp2: 120,
    tp2n: 120,
    tp1_upside: 7.84,
    tp1_upside_pct: 7.84,
    last_price: 103,
    current_price: 103,
    high_price: 109,
    previous_close: 100,
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
    telegram_verdict: 'Watchlist — tunggu konfirmasi.',
    setup_freshness_status: 'FRESH',
    data_quality_valid: true,
    final_quality_pass: true,
    final_gate_pass: true,
    quality_gate_pass: true
  }, overrides || {});
}

test('observed-high resolver uses highest available alias', () => {
  assert.equal(
    getObservedHighForTp1({
      high_price: 108,
      price_high: 111,
      high: 110
    }),
    111
  );
});

test('observed-high guard fails open when high is unavailable', () => {
  assert.equal(
    candidateHasTp1AlreadyReachedByObservedHigh({
      tp1: 110,
      last_price: 103
    }),
    false
  );
});

test('observed-high guard detects equality and overshoot', () => {
  assert.equal(
    candidateHasTp1AlreadyReachedByObservedHigh({
      tp1: 110,
      high_price: 110,
      last_price: 103
    }),
    true
  );

  assert.equal(
    candidateHasTp1AlreadyReachedByObservedHigh({
      tp1n: 110,
      price_high: 112,
      last_price: 103
    }),
    true
  );
});

test('status is changed to TP1_HIT when candle high reached TP1', () => {
  const result = applyObservedHighTp1Status(
    baseCandidate({
      high_price: 111,
      last_price: 103
    })
  );

  assert.equal(result.tp1_observed_high_reached, true);
  assert.equal(result.tp1_observed_high, 111);
  assert.equal(result.entry_status, 'TP1_HIT');
  assert.equal(result.entry_quality_status, 'TP1_HIT');
});

test('strict public gate blocks TP1 reached by candle high', () => {
  assert.equal(
    candidatePassesPublicTelegramSafetyGate(
      baseCandidate({ high_price: 110 }),
      'daytrade'
    ),
    false
  );

  assert.equal(
    candidatePassesPublicTelegramSafetyGate(
      baseCandidate({ high_price: 109 }),
      'daytrade'
    ),
    true
  );
});

test('strict public diagnostic explains TP1 observed-high rejection', () => {
  const result = diagnosePublicSafetyGateRejection(
    baseCandidate({ high_price: 111 }),
    'daytrade'
  );

  assert.equal(
    result.category,
    'tp1_already_reached_by_observed_high'
  );
});

test('Swing secondary safety returns TP1 observed-high reason', () => {
  assert.equal(
    getSwingPublicSignalSafetyRejectionReason(
      baseCandidate({
        category: 'Swing Konglo',
        status: 'WATCHLIST',
        high_price: 110
      })
    ),
    'tp1_already_reached_by_observed_high'
  );
});

test('Swing digest blocks TP1 reached by candle high', () => {
  assert.equal(
    candidatePassesTelegramCandidateDigestGate(
      baseCandidate({
        category: 'Swing Konglo',
        status: 'WATCHLIST',
        high_price: 110
      }),
      'swing_konglo_auto'
    ),
    false
  );

  assert.equal(
    candidatePassesTelegramCandidateDigestGate(
      baseCandidate({
        category: 'Swing Konglo',
        status: 'WATCHLIST',
        high_price: 109
      }),
      'swing_konglo_auto'
    ),
    true
  );
});

test('Day Trade radar blocks TP1 reached by candle high', () => {
  const touched = baseCandidate({
    category: 'Day Trade',
    status: 'RADAR',
    final_status: 'RADAR',
    high_price: 110
  });

  assert.equal(
    candidatePassesDayTradeRadarFallbackGate(touched),
    false
  );

  const untouched = Object.assign({}, touched, {
    high_price: 109
  });

  assert.equal(
    candidatePassesDayTradeRadarFallbackGate(untouched),
    true
  );
});

test('Swing monitor reports TP1 observed-high rejection', () => {
  const touchedResult = diagnoseSwingMonitorCandidate(
    baseCandidate({
      category: 'Swing Konglo',
      status: 'WATCHLIST',
      risk_label: 'Medium Risk',
      high_price: 110
    })
  );

  assert.equal(touchedResult.passed, false);
  assert.equal(
    touchedResult.reason,
    'tp1_already_reached_by_observed_high'
  );

  const untouchedResult = diagnoseSwingMonitorCandidate(
    baseCandidate({
      category: 'Swing Konglo',
      status: 'WATCHLIST',
      risk_label: 'Medium Risk',
      high_price: 109
    })
  );

  assert.equal(untouchedResult.passed, true);
  assert.equal(untouchedResult.reason, 'passed');
});
