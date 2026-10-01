'use strict';

/**
 * Intraday Plan-Lock Rollout Decoupling tests
 * ===========================================
 *
 * Proves that the internal intraday plan-lock is DECOUPLED from the public
 * website / Telegram V2 rollout:
 *
 *   - public presentation is governed ONLY by TRADE_PLAN_V2_PUBLIC_ENABLED;
 *   - the intraday collector locks V2 ONLY via the dedicated
 *     TRADE_PLAN_V2_INTRADAY_LOCK_ENABLED (+ TRADE_PLAN_V2_SHADOW_ENABLED) flags,
 *     in the 'intraday_shadow' selection context;
 *   - the two flags never cross-enable each other;
 *   - the same canonical field contract + plan_lock_id are preserved.
 *
 * Named outside the `trade-plan-v2*` glob so the baseline 177 Trade Plan V2 test
 * count guard stays exact.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const integration = require('../lib/trade-plan-v2-integration');
const flags = require('../lib/trade-plan-v2-flags');
const collector = require('../tools/intraday-sample-collector');

// Environment matrices.
const INTRADAY_ONLY = { TRADE_PLAN_V2_INTRADAY_LOCK_ENABLED: 'true', TRADE_PLAN_V2_SHADOW_ENABLED: 'true' };
const PUBLIC_ONLY = { TRADE_PLAN_V2_PUBLIC_ENABLED: 'true' };
const INTRADAY_NO_SHADOW = { TRADE_PLAN_V2_INTRADAY_LOCK_ENABLED: 'true' };
const OFF = {};

function usableCandidate(extra) {
  return Object.assign({
    ticker: 'BBCA',
    entry_low: 9400, entry_high: 9450,
    support: 9300, swing_low: 9250,
    resistance: 9900, next_resistance: 10200,
    atr14: 120, last_price: 9440, current_price: 9440,
    tp1: 9850, tp2: 10200, stop_loss: 9200, risk_reward: 2.1
  }, extra || {});
}

function rejectedCandidate(extra) {
  // No structural inputs => V2 is not usable; legacy fallback must be locked.
  return Object.assign({
    ticker: 'GOTO', entry_low: 100, entry_high: 102,
    tp1: 110, tp2: 120, stop_loss: 95, risk_reward: 2.0
  }, extra || {});
}

test('D0. the new flag defaults to false and is truthy only for explicit values', () => {
  assert.equal(flags.isIntradayLockEnabled({}), false, 'default must be false');
  assert.equal(flags.isIntradayLockEnabled({ TRADE_PLAN_V2_INTRADAY_LOCK_ENABLED: 'false' }), false);
  assert.equal(flags.isIntradayLockEnabled({ TRADE_PLAN_V2_INTRADAY_LOCK_ENABLED: '0' }), false);
  assert.equal(flags.isIntradayLockEnabled({ TRADE_PLAN_V2_INTRADAY_LOCK_ENABLED: 'true' }), true);
  assert.equal(flags.isIntradayLockEnabled({ TRADE_PLAN_V2_INTRADAY_LOCK_ENABLED: '1' }), true);
  // The all-flags snapshot documents the new safe default without breaking the
  // original two-flag getFlags() contract.
  const all = flags.getAllFlags({});
  assert.equal(all.defaults.TRADE_PLAN_V2_INTRADAY_LOCK_ENABLED, false);
  assert.equal(Object.prototype.hasOwnProperty.call(flags.getFlags({}).defaults, 'TRADE_PLAN_V2_INTRADAY_LOCK_ENABLED'), false);
});

test('D1. public=false + intraday_lock=true + shadow=true: web & Telegram legacy, intraday locks usable V2', () => {
  const cand = usableCandidate();
  assert.equal(flags.isPublicEnabled(INTRADAY_ONLY), false, 'public must remain OFF');

  // Public presentation (both channels) must remain LEGACY — the intraday lock
  // does not touch the public rollout.
  const web = integration.resolvePublicTradePlan(cand, { channel: 'web', env: INTRADAY_ONLY, screener_type: 'DAY_TRADE' });
  const tg = integration.resolvePublicTradePlan(cand, { channel: 'telegram', env: INTRADAY_ONLY, screener_type: 'DAY_TRADE' });
  assert.equal(web.source, 'legacy');
  assert.equal(web.public_v2_enabled, false);
  assert.equal(tg.source, 'legacy');
  assert.equal(tg.public_v2_enabled, false);

  // The canonical public selection is likewise legacy.
  const pub = integration.selectCanonicalTradePlan(cand, { selection_mode: 'public', env: INTRADAY_ONLY, screener_type: 'DAY_TRADE' });
  assert.equal(pub.source, 'legacy');
  assert.equal(pub.public_v2_enabled, false);

  // The intraday collector LOCKS the validated V2 plan under the same env.
  const rec = collector.buildCandidateRecord(cand, '09:15', 1, null, '2026-07-23', INTRADAY_ONLY);
  assert.equal(rec.trade_plan_source, 'trade_plan_v2');
  assert.ok(rec.selected_trade_plan.emergency_stop != null);
});

test('D2. intraday_lock=true + usable V2: source is trade_plan_v2 and entry/SL/emergency SL/TP1/TP2 match V2 exactly', () => {
  const cand = usableCandidate();
  const planV2 = integration.buildCandidatePlanV2(cand, { screener_type: 'DAY_TRADE' });
  assert.equal(integration.isPlanV2Usable(planV2), true, 'the V2 plan must be usable for this test');

  const rec = collector.buildCandidateRecord(cand, '09:15', 1, null, '2026-07-23', INTRADAY_ONLY);
  const p = rec.selected_trade_plan;
  assert.equal(rec.trade_plan_source, 'trade_plan_v2');
  // Every locked number is read VERBATIM from the canonical V2 plan.
  assert.equal(p.entry_zone_low, planV2.entry_zone_low);
  assert.equal(p.entry_zone_high, planV2.entry_zone_high);
  assert.equal(p.stop_loss, planV2.stop_loss);
  assert.equal(p.emergency_stop, planV2.emergency_stop);
  assert.equal(p.tp1, planV2.tp1);
  assert.equal(p.tp2, planV2.tp2);
});

test('D3. intraday_lock=true + rejected V2: source is legacy_fallback and complete legacy values are locked', () => {
  const cand = rejectedCandidate();
  const planV2 = integration.buildCandidatePlanV2(cand, { screener_type: 'DAY_TRADE' });
  assert.equal(integration.isPlanV2Usable(planV2), false, 'the V2 plan must be unusable for this test');

  const rec = collector.buildCandidateRecord(cand, '09:15', 1, null, '2026-07-23', INTRADAY_ONLY);
  const p = rec.selected_trade_plan;
  assert.equal(rec.trade_plan_source, 'legacy_fallback');
  // COMPLETE legacy values — never null SL/TP.
  assert.equal(p.entry_zone_low, 100);
  assert.equal(p.entry_zone_high, 102);
  assert.equal(p.stop_loss, 95);
  assert.equal(p.tp1, 110);
  assert.equal(p.tp2, 120);
  // Legacy carries no structural anchors — never fabricated.
  assert.equal(p.emergency_stop, null);
  assert.equal(p.stop_anchor_type, null);
});

test('D4. intraday_lock=false: collector retains current safe legacy behavior', () => {
  const cand = usableCandidate();
  const rec = collector.buildCandidateRecord(cand, '09:15', 1, null, '2026-07-23', OFF);
  assert.equal(rec.trade_plan_source, 'legacy');
  assert.equal(rec.selected_trade_plan.stop_loss, 9200); // unchanged legacy SL
  // Direct selector call in intraday_shadow mode with the flag off => legacy.
  const sel = integration.selectCanonicalTradePlan(cand, { selection_mode: 'intraday_shadow', env: OFF, screener_type: 'DAY_TRADE' });
  assert.equal(sel.source, 'legacy');
});

test('D5. public=true does NOT auto-enable intraday V2 when intraday_lock=false', () => {
  const cand = usableCandidate();
  // Public channels DO show V2 (public flag on + usable plan) ...
  const pub = integration.selectCanonicalTradePlan(cand, { selection_mode: 'public', env: PUBLIC_ONLY, screener_type: 'DAY_TRADE' });
  assert.equal(pub.source, 'trade_plan_v2');
  // ... but the intraday_shadow context stays LEGACY because the intraday-lock
  // flag is off. The public flag must not leak into intraday locking.
  const shadow = integration.selectCanonicalTradePlan(cand, { selection_mode: 'intraday_shadow', env: PUBLIC_ONLY, screener_type: 'DAY_TRADE' });
  assert.equal(shadow.source, 'legacy');
  // The collector (intraday_shadow) likewise stays legacy under public-only env.
  const rec = collector.buildCandidateRecord(cand, '09:15', 1, null, '2026-07-23', PUBLIC_ONLY);
  assert.equal(rec.trade_plan_source, 'legacy');
});

test('D6. intraday_lock=true does NOT enable public web or Telegram V2 when public=false', () => {
  const cand = usableCandidate();
  // Public selection + both presentation channels stay legacy.
  const pub = integration.selectCanonicalTradePlan(cand, { selection_mode: 'public', env: INTRADAY_ONLY, screener_type: 'DAY_TRADE' });
  assert.equal(pub.source, 'legacy');
  assert.equal(pub.public_v2_enabled, false);
  const web = integration.resolvePublicTradePlan(cand, { channel: 'web', env: INTRADAY_ONLY, screener_type: 'DAY_TRADE' });
  const tg = integration.resolvePublicTradePlan(cand, { channel: 'telegram', env: INTRADAY_ONLY, screener_type: 'DAY_TRADE' });
  assert.equal(web.source, 'legacy');
  assert.equal(tg.source, 'legacy');
  // Even the internally-locked intraday V2 record must not advertise public V2.
  const rec = collector.buildCandidateRecord(cand, '09:15', 1, null, '2026-07-23', INTRADAY_ONLY);
  assert.equal(rec.trade_plan_source, 'trade_plan_v2');
  assert.equal(rec.selected_trade_plan.public_v2_enabled, undefined,
    'the locked intraday record does not carry a public_v2_enabled=true signal');
});

test('D7. intraday_shadow requires BOTH the intraday-lock flag AND the shadow flag', () => {
  const cand = usableCandidate();
  // Lock on but shadow off => legacy (V2 must not be locked without shadow).
  const noShadow = integration.selectCanonicalTradePlan(cand, { selection_mode: 'intraday_shadow', env: INTRADAY_NO_SHADOW, screener_type: 'DAY_TRADE' });
  assert.equal(noShadow.source, 'legacy');
  // Both on => V2.
  const both = integration.selectCanonicalTradePlan(cand, { selection_mode: 'intraday_shadow', env: INTRADAY_ONLY, screener_type: 'DAY_TRADE' });
  assert.equal(both.source, 'trade_plan_v2');
});

test('D8. the canonical field contract + plan_lock_id are preserved across contexts', () => {
  const cand = usableCandidate();
  // Same usable plan, selected publicly (public on) vs intraday_shadow (lock on):
  // the canonical numeric contract is identical and the deterministic lock id
  // derived from it matches.
  const pub = integration.selectCanonicalTradePlan(cand, { selection_mode: 'public', env: PUBLIC_ONLY, screener_type: 'DAY_TRADE' });
  const shadow = integration.selectCanonicalTradePlan(cand, { selection_mode: 'intraday_shadow', env: INTRADAY_ONLY, screener_type: 'DAY_TRADE' });
  for (const f of ['entry_zone_low', 'entry_zone_high', 'stop_loss', 'emergency_stop', 'tp1', 'tp2', 'rr_to_tp1']) {
    assert.equal(shadow[f], pub[f], 'canonical field must match across contexts: ' + f);
  }
  const idArgs = (c) => ({
    screener_type: 'DAY_TRADE', ticker: cand.ticker, trading_date: '2026-07-23',
    source: c.source, entry_zone_low: c.entry_zone_low, entry_zone_high: c.entry_zone_high,
    stop_loss: c.stop_loss, emergency_stop: c.emergency_stop, tp1: c.tp1, tp2: c.tp2
  });
  assert.equal(integration.computePlanLockId(idArgs(pub)), integration.computePlanLockId(idArgs(shadow)));
});
