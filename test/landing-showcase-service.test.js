'use strict';

/**
 * Test: Landing Showcase Service
 * Menguji getSnapshot() dan refreshSnapshot() dengan supabase mock.
 */

const assert = require('assert');
const { getSnapshot, refreshSnapshot, KV_KEY } = require('../lib/landing-showcase-service');

// ── Helper: buat supabase mock ──────────────────────────────────────────────

function makeMock(opts) {
  opts = opts || {};
  // Chain builder yang merekam panggilan dan mengembalikan opts.result
  function chainable(finalResult) {
    const chain = {
      select: function() { return chain; },
      eq: function() { return chain; },
      order: function() { return chain; },
      limit: function() { return chain; },
      gte: function() { return chain; },
      maybeSingle: function() { return Promise.resolve(finalResult || { data: null, error: null }); },
      upsert: function() { return Promise.resolve(opts.upsertResult || { data: null, error: null }); },
      then: undefined
    };
    // Make it awaitable at the end of a non-maybeSingle chain
    chain[Symbol.asyncIterator] = undefined;
    Object.defineProperty(chain, 'then', {
      get: function() { return undefined; }
    });
    return chain;
  }

  // Allow per-table response customisation
  return {
    from: function(table) {
      if (table === 'kv_store') {
        return {
          select: function() {
            return {
              eq: function() {
                return {
                  maybeSingle: function() {
                    return Promise.resolve(opts.kvResult || { data: null, error: null });
                  }
                };
              }
            };
          },
          upsert: function() {
            return Promise.resolve(opts.upsertResult || { data: null, error: null });
          }
        };
      }
      if (table === 'sector_hot_latest') {
        return {
          select: function() {
            return {
              order: function() {
                return {
                  limit: function() {
                    return Promise.resolve(opts.sectorsResult || { data: [], error: null });
                  }
                };
              }
            };
          }
        };
      }
      if (table === 'telegram_daily_picks') {
        return {
          select: function() {
            return {
              gte: function() {
                return {
                  order: function() {
                    return {
                      limit: function() {
                        return Promise.resolve(opts.dtResult || { data: [], error: null });
                      }
                    };
                  }
                };
              }
            };
          }
        };
      }
      // fallback
      return chainable();
    }
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log('  ✓', name);
    passed++;
  } catch (e) {
    console.error('  ✗', name);
    console.error('   ', e.message);
    failed++;
  }
}

async function main() {

// getSnapshot — no data in DB
await test('getSnapshot: empty kv_store returns ok=true, snapshot=null, stale=true', async function() {
  const supabase = makeMock({ kvResult: { data: null, error: null } });
  const result = await getSnapshot(supabase);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.snapshot, null);
  assert.strictEqual(result.stale, true);
});

// getSnapshot — valid fresh snapshot in DB
await test('getSnapshot: valid fresh snapshot returns ok=true, stale=false', async function() {
  const snapshot = { sectors: [{ code: 'BANK', name: 'Perbankan', score: 7.2 }], dt_signals: [], generated_at: new Date().toISOString(), source: 'review_data' };
  const supabase = makeMock({
    kvResult: { data: { value: JSON.stringify(snapshot), updated_at: new Date().toISOString() }, error: null }
  });
  const result = await getSnapshot(supabase);
  assert.strictEqual(result.ok, true);
  assert.ok(result.snapshot !== null);
  assert.strictEqual(result.stale, false);
  assert.strictEqual(result.snapshot.sectors[0].code, 'BANK');
});

// getSnapshot — stale snapshot (updated 3 days ago)
await test('getSnapshot: old snapshot returns stale=true', async function() {
  const snapshot = { sectors: [], dt_signals: [], generated_at: '', source: 'review_data' };
  const oldDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const supabase = makeMock({
    kvResult: { data: { value: JSON.stringify(snapshot), updated_at: oldDate }, error: null }
  });
  const result = await getSnapshot(supabase);
  assert.strictEqual(result.stale, true);
});

// getSnapshot — DB error
await test('getSnapshot: DB error returns ok=false', async function() {
  const supabase = makeMock({ kvResult: { data: null, error: { message: 'connection refused' } } });
  const result = await getSnapshot(supabase);
  assert.strictEqual(result.ok, false);
});

