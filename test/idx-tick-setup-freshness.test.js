'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveSetupFreshness } = require('../lib/idx-tick-normalization');

const NOW = '2026-07-01T04:00:00.000Z';

function minutesAgo(minutes) {
  return new Date(new Date(NOW).getTime() - minutes * 60000).toISOString();
}

function candidate(overrides) {
  return Object.assign({
    calculated_at: minutesAgo(30),
    current_price: 101,
    entry_low: 100,
    entry_high: 102,
    stop_loss: 95
  }, overrides || {});
}

function freshness(overrides) {
  return deriveSetupFreshness(candidate(overrides), { now: NOW });
}

test('deriveSetupFreshness: missing timestamp -> NEEDS_REVALIDATION', () => {
  const result = deriveSetupFreshness({ current_price: 101, entry_low: 100, entry_high: 102, stop_loss: 95 }, { now: NOW });
  assert.equal(result.setup_freshness_status, 'NEEDS_REVALIDATION');
  assert.equal(result.setup_freshness_label, 'Needs Revalidation');
  assert.equal(result.setup_age_minutes, null);
  assert.equal(result.setup_age_hours, null);
  assert.match(result.setup_expiry_note, /Timestamp setup tidak jelas/i);
});

test('deriveSetupFreshness: recent timestamp and valid price levels -> FRESH', () => {
  const result = freshness({ calculated_at: minutesAgo(30) });
  assert.equal(result.setup_freshness_status, 'FRESH');
  assert.equal(result.setup_freshness_label, 'Fresh');
  assert.equal(result.setup_age_minutes, 30);
  assert.equal(result.setup_age_hours, 0.5);
  assert.match(result.setup_expiry_note, /belum menunjukkan kondisi invalid/i);
});

test('deriveSetupFreshness: older timestamp within aging threshold -> AGING', () => {
  const result = freshness({ calculated_at: minutesAgo(91) });
  assert.equal(result.setup_freshness_status, 'AGING');
  assert.equal(result.setup_freshness_label, 'Aging');
  assert.equal(result.setup_age_minutes, 91);
  assert.equal(result.setup_age_hours, 1.52);
  assert.match(result.setup_expiry_note, /mulai menua/i);
});

test('deriveSetupFreshness: timestamp older than expiry threshold -> EXPIRED', () => {
  const result = freshness({ calculated_at: minutesAgo(241) });
  assert.equal(result.setup_freshness_status, 'EXPIRED');
  assert.equal(result.setup_freshness_label, 'Expired');
  assert.equal(result.setup_age_minutes, 241);
  assert.equal(result.setup_age_hours, 4.02);
  assert.match(result.setup_expiry_note, /Setup terlalu lama/i);
});

test('deriveSetupFreshness: timestamp boundary behavior follows current thresholds', () => {
  assert.equal(freshness({ calculated_at: minutesAgo(90) }).setup_freshness_status, 'FRESH');
  assert.equal(freshness({ calculated_at: minutesAgo(91) }).setup_freshness_status, 'AGING');
  assert.equal(freshness({ calculated_at: minutesAgo(240) }).setup_freshness_status, 'AGING');
  assert.equal(freshness({ calculated_at: minutesAgo(241) }).setup_freshness_status, 'EXPIRED');
});

test('deriveSetupFreshness: price at or below SL -> EXPIRED', () => {
  assert.equal(freshness({ current_price: 95 }).setup_freshness_status, 'EXPIRED');
  const below = freshness({ current_price: 94 });
  assert.equal(below.setup_freshness_status, 'EXPIRED');
  assert.match(below.setup_expiry_note, /menyentuh\/di bawah SL/i);
});

test('deriveSetupFreshness: price more than current too-far-from-entry threshold -> EXPIRED', () => {
  const result = freshness({ current_price: 108 });
  assert.equal(result.setup_freshness_status, 'EXPIRED');
  assert.match(result.setup_expiry_note, /terlalu jauh dari entry/i);
});

test('deriveSetupFreshness: accepts existing freshness timestamp fields', () => {
  const fields = ['freshness_timestamp', 'calculated_at', 'run_at', 'updated_at', 'last_checked_at', 'created_at', 'first_sent_at'];
  for (const field of fields) {
    const base = { current_price: 101, entry_low: 100, entry_high: 102, stop_loss: 95 };
    base[field] = minutesAgo(15);
    const result = deriveSetupFreshness(base, { now: NOW });
    assert.equal(result.setup_freshness_status, 'FRESH', field);
    assert.equal(result.setup_age_minutes, 15, field);
  }
});
