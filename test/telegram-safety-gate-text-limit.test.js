'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sectorHot = require('../api/sector-hot');

// BUG-025 regression (gate level): a Telegram safety-gate trigger word that sits
// past the old 300-char / 120-char cutoffs must still block the broadcast.
// Before the fix the gate truncated the joined text, missed the trigger, and
// let a risky signal through (fail-OPEN).
function baseCandidate(overrides) {
  return Object.assign({
    ticker: 'TEST',
    status: 'READY',
    last_price: 100,
    entry1: 100,
    entry_low: 100,
    entry_high: 100,
    sl: 95,
    stop_loss: 95,
    tp1: 110,
    tp1n: 110,
    risk_reward: 2,
    data_quality_valid: true
  }, overrides || {});
}

test('BUG-025: gate blocks when trigger word sits beyond 300 chars in plan_quality_note', () => {
  const { candidatePassesPublicTelegramSafetyGate } = sectorHot.__test;
  assert.equal(typeof candidatePassesPublicTelegramSafetyGate, 'function');

  const longNote = 'A'.repeat(400) + ' invalid plan';
  assert.ok(longNote.indexOf('invalid plan') > 300, 'trigger must be past the old 300-char cutoff');

  const candidate = baseCandidate({ plan_quality_note: longNote });
  assert.equal(
    candidatePassesPublicTelegramSafetyGate(candidate, 'daytrade'),
    false,
    'long-text trigger must block the broadcast (fail-closed)'
  );
});

test('BUG-025: gate blocks when trigger word sits beyond 300 chars in stale_notes', () => {
  const { candidatePassesPublicTelegramSafetyGate } = sectorHot.__test;

  const longStale = 'B'.repeat(500) + ' stale';
  assert.ok(longStale.indexOf('stale') > 300, 'trigger must be past the old 300-char cutoff');

  const candidate = baseCandidate({ stale_notes: longStale });
  assert.equal(
    candidatePassesPublicTelegramSafetyGate(candidate, 'daytrade'),
    false,
    'stale past the cutoff must block the broadcast'
  );
});

test('BUG-025: gate still blocks a short-text trigger (no regression)', () => {
  const { candidatePassesPublicTelegramSafetyGate } = sectorHot.__test;
  const candidate = baseCandidate({ plan_quality_note: 'Setup invalid plan, level belum rapi.' });
  assert.equal(candidatePassesPublicTelegramSafetyGate(candidate, 'daytrade'), false);
});

test('BUG-025: clean candidate still passes the gate (no over-blocking)', () => {
  const { candidatePassesPublicTelegramSafetyGate } = sectorHot.__test;
  // M-P1e (2026-11-15): the gate routes through the readiness engine, which is
  // fail-closed on missing evidence. Declare the evidence set the engine
  // requires so the clean-candidate case exercises the no-over-blocking
  // contract, not missing-fixture rejection.
  const candidate = baseCandidate({
    plan_quality_note: 'Plan rapi, RR sehat, level tertata.',
    category: 'Day Trade',
    trading_plan_valid: true,
    plan_quality_status: 'VALID',
    data_status: 'AVAILABLE',
    volume_today: 1200,
    avg_volume_20d: 1000,
    liquidity_idr: 500000000
  });
  assert.equal(candidatePassesPublicTelegramSafetyGate(candidate, 'daytrade'), true);
});
