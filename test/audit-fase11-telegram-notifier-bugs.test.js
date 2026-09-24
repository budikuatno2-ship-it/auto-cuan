'use strict';

/**
 * AUDIT FASE 11 (BATCH 6) — Telegram Notifier Rate-Limit Recovery & Payload Safety
 *
 * Regression suite for the canonical outbound sender:
 *   - lib/telegram-notifier.js
 *
 * Findings covered (each FAILS on the pre-fix code):
 *   F11N-01  429 recovery had no retry queue at all — a throttled alert was dropped
 *   F11N-02  no exponential backoff schedule existed (fixed 1× retry_after only)
 *   F11N-03  a 429 could not be queued for automatic redelivery
 *   F11N-04  retry queue must stop after max_retries and must not leak jobs
 *   F11N-05  payloads above Telegram's 4096-char hard limit were never truncated
 *   F11N-06  the 4096 limit was not exposed as a single source of truth
 *   F11N-07  the default (non-queued) 429 contract must stay unchanged
 *
 * LOCAL / OFFLINE ONLY — global.fetch is mocked; all timers are injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const notifier = require('../lib/telegram-notifier');

async function withTelegramEnv(fetchImpl, fn) {
  const saved = {
    enabled: process.env.TELEGRAM_ENABLED,
    token: process.env.TELEGRAM_BOT_TOKEN,
    chat: process.env.TELEGRAM_CHAT_ID,
    fetch: global.fetch
  };
  process.env.TELEGRAM_ENABLED = '1';
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_CHAT_ID = '123';
  global.fetch = fetchImpl;
  try {
    return await fn();
  } finally {
    if (saved.enabled === undefined) delete process.env.TELEGRAM_ENABLED; else process.env.TELEGRAM_ENABLED = saved.enabled;
    if (saved.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = saved.token;
    if (saved.chat === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = saved.chat;
    global.fetch = saved.fetch;
    notifier.resetTelegramThrottle();
    notifier.clearRetryQueue();
  }
}

function rateLimitedFetch(retryAfter) {
  return async () => ({
    ok: false,
    status: 429,
    headers: { get: () => null },
    text: async () => JSON.stringify({ ok: false, parameters: { retry_after: retryAfter } })
  });
}

// ---------------------------------------------------------------------------
// F11N-01 / F11N-02 — exponential backoff schedule
// ---------------------------------------------------------------------------
test('F11N-01 computeBackoffDelayMs must grow exponentially (1s → 2s → 4s)', () => {
  assert.equal(typeof notifier.computeBackoffDelayMs, 'function', 'computeBackoffDelayMs must be exported');
  assert.equal(notifier.computeBackoffDelayMs(1), 1000);
  assert.equal(notifier.computeBackoffDelayMs(2), 2000);
  assert.equal(notifier.computeBackoffDelayMs(3), 4000);
  assert.equal(notifier.computeBackoffDelayMs(4), 8000);
});

test('F11N-02 computeBackoffDelayMs must honour a larger Telegram retry_after', () => {
  assert.equal(notifier.computeBackoffDelayMs(1, 5), 5000, 'retry_after=5s must dominate the 1s base');
  assert.equal(notifier.computeBackoffDelayMs(4, 5), 8000, 'exponential must dominate once larger');
  assert.equal(notifier.computeBackoffDelayMs(1, 0.5), 1000, 'sub-second retry_after must not shrink the base');
  assert.equal(notifier.computeBackoffDelayMs(0), 1000, 'attempt<=0 must be treated as the first attempt');
  assert.equal(notifier.computeBackoffDelayMs(NaN), 1000);
});

// ---------------------------------------------------------------------------
// F11N-03 — 429 can be queued for redelivery
// ---------------------------------------------------------------------------
test('F11N-03 a 429 with retry_queue:true must enqueue the alert instead of dropping it', async () => {
  notifier.clearRetryQueue();
  notifier.resetTelegramThrottle();
  await withTelegramEnv(rateLimitedFetch(2), async () => {
    const res = await notifier.sendTelegramMessage('throttled alert', {
      skip_market_guard: true,
      retry_queue: true,
      min_interval_ms: 0,
      sleep: async () => {}
    });
    assert.equal(res.sent, false);
    assert.equal(res.reason, 'rate_limited');
    assert.equal(res.queued_for_retry, true, 'the alert must be queued for redelivery');
    assert.equal(res.retry_after_seconds, 2);

    const state = notifier.getRetryQueueState();
    assert.equal(state.length, 1, 'exactly one job must be queued');
    assert.ok(state.entries[0].next_attempt_at > Date.now(), 'next attempt must be scheduled in the future');
    assert.ok(state.entries[0].next_attempt_at - Date.now() >= 1500, 'retry_after=2s must be honoured in the schedule');
  });
});

test('F11N-04 drainRetryQueue must redeliver a queued alert with backoff', async () => {
  notifier.clearRetryQueue();
  notifier.enqueueRetry('hello world', { retry_after_seconds: 1 });
  assert.equal(notifier.getRetryQueueState().length, 1);

  const delays = [];
  let calls = 0;
  const results = await notifier.drainRetryQueue({
    send: async () => {
      calls++;
      return calls === 1
        ? { sent: false, reason: 'rate_limited', retry_after_seconds: 1 }
        : { sent: true, status: 200 };
    },
    sleep: async (ms) => { delays.push(ms); }
  });

  assert.equal(calls, 2, 'one failed attempt + one successful retry');
  assert.equal(results.length, 2);
  assert.equal(results[0].sent, false);
  assert.equal(results[1].sent, true, 'the retry must succeed');
  // The wait is derived from a deadline, so allow sub-ms clock drift; the
  // assertion still distinguishes the 1s band from any shorter pacing.
  assert.ok(delays.length >= 1 && delays[0] >= 990 && delays[0] < 1500,
    'the first attempt must wait ~1000ms, got ' + JSON.stringify(delays));
  assert.equal(notifier.getRetryQueueState().length, 0, 'a delivered job must leave the queue');
});

test('F11N-05 drainRetryQueue must back off exponentially and stop after max_retries', async () => {
  notifier.clearRetryQueue();
  notifier.enqueueRetry('never delivered', { max_retries: 2, retry_after_seconds: 0 });

  const delays = [];
  let calls = 0;
  const results = await notifier.drainRetryQueue({
    send: async () => { calls++; return { sent: false, reason: 'rate_limited', retry_after_seconds: 0 }; },
    sleep: async (ms) => { delays.push(ms); }
  });

  assert.equal(calls, 3, 'initial attempt + 2 retries');
  assert.equal(results.length, 3);
  assert.equal(notifier.getRetryQueueState().length, 0, 'an exhausted job must be dropped, not looped forever');
  assert.equal(delays.length, 3);
  assert.ok(delays[0] >= 990 && delays[0] < 1500, 'attempt 1 backoff ~1000ms, got ' + delays[0]);
  assert.ok(delays[1] >= 1990 && delays[1] < 2500, 'attempt 2 backoff ~2000ms, got ' + delays[1]);
  assert.ok(delays[2] >= 3990 && delays[2] < 4500, 'attempt 3 backoff ~4000ms, got ' + delays[2]);
});

test('F11N-06 a non-rate-limited failure must not consume retry budget', async () => {
  notifier.clearRetryQueue();
  notifier.enqueueRetry('api error', { max_retries: 3 });
  let calls = 0;
  const results = await notifier.drainRetryQueue({
    send: async () => { calls++; return { sent: false, reason: 'api_error', status: 400 }; },
    sleep: async () => {}
  });
  assert.equal(calls, 1, 'a permanent API error must not be retried');
  assert.equal(results[0].sent, false);
  assert.equal(notifier.getRetryQueueState().length, 0);
});

// ---------------------------------------------------------------------------
// F11N-07 / F11N-08 — 4096-char payload truncation
// ---------------------------------------------------------------------------
test('F11N-07 TELEGRAM_MAX_TEXT_LENGTH must be exported and equal the Telegram hard limit', () => {
  assert.equal(notifier.TELEGRAM_MAX_TEXT_LENGTH, 4096);
});

test('F11N-08 splitTelegramMessage must hard-cap every chunk at 4096 chars', () => {
  const huge = 'X'.repeat(10000);
  const chunks = notifier.splitTelegramMessage(huge, 20000);
  assert.ok(chunks.length >= 3, 'a 10k single-token payload must be split, got ' + chunks.length + ' chunk(s)');
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 4096, 'chunk of ' + chunk.length + ' chars exceeds the 4096 hard limit');
  }
  assert.equal(chunks.join(''), huge, 'splitting must not lose any character');
});

test('F11N-09 sendTelegramMessage must never emit a body above 4096 chars', async () => {
  const bodies = [];
  await withTelegramEnv(async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '' };
  }, async () => {
    const res = await notifier.sendTelegramMessage('Y'.repeat(9000), {
      skip_market_guard: true,
      max_chunk_length: 12000,
      min_interval_ms: 0,
      sleep: async () => {}
    });
    assert.equal(res.sent, true);
    assert.ok(bodies.length >= 2, 'the payload must be chunked');
    for (const body of bodies) {
      assert.ok(body.text.length <= 4096, 'outbound body of ' + body.text.length + ' chars exceeds 4096');
    }
  });
});

// ---------------------------------------------------------------------------
// F11N-10 — default 429 contract unchanged (no silent queueing)
// ---------------------------------------------------------------------------
test('F11N-10 a 429 without retry_queue must keep the legacy non-queued contract', async () => {
  notifier.clearRetryQueue();
  await withTelegramEnv(rateLimitedFetch(7), async () => {
    const res = await notifier.sendTelegramMessage('plain alert', {
      skip_market_guard: true,
      min_interval_ms: 0,
      sleep: async () => {}
    });
    assert.equal(res.sent, false);
    assert.equal(res.reason, 'rate_limited');
    assert.equal(res.retry_after_seconds, 7);
    assert.equal(res.queued_for_retry, undefined, 'queueing must be strictly opt-in');
    assert.equal(notifier.getRetryQueueState().length, 0);
  });
});
