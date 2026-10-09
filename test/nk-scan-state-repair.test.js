'use strict';
// BUG-NK-META-REPLACE / BUG-NK-PLAN-RESUME / BUG-NK-STALE-PROCESSING
// Regression suite for the Non-Konglo scan state machine repairs (2026-10-09).
const test = require('node:test');
const assert = require('node:assert/strict');

// The NK orchestrator handlers are CRON_SECRET-gated; tests authenticate the
// same way production does (Bearer header against process.env.CRON_SECRET).
process.env.CRON_SECRET = process.env.CRON_SECRET || 'test-nk-secret';
function authedReq(query) {
  return {
    query: query || {},
    headers: { authorization: 'Bearer ' + process.env.CRON_SECRET }
  };
}

// Lightweight in-memory Supabase stub for the VPS market-store semantics:
// upsert REPLACES the whole row blob (that is exactly what the production
// SQLite-backed store does — it does NOT merge columns).
function makeStore(seedRows) {
  const tables = {};
  Object.entries(seedRows || {}).forEach(([table, rows]) => {
    tables[table] = rows.map((r) => Object.assign({}, r));
  });
  function ensure(table) { if (!tables[table]) tables[table] = []; return tables[table]; }

  function from(table) {
    const state = { filters: [], orFilters: [], order: null, limit: null, single: null, action: 'select', payload: null, onConflict: null, head: false };

    const builder = {
      select(_cols, opts) {
        if (opts && opts.head) state.head = true;
        if (state.action === 'select') state.action = 'select';
        return builder;
      },
      insert(rows) { state.action = 'insert'; state.payload = Array.isArray(rows) ? rows : [rows]; return builder; },
      upsert(rows, opts) { state.action = 'upsert'; state.payload = Array.isArray(rows) ? rows : [rows]; state.onConflict = opts && opts.onConflict || null; return builder; },
      update(values) { state.action = 'update'; state.payload = Object.assign({}, values || {}); return builder; },
      delete() { state.action = 'delete'; return builder; },
      eq(field, value) { state.filters.push({ field, value }); return builder; },
      in(field, values) { state.filters.push({ field, value: values, isIn: true }); return builder; },
      order(field, opts) { state.order = { field, ascending: !(opts && opts.ascending === false) }; return builder; },
      limit(n) { state.limit = n; return builder; },
      maybeSingle() { state.single = 'maybe'; return builder; },
      single() { state.single = 'single'; return builder; },
      then(resolve, reject) { return builder._exec().then(resolve, reject); },

      _match(row) {
        return state.filters.every((f) => {
          if (f.isIn) return f.value.includes(row[f.field]);
          return row[f.field] === f.value || String(row[f.field]) === String(f.value);
        });
      },
      async _exec() {
        const rows = ensure(table);
        if (state.action === 'select') {
          let matched = rows.filter((r) => builder._match(r));
          if (state.head) return { data: null, error: null, count: matched.length };
          if (state.order) {
            const { field, ascending } = state.order;
            matched = matched.slice().sort((a, b) => {
              const cmp = (a[field] > b[field]) ? 1 : (a[field] < b[field] ? -1 : 0);
              return ascending ? cmp : -cmp;
            });
          }
          if (state.limit != null) matched = matched.slice(0, state.limit);
          if (state.single) {
            if (matched.length === 1) return { data: matched[0], error: null };
            if (matched.length === 0 && state.single === 'maybe') return { data: null, error: null };
            return { data: null, error: { message: 'single expected' } };
          }
          return { data: matched.map((r) => Object.assign({}, r)), error: null };
        }
        if (state.action === 'insert' || state.action === 'upsert') {
          const keyFields = state.onConflict ? state.onConflict.split(',').map((s) => s.trim()) : ['id'];
          state.payload.forEach((row) => {
            const existingIndex = rows.findIndex((r) => keyFields.every((k) => String(r[k]) === String(row[k])));
            if (existingIndex >= 0) {
              if (state.action === 'upsert') rows[existingIndex] = Object.assign({}, row); // REPLACE semantics
            } else {
              rows.push(Object.assign({}, row));
            }
          });
          return { data: state.payload, error: null };
        }
        if (state.action === 'update') {
          const matched = rows.filter((r) => builder._match(r));
          matched.forEach((r) => Object.assign(r, state.payload));
          return { data: matched, error: null };
        }
        if (state.action === 'delete') {
          const remaining = rows.filter((r) => !builder._match(r));
          tables[table] = remaining;
          return { data: null, error: null };
        }
        return { data: null, error: null };
      }
    };
    return builder;
  }
  return { from, tables };
}

