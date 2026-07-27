'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const V = require('../lib/pattern-abcd-validation');

function candles(n) { return Array.from({ length: n }, (_, i) => ({ time: `2024-01-${String(i + 1).padStart(2, '0')}`, open: 100, high: 102, low: 98, close: 100, volume: 10 })); }
function candidate(cs, id = 'abcd-BBCA-bullish-abcd-t1-v1-20240101-20240102-20240103-20240104-20240105', status = 'candidate') {
  const point = (i, field) => ({ time: cs[i].time, value: cs[i][field], candleIndex: i, priceField: field });
  const c = { id, ruleVersion: 'abcd-t1-v1', name: 'Bullish ABCD', status, provenance: 'server:pattern-abcd:abcd-t1-v1', ticker: 'BBCA', timeframe: '1D', dataDate: cs.at(-1).time,
    candles: cs, points: { X: point(0, 'low'), A: point(1, 'high'), B: point(2, 'low'), C: point(3, 'high'), D: point(4, 'low') }, prz: { low: 97, high: 99 }, confirmation: 102, invalidation: 95, tp1: 105, tp2: 110, currentPrice: 100 };
  if (status === 'confirmed') c.confirmationEvidence = { type: 'daily-close', date: cs.at(-1).time }; return c;
}
function event(direction = 'bullish') { return { direction, firstSeenDate: '2024-01-05', currentPriceAtFirstSeen: 100, invalidation: direction === 'bullish' ? 95 : 105, tp1: direction === 'bullish' ? 105 : 95, tp2: direction === 'bullish' ? 110 : 90 }; }
function future(rows) { return rows.map((r, i) => ({ time: `2024-01-${String(i + 6).padStart(2, '0')}`, open: 100, close: 100, ...r })); }

test('walk-forward passes only truncated arrays with matching dataDate and is future-independent', () => {
  const input = candles(8), lengths = [], snapshots = [];
  const detectPattern = (cs, o) => { lengths.push(cs.length); snapshots.push(JSON.stringify(cs)); assert.equal(o.dataDate, cs.at(-1).time); return { candidate: null, reason: 'insufficient_pivots' }; };
  V.walkForwardAbcdValidation(input, { ticker: 'BBCA', detectPattern });
  assert.deepEqual(lengths, [1,2,3,4,5,6,7,8]); assert.equal(snapshots[4], JSON.stringify(input.slice(0, 5)));
  const changed = structuredClone(input); changed[7].close = 101;
  const prior = []; V.walkForwardAbcdValidation(changed, { ticker: 'BBCA', detectPattern: cs => { prior.push(JSON.stringify(cs)); return { candidate: null, reason: 'insufficient_pivots' }; } });
  assert.deepEqual(prior.slice(0, 7), snapshots.slice(0, 7));
});

test('stable IDs are accepted through PatternMap and deduplicated at first seen without mutation', () => {
  const input = candles(8), before = JSON.stringify(input); let validations = 0;
  const result = V.walkForwardAbcdValidation(input, { ticker: 'BBCA', detectPattern: cs => cs.length < 5 ? { candidate: null, reason: 'insufficient_pivots' } : { candidate: candidate(cs), reason: 'found', diagnostics: { bcRetracement: .7, cdAbRatio: 1 } }, validateCandidate: (c, context) => { validations++; return require('../public/pattern-map').validateCandidate(c, context); } });
  assert.equal(result.events.length, 1); assert.equal(result.events[0].firstSeenDate, '2024-01-05'); assert.equal(result.deduplicatedObservations, 3); assert.equal(validations, 4); assert.equal(JSON.stringify(input), before);
  assert.equal('candles' in result.events[0], false); assert.equal('provenance' in result.events[0], false);
});

test('renderer contract rejection is bounded', () => {
  const scan = V.walkForwardAbcdValidation(candles(5), { ticker: 'BBCA', detectPattern: cs => cs.length < 5 ? ({ candidate: null, reason: 'insufficient_pivots' }) : ({ candidate: candidate(cs), reason: 'found' }), validateCandidate: () => ({ valid: false }) });
  assert.equal(scan.events.length, 0); assert.equal(scan.reasonCounts.renderer_contract_rejected, 1);
});

