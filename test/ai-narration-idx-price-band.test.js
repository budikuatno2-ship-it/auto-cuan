'use strict';

// Regression: the fabricated-number guard in the narration validator used to
// exempt the entire 0-2359 band, which is where most liquid IDX tickers trade
// and where every RR ratio and percentage sits. A model could invent an entry,
// a stop, or a target anywhere in that range and the note shipped to Telegram
// as if it were grounded in the deterministic template printed above it.
//
// Clock references must be recognised syntactically instead of by exempting an
// entire numeric band. This also protects valid times whose minute component is
// above 31 (for example 09:45 or 13:59), which a numeric-only exception misses.

const test = require('node:test');
const assert = require('node:assert');

const validator = require('../lib/ai-narration-validator');

// Deliberately a realistic IDX level set: every number lives inside 0-2359.
const SOURCE = {
  ticker: 'BBRI',
  entry1: 1200,
  entry2: 1210,
  sl: 1150,
  tp1: 1300,
  tp2: 1400,
  last_price: 1210
};

test('an invented price level inside the IDX trading band is reported as fabricated', () => {
  const result = validator.validateNote(
    'Target realistis di 2.100 dengan stop di 1.750.',
    SOURCE
  );

  assert.equal(result.valid, false);
  assert.equal(result.reason, 'fabricated_numbers');
  assert.deepEqual(result.fabricatedNumbers.sort(), ['1750', '2100']);
});

test('an invented support level in the low hundreds is reported as fabricated', () => {
  const result = validator.validateNote('Support kuat di 850.', SOURCE);

  assert.equal(result.valid, false);
  assert.equal(result.reason, 'fabricated_numbers');
  assert.deepEqual(result.fabricatedNumbers, ['850']);
});

test('levels that really are in the source data still validate', () => {
  const result = validator.validateNote(
    'Entry 1.200, stop di 1.150, target pertama 1.300.',
    SOURCE
  );

  assert.equal(result.valid, true);
});

test('clock references stay allowed across the full valid minute range', () => {
  for (const note of [
    'Konfirmasi ditunggu sampai 09:30.',
    'Konfirmasi ditunggu sampai 09:45.',
    'Sesi kedua dibuka 13.30.',
    'Sesi kedua dibuka 13.59.',
    'Tutup di 15.00.',
    'Batas terakhir 23:59.'
  ]) {
    const result = validator.validateNote(note, SOURCE);
    assert.equal(result.valid, true, note + ' should validate');
  }
});

test('a standalone invented minute-like number is still rejected', () => {
  const result = validator.validateNote('Support kuat di 45.', SOURCE);

  assert.equal(result.valid, false);
  assert.equal(result.reason, 'fabricated_numbers');
  assert.deepEqual(result.fabricatedNumbers, ['45']);
});

test('an invalid clock token does not get clock exemption', () => {
  const result = validator.validateNote('Konfirmasi 09:75.', SOURCE);

  assert.equal(result.valid, false);
  assert.equal(result.reason, 'fabricated_numbers');
  assert.deepEqual(result.fabricatedNumbers, ['75']);
});

test('a year reference stays allowed', () => {
  const result = validator.validateNote('Pola serupa terjadi pada 2024.', SOURCE);

  assert.equal(result.valid, true);
});

test('an invented number above the old band is still reported, as before', () => {
  const result = validator.validateNote('Target jauh di 5.000.', SOURCE);

  assert.equal(result.valid, false);
  assert.equal(result.reason, 'fabricated_numbers');
  assert.deepEqual(result.fabricatedNumbers, ['5000']);
});
