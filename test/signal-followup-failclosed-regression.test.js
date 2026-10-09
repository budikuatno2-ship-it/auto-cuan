'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fetcher = require('../lib/chart-engine/candle-fetcher');
const sectorHot = require('../api/sector-hot');

test('candle circuit: OPEN with no cache fails closed, no repeated remote calls', async () => {
  fetcher.resetScreenerCandleCircuit();
  for (let i = 0; i < fetcher.SCREENER_REMOTE_FAILURE_THRESHOLD; i++) fetcher.noteScreenerRemoteResult(false);
  assert.equal(fetcher.getScreenerCircuitState(), 'OPEN');
  // This nonexistent ticker has no local cache. Prior code reached remote fetch.
  // Cache-hit and cache-miss now obey exactly the same OPEN gate.
  const originalFetch = global.fetch;
  let requests = 0;
  global.fetch = async () => { requests++; throw new Error('must not be reached'); };
  try {
    const value = await fetcher.fetchScreenerCandles('__NO_CACHE_OPEN_CIRCUIT__');
    assert.equal(value, null);
    assert.equal(requests, 0);
  } finally {
    global.fetch = originalFetch;
    fetcher.resetScreenerCandleCircuit();
  }
});

test('candle circuit: HALF_OPEN without cache permits one probe', async () => {
  fetcher.resetScreenerCandleCircuit();
  let time = 1000;
  fetcher.setScreenerCircuitClock(() => time);
  for (let i = 0; i < fetcher.SCREENER_REMOTE_FAILURE_THRESHOLD; i++) fetcher.noteScreenerRemoteResult(false);
  time += fetcher.SCREENER_REMOTE_COOLDOWN_MS + 1;
  assert.equal(fetcher.getScreenerCircuitState(), 'HALF_OPEN');
  const originalFetch = global.fetch;
  let requests = 0;
  global.fetch = async () => {
    requests++;
    return { ok: false, status: 503 };
  };
  try {
    await fetcher.fetchScreenerCandles('__NO_CACHE_HALF_OPEN__');
    assert.equal(requests, 1);
    assert.equal(fetcher.getScreenerCircuitState(), 'OPEN');
  } finally {
    global.fetch = originalFetch;
    fetcher.setScreenerCircuitClock(null);
    fetcher.resetScreenerCandleCircuit();
  }
});

test('NK metadata: read query error fails closed without writing', async () => {
  let writes = 0;
  const client = { from() { return {
    select() { return this; },
    eq() { return this; },
    maybeSingle() { return Promise.resolve({ data: null, error: { message: 'sqlite locked' } }); },
    upsert() { writes++; return Promise.resolve({ error: null }); }
  }; } };
  await assert.rejects(sectorHot.__test.updateNkMeta(client, { status: 'scanning' }), /NK meta read unavailable/);
  assert.equal(writes, 0);
});

test('NK metadata: thrown read failure fails closed without writing', async () => {
  let writes = 0;
  const client = { from() { return {
    select() { return this; },
    eq() { return this; },
    maybeSingle() { throw new Error('I/O failure'); },
    upsert() { writes++; return Promise.resolve({ error: null }); }
  }; } };
  await assert.rejects(sectorHot.__test.updateNkMeta(client, { status: 'scanning' }), /NK meta read unavailable/);
  assert.equal(writes, 0);
});

test('NK metadata: write error is propagated', async () => {
  const client = { from() { return {
    select() { return this; },
    eq() { return this; },
    maybeSingle() { return Promise.resolve({ data: { id: 'latest', run_date: '2026-10-09' }, error: null }); },
    upsert() { return Promise.resolve({ error: { message: 'disk full' } }); }
  }; } };
  await assert.rejects(sectorHot.__test.updateNkMeta(client, { status: 'scanning' }), /NK meta write failed: disk full/);
});
