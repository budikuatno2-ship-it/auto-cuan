'use strict';

/**
 * test/v5/chart-state-guard.test.js
 * ============================================================================
 * UNIT TESTS — chart identity guard (BUG-V5-P0-009 / P1-024)
 * ============================================================================
 * Proves a stale or cross-ticker render can never overwrite the active chart.
 * Run: node test/v5/chart-state-guard.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const G = require(path.join(ROOT, 'lib', 'chart-state-guard.js'));

const CHART = G.CATEGORY.CHART;
const PLAN = G.CATEGORY.PLAN;

test('request guard: seq is monotonic per category and only the newest token is current', () => {
  const guard = G.createRequestGuard();
  const first = guard.next('BBCA', CHART);
  const second = guard.next('BBCA', CHART);

  assert.equal(first.seq < second.seq, true, 'seq must increase');
  assert.notEqual(first.token, second.token, 'every request gets its own token');
  assert.equal(guard.isCurrent(second), true);
  assert.equal(guard.isCurrent(first), false, 'an older token is never current');
  assert.equal(guard.isCurrent(null), false);
  assert.equal(guard.isCurrent({ seq: second.seq, ticker: 'BBRI', category: CHART }), false,
    'the newest seq with another ticker is not current');
});

test('request guard: categories are sequenced independently', () => {
  const guard = G.createRequestGuard();
  const chartToken = guard.next('BBCA', CHART);
  const planToken = guard.next('BBCA', PLAN);

  assert.equal(guard.isCurrent(chartToken), true, 'a plan token must not invalidate the chart token');
  assert.equal(guard.isCurrent(planToken), true);
});

test('request guard: cancelAll invalidates every outstanding token', () => {
  const guard = G.createRequestGuard();
  const token = guard.next('BBCA', CHART);
  assert.equal(guard.isCurrent(token), true);
  guard.cancelAll();
  assert.equal(guard.isCurrent(token), false, 'a cancelled token must never publish');
});

test('request guard: switching ticker invalidates the previous ticker token', () => {
  const guard = G.createRequestGuard();
  const bbca = guard.next('BBCA', CHART);
  const dsng = guard.next('DSNG', CHART);
  assert.equal(guard.isCurrent(bbca), false, 'the BBCA token is stale after switching to DSNG');
  assert.equal(guard.isCurrent(dsng), true);
});

test('identityMatches normalises case/whitespace and rejects a missing field', () => {
  assert.equal(G.identityMatches({ ticker: ' bbca ', category: 'chart' }, { ticker: 'BBCA', category: 'CHART' }), true);
  assert.equal(G.identityMatches({ ticker: 'BBCA.jk', category: 'chart' }, { ticker: 'BBca', category: 'chart' }), true);
  assert.equal(G.identityMatches({ ticker: 'BBCA', category: CHART }, { ticker: 'DSNG', category: CHART }), false);
  assert.equal(G.identityMatches({ ticker: 'BBCA', category: CHART }, { ticker: 'BBCA', category: PLAN }), false);
  assert.equal(G.identityMatches({ ticker: '', category: CHART }, { ticker: '', category: CHART }), false,
    'an empty ticker must never behave like a wildcard');
  assert.equal(G.identityMatches(null, { ticker: 'BBCA', category: CHART }), false);
});

test('stampIdentity normalises the identity and preserves the payload', () => {
  const stamped = G.stampIdentity(
    { candles: [{ close: 9860 }], actual_data_date: '2026-11-04', source_timestamp: '2026-11-04T10:00:00.000Z' },
    { ticker: ' bbca ', category: ' chart ', tradeDate: '2026-11-04' }
  );
  assert.equal(stamped.ticker, 'BBCA');
  assert.equal(stamped.category, 'CHART');
  assert.equal(stamped.tradeDate, '2026-11-04');
  assert.equal(stamped.sourceTimestamp, '2026-11-04T10:00:00.000Z',
    'source_timestamp falls through when no explicit value is given');
  assert.equal(stamped.candles[0].close, 9860, 'the payload is preserved');
});

test('assertIdentityMatch returns true on match and throws a typed error on mismatch', () => {
  assert.equal(G.assertIdentityMatch({ ticker: 'BBCA', category: CHART }, { ticker: 'BBCA', category: CHART }), true);
  assert.throws(() => {
    G.assertIdentityMatch({ ticker: 'BBCA', category: CHART }, { ticker: 'DSNG', category: CHART });
  }, (err) => err && err.name === 'IdentityMismatch' && err.code === G.REJECT.IDENTITY_MISMATCH);
});

test('snapshot bus: chart and plan for one ticker never collide', () => {
  const bus = G.createSnapshotBus();
  bus.put({ ticker: 'BBCA', category: CHART, seq: 1, payload: { kind: 'chart' } });
  bus.put({ ticker: 'BBCA', category: PLAN, seq: 1, payload: { kind: 'plan' } });
  assert.equal(bus.get('BBCA', CHART).payload.kind, 'chart');
  assert.equal(bus.get('BBCA', PLAN).payload.kind, 'plan');
});

test('snapshot bus: an older seq for the same identity is rejected (out-of-order resolution)', () => {
  const bus = G.createSnapshotBus();
  const newer = bus.put({ ticker: 'BBCA', category: CHART, seq: 7, payload: { last: 9860 } });
  const older = bus.put({ ticker: 'BBCA', category: CHART, seq: 6, payload: { last: 9000 } });

  assert.equal(newer.ok, true);
  assert.equal(older.ok, false);
  assert.equal(older.reason, G.REJECT.STALE_SEQ);
  assert.equal(bus.get('BBCA', CHART).payload.last, 9860, 'the newer snapshot survived');
});

test('snapshot bus: a late write for the ticker switched away from is rejected and unreadable', () => {
  const bus = G.createSnapshotBus();
  bus.put({ ticker: 'BBCA', category: CHART, seq: 1, payload: { last: 9860 } });
  bus.put({ ticker: 'DSNG', category: CHART, seq: 2, payload: { last: 1550 } });

  const lateBbca = bus.put({ ticker: 'BBCA', category: CHART, seq: 1, payload: { last: 9860 } });
  assert.equal(lateBbca.ok, false, 'the late BBCA write must be refused');
  assert.equal(bus.get('BBCA', CHART), null, 'BBCA must not be served after the switch');
  assert.equal(bus.get('DSNG', CHART).payload.last, 1550, 'DSNG is still what the user is looking at');
});

test('snapshot bus: an entry without a complete identity or a seq is refused, never stored', () => {
  const bus = G.createSnapshotBus();
  assert.equal(bus.put({ category: CHART, seq: 1 }).reason, G.REJECT.INCOMPLETE_IDENTITY);
  assert.equal(bus.put({ ticker: 'BBCA', seq: 1 }).reason, G.REJECT.INCOMPLETE_IDENTITY);
  assert.equal(bus.put({ ticker: 'BBCA', category: CHART }).reason, G.REJECT.MISSING_SEQ);
  assert.equal(bus.put(null).reason, G.REJECT.NOT_AN_ENTRY);
  assert.equal(bus.get('BBCA', CHART), null);
});

test('async race: a late BBCA response cannot overwrite the DSNG chart or its plan', async () => {
  const state = G.createChartState();
  const bbcaToken = state.begin('BBCA', CHART);
  const dsngToken = state.begin('DSNG', CHART);
  assert.equal(state.publish(dsngToken, { ticker: 'DSNG', candles: [{ close: 1550 }] }, { tradeDate: '2026-11-04' }).ok, true);
  assert.equal(state.read('DSNG', CHART).candles[0].close, 1550);
  assert.equal(state.read('BBCA', CHART), null);

  const published = state.publish(bbcaToken, { ticker: 'BBCA', candles: [{ close: 9860 }] }, { tradeDate: '2026-11-04' });
  assert.equal(published.ok, false, 'the late BBCA payload must be discarded');
  assert.equal(published.reason, G.REJECT.STALE_TOKEN);
  assert.equal(state.read('DSNG', CHART).candles[0].close, 1550, 'the card on screen still belongs to DSNG');
  assert.equal(state.read('BBCA', CHART), null, 'BBCA must not be readable after the switch');
});

test('async race: two in-flight responses resolve out of order, the newest wins', () => {
  const state = G.createChartState();
  const first = state.begin('BBCA', CHART);
  const second = state.begin('BBCA', CHART);
  assert.equal(state.publish(second, { ticker: 'BBCA', candles: [{ close: 9900 }] }).ok, true);
  const stale = state.publish(first, { ticker: 'BBCA', candles: [{ close: 9860 }] });
  assert.equal(stale.ok, false);
  assert.equal(state.read('BBCA', CHART).candles[0].close, 9900);
});

test('async race: a payload whose ticker disagrees with the token is refused', () => {
  const state = G.createChartState();
  const token = state.begin('BBCA', CHART);
  const result = state.publish(token, { ticker: 'DSNG', candles: [{ close: 1550 }] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, G.REJECT.IDENTITY_MISMATCH);
  assert.equal(state.read('BBCA', CHART), null);
});

test('lib/chart-state-guard.js and public/chart-state-guard.js are one module', () => {
  const viaLib = require(path.join(ROOT, 'lib', 'chart-state-guard.js'));
  const viaPublic = require(path.join(ROOT, 'public', 'chart-state-guard.js'));
  assert.equal(viaLib, viaPublic, 'lib/ must re-export the served public/ module');
});