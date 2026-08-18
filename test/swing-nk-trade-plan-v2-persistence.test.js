'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sectorHot = require('../api/sector-hot');
const integration = require('../lib/trade-plan-v2-integration');
const hooks = sectorHot.__test;

function usablePlan() {
  return {
    plan_version: 'trade-plan-v2', status: 'OK', ticker: 'TEST',
    entry_zone_low: 100, entry_zone_high: 102, support: 95, resistance: 120,
    stop_loss: 92, stop_anchor_price: 95, stop_anchor_type: 'MAJOR_SUPPORT',
    stop_loss_reason: 'MAJOR_SUPPORT (95) minus volatility buffer',
    tp1: 116, tp2: 130, tp1_anchor_type: 'MAJOR_RESISTANCE', rr_to_tp1: 1.5,
    trailing_activation: 110, trailing_reference: 'ENTRY_PLUS_1R',
    trailing_method: 'ATR_RATCHET', trailing_atr_multiplier: 1.5, emergency_stop: 90,
    data_freshness: { is_stale: false }, profile: { min_rr_to_tp1: 1.2 }, warnings: []
  };
}

function sourceRow() {
  return {
    ticker: 'TEST', board: 'UTAMA', run_date: '2026-08-18', last_price: 101,
    entry_low: 100, entry_high: 102, stop_loss: 92, tp1: 116, tp2: 130,
    support: 95, resistance: 120, risk_reward: 1.5, score: 80,
    trade_plan_v2: usablePlan(),
    trade_plan_v2_structural: {
      screener_type: 'SWING_NON_KONGLO',
      source_fields: ['support', 'resistance', 'atr14', 'observations'], available: true
    }
  };
}

test('Swing NK persistence schema allowlists canonical V2 snapshot fields', () => {
  assert.ok(hooks.nkStagingColumns.includes('trade_plan_v2'));
  assert.ok(hooks.nkStagingColumns.includes('trade_plan_v2_structural'));
  assert.ok(hooks.nkLatestColumns.includes('trade_plan_v2'));
  assert.ok(hooks.nkLatestColumns.includes('trade_plan_v2_structural'));
});

test('Swing NK staging/latest sanitizers preserve canonical V2 snapshot', () => {
  const src = sourceRow();
  const staged = hooks.sanitizeNkStagingRow(src);
  assert.deepEqual(staged.trade_plan_v2, src.trade_plan_v2);
  assert.deepEqual(staged.trade_plan_v2_structural, src.trade_plan_v2_structural);
  const published = hooks.sanitizeNkLatestPublishRow({ ...staged, rank: 1 });
  assert.deepEqual(published.trade_plan_v2, src.trade_plan_v2);
  assert.deepEqual(published.trade_plan_v2_structural, src.trade_plan_v2_structural);
});

test('persisted Swing NK row resolves Telegram presentation as V2', () => {
  const staged = hooks.sanitizeNkStagingRow(sourceRow());
  const published = hooks.sanitizeNkLatestPublishRow({ ...staged, rank: 1 });
  const resolved = integration.resolvePublicTradePlan(published, {
    channel: 'telegram', mode: 'swing_non_konglo',
    env: { TRADE_PLAN_V2_PUBLIC_ENABLED: 'true' }
  });
  assert.equal(resolved.source, 'trade_plan_v2');
  assert.equal(resolved.fallback, false);
  assert.equal(resolved.payload.canonical.plan_version, 'trade-plan-v2');
  assert.equal(resolved.payload.canonical.support, 95);
  assert.equal(resolved.payload.canonical.resistance, 120);
});
