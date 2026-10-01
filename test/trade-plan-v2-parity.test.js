'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tp = require('../lib/trade-plan-v2');
const fmt = require('../lib/trade-plan-v2-formatter');
const flags = require('../lib/trade-plan-v2-flags');
const templates = require('../lib/telegram-templates');

function samplePlan(screener) {
  return tp.buildTradePlanV2({
    ticker: 'PARITY',
    entry_low: 1000,
    entry_high: 1010,
    support: 990,
    swing_low: 985,
    resistance: 1080,
    next_resistance: 1150,
    atr14: 20,
    current_price: 1008
  }, {
    screener_type: screener || 'DAY_TRADE',
    breakout_confirmed: true,
    generated_at: '2026-07-22T09:15:00Z'
  });
}

// ===================================================================
// Website / Telegram numeric parity
// ===================================================================

test('1. web and Telegram view-models are numerically identical for the same candidate', () => {
  const plan = samplePlan('DAY_TRADE');
  const web = fmt.buildWebViewModel(plan);
  const tg = fmt.buildTelegramViewModel(plan);
  const diff = fmt.diffViewModels(web, tg);
  assert.equal(diff.equal, true, 'mismatches: ' + JSON.stringify(diff.mismatches));
});

test('2. every required numeric field matches across channels', () => {
  const plan = samplePlan('SWING_KONGLO');
  const web = fmt.buildWebViewModel(plan).canonical;
  const tg = fmt.buildTelegramViewModel(plan).canonical;

  // entry zone
  assert.equal(web.entry_zone_low, tg.entry_zone_low);
  assert.equal(web.entry_zone_high, tg.entry_zone_high);
  // stop loss
  assert.equal(web.stop_loss, tg.stop_loss);
  assert.equal(web.emergency_stop, tg.emergency_stop);
  assert.equal(web.structural_invalidation, tg.structural_invalidation);
  // take profit
  assert.equal(web.tp1, tg.tp1);
  assert.equal(web.tp2, tg.tp2);
  // support & resistance
  assert.equal(web.support, tg.support);
  assert.equal(web.resistance, tg.resistance);
  // trailing method & activation
  assert.equal(web.trailing_activation, tg.trailing_activation);
  assert.equal(web.trailing_method, tg.trailing_method);
  assert.equal(web.trailing_atr_multiplier, tg.trailing_atr_multiplier);
  // risk / reward
  assert.equal(web.risk_amount, tg.risk_amount);
  assert.equal(web.reward_to_tp1, tg.reward_to_tp1);
  assert.equal(web.reward_to_tp2, tg.reward_to_tp2);
  assert.equal(web.rr_to_tp1, tg.rr_to_tp1);
  assert.equal(web.rr_to_tp2, tg.rr_to_tp2);
  // plan version
  assert.equal(web.plan_version, tg.plan_version);
  assert.equal(web.plan_version, 'trade-plan-v2');
});

test('3. the canonical values equal the underlying plan (presentation never recalculates)', () => {
  const plan = samplePlan('DAY_TRADE');
  const c = fmt.extractCanonicalNumbers(plan);
  for (const f of fmt.CANONICAL_NUMERIC_FIELDS.concat(fmt.CANONICAL_LABEL_FIELDS)) {
    assert.equal(c[f], plan[f], 'canonical field ' + f + ' must be copied straight from the plan');
  }
});

test('4. mutating the canonical plan number changes BOTH channels identically', () => {
  // Proves both channels read the same source value rather than deriving it.
  const plan = samplePlan('DAY_TRADE');
  plan.tp1 = 1234; // arbitrary, non-recomputed value
  const web = fmt.buildWebViewModel(plan).canonical;
  const tg = fmt.buildTelegramViewModel(plan).canonical;
  assert.equal(web.tp1, 1234);
  assert.equal(tg.tp1, 1234);
});

test('5. parity holds across all three screener profiles', () => {
  for (const screener of ['DAY_TRADE', 'SWING_NON_KONGLO', 'SWING_KONGLO']) {
    const plan = samplePlan(screener);
    const diff = fmt.diffViewModels(fmt.buildWebViewModel(plan), fmt.buildTelegramViewModel(plan));
    assert.equal(diff.equal, true, screener + ' parity: ' + JSON.stringify(diff.mismatches));
  }
});

