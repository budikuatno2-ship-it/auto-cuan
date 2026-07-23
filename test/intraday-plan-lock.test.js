'use strict';

/**
 * Intraday Plan-Lock tests
 * ========================
 *
 * Verifies the intraday sample collector locks the SELECTED canonical plan using
 * the DECOUPLED 'intraday_shadow' selection context: V2 when the dedicated
 * intraday-lock flag + shadow flag are on AND the V2 plan is usable, and the
 * complete legacy fallback otherwise. Also verifies observations never change the
 * locked numbers, that the deterministic plan_lock_id is stable across
 * re-observation but changes for a genuinely new screener snapshot, and that
 * progress monitoring reads the locked plan.
 *
 * The internal intraday plan-lock is governed ONLY by
 * TRADE_PLAN_V2_INTRADAY_LOCK_ENABLED (+ TRADE_PLAN_V2_SHADOW_ENABLED); the public
 * flag TRADE_PLAN_V2_PUBLIC_ENABLED never affects it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const integration = require('../lib/trade-plan-v2-integration');
const collector = require('../tools/intraday-sample-collector');
const monitor = require('../lib/top5-progress-monitor');

// Intraday-lock context: the collector's real VPS env (public V2 stays OFF).
const LOCK = { TRADE_PLAN_V2_INTRADAY_LOCK_ENABLED: 'true', TRADE_PLAN_V2_SHADOW_ENABLED: 'true' };
const OFF = {};

function usableResult(extra) {
  return Object.assign({
    ticker: 'BBCA',
    entry_low: 9400, entry_high: 9450,
    support: 9300, swing_low: 9250,
    resistance: 9900, next_resistance: 10200,
    atr14: 120, last_price: 9440, current_price: 9440,
    tp1: 9850, tp2: 10200, stop_loss: 9200, risk_reward: 2.1
  }, extra || {});
}

function legacyOnlyResult(extra) {
  return Object.assign({
    ticker: 'GOTO', entry_low: 100, entry_high: 102,
    tp1: 110, tp2: 120, stop_loss: 95, risk_reward: 2.0
  }, extra || {});
}

test('5. intraday sample stores the selected V2 plan and source (intraday lock on)', () => {
  const rec = collector.buildCandidateRecord(usableResult(), '09:15', 1, null, '2026-07-23', LOCK);
  assert.equal(rec.trade_plan_source, 'trade_plan_v2');
  const p = rec.selected_trade_plan;
  assert.ok(p, 'selected_trade_plan must be persisted');
  // Every required intraday field is present.
  for (const f of ['entry_zone_low', 'entry_zone_high', 'stop_loss', 'structural_invalidation',
    'emergency_stop', 'tp1', 'tp2', 'rr_to_tp1', 'minimum_rr_to_tp1', 'stop_anchor_type',
    'tp1_anchor_type', 'plan_status', 'plan_warnings', 'plan_generated_at']) {
    assert.ok(Object.prototype.hasOwnProperty.call(p, f), 'missing intraday field: ' + f);
  }
  // V2 structural fields are genuinely populated for a usable plan.
  assert.ok(p.emergency_stop != null);
  assert.equal(p.stop_anchor_type, 'CONFIRMED_SWING_LOW');
  assert.ok(rec.plan_lock_id && /^tplock_/.test(rec.plan_lock_id));
});

test('6. intraday sample stores legacy fallback when V2 is rejected (intraday lock on)', () => {
  const rec = collector.buildCandidateRecord(legacyOnlyResult(), '09:15', 1, null, '2026-07-23', LOCK);
  assert.equal(rec.trade_plan_source, 'legacy_fallback');
  const p = rec.selected_trade_plan;
  assert.equal(p.stop_loss, 95);
  assert.equal(p.tp1, 110);
  assert.equal(p.tp2, 120);
  // Legacy has no structural anchors — never fabricated.
  assert.equal(p.emergency_stop, null);
  assert.equal(p.stop_anchor_type, null);
});

test('7. intraday observations do not change the locked entry, SL, emergency SL, TP1, TP2', () => {
  const result = usableResult();
  const rec = collector.buildCandidateRecord(result, '09:15', 1, null, '2026-07-23', LOCK);
  const locked = JSON.parse(JSON.stringify(rec.selected_trade_plan));
  // Simulate observations at several very different intraday prices. Progress is
  // evaluated against the locked plan; it must NEVER rewrite the locked numbers.
  const row = { ticker: 'BBCA', selected_trade_plan: rec.selected_trade_plan, plan_lock_id: rec.plan_lock_id };
  for (const price of [9000, 9500, 9850, 10300]) {
    monitor.computeTop5Progress(row, price, { priceTimestamp: new Date().toISOString() });
  }
  assert.deepEqual(rec.selected_trade_plan, locked, 'locked plan must be immutable across observations');
  assert.equal(rec.selected_trade_plan.stop_loss, locked.stop_loss);
  assert.equal(rec.selected_trade_plan.emergency_stop, locked.emergency_stop);
  assert.equal(rec.selected_trade_plan.tp1, locked.tp1);
  assert.equal(rec.selected_trade_plan.tp2, locked.tp2);
});

test('8. a later observation keeps the same plan-lock identifier', () => {
  const result = usableResult();
  const a = collector.buildCandidateRecord(result, '09:15', 1, null, '2026-07-23', LOCK);
  // A later run of the SAME screener snapshot (same numbers, same date).
  const b = collector.buildCandidateRecord(usableResult(), '15:45', 5, null, '2026-07-23', LOCK);
  assert.equal(a.plan_lock_id, b.plan_lock_id, 'the lock id must be stable across observations');
  // The locked numbers are identical too.
  assert.deepEqual(a.selected_trade_plan, b.selected_trade_plan);
});

test('9. a new screener snapshot may intentionally produce a new lock identifier', () => {
  const a = collector.buildCandidateRecord(usableResult(), '09:15', 1, null, '2026-07-23', LOCK);
  // New snapshot: the plan structure changed (a different confirmed swing low
  // yields a different SL) — the lock id MUST change.
  const b = collector.buildCandidateRecord(usableResult({ swing_low: 9100, support: 9150 }), '09:15', 1, null, '2026-07-23', LOCK);
  assert.notEqual(a.plan_lock_id, b.plan_lock_id, 'a changed plan must produce a new lock id');
  // A different trading date is also a new snapshot.
  const c = collector.buildCandidateRecord(usableResult(), '09:15', 1, null, '2026-07-24', LOCK);
  assert.notEqual(a.plan_lock_id, c.plan_lock_id, 'a new trading date must produce a new lock id');
});

test('10. progress monitoring reads the locked selected plan (not the raw row fields)', () => {
  const rec = collector.buildCandidateRecord(usableResult(), '09:15', 1, null, '2026-07-23', LOCK);
  // Raw row carries DIFFERENT tp1/sl; the locked plan must win.
  const row = {
    ticker: 'BBCA', latest_price: 9860,
    tp1: 99999, tp2: 100000, sl: 1, entry_high: 99999,
    selected_trade_plan: rec.selected_trade_plan, plan_lock_id: rec.plan_lock_id
  };
  const progress = monitor.computeTop5Progress(row, 9860, { priceTimestamp: new Date().toISOString() });
  assert.equal(progress.tp1, rec.selected_trade_plan.tp1);
  assert.equal(progress.sl, rec.selected_trade_plan.stop_loss);
  assert.equal(progress.entry_used, rec.selected_trade_plan.entry_zone_high);
  assert.equal(progress.trade_plan_source, 'trade_plan_v2');
  assert.equal(progress.plan_lock_id, rec.plan_lock_id);
  // 9860 >= locked tp1 (9850) but < raw tp1 (99999) => proves the locked plan was used.
  assert.equal(progress.tp1_hit, true);
});

test('bonus: intraday collector default env (intraday lock off) locks the legacy plan', () => {
  const rec = collector.buildCandidateRecord(usableResult(), '09:15', 1, null, '2026-07-23', OFF);
  assert.equal(rec.trade_plan_source, 'legacy');
  assert.equal(rec.selected_trade_plan.stop_loss, 9200); // unchanged legacy SL
  assert.ok(rec.plan_lock_id);
});
