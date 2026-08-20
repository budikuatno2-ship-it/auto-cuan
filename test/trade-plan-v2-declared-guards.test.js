'use strict';

// Regression for two guards that every SCREENER_PROFILE declares but that no
// code path ever read:
//
//   emergency_max_structural_distance_pct  (30 / 35 / 40)
//   the `tolerance` parameter of isUsableOverheadLevel()
//
// Both were dead configuration. The emergency anchor is deliberately exempt
// from the *normal* budget (max_structural_distance_pct, 12/18/22) — the
// profiles declare a separate, looser emergency cap precisely because the
// intent was a wider bound, not an absent one.

const test = require('node:test');
const assert = require('node:assert/strict');
const tp = require('../lib/trade-plan-v2');

function candidate(overrides) {
  return Object.assign({
    ticker: 'TEST',
    entry_low: 1000,
    entry_high: 1010,
    support: 990,
    swing_low: 990,
    resistance: 1080,
    atr14: 40,
    current_price: 1008
  }, overrides || {});
}

function pctBelowEntry(entryLow, level) {
  return ((entryLow - level) / entryLow) * 100;
}

test('an emergency anchor beyond the profile cap is not used as the emergency stop', () => {
  // major_support 150 sits 85% below entry_low — far past DAY_TRADE's 30% cap.
  const plan = tp.buildTradePlanV2(candidate({ major_support: 150 }), { screener_type: 'DAY_TRADE' });

  assert.ok(
    pctBelowEntry(1000, plan.emergency_stop) <= 30.0,
    'emergency stop ' + plan.emergency_stop + ' is ' +
      pctBelowEntry(1000, plan.emergency_stop).toFixed(1) + '% below entry, past the 30% cap'
  );
});

test('an emergency anchor within the profile cap is still selected', () => {
  // major_support 800 is 20% below entry_low — inside DAY_TRADE's 30% cap and
  // outside its 12% normal budget, which is exactly what the emergency tier is for.
  const plan = tp.buildTradePlanV2(candidate({ major_support: 800 }), { screener_type: 'DAY_TRADE' });

  assert.equal(plan.emergency_anchor_type, tp.SUPPORT_ANCHOR_TYPE.MAJOR_SUPPORT);
  assert.ok(plan.emergency_stop < 800, 'emergency stop sits below the 800 anchor');
});

test('the looser SWING_KONGLO cap admits an anchor that DAY_TRADE rejects', () => {
  // 650 is 35% below entry: past DAY_TRADE's 30% cap, inside SWING_KONGLO's 40%.
  const dayTrade = tp.buildTradePlanV2(candidate({ major_support: 650 }), { screener_type: 'DAY_TRADE' });
  const konglo = tp.buildTradePlanV2(candidate({ major_support: 650 }), { screener_type: 'SWING_KONGLO' });

  assert.notEqual(dayTrade.emergency_anchor_type, tp.SUPPORT_ANCHOR_TYPE.MAJOR_SUPPORT);
  assert.equal(konglo.emergency_anchor_type, tp.SUPPORT_ANCHOR_TYPE.MAJOR_SUPPORT);
});

test('the emergency stop still sits below the normal stop in every case', () => {
  for (const major of [150, 650, 800, 950]) {
    const plan = tp.buildTradePlanV2(candidate({ major_support: major }), { screener_type: 'DAY_TRADE' });
    assert.ok(
      plan.emergency_stop <= plan.stop_loss,
      'major_support ' + major + ': emergency ' + plan.emergency_stop + ' vs stop ' + plan.stop_loss
    );
  }
});

// The cap applies to the anchor that produces a published emergency stop. It
// deliberately does NOT apply to the diagnostic candidate shown on a REJECTED
// plan, where distant structure is the only information the operator gets.
// Tests 35 and 36 in trade-plan-v2.test.js pin the diagnostic side; this pins
// the asymmetry itself so a future change cannot collapse the two by accident.
test('a REJECTED plan still surfaces distant emergency structure for diagnostics', () => {
  const plan = tp.buildTradePlanV2({
    ticker: 'BEEF', entry_low: 310, entry_high: 318, major_support: 122,
    resistance: 400, atr14: 10, current_price: 315
  }, { screener_type: 'DAY_TRADE' });

  assert.equal(plan.status, tp.STATUS.REJECTED);
  assert.ok(pctBelowEntry(310, 122) > 30.0, 'the fixture is deliberately past the cap');
  assert.equal(plan.emergency_anchor_type, tp.SUPPORT_ANCHOR_TYPE.MAJOR_SUPPORT);
  assert.equal(plan.emergency_anchor_price, 122);
});
