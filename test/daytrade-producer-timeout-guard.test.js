'use strict';

/**
 * Regression: DayTrade producer froze for six sessions (13–19 Oct 2026).
 *
 * Chain of failure:
 *   1. api/sector-hot.js installed a global 3.5s timeoutGuard (commit 6611c141,
 *      to fix a dashboard 504 on slow reads).
 *   2. daytrade-screener-run takes >3.5s, so the guard answered 200 with
 *      `{success:true,data:[],rows:[]}` — NO `status` field.
 *   3. The producer read `last.status` → '' → threw "Unexpected DayTrade
 *      producer status: missing" and aborted every 15 minutes.
 *   4. The nightly snapshot materialiser then wrote 0 rows over a good file.
 *
 * These tests pin the three guards that break that chain.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const sectorHot = require('../api/sector-hot');
const producer = require('../tools/run-daytrade-intraday-producer');
const alarm = require('../lib/daytrade-snapshot-alarm');

// ---------------------------------------------------------------------------
// 1. Heavy compute actions bypass the 3.5s read guard
// ---------------------------------------------------------------------------
test('heavy compute actions are recognised and exempt from the read timeout guard', () => {
  assert.equal(sectorHot.TIMEOUT_GUARD_MS, 3500, 'read guard stays 3.5s for normal reads');
  for (const action of ['daytrade-screener-run', 'nk-screener-run', 'refresh-screener', 'refresh']) {
    assert.equal(sectorHot.isHeavyComputeAction(action), true, action + ' must be treated as heavy');
  }
  for (const action of ['daytrade-screener', 'screener', 'nk-screener-results', 'web-daily-picks', null, undefined]) {
    assert.equal(sectorHot.isHeavyComputeAction(action), false, String(action) + ' must NOT be treated as heavy');
  }
});

test('the heavy set and the read-only set stay disjoint', () => {
  for (const action of sectorHot.READ_ONLY_ACTIONS) {
    assert.equal(sectorHot.HEAVY_COMPUTE_ACTIONS.has(action), false, action + ' cannot be both heavy and read-only');
  }
});

// ---------------------------------------------------------------------------
// 2. Producer treats a missing/unknown status as transient (retry, not abort)
// ---------------------------------------------------------------------------
test('missing or unknown producer status is classified as transient', () => {
  for (const s of ['', null, undefined, 'unknown', 'missing', 'UNKNOWN', 'Missing']) {
    assert.equal(producer.isTransientStatus(s), true, JSON.stringify(s) + ' must be transient');
  }
  for (const s of ['running', 'published', 'paused', 'failed', 'completed', 'already_done']) {
    assert.equal(producer.isTransientStatus(s), false, JSON.stringify(s) + ' must NOT be transient');
  }
});

test('retry backoff grows and is bounded (fits inside the 15-minute cadence)', () => {
  const delays = producer.UNKNOWN_STATUS_RETRY_DELAYS_MS;
  assert.ok(delays.length >= 3, 'at least three retries before giving up');
  for (let i = 1; i < delays.length; i++) {
    assert.ok(delays[i] >= delays[i - 1], 'delays must not decrease');
  }
  const total = delays.reduce((a, b) => a + b, 0);
  assert.ok(total < 15 * 60 * 1000, 'total retry budget must fit in one 15-minute slot, got ' + total + 'ms');
  // Out-of-range attempts clamp instead of returning undefined.
  assert.equal(producer.retryDelayFor(999), delays[delays.length - 1]);
  assert.equal(producer.retryDelayFor(-1), delays[0]);
});

test('a transient status keeps the SAME batch (does not advance) and eventually publishes', async () => {
  const calls = [];
  const responses = [
    { success: true, data: [], rows: [], note: 'Fallback: response completed via timeout guard' }, // no status
    { success: true, status: 'running', scanned_count: 75, universe_count: 258, next_batch: 1 },
    { success: true, status: 'published', scanned_count: 258, universe_count: 258 }
  ];
  let i = 0;
  const client = {
    call: async (query) => {
      calls.push(query.batch);
      return responses[Math.min(i++, responses.length - 1)];
    }
  };
  const result = await producer.run(
    { execute: true, maxBatches: 5, sleepMs: 0 },
    {
      now: new Date('2026-10-19T03:00:00+07:00'),
      getMarketSessionStatus: () => ({ isOpen: true, status: 'LIVE_MARKET' }),
      env: { CRON_SECRET: 'x' },
      baseUrl: 'http://127.0.0.1:3000',
      client,
      fs: { existsSync: () => false },
      log: () => {},
      buildSnapshot: async () => ({ ok: true, rows: 188 }),
      staleMinutes: 120
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, 'published');
  assert.equal(result.snapshot.rows, 188);
  // First two calls are batch 0 (retry on the same batch), then batch advances.
  assert.equal(calls[0], 0);
  assert.equal(calls[1], 0, 'transient status must retry the SAME batch');
  assert.equal(calls[2], 1, 'after a real running status the batch advances');
});

test('producer gives up only after exhausting the bounded retry budget', async () => {
  const client = { call: async () => ({ success: true, data: [], rows: [], note: 'timeout guard' }) };
  await assert.rejects(
    producer.run(
      { execute: true, maxBatches: 3, sleepMs: 0 },
      {
        now: new Date('2026-10-19T03:00:00+07:00'),
        getMarketSessionStatus: () => ({ isOpen: true, status: 'LIVE_MARKET' }),
        env: { CRON_SECRET: 'x' },
        baseUrl: 'http://127.0.0.1:3000',
        client,
        fs: { existsSync: () => false },
        log: () => {},
        buildSnapshot: async () => ({ ok: true, rows: 1 }),
        staleMinutes: 120
      }
    ),
    /status stayed unknown after/
  );
});

// ---------------------------------------------------------------------------
// 3. An empty snapshot must never overwrite a healthy one
// ---------------------------------------------------------------------------
test('a 0-row snapshot is rejected instead of overwriting the last good file', () => {
  assert.equal(producer.shouldRejectEmptySnapshot({ ok: true, rows: 0 }), true);
  assert.equal(producer.shouldRejectEmptySnapshot({ ok: true, rows: 0.0 }), true);
  assert.equal(producer.shouldRejectEmptySnapshot({ ok: true, rows: NaN }), true);
  assert.equal(producer.shouldRejectEmptySnapshot({ ok: true, rows: 1 }), false);
  assert.equal(producer.shouldRejectEmptySnapshot({ ok: true, rows: 188 }), false);
  assert.equal(producer.shouldRejectEmptySnapshot({ ok: false }), false, 'failures are handled by the caller');
  assert.equal(producer.shouldRejectEmptySnapshot(null), false);
});

test('published run with 0 rows keeps the previous snapshot and reports rejection', async () => {
  let built = 0;
  const result = await producer.run(
    { execute: true, maxBatches: 2, sleepMs: 0 },
    {
      now: new Date('2026-10-19T03:00:00+07:00'),
      getMarketSessionStatus: () => ({ isOpen: true, status: 'LIVE_MARKET' }),
      env: { CRON_SECRET: 'x' },
      baseUrl: 'http://127.0.0.1:3000',
      client: { call: async () => ({ success: true, status: 'published', scanned_count: 258, universe_count: 258 }) },
      fs: { existsSync: () => false },
      log: () => {},
      buildSnapshot: async () => { built++; return { ok: true, rows: 0 }; },
      staleMinutes: 120
    }
  );
  assert.equal(built, 1);
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.rejected_empty, true);
});

// ---------------------------------------------------------------------------
// 4. Staleness alarm: one message per incident, only during market hours
// ---------------------------------------------------------------------------
test('alarm stays silent outside market hours', () => {
  const d = alarm.evaluate({
    snapshotMtime: new Date('2026-10-19T01:00:00+07:00'),
    now: new Date('2026-10-19T12:00:00+07:00'),
    marketOpen: false
  });
  assert.equal(d.shouldAlert, false);
  assert.equal(d.reason, 'market_closed');
});

test('alarm fires when the snapshot is older than the 2h threshold', () => {
  // FIX-2: use 10:00 WIB (active session, not lunch break) to avoid +150 min break threshold
  const now = new Date('2026-10-19T10:00:00+07:00');
  const fresh = alarm.evaluate({ snapshotMtime: new Date('2026-10-19T09:30:00+07:00'), now, marketOpen: true });
  assert.equal(fresh.shouldAlert, false);
  assert.equal(fresh.reason, 'fresh');

  const stale = alarm.evaluate({ snapshotMtime: new Date('2026-10-19T07:00:00+07:00'), now, marketOpen: true });
  assert.equal(stale.shouldAlert, true);
  assert.equal(stale.reason, 'stale');
  assert.equal(stale.ageMinutes, 180);
});

test('alarm fires when the snapshot file is missing during market hours', () => {
  const d = alarm.evaluate({ snapshotMtime: null, now: new Date('2026-10-19T10:00:00+07:00'), marketOpen: true });
  assert.equal(d.shouldAlert, true);
  assert.equal(d.reason, 'snapshot_missing');
});

test('alarm does not repeat inside the cooldown (one message per incident)', () => {
  // FIX-2: use 10:00 WIB (active session) to avoid lunch break bump
  const now = new Date('2026-10-19T10:00:00+07:00');
  const d = alarm.evaluate({
    snapshotMtime: new Date('2026-10-19T07:00:00+07:00'),
    now,
    marketOpen: true,
    lastAlertAt: new Date('2026-10-19T09:30:00+07:00').toISOString()
  });
  assert.equal(d.shouldAlert, false);
  assert.equal(d.reason, 'cooldown');

  // After the cooldown the same incident may alert again.
  const later = alarm.evaluate({
    snapshotMtime: new Date('2026-10-19T09:00:00+07:00'),
    now: new Date('2026-10-19T18:00:00+07:00'),
    marketOpen: true,
    lastAlertAt: new Date('2026-10-19T11:30:00+07:00').toISOString()
  });
  assert.equal(later.shouldAlert, true);
});

test('alarm message names the stale condition and the log to inspect', () => {
  const msg = alarm.buildMessage({ ageMinutes: 3544, reason: 'stale', staleMinutes: 120 });
  assert.match(msg, /DARURAT/);
  assert.match(msg, /3544 menit/);
  assert.match(msg, /daytrade-producer\.log/);
});

test('alarm send() never throws when Telegram is disabled', async () => {
  const res = await alarm.send({ ageMinutes: 200 }, {
    notifier: { isTelegramEnabled: () => false, sendTelegramMessage: async () => ({ ok: true }) }
  });
  assert.equal(res.sent, false);
  assert.equal(res.skipped, true);
  assert.equal(res.reason, 'telegram_disabled');
});

test('alarm send() swallows notifier failures', async () => {
  const res = await alarm.send({ ageMinutes: 200 }, {
    notifier: { isTelegramEnabled: () => true, sendTelegramMessage: async () => { throw new Error('boom'); } }
  });
  assert.equal(res.sent, false);
  assert.match(String(res.reason), /send_failed/);
});
