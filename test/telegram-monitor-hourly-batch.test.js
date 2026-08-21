'use strict';

/**
 * Focused tests for the HOURLY BATCH SUMMARY cadence of the shared Telegram
 * follow-up monitor (`telegram-monitor-picks`).
 *
 * Behavior under test:
 *   - The monitor keeps running on its existing ~30-minute schedule.
 *   - Immediate individual notifications (IN_ENTRY_ZONE / TP1_HIT / TP2_HIT /
 *     SL_HIT) fire on EVERY run, idempotently, independent of cadence.
 *   - The routine batch summary is sent only on the top-of-hour run
 *     (Jakarta minute 0-29) and suppressed on the half-hour run (minute 30-59).
 *   - dry-run remains fully non-mutating; preview_hourly_batch=1 only works with
 *     dry_run=1.
 *
 * These are behavioral tests: they invoke the real handleTelegramMonitorPicks()
 * with a fully mocked Supabase client and spies over the Telegram notifier and
 * AI narration modules. No production endpoint, network, Telegram, or database is
 * ever touched. @supabase/supabase-js is stubbed via a one-time Module._load
 * override, and the Jakarta minute is injected through the exported monitorClock.
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
  isHourlyBatchDue,
  isPreviewHourlyBatchRequest,
  formatMonitorBatchRow,
  formatMonitorSourceLabel,
  monitorClock
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

// Runs the monitor with an injected Jakarta minute so cadence is deterministic.
async function runMonitorAtMinute(minute, extraQuery, scenario) {
  sendCalls = [];
  narrateCalls = [];
  monitorClock.getJakartaMinute = function () { return minute; };
  const supabase = makeSupabase(scenario);
  const req = {
    method: 'GET',
    // verifyCronSecret() only accepts the Bearer Authorization header (query-string
    // secrets were removed as a hardening measure).
    headers: { authorization: 'Bearer ' + process.env.CRON_SECRET },
    query: Object.assign({ force: '1' }, extraQuery || {})
  };
  const res = makeRes();
  await handleTelegramMonitorPicks(req, res, supabase);
  return { res: res, updateCalls: supabase.updateCalls, sendCalls: sendCalls, narrateCalls: narrateCalls };
}

// Scenario builders --------------------------------------------------

// A brand-new TP1 hit (significant -> immediate individual notification).
function newTp1Scenario() {
  return {
    rows: [{
      id: 1, ticker: 'BBCA', date: '2026-07-17', status: 'RUNNING', is_final: false,
      entry1: 100, entry2: 98, tp1: 110, tp2: 120, sl: 90,
      first_sent_at: NOW_ISO, hit_entry_at: NOW_ISO,
      hit_tp1_at: null, hit_tp2_at: null, hit_sl_at: null,
      category: 'Day Trade', raw_payload: { monitor_source: 'daytrade_signal' }
    }],
    daytradePrices: { BBCA: { last_price: 111, open_price: 110, high_price: 112, low_price: 108, calculated_at: NOW_ISO } }
  };
}

// A single non-significant row (WATCHLIST): no immediate individual event.
function watchlistOnlyScenario() {
  return {
    rows: [{
      id: 5, ticker: 'ANTM', date: '2026-07-17', status: 'WAITING', is_final: false,
      entry1: 100, entry2: 98, tp1: 110, tp2: 120, sl: 95,
      first_sent_at: NOW_ISO, hit_entry_at: null,
      hit_tp1_at: null, hit_tp2_at: null, hit_sl_at: null,
      category: 'Swing Non-Konglo', raw_payload: { monitor_source: 'swing_nk' }
    }],
    // last 96 -> below entry2 (98) but above SL (95) -> WATCHLIST (non-significant)
    daytradePrices: { ANTM: { last_price: 96, open_price: 96, high_price: 96, low_price: 96 } }
  };
}

// ==================================================================
// Pure-function tests: cadence + preview flag
// ==================================================================
test('isHourlyBatchDue: due at top-of-hour bucket (0-29), suppressed at half-hour (30-59)', function () {
  assert.equal(isHourlyBatchDue(0), true, 'minute 00 -> batch due');
  assert.equal(isHourlyBatchDue(5), true, 'a few minutes of scheduler drift still counts as top-of-hour');
  assert.equal(isHourlyBatchDue(29), true);
  assert.equal(isHourlyBatchDue(30), false, 'minute 30 -> suppressed');
  assert.equal(isHourlyBatchDue(45), false);
  assert.equal(isHourlyBatchDue(59), false);
});

test('isPreviewHourlyBatchRequest parses the override flag', function () {
  assert.equal(isPreviewHourlyBatchRequest({ query: { preview_hourly_batch: '1' } }), true);
  assert.equal(isPreviewHourlyBatchRequest({ query: { previewHourlyBatch: 'true' } }), true);
  assert.equal(isPreviewHourlyBatchRequest({ query: {} }), false);
  assert.equal(isPreviewHourlyBatchRequest({ query: { preview_hourly_batch: '0' } }), false);
});

test('formatMonitorSourceLabel maps internal tokens to human labels', function () {
  assert.equal(formatMonitorSourceLabel('daytrade_signal'), 'Day Trade');
  assert.equal(formatMonitorSourceLabel('swing_konglo'), 'Swing Konglo');
  assert.equal(formatMonitorSourceLabel('swing_nk'), 'Swing Non-Konglo');
  assert.equal(formatMonitorSourceLabel('Swing Non-Konglo'), 'Swing Non-Konglo');
});

// ==================================================================
// TEST 1: At minute 00 the batch summary would be sent
// ==================================================================
test('minute 00: routine batch summary is sent', async function () {
  const r = await runMonitorAtMinute(0, {}, watchlistOnlyScenario());
  assert.equal(r.res.body.hourly_batch_due, true);
  assert.equal(r.res.body.batch_suppressed_by_cadence, false);
  // No individual events in this scenario, so the ONLY send is the batch summary.
  assert.equal(r.sendCalls.length, 1, 'exactly one send: the batch summary');
  assert.equal(r.res.body.sent_count, 1, 'batch send reported as sent_count 1');
  assert.ok(r.res.body.telegram && r.res.body.telegram.sent === true);
});

// ==================================================================
// TEST 2: At minute 30 the batch summary is suppressed
// ==================================================================
test('minute 30: routine batch summary is suppressed (no batch send)', async function () {
  const r = await runMonitorAtMinute(30, {}, watchlistOnlyScenario());
  assert.equal(r.res.body.hourly_batch_due, false);
  assert.equal(r.res.body.batch_suppressed_by_cadence, true);
  // Only a non-significant row and cadence suppressed -> zero sends.
  assert.equal(r.sendCalls.length, 0, 'no batch summary is sent at :30');
  assert.equal(r.res.body.sent_count, 0);
  assert.equal(r.res.body.telegram.skipped, true);
  assert.equal(r.res.body.telegram.reason, 'batch_suppressed_by_cadence');
});

// ==================================================================
// TEST 3: A new event still sends immediately at minute 30
// ==================================================================
test('minute 30: a new TP1 hit still sends its individual notification immediately', async function () {
  const r = await runMonitorAtMinute(30, {}, newTp1Scenario());
  assert.equal(r.res.body.hourly_batch_due, false, 'batch is suppressed at :30');
  // The batch is suppressed, but the individual TP1 alert still fires -> exactly 1 send.
  assert.equal(r.sendCalls.length, 1, 'the immediate individual event send is not delayed by cadence');
  assert.equal(r.res.body.individual_sent_count, 1);
  assert.equal(r.res.body.sent_count, 0, 'sent_count tracks the batch only, which was suppressed');
  // The single send is the individual hit message (not the batch digest).
  assert.ok(/TP1/.test(r.sendCalls[0].msg), 'the send is the TP1 individual alert');
});

test('minute 00: the same new TP1 event sends the individual alert AND the batch', async function () {
  const r = await runMonitorAtMinute(0, {}, newTp1Scenario());
  assert.equal(r.sendCalls.length, 2, 'individual alert + batch summary');
  assert.equal(r.res.body.individual_sent_count, 1);
  assert.equal(r.res.body.sent_count, 1);
});

// ==================================================================
// TEST 4: No new individual event means no individual message
// ==================================================================
test('no new significant event -> zero individual messages (at :30 -> zero sends total)', async function () {
  const r30 = await runMonitorAtMinute(30, {}, watchlistOnlyScenario());
  assert.equal(r30.res.body.individual_sent_count, 0);
  assert.equal(r30.sendCalls.length, 0);

  // And a previously-recorded TP1 (hit_tp1_at already set) is NOT a new hit.
  const r0 = await runMonitorAtMinute(0, {}, {
    rows: [Object.assign(newTp1Scenario().rows[0], { hit_tp1_at: NOW_ISO })],
    daytradePrices: newTp1Scenario().daytradePrices
  });
  assert.equal(r0.res.body.individual_sent_count, 0, 'already-recorded TP1 is not re-sent individually');
  // Only the batch summary is sent (top of hour), no individual message.
  assert.equal(r0.sendCalls.length, 1);
});

// ==================================================================
// TEST 5: Deduplicated rows remain deduplicated
// ==================================================================
test('deduplication is preserved: only the latest row per source+ticker is evaluated', async function () {
  const scenario = {
    rows: [
      { id: 1, ticker: 'COCO', date: '2026-07-14', status: 'WAITING', is_final: false, entry1: 100, entry2: 98, tp1: 110, tp2: 120, sl: 95, hit_entry_at: null, hit_tp1_at: null, hit_tp2_at: null, hit_sl_at: null, raw_payload: { monitor_source: 'swing_nk' } },
      { id: 2, ticker: 'COCO', date: '2026-07-16', status: 'WAITING', is_final: false, entry1: 100, entry2: 98, tp1: 110, tp2: 120, sl: 95, hit_entry_at: null, hit_tp1_at: null, hit_tp2_at: null, hit_sl_at: null, raw_payload: { monitor_source: 'swing_nk' } }
    ],
    daytradePrices: { COCO: { last_price: 99, open_price: 99, high_price: 99, low_price: 99 } }
  };
  const dry = await runMonitorAtMinute(0, { dry_run: '1' }, scenario);
  assert.equal(dry.res.body.raw_row_count, 2);
  assert.equal(dry.res.body.deduped_row_count, 1, 'duplicates collapse to one row');
  assert.equal(dry.res.body.events.length, 1);
  assert.equal(dry.res.body.events[0].row_id, 2, 'latest recommendation wins');

  // Normal mode: exactly one update + one batch send (single deduped row, no individual event).
  const normal = await runMonitorAtMinute(0, {}, scenario);
  assert.equal(normal.updateCalls.length, 1, 'only the kept row is updated');
  assert.equal(normal.sendCalls.length, 1, 'one batch summary; deduped ticker appears once');
});

// ==================================================================
// TEST 6: Before entry, percentage wording is DISTANCE FROM ENTRY
// ==================================================================
test('before entry activation: percentage is labelled as distance from entry (not P/L)', function () {
  const pick = { ticker: 'AAAA', entry1: 100, entry2: 98, tp1: 110, tp2: 120, sl: 95, hit_entry_at: null, raw_payload: { monitor_source: 'swing_nk' } };
  const ev = { status: 'ENTRY_READY', note: 'wait' };
  const px = { last: 96, high: 96, low: 96 };
  const block = formatMonitorBatchRow(pick, ev, px);
  assert.ok(/Jarak dari entry/.test(block), 'must label as distance from entry before activation');
  assert.ok(/belum entry/.test(block));
  assert.ok(!/P\/L/.test(block), 'must NOT use P/L wording before activation');
});

// ==================================================================
// TEST 7: After entry, percentage wording is P/L
// ==================================================================
test('after entry activation: percentage is labelled as P/L versus the reference entry', function () {
  const pick = { ticker: 'BBBB', entry1: 100, entry2: 98, tp1: 110, tp2: 120, sl: 95, hit_entry_at: NOW_ISO, raw_payload: { monitor_source: 'swing_konglo' } };
  const ev = { status: 'RUNNING', note: 'running' };
  const px = { last: 105, high: 106, low: 101 };
  const block = formatMonitorBatchRow(pick, ev, px);
  assert.ok(/P\/L vs entry/.test(block), 'must label as P/L after activation');
  assert.ok(/\+5\.0%/.test(block), 'P/L computed vs reference entry (100 -> 105 = +5.0%)');
  assert.ok(!/Jarak dari entry/.test(block), 'must NOT use distance wording after activation');
});

// ==================================================================
// TEST 8: SL_HIT summary includes intraday low AND SL
// ==================================================================
test('SL_HIT batch block shows intraday low and SL (recovered last is not contradictory)', function () {
  const pick = { ticker: 'PADI', entry1: 100, entry2: 98, tp1: 110, tp2: 120, sl: 95, hit_entry_at: NOW_ISO, raw_payload: { monitor_source: 'swing_konglo' } };
  const ev = { status: 'SL_HIT', note: 'SL tersentuh', isFinal: true };
  // Intraday low wicked to 94 (<= SL 95) but last recovered to 103 (> entry).
  const px = { last: 103, high: 104, low: 94 };
  const block = formatMonitorBatchRow(pick, ev, px);
  assert.ok(/Low intraday: 94/.test(block), 'must show the intraday low');
  assert.ok(/SL: 95/.test(block), 'must show the SL level');
  // P/L still positive because it keys off last vs entry, not low vs SL.
  assert.ok(/P\/L vs entry 100: \+3\.0%/.test(block), 'P/L vs entry stays positive after a recovery');
});

// ==================================================================
// TEST 9: Dry-run never writes or sends (even at the top of the hour)
// ==================================================================
test('dry-run performs no writes, no sends, no narration at minute 00', async function () {
  const dry = await runMonitorAtMinute(0, { dry_run: '1' }, newTp1Scenario());
  assert.equal(dry.updateCalls.length, 0, 'no Supabase update');
  assert.equal(dry.sendCalls.length, 0, 'no Telegram send');
  assert.equal(dry.narrateCalls.length, 0, 'no AI narration');
  assert.equal(dry.res.body.write_suppressed, true);
  assert.equal(dry.res.body.telegram_suppressed, true);
  assert.equal(dry.res.body.ai_suppressed, true);
  // Diagnostics present.
  assert.equal(dry.res.body.hourly_batch_due, true);
  assert.equal(dry.res.body.batch_suppressed_by_cadence, false);
  assert.equal(typeof dry.res.body.batch_send_reason, 'string');
  assert.ok(dry.res.body.batch_send_reason.length > 0);
  assert.equal(dry.res.body.individual_sendable_count, 1, 'the new TP1 hit is individually sendable');
  assert.ok(typeof dry.res.body.batch_message_preview === 'string' && dry.res.body.batch_message_preview.length > 0);
});

// ==================================================================
// TEST 10: preview_hourly_batch=1 works only in dry-run
// ==================================================================
test('preview_hourly_batch=1 forces a batch preview at :30 ONLY in dry-run, and never sends', async function () {
  // Dry-run at :30 WITHOUT the override -> no preview (cadence would suppress).
  const dryNoOverride = await runMonitorAtMinute(30, { dry_run: '1' }, watchlistOnlyScenario());
  assert.equal(dryNoOverride.res.body.hourly_batch_due, false);
  assert.equal(dryNoOverride.res.body.batch_message_preview, null, 'no preview at :30 without override');
  assert.equal(dryNoOverride.res.body.preview_hourly_batch, false);

  // Dry-run at :30 WITH the override -> preview generated regardless of minute.
  const dryOverride = await runMonitorAtMinute(30, { dry_run: '1', preview_hourly_batch: '1' }, watchlistOnlyScenario());
  assert.equal(dryOverride.res.body.hourly_batch_due, false, 'cadence still reports suppressed at :30');
  assert.equal(dryOverride.res.body.batch_suppressed_by_cadence, true, 'a real run would still suppress');
  assert.equal(dryOverride.res.body.preview_hourly_batch, true);
  assert.ok(typeof dryOverride.res.body.batch_message_preview === 'string' && dryOverride.res.body.batch_message_preview.length > 0, 'preview generated via override');
  // Still fully non-mutating.
  assert.equal(dryOverride.updateCalls.length, 0);
  assert.equal(dryOverride.sendCalls.length, 0);
  assert.equal(dryOverride.narrateCalls.length, 0);

  // The override has NO effect outside dry-run: normal mode at :30 still suppresses
  // and sends nothing, and never exposes a preview.
  const normalOverride = await runMonitorAtMinute(30, { preview_hourly_batch: '1' }, watchlistOnlyScenario());
  assert.equal(normalOverride.sendCalls.length, 0, 'override must not trigger any send outside dry-run');
  assert.equal(normalOverride.res.body.sent_count, 0);
  assert.equal(normalOverride.res.body.batch_message_preview, undefined, 'no preview field in normal mode');
});

// ==================================================================
// TEST 12: API endpoint JS count remains exactly 12
// ==================================================================
test('api/ directory still contains exactly 12 endpoint JS files', function () {
  const apiDir = path.resolve(__dirname, '..', 'api');
  const jsFiles = fs.readdirSync(apiDir).filter(function (f) { return f.endsWith('.js'); });
  assert.equal(jsFiles.length, 12, 'API endpoint JS count must remain exactly 12; found: ' + jsFiles.join(', '));
});
