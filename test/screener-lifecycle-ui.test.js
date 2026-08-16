'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ui = require('../public/screener-lifecycle-ui');

test('production lifecycle phases have visible card labels', function () {
  assert.equal(ui.phaseSummary({ setup_phase: 'REVERSAL_EARLY', phase_confidence: 61 }), 'Fase 1/4 · Reversal · 61%');
  assert.equal(ui.phaseSummary({ setup_phase: 'PRE_BREAKOUT', phase_confidence: 70 }), 'Fase 2/4 · Pre-Breakout · 70%');
  assert.equal(ui.phaseSummary({ setup_phase: 'BREAKOUT_CONFIRMED', phase_confidence: 84 }), 'Fase 3/4 · Breakout · 84%');
  assert.equal(ui.phaseSummary({ setup_phase: 'POST_BREAKOUT_CONTINUATION', phase_confidence: 73 }), 'Fase 4/4 · Continuation · 73%');
  assert.equal(ui.phaseSummary({ setup_phase: 'INVALIDATED' }), 'Lifecycle · Diblokir');
  assert.equal(ui.phaseSummary({ setup_phase: 'NONE' }), null);
});

test('ticker normalization is stable for IDX symbols', function () {
  assert.equal(ui.cleanTicker('bbca.jk'), 'BBCA');
  assert.equal(ui.cleanTicker('  tlkm  '), 'TLKM');
});
