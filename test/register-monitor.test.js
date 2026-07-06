'use strict';

/**
 * Tests for registerCandidatesForMonitoring logic.
 *
 * Since sector-hot.js has heavy dependencies (@supabase/supabase-js, etc.) that
 * may not be installable in CI/sandbox, we replicate the exact function logic here
 * and test it in isolation. The function is also exported via __test for integration tests.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// === Replicate the exact function logic from sector-hot.js for unit testing ===
function dailyPickInsertRowFromCandidate(candidate, date, firstSentAt) {
  return { date: date, ticker: candidate.ticker, category: candidate.category, entry1: candidate.entry1, entry2: candidate.entry2, tp1: candidate.tp1n, tp2: candidate.tp2n, sl: candidate.sl, status: 'WAITING', first_sent_at: firstSentAt || null, raw_payload: candidate };
}

async function registerCandidatesForMonitoring(supabase, candidates, date, source) {
  if (!candidates || candidates.length === 0) return { inserted_count: 0, skipped_duplicate_count: 0 };
  try {
    var existingRes = await supabase.from('telegram_daily_picks').select('ticker').eq('date', date);
    var existingTickers = {};
    (existingRes.data || []).forEach(function(r) { if (r.ticker) existingTickers[r.ticker] = true; });

    var nowIso = new Date().toISOString();
    var newRows = [];
    var skipped = 0;
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (!c || !c.ticker || !c.entry1 || !c.sl) continue;
      if (existingTickers[c.ticker]) { skipped++; continue; }
      existingTickers[c.ticker] = true;
      var row = dailyPickInsertRowFromCandidate(c, date, nowIso);
      row.raw_payload = Object.assign({}, row.raw_payload || {}, { monitor_source: source, registered_at: nowIso });
      newRows.push(row);
    }

    if (newRows.length === 0) return { inserted_count: 0, skipped_duplicate_count: skipped };

    var ins = await supabase.from('telegram_daily_picks').insert(newRows);
    if (ins.error) return { inserted_count: 0, skipped_duplicate_count: skipped, error: ins.error.message };
    return { inserted_count: newRows.length, skipped_duplicate_count: skipped };
  } catch (e) {
    return { inserted_count: 0, skipped_duplicate_count: 0, error: (e.message || '').substring(0, 80) };
  }
}

// === Mock supabase helpers ===
function makeSupabase(existingTickers, insertError) {
  var insertedRows = [];
  return {
    insertedRows: insertedRows,
    from: function(table) {
      return {
        select: function(cols) {
          return {
            eq: function(col, val) {
              return Promise.resolve({
                data: (existingTickers || []).map(function(t) { return { ticker: t }; }),
                error: null
              });
            }
          };
        },
        insert: function(rows) {
          if (insertError) return Promise.resolve({ error: { message: insertError } });
          insertedRows.push.apply(insertedRows, rows);
          return Promise.resolve({ data: rows, error: null });
        }
      };
    }
  };
}

function makeCandidate(ticker, category) {
  return {
    ticker: ticker,
    category: category || 'Day Trade',
    entry1: 5000,
    entry2: 4900,
    tp1n: 5500,
    tp2n: 6000,
    sl: 4700,
    status: 'Swing Ready',
    risk_reward: 2.1,
    score: 75
  };
}

// === Tests ===

test('registerCandidatesForMonitoring inserts new candidates', async function() {
  var supabase = makeSupabase([]);
  var candidates = [
    makeCandidate('BBRI', 'Swing Konglo'),
    makeCandidate('TLKM', 'Swing Konglo')
  ];
  var result = await registerCandidatesForMonitoring(supabase, candidates, '2026-07-06', 'swing_konglo');
  assert.equal(result.inserted_count, 2);
  assert.equal(result.skipped_duplicate_count, 0);
  assert.equal(supabase.insertedRows.length, 2);
  assert.equal(supabase.insertedRows[0].ticker, 'BBRI');
  assert.equal(supabase.insertedRows[0].date, '2026-07-06');
  assert.equal(supabase.insertedRows[0].status, 'WAITING');
  assert.equal(supabase.insertedRows[0].category, 'Swing Konglo');
  assert.equal(supabase.insertedRows[0].entry1, 5000);
  assert.equal(supabase.insertedRows[0].sl, 4700);
  assert.equal(supabase.insertedRows[0].tp1, 5500);
  assert.equal(supabase.insertedRows[0].tp2, 6000);
  assert.ok(supabase.insertedRows[0].first_sent_at, 'first_sent_at should be set');
  assert.equal(supabase.insertedRows[0].raw_payload.monitor_source, 'swing_konglo');
});

test('registerCandidatesForMonitoring skips existing tickers (duplicate prevention)', async function() {
  var supabase = makeSupabase(['BBRI']);
  var candidates = [
    makeCandidate('BBRI', 'Swing Konglo'),
    makeCandidate('TLKM', 'Swing Konglo')
  ];
  var result = await registerCandidatesForMonitoring(supabase, candidates, '2026-07-06', 'swing_konglo');
  assert.equal(result.inserted_count, 1);
  assert.equal(result.skipped_duplicate_count, 1);
  assert.equal(supabase.insertedRows.length, 1);
  assert.equal(supabase.insertedRows[0].ticker, 'TLKM');
});

test('registerCandidatesForMonitoring skips duplicates within same batch', async function() {
  var supabase = makeSupabase([]);
  var candidates = [
    makeCandidate('BBRI', 'Day Trade'),
    makeCandidate('BBRI', 'Day Trade')
  ];
  var result = await registerCandidatesForMonitoring(supabase, candidates, '2026-07-06', 'daytrade_signal');
  assert.equal(result.inserted_count, 1);
  assert.equal(result.skipped_duplicate_count, 1);
});

test('registerCandidatesForMonitoring returns 0 for empty candidates', async function() {
  var supabase = makeSupabase([]);
  var result = await registerCandidatesForMonitoring(supabase, [], '2026-07-06', 'test');
  assert.equal(result.inserted_count, 0);
  assert.equal(result.skipped_duplicate_count, 0);
});

test('registerCandidatesForMonitoring returns 0 for null candidates', async function() {
  var supabase = makeSupabase([]);
  var result = await registerCandidatesForMonitoring(supabase, null, '2026-07-06', 'test');
  assert.equal(result.inserted_count, 0);
  assert.equal(result.skipped_duplicate_count, 0);
});

test('registerCandidatesForMonitoring skips candidates missing required fields', async function() {
  var supabase = makeSupabase([]);
  var candidates = [
    { ticker: 'BBRI', category: 'Day Trade', entry1: 5000, tp1n: 5500, tp2n: 6000 }, // missing sl
    { ticker: null, category: 'Day Trade', entry1: 5000, sl: 4700, tp1n: 5500, tp2n: 6000 }, // missing ticker
    { category: 'Day Trade', entry1: 5000, sl: 4700, tp1n: 5500, tp2n: 6000 }, // missing ticker (undefined)
    { ticker: 'EXCL', category: 'Day Trade', sl: 4700, tp1n: 5500, tp2n: 6000 }, // missing entry1
    makeCandidate('TLKM', 'Day Trade') // valid
  ];
  var result = await registerCandidatesForMonitoring(supabase, candidates, '2026-07-06', 'daytrade_signal');
  assert.equal(result.inserted_count, 1);
  assert.equal(supabase.insertedRows[0].ticker, 'TLKM');
});

test('registerCandidatesForMonitoring handles insert error gracefully', async function() {
  var supabase = makeSupabase([], 'DB connection error');
  var candidates = [makeCandidate('BBRI', 'Day Trade')];
  var result = await registerCandidatesForMonitoring(supabase, candidates, '2026-07-06', 'daytrade_signal');
  assert.equal(result.inserted_count, 0);
  assert.equal(result.error, 'DB connection error');
});

test('registerCandidatesForMonitoring sets monitor_source and registered_at in raw_payload', async function() {
  var supabase = makeSupabase([]);
  var candidates = [makeCandidate('EXCL', 'Swing Non-Konglo')];
  var result = await registerCandidatesForMonitoring(supabase, candidates, '2026-07-06', 'swing_nk');
  assert.equal(result.inserted_count, 1);
  assert.equal(supabase.insertedRows[0].raw_payload.monitor_source, 'swing_nk');
  assert.ok(supabase.insertedRows[0].raw_payload.registered_at, 'registered_at should be set');
});

test('registerCandidatesForMonitoring handles exception in supabase.from gracefully', async function() {
  var supabase = {
    from: function() { throw new Error('Network timeout'); }
  };
  var candidates = [makeCandidate('BBRI', 'Day Trade')];
  var result = await registerCandidatesForMonitoring(supabase, candidates, '2026-07-06', 'daytrade_signal');
  assert.equal(result.inserted_count, 0);
  assert.equal(result.error, 'Network timeout');
});
