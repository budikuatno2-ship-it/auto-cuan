'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const idxTick = require('../lib/idx-tick-normalization');
const sectorHot = require('../api/sector-hot');

const { candidatePassesPublicTelegramSafetyGate, formatCandidateBlock } = sectorHot.__test;

function daytrade(overrides) {
  return Object.assign({
    ticker: 'TEST', category: 'Day Trade', status: 'READY', setup: 'Signal', risk_label: 'Low Risk',
    risk_reward: 1.8, entry1: 100, entry2: 102, sl: 96, tp1n: 106, tp2n: 110,
    tp1_upside: 4, last_price: 101, value_today: 20000000000, volume_ratio_20d: 1.3,
    liquidity_label: 'Liquid', trading_plan_valid: true, plan_quality_status: 'VALID',
    entry_quality_status: 'IN_ENTRY_AREA', entry_status: 'IN_ENTRY_AREA', telegram_verdict: 'Watchlist'
  }, overrides || {});
}

test('entry or trigger near ARA is not realistic for public actionable buy', () => {
  const r = idxTick.deriveCandlePotentialRange({ previous_close: 100, last_price: 120, entry_high: 132, breakout_trigger: 132, tp1: 134, stop_loss: 116 });
  assert.equal(r.execution_reality_status, 'NEAR_ARA');
  assert.equal(r.entry_near_ara, true);
  assert.equal(r.trigger_near_ara, true);
  assert.equal(r.buy_execution_realistic, false);
  assert.equal(candidatePassesPublicTelegramSafetyGate(daytrade(r), 'daytrade'), false);
});

test('price touching ARA is blocked as execution reality risk', () => {
  const r = idxTick.deriveCandlePotentialRange({ previous_close: 100, last_price: 135, tp1: 136, stop_loss: 130 });
  assert.equal(r.execution_reality_status, 'ARA_HIT');
  assert.equal(r.ara_hit, true);
  assert.match(r.execution_reality_label, /rawan ARA/i);
  assert.equal(candidatePassesPublicTelegramSafetyGate(daytrade(r), 'daytrade'), false);
});

test('price near ARB or stop below ARB is conservative and blocked', () => {
  const r = idxTick.deriveCandlePotentialRange({ previous_close: 100, last_price: 87, entry_high: 90, tp1: 94, stop_loss: 84 });
  assert.equal(r.execution_reality_status, 'NEAR_ARB');
  assert.equal(r.near_arb, true);
  assert.equal(r.sl_below_arb, true);
  assert.equal(r.sell_risk_near_arb, true);
  assert.equal(candidatePassesPublicTelegramSafetyGate(daytrade(r), 'daytrade'), false);
});

test('missing previous close or reference price is unknown limits, not safe', () => {
  const r = idxTick.deriveCandlePotentialRange({ last_price: 100, entry_high: 101, tp1: 105, stop_loss: 97 });
  assert.equal(r.execution_reality_status, 'UNKNOWN_LIMITS');
  assert.equal(r.buy_execution_realistic, false);
  assert.equal(candidatePassesPublicTelegramSafetyGate(daytrade(r), 'daytrade'), false);
});

test('normal candidate far from ARA/ARB remains executable', () => {
  const r = idxTick.deriveCandlePotentialRange({ previous_close: 100, last_price: 105, entry_high: 106, breakout_trigger: 108, tp1: 112, tp2: 118, stop_loss: 99 });
  assert.equal(r.execution_reality_status, 'EXECUTABLE');
  assert.equal(r.buy_execution_realistic, true);
  assert.equal(r.near_ara, false);
  assert.equal(r.near_arb, false);
  assert.equal(candidatePassesPublicTelegramSafetyGate(daytrade(r), 'daytrade'), true);
});

test('public ARA/ARB fields are stable and formatter does not leak raw diagnostics', async () => {
  const r = daytrade(idxTick.deriveCandlePotentialRange({ previous_close: 100, last_price: 120, entry_high: 124, tp1: 128, stop_loss: 116 }));
  r.raw_payload = { secret: true };
  r.sample_rejected = [{ ticker: 'BAD' }];
  r.stageByTicker = { TEST: { debug: true } };
  r.debug_notes = 'internal raw diagnostics';
  const text = await formatCandidateBlock(null, r, 1, true);
  assert.equal(typeof r.execution_reality_status, 'string');
  assert.equal(typeof r.execution_reality_label, 'string');
  for (const forbidden of ['raw_payload', 'sample_rejected', 'stageByTicker', 'internal raw diagnostics', '[object Object]']) {
    assert.equal(text.includes(forbidden), false, 'leaked ' + forbidden + '\n' + text);
  }
});
