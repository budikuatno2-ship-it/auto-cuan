'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { stockFacts, planFacts } = require('../lib/ai-eval-derived-facts');

test('BUG-EDF-01: stockFacts must resolve standard screener keys entry1, entry2, and sl', () => {
  const pick = {
    ticker: 'BBRI',
    entry1: 5000,
    sl: 4800,
    tp1: 5500
  };
  const facts = stockFacts(pick);
  assert.strictEqual(facts.entry_price, 5000, 'entry_price must resolve entry1');
  assert.strictEqual(facts.stop_loss, 4800, 'stop_loss must resolve sl');
});

test('BUG-EDF-02: planFacts simulation must calculate total position for new/watchlist positions where existing lots is null', () => {
  const plan = {
    ticker: 'TLKM',
    entry: 3800
  };
  const simulation = {
    add_lots: 10,
    available_funds_idr: 5000000
  };
  const facts = planFacts(plan, simulation);

  assert.ok(facts.simulation, 'simulation facts must exist');
  assert.strictEqual(facts.simulation.total_lots, 10, 'total_lots must be 10 for new positions');
});
