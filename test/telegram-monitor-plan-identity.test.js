'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const origLoad = Module._load;
Module._load = function(request) {
  if (request === '@supabase/supabase-js') return { createClient: function() { return {}; } };
  return origLoad.apply(this, arguments);
};
process.env.CRON_SECRET = process.env.CRON_SECRET || 'test-secret-plan-identity';
const sectorHot = require('../api/sector-hot.js');
Module._load = origLoad;

const {
  buildMonitorPlanIdentity,
  resolveMonitorPlanIdentity,
  buildMonitorDedupKey,
  dedupeActiveMonitorRows,
  registerCandidatesForMonitoring,
  evaluateMonitorStatus
} = sectorHot.__test;

function candidate(overrides) {
  return Object.assign({ ticker: 'BBRI', category: 'Swing Konglo', entry1: 5100, entry2: 5000, tp1n: 5500, tp2n: 5800, sl: 4800, calculated_at: new Date().toISOString() }, overrides || {});
}

function row(overrides) {
  return Object.assign({ id: 1, date: '2026-08-04', ticker: 'BBRI', category: 'Swing Konglo', monitor_source: 'swing_konglo', plan_lock_id: null, status: 'WAITING', is_final: false, entry1: 5100, entry2: 5000, tp1: 5500, tp2: 5800, sl: 4800, created_at: new Date().toISOString(), first_sent_at: new Date().toISOString(), raw_payload: { monitor_source: 'swing_konglo', calculated_at: new Date().toISOString() } }, overrides || {});
}

test('monitor plan identity is stable for an identical locked plan', () => {
  const a = buildMonitorPlanIdentity(candidate(), '2026-08-04', 'swing_konglo');
  const b = buildMonitorPlanIdentity(candidate({ score: 99, last_price: 5200 }), '2026-08-04', 'swing_konglo');
  assert.equal(a.valid, true);
  assert.equal(a.plan_lock_id, b.plan_lock_id);
  assert.match(a.plan_lock_id, /^tplock_/);
});

test('changed entry/SL/TP creates a different monitor plan identity', () => {
  const base = buildMonitorPlanIdentity(candidate(), '2026-08-04', 'swing_konglo');
  const changed = buildMonitorPlanIdentity(candidate({ entry1: 5200 }), '2026-08-04', 'swing_konglo');
  assert.notEqual(base.plan_lock_id, changed.plan_lock_id);
});

test('dedupe keeps distinct identified plans for the same ticker and source', () => {
  const rows = [
    row({ id: 1, plan_lock_id: 'tplock_A', raw_payload: { monitor_source: 'swing_konglo', plan_lock_id: 'tplock_A' } }),
    row({ id: 2, plan_lock_id: 'tplock_B', raw_payload: { monitor_source: 'swing_konglo', plan_lock_id: 'tplock_B' } })
  ];
  const out = dedupeActiveMonitorRows(rows);
  assert.equal(out.kept.length, 2);
  assert.equal(out.ignored.length, 0);
});

test('dedupe collapses exact duplicate rows for one identified plan', () => {
  const rows = [
    row({ id: 1, plan_lock_id: 'tplock_A', raw_payload: { monitor_source: 'swing_konglo', plan_lock_id: 'tplock_A' } }),
    row({ id: 2, plan_lock_id: 'tplock_A', raw_payload: { monitor_source: 'swing_konglo', plan_lock_id: 'tplock_A' } })
  ];
  const out = dedupeActiveMonitorRows(rows);
  assert.equal(out.kept.length, 1);
  assert.equal(out.kept[0].id, 2);
  assert.equal(out.ignored[0].reason, 'duplicate_exact_plan');
});

test('legacy and identified plans never share a dedupe namespace', () => {
  const legacy = row({ id: 1, plan_lock_id: null, raw_payload: { monitor_source: 'swing_konglo' } });
  const identified = row({ id: 2, plan_lock_id: 'tplock_A', raw_payload: { monitor_source: 'swing_konglo', plan_lock_id: 'tplock_A' } });
  assert.notEqual(buildMonitorDedupKey(legacy), buildMonitorDedupKey(identified));
  assert.equal(resolveMonitorPlanIdentity(identified), 'tplock_A');
  assert.equal(dedupeActiveMonitorRows([legacy, identified]).kept.length, 2);
});

function makeSupabase(existingRows) {
  const insertedRows = [];
  return {
    insertedRows,
    from(table) {
      assert.equal(table, 'telegram_daily_picks');
      return {
        select() {
          return { eq: async function() { return { data: existingRows || [], error: null }; } };
        },
        insert(rows) {
          insertedRows.push(...rows);
          return Promise.resolve({ data: rows, error: null });
        }
      };
    }
  };
}

test('real registration allows same ticker with different sources and plans', async () => {
  const supabase = makeSupabase([]);
  const first = await registerCandidatesForMonitoring(supabase, [candidate()], '2026-08-04', 'swing_konglo');
  const second = await registerCandidatesForMonitoring(supabase, [candidate({ category: 'Swing Non-Konglo' })], '2026-08-04', 'swing_nk');
  assert.equal(first.inserted_count, 1);
  assert.equal(second.inserted_count, 1);
  assert.notEqual(supabase.insertedRows[0].monitor_source, supabase.insertedRows[1].monitor_source);
});

test('real registration skips the exact same plan identity', async () => {
  const identity = buildMonitorPlanIdentity(candidate(), '2026-08-04', 'swing_konglo');
  const supabase = makeSupabase([{ ticker: 'BBRI', monitor_source: 'swing_konglo', plan_lock_id: identity.plan_lock_id, raw_payload: { monitor_source: 'swing_konglo', plan_lock_id: identity.plan_lock_id } }]);
  const result = await registerCandidatesForMonitoring(supabase, [candidate()], '2026-08-04', 'swing_konglo');
  assert.equal(result.inserted_count, 0);
  assert.equal(result.skipped_duplicate_count, 1);
});

test('best-effort daily close cannot fabricate an entry/TP/SL touch', () => {
  const pick = row({ status: 'WAITING', raw_payload: { monitor_source: 'swing_konglo', calculated_at: new Date().toISOString() } });
  const ev = evaluateMonitorStatus(pick, { last: 5600, high: null, low: null, at: '2026-08-04', bestEffort: true, source: 'foreign_watchlist_daily.close' });
  assert.equal(ev.status, 'NEEDS_REVALIDATION');
  assert.equal(ev.price_revalidation_required, true);
});
