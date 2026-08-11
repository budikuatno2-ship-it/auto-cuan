'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeFakeSupabase } = require('./helpers/fake-supabase');
const { attachShadowContext } = require('../lib/fast-watcher-daily-context-shadow');

// Safety requirement: the frozen Fast Watcher persistence/confirmation
// candidate (commit 680ec37c) must never change when
// FAST_WATCHER_DAILY_CONTEXT_ENABLED is disabled (the default).

test('flag disabled (default): candidates array is returned unchanged, by reference', async () => {
  const candidates = [{ ticker: 'BBCA', score: 82, persistence: 74 }, { ticker: 'TLKM', score: 55, persistence: 40 }];
  const supabase = makeFakeSupabase({});

  const result = await attachShadowContext(supabase, candidates, {}); // no forceEnabled -> reads env default (false)

  assert.equal(result.enabled, false);
  assert.strictEqual(result.candidates, candidates); // same reference, not a copy
  assert.deepEqual(result.candidates, [
    { ticker: 'BBCA', score: 82, persistence: 74 },
    { ticker: 'TLKM', score: 55, persistence: 40 }
  ]);
});

test('flag disabled: no Supabase calls are made at all', async () => {
  const candidates = [{ ticker: 'BBCA', score: 82 }];
  let calls = 0;
  const trackingSupabase = { from() { calls++; return {}; } };

  await attachShadowContext(trackingSupabase, candidates, {});
  assert.equal(calls, 0);
});

test('flag enabled (explicit override, research/shadow use only): original fields are untouched, only a namespaced key is added', async () => {
  const candidates = [{ ticker: 'BBCA', score: 82, persistence: 74 }];
  const supabase = makeFakeSupabase({
    stock_daily_history: [{ ticker: 'BBCA', trade_date: '2026-08-11', close: 9500, volume: 1000, data_source: 'yahoo', data_quality_status: 'ok' }]
  });

  const result = await attachShadowContext(supabase, candidates, { forceEnabled: true });

  assert.equal(result.enabled, true);
  assert.equal(result.candidates[0].ticker, 'BBCA');
  assert.equal(result.candidates[0].score, 82);
  assert.equal(result.candidates[0].persistence, 74);
  assert.ok('_shadowDailyContext' in result.candidates[0]);
  // Original candidates array/objects must remain untouched (new objects returned).
  assert.equal('_shadowDailyContext' in candidates[0], false);
});
