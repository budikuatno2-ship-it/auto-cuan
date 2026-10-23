'use strict';

// C (23 Oct 2026) — catch-up of the dates J1 missed (20, 21, 22 Oct) plus the
// 19 Oct remainder. It must be newest-first, budget-guarded, batched, and stop
// when the provider is failing instead of burning quota.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tool = require('../tools/catchup-missing-dates');

test('C: the budget keeps the daily jobs safe (J1 + J2 + IHSG + retry + web)', () => {
  const b = tool.computeCatchupBudget(18080, 0);
  assert.equal(b.remaining, 18080);
  // floor = ceil(4400 * 1.10) + 100 = 4940
  assert.equal(b.floor, 4940);
  assert.equal(b.spendable, 18080 - 4940);
});

test('C: an exhausted quota leaves nothing to spend', () => {
  const b = tool.computeCatchupBudget(18080, 18000);
  assert.equal(b.spendable, 0);
});

test('C: dry-run lists missing emiten per date, newest first, and spends nothing', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catchup-'));
  const base = path.join(tmp, 'arjum-data');
  for (const t of ['BBCA', 'BBRI', 'TLKM']) fs.mkdirSync(path.join(base, 'broker-summary', t), { recursive: true });
  // BBCA already has 22 Oct; the rest are missing.
  fs.writeFileSync(path.join(base, 'broker-summary', 'BBCA', '2026-10-22.json'), '{}');

  const client = { getConfiguredDailyQuota: () => 18080, fetchBrokerSummary: async () => { throw new Error('must not fetch in dry-run'); } };
  const tracker = { getUsedToday: () => 0 };
  const summary = await tool.run(['--dry-run', '--dates', '2026-10-22,2026-10-21'], { env: { ARJUM_DATA_DIR: base }, client, tracker });

  assert.equal(summary.dry_run, true);
  assert.equal(summary.plan[0].date, '2026-10-22');
  assert.equal(summary.plan[0].missing, 2, 'BBCA already has 22 Oct');
  assert.equal(summary.plan[1].date, '2026-10-21');
  assert.equal(summary.plan[1].missing, 3);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('C: a batch with >20% failures stops the run instead of burning quota', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catchup-'));
  const base = path.join(tmp, 'arjum-data');
  for (const t of ['A1', 'A2', 'A3', 'A4', 'A5']) fs.mkdirSync(path.join(base, 'broker-summary', t), { recursive: true });

  let calls = 0;
  const client = {
    getConfiguredDailyQuota: () => 18080,
    fetchBrokerSummary: async () => { calls += 1; return { ok: false, status: 502, error: 'bad gateway' }; }
  };
  const tracker = { getUsedToday: () => 0 };
  const summary = await tool.run(['--dates', '2026-10-22', '--batch', '5'], { env: { ARJUM_DATA_DIR: base }, client, tracker });

  assert.equal(summary.stopped, 'failure_ratio_exceeded');
  assert.equal(summary.results[0].failed, 5);
  assert.equal(calls, 5, 'it must stop after the failing batch, not continue to the next date');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('C: a successful batch writes only the requested date and never overwrites another', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catchup-'));
  const base = path.join(tmp, 'arjum-data');
  fs.mkdirSync(path.join(base, 'broker-summary', 'BBCA'), { recursive: true });
  fs.writeFileSync(path.join(base, 'broker-summary', 'BBCA', '2026-10-19.json'), '{"keep":true}');

  const client = {
    getConfiguredDailyQuota: () => 18080,
    fetchBrokerSummary: async (ticker, date) => ({ ok: true, data: { stock_code: ticker, date } })
  };
  const tracker = { getUsedToday: () => 0 };
  await tool.run(['--dates', '2026-10-22', '--batch', '10'], { env: { ARJUM_DATA_DIR: base }, client, tracker });

  assert.ok(fs.existsSync(path.join(base, 'broker-summary', 'BBCA', '2026-10-22.json')));
  assert.equal(fs.readFileSync(path.join(base, 'broker-summary', 'BBCA', '2026-10-19.json'), 'utf8'), '{"keep":true}');
  fs.rmSync(tmp, { recursive: true, force: true });
});
