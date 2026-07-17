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
