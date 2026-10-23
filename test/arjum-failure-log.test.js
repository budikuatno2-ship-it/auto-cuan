'use strict';

/**
 * B1 (2026-10-20): Arjum failure classification + run summary.
 *
 * Regression guard for the 2026-10-19 incident: 921 broker-summary requests
 * failed with 0 persisted and NO error kind recorded. These tests pin the
 * classification + summary so a future run always records the failure KIND.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const flog = require('../lib/arjum-failure-log');

test('classifyArjumFailure distinguishes rate_limit / 5xx / transport / auth / 4xx / parse', () => {
  assert.equal(flog.classifyArjumFailure({ ok: false, status: 429, error: 'HTTP 429' }).kind, 'rate_limited');
  assert.equal(flog.classifyArjumFailure({ ok: false, status: 429, rateLimited: true }).kind, 'rate_limited');
  assert.equal(flog.classifyArjumFailure({ ok: false, error: 'quota exceeded' }).kind, 'rate_limited');

  assert.equal(flog.classifyArjumFailure({ ok: false, status: 502, error: 'origin overloaded' }).kind, 'provider_5xx');
  assert.equal(flog.classifyArjumFailure({ ok: false, status: 530 }).kind, 'provider_5xx');
  assert.equal(flog.classifyArjumFailure({ ok: false, status: 503 }).kind, 'provider_5xx');

  assert.equal(flog.classifyArjumFailure({ ok: false, status: 504, error: 'Request timeout ke stock.arjum.com' }).kind, 'transport');
  assert.equal(flog.classifyArjumFailure({ ok: false, error: 'socket hang up' }).kind, 'transport');
  assert.equal(flog.classifyArjumFailure({ ok: false, error: 'ECONNRESET' }).kind, 'transport');
  assert.equal(flog.classifyArjumFailure({ ok: false, error: 'fetch failed' }).kind, 'transport');

  assert.equal(flog.classifyArjumFailure({ ok: false, status: 401 }).kind, 'auth');
  assert.equal(flog.classifyArjumFailure({ ok: false, status: 403 }).kind, 'auth');

  assert.equal(flog.classifyArjumFailure({ ok: false, status: 404, error: 'HTTP 404' }).kind, 'client_4xx');
  assert.equal(flog.classifyArjumFailure({ ok: false, status: 422 }).kind, 'client_4xx');

  assert.equal(flog.classifyArjumFailure({ ok: false, status: 200, error: 'invalid JSON body' }).kind, 'parse');

  assert.equal(flog.classifyArjumFailure({ ok: false }).kind, 'unknown');
  assert.equal(flog.classifyArjumFailure(null).kind, 'unknown');
});

test('createFailureSummary aggregates per-kind counts and bounded samples', () => {
  const s = flog.createFailureSummary({ maxSamplesPerKind: 2 });
  s.recordFailure({ ok: false, status: 502, error: 'origin overloaded' }, { ticker: 'BBCA', at: '2026-10-19T16:30:00Z' });
  s.recordFailure({ ok: false, status: 530 }, { ticker: 'BBRI' });
  s.recordFailure({ ok: false, error: 'socket hang up' }, { ticker: 'TLKM' });

  const json = s.toJSON();
  assert.equal(json.total, 3);
  assert.equal(json.counts.provider_5xx, 2);
  assert.equal(json.counts.transport, 1);
  assert.equal(json.samples.provider_5xx.length, 2);
  assert.equal(s.countOf('provider_5xx'), 2);

  const text = s.formatSummary();
  assert.match(text, /total=3/);
  assert.match(text, /provider_5xx: 2/);
  assert.match(text, /transport: 1/);
});

test('failure summary with no failures reports zero', () => {
  const s = flog.createFailureSummary();
  assert.equal(s.getTotal(), 0);
  assert.match(s.formatSummary(), /total=0/);
});

test('shouldTripEarly: first 20 all-failed trips the breaker', () => {
  const outcomes = Array.from({ length: 20 }, () => ({ kind: 'provider_5xx' }));
  const verdict = flog.shouldTripEarly({ outcomes });
  assert.equal(verdict.trip, true);
  assert.match(verdict.reason, /first_20_all_failed/);
});

test('shouldTripEarly: first 20 not all failed does NOT trip on rule 1', () => {
  const outcomes = Array.from({ length: 20 }, (_, i) => ({ kind: i === 0 ? null : 'provider_5xx' }));
  assert.equal(flog.shouldTripEarly({ outcomes }).trip, false);
});

test('shouldTripEarly: >50% failed in first 50 trips the breaker', () => {
  // First 5 succeed, then a sustained burst (indices 5..30 fail = 26/50 = 52%).
  // The first 20 are NOT all failed, so rule 1 does not fire; rule 2 does.
  const outcomes = Array.from({ length: 50 }, (_, i) => ({ kind: (i >= 5 && i <= 30) ? 'provider_5xx' : null }));
  const verdict = flog.shouldTripEarly({ outcomes });
  assert.equal(verdict.trip, true);
  assert.match(verdict.reason, /50pct_failed_in_first_50/);
});

test('shouldTripEarly: exactly 50% failed does NOT trip (strictly greater)', () => {
  // Even indices fail = 25/50 = 50% exactly; first 20 are not all failed.
  const outcomes = Array.from({ length: 50 }, (_, i) => ({ kind: i % 2 === 0 ? 'provider_5xx' : null }));
  assert.equal(flog.shouldTripEarly({ outcomes }).trip, false);
});

test('shouldTripEarly: healthy run never trips', () => {
  const outcomes = Array.from({ length: 60 }, () => ({ kind: null }));
  assert.equal(flog.shouldTripEarly({ outcomes }).trip, false);
});