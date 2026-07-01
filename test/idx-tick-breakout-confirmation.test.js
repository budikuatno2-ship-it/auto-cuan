'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveBreakoutConfirmation } = require('../lib/idx-tick-normalization');

function breakout(overrides) {
  return deriveBreakoutConfirmation(Object.assign({
    close: 100,
    high_price: 101,
    resistance: 100
  }, overrides || {}));
}

test('deriveBreakoutConfirmation: close above resistance -> BREAKOUT_CONFIRMED', () => {
  const result = breakout({ close: 101, high_price: 102, resistance: 100 });
  assert.equal(result.breakout_confirmation_status, 'BREAKOUT_CONFIRMED');
  assert.equal(result.breakout_confirmation_label, 'Breakout Confirmed');
  assert.equal(result.false_breakout_risk, false);
});

test('deriveBreakoutConfirmation: high pierces resistance but close <= resistance -> FALSE_BREAKOUT_RISK', () => {
  const result = breakout({ close: 100, high_price: 102, resistance: 100 });
  assert.equal(result.breakout_confirmation_status, 'FALSE_BREAKOUT_RISK');
  assert.equal(result.breakout_confirmation_label, 'False Breakout Risk');
  assert.equal(result.false_breakout_risk, true);
  assert.match(result.breakout_confirmation_note, /close gagal/i);
});

test('deriveBreakoutConfirmation: close below resistance and high does not pierce -> BREAKOUT_WATCH', () => {
  const result = breakout({ close: 99, high_price: 100, resistance: 100 });
  assert.equal(result.breakout_confirmation_status, 'BREAKOUT_WATCH');
  assert.equal(result.false_breakout_risk, false);
  assert.match(result.breakout_confirmation_note, /butuh close di atas/i);
});

test('deriveBreakoutConfirmation: missing resistance or trigger -> NEEDS_CLOSE_CONFIRMATION', () => {
  const result = deriveBreakoutConfirmation({ close: 100, high_price: 101 });
  assert.equal(result.breakout_confirmation_status, 'NEEDS_CLOSE_CONFIRMATION');
  assert.equal(result.breakout_confirmation_label, 'Needs Close Confirmation');
  assert.equal(result.false_breakout_risk, false);
});

test('deriveBreakoutConfirmation: close exactly at resistance is not confirmed and wick pierce becomes FALSE_BREAKOUT_RISK', () => {
  const result = breakout({ close: 100, high_price: 100.5, resistance: 100 });
  assert.equal(result.breakout_confirmation_status, 'FALSE_BREAKOUT_RISK');
  assert.equal(result.false_breakout_risk, true);
});

test('deriveBreakoutConfirmation: close slightly above resistance follows strict > resistance confirmation', () => {
  const result = breakout({ close: 100.01, high_price: 100.02, resistance: 100 });
  assert.equal(result.breakout_confirmation_status, 'BREAKOUT_CONFIRMED');
  assert.equal(result.false_breakout_risk, false);
});
