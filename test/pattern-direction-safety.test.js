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

test('a candidate that has not confirmed is awaiting, not actionable', () => {
  const base = { currentPrice:1000, confirmation:1010, invalidation:950, tp1:1080, tp2:1140 };
  const awaiting = safety.evaluateRow({ ticker:'BBCA', candidate:Object.assign({ name:'Bullish ABCD', status:'candidate' }, base) }, null);
  assert.equal(awaiting.status, safety.STATUS.AWAITING);
  assert.equal(awaiting.actionable, false);

  const ready = safety.evaluateRow({ ticker:'BBCA', candidate:Object.assign({ name:'Bullish ABCD', status:'confirmed' }, base) }, null);
  assert.equal(ready.status, safety.STATUS.ACTIONABLE);
  assert.equal(ready.actionable, true);
});

test('a played-out or invalidated candidate is separated from a merely unconfirmed one', () => {
  const past = safety.evaluateRow({ ticker:'BBCA', candidate:{ name:'Bullish ABCD', status:'confirmed', currentPrice:1200, confirmation:1010, invalidation:950, tp1:1080, tp2:1140 } }, null);
  assert.equal(past.status, safety.STATUS.TARGET_REACHED);

  const dead = safety.evaluateRow({ ticker:'BBCA', candidate:{ name:'Bullish ABCD', status:'confirmed', currentPrice:900, confirmation:1010, invalidation:950, tp1:1080, tp2:1140 } }, null);
  assert.equal(dead.status, safety.STATUS.INVALIDATED);

  // Decision value drives the grid order: actionable first, dead last.
  assert.ok(safety.statusRank(safety.STATUS.ACTIONABLE) < safety.statusRank(safety.STATUS.AWAITING));
  assert.ok(safety.statusRank(safety.STATUS.AWAITING) < safety.statusRank(safety.STATUS.TARGET_REACHED));
  assert.ok(safety.statusRank(safety.STATUS.TARGET_REACHED) < safety.statusRank(safety.STATUS.INVALIDATED));
});

test('a classic-only row is context, never an entry plan', () => {
  const row = safety.evaluateRow({ ticker:'ASII', candidate:null, classicPatterns:[{ type:'DOUBLE_TOP', bias:'Bearish', confidence:0.92 }] }, null);
  assert.equal(row.status, safety.STATUS.CONTEXT_ONLY);
  assert.equal(row.actionable, false);
  assert.equal(row.direction, 'bearish');
});

test('the safety model evaluates numbers and never re-reads rendered text', () => {
  const source = read('public/pattern-direction-safety.js');
  const loader = read('public/assets/fca-stocks.js');
  new vm.Script(source, { filename:'pattern-direction-safety.js' });
  assert.match(loader, /20260813-pattern-direction-safety-v2/);
  // The MutationObserver + DOM-scraping install path is what produced the
  // measured idle-mutation loop; it must not come back. Comments are stripped
  // first so the explanation of the old behaviour does not trip its own guard.
  const code = source.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /MutationObserver|querySelectorAll|textContent\s*=|innerHTML/);
  assert.doesNotMatch(source, /fetch\(|sendTelegram|telegramNotifier|supabase\.from|createOrder|scan\(|\/api\//i);
});

test('the Screener extension owns the direction-conflict guard and reads plan numbers directly', () => {
  const extension = read('public/pattern-screener-extension.js');
  assert.match(extension, /Konflik arah · level Screener disembunyikan/);
  assert.match(extension, /data-direction-conflict/);
  assert.match(extension, /tradePlanDirection\(plan\)/);
  // The old guard rebuilt the plan by parsing rendered level strings.
  assert.doesNotMatch(extension, /parseLocalizedNumber|planFromBox/);
});
