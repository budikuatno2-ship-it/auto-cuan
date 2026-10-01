'use strict';

/**
 * Batch 11 — Syarat Konfirmasi Candle Close Sebelum Alert Entry Zone
 *
 * Membuktikan:
 * 1. `isCandleCloseConfirmed` mendeteksi bar yang masih berjalan (live/intraday) vs close terkonfirmasi.
 * 2. `deriveBreakoutConfirmation` TIDAK melabeli `BREAKOUT_CONFIRMED` saat harga live menembus
 *    resistance hanya dengan jarum intraday (bar belum close) — status menjadi `NEEDS_CLOSE_CONFIRMATION`.
 * 3. `deriveBreakoutConfirmation` tetap melabeli `BREAKOUT_CONFIRMED` saat close valid.
 * 4. Engine `scoreDayTrade` menahan status ENTRY ZONE (A_PLUS_SETUP/TRADE_CANDIDATE/READY_BREAKOUT)
 *    untuk kandidat live yang belum close, dan mengizinkannya saat close terkonfirmasi.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { isCandleCloseConfirmed } = require('../lib/screener-config');
const { deriveBreakoutConfirmation } = require('../lib/idx-tick-normalization');
const engine = require('../lib/daytrade-screener-engine');

const ENTRY_ZONE_STATUSES = new Set(['A_PLUS_SETUP', 'TRADE_CANDIDATE', 'READY_BREAKOUT']);

// ============================================================
// 1. isCandleCloseConfirmed
// ============================================================

test('isCandleCloseConfirmed: legacy daily-close candidate (no signal) is treated as confirmed', () => {
  assert.equal(isCandleCloseConfirmed({ close: 100, resistance: 99 }), true);
  assert.equal(isCandleCloseConfirmed({ price_source: 'yahoo_chart_1d_close' }), true);
  assert.equal(isCandleCloseConfirmed(null), true);
});

test('isCandleCloseConfirmed: explicit still-forming flags are rejected', () => {
  assert.equal(isCandleCloseConfirmed({ candle_closed: false }), false);
  assert.equal(isCandleCloseConfirmed({ bar_closed: false }), false);
  assert.equal(isCandleCloseConfirmed({ candle_forming: true }), false);
  assert.equal(isCandleCloseConfirmed({ is_intraday_live: true }), false);
});

test('isCandleCloseConfirmed: live/intraday price sources are rejected', () => {
  assert.equal(isCandleCloseConfirmed({ price_source: 'vps_bridge_live' }), false);
  assert.equal(isCandleCloseConfirmed({ price_source: 'intraday_quote' }), false);
  assert.equal(isCandleCloseConfirmed({ price_source: 'realtime_tick' }), false);
  // A closed daily source must NOT be misread as live.
  assert.equal(isCandleCloseConfirmed({ price_source: 'yahoo_chart_1d_close' }), true);
});

// ============================================================
// 2 & 3. deriveBreakoutConfirmation close gate
// ============================================================

test('deriveBreakoutConfirmation: live wick above resistance -> NEEDS_CLOSE_CONFIRMATION (not confirmed)', () => {
  const result = deriveBreakoutConfirmation({
    close: 101, high_price: 102, resistance: 100,
    price_source: 'vps_bridge_live'
  });
  assert.equal(result.breakout_confirmation_status, 'NEEDS_CLOSE_CONFIRMATION');
  assert.equal(result.breakout_confirmation_label, 'Needs Close Confirmation');
  assert.equal(result.false_breakout_risk, false);
  assert.match(result.breakout_confirmation_note, /belum close/i);
});

test('deriveBreakoutConfirmation: explicit candle_forming above resistance -> NEEDS_CLOSE_CONFIRMATION', () => {
  const result = deriveBreakoutConfirmation({
    close: 101, high_price: 102, resistance: 100, candle_forming: true
  });
  assert.equal(result.breakout_confirmation_status, 'NEEDS_CLOSE_CONFIRMATION');
});

test('deriveBreakoutConfirmation: confirmed close above resistance -> BREAKOUT_CONFIRMED', () => {
  const result = deriveBreakoutConfirmation({
    close: 101, high_price: 102, resistance: 100,
    price_source: 'yahoo_chart_1d_close'
  });
  assert.equal(result.breakout_confirmation_status, 'BREAKOUT_CONFIRMED');
  assert.equal(result.breakout_confirmation_label, 'Breakout Confirmed');
});

// ============================================================
// 4. Engine end-to-end: ENTRY ZONE held until close confirmed
// ============================================================

function makeData(overrides) {
  return Object.assign({
    ticker: 'TEST',
    last_price: 101,
    open_price: 99,
    high_price: 102,
    low_price: 98,
    atr14: 0.5,
    swingLow5: 98,
    swingHigh10: 110,
    change_pct: 2,
    previous_close: 98,
    volume_today: 4000000,
    value_today: 4000000000,
    avg_volume_20d: 1000000,
    avg_value_7d: 1000000000,
    volume_ratio_20d: 4,
    rsi14: 60,
    ma20: 95,
    ma50: 90,
    resistance: 100,
    support: 98,
    range_position: 70,
    distance_to_breakout_pct: 1,
    _priceAboveOpen: true,
    _overextendedMA20: false
  }, overrides || {});
}

test('scoreDayTrade: live wick above resistance does NOT reach ENTRY ZONE status', () => {
  const scored = engine.scoreDayTrade(
    makeData({ price_source: 'vps_bridge_live' }),
    'MORNING_SCOUT', 'UTAMA', { pattern: 'Strong breakout candle', note: 'synthetic' }
  );
  assert.equal(scored.breakout_confirmation_status, 'NEEDS_CLOSE_CONFIRMATION');
  assert.equal(ENTRY_ZONE_STATUSES.has(scored.status), false,
    'live unclosed wick must not reach ENTRY ZONE, got: ' + scored.status);
  assert.equal(scored.status, 'EARLY_RADAR');
});

test('scoreDayTrade: confirmed close above resistance reaches ENTRY ZONE status', () => {
  const scored = engine.scoreDayTrade(
    makeData({ price_source: 'yahoo_chart_1d_close' }),
    'MORNING_SCOUT', 'UTAMA', { pattern: 'Strong breakout candle', note: 'synthetic' }
  );
  assert.equal(scored.breakout_confirmation_status, 'BREAKOUT_CONFIRMED');
  assert.equal(ENTRY_ZONE_STATUSES.has(scored.status), true,
    'confirmed close must reach ENTRY ZONE, got: ' + scored.status);
  assert.equal(scored.status, 'A_PLUS_SETUP');
});
