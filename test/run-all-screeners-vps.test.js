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
  const result = await runner.runNk(client, { force: false, maxAttempts: 3, sleepMs: 1 }, () => {});
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

test('Top 5 readiness uses lock_only while dry-run generation does not', async () => {
  const calls = await runTop5(runner.parseArgs(['node', 'runner', '--dry-run', '--skip-progress']));
  assert.deepEqual(calls[0], { action: 'telegram-daily-picks', lock_only: 1, dry_run: 1 });
  assert.deepEqual(calls[1], { action: 'telegram-daily-picks', dry_run: 1 });
});

test('--send calls actual Top 5 generation only after readiness passes', async () => {
  const calls = await runTop5(runner.parseArgs(['node', 'runner', '--send', '--skip-progress']));
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
