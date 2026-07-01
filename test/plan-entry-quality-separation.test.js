'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const idx = require('../lib/idx-tick-normalization');
const sectorHot = require('../api/sector-hot');

const { candidatePassesPublicTelegramSafetyGate } = sectorHot.__test;

function base(overrides) {
  return Object.assign({
    ticker: 'BBRI',
    category: 'Day Trade',
    mode: 'daytrade',
    current_price: 1010,
    last_price: 1010,
    entry_low: 1000,
    entry_high: 1020,
    entry1: 1000,
    entry2: 1020,
    stop_loss: 970,
    sl: 970,
    tp1: 1080,
    tp1n: 1080,
    target_1: 1080,
    tp2: 1140,
    tp2n: 1140,
    target_2: 1140,
    risk_reward: 1.8,
    rr_minimum: 1.2,
    risk_label: 'Low Risk',
    liquidity_label: 'Liquid',
    volume_confirmation_label: 'Volume kuat',
    value_today: 20000000000,
    volume_ratio_20d: 1.4,
    signal_action_label: 'Watchlist',
    telegram_verdict: 'Watchlist — tunggu konfirmasi.'
  }, overrides || {});
}

function normalized(overrides) {
  const candidate = base(overrides);
  const sanity = idx.validateTradingPlanSanity(candidate);
  const plan = idx.derivePlanQuality(Object.assign({}, candidate, sanity));
  if (!sanity.trading_plan_valid) {
    plan.plan_quality_status = 'INVALID';
    plan.plan_quality_label = 'Wait / Level belum rapi';
    plan.plan_quality_note = sanity.trading_plan_note;
  }
  return Object.assign({}, candidate, sanity, plan, idx.deriveEntryStatus(candidate));
}

function withVerdict(overrides) {
  const candidate = normalized(overrides);
  return Object.assign(candidate, idx.deriveSignalVerdict(candidate));
}

test('plan valid and entry good stay distinguishable and not plan/entry avoided', () => {
  const r = withVerdict();
  assert.equal(r.trading_plan_valid, true);
  assert.match(r.plan_quality_status, /^(OK|VALID)$/);
  assert.equal(r.entry_quality_status, 'IN_ENTRY_AREA');
  assert.notEqual(r.signal_action_label, 'Hindari');
});

test('plan valid does not override chase/extended entry risk', () => {
  const r = withVerdict({ current_price: 1075, last_price: 1075 });
  assert.equal(r.trading_plan_valid, true);
  assert.match(r.plan_quality_status, /^(OK|VALID)$/);
  assert.match(r.entry_quality_status, /^(CHASE_RISK|EXTENDED|TP1_NEAR)$/);
  assert.notEqual(r.signal_action, 'ENTRY_AREA');
  assert.equal(candidatePassesPublicTelegramSafetyGate(r, 'daytrade'), false);
});

test('entry good does not override invalid plan levels', () => {
  const r = withVerdict({ entry_low: 1001, entry1: 1001 });
  assert.equal(r.trading_plan_valid, false);
  assert.equal(r.plan_quality_status, 'INVALID');
  assert.equal(r.entry_quality_status, 'IN_ENTRY_AREA');
  assert.notEqual(r.signal_action, 'ENTRY_AREA');
  assert.equal(candidatePassesPublicTelegramSafetyGate(r, 'daytrade'), false);
});

test('poor RR blocks entry-ready while preserving entry quality', () => {
  const r = withVerdict({ risk_reward: 0.8 });
  assert.equal(r.trading_plan_valid, true);
  assert.equal(r.plan_quality_status, 'POOR_RR');
  assert.equal(r.entry_quality_status, 'IN_ENTRY_AREA');
  assert.notEqual(r.signal_action, 'ENTRY_AREA');
  assert.equal(candidatePassesPublicTelegramSafetyGate(r, 'daytrade'), false);
});

test('stale setup keeps structural fields but public Telegram blocks freshness risk', () => {
  const r = withVerdict({ is_stale: true, setup_freshness_status: 'NEEDS_REVALIDATION' });
  assert.equal(r.trading_plan_valid, true);
  assert.match(r.plan_quality_status, /^(OK|VALID)$/);
  assert.equal(r.entry_quality_status, 'NEEDS_REVALIDATION');
  assert.equal(candidatePassesPublicTelegramSafetyGate(r, 'daytrade'), false);
});
