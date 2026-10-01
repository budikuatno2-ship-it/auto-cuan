'use strict';

/**
 * FASE 1 FORENSIC AUDIT — reproduction suite (23 Sep 2026)
 *
 * Target files:
 *   - lib/latest-price-resolver.js   → BUG-FASE1-001, BUG-FASE1-002, BUG-FASE1-004
 *   - lib/idx-tick-normalization.js  → BUG-FASE1-003
 *
 * Every bug test below was written FIRST and executed against the pre-fix
 * implementation. The captured FAIL output is recorded in
 * BUG_FINDINGS_FASE_1_23SEPT.md (section "Bukti Uji"); the same tests pass
 * after the minimal fixes applied to the two target files.
 *
 * No network, no credentials: the Supabase REST and SDK surfaces are replaced
 * by local fakes that emulate PostgREST column validation (a query ordered by a
 * column that does not exist answers HTTP 400 — exactly like production).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const resolver = require('../lib/latest-price-resolver');
const idx = require('../lib/idx-tick-normalization');

// ---------------------------------------------------------------------------
// Fake PostgREST surface (REST path)
// ---------------------------------------------------------------------------

/**
 * Per-table schema mirroring supabase/*.sql. Note the deliberate absences:
 *   - NO table has `updated_at`;
 *   - swing_screener_non_konglo_latest has no `calculated_at` (it has published_at);
 *   - foreign_watchlist_daily has no `calculated_at` (it has trade_date/uploaded_at).
 * `rows` is in physical/insertion order — a PostgREST query WITHOUT an order
 * clause returns rows in this unspecified order (oldest first), the failure
 * mode api/quote.js documents as BUG-QUOTE-02.
 */
const REST_SCHEMAS = {
  daytrade_screener_latest: {
    columns: ['ticker', 'last_price', 'price_date', 'calculated_at'],
    rows: []
  },
  swing_screener_latest: {
    columns: ['ticker', 'last_price', 'price_date', 'calculated_at'],
    rows: []
  },
  swing_screener_non_konglo_latest: {
    columns: ['ticker', 'last_price', 'price_date', 'published_at', 'run_date'],
    rows: []
  },
  foreign_watchlist_daily: {
    columns: ['ticker', 'close', 'trade_date', 'uploaded_at'],
    rows: [
      { ticker: 'AUDITX', close: 900, trade_date: '2026-09-21', uploaded_at: '2026-09-21T10:00:00Z' },
      { ticker: 'AUDITX', close: 5000, trade_date: '2026-09-22', uploaded_at: '2026-09-22T10:00:00Z' }
    ]
  }
};

function fakePostgrestFetch() {
  return async function fetchStub(url) {
    const u = new URL(url);
    const table = u.pathname.replace('/rest/v1/', '');
    const schema = REST_SCHEMAS[table];
    if (!schema) return { ok: false, status: 404, json: async () => ({ message: 'no such table' }) };
    const order = u.searchParams.get('order');
    const rows = schema.rows.slice();
    if (order) {
      const specs = order.split(',').map(function (part) {
        const bits = part.trim().split('.');
        return { column: bits[0], desc: String(bits[1] || '').toLowerCase() === 'desc' };
      });
      for (const spec of specs) {
        if (schema.columns.indexOf(spec.column) === -1) {
          return {
            ok: false,
            status: 400,
            json: async () => ({ message: 'column ' + table + '.' + spec.column + ' does not exist' })
          };
        }
      }
      const primary = specs[0];
      rows.sort(function (a, b) {
        const av = String(a[primary.column] || '');
        const bv = String(b[primary.column] || '');
        return primary.desc ? bv.localeCompare(av) : av.localeCompare(bv);
      });
    }
    const limit = Number(u.searchParams.get('limit') || rows.length);
    return { ok: true, status: 200, json: async () => rows.slice(0, limit) };
  };
}

// ---------------------------------------------------------------------------
// Fake Supabase SDK client (SDK path)
// ---------------------------------------------------------------------------

function fakeSupabaseClient(schemas) {
  return {
    from: function (table) {
      const schema = schemas[table];
      const q = {
        _order: null,
        select: function () { return q; },
        eq: function () { return q; },
        order: function (column) { q._order = column; return q; },
        limit: function () { return q; },
        then: function (resolve) {
          if (!schema) return resolve({ data: null, error: { message: 'no such table' } });
          if (schema.columns.indexOf(q._order) === -1) {
            return resolve({ data: null, error: { message: 'column ' + table + '.' + q._order + ' does not exist' } });
          }
          return resolve({ data: schema.rows.slice(0, 1), error: null });
        }
      };
      return q;
    }
  };
}

// ===========================================================================
// BUG-FASE1-001 — ordering by columns that do not exist silently degrades
// "latest" selection (arbitrary row) and drops sources entirely (SDK path)
// ===========================================================================

