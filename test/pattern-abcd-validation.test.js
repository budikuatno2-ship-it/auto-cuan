'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const V = require('../lib/pattern-abcd-validation');
const CLI = require('../tools/validate-pattern-abcd-history');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');

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

test('non-finite or structurally nonsensical levels are excluded with bounded reason', () => {
  const nonFinite = event(); nonFinite.tp1 = Infinity;
  const first = V.evaluateAbcdOutcome(nonFinite, future([]), { horizons: [5] });
  assert.equal(first.invalidReason, 'non_finite_or_non_positive_level'); assert.equal(first.horizons['5'].classification, 'invalid_event_levels');
  const badOrder = { ...event(), tp1: 111, tp2: 110 };
  const second = V.evaluateAbcdOutcome(badOrder, future([]), { horizons: [5] });
  assert.equal(second.invalidReason, 'nonsensical_level_order'); assert.equal(second.horizons['5'].classification, 'invalid_event_levels');
});

test('incomplete horizons retain observed TP1, TP2, and invalidation outcomes', () => {
  const tp1 = V.evaluateAbcdOutcome(event(), future([{ high: 101, low: 99 }, { high: 106, low: 99 }, { high: 101, low: 99 }]), { horizons: [20] }).horizons['20'];
  assert.equal(tp1.classification, 'tp1_before_invalidation');
  assert.equal(V.evaluateAbcdOutcome(event(), future([{ high: 111, low: 99 }]), { horizons: [20] }).horizons['20'].classification, 'tp2_before_invalidation');
  assert.equal(V.evaluateAbcdOutcome(event(), future([{ high: 101, low: 94 }]), { horizons: [20] }).horizons['20'].classification, 'invalidation_before_tp1');
  assert.equal(V.evaluateAbcdOutcome(event(), future([{ high: 101, low: 99 }]), { horizons: [20] }).horizons['20'].classification, 'insufficient_future_data');
});

test('same-bar policy credits only TP1 reached on an earlier candle', () => {
  const prior = V.evaluateAbcdOutcome(event(), future([{ high: 106, low: 99 }, { high: 111, low: 94 }]), { horizons: [20] }).horizons['20'];
  assert.equal(prior.classification, 'tp1_before_invalidation'); assert.equal(prior.sameBarConflict, true);
  const first = V.evaluateAbcdOutcome(event(), future([{ high: 106, low: 94 }]), { horizons: [20] }).horizons['20'];
  assert.equal(first.classification, 'invalidation_before_tp1'); assert.equal(first.sameBarConflict, true);
});

test('crossed levels are ineligible at first seen rather than malformed', () => {
  const cases = [
    [{ ...event(), currentPriceAtFirstSeen: 106 }, 'tp1_reached_before_first_seen'],
    [{ ...event(), currentPriceAtFirstSeen: 111 }, 'tp2_reached_before_first_seen'],
    [{ ...event(), currentPriceAtFirstSeen: 94 }, 'invalidation_reached_before_first_seen'],
    [{ ...event('bearish'), currentPriceAtFirstSeen: 94 }, 'tp1_reached_before_first_seen'],
    [{ ...event('bearish'), currentPriceAtFirstSeen: 89 }, 'tp2_reached_before_first_seen'],
    [{ ...event('bearish'), currentPriceAtFirstSeen: 106 }, 'invalidation_reached_before_first_seen']
  ];
  for (const [value, reason] of cases) {
    const result = V.evaluateAbcdOutcome(value, [], { horizons: [5] });
    assert.equal(result.invalidReason, null);
    assert.equal(result.firstSeenEligibility, reason);
    assert.equal(result.horizons['5'].classification, 'ineligible_at_first_seen');
    assert.equal(result.horizons['5'].firstSeenOutcome, reason);
  }
});

test('directory null and null candles become bounded ticker failures while valid tickers complete', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abcd-input-')); fs.writeFileSync(path.join(dir, 'NULL.json'), 'null');
  fs.writeFileSync(path.join(dir, 'BAD.json'), JSON.stringify([null])); fs.writeFileSync(path.join(dir, 'BBCA.json'), JSON.stringify(candles(3)));
  const result = CLI.processEntries(CLI.loadInput(dir), {});
  assert.deepEqual(result.failures, [{ ticker: 'BAD', reason: 'invalid_date', candleIndex: 0 }, { ticker: 'NULL', reason: 'invalid_file_schema' }]);
  assert.deepEqual(result.scans.map(s => s.ticker), ['BBCA']); assert.equal(JSON.stringify(result).includes('stack'), false);
});

test('complete source is validated before range filtering', () => {
  const malformed = candles(4); malformed[0] = null;
  const duplicate = candles(4); duplicate[0].time = duplicate[1].time;
  const result = CLI.processEntries([{ rawTicker: 'BBCA', candles: malformed }, { rawTicker: 'TLKM', candles: duplicate }], { from: '2024-01-03', to: '2024-01-04' });
  assert.deepEqual(result.failures, [{ ticker: 'BBCA', reason: 'invalid_date', candleIndex: 0 }, { ticker: 'TLKM', reason: 'duplicate_date', candleIndex: 1 }]);
});

