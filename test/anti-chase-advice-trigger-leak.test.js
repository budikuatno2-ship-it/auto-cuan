'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const idx = require('../lib/idx-tick-normalization');
const sectorHot = require('../api/sector-hot');

const { deriveFinalTopQualityGate, hasHindariAction } = sectorHot.__test || {};

function baseCandidate(overrides) {
  return Object.assign({
    ticker: 'AUTO',
    category: 'Day Trade',
    mode: 'daytrade',
    current_price: 1000,
    last_price: 1000,
    entry_low: 990,
    entry_high: 1010,
    entry1: 990,
    entry2: 1010,
    stop_loss: 960,
    sl: 960,
    tp1: 1070,
    tp1n: 1070,
    risk_reward: 1.75,
    risk_label: 'Low Risk',
    risk_label_v2: 'Low Risk',
    plan_quality_status: 'OK',
    trading_plan_status: 'OK',
    entry_quality_status: 'IN_ENTRY_AREA',
    entry_status: 'IN_ENTRY_AREA',
    liquidity_label: 'Liquid',
    volume_label: 'Volume valid',
    trend_label: 'Improving Trend',
    respect_quality_label: 'valid respect',
    entry_timing: 'Watchlist — jangan chase dekat ARA',
    time_plan: 'tunggu pullback, jangan chase',
    telegram_verdict: 'Watchlist — jangan chase dekat ARA.'
  }, overrides || {});
}

test('BUG-027: warning advice containing "jangan chase" must NOT trigger chaseExtended / Hindari in deriveSignalVerdict', () => {
  const candidate = baseCandidate();
  const verdict = idx.deriveSignalVerdict(candidate);

  // Before fix: chaseExtended matched 'chase' in entry_timing/time_plan/telegram_verdict,
  // returning action_label: 'Hindari' and signal_action: 'WAIT_PULLBACK'.
  // After fix: advice fields are excluded from market observations and negative prefixes are stripped,
  // so the valid entry setup produces 'Entry' / 'ENTRY_AREA'.
  assert.notEqual(verdict.action_label, 'Hindari', 'advice saying "jangan chase" should not brand setup as Hindari');
  assert.equal(verdict.signal_action, 'ENTRY_AREA');
  assert.equal(verdict.action_label, 'Entry');
});

test('BUG-027: genuine chase risk (entry_status = CHASE_RISK) still triggers Anti-chase / Hindari', () => {
  const candidate = baseCandidate({
    entry_quality_status: 'CHASE_RISK',
    entry_status: 'CHASE_RISK',
    entry_timing: 'Tunggu pullback'
  });
  const verdict = idx.deriveSignalVerdict(candidate);

  assert.equal(verdict.action_label, 'Hindari');
  assert.equal(verdict.signal_action, 'WAIT_PULLBACK');
  assert.match(verdict.signal_reason, /chase/i);
});

test('BUG-027: genuine chase note (notes = "chase risk candle") still triggers Anti-chase', () => {
  const candidate = baseCandidate({
    notes: 'chase risk candle extended',
    entry_timing: 'Tunggu pullback'
  });
  const verdict = idx.deriveSignalVerdict(candidate);

  assert.equal(verdict.action_label, 'Hindari');
  assert.equal(verdict.signal_action, 'WAIT_PULLBACK');
});

test('BUG-027: candidatePassesPublicTelegramSafetyGate allows candidate with "jangan chase" advice', () => {
  const { candidatePassesPublicTelegramSafetyGate } = sectorHot.__test || {};
  if (!candidatePassesPublicTelegramSafetyGate) return;

  const candidate = baseCandidate();
  const verdict = idx.deriveSignalVerdict(candidate);
  Object.assign(candidate, verdict);

  const passes = candidatePassesPublicTelegramSafetyGate(candidate);
  assert.equal(passes, true, 'candidate with "jangan chase" advice should pass telegram safety gate');
});

test('BUG-027: candidatePassesPublicTelegramSafetyGate rejects candidate with genuine chase risk', () => {
  const { candidatePassesPublicTelegramSafetyGate, diagnosePublicSafetyGateRejection } = sectorHot.__test || {};
  if (!candidatePassesPublicTelegramSafetyGate) return;

  const candidate = baseCandidate({
    entry_quality_status: 'CHASE_RISK',
    entry_status: 'CHASE_RISK',
    entry_timing: 'Tunggu pullback'
  });
  const verdict = idx.deriveSignalVerdict(candidate);
  Object.assign(candidate, verdict);

  const passes = candidatePassesPublicTelegramSafetyGate(candidate);
  assert.equal(passes, false, 'candidate with genuine chase risk should be rejected');
  const diag = diagnosePublicSafetyGateRejection(candidate);
  assert.ok(['status_verdict_reject', 'guard_text_reject'].includes(diag.category), 'should reject due to verdict Hindari or guard text');
});
