'use strict';

/**
 * STAGE 2 — Day Trade live guard + Telegram cleanup.
 *
 * Covered here:
 *   A. lib/market-hours-guard.js — LIVE_MARKET classification on real IDX
 *      hours (so the intraday runner is never OUTSIDE_MARKET while the
 *      exchange is open), plus the 14:30 WIB radar hard cut-off.
 *   B. lib/daytrade-screener-engine.js — getMarketSessionStatus delegation
 *      and the radar-window helpers used by the runner.
 *   C. lib/telegram-templates.js — the official Signal Card must expose
 *      Entry Zone, TP1 (+ pasang BEP), TP2, Cut Loss (SL), Risk/Reward
 *      Ratio and Volume Pace; Swing cards must expose Grup/Sektor, Setup,
 *      Area Beli, TP1, TP2, SL and R:R with an R:R > 2.5x warning for
 *      Non-Konglo; the TP/SL emergency cards must carry firm action text.
 *
 * Local, deterministic, no network, no Telegram, no database.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const guard = require('../lib/market-hours-guard');
const engine = require('../lib/daytrade-screener-engine');
const templates = require('../lib/telegram-templates');

function wib(dateStr, timeStr) {
  return new Date(`${dateStr}T${timeStr}:00+07:00`);
}

// Monday-Thursday reference dates (2026-09-21 = Monday, 2026-09-17 = Thursday)
const MON = '2026-09-21';
const THU = '2026-09-17';
const FRI = '2026-09-18';
const SAT = '2026-09-19';

// ---------------------------------------------------------------------------
// A. Market hours guard — LIVE_MARKET classification
// ---------------------------------------------------------------------------

test('A1: Session 1 (09:00-12:00 WIB Mon-Thu) classifies as LIVE_MARKET, never OUTSIDE_MARKET', () => {
  // 12:00 is the break boundary (Sesi 1 runs 09:00 until 12:00 exclusive),
  // so the last Sesi 1 minute is 11:59.
  for (const time of ['09:00', '09:30', '10:30', '11:30', '11:59']) {
    const status = guard.getMarketSessionStatus(wib(THU, time));
    assert.equal(status.isOpen, true, `${time} WIB must be open`);
    assert.equal(status.session, 'SESSION_1', `${time} WIB must be SESSION_1`);
    assert.equal(status.status, 'LIVE_MARKET', `${time} WIB must be LIVE_MARKET, got ${status.status}`);
    assert.notEqual(status.status, 'OUTSIDE_MARKET');
  }
});

test('A2: Session 2 (13:30-15:45 WIB Mon-Thu) classifies as LIVE_MARKET, never OUTSIDE_MARKET', () => {
  for (const time of ['13:30', '14:00', '14:30', '15:00', '15:37', '15:45']) {
    const status = guard.getMarketSessionStatus(wib(THU, time));
    assert.equal(status.isOpen, true, `${time} WIB must be open`);
    assert.equal(status.session, 'SESSION_2', `${time} WIB must be SESSION_2`);
    assert.equal(status.status, 'LIVE_MARKET', `${time} WIB must be LIVE_MARKET, got ${status.status}`);
    assert.notEqual(status.status, 'OUTSIDE_MARKET');
  }
});

test('A3: the lunch break is the only non-LIVE gap inside the Mon-Thu trading day', () => {
  for (const time of ['12:01', '12:45', '13:00', '13:29']) {
    const status = guard.getMarketSessionStatus(wib(THU, time));
    assert.equal(status.isOpen, false, `${time} WIB is lunch break`);
    assert.equal(status.session, 'BREAK');
    assert.equal(status.status, 'OUTSIDE_MARKET');
  }
});

test('A4: Friday uses the Friday calendar (09:00-11:30 and 14:00-15:45)', () => {
  assert.equal(guard.getMarketSessionStatus(wib(FRI, '11:29')).session, 'SESSION_1');
  assert.equal(guard.getMarketSessionStatus(wib(FRI, '11:29')).status, 'LIVE_MARKET');
  assert.equal(guard.getMarketSessionStatus(wib(FRI, '11:30')).session, 'BREAK');
  assert.equal(guard.getMarketSessionStatus(wib(FRI, '11:30')).status, 'OUTSIDE_MARKET');
  assert.equal(guard.getMarketSessionStatus(wib(FRI, '13:59')).session, 'BREAK');
  assert.equal(guard.getMarketSessionStatus(wib(FRI, '14:00')).session, 'SESSION_2');
  assert.equal(guard.getMarketSessionStatus(wib(FRI, '14:00')).status, 'LIVE_MARKET');
});

test('A5: outside trading hours is OUTSIDE_MARKET (pre, post, weekend)', () => {
  assert.equal(guard.getMarketSessionStatus(wib(THU, '08:59')).status, 'OUTSIDE_MARKET');
  assert.equal(guard.getMarketSessionStatus(wib(THU, '08:59')).session, 'PRE');
  assert.equal(guard.getMarketSessionStatus(wib(THU, '15:46')).status, 'OUTSIDE_MARKET');
  assert.equal(guard.getMarketSessionStatus(wib(THU, '15:46')).session, 'CLOSED');
  assert.equal(guard.getMarketSessionStatus(wib(SAT, '10:00')).status, 'OUTSIDE_MARKET');
  assert.equal(guard.getMarketSessionStatus(wib(SAT, '10:00')).session, 'CLOSED');
});

test('A6: run_mode is derived from the same session classification', () => {
  assert.equal(guard.getMarketSessionStatus(wib(THU, '09:30')).run_mode, 'MORNING_SCOUT');
  assert.equal(guard.getMarketSessionStatus(wib(THU, '11:00')).run_mode, 'MIDDAY_CHECK');
  assert.equal(guard.getMarketSessionStatus(wib(THU, '14:00')).run_mode, 'AFTERNOON_EXIT');
  assert.equal(guard.getMarketSessionStatus(wib(THU, '08:00')).run_mode, 'OUTSIDE_MARKET');
});

test('A7: broadcast_allowed stays conservative (2-minute buffer before the Sesi 1 close)', () => {
  // Session classification says open at 11:59, but the broadcast gate does not:
  // the order book is effectively frozen two minutes before the break.
  const status = guard.getMarketSessionStatus(wib(THU, '11:59'));
  assert.equal(status.isOpen, true);
  assert.equal(status.status, 'LIVE_MARKET');
  assert.equal(status.broadcast_allowed, false);
  assert.equal(guard.isMarketOpen(wib(THU, '11:59')), false);
  // Inside the window both agree.
  assert.equal(guard.getMarketSessionStatus(wib(THU, '11:00')).broadcast_allowed, true);
});

test('A8: invalid timestamps fail closed to OUTSIDE_MARKET', () => {
  const status = guard.getMarketSessionStatus('not-a-date');
  assert.equal(status.isOpen, false);
  assert.equal(status.status, 'OUTSIDE_MARKET');
  assert.equal(status.reason, 'invalid_time');
});

// ---------------------------------------------------------------------------
// A9-A12. 14:30 WIB hard cut-off (AFTERNOON_EXIT rule)
// ---------------------------------------------------------------------------

test('A9: the 14:30 WIB cut-off blocks radar publication strictly after 14:30', () => {
  assert.equal(guard.isAfternoonExitCutoff(wib(THU, '14:29')), false);
  assert.equal(guard.isAfternoonExitCutoff(wib(THU, '14:30')), false, '14:30 itself is the last allowed minute');
  assert.equal(guard.isAfternoonExitCutoff(wib(THU, '14:31')), true);
  assert.equal(guard.isAfternoonExitCutoff(wib(THU, '15:00')), true);
});

test('A10: the 15:37 WIB pre-close radar is blocked by the cut-off', () => {
  const window = guard.evaluateDayTradeRadarWindow(wib(THU, '15:37'));
  assert.equal(window.allowed, false);
  assert.equal(window.reason, 'after_1430_wib_cutoff');
  assert.equal(window.session, 'SESSION_2');
  assert.equal(window.wib_time, '15:37');
});

test('A11: the radar window is open during normal session hours', () => {
  assert.equal(guard.evaluateDayTradeRadarWindow(wib(THU, '09:30')).allowed, true);
  assert.equal(guard.evaluateDayTradeRadarWindow(wib(THU, '13:30')).allowed, true);
  assert.equal(guard.evaluateDayTradeRadarWindow(wib(THU, '14:30')).allowed, true);
});

test('A12: the radar window is closed outside the market regardless of the clock', () => {
  assert.equal(guard.evaluateDayTradeRadarWindow(wib(THU, '12:45')).allowed, false);
  assert.equal(guard.evaluateDayTradeRadarWindow(wib(THU, '12:45')).reason, 'lunch_break');
  assert.equal(guard.evaluateDayTradeRadarWindow(wib(SAT, '10:00')).allowed, false);
  assert.equal(guard.evaluateDayTradeRadarWindow(wib(SAT, '10:00')).reason, 'weekend');
});

test('A13: getMarketSessionStatus is timezone-deterministic (UTC input, VPS-safe)', () => {
  // 09:00 WIB === 02:00 UTC
  const utcMorning = new Date('2026-09-17T02:00:00.000Z');
  assert.equal(guard.getMarketSessionStatus(utcMorning).session, 'SESSION_1');
  assert.equal(guard.getMarketSessionStatus(utcMorning).status, 'LIVE_MARKET');
  // 14:00 WIB === 07:00 UTC
  const utcAfternoon = new Date('2026-09-17T07:00:00.000Z');
  assert.equal(guard.getMarketSessionStatus(utcAfternoon).session, 'SESSION_2');
  assert.equal(guard.getMarketSessionStatus(utcAfternoon).status, 'LIVE_MARKET');
});

// ---------------------------------------------------------------------------
// B. Engine delegation
// ---------------------------------------------------------------------------

test('B1: daytrade engine delegates session classification to the central guard', () => {
  const viaEngine = engine.getMarketSessionStatus(wib(THU, '10:30'));
  const viaGuard = guard.getMarketSessionStatus(wib(THU, '10:30'));
  assert.deepEqual(viaEngine, viaGuard);
  assert.equal(viaEngine.status, 'LIVE_MARKET');
});

test('B2: engine exposes the radar cut-off helpers', () => {
  assert.equal(typeof engine.isDayTradeRadarCutoffPassed, 'function');
  assert.equal(typeof engine.evaluateDayTradeRadarWindow, 'function');
  assert.equal(engine.isDayTradeRadarCutoffPassed(wib(THU, '15:37')), true);
  assert.equal(engine.evaluateDayTradeRadarWindow(wib(THU, '15:37')).allowed, false);
  assert.equal(engine.evaluateDayTradeRadarWindow(wib(THU, '10:00')).allowed, true);
});

test('B3: the engine no longer claims the market is open after 15:45 WIB', () => {
  // The previous local calendar ran Sesi 2 until 16:00, so 15:50 WIB was
  // treated as an open session even though the order book was already frozen.
  assert.equal(engine.getMarketSessionStatus(wib(THU, '15:50')).isOpen, false);
  assert.equal(engine.getMarketSessionStatus(wib(THU, '15:50')).session, 'CLOSED');
  assert.equal(engine.getMarketSessionStatus(wib(THU, '15:45')).isOpen, true);
});

// ---------------------------------------------------------------------------
// C. Telegram templates — Signal Card / Swing / emergency TP-SL
// ---------------------------------------------------------------------------

function dayTradeRow(overrides) {
  return Object.assign({
    ticker: 'EXCL',
    status: 'A_PLUS_SETUP',
    final_status: 'A_PLUS_SETUP',
    daytrade_score: 82,
    risk_reward: 2.4,
    entry_low: 2870,
    entry_high: 2900,
    stop_loss: 2750,
    tp1: 3010,
    tp2: 3150,
    last_price: 2880,
    volume_ratio_20d: 1.8,
    intraday_volume_pace_ratio: 2.3,
    value_today: 20100000000,
    tx_value_1d: 20100000000,
    risk_label_v2: 'Medium Risk',
    liquidity_label: 'Liquid',
    tf_1d_context: 'Green candle',
    tf_5d_context: 'Bullish'
  }, overrides || {});
}

function swingRow(overrides) {
  return Object.assign({
    ticker: 'BBRI',
    status: 'Swing Ready',
    final_status: 'Swing Ready',
    score: 84,
    risk_reward: 2.2,
    entry_low: 5000,
    entry_high: 5050,
    stop_loss: 4800,
    tp1: 5500,
    tp2: 5800,
    last_price: 5025,
    volume_ratio_20d: 1.4,
    value_today: 10000000000,
    tx_value_1d: 10000000000,
    risk_label_v2: 'Medium Risk',
    liquidity_label: 'Liquid',
    sector: 'Perbankan',
    tf_1d_context: 'Bullish candle',
    tf_5d_context: 'Bullish (5D Approx)'
  }, overrides || {});
}

test('C1: Day Trade Signal Card exposes Entry Zone, TP1 (+pasang BEP), TP2, SL, R:R, Volume Pace', () => {
  const card = templates.formatSignalCard(dayTradeRow(), 1, 'daytrade');
  assert.match(card, /SIGNAL CARD/);
  assert.match(card, /Entry Zone: Rp2\.870 - Rp2\.900/);
  assert.match(card, /TP1 \(\+\d+(\.\d+)?%\): Rp3\.010 — pasang BEP setelah TP1/);
  assert.match(card, /TP2 \(\+\d+(\.\d+)?%\): Rp3\.150/);
  assert.match(card, /Cut Loss \(SL\): Rp2\.750/);
  assert.match(card, /Risk\/Reward Ratio: 2\.4x/);
  assert.match(card, /Volume Pace: 2\.3x/);
});

test('C2: Day Trade card still renders the detailed plan below the summary (additive)', () => {
  const card = templates.formatSignalCard(dayTradeRow(), 1, 'daytrade');
  assert.match(card, /Trading Plan/);
  assert.match(card, /Area Beli \(Entry\): Rp2\.870 - Rp2\.900/);
  assert.match(card, /Target Profit 1/);
  assert.match(card, /Stop Loss: Rp2\.750/);
});

test('C3: Swing Konglo card exposes Grup/Sektor, Setup, Area Beli, TP1, TP2, SL and R:R', () => {
  const card = templates.formatSignalCard(swingRow(), 1, 'swing');
  assert.match(card, /Entry Zone: Rp5\.000 - Rp5\.050/);
  assert.match(card, /Grup\/Sektor: Konglo \/ Perbankan/);
  assert.match(card, /Setup: /);
  assert.match(card, /Area Beli \(Entry\): Rp5\.000 - Rp5\.050/);
  assert.match(card, /Target Profit 1/);
  assert.match(card, /Rp5\.500/);
  assert.match(card, /Rp5\.800/);
  assert.match(card, /Stop Loss: Rp4\.800/);
  assert.match(card, /Risk\/Reward: 2\.2x/);
});

test('C4: Swing Non-Konglo shows the same structure but is labelled Non-Konglo', () => {
  const card = templates.formatSignalCard(swingRow({ ticker: 'ACES', risk_reward: 1.9 }), 1, 'swing_non_konglo');
  assert.match(card, /Grup\/Sektor: Non-Konglo \/ Perbankan/);
  assert.match(card, /Cut Loss \(SL\): Rp4\.800/);
  assert.match(card, /Risk\/Reward Ratio: 1\.9x/);
});

test('C5: Swing Non-Konglo warns when R:R exceeds the canonical 2.5x threshold', () => {
  assert.equal(templates.SWING_NK_HIGH_RR_THRESHOLD, 2.5);
  const warned = templates.formatSignalCard(swingRow({ ticker: 'ACES', risk_reward: 3.3 }), 1, 'swing_non_konglo');
  assert.match(warned, /Peringatan R:R tinggi: target 3\.3x > 2\.5x/);
  assert.match(warned, /lebih sering kena SL sebelum TP/);
});

test('C6: the R:R warning is Non-Konglo only and never fires at/below the threshold', () => {
  const atThreshold = templates.formatSignalCard(swingRow({ ticker: 'ACES', risk_reward: 2.5 }), 1, 'swing_non_konglo');
  assert.doesNotMatch(atThreshold, /Peringatan R:R tinggi/);
  const konglo = templates.formatSignalCard(swingRow({ ticker: 'BBRI', risk_reward: 3.9 }), 1, 'swing');
  assert.doesNotMatch(konglo, /Peringatan R:R tinggi/, 'Konglo must not carry the Non-Konglo warning');
});

test('C7: SL_HIT is a firm cut-loss capital-protection card', () => {
  const pick = { ticker: 'BRIS', entry1: 2000, entry2: 2040, tp1: 2150, tp2: 2280, sl: 1920, category: 'daytrade' };
  const msg = templates.formatMonitorHitMessage(pick, { status: 'SL_HIT' }, { last: 1910, high: 2050, low: 1910 });
  assert.match(msg, /🛑 SL HIT — STOP LOSS/);
  assert.match(msg, /AKSI WAJIB — CUT LOSS sekarang untuk proteksi modal/);
  assert.match(msg, /Cut loss disiplin, jangan buyback sebelum ada setup baru/);
});

test('C8: TP1_HIT is a firm secure-profit + move-SL-to-BEP card', () => {
  const pick = { ticker: 'BRIS', entry1: 2000, entry2: 2040, tp1: 2150, tp2: 2280, sl: 1920, category: 'daytrade' };
  const msg = templates.formatMonitorHitMessage(pick, { status: 'TP1_HIT' }, { last: 2150, high: 2160, low: 2020 });
  assert.match(msg, /🎯 TP1 HIT/);
  assert.match(msg, /AKSI WAJIB — Amankan profit 50% posisi SEKARANG/);
  assert.match(msg, /geser SL ke BEP \(Entry \+ 1 tick\)/);
});

test('C9: summary helper degrades safely with missing levels (no undefined/null leakage)', () => {
  const card = templates.formatSignalCard(dayTradeRow({ tp2: null, intraday_volume_pace_ratio: null, relative_volume: null, volume_ratio_20d: null, volume_pace: null }), 1, 'daytrade');
  assert.doesNotMatch(card, /undefined/);
  assert.doesNotMatch(card, /\bnull\b/);
  assert.doesNotMatch(card, /\[object Object\]/);
  assert.match(card, /Entry Zone:/);
  assert.match(card, /Cut Loss \(SL\):/);
});