test('detector and outcome exceptions are isolated without exception text', () => {
  const entries = [{ rawTicker: 'BBCA', candles: candles(3) }, { rawTicker: 'TLKM', candles: candles(3) }];
  const result = CLI.processEntries(entries, { walkForward: (cs, o) => o.ticker === 'BBCA' ? { error: { reason: 'detector_exception' } } : V.walkForwardAbcdValidation(cs, o) });
  assert.deepEqual(result.failures, [{ ticker: 'BBCA', reason: 'detector_exception' }]); assert.deepEqual(result.scans.map(s => s.ticker), ['TLKM']);
  const secret = CLI.processEntries([{ rawTicker: 'BBCA', candles: candles(3) }], { walkForward: () => { throw new Error('PRIVATE /home/user/token'); } });
  assert.deepEqual(secret.failures, [{ ticker: 'BBCA', reason: 'ticker_processing_exception' }]); assert.doesNotMatch(JSON.stringify(secret), /PRIVATE|token|\/home/);
  const direct = V.walkForwardAbcdValidation(candles(3), { ticker: 'BBCA', detectPattern: () => { throw new Error('secret'); } });
  assert.deepEqual(direct.error, { valid: false, reason: 'detector_exception' });
});

test('invalid calendar arguments are rejected', () => {
  ['2026-02-30', '2026-13-01', '2026-00-10'].forEach(value => assert.throws(() => CLI.parseDate(value, 'from'), /real YYYY-MM-DD/));
});

test('normalized ticker aliases conflict deterministically and never scan twice', () => {
  const a = [{ rawTicker: 'BBCA', candles: candles(3) }, { rawTicker: ' bbca.JK ', candles: candles(3) }, { rawTicker: 'TLKM.JK', candles: candles(3) }];
  const one = CLI.processEntries(a, {}), two = CLI.processEntries(a.slice().reverse(), {});
  assert.deepEqual(one.failures, [{ ticker: 'BBCA', reason: 'duplicate_normalized_ticker' }, { ticker: 'BBCA', reason: 'duplicate_normalized_ticker' }]);
  assert.deepEqual(one.failures, two.failures); assert.deepEqual(one.scans.map(s => s.ticker), ['TLKM']);
});

test('directory filename and payload aliases are rejected as duplicate identities', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abcd-alias-'));
  fs.writeFileSync(path.join(dir, 'BBCA.json'), JSON.stringify({ ticker: 'BBCA.JK', candles: candles(3) }));
  assert.deepEqual(CLI.processEntries(CLI.loadInput(dir), {}).failures, [{ ticker: 'BBCA', reason: 'duplicate_normalized_ticker' }]);
});

test('duplicate directory filename aliases conflict independent of file ordering', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abcd-dir-alias-'));
  fs.writeFileSync(path.join(dir, 'BBCA.json'), JSON.stringify(candles(3)));
  fs.writeFileSync(path.join(dir, 'bbca.JK.json'), JSON.stringify(candles(3)));
  const result = CLI.processEntries(CLI.loadInput(dir), {});
  assert.deepEqual(result.failures, [{ ticker: 'BBCA', reason: 'duplicate_normalized_ticker' }, { ticker: 'BBCA', reason: 'duplicate_normalized_ticker' }]);
  assert.equal(result.scans.length, 0); assert.equal(result.events.length, 0);
});

test('aggregate report counts, percentages, distributions, and dedup totals are deterministic', () => {
  const fake = (cs, o) => ({ ticker: o.ticker, windowsScanned: 2, reasonCounts: { found: 1, insufficient_pivots: 1 }, deduplicatedObservations: 3,
    noPatternExamples: [], events: [{ ...event(), ticker: o.ticker, candidateId: 'id-' + o.ticker, firstSeenStatus: o.ticker === 'BBCA' ? 'candidate' : 'confirmed', direction: o.ticker === 'BBCA' ? 'bullish' : 'bearish' }] });
  const entries = [{ rawTicker: 'TLKM', candles: candles(3) }, { rawTicker: 'BBCA', candles: candles(3) }];
  const run = () => CLI.processEntries(entries, { walkForward: fake, horizons: [5] }); const result = run();
  assert.equal(Object.values(result.aggregateReasonDistribution).reduce((n, r) => n + r.count, 0), result.totalWindows);
  assert.deepEqual(result.aggregateReasonDistribution, { found: { count: 2, percentagePct: 50 }, insufficient_pivots: { count: 2, percentagePct: 50 } });
  assert.equal(result.totalDeduplicatedObservations, 6); assert.equal(result.foundWindowCount + result.noPatternWindowCount, result.totalWindows);
  assert.deepEqual(result.directionDistribution, { bullish: 1, bearish: 1 }); assert.deepEqual(result.firstSeenStatusDistribution, { candidate: 1, confirmed: 1 });
  assert.deepEqual(result.firstSeenEligibilityDistribution, { eligible: 2, tp1_reached_before_first_seen: 0, tp2_reached_before_first_seen: 0, invalidation_reached_before_first_seen: 0, invalid_event_levels: 0 });
  assert.equal(JSON.stringify(result), JSON.stringify(run()));
});

test('aggregate outcomes separate eligible, stale, and invalid candidates', () => {
  const events = [
    { outcomes: { 5: { classification: 'tp2_before_invalidation', sameBarConflict: false } } },
    { outcomes: { 5: { classification: 'ineligible_at_first_seen', firstSeenOutcome: 'tp1_reached_before_first_seen', sameBarConflict: false } } },
    { outcomes: { 5: { classification: 'ineligible_at_first_seen', firstSeenOutcome: 'tp2_reached_before_first_seen', sameBarConflict: false } } },
    { outcomes: { 5: { classification: 'invalid_event_levels', sameBarConflict: false } } }
  ];
  const row = CLI.outcomeAggregate(events, [5])['5'];
  assert.equal(row.candidateEventCount, 4); assert.equal(row.eventCount, 1); assert.equal(row.ineligibleAtFirstSeenCount, 2); assert.equal(row.invalidEventCount, 1);
  assert.equal(row.tp1AlreadyReachedCount, 1); assert.equal(row.tp2AlreadyReachedCount, 1);
  assert.equal(row.eligibleEventRatePct, 25); assert.equal(row.ineligibleAtFirstSeenRatePct, 50); assert.equal(row.invalidEventRatePct, 25);
});
