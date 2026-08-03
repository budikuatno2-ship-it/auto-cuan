'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  moneyFromMessage,
  lotsFromMessage,
  prepareRuntimeGrounding
} = require('../lib/ai-runtime-grounding-v2');

function context(overrides) {
  return Object.assign({
    plans: [{
      ticker: 'BELL',
      lots: 300,
      entryPriceIdr: 109,
      currentPriceIdr: 0,
      stopLossIdr: 100,
      tp1Idr: 185,
      tp2Idr: 210,
      capitalIdr: 3270000,
      estimatedMaxLossIdr: 270000
    }],
    prices: {},
    budget: null
  }, overrides || {});
}

function scenarioFor(grounded, funds) {
  return grounded.affordability_facts.scenarios.find((row) => row.available_funds_idr === funds);
}

test('parses Indonesian budget and lot notation safely', () => {
  assert.deepEqual(moneyFromMessage('budget Rp1.000.000 untuk saham'), [1000000]);
  assert.deepEqual(moneyFromMessage('modal 2,5 juta'), [2500000]);
  assert.deepEqual(lotsFromMessage('simulasi beli 3 lot'), [3]);
});

test('promotes one-lot and plan affordability facts used by evaluated answers', () => {
  const grounded = prepareRuntimeGrounding(
    'portfolio_chat',
    'Dengan budget Rp1.000.000, harga maksimal untuk 1 lot berapa?',
    context()
  );
  const scenario = scenarioFor(grounded, 1000000);
  const plan = scenario.plan_scenarios[0];
  assert.equal(scenario.max_price_for_one_lot_idr, 10000);
  assert.equal(scenario.requested_lot_scenarios[0].max_price_per_share_floor_idr, 10000);
  assert.equal(plan.max_affordable_lots, 91);
  assert.equal(plan.max_affordable_shares, 9100);
  assert.equal(plan.max_affordable_cost_idr, 991900);
  assert.equal(plan.remaining_after_max_lots_idr, 8100);
});

test('derives target and risk deltas per share from portfolio snapshot', () => {
  const grounded = prepareRuntimeGrounding('portfolio_chat', 'Apa dampaknya jika TP1 tercapai?', context());
  const facts = grounded.calculation_facts.plans[0];
  assert.equal(facts.loss_to_stop_per_share_idr, 9);
  assert.equal(facts.tp1_gain_per_share_idr, 76);
  assert.equal(facts.tp2_gain_per_share_idr, 101);
  assert.equal(facts.tp1_gross_profit_idr, 2280000);
});

test('covers evaluated affordability variants without hard-coded case IDs', () => {
  const fiveMillion = scenarioFor(
    prepareRuntimeGrounding('portfolio_chat', 'budget Rp5.000.000 untuk 1 lot', context()),
    5000000
  );
  assert.equal(fiveMillion.max_price_for_one_lot_idr, 50000);
  assert.equal(fiveMillion.plan_scenarios[0].max_affordable_shares, 45800);

  const tenMillion = scenarioFor(
    prepareRuntimeGrounding('portfolio_chat', 'dana Rp10.000.000', context()),
    10000000
  );
  assert.equal(tenMillion.max_price_for_one_lot_idr, 100000);
  assert.equal(tenMillion.plan_scenarios[0].max_affordable_shares, 91700);

  const threeLots = scenarioFor(
    prepareRuntimeGrounding('portfolio_chat', 'modal 2,5 juta untuk 3 lot', context()),
    2500000
  );
  const requested = threeLots.requested_lot_scenarios.find((row) => row.lots === 3);
  assert.equal(requested.shares, 300);
  assert.equal(requested.max_price_per_share_floor_idr, 8333);
});

test('uses transient simulation facts and labels them as simulation', () => {
  const grounded = prepareRuntimeGrounding('portfolio_chat', 'berapa batasnya?', context({
    simulation: { available_funds_idr: 2500000, add_lots: 2, label: 'SIMULASI' }
  }));
  const scenario = scenarioFor(grounded, 2500000);
  const requested = scenario.requested_lot_scenarios.find((row) => row.lots === 2);
  assert.equal(requested.max_price_per_share_floor_idr, 12500);
  assert.match(grounded.affordability_facts.policy, /SIMULASI/);
  assert.equal(grounded.ai_answer_policy.version, 'AUTO_CUAN_AI_RUNTIME_GROUNDING_V1');
});

test('stock follow-up receives answer policy without portfolio calculations', () => {
  const grounded = prepareRuntimeGrounding('stock_analysis_followup', 'ringkas', {
    ticker: 'BELL',
    analysis_text: 'Volume 0,51x rata-rata dan last 114.'
  });
  assert.equal(grounded.ai_answer_policy.source, 'stock_analysis_followup');
  assert.equal(Object.hasOwn(grounded, 'calculation_facts'), false);
  assert.equal(Object.hasOwn(grounded, 'affordability_facts'), false);
});
