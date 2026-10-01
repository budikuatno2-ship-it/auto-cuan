'use strict';

/**
 * FASE A: Day Trade Screener published candidates (daytrade_screener_latest,
 * up to ~50/day) previously had NO outcome tracking — registerCandidatesForMonitoring
 * was only ever called for the small subset that also got sent as a Telegram
 * signal (monitor_source 'daytrade_signal'). These tests verify finalizeDtScreener
 * now registers every published candidate under monitor_source 'daytrade'.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const sectorHot = require('../api/sector-hot');
const notifier = require('../lib/telegram-notifier');

function makeSupabase(tables) {
  tables = tables || {};

  function builder(table) {
    var filters = [];
    var limitN = null;
    var wantMaybeSingle = false;

    var api = {
      select: function() { return api; },
      order: function() { return api; },
      eq: function(col, val) { filters.push(function(r) { return r[col] === val; }); return api; },
      gte: function(col, val) { filters.push(function(r) { return r[col] >= val; }); return api; },
      lt: function(col, val) { filters.push(function(r) { return r[col] < val; }); return api; },
      neq: function(col, val) { filters.push(function(r) { return r[col] !== val; }); return api; },
      in: function(col, vals) { filters.push(function(r) { return vals.indexOf(r[col]) >= 0; }); return api; },
      limit: function(n) { limitN = n; return api; },
      maybeSingle: function() { wantMaybeSingle = true; return api; },
      insert: function(rows) {
        var arr = Array.isArray(rows) ? rows : [rows];
        tables[table] = tables[table] || [];
        var withIds = arr.map(function(r, i) {
          return Object.assign({ id: tables[table].length + i + 1 }, r);
        });
        tables[table] = tables[table].concat(withIds);
        return {
          select: function() { return Promise.resolve({ data: withIds, error: null }); },
          then: function(resolve, reject) { return Promise.resolve({ data: withIds, error: null }).then(resolve, reject); }
        };
      },
      upsert: function(rows) {
        var arr = Array.isArray(rows) ? rows : [rows];
        tables[table] = tables[table] || [];
        arr.forEach(function(r) {
          var idx = tables[table].findIndex(function(x) { return x.id === r.id; });
          if (idx >= 0) tables[table][idx] = Object.assign({}, tables[table][idx], r);
          else tables[table].push(r);
        });
        return Promise.resolve({ data: arr, error: null });
      },
      delete: function() {
        return {
          neq: function() { return Promise.resolve({ error: null }); },
          in: function() { return Promise.resolve({ error: null }); }
        };
      },
      update: function() {
        return {
          in: function() { return Promise.resolve({ error: null }); },
          eq: function() { return Promise.resolve({ error: null }); }
        };
      },
      then: function(resolve, reject) {
        var rows = (tables[table] || []).filter(function(r) {
          return filters.every(function(f) { return f(r); });
        });
        if (limitN != null) rows = rows.slice(0, limitN);
        var result = wantMaybeSingle
          ? { data: rows[0] || null, error: null }
          : { data: rows, error: null };
        return Promise.resolve(result).then(resolve, reject);
      }
    };
    return api;
  }

  return { from: function(table) { return builder(table); }, __tables: tables };
}

function dtRow(overrides) {
  return Object.assign({
    ticker: 'GOTO',
    daytrade_score: 80,
    status: 'A_PLUS_SETUP',
    risk_reward: 2.5,
    entry_low: 100,
    entry_high: 102,
    stop_loss: 95,
    tp1: 115,
    tp2: 125,
    calculated_at: new Date().toISOString()
  }, overrides || {});
}

function makeRes() {
  var captured = null;
  return {
    status: function(code) {
      return { json: function(payload) { captured = { code: code, payload: payload }; return captured; } };
    },
    get: function() { return captured; }
  };
}

async function withSendSpy(fn) {
  const original = notifier.sendTelegramMessage;
  notifier.sendTelegramMessage = async (text) => ({ sent: true, message: text });
  try { return await fn(); } finally { notifier.sendTelegramMessage = original; }
}

test('finalizeDtScreener registers every published candidate for TP/SL monitoring under monitor_source daytrade', async () => {
  await withSendSpy(async () => {
    const tables = {
      daytrade_screener_latest: [
        dtRow({ ticker: 'GOTO' }),
        dtRow({ ticker: 'ANTM', entry_low: 200, entry_high: 205, stop_loss: 190, tp1: 230, tp2: 250, daytrade_score: 75, status: 'TRADE_CANDIDATE' })
      ],
      telegram_daily_picks: []
    };
    const supabase = makeSupabase(tables);
    const req = { query: { defer_to_fast_watcher: '1' }, body: {} };
    const res = makeRes();

    await sectorHot.__test.finalizeDtScreener(
      req, res, supabase, 'test-run-1', '2026-08-20', 'full', 2, 1,
      { scanned_count: 2, failed_count: 0, passed_count: 2 }
    );

    const captured = res.get();
    assert.ok(captured, 'finalizeDtScreener should respond');
    assert.equal(captured.payload.success, true);
    assert.equal(captured.payload.screener_monitor_registered_count, 2);

    const inserted = tables.telegram_daily_picks;
    assert.equal(inserted.length, 2, 'both published candidates should be registered for monitoring');

    const goto = inserted.find((r) => r.ticker === 'GOTO');
    assert.ok(goto, 'GOTO should be registered');
    assert.equal(goto.status, 'WAITING');
    assert.equal(goto.date, '2026-08-20');
    assert.equal(goto.monitor_source, 'daytrade');
    assert.equal(goto.raw_payload.monitor_source, 'daytrade');

    const antm = inserted.find((r) => r.ticker === 'ANTM');
    assert.ok(antm, 'ANTM should be registered');
    assert.equal(antm.monitor_source, 'daytrade');
  });
});

test('finalizeDtScreener does not double-register a candidate already registered under daytrade for the same date/levels', async () => {
  await withSendSpy(async () => {
    const tables = {
      daytrade_screener_latest: [dtRow({ ticker: 'GOTO' })],
      telegram_daily_picks: []
    };
    const supabase = makeSupabase(tables);
    const req = { query: { defer_to_fast_watcher: '1' }, body: {} };

    // Run twice for the same run date — second run must not duplicate the row.
    await sectorHot.__test.finalizeDtScreener(req, makeRes(), supabase, 'run-1', '2026-08-20', 'full', 1, 1, { scanned_count: 1, failed_count: 0, passed_count: 1 });
    await sectorHot.__test.finalizeDtScreener(req, makeRes(), supabase, 'run-2', '2026-08-20', 'full', 1, 1, { scanned_count: 1, failed_count: 0, passed_count: 1 });

    const gotoRows = tables.telegram_daily_picks.filter((r) => r.ticker === 'GOTO' && r.monitor_source === 'daytrade');
    assert.equal(gotoRows.length, 1, 'duplicate registration should be skipped');
  });
});
