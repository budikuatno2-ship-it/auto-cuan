'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { addPerShareFacts } = require('../lib/ai-runtime-grounding-v2');

test('BUG-ARG2-01: addPerShareFacts must not fall back to plans[index] when factTicker is not in plansByTicker', () => {
  const context = {
    plans: [
      { ticker: 'BBRI', entryPriceIdr: 5000, stopLossIdr: 4700, tp1Idr: 5500 }
    ],
    calculation_facts: {
      plans: [
        { ticker: 'GOTO' }
      ]
    }
  };

  addPerShareFacts(context);

  const gotoFact = context.calculation_facts.plans[0];
  assert.strictEqual(
    gotoFact.loss_to_stop_per_share_idr,
    undefined,
    `GOTO must not inherit BBRI's loss_to_stop_per_share_idr, got ${gotoFact.loss_to_stop_per_share_idr}`
  );
  assert.strictEqual(
    gotoFact.tp1_gain_per_share_idr,
    undefined,
    `GOTO must not inherit BBRI's tp1_gain_per_share_idr, got ${gotoFact.tp1_gain_per_share_idr}`
  );
});

test('BUG-ARG2-02: addPerShareFacts must recognize standard alias "sl" for stop loss', () => {
  const context = {
    plans: [
      { ticker: 'BBRI', entry: 5000, sl: 4700 }
    ],
    calculation_facts: {
      plans: [
        { ticker: 'BBRI' }
      ]
    }
  };

  addPerShareFacts(context);

  const bbriFact = context.calculation_facts.plans[0];
  assert.strictEqual(
    bbriFact.loss_to_stop_per_share_idr,
    300,
    `addPerShareFacts should compute 300 from entry 5000 and sl 4700, got ${bbriFact.loss_to_stop_per_share_idr}`
  );
});
