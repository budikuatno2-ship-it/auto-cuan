'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const idx = require('../lib/idx-tick-normalization');

function assertValidLevels(plan, keys) {
  for (const key of keys) {
    if (plan[key] != null) assert.equal(idx.isValidIdxPriceLevel(plan[key]), true, key + ' should be IDX tick-aligned');
  }
}

test('getIdxTickSize locks current IDX/BEI fraksi harga boundaries', () => {
  const cases = [
    [50, 1], [199, 1], [200, 2], [499, 2], [500, 5], [1999, 5],
    [2000, 10], [4999, 10], [5000, 25], [10000, 25]
  ];
  for (const [price, tick] of cases) assert.equal(idx.getIdxTickSize(price), tick, String(price));
  for (const price of [0, -1, null, undefined, '', Number.NaN]) assert.equal(idx.getIdxTickSize(price), null, String(price));
});

test('roundToIdxTick locks nearest/floor/ceil behavior around tick boundaries', () => {
  const cases = [
    [199.4, { nearest: 199, floor: 199, ceil: 200 }],
    [199.6, { nearest: 200, floor: 199, ceil: 200 }],
    [201, { nearest: 202, floor: 200, ceil: 202 }],
    [202, { nearest: 202, floor: 202, ceil: 202 }],
    [203, { nearest: 204, floor: 202, ceil: 204 }],
    [503, { nearest: 505, floor: 500, ceil: 505 }],
    [504, { nearest: 505, floor: 500, ceil: 505 }],
    [506, { nearest: 505, floor: 505, ceil: 510 }],
    [2003, { nearest: 2000, floor: 2000, ceil: 2010 }],
    [2006, { nearest: 2010, floor: 2000, ceil: 2010 }],
    [5003, { nearest: 5000, floor: 5000, ceil: 5025 }],
    [5012, { nearest: 5000, floor: 5000, ceil: 5025 }],
    [5013, { nearest: 5025, floor: 5000, ceil: 5025 }]
  ];
  for (const [price, expected] of cases) {
    for (const [mode, value] of Object.entries(expected)) assert.equal(idx.roundToIdxTick(price, mode), value, price + ':' + mode);
  }
});

test('isValidIdxPriceLevel accepts and rejects levels using the encoded tick bands', () => {
  for (const price of [50, 199, 200, 202, 500, 505, 2000, 2010, 5000, 5025]) {
    assert.equal(idx.isValidIdxPriceLevel(price), true, String(price));
  }
  for (const price of [201, 503, 2005, 5010, 0, null, -1]) {
    assert.equal(idx.isValidIdxPriceLevel(price), false, String(price));
  }
});

test('normalizeTradingPlanLevels normalizes all trading-plan aliases to valid IDX ticks', () => {
  const plan = idx.normalizeTradingPlanLevels({
    ticker: 'TEST',
    mode: 'daytrade',
    entry1: 1003,
    entry2: 1012,
    sl: 977,
    tp1: 1043,
    tp2: 1086,
    support: 981,
    resistance: 1042,
    breakout_trigger: 1041,
    reclaim_level: 1027,
    risk_reward: 1.5,
    rr_minimum: 1.2
  });

  assertValidLevels(plan, [
    'entry1', 'entry2', 'entry_1', 'entry_2', 'entry_low', 'entry_high', 'sl', 'stop_loss',
    'tp1', 'tp1n', 'target_1', 'tp2', 'tp2n', 'target_2', 'support', 'resistance',
    'breakout_trigger', 'reclaim_level'
  ]);
  assert.equal(plan.entry1, 1005);
  assert.equal(plan.entry2, 1010);
  assert.equal(plan.entry_low, 1005);
  assert.equal(plan.entry_high, 1010);
  assert.equal(plan.stop_loss, 975);
  assert.equal(plan.tp1, 1045);
  assert.equal(plan.tp2, 1090);
  assert.equal(plan.support, 980);
  assert.equal(plan.resistance, 1045);
  assert.equal(plan.breakout_trigger, 1045);
  assert.equal(plan.reclaim_level, 1045);
  assert.equal(plan.entry_low <= plan.entry_high, true);
  assert.equal(plan.stop_loss < plan.entry_high, true);
  assert.equal(plan.tp1 > plan.entry_high, true);
  assert.equal(plan.tp2 >= plan.tp1, true);
  assert.equal(plan.support <= plan.resistance, true);
  assert.equal(plan.tick_normalized, true);
  assert.equal(plan.level_validation_valid, true);
  assert.equal(plan.trading_plan_valid, true);
});

