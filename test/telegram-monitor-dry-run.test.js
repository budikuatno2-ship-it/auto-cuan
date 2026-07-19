'use strict';

/**
 * Focused tests for the non-mutating dry-run mode of the shared Telegram
 * follow-up monitor (`telegram-monitor-picks`) used by Day Trade, Swing Konglo,
 * and Swing Non-Konglo recommendations.
 *
 * These are behavioral tests: they invoke the real handleTelegramMonitorPicks()
 * with a fully mocked Supabase client and spies over the Telegram notifier and
 * AI narration modules. No production endpoint, network, Telegram, or database
 * is ever touched.
 *
 * @supabase/supabase-js is not installed in this workspace, so we override
 * Module._load to stub only that dependency before requiring sector-hot.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// --- Stub @supabase/supabase-js (never used: we inject our own mock client) ---
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@supabase/supabase-js') {
    return { createClient: function () { return {}; } };
  }
  return origLoad.apply(this, arguments);
};

process.env.CRON_SECRET = process.env.CRON_SECRET || 'test-secret-monitor';

const sectorHot = require('../api/sector-hot.js');
const telegramNotifier = require('../lib/telegram-notifier');
const aiNarration = require('../lib/ai-narration');

// Restore the loader immediately after the one-time require above.
Module._load = origLoad;

const {
  handleTelegramMonitorPicks,
  isMonitorDryRunRequest
} = sectorHot.__test;

// ------------------------------------------------------------------
// Spies over side-effecting modules. sector-hot.js holds a reference to
// these exact module objects, so replacing the properties intercepts calls.
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
// Mock Supabase client covering exactly the access patterns used by
// handleTelegramMonitorPicks() and fetchLatestPriceForMonitor().
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
        // daytrade_screener_latest single-row price lookup
        const data = daytradePrices[ctx.eqVal] || null;
        return Promise.resolve({ data: data, error: null });
      },
      limit: function () {
        // foreign_watchlist_daily fallback price lookup
        const row = foreignPrices[ctx.eqVal];
        return Promise.resolve({ data: row ? [row] : [], error: null });
      },
      // Thenable terminal for the list-select and update chains on telegram_daily_picks
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

// Three active rows, one per monitored source, engineered to produce
// deterministic statuses independent of the current clock:
//   BBCA (daytrade_signal)  -> TP1_HIT       (significant -> individual msg)
//   TLKM (swing_konglo)     -> IN_ENTRY_ZONE (significant -> individual msg)
//   ANTM (swing_nk)         -> WATCHLIST     (non-significant -> batch only)
function buildScenario() {
  return {
    rows: [
      {
        id: 1, ticker: 'BBCA', date: '2026-07-17', status: 'RUNNING', is_final: false,
        entry1: 100, entry2: 98, tp1: 110, tp2: 120, sl: 90,
        first_sent_at: NOW_ISO, hit_entry_at: NOW_ISO,
        hit_tp1_at: null, hit_tp2_at: null, hit_sl_at: null,
        category: 'Day Trade', raw_payload: { monitor_source: 'daytrade_signal' }
      },
      {
        id: 2, ticker: 'TLKM', date: '2026-07-17', status: 'WAITING', is_final: false,
        entry1: 100, entry2: 98, tp1: 110, tp2: 120, sl: 95,
        first_sent_at: NOW_ISO, hit_entry_at: null,
        hit_tp1_at: null, hit_tp2_at: null, hit_sl_at: null,
        category: 'Swing Konglo', raw_payload: { monitor_source: 'swing_konglo' }
      },
      {
        id: 3, ticker: 'ANTM', date: '2026-07-17', status: 'WAITING', is_final: false,
        entry1: 100, entry2: 98, tp1: 110, tp2: 120, sl: 95,
        first_sent_at: NOW_ISO, hit_entry_at: null,
        hit_tp1_at: null, hit_tp2_at: null, hit_sl_at: null,
        category: 'Swing Non-Konglo', raw_payload: { monitor_source: 'swing_nk' }
      }
    ],
    daytradePrices: {
      BBCA: { last_price: 111, open_price: 110, high_price: 112, low_price: 108, calculated_at: NOW_ISO },
      TLKM: { last_price: 99, open_price: 99, high_price: 99, low_price: 99, calculated_at: NOW_ISO },
      ANTM: { last_price: 96, open_price: 96, high_price: 96, low_price: 96, calculated_at: NOW_ISO }
    },
    foreignPrices: {}
  };
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
// Sanity: flag parsing accepts dry_run=1 and dryRun=1
// ==================================================================
test('isMonitorDryRunRequest accepts dry_run=1 and dryRun=1 (and rejects absence)', function () {
  assert.equal(isMonitorDryRunRequest({ query: { dry_run: '1' } }), true);
  assert.equal(isMonitorDryRunRequest({ query: { dryRun: '1' } }), true);
  assert.equal(isMonitorDryRunRequest({ query: { dry_run: 'true' } }), true);
  assert.equal(isMonitorDryRunRequest({ query: {} }), false);
  assert.equal(isMonitorDryRunRequest({ query: { dry_run: '0' } }), false);
});

// ==================================================================
// TEST 1: Dry-run calculates the same simulated status as normal mode
// ==================================================================
test('dry-run produces identical simulated statuses to normal mode', async function () {
  const normal = await runMonitor({}, buildScenario());
  const dry = await runMonitor({ dry_run: '1' }, buildScenario());

  // Normal mode: one update call per processed row, carrying the computed status.
  const normalStatuses = normal.updateCalls.map(function (u) { return u.eqVal + ':' + u.updateObj.status; });
  const dryStatuses = dry.res.body.events.map(function (e) {
    const idByTicker = { BBCA: 1, TLKM: 2, ANTM: 3 };
    return idByTicker[e.ticker] + ':' + e.simulated_status;
  });
  assert.deepEqual(dryStatuses, normalStatuses,
    'simulated statuses in dry-run must match the statuses written in normal mode');

  // Confirm the engineered statuses are what we expect.
  const byTicker = {};
  dry.res.body.events.forEach(function (e) { byTicker[e.ticker] = e.simulated_status; });
  assert.equal(byTicker.BBCA, 'TP1_HIT');
  assert.equal(byTicker.TLKM, 'IN_ENTRY_ZONE');
  assert.equal(byTicker.ANTM, 'WATCHLIST');
});

// ==================================================================
// TEST 2: No Supabase update occurs in dry-run
// ==================================================================
test('dry-run performs zero Supabase updates (normal mode does update)', async function () {
  const dry = await runMonitor({ dry_run: '1' }, buildScenario());
  assert.equal(dry.updateCalls.length, 0, 'dry-run must not update any telegram_daily_picks row');

  const normal = await runMonitor({}, buildScenario());
  assert.ok(normal.updateCalls.length > 0, 'normal mode is expected to update rows (control)');
  assert.equal(normal.updateCalls.length, 3);
});

// ==================================================================
// TEST 3: No Telegram send occurs in dry-run
// ==================================================================
test('dry-run sends zero Telegram messages (normal mode sends)', async function () {
  const dry = await runMonitor({ dry_run: '1' }, buildScenario());
  assert.equal(dry.sendCalls.length, 0, 'dry-run must not send any Telegram message (individual or batch)');
  assert.equal(dry.res.body.telegram_suppressed, true);

  const normal = await runMonitor({}, buildScenario());
  // 2 significant individual messages + 1 batch message
  assert.equal(normal.sendCalls.length, 3, 'normal mode must send individual + batch messages (control)');
});

// ==================================================================
// TEST 4: No AI narration call occurs in dry-run
// ==================================================================
test('dry-run makes zero AI narration calls (normal mode narrates significant hits)', async function () {
  const dry = await runMonitor({ dry_run: '1' }, buildScenario());
  assert.equal(dry.narrateCalls.length, 0, 'dry-run must not call AI narration');
  assert.equal(dry.res.body.ai_suppressed, true);

  const normal = await runMonitor({}, buildScenario());
  assert.equal(normal.narrateCalls.length, 2, 'normal mode narrates the 2 significant statuses (control)');
});

// ==================================================================
// TEST 5: Existing hit timestamps remain unchanged
// ==================================================================
test('dry-run leaves existing hit timestamps untouched', async function () {
  const scenario = buildScenario();
  const preservedEntry = scenario.rows[0].hit_entry_at;
  const dry = await runMonitor({ dry_run: '1' }, scenario);

  // No write occurred at all...
  assert.equal(dry.updateCalls.length, 0);
  // ...and the in-memory row objects were not mutated.
  assert.equal(scenario.rows[0].hit_entry_at, preservedEntry);
  assert.equal(scenario.rows[0].hit_tp1_at, null, 'TP1 timestamp must not be set in dry-run despite TP1_HIT');
  assert.equal(scenario.rows[1].hit_entry_at, null, 'entry timestamp must not be set in dry-run despite IN_ENTRY_ZONE');
});

// ==================================================================
// TEST 6: Individual and batch message previews are returned
// ==================================================================
test('dry-run returns individual and batch message previews plus full preview payload', async function () {
  const dry = await runMonitor({ dry_run: '1' }, buildScenario());
  const body = dry.res.body;

  assert.equal(body.dry_run, true);
  assert.equal(body.write_suppressed, true);
  assert.equal(body.telegram_suppressed, true);
  assert.equal(body.checked_count, 3);

  // Individual previews: BBCA (TP1_HIT) and TLKM (IN_ENTRY_ZONE)
  assert.equal(body.individual_message_previews.length, 2);
  const previewTickers = body.individual_message_previews.map(function (p) { return p.ticker; }).sort();
  assert.deepEqual(previewTickers, ['BBCA', 'TLKM']);
  body.individual_message_previews.forEach(function (p) {
    assert.ok(typeof p.message === 'string' && p.message.length > 0, 'preview message must be a non-empty string');
  });

  // Batch preview present and non-empty
  assert.ok(typeof body.batch_message_preview === 'string' && body.batch_message_preview.length > 0);
  // WATCHLIST (ANTM) belongs in the batch summary.
  assert.ok(body.batch_message_preview.indexOf('ANTM') >= 0, 'batch preview should include the non-significant ticker');

  // Per-event diagnostic fields required by the spec.
  const evt = body.events.find(function (e) { return e.ticker === 'BBCA'; });
  assert.equal(evt.source, 'daytrade_signal');
  assert.equal(evt.previous_status, 'RUNNING');
  assert.equal(evt.simulated_status, 'TP1_HIT');
  assert.equal(evt.current_price, 111);
  assert.deepEqual(evt.entry_range, { entry1: 100, entry2: 98 });
  assert.equal(evt.tp1, 110);
  assert.equal(evt.tp2, 120);
  assert.equal(evt.sl, 90);
  assert.equal(typeof evt.pct_change, 'number');
  assert.equal(evt.would_be_new_significant_hit, true);
  assert.equal(evt.sendable, true);
  assert.ok(typeof evt.send_reason === 'string' && evt.send_reason.length > 0);

  // Non-significant event explains why it is not individually sendable.
  const watch = body.events.find(function (e) { return e.ticker === 'ANTM'; });
  assert.equal(watch.would_be_new_significant_hit, false);
  assert.equal(watch.sendable, false);
  assert.ok(watch.send_reason.length > 0);
});

// ==================================================================
// TEST 7: Day Trade, Swing Konglo, and Swing Non-Konglo sources preserved
// ==================================================================
test('dry-run preserves all three monitored sources per ticker', async function () {
  const dry = await runMonitor({ dry_run: '1' }, buildScenario());
  const sources = {};
  dry.res.body.events.forEach(function (e) { sources[e.ticker] = e.source; });
  assert.equal(sources.BBCA, 'daytrade_signal');
  assert.equal(sources.TLKM, 'swing_konglo');
  assert.equal(sources.ANTM, 'swing_nk');
});

// ==================================================================
// TEST 8: Normal non-dry-run behavior remains unchanged
// ==================================================================
test('normal mode still updates, sends, narrates, and returns production shape', async function () {
  const normal = await runMonitor({}, buildScenario());
  const body = normal.res.body;

  assert.equal(body.success, true);
  assert.equal(body.dry_run, undefined, 'normal response must not carry dry_run');
  assert.equal(body.write_suppressed, undefined);
  assert.equal(body.telegram_suppressed, undefined);
  assert.equal(body.checked_count, 3);
  assert.equal(body.sent_count, 1, 'batch send returns sent_count 1');
  assert.ok(Array.isArray(body.ai_narration) && body.ai_narration.length === 2);
  assert.equal(normal.updateCalls.length, 3);
  assert.equal(normal.sendCalls.length, 3);

  // Every update carries last_checked_at and a computed status.
  normal.updateCalls.forEach(function (u) {
    assert.ok(u.updateObj.last_checked_at, 'update must set last_checked_at in normal mode');
    assert.ok(u.updateObj.status, 'update must set status in normal mode');
  });
  // TP1 hit row records hit_tp1_at in normal mode.
  const tp1Update = normal.updateCalls.find(function (u) { return u.eqVal === 1; });
  assert.ok(tp1Update.updateObj.hit_tp1_at, 'normal mode records hit_tp1_at for a new TP1 hit');
});

// ==================================================================
// TEST 9: Repeated dry-runs are idempotent and produce no writes
// ==================================================================
test('repeated dry-runs produce no writes/sends/narration and identical events', async function () {
  const first = await runMonitor({ dry_run: '1' }, buildScenario());
  const second = await runMonitor({ dryRun: '1' }, buildScenario());

  assert.equal(first.updateCalls.length, 0);
  assert.equal(second.updateCalls.length, 0);
  assert.equal(first.sendCalls.length, 0);
  assert.equal(second.sendCalls.length, 0);
  assert.equal(first.narrateCalls.length, 0);
  assert.equal(second.narrateCalls.length, 0);

  // Same events regardless of dry_run vs dryRun spelling.
  assert.deepEqual(
    second.res.body.events.map(function (e) { return e.ticker + ':' + e.simulated_status; }),
    first.res.body.events.map(function (e) { return e.ticker + ':' + e.simulated_status; })
  );
});

// ==================================================================
// TEST 10: API endpoint JS count remains exactly 12
// ==================================================================
test('api/ directory still contains exactly 12 endpoint JS files', function () {
  const apiDir = path.resolve(__dirname, '..', 'api');
  const jsFiles = fs.readdirSync(apiDir).filter(function (f) { return f.endsWith('.js'); });
  assert.equal(jsFiles.length, 12, 'API endpoint JS count must remain exactly 12; found: ' + jsFiles.join(', '));
});
