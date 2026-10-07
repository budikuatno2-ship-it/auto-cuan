'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const producer = require('../tools/run-daytrade-intraday-producer');

const ROOT = path.resolve(__dirname, '..');

test('IDTP-01: dry-run never invokes mutating DayTrade run action', async () => {
  const calls = [];
  const client = { call: async (q) => {
    calls.push(q);
    if (q.action === 'daytrade-screener') return { meta: { status: 'published' } };
    throw new Error('unexpected mutation');
  }};
  const result = await producer.run(
    { execute: false, maxBatches: 10, sleepMs: 0 },
    {
      env: { CRON_SECRET: 'x' },
      baseUrl: 'http://127.0.0.1:3000',
      client,
      now: new Date('2026-10-06T02:20:00Z'),
      getMarketSessionStatus: () => ({ isOpen: true, session: 'SESSION_1', status: 'LIVE_MARKET' }),
      log: () => {}
    }
  );
  assert.equal(result.dryRun, true);
  assert.deepEqual(calls, [{ action: 'daytrade-screener' }]);
});

test('IDTP-02: execute uses canonical FAST producer contract and defers signal delivery to FastWatcher', async () => {
  const calls = [];
  let runCalls = 0;
  let snapshotCalls = 0;
  const client = { call: async (q) => {
    calls.push({ ...q });
    if (q.action !== 'daytrade-screener-run') throw new Error('unexpected action');
    runCalls += 1;
    if (runCalls === 1) {
      return {
        success: true,
        status: 'running',
        next_batch: 1,
        scanned_count: 75,
        universe_count: 150
      };
    }
    return {
      success: true,
      status: 'published',
      run_date: '2026-10-06',
      run_id: 'dt-test',
      published_count: 7,
      scanned_count: 150,
      universe_count: 150
    };
  }};

  const result = await producer.run(
    { execute: true, maxBatches: 10, sleepMs: 0 },
    {
      env: { CRON_SECRET: 'x', AUTO_CUAN_MIN_HEAVY_SCAN_MEM_AVAILABLE_MB: '1' },
      baseUrl: 'http://127.0.0.1:3000',
      client,
      fs: { readFileSync: () => 'MemAvailable:    4096000 kB\n' },
      now: new Date('2026-10-06T02:20:00Z'),
      getMarketSessionStatus: () => ({ isOpen: true, session: 'SESSION_1', status: 'LIVE_MARKET' }),
      buildSnapshot: async () => { snapshotCalls += 1; return { ok: true, rows: 12 }; },
      log: () => {}
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.run_date, '2026-10-06');
  assert.equal(snapshotCalls, 1);
  assert.equal(calls.length, 2);
  for (const q of calls) {
    assert.equal(q.action, 'daytrade-screener-run');
    assert.equal(q.force, 1);
    assert.equal(q.mode, 'auto');
    assert.equal(q.speed, 'fast');
    assert.equal(q.send_radar, 0);
    assert.equal(q.defer_to_fast_watcher, 1);
  }
  assert.deepEqual(calls.map((q) => q.batch), [0, 1]);
});

test('IDTP-03: closed/break session performs zero API mutations', async () => {
  let called = false;
  const result = await producer.run(
    { execute: true, maxBatches: 10, sleepMs: 0 },
    {
      now: new Date('2026-10-06T05:30:00Z'),
      getMarketSessionStatus: () => ({ isOpen: false, session: 'BREAK', status: 'OUTSIDE_MARKET', reason: 'lunch_break' }),
      client: { call: async () => { called = true; } },
      env: { CRON_SECRET: 'x' },
      log: () => {}
    }
  );
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'MARKET_CLOSED');
  assert.equal(called, false);
});

test('IDTP-04: producer materializes snapshot only after published terminal state', async () => {
  let buildCalls = 0;
  const client = { call: async () => ({
    success: true,
    status: 'paused',
    reason: 'market_break',
    session: 'BREAK'
  })};

  const result = await producer.run(
    { execute: true, maxBatches: 10, sleepMs: 0 },
    {
      env: { CRON_SECRET: 'x', AUTO_CUAN_MIN_HEAVY_SCAN_MEM_AVAILABLE_MB: '1' },
      baseUrl: 'http://127.0.0.1:3000',
      client,
      fs: { readFileSync: () => 'MemAvailable:    4096000 kB\n' },
      now: new Date('2026-10-06T02:20:00Z'),
      getMarketSessionStatus: () => ({ isOpen: true, session: 'SESSION_1', status: 'LIVE_MARKET' }),
      buildSnapshot: async () => { buildCalls += 1; return { ok: true }; },
      log: () => {}
    }
  );

  assert.equal(result.skipped, true);
  assert.equal(buildCalls, 0);
});

test('IDTP-05: versioned schedule restores the 15-minute intraday producer before consumers', () => {
  const cron = fs.readFileSync(path.join(ROOT, 'deploy', 'vps', 'final-schedule.cron'), 'utf8');
  assert.match(
    cron,
    /2,17,32,47 9-15 \* \* 1-5 \/home\/ubuntu\/auto-cuan\/deploy\/vps\/run-daytrade-producer\.sh --execute/,
    'DayTrade FAST producer must run every 15 minutes from 09:02 cadence'
  );
  assert.match(cron, /run-fastwatcher\.sh --send/);
  assert.doesNotMatch(cron, /run-daytrade\.sh --send/,
    'generic DayTrade snapshot sender must not bypass FastWatcher confirmation ownership');
});

test('IDTP-06: VPS producer wrapper uses canonical env loader and single-flight lock', () => {
  const src = fs.readFileSync(path.join(ROOT, 'deploy', 'vps', 'run-daytrade-producer.sh'), 'utf8');
  assert.match(src, /lib\/load-env\.sh/);
  assert.match(src, /load_auto_cuan_env "\$REPO" "\$RUNNER_DIR"/);
  assert.match(src, /require_nonempty_env "CRON_SECRET"/);
  assert.match(src, /daytrade-producer\.lock/);
  assert.match(src, /tools\/run-daytrade-intraday-producer\.js/);
});
