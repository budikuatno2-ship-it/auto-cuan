'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const runner = require('../tools/run-all-screeners-vps');

test('runner recognizes published same-day Non-Konglo state', () => {
  assert.equal(runner.publishedToday({ status: 'published', run_date: runner.wibDate() }), true);
  assert.equal(runner.finalizedResponse({ step: 'finalize', status: 'PUBLISHED' }), true);
  assert.equal(runner.finalizedResponse({ message: 'Published 22 top candidates.' }), true);
});

test('Non-Konglo runner skips published status without calling run endpoint', async () => {
  let calls = 0;
  const client = { call: async () => { calls += 1; return { meta: { status: 'published', run_date: runner.wibDate() } }; } };
  const result = await runner.runNk(client, { force: false, maxAttempts: 2, sleepMs: 1 }, () => {});
  assert.equal(result.skipped, true);
  assert.equal(calls, 1);
});

test('Non-Konglo runner stops immediately after finalized response', async () => {
  const calls = [];
  const client = { call: async (q) => { calls.push(q.action); if (q.action === 'nk-screener-results') return { meta: { status: 'scanning', run_date: runner.wibDate() } }; return { step: 'finalize', status: 'PUBLISHED', message: 'Published 22 top candidates.' }; } };
  const result = await runner.runNk(client, { execute: true, force: false, maxAttempts: 3, sleepMs: 1, nkBatchSize: 8 }, () => {});
  assert.equal(result.finalized, true);
  assert.deepEqual(calls, ['nk-screener-results', 'nk-screener-run']);
});

test('--skip-swing skips both Swing Konglo and Non-Konglo', async () => {
  const options = runner.parseArgs(['node', 'runner', '--skip-swing', '--skip-daytrade', '--skip-top5', '--skip-progress']);
  const calls = [];
  const client = { call: async (query) => { calls.push(query); if (query.action === 'screener') return { meta: {} }; if (query.action === 'telegram-daily-picks') return { ready: false }; throw new Error('Unexpected call: ' + query.action); } };
  await runner.main(options, { env: { CRON_SECRET: 'test' }, client, log: () => {} });
  assert.equal(options.skipSwing, true);
  assert.deepEqual(calls.map((query) => query.action), ['screener', 'telegram-daily-picks']);
});

async function runTop5(options) {
  const calls = [];
  const client = { call: async (query) => {
    calls.push(query);
    if (query.action === 'screener' || query.action === 'daytrade-screener') return { meta: { status: 'published', run_date: runner.wibDate() } };
    if (query.action === 'nk-screener-results') return { meta: { status: 'published', run_date: runner.wibDate() } };
    if (query.action === 'telegram-daily-picks' && query.lock_only === 1) return { ready: true };
    if (query.action === 'telegram-daily-picks') return { success: true, sent: !query.dry_run };
    throw new Error('Unexpected call: ' + JSON.stringify(query));
  } };
  await runner.main(options, { env: { CRON_SECRET: 'test' }, client, log: () => {} });
  return calls.filter((query) => query.action === 'telegram-daily-picks');
}

test('dry-run only calls Top 5 readiness, never generation', async () => {
  const calls = await runTop5(runner.parseArgs(['node', 'runner', '--dry-run', '--skip-progress']));
  assert.deepEqual(calls, [{ action: 'telegram-daily-picks', lock_only: 1, dry_run: 1 }]);
});

test('--send without --execute only checks readiness', async () => {
  const calls = await runTop5(runner.parseArgs(['node', 'runner', '--send', '--skip-progress']));
  assert.deepEqual(calls, [{ action: 'telegram-daily-picks', lock_only: 1, dry_run: 1 }]);
});

test('--execute --send calls actual Top 5 generation only after readiness passes', async () => {
  const calls = await runTop5(runner.parseArgs(['node', 'runner', '--execute', '--send', '--skip-progress']));
  assert.deepEqual(calls[0], { action: 'telegram-daily-picks', lock_only: 1, dry_run: 1 });
  assert.deepEqual(calls[1], { action: 'telegram-daily-picks' });
});

test('Top 5 generation is not called when readiness is not ready', async () => {
  const calls = [];
  const client = { call: async (query) => {
    calls.push(query);
    if (query.action === 'screener' || query.action === 'daytrade-screener' || query.action === 'nk-screener-results') return { meta: { status: 'published', run_date: runner.wibDate() } };
    if (query.action === 'telegram-daily-picks') return { ready: false, reason: 'screeners_not_ready' };
    throw new Error('Unexpected call');
  } };
  await runner.main(runner.parseArgs(['node', 'runner', '--skip-progress']), { env: { CRON_SECRET: 'test' }, client, log: () => {} });
  assert.deepEqual(calls.filter((query) => query.action === 'telegram-daily-picks'), [{ action: 'telegram-daily-picks', lock_only: 1, dry_run: 1 }]);
});


