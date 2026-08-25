'use strict';

// PRODUCTION WIRING REGRESSION TEST — not a library unit test.
//
// lib/daytrade-entry-discipline-observability.js was landed and unit-tested
// (test/daytrade-entry-discipline-observability.test.js) but was never
// imported or called from api/sector-hot.js, so the summary never reached
// any real API response. This test exercises the actual Day Trade Screener
// read handler (the same function the public endpoint calls) and asserts
// the observability summary is present in the response and reflects the
// FINAL decorated/sorted rows that are actually sent to the client — not
// raw Supabase rows. If the import/call is ever removed from
// api/sector-hot.js, this test must fail.

const test = require('node:test');
const assert = require('node:assert/strict');
const sectorHot = require('../api/sector-hot');
const { summarizeDayTradeEntryDiscipline } = require('../lib/daytrade-entry-discipline-observability');

function mockSupabase(rows, meta) {
  return {
    from(table) {
      if (table === 'daytrade_screener_meta') {
        return { select() { return this; }, eq() { return this; }, async maybeSingle() { return { data: meta, error: null }; } };
      }
      if (table === 'daytrade_screener_latest') {
        return { select() { return this; }, order() { return this; }, async limit() { return { data: rows, error: null }; } };
      }
      throw new Error('unexpected table ' + table);
    }
  };
}

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = function(code) { res.statusCode = code; return res; };
  res.json = function(payload) { res.body = payload; return payload; };
  return res;
}

test('handleDayTradeScreenerRead response includes daytrade_entry_discipline_observability reflecting final rows', async () => {
  const rows = [
    {
      ticker: 'LEAD', status: 'EARLY_RADAR', daytrade_score: 70,
      entry_low: 97, entry_high: 99, entry1: null, entry2: null, entry_mid: null,
      tp1: 105, tp1n: null, tp1_upside: null, tp1_upside_pct: null,
      stop_loss: 95, last_price: 98, risk_reward: 2
    },
    {
      ticker: 'BBRM', status: 'WAIT_PULLBACK', daytrade_score: 69,
      entry_low: 113, entry_high: 116, entry1: null, entry2: null, entry_mid: null,
      tp1: 142, tp1n: null, tp1_upside: null, tp1_upside_pct: null,
      stop_loss: 110, last_price: 200, risk_reward: 2
    },
    {
      ticker: 'CHSE', status: 'WITHIN_ENTRY_RANGE', daytrade_score: 65,
      entry_low: 500, entry_high: 520, entry1: null, entry2: null, entry_mid: null,
      tp1: 560, tp1n: null, tp1_upside: null, tp1_upside_pct: null,
      stop_loss: 490, last_price: 480, risk_reward: 2
    }
  ];
  const meta = { calculated_at: '2026-08-25T00:00:00Z', status: 'completed', published_count: rows.length, scanned_count: rows.length };
  const supabase = mockSupabase(rows, meta);
  const res = mockRes();

  await sectorHot.__test.handleDayTradeScreenerRead({ query: { action: 'daytrade-screener' } }, res, supabase);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.ok(Array.isArray(res.body.results));
  assert.ok(res.body.results.length > 0, 'expected decorated results to be non-empty for this fixture');

  // Regression guard: the field must exist and be an object shaped like the
  // library's summary output, not undefined/missing.
  const observability = res.body.daytrade_entry_discipline_observability;
  assert.ok(observability && typeof observability === 'object', 'daytrade_entry_discipline_observability must be present in the API response');
  assert.equal(typeof observability.total_count, 'number');
  assert.equal(typeof observability.by_status, 'object');

  // Must reflect the FINAL rows sent to the client (post sort + decoration +
  // enrichment), not the raw Supabase rows fed into the handler. Raw rows
  // carry no entry_discipline_status/entry_executable_now fields at all
  // (those are attached by decorateDayTradeExecution), so summarizing the
  // raw input would misclassify everything into ENTRY_UNVERIFIED/blocked —
  // proving the handler must be summarizing post-decoration data.
  assert.equal(observability.total_count, res.body.results.length);
  const rawSummary = summarizeDayTradeEntryDiscipline(rows);
  assert.equal(rawSummary.by_status.ENTRY_UNVERIFIED.count, rows.length);
  assert.notEqual(observability.by_status.ENTRY_UNVERIFIED.count, rows.length);

  // Recomputing the summary from the actual response rows must produce an
  // identical object — proving the handler summarized what it actually sent,
  // not some earlier/raw snapshot of the data.
  const expected = summarizeDayTradeEntryDiscipline(res.body.results);
  assert.deepEqual(observability, expected);
});

test('handleDayTradeScreenerRead response observability is stable (not divide-by-zero) with no rows', async () => {
  const meta = { calculated_at: null, status: 'pending', published_count: 0, scanned_count: 0 };
  const supabase = mockSupabase([], meta);
  const res = mockRes();

  await sectorHot.__test.handleDayTradeScreenerRead({ query: { action: 'daytrade-screener' } }, res, supabase);

  assert.equal(res.statusCode, 200);
  const observability = res.body.daytrade_entry_discipline_observability;
  assert.ok(observability, 'daytrade_entry_discipline_observability must be present even for empty results');
  assert.equal(observability.total_count, 0);
  assert.equal(observability.chased_pct, null);
});