// ===================================================================
// Feature flags — safe defaults
// ===================================================================

test('6. feature flags default to false when unset', () => {
  assert.equal(flags.isShadowEnabled({}), false);
  assert.equal(flags.isPublicEnabled({}), false);
  const f = flags.getFlags({});
  assert.equal(f.TRADE_PLAN_V2_SHADOW_ENABLED, false);
  assert.equal(f.TRADE_PLAN_V2_PUBLIC_ENABLED, false);
  assert.deepEqual(f.defaults, { TRADE_PLAN_V2_SHADOW_ENABLED: false, TRADE_PLAN_V2_PUBLIC_ENABLED: false });
});

test('7. only explicit truthy strings enable a flag', () => {
  for (const v of ['true', '1', 'yes', 'on', 'TRUE', 'On']) {
    assert.equal(flags.isShadowEnabled({ TRADE_PLAN_V2_SHADOW_ENABLED: v }), true, v);
  }
  for (const v of ['false', '0', '', 'no', 'off', undefined, null, 'disabled']) {
    assert.equal(flags.isPublicEnabled({ TRADE_PLAN_V2_PUBLIC_ENABLED: v }), false, String(v));
  }
});

// ===================================================================
// Public output stays unchanged while the public flag is false
// ===================================================================

test('8. selectPublicTradePlan returns the LEGACY payload unchanged while public flag is false', () => {
  const plan = samplePlan('DAY_TRADE');
  const legacy = { ticker: 'PARITY', entry1: 1010, entry2: 1000, tp1: 1075, tp2: 1150, sl: 980, source: 'legacy-engine' };
  const web = fmt.selectPublicTradePlan({ legacyPayload: legacy, planV2: plan, channel: 'web', env: {} });
  const tgc = fmt.selectPublicTradePlan({ legacyPayload: legacy, planV2: plan, channel: 'telegram', env: {} });
  assert.equal(web.source, 'legacy');
  assert.equal(web.public_v2_enabled, false);
  assert.deepEqual(web.payload, legacy, 'legacy payload must be returned byte-identical');
  assert.deepEqual(tgc.payload, legacy);
});

test('9. selectPublicTradePlan switches to V2 only when the public flag is explicitly true', () => {
  const plan = samplePlan('DAY_TRADE');
  const legacy = { source: 'legacy-engine' };
  const enabled = fmt.selectPublicTradePlan({ legacyPayload: legacy, planV2: plan, channel: 'web', env: { TRADE_PLAN_V2_PUBLIC_ENABLED: 'true' } });
  assert.equal(enabled.source, 'trade_plan_v2');
  assert.equal(enabled.public_v2_enabled, true);
  assert.equal(enabled.payload.canonical.plan_version, 'trade-plan-v2');
});

test('10. the existing Telegram signal card is unchanged (no V2 leakage) while the flag is false', () => {
  // Render a legacy candidate through the existing public formatter and confirm
  // the shadow trade-plan-v2 content never appears in public output.
  const card = templates.formatSignalCard({
    ticker: 'BBCA', entry_low: 9405, entry_high: 9595, tp1: 9785, tp2: 10070,
    stop_loss: 9215, risk_reward: 1.8, last_price: 9500, status: 'READY_BREAKOUT'
  }, 1, 'daytrade');
  assert.ok(card.indexOf('TRADE PLAN V2') === -1, 'public card must not contain V2 shadow content');
  assert.ok(card.indexOf('Trading Plan') >= 0, 'legacy card structure preserved');
  assert.ok(card.indexOf('Rp9.405') >= 0 || card.indexOf('9.405') >= 0, 'legacy entry rendered');
});

test('11. the shadow Telegram V2 card reads only canonical numbers', () => {
  const plan = samplePlan('DAY_TRADE');
  const card = fmt.formatTelegramTradePlanV2Card(plan);
  assert.ok(card.indexOf('TRADE PLAN V2 · SHADOW') >= 0);
  // The rendered SL string is derived from the canonical stop_loss.
  assert.ok(card.indexOf(String(plan.stop_loss)) >= 0 || card.indexOf(Number(plan.stop_loss).toLocaleString('id-ID')) >= 0);
});
