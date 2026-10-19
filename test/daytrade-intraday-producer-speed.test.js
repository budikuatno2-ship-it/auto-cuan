'use strict';

/**
 * DayTrade full-universe intraday producer (change request A1, 2026-10-20).
 *
 * Adds `--speed fast|full`:
 *   - default stays `fast` so the existing 15-minute cron is unchanged;
 *   - `full` scans the whole eligible universe with BATCH_SIZE 50 (already used
 *     by api/sector-hot.js full mode);
 *   - a run over the ceiling aborts cleanly (ABORTED_TIMEOUT) WITHOUT publishing
 *     a half scan and WITHOUT overwriting the last good snapshot;
 *   - an overlapping run is a clean slot skip (SKIPPED_RUNNING), never an error;
 *   - the run records run_speed/universe_count/scanned_count/duration_ms.
 *
 * The 13 Oct outage guard (transient-status retry), the empty-snapshot guard,
 * and the closed-session guard are pinned by
 * test/daytrade-producer-timeout-guard.test.js and must stay green.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const producer = require('../tools/run-daytrade-intraday-producer');

const ROOT = path.resolve(__dirname, '..');

function liveDeps(overrides) {
  return Object.assign({
    env: { CRON_SECRET: 'x', AUTO_CUAN_MIN_HEAVY_SCAN_MEM_AVAILABLE_MB: '1' },
    baseUrl: 'http://127.0.0.1:3000',
    fs: { readFileSync: () => 'MemAvailable:    4096000 kB\n', existsSync: () => false },
    now: new Date('2026-10-20T02:25:00Z'),
    getMarketSessionStatus: () => ({ isOpen: true, session: 'SESSION_1', status: 'LIVE_MARKET' }),
    buildSnapshot: async () => ({ ok: true, rows: 12 }),
    log: () => {}
  }, overrides || {});
}

test('FUS-01: parseArgs defaults to fast and accepts --speed fast|full (space and = form)', () => {
  assert.equal(producer.parseArgs(['node', 'x']).speed, 'fast', 'default must stay fast');
  assert.equal(producer.parseArgs(['node', 'x', '--speed', 'full']).speed, 'full');
  assert.equal(producer.parseArgs(['node', 'x', '--speed', 'fast']).speed, 'fast');
  assert.equal(producer.parseArgs(['node', 'x', '--speed=full']).speed, 'full');
  assert.equal(producer.parseArgs(['node', 'x', '--speed', 'bogus']).speed, 'fast', 'unknown speed degrades to fast');
  assert.equal(producer.normalizeSpeed('FULL'), 'full');
  assert.equal(producer.normalizeSpeed('nonsense'), 'fast');
});

test('FUS-02: full-mode ceiling is 6 minutes and fast-mode ceiling is shorter', () => {
  assert.equal(producer.FULL_RUN_TIMEOUT_MS, 6 * 60 * 1000);
  assert.equal(producer.resolveRunTimeoutMs({ speed: 'full' }), producer.FULL_RUN_TIMEOUT_MS);
  assert.ok(producer.resolveRunTimeoutMs({ speed: 'fast' }) < producer.FULL_RUN_TIMEOUT_MS);
  assert.equal(producer.resolveRunTimeoutMs({ speed: 'full', timeoutMs: 123 }), 123, 'explicit timeoutMs overrides the mode default');
  assert.equal(producer.DAYTRADE_SPEED_BATCH_SIZE, 50, 'full mode reuses the existing BATCH_SIZE 50');
});

test('FUS-03: fast mode sends speed=fast (legacy contract unchanged)', async () => {
  const calls = [];
  const client = { call: async (q) => {
    calls.push({ ...q });
    return { success: true, status: 'published', run_date: '2026-10-20', run_id: 'dt-fast', published_count: 6, scanned_count: 258, universe_count: 258 };
  } };
  const result = await producer.run({ execute: true, maxBatches: 5, sleepMs: 0, speed: 'fast' }, liveDeps({ client }));
  assert.equal(result.ok, true);
  assert.equal(result.run_speed, 'fast');
  assert.equal(calls[0].speed, 'fast');
  assert.equal(calls[0].mode, 'auto');
  assert.equal(calls[0].defer_to_fast_watcher, 1);
});

test('FUS-04: full mode sends speed=full on every batch and records run meta', async () => {
  const calls = [];
  let run = 0;
  const client = { call: async (q) => {
    calls.push({ ...q });
    run += 1;
    if (run < 3) return { success: true, status: 'running', next_batch: q.batch + 1, scanned_count: (q.batch + 1) * 50, universe_count: 800 };
    return { success: true, status: 'published', run_date: '2026-10-20', run_id: 'dt-full', published_count: 9, scanned_count: 800, universe_count: 800 };
  } };
  const result = await producer.run({ execute: true, maxBatches: 10, sleepMs: 0, speed: 'full' }, liveDeps({ client }));

  assert.equal(result.ok, true);
  assert.equal(result.run_speed, 'full');
  assert.equal(result.universe_count, 800);
  assert.equal(result.scanned_count, 800);
  assert.equal(typeof result.duration_ms, 'number');
  assert.ok(result.duration_ms >= 0);
  for (const q of calls) assert.equal(q.speed, 'full', 'every full-mode batch must request the full universe');
  // The producer measures duration; the meta summary mirrors the return value.
  assert.equal(result.meta.run_speed, 'full');
  assert.equal(result.meta.universe_count, 800);
  assert.equal(result.meta.scanned_count, 800);
});

test('FUS-05: a run over the ceiling aborts cleanly and NEVER publishes a half scan', async () => {
  // The deadline is checked at the top of the loop, so make the mock client
  // yield real wall time per batch (a synchronous mock can finish all batches
  // before the ceiling is ever observed — the exact CI flake this guards).
  let sawPublish = false;
  let buildCalls = 0;
  const client = {
    call: async () => {
      sawPublish = true;
      await new Promise((r) => setTimeout(r, 15));
      return { success: true, status: 'running', next_batch: 1, scanned_count: 50, universe_count: 800 };
    }
  };

  const result = await producer.run(
    { execute: true, maxBatches: 1000, sleepMs: 0, speed: 'full', timeoutMs: 40 },
    liveDeps({ client, buildSnapshot: async () => { buildCalls += 1; return { ok: true, rows: 5 }; } })
  );

  assert.equal(result.ok, false);
  assert.equal(result.aborted, true);
  assert.equal(result.reason, 'ABORTED_TIMEOUT');
  assert.equal(result.published, false);
  assert.equal(result.run_speed, 'full');
  assert.equal(buildCalls, 0, 'a timed-out run must not materialize a snapshot');
  assert.equal(sawPublish, true, 'sanity: the producer did poll the endpoint');
});

test('FUS-06: an overlapping run is reported as SKIPPED_RUNNING, not an error', async () => {
  const client = { call: async () => ({ success: true, status: 'skipped', skipped_due_to_running: true, run_id: 'dt-other' }) };
  const result = await producer.run({ execute: true, maxBatches: 5, sleepMs: 0, speed: 'full' }, liveDeps({ client }));
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'SKIPPED_RUNNING');
  assert.equal(result.run_speed, 'full');
});

test('FUS-07: wrapper passes --speed through to the node producer and defaults to fast', () => {
  const src = fs.readFileSync(path.join(ROOT, 'deploy', 'vps', 'run-daytrade-producer.sh'), 'utf8');
  assert.match(src, /SPEED="fast"/, 'wrapper default speed must stay fast');
  assert.ok(src.includes('--speed "$SPEED"'), 'wrapper must forward --speed to the producer');
  assert.ok(src.includes('run-daytrade-intraday-producer.js "$MODE" --speed "$SPEED"'), 'exact producer invocation');
  assert.match(src, /daytrade-producer\.lock/, 'existing single-flight lock retained');
});