'use strict';
/**
 * TASK C — focused regression tests for quarterly windows, incomplete issuer
 * state, and the mocked manual-fetch path. All state is isolated via env paths
 * set by the runner; no provider calls, no DB writes, no production caches.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const ISOLATED = process.env.TASK_C_ISOLATED === '1';
if (!ISOLATED) throw new Error('TASK_C_ISOLATED=1 required — never run against production state');
for (const key of ['FINANCIAL_WINDOW_CONFIG_PATH', 'FINANCIAL_INCOMPLETE_STATE_PATH', 'QUOTA_OPS_CONFIG_PATH']) {
  const p = process.env[key];
  if (!p) throw new Error(key + ' required');
  const abs = path.resolve(p);
  if (!abs.startsWith(path.resolve(ROOT, 'audit-evidence') + path.sep) && !abs.startsWith(path.resolve(ROOT, 'tmp_taskc') + path.sep)) {
    throw new Error(key + ' must point to isolated evidence/tmp path: ' + abs);
  }
}

const windowStore = require('../../lib/financial-window-store');
const incomplete = require('../../lib/financial-incomplete-store');
const manual = require('../../lib/financial-manual-fetch');
const quotaStore = require('../../lib/quota-config-store');

function freshQuota() {
  const doc = Object.assign(quotaStore.blankDoc ? quotaStore.blankDoc() : {}, {
    configuredOperatingCap: 18080,
    reserveFloorWeekday: 5000,
    priorityOrder: ['broksum-ALL', 'broksum-Foreign', 'insider-tiered', 'candles', 'financial']
  });
  return { ok: true, doc };
}

test('C1: default windows are 5..15 for Q1/Q2/Q3/Q4/FY with Q4 and FY separate', () => {
  const d = windowStore.blankDoc();
  for (const p of ['Q1', 'Q2', 'Q3', 'Q4', 'FY']) {
    assert.equal(d.periods[p].startDay, 5, p + '.startDay');
    assert.equal(d.periods[p].endDay, 15, p + '.endDay');
  }
  assert.notEqual(d.periods.Q4.startDay, null);
  assert.notEqual(d.periods.FY.startDay, null);
});

test('C2: window config is versioned, validated, and read back', () => {
  const before = windowStore.get();
  const r = windowStore.put({ periods: { Q3: { startDay: 6, endDay: 14 } } }, {
    actor: 'offline-admin', reason: 'OFFLINE SYNTHETIC window test', now: new Date('2026-11-20T07:00:00Z')
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.readbackOk, true);
  assert.equal(r.version, before.doc.version + 1);
  const after = windowStore.get();
  assert.equal(after.doc.periods.Q3.startDay, 6);
  assert.equal(after.doc.periods.Q3.endDay, 14);
  // Invalid patch cannot mutate.
  const bad = windowStore.put({ periods: { Q1: { startDay: 20, endDay: 5 } } }, { actor: 'offline-admin' });
  assert.equal(bad.ok, false);
  assert.equal(windowStore.get().doc.version, r.version);
  // Restore default for later tests.
  windowStore.put({ periods: { Q3: { startDay: 5, endDay: 15 } } }, { actor: 'offline-admin', reason: 'restore default' });
});

test('C3: resolveWindow derives 5 May–15 May for Q1 and 5 Apr–15 Apr for FY', () => {
  const q1 = manual.resolveWindow('Q1', 2026, { readWindow: () => ({ ok: true, doc: windowStore.blankDoc() }) });
  assert.equal(q1.ok, true);
  assert.equal(q1.window.deadline, '2026-04-30');
  assert.equal(q1.window.start, '2026-05-05');
  assert.equal(q1.window.end, '2026-05-15');
  const fy = manual.resolveWindow('FY', 2026, { readWindow: () => ({ ok: true, doc: windowStore.blankDoc() }) });
  assert.equal(fy.window.deadline, '2027-03-31');
  assert.equal(fy.window.start, '2027-04-05');
  assert.equal(fy.window.end, '2027-04-15');
  const q4 = manual.resolveWindow('Q4', 2026, { readWindow: () => ({ ok: true, doc: windowStore.blankDoc() }) });
  assert.equal(q4.window.start, '2027-02-05');
  assert.equal(q4.window.end, '2027-02-15');
});

test('C4: incomplete issuer store requires source/as_of/reason and is idempotent', () => {
  const bad = incomplete.upsert({ ticker: 'AAAA', fiscal_year: 2026, period: 'Q3', status: 'MISSING' }, { actor: 'offline-admin' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /source/.test(e)));
  const good = incomplete.upsert({
    ticker: 'AAAA', fiscal_year: 2026, period: 'Q3', status: 'MISSING',
    source: 'OFFLINE SYNTHETIC observation', as_of: '2026-11-20', reason: 'no verified publication receipt',
    target_period: '2026Q3', fetch_window: { start: '2026-11-05', end: '2026-11-15' }
  }, { actor: 'offline-admin', now: new Date('2026-11-20T07:00:00Z') });
  assert.equal(good.ok, true, JSON.stringify(good));
  assert.equal(good.entry.ticker, 'AAAA');
  assert.equal(good.entry.source, 'OFFLINE SYNTHETIC observation');
  const list = incomplete.list({ openOnly: true });
  assert.ok(list.entries.some((e) => e.ticker === 'AAAA' && e.period === 'Q3'));
});

test('C5: manual fetch rejects live transport and blocked quota before any transport call', async () => {
  let calls = 0;
  const live = { id: 'LIVE-PROVIDER', fetch: async () => { calls++; return { published: true }; } };
  const r1 = await manual.runManualFetch({ ticker: 'AAAA', fiscal_year: 2026, period: 'Q3', transport: live }, { readQuota: freshQuota });
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'LIVE_TRANSPORT_REJECTED');
  assert.equal(calls, 0);
  const mock = { id: 'MOCK-OFFLINE', fetch: async () => { calls++; return { published: false }; } };
  const blockedQuota = { ok: true, doc: Object.assign(freshQuota().doc, { killSwitch: true }) };
  const r2 = await manual.runManualFetch({ ticker: 'AAAA', fiscal_year: 2026, period: 'Q3', transport: mock }, { readQuota: () => blockedQuota });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'KILL_SWITCH');
  assert.equal(calls, 0);
});

test('C6: mocked manual fetch updates state, reports 0/0, and is idempotent', async () => {
  // The UI button only appears for an existing incomplete entry — seed it first.
  incomplete.upsert({
    ticker: 'BBBB', fiscal_year: 2026, period: 'Q3', status: 'MISSING',
    source: 'OFFLINE SYNTHETIC observation', as_of: '2026-11-20', reason: 'no verified publication receipt'
  }, { actor: 'offline-admin', now: new Date('2026-11-20T07:30:00Z') });
  let calls = 0;
  const mock = {
    id: 'MOCK-OFFLINE',
    fetch: async (q) => {
      calls++;
      return { published: false, source: 'MOCK-OFFLINE', as_of: '2026-11-20', reason: 'OFFLINE SYNTHETIC no publication' };
    }
  };
  const opts = { readQuota: freshQuota, now: new Date('2026-11-20T08:00:00Z'), actor: 'offline-admin' };
  const r = await manual.runManualFetch({ ticker: 'BBBB', fiscal_year: 2026, period: 'Q3', transport: mock, attemptId: 'taskc-attempt-bbbb' }, opts);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.outcome, 'NOT_PUBLISHED');
  assert.equal(r.httpRequests, 0);
  assert.equal(r.billedUnits, 0);
  assert.equal(r.readbackOk, true);
  assert.equal(calls, 1);
  const r2 = await manual.runManualFetch({ ticker: 'BBBB', fiscal_year: 2026, period: 'Q3', transport: mock, attemptId: 'taskc-attempt-bbbb' }, opts);
  assert.equal(r2.ok, true);
  assert.equal(r2.outcome, 'ALREADY_ATTEMPTED');
  assert.equal(calls, 1, 'idempotent replay must not call transport again');
  const entry = incomplete.list({ openOnly: false }).entries.find((e) => e.ticker === 'BBBB');
  assert.ok(entry);
  assert.equal(entry.last_attempt_id, 'taskc-attempt-bbbb');
  assert.equal(entry.attempts, 1);
});

test('C7: no global fetch/network used by manual fetch path', async () => {
  const originalFetch = global.fetch;
  let network = 0;
  global.fetch = async () => { network++; throw new Error('NETWORK_FORBIDDEN'); };
  try {
    const mock = { id: 'MOCK-OFFLINE', fetch: async () => ({ published: false, source: 'MOCK-OFFLINE', as_of: '2026-11-20' }) };
    await manual.runManualFetch({ ticker: 'CCCC', fiscal_year: 2026, period: 'Q1', transport: mock, attemptId: 'taskc-cccc' }, { readQuota: freshQuota, now: new Date('2026-11-20T09:00:00Z') });
    assert.equal(network, 0);
  } finally {
    global.fetch = originalFetch;
  }
});
