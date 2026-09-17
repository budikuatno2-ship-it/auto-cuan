'use strict';

/**
 * Batch 14 — Test Integrasi Seluruh Guard
 *
 * Membuktikan guard dari Batch 2–13 BUKAN hanya lolos secara terisolasi, tetapi
 * benar-benar TERKOMPOSISI sebagai satu pipeline ring (defense in depth):
 *
 *   1. Market Hours Guard   (lib/market-hours-guard.js)        — Batch 2/3
 *   2. R/R Gate             (lib/screener-config.js)           — Batch 5/6
 *   3. Volume Breakout Gate (lib/screener-config.js)           — Batch 9
 *   4. Candle Close Gate    (lib/screener-config.js + idx-tick)— Batch 11
 *   5. Public Telegram Gate (api/sector-hot.js)                — existing, dipertegas
 *   6. Dedup + Throttle     (lib/telegram-notifier.js)         — Batch 8/10
 *   7. Deploy ordering      (tools/atomic-deploy.js)           — Batch 13
 *
 * Fokus: cross-guard invariants — satu guard gagal => kandidat TIDAK boleh lolos
 * apa pun isi guard lain (tidak ada jalur samping yang melewati guard).
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { isMarketOpen, getMarketSession } = require('../lib/market-hours-guard');
const {
  passesRiskRewardFilter,
  passesVolumeBreakoutConfirmation,
  isCandleCloseConfirmed,
  validateRevalidationSignal
} = require('../lib/screener-config');
const { deriveBreakoutConfirmation } = require('../lib/idx-tick-normalization');
const telegramNotifier = require('../lib/telegram-notifier');
const { deriveDeployDecision } = require('../tools/atomic-deploy');
const sectorHot = require('../api/sector-hot');

const { candidatePassesPublicTelegramSafetyGate } = sectorHot.__test;

// WIB helper: build a UTC ISO instant from a Jakarta wall-clock time.
function wibToUtcIso(dateKey, wibTime) {
  const [h, m] = String(wibTime).split(':').map(Number);
  const [y, mo, d] = String(dateKey).split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h - 7, m)).toISOString();
}
const THU = '2026-08-13'; // Kamis

/**
 * A candidate that clears every guard when its flags are healthy. Individual
 * tests then break exactly one guard and assert the pipeline rejects it.
 */
function healthyCandidate(overrides) {
  return Object.assign({
    ticker: 'BBCA', category: 'Day Trade', status: 'TRADE_CANDIDATE', final_status: 'TRADE_CANDIDATE',
    last_price: 101, close: 101, high_price: 102, resistance: 100, breakout_trigger: 100,
    entry_low: 100, entry_high: 101, entry1: 101, entry2: 100,
    sl: 98, stop_loss: 98, tp1n: 104, tp1: 104, tp2n: 108, tp2: 108,
    risk_reward: 2.0, tp1_upside: 3.0,
    volume_ratio: 1.6, volume_ratio_20d: 1.6,
    price_source: 'yahoo_chart_1d_close',
    entry_status: 'IN_ENTRY_AREA', entry_quality_status: 'IN_ENTRY_AREA',
    breakout_confirmation_status: 'BREAKOUT_CONFIRMED',
    trading_plan_valid: true, plan_quality_status: 'VALID',
    liquidity_label: 'Liquid', risk_label: 'Medium Risk', risk_label_v2: 'Medium Risk',
    setup_freshness_status: 'FRESH', freshness_is_stale: false, is_stale: false
  }, overrides || {});
}

/**
 * The composed ring. Returns the FIRST guard that rejects, or 'PASS'.
 * Order mirrors the real broadcast path: session -> R/R -> volume -> close -> public.
 */
function runGuardPipeline(candidate, { marketTimeIso } = {}) {
  if (marketTimeIso && !isMarketOpen(marketTimeIso)) return 'market_closed';
  if (!passesRiskRewardFilter(candidate)) return 'poor_risk_reward';
  if (!passesVolumeBreakoutConfirmation(candidate)) return 'insufficient_volume';
  if (!isCandleCloseConfirmed(candidate)) return 'candle_not_closed';
  if (!candidatePassesPublicTelegramSafetyGate(candidate, 'telegram')) return 'public_gate';
  return 'PASS';
}

// ---------------------------------------------------------------------------
// 1. The happy path clears every guard.
// ---------------------------------------------------------------------------
test('Batch 14: a healthy candidate clears the entire guard ring', () => {
  const c = healthyCandidate();
  assert.equal(isMarketOpen(wibToUtcIso(THU, '10:00')), true);
  assert.equal(runGuardPipeline(c, { marketTimeIso: wibToUtcIso(THU, '10:00') }), 'PASS');
});

// ---------------------------------------------------------------------------
// 2. Each guard independently vetoes — no bypass via another guard.
// ---------------------------------------------------------------------------
test('Batch 14: market-closed vetoes even a flawless candidate', () => {
  const c = healthyCandidate();
  assert.equal(runGuardPipeline(c, { marketTimeIso: wibToUtcIso(THU, '12:45') }), 'market_closed');
  assert.equal(getMarketSession(wibToUtcIso(THU, '12:45')), 'CLOSED');
});

