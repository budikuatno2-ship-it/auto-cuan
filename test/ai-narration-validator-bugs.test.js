'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { validateNote, stripClockReferences } = require('../lib/ai-narration-validator');

test('BUG-NAV-01: stripClockReferences erases real stock prices/percentages formatted with two decimals (X.YY where X <= 23, YY <= 59)', () => {
  // A fabricated price 18.30 or 14.50 should be detected as fabricated
  const note = 'Target resistance berada di 18.30';
  const sourceData = { ticker: 'BBRI', last_price: 5000 };

  // Currently, stripClockReferences replaces 18.30 with ' ' assuming it is 18:30 (clock),
  // causing fabricated number 18.30 to bypass validation entirely
  const result = validateNote(note, sourceData);

  assert.strictEqual(result.valid, false, 'Should fail validation due to fabricated price 18.30');
  assert.strictEqual(result.reason, 'fabricated_numbers');
});

test('BUG-NAV-02: validateNote day-of-month exemption allows fabricated stock prices, percentages, and lot sizes between 0 and 31', () => {
  // AI hallucinates 25 rupiah cut loss or 15% profit, which does not exist in source data
  const note = 'Disiplin cut loss di level 25 rupiah';
  const sourceData = { ticker: 'GOTO', entry1: 60, sl: 50, tp1: 75 };

  // Current code: `if (num >= 0 && num <= 31) return false;` exempts ANY number 0..31 without date context
  const result = validateNote(note, sourceData);

  assert.strictEqual(result.valid, false, 'Should reject fabricated price 25');
  assert.strictEqual(result.reason, 'fabricated_numbers');
});

test('BUG-NAV-03: validateNote ignores nested objects in sourceData, causing valid numbers in nested properties to be rejected as fabricated', () => {
  const note = 'Support kuat di 4500';
  const sourceData = {
    ticker: 'BBRI',
    levels: {
      support: 4500
    }
  };

  // Current code only inspects top-level properties and skips `typeof val === 'object'`,
  // missing nested 4500 and falsely flagging it as fabricated
  const result = validateNote(note, sourceData);

  assert.strictEqual(result.valid, true, 'Should recognize support 4500 from nested sourceData.levels');
});
