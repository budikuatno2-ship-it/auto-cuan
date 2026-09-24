'use strict';

/**
 * AUDIT FASE 9 — Fast Watcher Engine, Real-time Pipeline Gates, & Rejection Rules.
 *
 * Test-first verification of the rejection/gate defects found by line-by-line
 * audit of the real runtime chain:
 *
 *   tools/intraday-sample-collector.js  (tick source)
 *     -> lib/daytrade-screener-engine.js
 *     -> lib/intraday-volume-pace.js
 *     -> lib/intraday-fast-watcher-live.js     (snapshot collection)
 *     -> lib/intraday-fast-watcher-pool.js     (2-of-3 confirmation gate)
 *          -> lib/intraday-fast-watcher-momentum.js  (scoring + rejection rules)
 *     -> lib/intraday-fast-watcher-publisher.js / telegram-templates.js
 *
 * Each test below FAILS on the pre-fix code and documents the real-world
 * trigger (PostgREST/JSON string booleans, ARA/ARB zero bid queues, tick
 * bursts, transient feed loss).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const momentum = require('../lib/intraday-fast-watcher-momentum');
const watcher = require('../lib/intraday-fast-watcher');
const pool = require('../lib/intraday-fast-watcher-pool');
const templates = require('../lib/telegram-templates');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function poolObs(overrides) {
  return Object.assign({
    ticker: 'AAAA',
    production_eligible: true,
    entry_low: 990,
    entry_high: 1010,
    stop_loss: 950,
    tp1: 1100,
    relative_volume: 2,
    high: 1010,
    low: 995,
    open: 995,
    volume: 500000,
    risk_reward: 2,
    board: 'UTAMA'
  }, overrides || {});
}

const POOL_ROWS = [{ ticker: 'AAAA', source_rank: 1, score: 50, board: 'UTAMA' }];

function runPool(priorState, scheduledTime, observation) {
  return pool.process({
    sampleDate: '2026-09-23',
    scheduledTime,
    shortlistRows: POOL_ROWS,
    observations: [observation],
    priorState,
    now: '2026-09-23T02:00:00Z'
  });
}

// ===========================================================================
// BUG F9-01 — Boolean-like payload flags rejected (string vs boolean)
// ===========================================================================
// The collector/screener pipeline forwards JSON payloads where booleans arrive
// as 'true'/'false' strings (PostgREST) or 1/0. `=== true` comparisons silently
// downgraded a genuinely READY engine payload to `unknown`, so the candidate
// could never accumulate confirmations.
test('F9-01 momentum.explicitReady accepts boolean-like production_eligible/ready', () => {
  assert.deepEqual(
    momentum.explicitReady({ production_eligible: 'true' }),
    { value: true, source: 'production_eligible', status: 'PRODUCTION_ELIGIBLE' }
  );
  assert.deepEqual(
    momentum.explicitReady({ production_eligible: 1 }),
    { value: true, source: 'production_eligible', status: 'PRODUCTION_ELIGIBLE' }
  );
  assert.deepEqual(
    momentum.explicitReady({ ready: 'true' }),
    { value: true, source: 'ready', status: 'READY' }
  );
  // Explicit negatives must still fail closed.
  assert.equal(momentum.explicitReady({ production_eligible: 'false' }).value, false);
  assert.equal(momentum.explicitReady({ production_eligible: 0 }).value, false);
});

test('F9-01b watcher.explicitReady accepts boolean-like production_eligible', () => {
  assert.deepEqual(
    watcher.explicitReady({ production_eligible: 'true' }),
    { value: true, source: 'production_eligible' }
  );
  assert.deepEqual(
    watcher.explicitReady({ ready: 'true' }),
    { value: true, source: 'ready' }
  );
  assert.equal(watcher.explicitReady({ production_eligible: 'false' }).value, false);
});

test('F9-01c pool: a string-typed production_eligible still confirms like a boolean one', () => {
  const stringState = ['09:45', '09:46', '09:47'].reduce((state, time) => (
    runPool(state, time, poolObs({ scheduled_time: time, current_price: 1000, production_eligible: 'true' })).state
  ), null);
  const boolState = ['09:45', '09:46', '09:47'].reduce((state, time) => (
    runPool(state, time, poolObs({ scheduled_time: time, current_price: 1000, production_eligible: true })).state
  ), null);

  assert.equal(boolState.tickers.AAAA.status, 'READY_CONFIRMED');
  assert.equal(
    stringState.tickers.AAAA.status,
    'READY_CONFIRMED',
    'string boolean must not be silently downgraded to engine_class=unknown'
  );
});

// ===========================================================================
// BUG F9-02 — Stale feed flag as a string bypasses the freshness gate
// ===========================================================================
// `is_stale === true` misses `'true'`. A stale quote was therefore scored and
// confirmed as if it were fresh — the opposite of the documented fail-closed
// freshness contract.
test('F9-02 momentum treats a string stale flag as stale', () => {
  assert.equal(momentum.metricsFrom({ is_stale: 'true' }).stale, true);
  assert.equal(momentum.metricsFrom({ data_stale: 'true' }).stale, true);
  assert.equal(momentum.metricsFrom({ freshness: { is_stale: 'true' } }).stale, true);
  assert.equal(momentum.metricsFrom({ is_stale: true }).stale, true);
  // Explicit negatives stay fresh.
  assert.equal(momentum.metricsFrom({ is_stale: 'false' }).stale, false);
  assert.equal(momentum.metricsFrom({ is_stale: false }).stale, false);
});

test('F9-02b momentum.evaluate rejects a string-stale observation', () => {
  const result = momentum.evaluate({
    ticker: 'AAAA', scheduled_time: '10:00', production_eligible: true,
    current_price: 1000, entry_low: 990, entry_high: 1010, stop_loss: 950, tp1: 1100,
    relative_volume: 2, high: 1010, low: 995, open: 995, volume: 500000, risk_reward: 2,
    is_stale: 'true'
  }, { first_price: 995, board: 'UTAMA' });
  assert.equal(result.status, 'STALE');
  assert.equal(result.passes, false);
});

// ===========================================================================
// BUG F9-03 — watcher.observationMetrics rejects numeric strings
// ===========================================================================
// The shadow watcher used a strict `typeof value === 'number'` guard, so any
// numeric string price produced `invalid_current_price` / `INVALID_DATA` —
// a false rejection that also poisoned the anti-chase baseline.
test('F9-03 watcher.observationMetrics coerces numeric strings', () => {
  const metrics = watcher.observationMetrics({
    current_price: '1500', entry_low: '1490', entry_high: '1510',
    tp1: '1560', stop_loss: '1450'
  });
  assert.equal(metrics.current_price, 1500);
  assert.equal(metrics.entry_low, 1490);
  assert.equal(metrics.entry_high, 1510);
  assert.equal(metrics.tp1, 1560);
  assert.equal(metrics.stop_loss, 1450);
});

test('F9-03b watcher.evaluateObservation passes a numeric-string observation', () => {
  const result = watcher.evaluateObservation({
    current_price: '1500', entry_low: '1490', entry_high: '1510',
    tp1: '1560', stop_loss: '1450', production_eligible: true
  }, { first_price: 1495 });
  assert.equal(result.passes, true);
  assert.equal(result.status, 'READY_PASS');
  assert.deepEqual(result.reasons, []);
});

// ===========================================================================
// BUG F9-04 — Numeric strings defeat prespike / early-momentum radar detection
// ===========================================================================
test('F9-04 isPrespikeRadar and isEarlyMomentum accept numeric-string ratios', () => {
  assert.equal(momentum.isPrespikeRadar({ change_pct: 0.5, volume_ratio_20d: '3.0' }), true);
  assert.equal(momentum.isPrespikeRadar({ change_pct: 0.5, volume_ratio_20d: 3.0 }), true);
  assert.equal(momentum.isEarlyMomentum({ change_pct: 3.0, volume_ratio_20d: '2.5' }), true);
  assert.equal(momentum.isEarlyMomentum({ change_pct: 3.0, volume_ratio_20d: 2.5 }), true);
  // Thresholds must still be enforced for out-of-range values.
  assert.equal(momentum.isPrespikeRadar({ change_pct: 9.0, volume_ratio_20d: '3.0' }), false);
  assert.equal(momentum.isEarlyMomentum({ change_pct: 3.0, volume_ratio_20d: '1.0' }), false);
});

// ===========================================================================
// BUG F9-05 — Same-minute tick burst confirms instantly (in-flight collision)
// ===========================================================================
// The confirmation window counted every passing observation, not every distinct
// observation MINUTE. A burst of ticks arriving inside the same minute (a data
// spike / retry storm) therefore satisfied REQUIRED_CONFIRMATIONS instantly,
// defeating the "distinct consecutive confirmations" contract.
test('F9-05 a same-minute tick burst cannot reach READY_CONFIRMED', () => {
  let state = null;
  const statuses = [];
  for (let index = 0; index < 5; index += 1) {
    // Distinct observation keys (distinct turnover) but the SAME minute.
    const result = runPool(state, '09:45', poolObs({
      scheduled_time: '09:45', current_price: 1000, turnover: 1000000 + index
    }));
    state = result.state;
    statuses.push(state.tickers.AAAA.status);
  }
  assert.ok(
    statuses.every(status => status !== 'READY_CONFIRMED'),
    `burst of same-minute ticks must never confirm; got ${JSON.stringify(statuses)}`
  );
  assert.equal(state.tickers.AAAA.status, 'READY_PENDING');
});

test('F9-05b distinct minutes still confirm normally', () => {
  let state = null;
  for (const time of ['09:45', '09:46', '09:47']) {
    state = runPool(state, time, poolObs({ scheduled_time: time, current_price: 1000 })).state;
  }
  assert.equal(state.tickers.AAAA.status, 'READY_CONFIRMED');
  assert.equal(state.tickers.AAAA.ready_streak, 3);
});

// ===========================================================================
// BUG F9-06 — One transient stale tick terminates the whole watch cycle
// ===========================================================================
// A feed hiccup of a few seconds (single stale read) immediately produced a
// terminal STALE status and evicted the tracker from the active pool, with no
// measurable grace period. Worse, the eviction reset `first_price`, so the
// anti-chase baseline was rebuilt at the ALREADY ADVANCED price.
test('F9-06 a single stale tick is tolerated instead of dropping the tracker', () => {
  let state = null;
  state = runPool(state, '09:45', poolObs({ scheduled_time: '09:45', current_price: 1000 })).state;
  state = runPool(state, '09:46', poolObs({ scheduled_time: '09:46', current_price: 1000 })).state;
  const before = state.tickers.AAAA.first_price;

  const staleRun = runPool(state, '09:47', poolObs({
    scheduled_time: '09:47', current_price: 1000, freshness: { is_stale: true }
  }));
  state = staleRun.state;

  assert.equal(state.tickers.AAAA.active, true, 'one stale read must not evict the tracker');
  assert.notEqual(state.tickers.AAAA.status, 'DROPPED_FROM_WATCH_POOL');
  assert.equal(state.tickers.AAAA.first_price, before, 'anti-chase baseline must survive a feed hiccup');
  assert.ok(
    (state.tickers.AAAA.last_reasons || []).includes('stale_grace_pending'),
    'the grace period must be reported honestly in rejected_reason'
  );
});

test('F9-06b a sustained stale feed still fails closed', () => {
  let state = null;
  state = runPool(state, '09:45', poolObs({ scheduled_time: '09:45', current_price: 1000 })).state;
  for (const time of ['09:46', '09:47', '09:48']) {
    state = runPool(state, time, poolObs({
      scheduled_time: time, current_price: 1000, freshness: { is_stale: true }
    })).state;
  }
  assert.equal(state.tickers.AAAA.status, 'DROPPED_FROM_WATCH_POOL');
  assert.equal(state.tickers.AAAA.active, false);
});

// ===========================================================================
// BUG F9-07 — Chase guard baseline reset after a transient stale drop
// ===========================================================================
// Because the tracker was re-created on re-entry, `first_price` became the
// post-spike price and the +6% adaptive advance guard was silently defeated.
test('F9-07 transient stale must not reset the adaptive chase guard', () => {
  // Entry zone deliberately wide enough that the advanced price is still
  // INSIDE it: only the adaptive +6% advance guard can catch this chase.
  const wideZone = { entry_low: 990, entry_high: 1090, tp1: 1400 };
  let state = null;
  state = runPool(state, '09:45', poolObs(Object.assign({ scheduled_time: '09:45', current_price: 1000 }, wideZone))).state;
  state = runPool(state, '09:46', poolObs(Object.assign({ scheduled_time: '09:46', current_price: 1085 }, wideZone))).state;
  assert.equal(state.tickers.AAAA.status, 'SPIKE_RADAR', '+8.5% must be flagged as chase');
  assert.ok(state.tickers.AAAA.last_reasons.includes('adaptive_advance_chase'));

  state = runPool(state, '09:47', poolObs(Object.assign({
    scheduled_time: '09:47', current_price: 1085, freshness: { is_stale: true }
  }, wideZone))).state;

  const recovered = runPool(state, '09:48', poolObs(Object.assign({ scheduled_time: '09:48', current_price: 1086 }, wideZone)));
  assert.equal(
    recovered.state.tickers.AAAA.first_price,
    1000,
    'the anti-chase baseline must remain the original first observed price'
  );
  assert.notEqual(
    recovered.state.tickers.AAAA.status,
    'READY_PENDING',
    '+8.6% above the original first_price must never become entry-eligible'
  );
});

// ===========================================================================
// BUG F9-08 — ARB / zero bid queue reported as "Bid Dominant"
// ===========================================================================
// `r.bid_offer_dominance || r.bid_dominance || ...` collapsed a legitimate
// numeric 0 (empty bid queue = ARB, or a fully offer-dominated book) into the
// falsy branch, so the Telegram card asserted "Bid Dominant" — the exact
// opposite of the real order book.
test('F9-08 zero bid dominance is reported honestly, not as "Bid Dominant"', () => {
  const base = {
    ticker: 'AAAA', status: 'CONFIRMED_BUY', last_price: 1000,
    entry_low: 990, entry_high: 1010, stop_loss: 950, tp1: 1100,
    volume_ratio_20d: 2, risk_reward: 2, change_pct: 1.5
  };
  function dominanceLine(extra) {
    const message = templates.formatDayTradeSignalMessage([Object.assign({}, base, extra)]);
    return String(message).split('\n').find(line => line.indexOf('Dominasi Bid/Offer:') >= 0) || '';
  }

  const arb = dominanceLine({ bid_dominance: 0 });
  assert.match(arb, /Dominasi Bid\/Offer:/);
  assert.ok(
    !/Bid Dominant/.test(arb),
    `an empty bid queue must not be labelled Bid Dominant; got ${JSON.stringify(arb)}`
  );
  assert.match(arb, /Offer/);

  // A bid-dominated book must still read as bid-dominant.
  assert.match(dominanceLine({ bid_dominance: 0.72 }), /Bid/);
  assert.match(dominanceLine({ bid_dominance: 72 }), /Bid/);

  // Free-text labels must pass through untouched (existing contract).
  assert.match(
    dominanceLine({ bid_offer_dominance: 'Bid 65% (Dominan)' }),
    /Bid 65% \(Dominan\)/
  );
});