test('normalizeTradingPlanLevels keeps structurally invalid plans invalid after tick normalization', () => {
  const plan = idx.normalizeTradingPlanLevels({
    entry1: 1003,
    entry2: 1007,
    sl: 1011,
    tp1: 1008,
    tp2: 1004,
    risk_reward: 1.5
  });
  assertValidLevels(plan, ['entry_low', 'entry_high', 'stop_loss', 'tp1', 'tp2']);
  assert.equal(plan.trading_plan_valid, false);
  assert.equal(plan.level_validation_valid, false);
  assert.equal(plan.tick_normalized, false);
  assert.match(plan.trading_plan_note, /SL harus di bawah Entry|TP2 harus sama\/di atas TP1/);
});

test('validateTradingPlanSanity rejects invalid structures, missing levels, bad RR, and invalid ticks', () => {
  const base = { entry_low: 1000, entry_high: 1010, stop_loss: 970, tp1: 1040, tp2: 1070, risk_reward: 1.5 };
  const invalids = [
    ['SL >= entry', { stop_loss: 1010 }, /SL harus di bawah Entry/],
    ['TP1 <= entry', { tp1: 1010 }, /TP1 harus di atas Entry/],
    ['TP2 < TP1', { tp2: 1030 }, /TP2 harus sama\/di atas TP1/],
    ['missing level', { entry_low: null }, /Ada level entry\/SL\/TP kosong/],
    ['invalid RR', { risk_reward: 0 }, /RR tidak valid/],
    ['invalid tick level', { entry_low: 1001 }, /Level harga belum sesuai tick size IDX/]
  ];
  for (const [name, overrides, note] of invalids) {
    const sanity = idx.validateTradingPlanSanity(Object.assign({}, base, overrides));
    assert.equal(sanity.trading_plan_valid, false, name);
    assert.equal(sanity.trading_plan_status, 'INVALID', name);
    assert.match(sanity.trading_plan_note, note, name);
  }
});

test('normalizeLevelsToIdxTicks exposes normalized canonical levels and tick metadata', () => {
  const levels = idx.normalizeLevelsToIdxTicks({
    entry_low: 1003,
    entry_high: 1012,
    stop_loss: 977,
    tp1: 1043,
    tp2: 1086,
    risk_reward: 1.5,
    support: 981,
    resistance: 1042
  });
  assert.deepEqual(Object.keys(levels).sort(), [
    'entry_high', 'entry_low', 'resistance', 'risk_reward', 'stop_loss', 'support',
    'tick_normalized', 'tick_notes', 'tp1', 'tp2'
  ].sort());
  assertValidLevels(levels, ['entry_low', 'entry_high', 'stop_loss', 'tp1', 'tp2', 'support', 'resistance']);
  assert.equal(levels.entry_low, 1005);
  assert.equal(levels.entry_high, 1010);
  assert.equal(levels.stop_loss, 975);
  assert.equal(levels.tp1, 1045);
  assert.equal(levels.tp2, 1090);
  assert.equal(levels.support, 980);
  assert.equal(levels.resistance, 1045);
  assert.equal(typeof levels.risk_reward, 'number');
  assert.equal(levels.tick_normalized, true);
  assert.equal(levels.tick_notes, null);
});