// getSnapshot — malformed JSON in value
await test('getSnapshot: malformed JSON in kv returns ok=false', async function() {
  const supabase = makeMock({
    kvResult: { data: { value: '{bad json:::}', updated_at: new Date().toISOString() }, error: null }
  });
  const result = await getSnapshot(supabase);
  assert.strictEqual(result.ok, false);
});

// refreshSnapshot — successful with data
await test('refreshSnapshot: success with sectors and DT data', async function() {
  const supabase = makeMock({
    sectorsResult: {
      data: [
        { group_code: 'BANK', group_name: 'Perbankan', score: 8.1, avg_change_pct: 1.23, calculated_at: new Date().toISOString() },
        { group_code: 'PROP', group_name: 'Properti', score: 5.5, avg_change_pct: -0.5, calculated_at: new Date().toISOString() }
      ],
      error: null
    },
    dtResult: {
      data: [
        { ticker: 'BBCA', raw_payload: JSON.stringify({ signal_type: 'DT', entry: 9500, tp: 9800, sl: 9350, rr: 2.0 }), created_at: new Date().toISOString() },
        { ticker: 'TLKM', raw_payload: JSON.stringify({ signal_type: 'DT', entry: 3200, tp: 3350, sl: 3100, rr: 1.5 }), created_at: new Date().toISOString() }
      ],
      error: null
    },
    upsertResult: { data: null, error: null }
  });

  const result = await refreshSnapshot(supabase);
  assert.strictEqual(result.ok, true);
  assert.ok(result.snapshot !== null);
  assert.ok(Array.isArray(result.snapshot.sectors));
  assert.ok(Array.isArray(result.snapshot.dt_signals));
  assert.strictEqual(result.snapshot.sectors[0].code, 'BANK');
  assert.strictEqual(result.snapshot.dt_signals[0].ticker, 'BBCA');
  assert.strictEqual(result.snapshot.source, 'review_data');
});

// refreshSnapshot — no sectors/DT data still succeeds
await test('refreshSnapshot: success even with empty DB (no sectors, no DT)', async function() {
  const supabase = makeMock({
    sectorsResult: { data: [], error: null },
    dtResult: { data: [], error: null },
    upsertResult: { data: null, error: null }
  });
  const result = await refreshSnapshot(supabase);
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.snapshot.sectors, []);
  assert.deepStrictEqual(result.snapshot.dt_signals, []);
});

// refreshSnapshot — upsert DB write error returns ok=false but snapshot still present
await test('refreshSnapshot: upsert error returns ok=false but snapshot in-memory', async function() {
  const supabase = makeMock({
    sectorsResult: { data: [], error: null },
    dtResult: { data: [], error: null },
    upsertResult: { data: null, error: { message: 'write failed' } }
  });
  const result = await refreshSnapshot(supabase);
  assert.strictEqual(result.ok, false);
  assert.ok(result.snapshot !== null); // in-memory snapshot still available
});

// de-duplicate by ticker in DT picks
await test('refreshSnapshot: de-duplicates DT tickers (only latest per ticker)', async function() {
  const supabase = makeMock({
    sectorsResult: { data: [], error: null },
    dtResult: {
      data: [
        { ticker: 'BBCA', raw_payload: '{}', created_at: new Date().toISOString() },
        { ticker: 'BBCA', raw_payload: '{}', created_at: new Date(Date.now() - 1000).toISOString() }, // duplicate
        { ticker: 'TLKM', raw_payload: '{}', created_at: new Date().toISOString() }
      ],
      error: null
    },
    upsertResult: { data: null, error: null }
  });
  const result = await refreshSnapshot(supabase);
  assert.strictEqual(result.snapshot.dt_signals.length, 2); // BBCA dedup + TLKM
});

// KV_KEY constant is the expected value
await test('KV_KEY constant is correct', function() {
  assert.strictEqual(KV_KEY, 'landing_showcase_snapshot');
});

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

} // end main()

main().catch(function(e) { console.error(e); process.exit(1); });
