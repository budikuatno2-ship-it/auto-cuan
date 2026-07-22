'use strict';

/**
 * Trade Plan V2 — Screener Integration tests
 * ==========================================
 *
 * Covers the wiring of the canonical Trade Plan V2 into the three screener
 * pipelines and the website / Telegram presentation:
 *
 *   - structural SL below support / active demand-gap invalidation
 *   - TP1 before resistance / active supply gap
 *   - an excessively wide SL is never silently accepted
 *   - insufficient RR to TP1 is never silently accepted
 *   - base screener scoring / candidate fields are never mutated
 *   - liquidity-sweep delayed exit stays disabled in production output
 *   - legacy fallback when V2 data is missing / the V2 plan is rejected
 *   - website and Telegram display identical numeric values
 *   - the public flag false preserves the current public output
 *   - the API surface remains exactly 12 endpoints
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const integration = require('../lib/trade-plan-v2-integration');
const fmt = require('../lib/trade-plan-v2-formatter');
const flags = require('../lib/trade-plan-v2-flags');
const tpv2 = require('../lib/trade-plan-v2');
const templates = require('../lib/telegram-templates');
const replay = require('../lib/trade-plan-v2-replay-preview');

const ROOT = path.join(__dirname, '..');

// A well-formed, tradeable Day-Trade candidate (RR comfortably above min).
function goodCandidate(extra) {
  return Object.assign({
    ticker: 'BBCA',
    entry_low: 9400,
    entry_high: 9450,
    support: 9300,
    swing_low: 9250,
    resistance: 9900,
    next_resistance: 10200,
    atr14: 120,
    last_price: 9440,
    current_price: 9440,
    tp1: 9850,
    tp2: 10200,
    stop_loss: 9200,
    risk_reward: 2.1
  }, extra || {});
}

function planFor(candidate, screener, opts) {
  return integration.buildCandidatePlanV2(candidate, Object.assign({ screener_type: screener || 'DAY_TRADE' }, opts || {}));
}

// ===================================================================
// Structural stop loss
// ===================================================================

test('1. structural SL sits below support and the structural invalidation', () => {
  const plan = planFor(goodCandidate());
  assert.equal(plan.status !== tpv2.STATUS.REJECTED, true, 'plan should not be rejected: ' + plan.reject_reason);
  assert.ok(plan.stop_loss < plan.support, 'SL must be below support');
  assert.ok(plan.stop_loss < plan.structural_invalidation, 'SL must be below structural invalidation');
  // SL anchored below the LOWEST structural anchor (min of support / swing low).
  assert.ok(plan.stop_loss < 9250, 'SL must be below the confirmed swing low');
  // Emergency structural stop always present and below the SL.
  assert.ok(plan.emergency_stop < plan.stop_loss, 'emergency stop must sit below the SL');
});

test('2. an active demand gap below the local anchor remains the emergency/reference structure', () => {
  const cand = goodCandidate();
  // The active demand gap is farther below the confirmed swing low (9250), so
  // it must not widen the normal stop; it remains a separate hard-stop anchor.
  const gaps = [{ gap_type: 'demand', gap_low: 9100, gap_high: 9180, gap_direction: 'DEMAND' }];
  const plan = planFor(cand, 'DAY_TRADE', { gaps });
  assert.ok(plan.nearest_demand_gap && plan.nearest_demand_gap.active, 'demand gap should be active');
  assert.equal(plan.stop_anchor_type, tpv2.SUPPORT_ANCHOR_TYPE.CONFIRMED_SWING_LOW);
  assert.equal(plan.emergency_anchor_type, tpv2.SUPPORT_ANCHOR_TYPE.DEMAND_GAP_INVALIDATION);
  assert.ok(plan.emergency_stop < plan.nearest_demand_gap.gap_low, 'emergency stop must sit below demand-gap invalidation');
});

// ===================================================================
// Take profit
// ===================================================================

test('3. TP1 is placed before the nearest resistance', () => {
  const plan = planFor(goodCandidate());
  assert.ok(plan.tp1 !== null, 'TP1 should exist when resistance is available');
  assert.ok(plan.tp1 < plan.resistance, 'TP1 must sit before resistance');
  assert.ok(plan.tp1 > plan.entry_zone_high, 'TP1 must be above the entry reference');
});

test('4. TP1 is capped before an active supply gap', () => {
  const cand = goodCandidate();
  // Active supply gap (low 9600) between entry and resistance (9900).
  const gaps = [{ gap_type: 'supply', gap_low: 9600, gap_high: 9700, gap_direction: 'SUPPLY' }];
  const plan = planFor(cand, 'DAY_TRADE', { gaps });
  assert.ok(plan.nearest_supply_gap && plan.nearest_supply_gap.active, 'supply gap should be active');
  assert.ok(plan.tp1 < plan.nearest_supply_gap.gap_low, 'TP1 must sit before the active supply gap');
  assert.match(plan.tp1_reason, /supply gap/i, 'TP1 reason should cite the supply-gap cap');
});

// ===================================================================
// Excessively wide SL is never silent
// ===================================================================

test('5. an excessively wide SL is rejected, not silently passed', () => {
  // Support far below entry => stop distance beyond the DAY_TRADE reject budget.
  const cand = goodCandidate({ support: 8800, swing_low: 8700, stop_loss: 8600 });
  const plan = planFor(cand);
  assert.equal(plan.status, tpv2.STATUS.REJECTED, 'a huge stop distance must be rejected');
  assert.ok(plan.warnings.indexOf('STOP_DISTANCE_EXCEEDS_RISK_BUDGET') >= 0, 'must warn about the risk budget');
  assert.equal(integration.isPlanV2Usable(plan), false, 'rejected plan must not be usable publicly');
});

test('6. a moderately wide SL downgrades status and warns (never silent OK)', () => {
  // Stop distance between the risk-budget (4%) and reject (7%) thresholds.
  const cand = goodCandidate({ support: 9010, swing_low: 8990, resistance: 10200, next_resistance: 10600 });
  const plan = planFor(cand);
  assert.notEqual(plan.status, tpv2.STATUS.OK, 'a wide SL must not be a silent OK');
  assert.ok(plan.warnings.indexOf('STOP_DISTANCE_EXCEEDS_RISK_BUDGET') >= 0, 'must warn about the risk budget');
});

// ===================================================================
// Insufficient RR is never silent
// ===================================================================

test('7. insufficient RR to TP1 is warned/rejected, not silently passed', () => {
  // Resistance very close above entry => small reward => RR below the DAY_TRADE min (1.00).
  // entry=9450, swing_low=9250, buffer=60, SL=9190, risk=260. resistance=9680
  // obstacleBuffer = max(5, 0.20*120) = 24. cappedTp1 = 9680-24 = 9656
  // baseTp1 = 9450 + 1.15*260 = 9749. tp1 = min(9749, 9656) = 9656, capped by resistance.
  // reward = 9656-9450 = 206, rr = 206/260 = 0.79 < 1.0 => REJECTED.
  const cand = goodCandidate({ resistance: 9680, next_resistance: 9700, tp1: 9650 });
  const plan = planFor(cand);
  if (plan.rr_to_tp1 !== null && plan.rr_to_tp1 < tpv2.SCREENER_PROFILES.DAY_TRADE.min_rr_to_tp1) {
    assert.notEqual(plan.status, tpv2.STATUS.OK, 'a sub-minimum RR must not be a silent OK');
    assert.ok(plan.warnings.indexOf('INSUFFICIENT_RR_TO_TP1') >= 0, 'must warn about insufficient RR');
  } else {
    assert.fail('test fixture did not produce a sub-minimum RR: ' + plan.rr_to_tp1);
  }
});

test('8. an RR below 1.0 is a hard rejection', () => {
  const cand = goodCandidate({ resistance: 9470, next_resistance: 9480, tp1: 9460 });
  const plan = planFor(cand);
  if (plan.rr_to_tp1 !== null && plan.rr_to_tp1 < 1.0) {
    assert.equal(plan.status, tpv2.STATUS.REJECTED, 'RR below 1.0 must be rejected');
  } else {
    assert.ok(plan.warnings.indexOf('ENTRY_TOO_CLOSE_TO_RESISTANCE') >= 0 || plan.tp1 === null,
      'when RR is not < 1 the entry-too-close guard should still fire');
  }
});

// ===================================================================
// Base scoring / candidate fields are never mutated
// ===================================================================

test('9. shadow attach is a pure no-op when the shadow flag is off', () => {
  const cand = goodCandidate({ daytrade_score: 87, score: 91, status: 'READY_BREAKOUT', confirmed_rank: 1 });
  const before = JSON.parse(JSON.stringify(cand));
  integration.attachShadowTradePlanV2(cand, { screener_type: 'DAY_TRADE', env: {} });
  assert.deepEqual(cand, before, 'candidate must be byte-identical when the shadow flag is off');
  assert.equal(cand.trade_plan_v2, undefined, 'no shadow field added while the flag is off');
});

test('10. shadow attach never mutates any scoring/ranking/eligibility field', () => {
  const cand = goodCandidate({ daytrade_score: 87, score: 91, status: 'READY_BREAKOUT', confirmed_rank: 1, confidence: 'A+' });
  const scoringBefore = {
    daytrade_score: cand.daytrade_score, score: cand.score, status: cand.status,
    confirmed_rank: cand.confirmed_rank, confidence: cand.confidence,
    entry_low: cand.entry_low, entry_high: cand.entry_high, stop_loss: cand.stop_loss,
    tp1: cand.tp1, tp2: cand.tp2, risk_reward: cand.risk_reward
  };
  integration.attachShadowTradePlanV2(cand, { screener_type: 'DAY_TRADE', env: { TRADE_PLAN_V2_SHADOW_ENABLED: 'true' } });
  for (const k of Object.keys(scoringBefore)) {
    assert.equal(cand[k], scoringBefore[k], 'scoring/level field ' + k + ' must be untouched by the shadow attach');
  }
  assert.equal(cand.trade_plan_v2.plan_version, 'trade-plan-v2', 'shadow plan attached when the flag is on');
  assert.equal(cand.trade_plan_v2_shadow, true);
});

// ===================================================================
// Liquidity-sweep delayed exit stays disabled publicly
// ===================================================================

test('11. production trailing is ATR ratcheting; liquidity-sweep delayed exit is disabled', () => {
  const plan = planFor(goodCandidate());
  const trailing = integration.buildProductionTrailing(plan);
  assert.equal(trailing.delayed_exit_enabled, false, 'liquidity-sweep delayed exit must never be enabled in production');
  assert.equal(trailing.liquidity_sweep_shadow_only, true);
  assert.equal(trailing.non_decreasing, true, 'production trailing must be non-decreasing');
  assert.ok(trailing.emergency_stop != null, 'emergency structural stop is always active');
  assert.match(plan.trailing_method, /ratcheting/i, 'trailing method must be the ATR ratcheting stop');
  assert.match(plan.trailing_method, /\+1R or TP1/i, 'trailing activates at +1R or TP1');
});

test('12. even with the sweep shadow flag on, public selection falls back when RR is below the profile minimum', () => {
  const env = { TRADE_PLAN_V2_PUBLIC_ENABLED: 'true', TRADE_PLAN_V2_LIQUIDITY_SWEEP_SHADOW_ENABLED: 'true' };
  // Sub-minimum RR candidate: resistance too close, so TP1 is capped below 1.0R.
  const subMinCand = goodCandidate({ resistance: 9680, next_resistance: 9700 });
  const resolved = integration.resolvePublicTradePlan(subMinCand, { channel: 'web', mode: 'daytrade', env });
  assert.equal(resolved.source, 'legacy_fallback', 'sub-minimum RR must fall back');
  const plan = planFor(subMinCand);
  assert.equal(integration.buildProductionTrailing(plan).delayed_exit_enabled, false);
  assert.equal(integration.buildProductionTrailing(plan).liquidity_sweep_shadow_only, true);
});

// ===================================================================
// Legacy fallback
// ===================================================================

test('13. public channel falls back to legacy when the V2 plan is rejected', () => {
  const env = { TRADE_PLAN_V2_PUBLIC_ENABLED: 'true' };
  // Excessively wide SL => V2 rejected => fallback to legacy.
  const cand = goodCandidate({ support: 8800, swing_low: 8700, stop_loss: 8600 });
  const resolved = integration.resolvePublicTradePlan(cand, { channel: 'web', mode: 'daytrade', env });
  assert.equal(resolved.source, 'legacy_fallback');
  assert.equal(resolved.fallback, true);
  assert.equal(resolved.payload.stop_loss, 8600, 'fallback payload must be the legacy plan');
});

test('14. public channel falls back to legacy when mandatory V2 data is missing', () => {
  const env = { TRADE_PLAN_V2_PUBLIC_ENABLED: 'true' };
  // No support / swing low => no structural level => V2 cannot be built.
  const cand = { ticker: 'X', entry_low: 1000, entry_high: 1010, resistance: 1080, tp1: 1075, stop_loss: 980, risk_reward: 1.8 };
  const resolved = integration.resolvePublicTradePlan(cand, { channel: 'telegram', mode: 'daytrade', env });
  assert.equal(resolved.source, 'legacy_fallback');
  assert.equal(resolved.payload.stop_loss, 980);
});

// ===================================================================
// Web / Telegram parity
// ===================================================================

test('15. public selection falls back for sub-minimum RR across all screener profiles', () => {
  const env = { TRADE_PLAN_V2_PUBLIC_ENABLED: 'true' };
  // A candidate with resistance so close that TP1 is capped below the profile
  // minimum RR for each screener type.
  const subMinCand = goodCandidate({ resistance: 9680, next_resistance: 9700 });
  for (const screener of ['DAY_TRADE', 'SWING_NON_KONGLO', 'SWING_KONGLO']) {
    const web = integration.resolvePublicTradePlan(subMinCand, { channel: 'web', screener_type: screener, env });
    const tg = integration.resolvePublicTradePlan(subMinCand, { channel: 'telegram', screener_type: screener, env });
    assert.equal(web.source, 'legacy_fallback', screener + ' should reject sub-minimum RR');
    assert.equal(tg.source, 'legacy_fallback', screener + ' Telegram should reject sub-minimum RR');
  }
});

test('16. replay preview reports byte-equal web/telegram parity for a batch', () => {
  const report = replay.replayCandidates({
    candidates: [goodCandidate(), goodCandidate({ ticker: 'BBRI', entry_low: 4500, entry_high: 4550, support: 4400, swing_low: 4350, resistance: 4900, next_resistance: 5100, atr14: 60, tp1: 4850, stop_loss: 4300 })],
    screener_type: 'DAY_TRADE'
  });
  assert.equal(report.status, 'success');
  assert.equal(report.summary.web_telegram_parity_ok, true, 'parity failures: ' + JSON.stringify(report.summary.parity_failures));
  assert.equal(report.safety.telegram_sent, false);
  assert.equal(report.safety.supabase_writes, false);
  assert.equal(report.safety.public_output_changed, false);
});

// ===================================================================
// Public flag false preserves current public output
// ===================================================================

test('17. resolvePublicTradePlan returns the legacy plan unchanged while the public flag is false', () => {
  const cand = goodCandidate();
  const legacy = integration.buildLegacyTradePlan(cand);
  for (const channel of ['web', 'telegram']) {
    const resolved = integration.resolvePublicTradePlan(cand, { channel, mode: 'daytrade', env: {} });
    assert.equal(resolved.source, 'legacy');
    assert.equal(resolved.public_v2_enabled, false);
    assert.deepEqual(resolved.payload, legacy, channel + ' must return the legacy plan unchanged');
  }
});

test('18. the Telegram signal card is byte-identical while the public flag is false', () => {
  const prev = process.env.TRADE_PLAN_V2_PUBLIC_ENABLED;
  delete process.env.TRADE_PLAN_V2_PUBLIC_ENABLED;
  try {
    const row = { ticker: 'BBCA', entry_low: 9405, entry_high: 9595, tp1: 9785, tp2: 10070, stop_loss: 9215, risk_reward: 1.8, last_price: 9500, status: 'READY_BREAKOUT' };
    const card = templates.formatSignalCard(row, 1, 'daytrade');
    assert.ok(card.indexOf('Risk/Reward:') >= 0, 'legacy Risk/Reward line preserved');
    assert.ok(card.indexOf('trade-plan-v2') === -1, 'V2 plan version must not leak into public output');
    assert.ok(card.indexOf('SL Reason:') === -1, 'V2-only SL reason line must not appear');
  } finally {
    if (prev === undefined) delete process.env.TRADE_PLAN_V2_PUBLIC_ENABLED;
    else process.env.TRADE_PLAN_V2_PUBLIC_ENABLED = prev;
  }
});

test('19. the Telegram signal card falls back when the enabled V2 plan fails minimum RR', () => {
  const prev = process.env.TRADE_PLAN_V2_PUBLIC_ENABLED;
  process.env.TRADE_PLAN_V2_PUBLIC_ENABLED = 'true';
  try {
    // Sub-minimum candidate: resistance too close => RR below 1.0.
    const subMinCand = goodCandidate({ resistance: 9680, next_resistance: 9700 });
    const card = templates.formatSignalCard(subMinCand, 1, 'daytrade');
    assert.ok(card.indexOf('trade-plan-v2') === -1, 'sub-minimum V2 plan must not be shown');
    assert.ok(card.indexOf('Risk/Reward:') >= 0, 'legacy fallback card remains visible');
  } finally {
    if (prev === undefined) delete process.env.TRADE_PLAN_V2_PUBLIC_ENABLED;
    else process.env.TRADE_PLAN_V2_PUBLIC_ENABLED = prev;
  }
});

test('20. decorateRowsForWeb is a no-op while the public flag is false', () => {
  const rows = [goodCandidate()];
  const out = integration.decorateRowsForWeb(rows, { mode: 'daytrade', env: {} });
  assert.equal(out, rows, 'same array reference returned');
  assert.equal(rows[0].trade_plan_public, undefined, 'no public plan field added while the flag is off');
});

test('21. decorateRowsForWeb attaches the legacy fallback when enabled V2 fails minimum RR', () => {
  // Sub-minimum candidate: resistance too close => RR below 1.0.
  const rows = [goodCandidate({ resistance: 9680, next_resistance: 9700 })];
  integration.decorateRowsForWeb(rows, { mode: 'daytrade', env: { TRADE_PLAN_V2_PUBLIC_ENABLED: 'true' } });
  assert.ok(rows[0].trade_plan_public, 'public plan attached when the flag is on');
  assert.equal(rows[0].trade_plan_public_source, 'legacy_fallback');
  assert.equal(rows[0].trade_plan_public.stop_loss, rows[0].stop_loss);
});

// ===================================================================
// Profiles
// ===================================================================

test('22. the three screener profiles keep their SL buffer and min RR', () => {
  assert.equal(tpv2.SCREENER_PROFILES.DAY_TRADE.volatility_buffer_atr, 0.50);
  assert.equal(tpv2.SCREENER_PROFILES.DAY_TRADE.min_rr_to_tp1, 1.00);
  assert.equal(tpv2.SCREENER_PROFILES.SWING_NON_KONGLO.volatility_buffer_atr, 0.75);
  assert.equal(tpv2.SCREENER_PROFILES.SWING_NON_KONGLO.min_rr_to_tp1, 1.20);
  assert.equal(tpv2.SCREENER_PROFILES.SWING_KONGLO.volatility_buffer_atr, 1.00);
  assert.equal(tpv2.SCREENER_PROFILES.SWING_KONGLO.min_rr_to_tp1, 1.20);
});

test('23. mode aliases map to the correct canonical screener type', () => {
  assert.equal(integration.resolveScreenerType('daytrade'), 'DAY_TRADE');
  assert.equal(integration.resolveScreenerType('swing'), 'SWING_KONGLO');
  assert.equal(integration.resolveScreenerType('swing_konglo'), 'SWING_KONGLO');
  assert.equal(integration.resolveScreenerType('swing_non_konglo'), 'SWING_NON_KONGLO');
  assert.equal(integration.resolveScreenerType('nonkonglo'), 'SWING_NON_KONGLO');
});

// ===================================================================
// Safety / rollout invariants
// ===================================================================

test('24. both rollout flags default to false', () => {
  assert.equal(flags.isShadowEnabled({}), false);
  assert.equal(flags.isPublicEnabled({}), false);
  assert.equal(flags.isLiquiditySweepShadowEnabled({}), false);
});

test('25. the API surface remains exactly 12 endpoints', () => {
  const apiFiles = fs.readdirSync(path.join(ROOT, 'api')).filter((f) => f.endsWith('.js'));
  assert.equal(apiFiles.length, 12, 'API endpoint count must stay 12: ' + apiFiles.join(', '));
});

test('26. the pipelines and presentation are wired through the shared integration seam', () => {
  const engine = fs.readFileSync(path.join(ROOT, 'lib', 'daytrade-screener-engine.js'), 'utf8');
  const sectorHot = fs.readFileSync(path.join(ROOT, 'api', 'sector-hot.js'), 'utf8');
  const tg = fs.readFileSync(path.join(ROOT, 'lib', 'telegram-templates.js'), 'utf8');

  // Day Trade pipeline attaches the shadow plan.
  assert.match(engine, /attachShadowTradePlanV2/, 'Day Trade engine must attach the shadow plan');
  // Both swing pipelines attach the shadow plan (Konglo + Non-Konglo).
  assert.ok((sectorHot.match(/attachShadowTradePlanV2/g) || []).length >= 2, 'both swing pipelines must attach the shadow plan');
  assert.match(sectorHot, /SWING_KONGLO/, 'Konglo pipeline wired');
  assert.match(sectorHot, /SWING_NON_KONGLO/, 'Non-Konglo pipeline wired');
  // Web reads decorated through the selector.
  assert.ok((sectorHot.match(/decorateRowsForWeb/g) || []).length >= 3, 'all three web reads must be decorated');
  // Telegram presentation routes through the selector.
  assert.match(tg, /resolvePublicTradePlan/, 'Telegram card must route through the public selector');
});



// ===================================================================
// Regression: public flag false keeps current public output unchanged
// ===================================================================

test('27. public flag false keeps current public output unchanged for a V2-usable candidate', () => {
  const cand = goodCandidate();
  const resolved = integration.resolvePublicTradePlan(cand, { channel: 'web', mode: 'daytrade', env: {} });
  assert.equal(resolved.source, 'legacy');
  assert.equal(resolved.public_v2_enabled, false);
  assert.equal(resolved.payload.plan_version, 'legacy');
});

// ===================================================================
// Regression: web / Telegram parity for usable V2 candidates
// ===================================================================

test('28. web and Telegram produce identical canonical numbers for usable V2 candidates', () => {
  const env = { TRADE_PLAN_V2_PUBLIC_ENABLED: 'true' };
  const cand = goodCandidate();
  const web = integration.resolvePublicTradePlan(cand, { channel: 'web', mode: 'daytrade', env });
  const tg = integration.resolvePublicTradePlan(cand, { channel: 'telegram', mode: 'daytrade', env });
  assert.equal(web.source, 'trade_plan_v2');
  assert.equal(tg.source, 'trade_plan_v2');
  // Both channels carry identical canonical numbers.
  const webC = web.payload.canonical;
  const tgC = tg.payload.canonical;
  for (const f of ['entry_zone_low', 'entry_zone_high', 'stop_loss', 'tp1', 'tp2', 'rr_to_tp1', 'rr_to_tp2', 'trailing_activation', 'minimum_rr_to_tp1']) {
    assert.equal(webC[f], tgC[f], 'parity field ' + f + ' web=' + webC[f] + ' tg=' + tgC[f]);
  }
});

test('29. API JavaScript count remains exactly 12', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const apiFiles = fs.readdirSync(path.join(__dirname, '..', 'api')).filter((f) => f.endsWith('.js'));
  assert.equal(apiFiles.length, 12, 'API endpoint count must stay 12: ' + apiFiles.join(', '));
});
