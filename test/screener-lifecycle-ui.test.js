'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const lifecycleUi = require(path.join('..', 'public', 'screener-lifecycle-ui.js'));

test('lifecycle UI always exposes an explicit status', () => {
  assert.equal(lifecycleUi.phaseSummary({ setup_phase: 'PRE_BREAKOUT', phase_confidence: 77 }), 'Fase 2/4 · Pre-Breakout · 77%');
  assert.equal(lifecycleUi.phaseSummary({ setup_phase: 'NONE', phase_confidence: 45 }), 'Lifecycle · Belum masuk fase');
  assert.equal(lifecycleUi.phaseSummary({ setup_phase: 'INVALIDATED', phase_confidence: 100 }), 'Lifecycle · Diblokir safety');
  assert.equal(lifecycleUi.phaseSummary({}), 'Lifecycle · Status belum tersedia');
  assert.equal(lifecycleUi.phaseSummary(null), 'Lifecycle · Status belum tersedia');
});

test('confidence percentage is shown only for active phases', () => {
  const active = ['REVERSAL_EARLY', 'PRE_BREAKOUT', 'BREAKOUT_CONFIRMED', 'POST_BREAKOUT_CONTINUATION'];
  active.forEach((phase) => {
    assert.equal(lifecycleUi.PHASE_META[phase].showConfidence, true, phase + ' should show confidence');
    assert.match(lifecycleUi.phaseSummary({ setup_phase: phase, phase_confidence: 64 }), /64%$/);
  });

  ['NONE', 'INVALIDATED', 'UNKNOWN'].forEach((phase) => {
    assert.equal(lifecycleUi.PHASE_META[phase].showConfidence, false, phase + ' must not show confidence');
    assert.doesNotMatch(lifecycleUi.phaseSummary({ setup_phase: phase, phase_confidence: 99 }), /%/);
  });
});

test('unknown future lifecycle state degrades to explicit neutral status', () => {
  assert.equal(lifecycleUi.phaseMeta({ setup_phase: 'FUTURE_PHASE' }), lifecycleUi.PHASE_META.UNKNOWN);
  assert.equal(lifecycleUi.phaseSummary({ setup_phase: 'FUTURE_PHASE', phase_confidence: 88 }), 'Lifecycle · Status belum tersedia');
});
