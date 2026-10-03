'use strict';

/**
 * Wave 2 — EOD terminal-state taxonomy, retry machine and session activity
 * classification contract (W2-04/W2-06/W2-08).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const eod = require('../lib/eod-session-state');
const { EOD_STATES, RETRY_POLICY, SESSION_STATES } = eod;

test('W2-04: zero-volume target-date candle classifies as NO_TRADE (terminal)', () => {
  const state = eod.classifyBrokerOutcome({
    hasRows: false,
    candleAvailable: true,
    candleVolume: 0,
    isFinal: false
  });
  assert.equal(state, EOD_STATES.NO_TRADE);
  assert.equal(eod.isTerminal(state), true);
});

test('W2-04: a traded ticker with an empty provider response is NEVER NO_TRADE (TCID regression)', () => {
  // TCID 2026-10-01: volume 200, close 2600, broker summary empty.
  const nonFinal = eod.classifyBrokerOutcome({
    hasRows: false,
    candleAvailable: true,
    candleVolume: 200,
    isFinal: false
  });
  assert.equal(nonFinal, EOD_STATES.PENDING_PROVIDER);
  assert.notEqual(nonFinal, EOD_STATES.NO_TRADE);

  const final = eod.classifyBrokerOutcome({
    hasRows: false,
    candleAvailable: true,
    candleVolume: 200,
    isFinal: true
  });
  assert.equal(final, EOD_STATES.BROKER_DATA_UNAVAILABLE);
  assert.notEqual(final, EOD_STATES.NO_TRADE);
});

test('W2-04: empty response with no candle evidence stays retryable, then terminal-unavailable on --final', () => {
  assert.equal(eod.classifyBrokerOutcome({ hasRows: false, candleAvailable: false, candleVolume: null, isFinal: false }), EOD_STATES.PENDING_PROVIDER);
  assert.equal(eod.classifyBrokerOutcome({ hasRows: false, candleAvailable: false, candleVolume: null, isFinal: true }), EOD_STATES.BROKER_DATA_UNAVAILABLE);
});

test('W2-04: broker rows present is always COMPLETE regardless of finality', () => {
  assert.equal(eod.classifyBrokerOutcome({ hasRows: true, candleAvailable: true, candleVolume: 0, isFinal: false }), EOD_STATES.COMPLETE);
  assert.equal(eod.classifyBrokerOutcome({ hasRows: true, candleAvailable: false, candleVolume: null, isFinal: true }), EOD_STATES.COMPLETE);
});

test('W2-06: retry policy table — NO_TRADE and BROKER_DATA_UNAVAILABLE are terminal, never retried', () => {
  assert.deepEqual(RETRY_POLICY[EOD_STATES.NO_TRADE], { retry: false, auxiliary: false, terminal: true });
  assert.deepEqual(RETRY_POLICY[EOD_STATES.BROKER_DATA_UNAVAILABLE], { retry: false, auxiliary: false, terminal: true });
  assert.equal(eod.shouldRetry(EOD_STATES.NO_TRADE), false);
  assert.equal(eod.shouldRetry(EOD_STATES.BROKER_DATA_UNAVAILABLE), false);
  assert.equal(eod.shouldRetry(EOD_STATES.PENDING_PROVIDER), true);
  assert.equal(eod.shouldRetry(EOD_STATES.UPSTREAM_ERROR), true);
  assert.equal(eod.shouldRetry(EOD_STATES.COMPLETE), false);
});

test('W2-05: auxiliary requests are only allowed for COMPLETE (same-day), never for terminal/pending states', () => {
  assert.equal(eod.auxiliaryAllowed(EOD_STATES.COMPLETE), true);
  for (const state of [EOD_STATES.NO_TRADE, EOD_STATES.BROKER_DATA_UNAVAILABLE, EOD_STATES.PENDING_PROVIDER, EOD_STATES.UPSTREAM_ERROR]) {
    assert.equal(eod.auxiliaryAllowed(state), false, `${state} must not spend auxiliary quota`);
  }
});

test('W2-04: transport failures classify as UPSTREAM_ERROR, never as provider no-data', () => {
  const state = eod.classifyTransportFailure();
  assert.equal(state, EOD_STATES.UPSTREAM_ERROR);
  assert.notEqual(state, EOD_STATES.NO_TRADE);
  assert.notEqual(state, EOD_STATES.BROKER_DATA_UNAVAILABLE);
});

test('W2-08: session activity classification never infers delisting from one zero-volume day', () => {
  assert.equal(eod.classifySessionActivity({ candleAvailable: true, candleVolume: 0 }), SESSION_STATES.NO_TRADE);
  assert.equal(eod.classifySessionActivity({ candleAvailable: true, candleVolume: 12345 }), SESSION_STATES.TRADED);
  assert.equal(eod.classifySessionActivity({ candleAvailable: false, candleVolume: null }), SESSION_STATES.UNKNOWN);
  // SUSPENDED/INACTIVE/DELISTED exist in the vocabulary but are never produced
  // by this classifier — they require an authoritative date-scoped source.
  const produced = new Set([
    eod.classifySessionActivity({ candleAvailable: true, candleVolume: 0 }),
    eod.classifySessionActivity({ candleAvailable: true, candleVolume: 5 }),
    eod.classifySessionActivity({ candleAvailable: false, candleVolume: null })
  ]);
  assert.equal(produced.has(SESSION_STATES.SUSPENDED), false);
  assert.equal(produced.has(SESSION_STATES.DELISTED), false);
});

test('W2-06: every state has an explicit policy and unknown states are rejected', () => {
  for (const state of Object.values(EOD_STATES)) {
    assert.ok(RETRY_POLICY[state], `policy missing for ${state}`);
    assert.equal(typeof RETRY_POLICY[state].retry, 'boolean');
    assert.equal(typeof RETRY_POLICY[state].auxiliary, 'boolean');
    assert.equal(typeof RETRY_POLICY[state].terminal, 'boolean');
  }
  assert.equal(eod.isKnownState('NOT_A_STATE'), false);
  assert.equal(eod.shouldRetry('NOT_A_STATE'), false, 'unknown state must never be retryable');
});
