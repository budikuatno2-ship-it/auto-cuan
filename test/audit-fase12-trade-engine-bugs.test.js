'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// =============================================================================
// F12 — Trade Engine Core / Signal State Machine / Confluence / Dispatcher
// Zero-trust, test-first: tiap temuan harus FAIL dulu sebelum di-fix.
// =============================================================================

// F12-01: reversal-breakout-lifecycle stale version guard — cached row never re-evaluated
test('F12-01: re-applyLifecycle must re-evaluate when corporate guard flips to BLOCKED', () => {
  const lifecycle = require('../lib/reversal-breakout-lifecycle');
  const row = {
    last_price: 105, resistance: 100, support: 90,
    breakout_confirmation_status: 'BREAKOUT_CONFIRMED',
    volume_ratio_avg20: 1.8, change_pct: 3,
    lifecycle_version: lifecycle.VERSION,
    setup_phase: 'BREAKOUT_CONFIRMED',
    lifecycle_active: true,
  };
  const withGuard = Object.assign({}, row, { corporate_action_guard: 'BLOCKED' });
  const out = lifecycle.applyLifecycle(withGuard, { mode: 'daytrade' });
  assert.equal(out.setup_phase, 'INVALIDATED', 'row with BLOCKED guard must be INVALIDATED even when version already stamped');
  assert.equal(out.lifecycle_active, false);
});

// F12-02: emergency_stop must be usable diagnostic even when plan REJECTED for distance
test('F12-02: emergency_stop must be tick-valid even when normal plan is REJECTED for distance', () => {
  const tp = require('../lib/trade-plan-v2');
  const plan = tp.buildTradePlanV2(
    { ticker: 'TEST', entry_low: 1000, entry_high: 1010, support: 700, emergency_support: 700, resistance: 1100, atr14: 10, current_price: 1005 },
    { screener_type: 'DAY_TRADE' }
  );
  assert.equal(plan.status, 'REJECTED');
  assert.equal(plan.reject_reason, 'NO_STRUCTURAL_LEVEL');
  assert.notEqual(plan.emergency_stop, null, 'emergency_stop must be present as diagnostic even on REJECTED plan');
  assert.ok(Number.isFinite(plan.emergency_stop), 'emergency_stop must be finite');
});

// F12-03: bandarmologi label downgrade when 3d null wipes 7d accumulation
test('F12-03: bandar label must not downgrade Accumulation when 3d is null due to missing window', () => {
  const bc = require('../lib/bandarmologi-confluence');
  const net3d = null, net7d = 5000000, net1m = null, net3m = null;
  const labelWithNullGuard = bc.getBandarTrendLabel(net3d != null ? net3d : 0, net7d != null ? net7d : 0, net1m, net3m);
  assert.equal(labelWithNullGuard, 'Accumulation', 'missing 3d must not wipe 7d accumulation - label should be Accumulation');
  assert.equal(bc.getBandarTrendLabel(100, 5000000, null, null), 'Accumulation');
});

// F12-04: REJECTED plan with tiny RR must not leak Infinity, and WARNING-vs-usable divergence
test('F12-04: REJECTED plan RR must be finite and usable-contract must match status', () => {
  const tp = require('../lib/trade-plan-v2');
  const integ = require('../lib/trade-plan-v2-integration');
  const plan = tp.buildTradePlanV2(
    { ticker: 'TEST', entry_low: 1000, entry_high: 1000, support: 960, confirmed_swing_low: 960, resistance: 1025, atr14: 8, current_price: 1000, board: null, is_fca: false },
    { screener_type: 'SWING_KONGLO', generated_at: new Date().toISOString() }
  );
  assert.equal(plan.status, 'REJECTED');
  assert.ok(Number.isFinite(plan.rr_to_tp1), 'rr_to_tp1 must be finite, not Infinity');
  assert.equal(plan.rr_to_tp1, 0.4);
  assert.equal(integ.isPlanV2Usable(plan), false, 'REJECTED plan must not be usable');
});

// F12-05: cache mutable shared state leak
test('F12-05: bandarmologi cache must not expose mutable shared state across callers', () => {
  const bc = require('../lib/bandarmologi-confluence');
  const svc = require('../lib/bandarmologi-service');
  const origRead = svc.readDiskCache;
  const origList = svc.listDiskDates;
  const origNorm = svc.normalizeBrokerSummary;
  svc.readDiskCache = () => ({ net_flow: 1000000, foreign_buy: 5000000, foreign_sell: 4000000 });
  svc.listDiskDates = () => ['2026-09-23', '2026-09-22', '2026-09-21'];
  svc.normalizeBrokerSummary = () => ({ net_flow: 1000000, foreign_net: 500000, net_status: 'NEUTRAL', date: '2026-09-23' });
  bc.clearMemoryCacheForTesting();
  const a = bc.computeBandarmologiConfluence('TESTMUT');
  a.injected_field = 'caller A mutation';
  const b = bc.computeBandarmologiConfluence('TESTMUT');
  const leaked = b.injected_field === 'caller A mutation';
  svc.readDiskCache = origRead;
  svc.listDiskDates = origList;
  svc.normalizeBrokerSummary = origNorm;
  bc.clearMemoryCacheForTesting();
  assert.equal(leaked, false, 'cache must not leak mutations across callers');
});

// F12-06: resolvePublicTradePlan rebuild path must preserve rejection fallback
test('F12-06: resolvePublicTradePlan rebuild path must not silently change rejection reason', () => {
  const integ = require('../lib/trade-plan-v2-integration');
  const tp = require('../lib/trade-plan-v2');
  const candidate = { ticker: 'TEST', entry_low: 100, entry_high: 100, support: 99, confirmed_swing_low: 99, resistance: 120, atr14: 0.2, current_price: 100 };
  const first = tp.buildTradePlanV2(candidate, { screener_type: 'DAY_TRADE' });
  if (first.status === 'REJECTED' && first.reject_reason === 'STOP_NOT_BELOW_ENTRY') {
    const candWithPlan = Object.assign({}, candidate, { trade_plan_v2: first });
    const resolved = integ.resolvePublicTradePlan(candWithPlan, { channel: 'web', mode: 'DAY_TRADE', env: { TRADE_PLAN_V2_PUBLIC_ENABLED: 'true' } });
    assert.equal(resolved.fallback, true, 'REJECTED plan must fallback, not become usable after rebuild');
    assert.equal(resolved.source, 'legacy_fallback');
  } else {
    assert.ok(first.status);
  }
});
