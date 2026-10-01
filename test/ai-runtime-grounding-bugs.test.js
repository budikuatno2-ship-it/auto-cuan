'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  moneyFromMessage,
  prepareRuntimeGrounding,
  portfolioCalculationFacts
} = require('../lib/ai-runtime-grounding');

test('BUG-ARG-01: moneyFromMessage must extract funds from multi-word phrasing like "modal saya sebesar 50 juta"', () => {
  const result = moneyFromMessage('Modal saya sebesar 50 juta');
  assert.deepStrictEqual(result, [50000000]);
});

test('BUG-ARG-02: prepareRuntimeGrounding must supply calculation_facts for stock_analysis', () => {
  const context = {
    ticker: 'BBRI',
    entry: 5000,
    stop_loss: 4800,
    tp1: 5500
  };
  const grounded = prepareRuntimeGrounding('stock_analysis', 'analisis BBRI', context);
  assert.ok(grounded.calculation_facts, 'calculation_facts must be defined for stock_analysis');
});

test('BUG-ARG-03: portfolioCalculationFacts must include budget facts when budget is provided', () => {
  const context = {
    budget: {
      capitalIdr: 100000000,
      reservePct: 20,
      maxPositions: 5
    },
    plans: []
  };
  const facts = portfolioCalculationFacts(context);
  assert.ok(facts.budget, 'calculation_facts.budget must be defined when context has budget');
});
