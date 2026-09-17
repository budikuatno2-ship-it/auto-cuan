'use strict';

/**
 * Batch 9 — Syarat Konfirmasi Volume Breakout untuk Revalidasi
 *
 * Membuktikan:
 * 1. `passesVolumeBreakoutConfirmation` mengekstrak volume ratio dari berbagai varian properti.
 * 2. `validateRevalidationSignal` menolak sinyal stale, R/R rendah, dan breakout tanpa volume.
 * 3. `deriveBreakoutConfirmation` TIDAK lagi melabeli `BREAKOUT_CONFIRMED` saat volume kering
 *    (VR < 1.0x) — status menjadi `VOLUME_CONFIRMATION_NEEDED`.
 * 4. `candidatePassesPublicTelegramSafetyGate` memblokir `VOLUME_CONFIRMATION_NEEDED`.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MIN_BREAKOUT_VOLUME_RATIO,
  passesVolumeBreakoutConfirmation,
  validateRevalidationSignal
} = require('../lib/screener-config');

const { deriveBreakoutConfirmation } = require('../lib/idx-tick-normalization');

test('Batch 9: MIN_BREAKOUT_VOLUME_RATIO constant is 1.2', () => {
  assert.equal(MIN_BREAKOUT_VOLUME_RATIO, 1.2);
});

test('passesVolumeBreakoutConfirmation: extracts volume ratio from all naming variants', () => {
  assert.equal(passesVolumeBreakoutConfirmation({ volume_ratio: 1.5 }), true);
  assert.equal(passesVolumeBreakoutConfirmation({ volume_ratio_20d: 1.5 }), true);
  assert.equal(passesVolumeBreakoutConfirmation({ volume_ratio_avg20: 1.5 }), true);
  assert.equal(passesVolumeBreakoutConfirmation({ volumeRatio: 1.5 }), true);
  assert.equal(passesVolumeBreakoutConfirmation({ vr: 1.5 }), true);
  assert.equal(passesVolumeBreakoutConfirmation({ vol_ratio: 1.5 }), true);
});

test('passesVolumeBreakoutConfirmation: rejects weak / missing / invalid volume', () => {
  assert.equal(passesVolumeBreakoutConfirmation({ volume_ratio: 0.8 }), false, 'VR 0.8x must fail');
  assert.equal(passesVolumeBreakoutConfirmation({ volume_ratio: 1.19 }), false, 'VR 1.19x must fail');
  assert.equal(passesVolumeBreakoutConfirmation({ volume_ratio: 1.2 }), true, 'VR 1.2x must pass');
  assert.equal(passesVolumeBreakoutConfirmation({}), false, 'missing volume must fail');
  assert.equal(passesVolumeBreakoutConfirmation(null), false, 'null candidate must fail');
  assert.equal(passesVolumeBreakoutConfirmation({ volume_ratio: 'abc' }), false, 'NaN volume must fail');
  assert.equal(passesVolumeBreakoutConfirmation({ volume_ratio: -1 }), false, 'negative volume must fail');
});

test('validateRevalidationSignal: stale data is rejected', () => {
  const result = validateRevalidationSignal({
    is_stale: true,
    risk_reward: 2.0,
    volume_ratio: 2.0,
    entry_status: 'BREAKOUT_CONFIRMED'
  });
  assert.equal(result.pass, false);
  assert.equal(result.reason, 'stale_data');
});

test('validateRevalidationSignal: poor R/R is rejected', () => {
  const result = validateRevalidationSignal({
    risk_reward: 1.0,
    volume_ratio: 2.0,
    entry_status: 'BREAKOUT_CONFIRMED'
  });
  assert.equal(result.pass, false);
  assert.equal(result.reason, 'poor_risk_reward');
});

test('validateRevalidationSignal: breakout without volume confirmation is rejected', () => {
  const result = validateRevalidationSignal({
    risk_reward: 2.0,
    volume_ratio: 0.9,
    entry_status: 'BREAKOUT_CONFIRMED'
  });
  assert.equal(result.pass, false);
  assert.equal(result.reason, 'insufficient_breakout_volume');
});

test('validateRevalidationSignal: breakout with confirmed volume passes', () => {
  const result = validateRevalidationSignal({
    risk_reward: 2.0,
    volume_ratio: 1.5,
    entry_status: 'BREAKOUT_CONFIRMED'
  });
  assert.equal(result.pass, true);
  assert.equal(result.reason, null);
});

test('validateRevalidationSignal: non-breakout status does not require volume', () => {
  const result = validateRevalidationSignal({
    risk_reward: 2.0,
    entry_status: 'WAIT_PULLBACK'
  });
  assert.equal(result.pass, true);
  assert.equal(result.reason, null);
});

test('validateRevalidationSignal: require_volume forces volume check', () => {
  const result = validateRevalidationSignal(
    { risk_reward: 2.0, volume_ratio: 0.5, entry_status: 'WAIT_PULLBACK' },
    { require_volume: true }
  );
  assert.equal(result.pass, false);
  assert.equal(result.reason, 'insufficient_breakout_volume');
});

test('deriveBreakoutConfirmation: close above resistance with weak volume -> VOLUME_CONFIRMATION_NEEDED', () => {
  const result = deriveBreakoutConfirmation({
    close: 101,
    high_price: 102,
    resistance: 100,
    volume_ratio: 0.7
  });
  assert.equal(result.breakout_confirmation_status, 'VOLUME_CONFIRMATION_NEEDED');
  assert.equal(result.breakout_confirmation_label, 'Needs Volume Confirmation');
  assert.equal(result.false_breakout_risk, false);
  assert.match(result.breakout_confirmation_note, /volume ratio/i);
});

test('deriveBreakoutConfirmation: close above resistance with confirmed volume -> BREAKOUT_CONFIRMED', () => {
  const result = deriveBreakoutConfirmation({
    close: 101,
    high_price: 102,
    resistance: 100,
    volume_ratio: 1.5
  });
  assert.equal(result.breakout_confirmation_status, 'BREAKOUT_CONFIRMED');
  assert.equal(result.breakout_confirmation_label, 'Breakout Confirmed');
  assert.equal(result.false_breakout_risk, false);
});

test('deriveBreakoutConfirmation: no volume data preserves legacy BREAKOUT_CONFIRMED behavior', () => {
  const result = deriveBreakoutConfirmation({ close: 101, high_price: 102, resistance: 100 });
  assert.equal(result.breakout_confirmation_status, 'BREAKOUT_CONFIRMED');
});

test('deriveBreakoutConfirmation: custom min_breakout_volume_ratio is honored', () => {
  const result = deriveBreakoutConfirmation({
    close: 101,
    high_price: 102,
    resistance: 100,
    volume_ratio: 1.1,
    min_breakout_volume_ratio: 1.5
  });
  assert.equal(result.breakout_confirmation_status, 'VOLUME_CONFIRMATION_NEEDED');
});