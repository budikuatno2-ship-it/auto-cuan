'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const safety = require('../public/pattern-direction-safety');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('long and short plans are classified from official level ordering', () => {
  assert.equal(safety.tradePlanDirection({ entry_low:2640, entry_high:2690, stop_loss:2580, tp1:2790, tp2:2930 }), 'bullish');
  assert.equal(safety.tradePlanDirection({ entry_low:3200, entry_high:3220, stop_loss:3477.5, tp1:3053.84, tp2:2846.16 }), 'bearish');
  assert.equal(safety.tradePlanDirection({ entry_low:100, entry_high:105, stop_loss:103, tp1:106, tp2:90 }), 'unknown');
});

test('bearish Pattern never treats bullish Screener levels as compatible', () => {
  assert.equal(safety.directionsCompatible('bearish', 'bullish'), false);
  assert.equal(safety.directionsCompatible('bullish', 'bullish'), true);
  assert.equal(safety.directionsCompatible('bilateral', 'bullish'), true);
  assert.equal(safety.directionsCompatible('bearish', 'unknown'), false);
});

test('opposite Screener labels are filtered instead of shown as confluence', () => {
  assert.deepEqual(safety.filterLabelsForDirection(['Bull Pennant', 'Rising Wedge', 'Volume Dry-Up'], 'bearish'), {
    accepted:['Rising Wedge', 'Volume Dry-Up'], rejected:['Bull Pennant']
  });
  assert.deepEqual(safety.filterLabelsForDirection(['Uptrend Pullback', 'VCP-like Base'], 'bearish'), {
    accepted:[], rejected:['Uptrend Pullback', 'VCP-like Base']
  });
});

test('ABCD labels and stale-level checks are direction aware', () => {
  assert.equal(safety.normalizeLevelLabel('Entry / Konfirmasi', 'bearish'), 'Konfirmasi Turun');
  assert.equal(safety.normalizeLevelLabel('Stop Loss / Invalidasi', 'bearish'), 'Batas Invalidasi Atas');
  assert.equal(safety.normalizeLevelLabel('TP1', 'bearish'), 'Target Turun 1');
  assert.equal(safety.normalizeLevelLabel('TP2', 'bearish'), 'Target Turun 2');

  assert.deepEqual(safety.evaluateAbcdLevels({ current:3250, confirmation:3220, invalidation:3477.5, tp1:3053.84, tp2:2846.16 }, 'bearish'), {
    actionable:true, reason:null, reasons:[]
  });
  const stale = safety.evaluateAbcdLevels({ current:2610, confirmation:2740, invalidation:2981.79, tp1:2758.1, tp2:2651.9 }, 'bearish');
  assert.equal(stale.actionable, false);
  assert.ok(stale.reasons.includes('inconsistent_level_order'));
  assert.ok(stale.reasons.includes('target_already_reached'));
});

test('runtime loads after Pattern Screener context and remains UI-only', () => {
  const source = read('public/pattern-direction-safety.js');
  const loader = read('public/assets/fca-stocks.js');
  new vm.Script(source, { filename:'pattern-direction-safety.js' });
  assert.ok(loader.indexOf('/pattern-screener-extension.js') < loader.indexOf('/pattern-direction-safety.js'));
  assert.match(loader, /20260731-pattern-direction-safety-v1/);
  assert.match(source, /Konflik arah · level Screener disembunyikan/);
  assert.match(source, /data-direction-conflict/);
  assert.match(source, /Tidak actionable/);
  assert.doesNotMatch(source, /fetch\(|sendTelegram|telegramNotifier|supabase\.from|createOrder|scan\(|\/api\//i);
});
