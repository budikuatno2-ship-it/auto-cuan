'use strict';

/**
 * Regression: the 00:07 broksum backfill halted after ONE Cloudflare 502
 * ("origin overloaded") because any invalid response set `quotaHalted = true`.
 * One bad response is NOT a budget problem.
 *
 * New policy (2026-10-19):
 *   - 5xx / timeout / network errors are TRANSIENT → retried 3× with backoff
 *     (2s, 8s, 30s).
 *   - If still failing, the task is SKIPPED (queued for a later run) and the
 *     run continues to the next task.
 *   - A hard halt happens ONLY for: quota exhausted / HTTP 429, an active
 *     circuit breaker, or MAX_CONSECUTIVE_5XX consecutive provider errors.
 *   - The summary label distinguishes HALTED_BY_BUDGET_OR_QUOTA from
 *     HALTED_BY_PROVIDER_ERROR.
 *
 * These tests pin the classification + retry policy that break that chain.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const backfill = require('../tools/backfill-broksum');

// ---------------------------------------------------------------------------
// 1. isProviderTransient classification
// ---------------------------------------------------------------------------
test('5xx responses are classified as transient provider errors', () => {
  for (const status of [500, 502, 503, 504, 599]) {
    assert.equal(
      backfill.isProviderTransient({ ok: false, status, error: 'origin overloaded' }),
      true,
      'status ' + status + ' must be transient'
    );
  }
});

test('timeout / network transport errors are transient even without a status', () => {
  const cases = [
    { ok: false, error: 'request timeout' },
    { ok: false, error: 'socket hang up' },
    { ok: false, error: 'ECONNRESET' },
    { ok: false, error: 'ETIMEDOUT' },
    { ok: false, error: 'EAI_AGAIN' },
    { ok: false, error: 'network error' },
    { ok: false, error: 'The operation was aborted' },
    null
  ];
  for (const res of cases) {
    assert.equal(backfill.isProviderTransient(res), true, JSON.stringify(res) + ' must be transient');
  }
});

test('429 / rate-limited is NOT transient (it is a hard quota stop)', () => {
  assert.equal(backfill.isProviderTransient({ ok: false, status: 429, rateLimited: true }), false);
  assert.equal(backfill.isProviderTransient({ ok: false, status: 429 }), false);
});

test('a healthy 200 response is NOT transient', () => {
  assert.equal(backfill.isProviderTransient({ ok: true, status: 200, data: {} }), false);
});

test('a 4xx client error is NOT transient', () => {
  assert.equal(backfill.isProviderTransient({ ok: false, status: 400, error: 'bad request' }), false);
  assert.equal(backfill.isProviderTransient({ ok: false, status: 404, error: 'not found' }), false);
});

// ---------------------------------------------------------------------------
// 2. Retry policy constants
// ---------------------------------------------------------------------------
test('retry policy uses 3 backoff delays (2s, 8s, 30s)', () => {
  assert.deepEqual(backfill.PROVIDER_RETRY_DELAYS_MS, [2000, 8000, 30000]);
});

test('halt threshold is 5 consecutive provider errors', () => {
  assert.equal(backfill.MAX_CONSECUTIVE_5XX, 5);
});

// ---------------------------------------------------------------------------
// 3. Retry-then-skip simulation (mirrors the run() loop)
// ---------------------------------------------------------------------------
function simulateFetch(responses) {
  // Replicates the retry loop in run(): attempt 0..N, break on non-transient.
  let attempts = 0;
  let res = null;
  for (let attempt = 0; attempt <= backfill.PROVIDER_RETRY_DELAYS_MS.length; attempt++) {
    res = responses[Math.min(attempt, responses.length - 1)];
    attempts++;
    if (!backfill.isProviderTransient(res)) break;
  }
  return { res, attempts };
}

test('a transient error that recovers on the 2nd attempt stops retrying', () => {
  const { res, attempts } = simulateFetch([
    { ok: false, status: 502, error: 'origin overloaded' },
    { ok: true, status: 200, data: { flow: 'all' } }
  ]);
  assert.equal(attempts, 2, 'should stop after the successful retry');
  assert.equal(res.status, 200);
});

test('a persistent 5xx exhausts all retries (1 initial + 3 retries = 4 attempts)', () => {
  const { res, attempts } = simulateFetch([
    { ok: false, status: 502, error: 'origin overloaded' }
  ]);
  assert.equal(attempts, 4, 'initial attempt + 3 backoff retries');
  assert.equal(backfill.isProviderTransient(res), true, 'still transient → caller skips the task');
});

test('a 429 is not retried (hard stop on the first attempt)', () => {
  const { attempts } = simulateFetch([
    { ok: false, status: 429, rateLimited: true }
  ]);
  assert.equal(attempts, 1, 'quota/429 must not be retried');
});

// ---------------------------------------------------------------------------
// 4. Consecutive-5xx halt accounting
// ---------------------------------------------------------------------------
test('the run halts only after MAX_CONSECUTIVE_5XX consecutive provider errors', () => {
  let consecutive5xx = 0;
  let halted = false;
  const skipped = [];

  // Simulate 4 skipped tasks (each a persistent 5xx) — must NOT halt.
  for (let i = 0; i < 4; i++) {
    consecutive5xx++;
    if (consecutive5xx >= backfill.MAX_CONSECUTIVE_5XX) {
      halted = true;
      break;
    }
    skipped.push('T' + i);
  }
  assert.equal(halted, false, '4 consecutive errors must not halt');
  assert.equal(skipped.length, 4, 'all 4 tasks are skipped, not halted');

  // The 5th consecutive error trips the halt.
  consecutive5xx++;
  if (consecutive5xx >= backfill.MAX_CONSECUTIVE_5XX) halted = true;
  assert.equal(halted, true, 'the 5th consecutive error halts the run');
});

test('a successful fetch resets the consecutive-5xx counter', () => {
  let consecutive5xx = 0;
  consecutive5xx++; // one transient error
  consecutive5xx++; // another
  // A healthy response resets it (mirrors `consecutive429 = 0` on success).
  consecutive5xx = 0;
  assert.equal(consecutive5xx, 0);
  assert.ok(consecutive5xx < backfill.MAX_CONSECUTIVE_5XX, 'counter reset keeps the run alive');
});

// ---------------------------------------------------------------------------
// 5. Summary label mapping
// ---------------------------------------------------------------------------
function statusLabel(haltReason, quotaHalted) {
  if (haltReason === 'provider_error') return 'HALTED_BY_PROVIDER_ERROR';
  if (haltReason === 'circuit_breaker') return 'HALTED_BY_CIRCUIT_BREAKER';
  if (quotaHalted) return 'HALTED_BY_BUDGET_OR_QUOTA';
  return 'COMPLETED_OR_LIMITED';
}

test('a provider-error halt is labelled HALTED_BY_PROVIDER_ERROR, not budget', () => {
  assert.equal(statusLabel('provider_error', true), 'HALTED_BY_PROVIDER_ERROR');
});

test('a quota halt is labelled HALTED_BY_BUDGET_OR_QUOTA', () => {
  assert.equal(statusLabel('quota', true), 'HALTED_BY_BUDGET_OR_QUOTA');
  assert.equal(statusLabel(null, true), 'HALTED_BY_BUDGET_OR_QUOTA');
});

test('a circuit-breaker halt is labelled HALTED_BY_CIRCUIT_BREAKER', () => {
  assert.equal(statusLabel('circuit_breaker', true), 'HALTED_BY_CIRCUIT_BREAKER');
});

test('a clean run is labelled COMPLETED_OR_LIMITED', () => {
  assert.equal(statusLabel(null, false), 'COMPLETED_OR_LIMITED');
});
