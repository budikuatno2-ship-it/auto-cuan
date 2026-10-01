'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const integration = require('../lib/trade-plan-v2-integration');

function usablePlan(screenerType) {
  return {
    plan_version: 'trade-plan-v2',
    status: 'OK',
    ticker: 'TEST',
    entry_zone_low: 1000,
    entry_zone_high: 1010,
    support: 970,
    resistance: 1080,
    stop_loss: 955,
    stop_anchor_price: 970,
    stop_anchor_type: 'CONFIRMED_SWING_LOW',
    stop_loss_reason: 'CONFIRMED_SWING_LOW (970) minus volatility buffer',
    tp1: 1060,
    tp2: null,
    tp1_anchor_type: 'MAJOR_RESISTANCE',
    rr_to_tp1: 1.5,
    trailing_activation: 1045,
    trailing_reference: 'ENTRY_PLUS_1R',
    trailing_method: 'ATR_RATCHET',
    trailing_atr_multiplier: 1.0,
    emergency_stop: 930,
    data_freshness: { is_stale: false },
    profile: { min_rr_to_tp1: 1.0 },
    warnings: []
  };
}

test('Day Trade batchRows mapper includes trade_plan_v2 and trade_plan_v2_structural', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'sector-hot.js'), 'utf8');
  const dtStart = source.indexOf('var batchRows = passedResults.map(function(r) {');
  const dtEnd = source.indexOf("from('daytrade_screener_latest').upsert(batchRows", dtStart);
  assert.notEqual(dtStart, -1, 'Day Trade batchRows mapper must exist');
  assert.notEqual(dtEnd, -1, 'Day Trade upsert must exist');
  const dtBlock = source.slice(dtStart, dtEnd);

  assert.match(dtBlock, /trade_plan_v2:\s*r\.trade_plan_v2\s*\|\|\s*null/);
  assert.match(dtBlock, /trade_plan_v2_structural:\s*r\.trade_plan_v2_structural\s*\|\|\s*null/);
});

test('Swing Konglo upsertRows mapper includes trade_plan_v2 and trade_plan_v2_structural', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'sector-hot.js'), 'utf8');
  const swStart = source.indexOf('var upsertRows = results.map(function(r) {');
  const swEnd = source.indexOf("from('swing_screener_latest')", swStart);
  assert.notEqual(swStart, -1, 'Swing Konglo upsertRows mapper must exist');
  assert.notEqual(swEnd, -1, 'Swing Konglo upsert must exist');
  const swBlock = source.slice(swStart, swEnd);

  assert.match(swBlock, /trade_plan_v2:\s*r\.trade_plan_v2\s*\|\|\s*null/);
  assert.match(swBlock, /trade_plan_v2_structural:\s*r\.trade_plan_v2_structural\s*\|\|\s*null/);
});

test('persisted Day Trade row with trade_plan_v2 resolves as trade_plan_v2 when flag is on', () => {
  const row = {
    ticker: 'TEST',
    last_price: 1005,
    entry_low: 1000,
    entry_high: 1010,
    stop_loss: 955,
    tp1: 1060,
    tp2: null,
    risk_reward: 1.5,
    trade_plan_v2: usablePlan('DAY_TRADE'),
    trade_plan_v2_structural: {
      screener_type: 'DAY_TRADE',
      source_fields: ['support', 'resistance', 'atr14', 'candles'],
      available: true
    }
  };

  const resolved = integration.resolvePublicTradePlan(row, {
    channel: 'telegram',
    mode: 'daytrade',
    env: { TRADE_PLAN_V2_PUBLIC_ENABLED: 'true' }
  });

  assert.equal(resolved.source, 'trade_plan_v2');
  assert.equal(resolved.fallback, false);
  assert.equal(resolved.payload.canonical.plan_version, 'trade-plan-v2');
  assert.equal(resolved.payload.canonical.support, 970);
  assert.equal(resolved.payload.canonical.stop_loss, 955);
  assert.equal(resolved.payload.canonical.tp1, 1060);
});

test('persisted Swing Konglo row with trade_plan_v2 resolves as trade_plan_v2 when flag is on', () => {
  const row = {
    ticker: 'TEST',
    last_price: 1005,
    entry_low: 1000,
    entry_high: 1010,
    stop_loss: 955,
    tp1: 1060,
    tp2: null,
    risk_reward: 1.5,
    trade_plan_v2: usablePlan('SWING_KONGLO'),
    trade_plan_v2_structural: {
      screener_type: 'SWING_KONGLO',
      source_fields: ['support', 'resistance', 'atr14', 'candles'],
      available: true
    }
  };

  const resolved = integration.resolvePublicTradePlan(row, {
    channel: 'web',
    mode: 'swing_konglo',
    env: { TRADE_PLAN_V2_PUBLIC_ENABLED: 'true' }
  });

  assert.equal(resolved.source, 'trade_plan_v2');
  assert.equal(resolved.fallback, false);
  assert.equal(resolved.payload.canonical.plan_version, 'trade-plan-v2');
  assert.equal(resolved.payload.canonical.support, 970);
  assert.equal(resolved.payload.canonical.stop_loss, 955);
});
