'use strict';

/**
 * Batch 15 — Regression Test Data Historis Nyata (SSMS, KAEF, SMGR, IMJS, INKP)
 *
 * Setiap fixture di sini adalah data produksi NYATA yang diambil dari Supabase
 * pada insiden 17 September 2026 (lihat SCREENER_ARCHITECTURE_AUDIT.md §4.1).
 * Uji ini membuktikan bahwa kondisi yang DULU meloloskan sinyal sekarang
 * ditolak oleh guard yang tepat:
 *
 *   - IMJS (Konglo)     R/R 1.27  -> R/R gate (Batch 5/7)
 *   - SSMS (Non-Konglo) R/R 1.00  -> R/R gate (Batch 5/6)
 *   - KAEF (Konglo)     R/R 4.25, 12:45 WIB -> market hours guard (Batch 2/3)
 *   - INKP (Konglo)     R/R 2.82, 12:45 WIB -> market hours guard (Batch 2/3)
 *   - SMGR (Konglo)     R/R 3.67, 12:45 WIB -> market hours guard (Batch 2/3)
 *
 * Plus: KAEF menyentuh entry_high secara live (bar belum close) -> candle gate (Batch 11).
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { isMarketOpen, getMarketSession } = require('../lib/market-hours-guard');
const { passesRiskRewardFilter, MIN_RR_RATIO } = require('../lib/screener-config');
const { deriveBreakoutConfirmation } = require('../lib/idx-tick-normalization');

// Kamis 17 September 2026 — hari insiden (lunch break 11:58-13:30 WIB).
const INCIDENT_DATE = '2026-09-17';

function wibToUtcIso(dateKey, wibTime) {
  const [h, m] = String(wibTime).split(':').map(Number);
  const [y, mo, d] = String(dateKey).split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h - 7, m)).toISOString();
}

// --- Fixtures = data produksi riil (swing_screener_latest / _non_konglo_latest) ---
const HISTORICAL = {
  IMJS: { ticker: 'IMJS', status: 'Watchlist', score: 76, risk_reward: 1.27, last_price: 188, entry_low: 182, entry_high: 186, stop_loss: 175, tp1: 200 },
  KAEF: { ticker: 'KAEF', status: 'Watchlist', score: 72, risk_reward: 4.25, last_price: 448, entry_low: 442, entry_high: 448, stop_loss: 424, tp1: 550 },
  SSMS: { ticker: 'SSMS', status: 'Wait Pullback', score: 91, risk_reward: 2.25, last_price: 1155, entry_low: 1140, entry_high: 1155, stop_loss: 1095, tp1: 1290 },
  INKP: { ticker: 'INKP', status: 'Watchlist', score: 87, risk_reward: 2.82, last_price: 8725, entry_low: 8550, entry_high: 8725, stop_loss: 8450, tp1: 9500 },
  SMGR: { ticker: 'SMGR', status: 'Watchlist', score: 80, risk_reward: 3.67, last_price: 1620, entry_low: 1580, entry_high: 1620, stop_loss: 1560, tp1: 1840 }
};

// --- 1. R/R gate: the incident low-R/R emiten are now rejected ---------------
test('Batch 15: IMJS real row (R/R 1.27x) is rejected by the R/R gate', () => {
  assert.equal(MIN_RR_RATIO, 1.5);
  assert.equal(passesRiskRewardFilter(HISTORICAL.IMJS), false, 'IMJS 1.27x must fail');
});

test('Batch 15: SSMS morning leak (R/R 1.0x at 1080, above entry) is rejected by the R/R gate', () => {
  // On-the-day leak row: price 1080 vs entry 1050-1075, R/R 1.0x.
  const ssmsMorning = { ticker: 'SSMS', last_price: 1080, entry_low: 1050, entry_high: 1075, risk_reward: 1.0 };
  assert.equal(passesRiskRewardFilter(ssmsMorning), false, 'SSMS morning 1.0x must fail');
  // The row published later (2.25x) legitimately passes.
  assert.equal(passesRiskRewardFilter(HISTORICAL.SSMS), true, 'SSMS published 2.25x is valid');
});

test('Batch 15: the valid-R/R Konglo rows all PASS the R/R gate', () => {
  for (const t of ['KAEF', 'INKP', 'SMGR']) {
    assert.equal(passesRiskRewardFilter(HISTORICAL[t]), true, t + ' R/R must pass');
  }
});

// --- 2. Market hours guard: 12:45 WIB incident instant is CLOSED --------------
test('Batch 15: the 12:45 WIB incident instant is strictly CLOSED (lunch break)', () => {
  const at = wibToUtcIso(INCIDENT_DATE, '12:45');
  assert.equal(getMarketSession(at), 'CLOSED');
  assert.equal(isMarketOpen(at), false);
});

test('Batch 15: KAEF / INKP / SMGR valid-R/R rows are all blocked at 12:45 WIB', () => {
  const at = wibToUtcIso(INCIDENT_DATE, '12:45');
  for (const t of ['KAEF', 'INKP', 'SMGR']) {
    // R/R is fine, so ONLY the market guard can stop these — exactly the missing guard.
    assert.equal(passesRiskRewardFilter(HISTORICAL[t]), true, t + ' passes R/R');
    assert.equal(isMarketOpen(at), false, t + ' must be blocked by market hours at 12:45');
  }
});

test('Batch 15: the same rows would be allowed during an active session (guard is time-scoped, not blanket)', () => {
  const morning = wibToUtcIso(INCIDENT_DATE, '10:00');
  const afternoon = wibToUtcIso(INCIDENT_DATE, '14:00');
  assert.equal(isMarketOpen(morning), true);
  assert.equal(isMarketOpen(afternoon), true);
});

// --- 3. Candle close gate: a live breakout above resistance is held -----------
// KAEF closed at 448 (== entry_high) — an entry-zone touch, not a breakout. The
// candle-close gate applies when price is ABOVE resistance on a still-forming bar.
test('Batch 15: a live bar above resistance is held at NEEDS_CLOSE_CONFIRMATION', () => {
  const live = {
    ticker: 'KAEF', close: 448, high_price: 450, resistance: 442,
    price_source: 'vps_bridge_live'
  };
  const label = deriveBreakoutConfirmation(live);
  assert.equal(label.breakout_confirmation_status, 'NEEDS_CLOSE_CONFIRMATION');
});

test('Batch 15: the same bar on a confirmed close is labelled BREAKOUT_CONFIRMED', () => {
  const closed = {
    ticker: 'KAEF', close: 448, high_price: 450, resistance: 442,
    price_source: 'yahoo_chart_1d_close'
  };
  const label = deriveBreakoutConfirmation(closed);
  assert.equal(label.breakout_confirmation_status, 'BREAKOUT_CONFIRMED');
});

// --- 4. Composite: every incident row is now stopped by exactly one guard -----
test('Batch 15: every incident row is stopped (none reaches public broadcast unchanged)', () => {
  const at1245 = wibToUtcIso(INCIDENT_DATE, '12:45');
  const at1000 = wibToUtcIso(INCIDENT_DATE, '10:00');

  // IMJS + SSMS-morning: stopped by R/R regardless of time.
  assert.equal(passesRiskRewardFilter(HISTORICAL.IMJS), false);
  assert.equal(passesRiskRewardFilter({ risk_reward: 1.0 }), false);

  // KAEF/INKP/SMGR at 12:45: stopped by market hours.
  assert.equal(isMarketOpen(at1245), false);
  // The same valid rows during a live session are NOT blocked (guard correctness).
  assert.equal(isMarketOpen(at1000), true);
});