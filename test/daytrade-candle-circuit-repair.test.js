'use strict';
// BUG-DT-CIRCUIT-LATCH regression suite (2026-10-09).
const test = require('node:test');
const assert = require('node:assert/strict');
const fetcher = require('../lib/chart-engine/candle-fetcher');

test('DT-04: circuit opens after configured consecutive failures (not a boolean latch)', () => {
  fetcher.resetScreenerCandleCircuit();
  assert.equal(fetcher.getScreenerCircuitState(), 'CLOSED');
  const threshold = fetcher.SCREENER_REMOTE_FAILURE_THRESHOLD;
  for (let i = 0; i < threshold; i++) fetcher.noteScreenerRemoteResult(false);
  assert.equal(fetcher.getScreenerCircuitState(), 'OPEN');
  assert.equal(fetcher.screenerRemoteCircuitOpen(), true);
});

test('DT-06: after cooldown the breaker becomes HALF_OPEN (probe allowed)', () => {
  fetcher.resetScreenerCandleCircuit();
  let nowMs = 1000000;
  fetcher.setScreenerCircuitClock(() => nowMs);
  try {
    const threshold = fetcher.SCREENER_REMOTE_FAILURE_THRESHOLD;
    for (let i = 0; i < threshold; i++) fetcher.noteScreenerRemoteResult(false);
    assert.equal(fetcher.getScreenerCircuitState(), 'OPEN');

    // Before cooldown: still OPEN.
    nowMs += fetcher.SCREENER_REMOTE_COOLDOWN_MS - 1000;
    assert.equal(fetcher.getScreenerCircuitState(), 'OPEN');

    // After cooldown: HALF_OPEN — one probe allowed.
    nowMs += 2000;
    assert.equal(fetcher.getScreenerCircuitState(), 'HALF_OPEN');
    assert.equal(fetcher.tryAcquireScreenerHalfOpenProbe(), true, 'first probe allowed');
    assert.equal(fetcher.tryAcquireScreenerHalfOpenProbe(), false, 'second concurrent probe denied');
    fetcher.releaseScreenerHalfOpenProbe();
  } finally {
    fetcher.setScreenerCircuitClock(null);
    fetcher.resetScreenerCandleCircuit();
  }
});

test('DT-07: a successful probe closes the breaker', () => {
  fetcher.resetScreenerCandleCircuit();
  let nowMs = 5000000;
  fetcher.setScreenerCircuitClock(() => nowMs);
  try {
    const threshold = fetcher.SCREENER_REMOTE_FAILURE_THRESHOLD;
    for (let i = 0; i < threshold; i++) fetcher.noteScreenerRemoteResult(false);
    nowMs += fetcher.SCREENER_REMOTE_COOLDOWN_MS + 1;
    assert.equal(fetcher.getScreenerCircuitState(), 'HALF_OPEN');
    fetcher.noteScreenerRemoteResult(true);
    assert.equal(fetcher.getScreenerCircuitState(), 'CLOSED');
    assert.equal(fetcher.getScreenerRemoteFailureCount(), 0);
  } finally {
    fetcher.setScreenerCircuitClock(null);
    fetcher.resetScreenerCandleCircuit();
  }
});

test('DT-08: a failed HALF_OPEN probe reopens the breaker and restarts cooldown', () => {
  fetcher.resetScreenerCandleCircuit();
  let nowMs = 9000000;
  fetcher.setScreenerCircuitClock(() => nowMs);
  try {
    const threshold = fetcher.SCREENER_REMOTE_FAILURE_THRESHOLD;
    for (let i = 0; i < threshold; i++) fetcher.noteScreenerRemoteResult(false);
    nowMs += fetcher.SCREENER_REMOTE_COOLDOWN_MS + 1;
    assert.equal(fetcher.getScreenerCircuitState(), 'HALF_OPEN');
    fetcher.noteScreenerRemoteResult(false); // probe failed
    assert.equal(fetcher.getScreenerCircuitState(), 'OPEN', 'failed probe reopens');
    nowMs += 1000;
    assert.equal(fetcher.getScreenerCircuitState(), 'OPEN', 'cooldown restarted');
  } finally {
    fetcher.setScreenerCircuitClock(null);
    fetcher.resetScreenerCandleCircuit();
  }
});

test('DT-05: OPEN state avoids retry storm (no probe acquisition while cooling down)', () => {
  fetcher.resetScreenerCandleCircuit();
  let nowMs = 20000000;
  fetcher.setScreenerCircuitClock(() => nowMs);
  try {
    const threshold = fetcher.SCREENER_REMOTE_FAILURE_THRESHOLD;
    for (let i = 0; i < threshold; i++) fetcher.noteScreenerRemoteResult(false);
    assert.equal(fetcher.tryAcquireScreenerHalfOpenProbe(), false, 'no probe while OPEN');
    nowMs += fetcher.SCREENER_REMOTE_COOLDOWN_MS + 1;
    assert.equal(fetcher.tryAcquireScreenerHalfOpenProbe(), true);
    fetcher.releaseScreenerHalfOpenProbe();
  } finally {
    fetcher.setScreenerCircuitClock(null);
    fetcher.resetScreenerCandleCircuit();
  }
});

test('DT-09: separate batches do not permanently latch remote access (success resets failures)', () => {
  fetcher.resetScreenerCandleCircuit();
  fetcher.noteScreenerRemoteResult(false);
  fetcher.noteScreenerRemoteResult(false);
  assert.equal(fetcher.getScreenerRemoteFailureCount(), 2);
  fetcher.noteScreenerRemoteResult(true);
  assert.equal(fetcher.getScreenerRemoteFailureCount(), 0);
  assert.equal(fetcher.getScreenerCircuitState(), 'CLOSED');
});

test('DT-10: fallback provenance retained (fetchScreenerCandles returns disk cache when remote fails)', async () => {
  // No cache file in test env: function must return null without throwing.
  const result = await fetcher.fetchScreenerCandles('__NO_SUCH_TICKER__', { minCandles: 20 });
  assert.equal(result, null);
});