test('BUG-FASE1-001a: REST path must order foreign_watchlist_daily by trade_date so the NEWEST row wins', async () => {
  const originalFetch = global.fetch;
  global.fetch = fakePostgrestFetch();
  try {
    const res = await resolver.fetchFreshScreenerLatestPrice('AUDITX', {
      supabaseUrl: 'https://fake-supabase.local',
      supabaseKey: 'service-role-key',
      now: '2026-09-23T02:00:00Z'
    });
    // Both rows are inside the 72h freshness window. The newest row (5000,
    // 2026-09-22) must win — not the arbitrary first row (900, 2026-09-21).
    assert.equal(res.price, 5000, 'newest trade_date row must win, got ' + res.price);
    assert.equal(res.price_date, '2026-09-22');
  } finally {
    global.fetch = originalFetch;
  }
});

test('BUG-FASE1-001b: SDK path must read swing_screener_non_konglo_latest (no calculated_at column)', async () => {
  const sdk = fakeSupabaseClient({
    daytrade_screener_latest: { columns: ['ticker', 'last_price', 'calculated_at'], rows: [] },
    swing_screener_latest: { columns: ['ticker', 'last_price', 'calculated_at'], rows: [] },
    swing_screener_non_konglo_latest: {
      columns: ['ticker', 'last_price', 'price_date', 'published_at', 'run_date'],
      rows: [{ ticker: 'AUDITSDK', last_price: 1500, price_date: '2026-09-22', published_at: '2026-09-22T10:00:00Z' }]
    },
    foreign_watchlist_daily: { columns: ['ticker', 'close', 'trade_date'], rows: [] }
  });
  const res = await resolver.fetchFreshScreenerLatestPrice('AUDITSDK', {
    supabase: sdk,
    now: '2026-09-23T02:00:00Z'
  });
  assert.equal(res.price, 1500, 'the non-konglo source must not be silently dropped by an invalid order column');
  assert.equal(res.price_source, 'swing_screener_non_konglo_latest');
});

test('BUG-FASE1-001c: every SOURCES entry must declare order columns that exist on its real table', () => {
  const expected = {
    daytrade_screener_latest: 'calculated_at',
    swing_screener_latest: 'calculated_at',
    swing_screener_non_konglo_latest: 'published_at',
    foreign_watchlist_daily: 'trade_date'
  };
  for (const source of resolver.SOURCES) {
    assert.equal(source.orderColumn, expected[source.table], 'orderColumn for ' + source.table);
    assert.equal(source.order, expected[source.table] + '.desc', 'REST order clause for ' + source.table);
  }
});

// ===========================================================================
// BUG-FASE1-002 — REJECTED HYPOTHESIS (kept as lock coverage)
//
// The initial reproduction expected the freshest intra-day TIMESTAMP to win
// across sources on the same WIB day (e.g. swing 18:00 WIB beating daytrade
// 09:00 WIB). Cross-check against the committed contract disproved the claim:
//   - test/latest-price-resolver.test.js locks "prefers fresh daytrade latest
//     over ... lower-priority sources" for same-day rows;
//   - commit 030ce7e0 deliberately reverted timestamp comparison to the
//     WIB-calendar-day comparison (dKey) to honour that contract.
// Selection is therefore source-priority-first WITHIN a calendar day and
// date-first ACROSS days. These tests lock that exact contract so the
// behaviour cannot drift silently. Full reasoning: BUG_FINDINGS_FASE_1_23SEPT.md
// ("BUG-FASE1-002 — Hipotesis DITOLAK").
// ===========================================================================

test('BUG-FASE1-002a (lock): same-day rows keep SOURCES priority (daytrade beats a later swing run)', () => {
  const res = resolver.resolveLatestPrice({
    daytrade_screener_latest: { last_price: 1000, calculated_at: '2026-08-11T02:00:00Z' }, // 09:00 WIB
    swing_screener_latest: { last_price: 1500, calculated_at: '2026-08-11T11:00:00Z' }      // 18:00 WIB
  }, { now: '2026-08-11T12:00:00Z' });
  assert.equal(res.price, 1000, 'documented contract: daytrade_screener_latest is the authoritative same-day source');
  assert.equal(res.price_source, 'daytrade_screener_latest');
});

test('BUG-FASE1-002b (lock): a later calendar day still outranks an earlier SOURCES entry', () => {
  const res = resolver.resolveLatestPrice({
    daytrade_screener_latest: { last_price: 1000, calculated_at: '2026-08-10T10:00:00Z' },
    swing_screener_latest: { last_price: 1500, price_date: '2026-08-11' }
  }, { now: '2026-08-11T12:00:00Z' });
  assert.equal(res.price, 1500, 'cross-day freshness wins: the 2026-08-11 row must beat the 2026-08-10 row');
  assert.equal(res.price_source, 'swing_screener_latest');
  assert.equal(res.price_date, '2026-08-11');
});

test('BUG-FASE1-002c (lock): identical timestamps keep the documented SOURCES priority', () => {
  const res = resolver.resolveLatestPrice({
    daytrade_screener_latest: { last_price: 123, calculated_at: '2026-08-11T10:00:00Z' },
    swing_screener_latest: { last_price: 1500, calculated_at: '2026-08-11T10:00:00Z' }
  }, { now: '2026-08-11T12:00:00Z' });
  assert.equal(res.price, 123);
  assert.equal(res.price_source, 'daytrade_screener_latest');
});