test('--dry-run never calls mutating screener endpoints', async () => {
  const calls=[]; const client={call: async q => { calls.push(q); if(['screener','daytrade-screener','nk-screener-results'].includes(q.action)) return {meta:{}}; if(q.action==='telegram-daily-picks') return {ready:false}; throw new Error('mutating '+q.action); }};
  await runner.main(runner.parseArgs(['node','runner','--dry-run','--skip-progress']), {env:{CRON_SECRET:'test'},client,log:()=>{}});
  assert.equal(calls.some(q => ['refresh-screener','nk-screener-run','daytrade-screener-run'].includes(q.action)), false);
});


test('heavy-scan memory preflight reads MemAvailable and refuses dangerously low headroom', () => {
  const fakeFs = {
    readFileSync: () => 'MemTotal:       6000000 kB\nMemAvailable:    1024000 kB\n'
  };
  assert.equal(Math.round(runner.readLinuxMemAvailableMb(fakeFs)), 1000);
  assert.throws(
    () => runner.assertHeavyScanMemoryHeadroom({}, fakeFs),
    /below safety floor 1536 MB/
  );

  const safeFs = {
    readFileSync: () => 'MemTotal:       6000000 kB\nMemAvailable:    4608000 kB\n'
  };
  const safe = runner.assertHeavyScanMemoryHeadroom({}, safeFs);
  assert.equal(Math.round(safe.availableMb), 4500);
  assert.equal(safe.minMb, 1536);
});

test('makeClient surfaces action, URL, and network cause instead of opaque fetch failed', async () => {
  const fetchImpl = async () => {
    const err = new TypeError('fetch failed');
    err.cause = { code: 'ECONNRESET', message: 'socket hang up' };
    throw err;
  };
  const client = runner.makeClient('http://127.0.0.1:3000', 'secret', fetchImpl);
  await assert.rejects(
    client.call({ action: 'daytrade-screener-run', batch: 0 }),
    /Fetch failed action=daytrade-screener-run .*cause=ECONNRESET: socket hang up/
  );
});


test('VPS runner defaults Non-Konglo to batch size 50 for the 635-name universe', () => {
  const options = runner.parseArgs(['node','runner','--execute','--skip-daytrade','--skip-top5','--skip-progress']);
  assert.equal(options.nkBatchSize, 50);
  assert.equal(options.maxAttempts, 40);
});

test('Non-Konglo runner refuses impossible max-attempt capacity after start response', async () => {
  const calls = [];
  const client = {
    call: async (q) => {
      calls.push(q);
      if (q.action === 'nk-screener-results') {
        return { meta: { status: 'idle', run_date: runner.wibDate() } };
      }
      if (q.action === 'nk-screener-run') {
        return { step: 'start', status: 'SCANNING', universe_count: 635, batch_count: 80, batch_size: 8 };
      }
      throw new Error('unexpected');
    }
  };
  await assert.rejects(
    runner.runNk(client, { execute:true, force:true, maxAttempts:40, sleepMs:1, nkBatchSize:8 }, () => {}),
    /requires at least 82 attempts/
  );
});

test('Non-Konglo runner accepts large universe with batch 50 and logs start diagnostics', async () => {
  const logs = [];
  let runCalls = 0;
  const client = {
    call: async (q) => {
      if (q.action === 'nk-screener-results') {
        return { meta: { status: runCalls >= 2 ? 'published' : 'scanning', run_date: runner.wibDate() } };
      }
      if (q.action === 'nk-screener-run') {
        runCalls += 1;
        if (runCalls === 1) return { step:'start', status:'SCANNING', universe_count:635, batch_count:13, batch_size:50 };
        return { step:'finalize', status:'PUBLISHED', message:'Published 20 top candidates.' };
      }
      throw new Error('unexpected');
    }
  };
  const result = await runner.runNk(client, { execute:true, force:true, maxAttempts:40, sleepMs:1, nkBatchSize:50 }, (x) => logs.push(x));
  assert.equal(result.finalized, true);
  assert.ok(logs.some((x) => /universe 635, batches 13, batch_size 50/.test(x)));
});


test('Non-Konglo force run does not short-circuit on stale published meta', async () => {
  const calls = [];
  let runCalls = 0;
  const client = {
    call: async (q) => {
      calls.push(q);
      if (q.action === 'nk-screener-results') {
        if (runCalls === 0) return { meta: { status: 'published', run_date: '2026-09-24' } };
        return { meta: { status: 'scanning', run_date: runner.wibDate() } };
      }
      if (q.action === 'nk-screener-run') {
        runCalls += 1;
        if (runCalls === 1) return { step:'start', status:'SCANNING', universe_count:635, batch_count:13, batch_size:50 };
        return { step:'finalize', status:'PUBLISHED', message:'Published 21 top candidates.' };
      }
      throw new Error('unexpected');
    }
  };
  const result = await runner.runNk(client, {
    execute:true, force:true, maxAttempts:40, sleepMs:1, nkBatchSize:50
  }, () => {});
  assert.equal(result.finalized, true);
  assert.equal(calls.some((q) => q.action === 'nk-screener-run' && q.force === 1), true);
});
