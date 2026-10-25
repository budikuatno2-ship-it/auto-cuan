'use strict';

// C (23 Oct 2026) — catch-up of the dates J1 missed (20, 21, 22 Oct) plus the
// 19 Oct remainder. It must fill ALL FOUR types J1 writes (ALL, F, accumulation,
// insider), newest-first, budget-guarded, batched, and stop when the provider is
// failing instead of burning quota.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tool = require('../tools/catchup-missing-dates');

function makeBase(tickers) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catchup-'));
  const base = path.join(tmp, 'arjum-data');
  for (const t of tickers) fs.mkdirSync(path.join(base, 'broker-summary', t), { recursive: true });
  return { tmp, base };
}

test('C: the weekday budget keeps the daily jobs safe (J1 + J2 + IHSG + retry + web)', () => {
  const b = tool.computeCatchupBudget(18080, 0);
  assert.equal(b.remaining, 18080);
  assert.equal(b.floor, 5000);
  assert.equal(b.spendable, 18080 - 5000);
});

test('C: the WEEKEND budget drops the J1/J2 reserve to 0 (100% quota usable)', () => {
  const b = tool.computeCatchupBudget(18080, 0, { isWeekend: true });
  assert.equal(b.isWeekend, true);
  assert.equal(b.floor, 0);
  assert.equal(b.spendable, 18080);
});

test('C: Saturday/Sunday are detected in WIB', () => {
  assert.equal(tool.isWeekendWib('2026-10-24'), true, 'Sat 24 Oct 2026');
  assert.equal(tool.isWeekendWib('2026-10-25'), true, 'Sun 25 Oct 2026');
  assert.equal(tool.isWeekendWib('2026-10-23'), false, 'Fri 23 Oct 2026');
  assert.equal(tool.isWeekendWib('2026-10-26'), false, 'Mon 26 Oct 2026');
});

test('C: an exhausted quota leaves nothing to spend', () => {
  const b = tool.computeCatchupBudget(18080, 18000);
  assert.equal(b.spendable, 0);
});

test('C: missing emiten are counted PER TYPE (ALL, F)', () => {
  const { tmp, base } = makeBase(['BBCA', 'BBRI', 'TLKM']);
  // BBCA already has ALL for 22 Oct; nothing else exists.
  fs.writeFileSync(path.join(base, 'broker-summary', 'BBCA', '2026-10-22.json'), '{}');
  const m = tool.missingForDate(base, '2026-10-22');
  assert.equal(m.total, 3);
  assert.equal(m.missing.ALL.length, 2, 'BBCA already has ALL');
  assert.equal(m.missing.F.length, 3);
  assert.equal(m.missingCells, 5);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('C: dry-run lists missing cells per date, newest first, and spends nothing', async () => {
  const { tmp, base } = makeBase(['BBCA', 'BBRI', 'TLKM']);
  fs.writeFileSync(path.join(base, 'broker-summary', 'BBCA', '2026-10-22.json'), '{}');

  const client = { getConfiguredDailyQuota: () => 18080, fetchBrokerSummary: async () => { throw new Error('must not fetch in dry-run'); } };
  const tracker = { getUsedToday: () => 0 };
  const summary = await tool.run(['--dry-run', '--dates', '2026-10-22,2026-10-21'], { env: { ARJUM_DATA_DIR: base }, client, tracker, todayWib: '2026-10-24' });

  assert.equal(summary.dry_run, true);
  assert.equal(summary.is_weekend, true);
  assert.equal(summary.floor, 0);
  assert.equal(summary.plan[0].date, '2026-10-22');
  assert.equal(summary.plan[0].missing.ALL, 2, 'BBCA already has ALL');
  assert.equal(summary.plan[0].missing.F, 3);
  assert.equal(summary.plan[0].missing_cells, 5);
  assert.equal(summary.plan[1].date, '2026-10-21');
  assert.equal(summary.plan[1].missing_cells, 6);
  assert.equal(summary.total_missing_cells, 11);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('C: a batch with >20% failures stops the run instead of burning quota', async () => {
  const { tmp, base } = makeBase(['A1', 'A2', 'A3', 'A4', 'A5']);
  let calls = 0;
  const client = {
    getConfiguredDailyQuota: () => 18080,
    fetchBrokerSummary: async () => { calls += 1; return { ok: false, status: 502, error: 'bad gateway' }; },
    fetchBrokerAccumulation: async () => { calls += 1; return { ok: false, status: 502 }; },
    fetchInsiders: async () => { calls += 1; return { ok: false, status: 502 }; }
  };
  const tracker = { getUsedToday: () => 0 };
  const summary = await tool.run(['--dates', '2026-10-22', '--batch', '5'], { env: { ARJUM_DATA_DIR: base }, client, tracker, todayWib: '2026-10-24' });

  assert.equal(summary.stopped, 'failure_ratio_exceeded');
  assert.equal(summary.results[0].failed, 5, 'ALL failed for all 5 -> stop before F/accum/insider');
  assert.equal(calls, 5, 'it must stop after the failing batch, not continue to the next date');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('C: a successful batch writes ALL and F and never overwrites another date', async () => {
  const { tmp, base } = makeBase(['BBCA']);
  fs.writeFileSync(path.join(base, 'broker-summary', 'BBCA', '2026-10-19.json'), '{"keep":true}');

  const client = {
    getConfiguredDailyQuota: () => 18080,
    fetchBrokerSummary: async (ticker, date, flow) => ({ ok: true, data: { stock_code: ticker, date, flow: flow || 'all' } })
  };
  const tracker = { getUsedToday: () => 0 };
  const summary = await tool.run(['--dates', '2026-10-22', '--batch', '10'], { env: { ARJUM_DATA_DIR: base }, client, tracker, todayWib: '2026-10-24' });

  assert.equal(summary.spent, 2, 'ALL + F');
  for (const dir of ['broker-summary', 'broker-summary-F']) {
    assert.ok(fs.existsSync(path.join(base, dir, 'BBCA', '2026-10-22.json')), dir + ' must be written');
  }
  assert.equal(fs.readFileSync(path.join(base, 'broker-summary', 'BBCA', '2026-10-19.json'), 'utf8'), '{"keep":true}');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('C: --skip-f fills ALL only', async () => {
  const { tmp, base } = makeBase(['BBCA']);
  const client = {
    getConfiguredDailyQuota: () => 18080,
    fetchBrokerSummary: async (ticker, date, flow) => ({ ok: true, data: { stock_code: ticker, date, flow: flow || 'all' } })
  };
  const tracker = { getUsedToday: () => 0 };
  const summary = await tool.run(['--dates', '2026-10-22', '--batch', '10', '--skip-f'], { env: { ARJUM_DATA_DIR: base }, client, tracker, todayWib: '2026-10-24' });
  assert.equal(summary.spent, 1);
  assert.ok(!fs.existsSync(path.join(base, 'broker-summary-F', 'BBCA', '2026-10-22.json')));
  fs.rmSync(tmp, { recursive: true, force: true });
});
