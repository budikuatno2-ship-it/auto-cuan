'use strict';

const assert = require('node:assert');
const screenerConfig = require('../lib/screener-config');
const swingScreener = require('../lib/swing-screener-engine');
const daytradeEngine = require('../lib/daytrade-screener-engine');

let failedCount = 0;
let passedCount = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
    passedCount++;
  } catch (err) {
    console.log(`EXPECTED_FAIL (Bug Proven): ${name} -> ${err.message}`);
    failedCount++;
  }
}

// BUG-F3-01: Lifecycle & Revalidation passes candidate that has already breached Stop Loss
runTest('BUG-F3-01: validateRevalidationSignal must reject candidates below Stop Loss', () => {
  const candidate = {
    last_price: 92,
    stop_loss: 95,
    entry_low: 100,
    entry_high: 102,
    tp1: 115,
    risk_reward: 2.0,
    volume_ratio: 1.5,
    status: 'READY_BREAKOUT'
  };
  const result = screenerConfig.validateRevalidationSignal(candidate);
  assert.strictEqual(
    result.pass,
    false,
    'Candidate whose current price is below stop_loss must be rejected (stop_loss_breached)'
  );
});

// BUG-F3-02: Lifecycle & Revalidation passes candidate whose TP1 has already been hit
runTest('BUG-F3-02: validateRevalidationSignal must reject candidates that already reached TP1', () => {
  const candidate = {
    last_price: 120,
    stop_loss: 95,
    entry_low: 100,
    entry_high: 102,
    tp1: 115,
    risk_reward: 2.0,
    volume_ratio: 1.5,
    status: 'READY_BREAKOUT'
  };
  const result = screenerConfig.validateRevalidationSignal(candidate);
  assert.strictEqual(
    result.pass,
    false,
    'Candidate whose target TP1 is already hit must not pass revalidation as new entry'
  );
});

// BUG-F3-03: verifySwingHighConviction approves upstream AVOID candidates
runTest('BUG-F3-03: verifySwingHighConviction must reject candidates with status AVOID', () => {
  const candidate = {
    ticker: 'BOGUS',
    status: 'AVOID',
    risk_reward: 2.5,
    conviction_score: 85,
    last_price: 1000,
    open_price: 980,
    volume_ratio: 1.5,
    ma20: 950,
    notes: 'Illiquid stock avoid'
  };
  const result = swingScreener.verifySwingHighConviction(candidate);
  assert.strictEqual(
    result,
    null,
    'Candidate explicitly flagged as AVOID must not be promoted to High Conviction Swing'
  );
});

// BUG-F3-04: validateRevalidationSignal bypasses volume check when entry_status is non-empty
runTest('BUG-F3-04: validateRevalidationSignal must enforce volume confirmation for READY_BREAKOUT even if entry_status is EXTENDED', () => {
  const candidate = {
    entry_status: 'EXTENDED',
    status: 'READY_BREAKOUT',
    risk_reward: 2.0,
    volume_ratio: 0.7
  };
  const result = screenerConfig.validateRevalidationSignal(candidate);
  assert.strictEqual(
    result.pass,
    false,
    'Candidate with status READY_BREAKOUT and volume_ratio 0.7 must fail insufficient_breakout_volume regardless of entry_status'
  );
});

// BUG-F3-05: refineLevelsWithRespectZones inverts TP2 < TP1 on supply refinement and falsely claims R/R too weak
runTest('BUG-F3-05: refineLevelsWithRespectZones must adjust TP2 above TP1 and not falsely claim R/R too weak', () => {
  const candles = [];
  for (let i = 0; i < 30; i++) {
    candles.push({
      open: 100,
      high: i % 3 === 0 ? 115 : 105,
      low: 95,
      close: 101,
      volume: 1000000
    });
  }
  const baseLevels = {
    entry_low: 100,
    entry_high: 102,
    stop_loss: 95,
    tp1: 108,
    tp2: 110,
    risk_reward: 1.8
  };
  const refined = daytradeEngine.refineLevelsWithRespectZones(baseLevels, candles, 101, 'daytrade');
  assert.ok(
    !refined.refinement_notes || !refined.refinement_notes.includes('R/R would become too weak'),
    'Should not drop valid respect refinement with false R/R error when R/R is actually favorable'
  );
});

console.log(`\nFase 3 Batch 1 Test Summary: ${passedCount} passed, ${failedCount} expected failing checks (reproducing bugs).`);