test('bullish TP1, TP2, and invalidation classifications', () => {
  assert.equal(V.evaluateAbcdOutcome(event(), future([{ high: 106, low: 99 }]), { horizons: [1] }).horizons['1'].classification, 'tp1_before_invalidation');
  assert.equal(V.evaluateAbcdOutcome(event(), future([{ high: 111, low: 99 }]), { horizons: [1] }).horizons['1'].classification, 'tp2_before_invalidation');
  assert.equal(V.evaluateAbcdOutcome(event(), future([{ high: 101, low: 94 }]), { horizons: [1] }).horizons['1'].classification, 'invalidation_before_tp1');
});

test('bearish TP1, TP2, and invalidation classifications', () => {
  assert.equal(V.evaluateAbcdOutcome(event('bearish'), future([{ high: 101, low: 94 }]), { horizons: [1] }).horizons['1'].classification, 'tp1_before_invalidation');
  assert.equal(V.evaluateAbcdOutcome(event('bearish'), future([{ high: 101, low: 89 }]), { horizons: [1] }).horizons['1'].classification, 'tp2_before_invalidation');
  assert.equal(V.evaluateAbcdOutcome(event('bearish'), future([{ high: 106, low: 99 }]), { horizons: [1] }).horizons['1'].classification, 'invalidation_before_tp1');
});

test('same-bar conflict conservatively chooses invalidation and records conflict', () => {
  const o = V.evaluateAbcdOutcome(event(), future([{ high: 111, low: 94 }]), { horizons: [1] }).horizons['1'];
  assert.equal(o.classification, 'invalidation_before_tp1'); assert.equal(o.sameBarConflict, true);
});

test('outcome starts strictly after firstSeenDate and calculates deterministic MFE/MAE', () => {
  const rows = [{ time: '2024-01-05', high: 999, low: 1 }, ...future([{ high: 104, low: 97 }, { high: 103, low: 96 }])];
  const o = V.evaluateAbcdOutcome(event(), rows, { horizons: [2] }).horizons['2'];
  assert.equal(o.classification, 'unresolved'); assert.equal(o.maximumFavorableExcursion, 4); assert.equal(o.maximumAdverseExcursion, 4); assert.equal(o.mfePercent, 4); assert.equal(o.maePercent, 4);
});

test('unresolved, insufficient data, and 5/10/20 horizons remain separate', () => {
  const rows = future(Array.from({ length: 10 }, () => ({ high: 101, low: 99 })));
  const o = V.evaluateAbcdOutcome(event(), rows, { horizons: [5,10,20] }).horizons;
  assert.equal(o['5'].classification, 'unresolved'); assert.equal(o['10'].classification, 'unresolved'); assert.equal(o['20'].classification, 'insufficient_future_data');
});

test('summaries separate direction, first-seen status, and horizon', () => {
  const events = ['bullish','bearish'].flatMap(direction => ['candidate','confirmed'].map(firstSeenStatus => ({ direction, firstSeenStatus, outcomes: { 5: { classification: 'tp2_before_invalidation', sameBarConflict: false }, 10: { classification: 'unresolved', sameBarConflict: false } } })));
  const rows = V.summarizeAbcdValidation(events, { horizons: [5,10] }); assert.equal(rows.length, 8);
  assert.equal(new Set(rows.map(r => `${r.direction}|${r.firstSeenStatus}|${r.horizonBars}`)).size, 8);
});

test('no-pattern reasons are counted and repeated runs/order are byte-equivalent', () => {
  const run = () => V.walkForwardAbcdValidation(candles(4), { ticker: 'BBCA', detectPattern: cs => ({ candidate: null, reason: cs.length % 2 ? 'insufficient_pivots' : 'no_ratio_match' }) });
  assert.equal(run().reasonCounts.insufficient_pivots, 2); assert.equal(run().reasonCounts.no_ratio_match, 2); assert.equal(JSON.stringify(run()), JSON.stringify(run()));
});

test('invalid candles reject only their ticker-level scan', () => {
  const bad = candles(3); bad[1].time = bad[0].time; const failure = V.walkForwardAbcdValidation(bad, { ticker: 'BAD' }); const good = V.walkForwardAbcdValidation(candles(3), { ticker: 'BBCA' });
  assert.equal(failure.error.reason, 'duplicate_date'); assert.equal(good.error, undefined); assert.equal(good.windowsScanned, 3);
});

test('non-finite or nonsensical levels are excluded with bounded reason', () => {
  const e = event(); e.tp1 = Infinity; const o = V.evaluateAbcdOutcome(e, future([]), { horizons: [5] });
  assert.equal(o.invalidReason, 'non_finite_or_non_positive_level'); assert.equal(o.horizons['5'].classification, 'invalid_event_levels');
});