const sectorHot = require('../api/sector-hot');
const runner = require('../tools/run-all-screeners-vps');

test('NK-02/NK-03: partial meta update preserves run_date and batch_size (no replace-wipe)', async () => {
  const store = makeStore({
    swing_screener_non_konglo_meta: [{
      id: 'latest',
      status: 'scanning',
      run_date: '2026-10-09',
      batch_size: 50,
      total_batches: 13,
      universe_count: 635,
      scanned_count: 100
    }]
  });

  await sectorHot.__test.updateNkMeta(store, { status: 'scanning', message: 'Batch 2 done.' });

  const meta = store.tables.swing_screener_non_konglo_meta[0];
  assert.equal(meta.status, 'scanning');
  assert.equal(meta.run_date, '2026-10-09', 'run_date must survive a partial update');
  assert.equal(meta.batch_size, 50, 'batch_size must survive a partial update');
  assert.equal(meta.total_batches, 13, 'total_batches must survive a partial update');
  assert.equal(meta.universe_count, 635);
  assert.equal(meta.scanned_count, 100);
  assert.equal(meta.message, 'Batch 2 done.');
});

test('NK-02b: updateNkMeta works when no row exists yet (first write)', async () => {
  const store = makeStore({ swing_screener_non_konglo_meta: [] });
  await sectorHot.__test.updateNkMeta(store, { status: 'scanning', run_date: '2026-10-09', batch_size: 50, total_batches: 13 });
  const meta = store.tables.swing_screener_non_konglo_meta[0];
  assert.equal(meta.id, 'latest');
  assert.equal(meta.run_date, '2026-10-09');
  assert.equal(meta.batch_size, 50);
  assert.equal(meta.total_batches, 13);
});

test('NK-04/NK-05: START resumes the persisted plan instead of rebuilding with default 8', async () => {
  // Universe 635 @ batch_size 50 => 13 batches, already created.
  const jobs = [];
  for (let i = 0; i < 13; i++) jobs.push({ id: i + 1, run_date: '2026-10-09', batch_index: i, status: 'pending', tickers: [] });
  const store = makeStore({
    swing_screener_non_konglo_meta: [{
      id: 'latest', status: 'scanning', run_date: '2026-10-09',
      batch_size: 50, total_batches: 13, universe_count: 635
    }],
    swing_screener_non_konglo_jobs: jobs
  });

  let responded = null;
  const res = { status() { return res; }, json(body) { responded = body; return res; } };

  await sectorHot.__test.handleNkScreenerStart(authedReq(), res, store);

  assert.ok(responded, 'handler must respond');
  assert.equal(responded.resumed, true, 'existing plan must be resumed');
  assert.equal(responded.batch_count, 13, 'plan must stay 13 batches');
  assert.equal(responded.batch_size, 50, 'plan must stay batch_size 50');
  // No job was deleted or recreated: still exactly 13 rows.
  assert.equal(store.tables.swing_screener_non_konglo_jobs.length, 13);
});

test('NK-01/NK-15: batch plan formula is ceil(universe/batch_size) — 635 @ 50 => 13, never 80', () => {
  const universe = 635;
  for (const size of [8, 25, 50]) {
    const expected = Math.ceil(universe / size);
    if (size === 8) assert.equal(expected, 80);
    if (size === 25) assert.equal(expected, 26);
    if (size === 50) assert.equal(expected, 13);
  }
  // The producer must default to 50 so the plan is 13 batches.
  const options = runner.parseArgs(['node', 'runner', '--execute', '--skip-daytrade', '--skip-top5', '--skip-progress']);
  assert.equal(options.nkBatchSize, 50);
});

test('NK-14: runner sends batch_size on every attempt (idempotent plan identity)', async () => {
  const calls = [];
  const client = {
    call: async (q) => {
      calls.push(q);
      if (q.action === 'nk-screener-results') return { meta: { status: 'scanning', run_date: runner.wibDate() } };
      return { step: 'batch', status: 'SCANNING', message: 'ok' };
    }
  };
  await assert.rejects(
    runner.runNk(client, { execute: true, force: false, maxAttempts: 3, sleepMs: 1, nkBatchSize: 50 }, () => {}),
    /max-attempts/
  );
  const runCalls = calls.filter((c) => c.action === 'nk-screener-run');
  assert.ok(runCalls.length >= 2, 'must call run endpoint multiple times');
  runCalls.forEach((c) => assert.equal(c.batch_size, 50, 'every attempt must pin batch_size=50'));
});