// ===========================================================================
// BUG-FASE1-003 — sub-Rp1 fractional prices floor/round to 0, a non-positive
// value that is not a valid IDX level and leaks into normalized plan levels
// ===========================================================================

test('BUG-FASE1-003a: roundToIdxTick must never emit a non-positive level for a positive price', () => {
  assert.equal(idx.roundToIdxTick(0.9, 'floor'), null, 'floor of a sub-Rp1 price must be null, not 0');
  assert.equal(idx.roundToIdxTick(0.9, 'down'), null, '"down" alias of floor must be null too');
  assert.equal(idx.roundToIdxTick(0.4, 'nearest'), null, 'nearest of a sub-Rp1 price must be null, not 0');
  assert.equal(idx.roundToIdxTick(0.5, 'ceil'), 1, 'ceil of a sub-Rp1 price stays the minimum Rp1 tick');
  assert.equal(idx.isValidIdxPriceLevel(0), false);
});

test('BUG-FASE1-003b: a sub-Rp1 stop loss must not leak 0 into normalized plan levels', () => {
  const levels = idx.normalizeLevelsToIdxTicks({
    entry_low: 1.5,
    entry_high: 2.5,
    stop_loss: 0.9,
    tp1: 3.5,
    tp2: 4.5
  });
  assert.notEqual(levels.stop_loss, 0, 'stop_loss 0 is not a tradable IDX level');
});

// ===========================================================================
// BUG-FASE1-004 — resolveLatestPriceBulk violates its own documented contract
// ===========================================================================

test('BUG-FASE1-004a: bulk resolver must key results by the clean ticker, matching the single-ticker path', () => {
  const bulk = resolver.resolveLatestPriceBulk({
    'BBCA.JK': { daytrade_screener_latest: { last_price: 5000, calculated_at: '2026-08-11T11:00:00Z' } }
  }, { now: '2026-08-11T12:00:00Z' });
  assert.ok(bulk.BBCA, 'BBCA.JK must resolve under the clean key BBCA (keys: ' + Object.keys(bulk).join(',') + ')');
  assert.equal(bulk.BBCA.price, 5000);
});

test('BUG-FASE1-004b: documented pre-resolved price map input must be honored, not silently dropped', () => {
  const bulk = resolver.resolveLatestPriceBulk({
    BBCA: { price: 5000, price_source: 'manual_portfolio', price_date: '2026-08-11' }
  }, { now: '2026-08-11T12:00:00Z' });
  assert.ok(bulk.BBCA, 'pre-resolved {price, price_source, price_date} entries must pass through');
  assert.equal(bulk.BBCA.price, 5000);
  assert.equal(bulk.BBCA.price_source, 'manual_portfolio');
  assert.equal(bulk.BBCA.price_date, '2026-08-11');
});

// ===========================================================================
// LOCKS — behaviours that must survive the fixes above
// ===========================================================================

test('LOCK: IDX tick fraction boundaries (Rp1/2/5/10/25) stay exact', () => {
  const cases = [
    [199, 1], [200, 2], [201, 2], [498, 2], [500, 5], [502, 5],
    [1995, 5], [2000, 10], [2005, 10], [4990, 10], [5000, 25], [5025, 25]
  ];
  for (const [price, tick] of cases) assert.equal(idx.getIdxTickSize(price), tick, String(price));
});

test('LOCK: SL floors to the tick grid while TP/resistance ceil — never the opposite direction', () => {
  const plan = idx.normalizeTradingPlanLevels({
    ticker: 'AUDITX',
    entry_low: 503,
    entry_high: 508,
    stop_loss: 502,
    tp1: 1998,
    tp2: 2005,
    risk_reward: 1.5
  });
  assert.equal(plan.stop_loss, 500, 'SL must floor (502 -> 500)');
  assert.equal(plan.tp1, 2000, 'TP1 must ceil (1998 -> 2000)');
  assert.equal(plan.tp2, 2010, 'TP2 must ceil (2005 -> 2010)');
  assert.equal(plan.tick_normalized, true);
  assert.equal(plan.trading_plan_valid, true);
});

test('LOCK: the 72h freshness window still rejects stale rows', () => {
  const res = resolver.resolveLatestPrice({
    daytrade_screener_latest: { last_price: 999, calculated_at: '2026-08-01T09:00:00Z' }
  }, { now: '2026-08-11T12:00:00Z' });
  assert.equal(res.price, null);
  assert.equal(res.stale, true);
});

test('LOCK: a newer calendar day still outranks an earlier SOURCES entry', () => {
  const res = resolver.resolveLatestPrice({
    daytrade_screener_latest: { last_price: 1000, calculated_at: '2026-08-10T10:00:00Z' },
    swing_screener_latest: { last_price: 1500, calculated_at: '2026-08-11T11:00:00Z' }
  }, { now: '2026-08-11T12:00:00Z' });
  assert.equal(res.price, 1500);
  assert.equal(res.price_source, 'swing_screener_latest');
});