test('Batch 14: poor R/R vetoes before volume/close are even consulted', () => {
  const c = healthyCandidate({ risk_reward: 1.0 });
  assert.equal(runGuardPipeline(c, { marketTimeIso: wibToUtcIso(THU, '10:00') }), 'poor_risk_reward');
});

test('Batch 14: dry volume vetoes a high-R/R candidate', () => {
  const c = healthyCandidate({ volume_ratio: 0.7, volume_ratio_20d: 0.7 });
  assert.equal(runGuardPipeline(c, { marketTimeIso: wibToUtcIso(THU, '10:00') }), 'insufficient_volume');
});

test('Batch 14: unclosed candle vetoes a strong-volume R/R-passing candidate', () => {
  const c = healthyCandidate({ price_source: 'vps_bridge_live' });
  assert.equal(runGuardPipeline(c, { marketTimeIso: wibToUtcIso(THU, '10:00') }), 'candle_not_closed');
});

// ---------------------------------------------------------------------------
// 3. Cross-guard invariant: candle-close + public gate agree.
// ---------------------------------------------------------------------------
test('Batch 14: a live wick yields NEEDS_CLOSE_CONFIRMATION and is blocked by the public gate', () => {
  const c = healthyCandidate({ price_source: 'vps_bridge_live' });
  const label = deriveBreakoutConfirmation(c);
  assert.equal(label.breakout_confirmation_status, 'NEEDS_CLOSE_CONFIRMATION');
  assert.equal(candidatePassesPublicTelegramSafetyGate(
    Object.assign({}, c, label), 'telegram'), false);
});

test('Batch 14: an unconfirmed breakout cannot be promoted by weakenning another guard', () => {
  // Even with a perfect R/R and huge volume, the close gate alone keeps it out.
  const c = healthyCandidate({ risk_reward: 5.0, volume_ratio: 9.0, candle_forming: true });
  assert.equal(runGuardPipeline(c, { marketTimeIso: wibToUtcIso(THU, '10:00') }), 'candle_not_closed');
});

// ---------------------------------------------------------------------------
// 4. Revalidation guard composes with the rest.
// ---------------------------------------------------------------------------
test('Batch 14: validateRevalidationSignal rejects stale / low-RR / dry-volume together', () => {
  assert.equal(validateRevalidationSignal(healthyCandidate({ is_stale: true })).reason, 'stale_data');
  assert.equal(validateRevalidationSignal(healthyCandidate({ risk_reward: 1.0 })).reason, 'poor_risk_reward');
  assert.equal(
    validateRevalidationSignal(healthyCandidate({ volume_ratio: 0.5 })).reason,
    'insufficient_breakout_volume'
  );
  assert.equal(validateRevalidationSignal(healthyCandidate()).pass, true);
});

// ---------------------------------------------------------------------------
// 5. Alert layer: dedup + throttle compose after the gate.
// ---------------------------------------------------------------------------
test('Batch 14: an alert that clears the gate is then deduped, then throttled', async () => {
  telegramNotifier.clearAlertCooldownCache();
  telegramNotifier.resetTelegramThrottle();

  // Gate cleared -> first alert (neutral status) allowed and recorded.
  const first = telegramNotifier.checkAlertCooldown('BBCA', 'WATCHLIST_MONITOR', { now: 1000 });
  assert.equal(first.suppressed, false);
  telegramNotifier.recordAlertCooldown('BBCA', 'WATCHLIST_MONITOR', { now: 1000 });

  // Identical alert inside the window is suppressed.
  const dup = telegramNotifier.checkAlertCooldown('BBCA', 'WATCHLIST_MONITOR', { now: 2000 });
  assert.equal(dup.suppressed, true);

  // A drastic upgrade (neutral -> confirmed-buy) still bypasses the window.
  const upgrade = telegramNotifier.checkAlertCooldown('BBCA', 'A_PLUS_SETUP', { now: 3000 });
  assert.equal(upgrade.suppressed, false);
  assert.equal(upgrade.reason, 'status_changed_bypass');

  // Throttle gate serializes sends (no real wait in test env).
  const sleep = () => new Promise((r) => setImmediate(r));
  await telegramNotifier.acquireSendSlot({ min_interval_ms: 0, sleep });
  assert.ok(telegramNotifier.getTelegramThrottleState().defaultIntervalMs > 0);
});

// ---------------------------------------------------------------------------
// 6. Deploy guard ordering: test gate precedes reload.
// ---------------------------------------------------------------------------
test('Batch 14: deploy never reloads a revision whose tests failed', () => {
  const failing = deriveDeployDecision({ dirty: false, preSha: 'a', remoteSha: 'b', testsPassed: false });
  assert.equal(failing.reload, false);
  assert.equal(failing.rollback, true);

  const passing = deriveDeployDecision({ dirty: false, preSha: 'a', remoteSha: 'b', testsPassed: true });
  assert.equal(passing.reload, true);
  assert.equal(passing.rollback, false);
});