test('NK-08/NK-09: stale scan triggers bounded recovery instead of permanent STALE SCAN abort', async () => {
  const staleMeta = { status: 'scanning', updated_at: new Date(Date.now() - 45 * 60 * 1000).toISOString(), run_date: '2026-10-01' };
  const calls = [];
  const client = {
    call: async (q) => {
      calls.push(q);
      if (q.action === 'nk-screener-results') return { meta: staleMeta };
      if (q.action === 'nk-screener-run' && q.recover_stale) return { step: 'finalize', status: 'PUBLISHED', message: 'Published 22 top candidates.' };
      return { step: 'batch' };
    }
  };
  const result = await runner.runNk(client, { execute: true, force: false, maxAttempts: 5, sleepMs: 1, nkBatchSize: 50 }, () => {});
  assert.equal(result.finalized, true);
  assert.equal(result.recovered, true);
  const recovery = calls.find((c) => c.action === 'nk-screener-run' && c.recover_stale === 1);
  assert.ok(recovery, 'recovery call must be sent');
});

test('NK-10: a truly active scan is not disturbed (runner skips fresh published + server blocks fresh processing)', async () => {
  // publishedToday short-circuit — the runner never calls run endpoint.
  let calls = 0;
  const client = { call: async () => { calls += 1; return { meta: { status: 'published', run_date: runner.wibDate() } }; } };
  const result = await runner.runNk(client, { force: false, maxAttempts: 2, sleepMs: 1 }, () => {});
  assert.equal(result.skipped, true);
  assert.equal(calls, 1);

  // Server: fresh processing job (started 1 minute ago) is NOT recovered.
  const store = makeStore({
    swing_screener_non_konglo_meta: [{ id: 'latest', status: 'scanning', run_date: new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10), total_batches: 13, batch_size: 50 }],
    swing_screener_non_konglo_jobs: [{ id: 1, run_date: new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10), batch_index: 0, status: 'processing', started_at: new Date(Date.now() - 60 * 1000).toISOString() }]
  });
  let responded = null;
  const res = { status() { return res; }, json(b) { responded = b; return res; } };
  await sectorHot.__test.handleNkScreenerRun(authedReq(), res, store);
  assert.equal(responded.step, 'blocked', 'fresh processing must still block');
  assert.equal(store.tables.swing_screener_non_konglo_jobs[0].status, 'processing', 'fresh job untouched');
});

test('NK-04b: forced START bypasses resume and rebuilds the plan (force semantics)', async () => {
  // A forced run is routed to START precisely to CLEAR and rebuild jobs/staging.
  const jobs = [];
  for (let i = 0; i < 13; i++) jobs.push({ id: i + 1, run_date: '2026-10-09', batch_index: i, status: 'pending', tickers: [] });
  const store = makeStore({
    swing_screener_non_konglo_meta: [{
      id: 'latest', status: 'scanning', run_date: '2026-10-09',
      batch_size: 50, total_batches: 13, universe_count: 635
    }],
    swing_screener_non_konglo_jobs: jobs,
    stock_boards: [{ ticker: 'AAAA', board: 'UTAMA', is_active: true, is_fca: false, note: null }],
    sector_hot_group_members: []
  });

  let responded = null;
  const res = { status() { return res; }, json(body) { responded = body; return res; } };

  await sectorHot.__test.handleNkScreenerStart(authedReq({ force: '1' }), res, store);

  assert.ok(responded, 'handler must respond');
  assert.notEqual(responded.resumed, true, 'forced run must NOT resume the old plan');
});

test('NK-08b: stale processing job is recovered back to pending deterministically', async () => {
  const runDate = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const store = makeStore({
    swing_screener_non_konglo_meta: [{ id: 'latest', status: 'scanning', run_date: runDate, total_batches: 13, batch_size: 50, universe_count: 635 }],
    swing_screener_non_konglo_jobs: [{ id: 7, run_date: runDate, batch_index: 3, status: 'processing', started_at: new Date(Date.now() - 45 * 60 * 1000).toISOString() }]
  });
  let responded = null;
  const res = { status() { return res; }, json(b) { responded = b; return res; } };
  await sectorHot.__test.handleNkScreenerRun(authedReq(), res, store);
  // The recovered job goes back to pending and the orchestrator processes it
  // (or reports a batch attempt) instead of blocking forever.
  assert.ok(responded && responded.step !== 'blocked', 'stale processing must not block');
  const job = store.tables.swing_screener_non_konglo_jobs[0];
  assert.notEqual(job.status, 'processing', 'stale job must leave processing');
});
