'use strict';

/**
 * Focused tests for the duplicate-active-recommendation fix and the enhanced
 * dry-run diagnostics of the shared Telegram follow-up monitor
 * (`telegram-monitor-picks`).
 *
 * The monitor now evaluates and notifies only the LATEST non-terminal
 * recommendation per (monitor_source + ticker), using recommendation date
 * descending and row ID descending as the deterministic tie-breaker. Older
 * duplicate rows are ignored in memory only — never updated, notified, or
 * marked terminal.
 *
 * These are behavioral tests: they invoke the real handleTelegramMonitorPicks()
 * with a mocked Supabase client and spies over the Telegram notifier and AI
 * narration modules. No production endpoint, network, Telegram, or database is
 * touched. @supabase/supabase-js is stubbed via a one-time Module._load override.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@supabase/supabase-js') {
    return { createClient: function () { return {}; } };
  }
  return origLoad.apply(this, arguments);
};

process.env.CRON_SECRET = process.env.CRON_SECRET || 'test-secret-monitor';

const sectorHot = require('../api/sector-hot.js');
const telegramNotifier = require('../lib/telegram-notifier');
const aiNarration = require('../lib/ai-narration');

Module._load = origLoad;

const {
  handleTelegramMonitorPicks,
  dedupeActiveMonitorRows,
  compareMonitorRowRecency
} = sectorHot.__test;

// ------------------------------------------------------------------
// Spies over side-effecting modules (same cached module objects used by
// sector-hot.js), so replacing the properties intercepts calls.
// ------------------------------------------------------------------
let sendCalls = [];
let narrateCalls = [];
telegramNotifier.sendTelegramMessage = async function (msg, options) {
  sendCalls.push({ msg: msg, options: options || null });
  return { sent: true, skipped: false };
};
aiNarration.narrateMonitorUpdate = async function () {
  narrateCalls.push(1);
  return { note: null, source: 'test-ai' };
};

// ------------------------------------------------------------------
// Mock Supabase client. Price lookups are keyed by ticker so multiple rows
// for the same ticker all resolve to the same current price (as in production).
// ------------------------------------------------------------------
function makeSupabase(opts) {
  opts = opts || {};
  const rows = opts.rows || [];
  const daytradePrices = opts.daytradePrices || {};
  const foreignPrices = opts.foreignPrices || {};
  const updateCalls = [];

  function from(table) {
    const ctx = { table: table, op: 'select', eqCol: null, eqVal: null, updateObj: null };
    const builder = {
      select: function () { return builder; },
      in: function () { return builder; },
      order: function () { return builder; },
      eq: function (col, val) { ctx.eqCol = col; ctx.eqVal = val; return builder; },
      update: function (obj) { ctx.op = 'update'; ctx.updateObj = obj; return builder; },
      maybeSingle: function () {
        return Promise.resolve({ data: daytradePrices[ctx.eqVal] || null, error: null });
      },
      limit: function () {
        const row = foreignPrices[ctx.eqVal];
        return Promise.resolve({ data: row ? [row] : [], error: null });
      },
      then: function (resolve, reject) {
        try {
          if (ctx.op === 'update') {
            updateCalls.push({ table: table, updateObj: ctx.updateObj, eqCol: ctx.eqCol, eqVal: ctx.eqVal });
            resolve({ data: null, error: null });
          } else {
            resolve({ data: rows.slice(), error: null });
          }
        } catch (e) { reject(e); }
      }
    };
    return builder;
  }
  return { from: from, updateCalls: updateCalls };
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status: function (c) { this.statusCode = c; return this; },
    json: function (o) { this.body = o; return this; }
  };
}

const NOW_ISO = new Date().toISOString();

function baseRow(over) {
  return Object.assign({
    id: 1, ticker: 'AAAA', date: '2026-07-16', status: 'WAITING', is_final: false,
    entry1: 100, entry2: 98, tp1: 110, tp2: 120, sl: 95,
    first_sent_at: NOW_ISO, hit_entry_at: null,
    hit_tp1_at: null, hit_tp2_at: null, hit_sl_at: null,
    category: null, raw_payload: { monitor_source: 'swing_konglo' }
  }, over || {});
}

async function runMonitor(extraQuery, scenario) {
  sendCalls = [];
  narrateCalls = [];
  const supabase = makeSupabase(scenario);
  const req = {
    method: 'GET',
    headers: {},
    query: Object.assign({ secret: process.env.CRON_SECRET, force: '1' }, extraQuery || {})
  };
  const res = makeRes();
  await handleTelegramMonitorPicks(req, res, supabase);
  return { res: res, updateCalls: supabase.updateCalls, sendCalls: sendCalls, narrateCalls: narrateCalls };
}

// ==================================================================
// Pure-function tests for the comparator and grouping
// ==================================================================
test('compareMonitorRowRecency: later date wins, then higher id', function () {
  // later date first
  assert.ok(compareMonitorRowRecency({ date: '2026-07-17', id: 1 }, { date: '2026-07-16', id: 999 }) < 0);
  // same date -> higher id first
  assert.ok(compareMonitorRowRecency({ date: '2026-07-17', id: 5 }, { date: '2026-07-17', id: 4 }) < 0);
  assert.equal(compareMonitorRowRecency({ date: '2026-07-17', id: 5 }, { date: '2026-07-17', id: 5 }), 0);
});

test('dedupeActiveMonitorRows keeps latest date per source+ticker', function () {
  const rows = [
    baseRow({ id: 10, ticker: 'COCO', date: '2026-07-14', raw_payload: { monitor_source: 'swing_nk' } }),
    baseRow({ id: 11, ticker: 'COCO', date: '2026-07-16', raw_payload: { monitor_source: 'swing_nk' } }),
    baseRow({ id: 12, ticker: 'COCO', date: '2026-07-15', raw_payload: { monitor_source: 'swing_nk' } })
  ];
  const out = dedupeActiveMonitorRows(rows);
  assert.equal(out.kept.length, 1);
  assert.equal(out.kept[0].id, 11, 'row from latest date (2026-07-16) must win');
  assert.equal(out.ignored.length, 2);
});

// ==================================================================
// TEST 1: Same source+ticker, different dates -> latest date wins
// ==================================================================
test('same source+ticker across dates: only the latest recommendation is evaluated', async function () {
  const scenario = {
    rows: [
      baseRow({ id: 1, ticker: 'COCO', date: '2026-07-14', raw_payload: { monitor_source: 'swing_nk' } }),
      baseRow({ id: 2, ticker: 'COCO', date: '2026-07-16', raw_payload: { monitor_source: 'swing_nk' } })
    ],
    daytradePrices: { COCO: { last_price: 99, open_price: 99, high_price: 99, low_price: 99 } }
  };
  const dry = await runMonitor({ dry_run: '1' }, scenario);
  assert.equal(dry.res.body.deduped_row_count, 1);
  assert.equal(dry.res.body.events.length, 1);
  assert.equal(dry.res.body.events[0].row_id, 2);
  assert.equal(dry.res.body.events[0].recommendation_date, '2026-07-16');
});

// ==================================================================
// TEST 2: Same date, different IDs -> highest ID wins
// ==================================================================
test('same date, different ids: highest id wins', async function () {
  const scenario = {
    rows: [
      baseRow({ id: 41, ticker: 'BREN', date: '2026-07-16', raw_payload: { monitor_source: 'swing_konglo' } }),
      baseRow({ id: 43, ticker: 'BREN', date: '2026-07-16', raw_payload: { monitor_source: 'swing_konglo' } }),
      baseRow({ id: 42, ticker: 'BREN', date: '2026-07-16', raw_payload: { monitor_source: 'swing_konglo' } })
    ],
    daytradePrices: { BREN: { last_price: 99, open_price: 99, high_price: 99, low_price: 99 } }
  };
  const dry = await runMonitor({ dry_run: '1' }, scenario);
  assert.equal(dry.res.body.deduped_row_count, 1);
  assert.equal(dry.res.body.events[0].row_id, 43, 'highest id (43) must win on identical dates');
});

// ==================================================================
// TEST 3: Same ticker, different sources -> both remain
// ==================================================================
test('same ticker under different monitor sources stays separate', async function () {
  const scenario = {
    rows: [
      baseRow({ id: 1, ticker: 'ESSA', date: '2026-07-16', raw_payload: { monitor_source: 'swing_konglo' } }),
      baseRow({ id: 2, ticker: 'ESSA', date: '2026-07-16', raw_payload: { monitor_source: 'swing_nk' } })
    ],
    daytradePrices: { ESSA: { last_price: 99, open_price: 99, high_price: 99, low_price: 99 } }
  };
  const dry = await runMonitor({ dry_run: '1' }, scenario);
  assert.equal(dry.res.body.deduped_row_count, 2, 'different sources must not be merged');
  const sources = dry.res.body.events.map(function (e) { return e.source; }).sort();
  assert.deepEqual(sources, ['swing_konglo', 'swing_nk']);
  assert.equal(dry.res.body.duplicate_groups.length, 0);
});

// ==================================================================
// TEST 4: No duplicates -> existing behavior unchanged
// ==================================================================
test('no duplicates: raw and deduped counts match and no ignored rows', async function () {
  const scenario = {
    rows: [
      baseRow({ id: 1, ticker: 'AAAA', date: '2026-07-16', raw_payload: { monitor_source: 'swing_konglo' } }),
      baseRow({ id: 2, ticker: 'BBBB', date: '2026-07-16', raw_payload: { monitor_source: 'swing_nk' } })
    ],
    daytradePrices: {
      AAAA: { last_price: 99, open_price: 99, high_price: 99, low_price: 99 },
      BBBB: { last_price: 99, open_price: 99, high_price: 99, low_price: 99 }
    }
  };
  const dry = await runMonitor({ dry_run: '1' }, scenario);
  assert.equal(dry.res.body.raw_row_count, 2);
  assert.equal(dry.res.body.deduped_row_count, 2);
  assert.equal(dry.res.body.duplicate_groups.length, 0);
  assert.equal(dry.res.body.ignored_duplicate_rows.length, 0);
});

// ==================================================================
// TEST 5: Normal mode with duplicates -> one update/notification per group
// ==================================================================
test('normal mode with duplicates updates and notifies only the kept row', async function () {
  // Two COCO rows (swing_nk) that would BOTH evaluate to IN_ENTRY_ZONE (significant).
  // Only the latest (id 2, 2026-07-16) should be updated + individually notified.
  const scenario = {
    rows: [
      baseRow({ id: 1, ticker: 'COCO', date: '2026-07-14', entry1: 100, entry2: 98, sl: 95, raw_payload: { monitor_source: 'swing_nk' } }),
      baseRow({ id: 2, ticker: 'COCO', date: '2026-07-16', entry1: 100, entry2: 98, sl: 95, raw_payload: { monitor_source: 'swing_nk' } })
    ],
    // last=99 within [98,100] -> IN_ENTRY_ZONE; no wick (high=low=99) so entry not "touched"
    daytradePrices: { COCO: { last_price: 99, open_price: 99, high_price: 99, low_price: 99 } }
  };
  const normal = await runMonitor({}, scenario);
  assert.equal(normal.updateCalls.length, 1, 'exactly one row updated');
  assert.equal(normal.updateCalls[0].eqVal, 2, 'the kept (latest) row is the one updated');
  // 1 individual significant message + 1 batch message = 2 sends (not 3)
  assert.equal(normal.sendCalls.length, 2, 'only one individual notification for the duplicated ticker');
  assert.equal(normal.res.body.checked_count, 1);
});

// ==================================================================
// TEST 6: Dry-run reports raw and deduped counts accurately
// ==================================================================
test('dry-run reports accurate raw_row_count and deduped_row_count', async function () {
  const scenario = {
    rows: [
      baseRow({ id: 1, ticker: 'COCO', date: '2026-07-14', raw_payload: { monitor_source: 'swing_nk' } }),
      baseRow({ id: 2, ticker: 'COCO', date: '2026-07-16', raw_payload: { monitor_source: 'swing_nk' } }),
      baseRow({ id: 3, ticker: 'PADI', date: '2026-07-15', raw_payload: { monitor_source: 'swing_konglo' } }),
      baseRow({ id: 4, ticker: 'PADI', date: '2026-07-16', raw_payload: { monitor_source: 'swing_konglo' } }),
      baseRow({ id: 5, ticker: 'IRSX', date: '2026-07-16', raw_payload: { monitor_source: 'swing_nk' } })
    ],
    daytradePrices: {
      COCO: { last_price: 99, open_price: 99, high_price: 99, low_price: 99 },
      PADI: { last_price: 99, open_price: 99, high_price: 99, low_price: 99 },
      IRSX: { last_price: 99, open_price: 99, high_price: 99, low_price: 99 }
    }
  };
  const dry = await runMonitor({ dry_run: '1' }, scenario);
  assert.equal(dry.res.body.raw_row_count, 5);
  assert.equal(dry.res.body.deduped_row_count, 3);
  assert.equal(dry.res.body.checked_count, 3);
  assert.equal(dry.res.body.duplicate_groups.length, 2, 'COCO and PADI form duplicate groups');
});

// ==================================================================
// TEST 7: Ignored rows appear in ignored_duplicate_rows
// ==================================================================
test('ignored older duplicates are reported in ignored_duplicate_rows', async function () {
  const scenario = {
    rows: [
      baseRow({ id: 1, ticker: 'IRSX', date: '2026-07-14', status: 'WAITING', raw_payload: { monitor_source: 'swing_nk' } }),
      baseRow({ id: 2, ticker: 'IRSX', date: '2026-07-16', status: 'WAITING', raw_payload: { monitor_source: 'swing_nk' } })
    ],
    daytradePrices: { IRSX: { last_price: 99, open_price: 99, high_price: 99, low_price: 99 } }
  };
  const dry = await runMonitor({ dry_run: '1' }, scenario);
  assert.equal(dry.res.body.ignored_duplicate_rows.length, 1);
  const ig = dry.res.body.ignored_duplicate_rows[0];
  assert.equal(ig.ticker, 'IRSX');
  assert.equal(ig.source, 'swing_nk');
  assert.equal(ig.row_id, 1, 'older row (id 1) is the ignored one');
  assert.equal(ig.recommendation_date, '2026-07-14');
  assert.ok(ig.reason && ig.reason.length > 0);
  // The kept row must be the latest one.
  const grp = dry.res.body.duplicate_groups[0];
  assert.equal(grp.kept.row_id, 2);
});

// ==================================================================
// TEST 8: PADI-style case -> intraday low <= SL, last > entry
// ==================================================================
test('PADI-style: low<=SL and last>entry -> SL_HIT with positive pct_change and full price fields', async function () {
  const scenario = {
    rows: [
      baseRow({
        id: 7, ticker: 'PADI', date: '2026-07-16', status: 'RUNNING',
        entry1: 100, entry2: 98, tp1: 110, tp2: 120, sl: 95,
        hit_entry_at: NOW_ISO, // active
        raw_payload: { monitor_source: 'swing_konglo' }
      })
    ],
    // intraday low wicked to 94 (<= sl 95) but recovered; last 103 (> entry1 100)
    daytradePrices: { PADI: { last_price: 103, open_price: 100, high_price: 104, low_price: 94 } }
  };
  const dry = await runMonitor({ dry_run: '1' }, scenario);
  const evt = dry.res.body.events.find(function (e) { return e.ticker === 'PADI'; });
  assert.equal(evt.simulated_status, 'SL_HIT', 'SL_HIT keys off intraday low vs SL');
  assert.ok(evt.pct_change > 0, 'pct_change is positive because it keys off last vs entry1');
  // preview exposes low, last, SL, and reference price
  assert.equal(evt.price_low, 94);
  assert.equal(evt.price_high, 104);
  assert.equal(evt.current_price, 103);
  assert.equal(evt.sl, 95);
  assert.equal(evt.reference_price, 100);
  assert.deepEqual(evt.entry_range, { entry1: 100, entry2: 98 });
});

// ==================================================================
// TEST 9: Repeated dry-runs remain non-mutating and idempotent
// ==================================================================
test('repeated dry-runs are non-mutating and produce identical dedup output', async function () {
  const build = function () {
    return {
      rows: [
        baseRow({ id: 1, ticker: 'COCO', date: '2026-07-14', raw_payload: { monitor_source: 'swing_nk' } }),
        baseRow({ id: 2, ticker: 'COCO', date: '2026-07-16', raw_payload: { monitor_source: 'swing_nk' } })
      ],
      daytradePrices: { COCO: { last_price: 99, open_price: 99, high_price: 99, low_price: 99 } }
    };
  };
  const first = await runMonitor({ dry_run: '1' }, build());
  const second = await runMonitor({ dryRun: '1' }, build());

  assert.equal(first.updateCalls.length, 0);
  assert.equal(second.updateCalls.length, 0);
  assert.equal(first.sendCalls.length, 0);
  assert.equal(second.sendCalls.length, 0);
  assert.equal(first.narrateCalls.length, 0);
  assert.equal(second.narrateCalls.length, 0);

  assert.deepEqual(
    second.res.body.events.map(function (e) { return e.row_id + ':' + e.simulated_status; }),
    first.res.body.events.map(function (e) { return e.row_id + ':' + e.simulated_status; })
  );
  assert.equal(first.res.body.deduped_row_count, second.res.body.deduped_row_count);
});

// ==================================================================
// TEST 10: API endpoint JS count remains exactly 12
// ==================================================================
test('api/ directory still contains exactly 12 endpoint JS files', function () {
  const apiDir = path.resolve(__dirname, '..', 'api');
  const jsFiles = fs.readdirSync(apiDir).filter(function (f) { return f.endsWith('.js'); });
  assert.equal(jsFiles.length, 12, 'API endpoint JS count must remain exactly 12; found: ' + jsFiles.join(', '));
});
