'use strict';

/**
 * FASE B2: informational-only cooldown flag. When a ticker was recently
 * SL_HIT with an entry/SL/TP setup very close to a new candidate's, the
 * candidate is still published as-is but gets `recently_failed_similar_setup`
 * so the user can see it and decide for themselves — it must never filter,
 * re-score, or hide anything.
 *
 * Examples from the investigation: GULA (12 -> 13 Aug) and PADI (16 -> 17 Jul)
 * were republished within a day of an SL_HIT with near-identical levels.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const sectorHot = require('../api/sector-hot');
const cooldown = require('../lib/recent-failure-cooldown');

function makeSupabase(tables) {
  tables = tables || {};
  function builder(table) {
    var filters = [];
    var api = {
      select: function() { return api; },
      eq: function(col, val) { filters.push(function(r) { return r[col] === val; }); return api; },
      gte: function(col, val) { filters.push(function(r) { return r[col] >= val; }); return api; },
      lt: function(col, val) { filters.push(function(r) { return r[col] < val; }); return api; },
      then: function(resolve, reject) {
        var rows = (tables[table] || []).filter(function(r) { return filters.every(function(f) { return f(r); }); });
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
      }
    };
    return api;
  }
  return { from: function(table) { return builder(table); } };
}

test('annotateRecentlyFailedSimilarSetups flags a candidate whose ticker recently SL_HIT with a near-identical setup', async () => {
  const tables = {
    telegram_daily_picks: [
      { id: 1, ticker: 'GULA', date: '2026-08-12', status: 'SL_HIT', entry1: 102, entry2: 100, sl: 95, tp1: 115 }
    ]
  };
  const supabase = makeSupabase(tables);
  const candidates = [
    { ticker: 'GULA', entry_low: 100.5, entry_high: 102.5, sl: 95.2, tp1: 115.3 }
  ];

  await sectorHot.__test.annotateRecentlyFailedSimilarSetups(supabase, candidates, '2026-08-13');

  assert.equal(candidates[0].recently_failed_similar_setup, true);
  assert.match(candidates[0].recently_failed_similar_setup_note, /SL_HIT pada 2026-08-12/);
});

test('annotateRecentlyFailedSimilarSetups does not flag a candidate with materially different levels', async () => {
  const tables = {
    telegram_daily_picks: [
      { id: 1, ticker: 'PADI', date: '2026-07-16', status: 'SL_HIT', entry1: 102, entry2: 100, sl: 95, tp1: 115 }
    ]
  };
  const supabase = makeSupabase(tables);
  const candidates = [
    { ticker: 'PADI', entry_low: 130, entry_high: 132, sl: 120, tp1: 150 }
  ];

  await sectorHot.__test.annotateRecentlyFailedSimilarSetups(supabase, candidates, '2026-07-17');

  assert.equal(candidates[0].recently_failed_similar_setup, undefined);
});

test('annotateRecentlyFailedSimilarSetups looks back only within the cooldown window (does not flag old SL_HIT)', async () => {
  const tables = {
    telegram_daily_picks: [
      // SL_HIT far outside the default 5-day cooldown window
      { id: 1, ticker: 'GULA', date: '2026-08-01', status: 'SL_HIT', entry1: 102, entry2: 100, sl: 95, tp1: 115 }
    ]
  };
  const supabase = makeSupabase(tables);
  const candidates = [
    { ticker: 'GULA', entry_low: 100.5, entry_high: 102.5, sl: 95.2, tp1: 115.3 }
  ];

  await sectorHot.__test.annotateRecentlyFailedSimilarSetups(supabase, candidates, '2026-08-13');

  assert.equal(candidates[0].recently_failed_similar_setup, undefined);
});

test('annotateRecentlyFailedSimilarSetups never removes or mutates scoring/entry fields, only adds informational flags', async () => {
  const tables = {
    telegram_daily_picks: [
      { id: 1, ticker: 'GULA', date: '2026-08-12', status: 'SL_HIT', entry1: 102, entry2: 100, sl: 95, tp1: 115 }
    ]
  };
  const supabase = makeSupabase(tables);
  const candidate = { ticker: 'GULA', entry_low: 100.5, entry_high: 102.5, sl: 95.2, tp1: 115.3, daytrade_score: 88, status: 'A_PLUS_SETUP' };
  const candidates = [candidate];

  await sectorHot.__test.annotateRecentlyFailedSimilarSetups(supabase, candidates, '2026-08-13');

  assert.equal(candidate.daytrade_score, 88);
  assert.equal(candidate.status, 'A_PLUS_SETUP');
  assert.equal(candidates.length, 1, 'candidate must still be present/displayed, not filtered out');
});

test('annotateRecentlyFailedSimilarSetups leaves candidates untouched when supabase read fails', async () => {
  const supabase = { from: function() { throw new Error('network down'); } };
  const candidates = [{ ticker: 'GULA', entry_low: 100.5, entry_high: 102.5, sl: 95.2, tp1: 115.3 }];

  const result = await sectorHot.__test.annotateRecentlyFailedSimilarSetups(supabase, candidates, '2026-08-13');

  assert.equal(result[0].recently_failed_similar_setup, undefined);
});

// --- Pure unit tests on lib/recent-failure-cooldown.js ---

test('withinTolerance respects the configured percentage band', () => {
  assert.equal(cooldown.withinTolerance(100, 102.9, 0.03), true);
  assert.equal(cooldown.withinTolerance(100, 103.1, 0.03), false);
});

test('findSimilarRecentSlHit requires entry, sl, AND tp1 to all match within tolerance', () => {
  const candidate = { entry_low: 100, entry_high: 102, sl: 95, tp1: 115 };
  const onlyEntryMatches = [{ ticker: 'X', date: '2026-08-10', entry_low: 100, entry_high: 102, sl: 50, tp1: 200 }];
  assert.equal(cooldown.findSimilarRecentSlHit(candidate, onlyEntryMatches), null);

  const allMatch = [{ ticker: 'X', date: '2026-08-10', entry_low: 100, entry_high: 102, sl: 95, tp1: 115 }];
  assert.ok(cooldown.findSimilarRecentSlHit(candidate, allMatch));
});

test('notification pipeline queries recent SL_HIT cooldown rows exactly once per execution (no duplicate query)', async () => {
  let slHitQueryCount = 0;
  const today = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();
  const mockRows = [
    {
      ticker: 'GULA', status: 'A_PLUS_SETUP', final_status: 'A_PLUS_SETUP', action_label: 'BUY', quality_grade: 'A', score: 88, daytrade_score: 88, risk_reward: 1.8,
      entry1: 100, entry_low: 100, entry2: 100, entry_high: 100, stop_loss: 95, sl: 95,
      tp1: 115, tp1n: 115, tp2: 125, last_price: 100, volume_ratio_20d: 1.5,
      value_today: 5000000000, risk_label: 'Low Risk', plan_quality_status: 'VALID', trading_plan_valid: true,
      breakout_confirmation_status: 'CONFIRMED', breakout_confirmation_label: 'Breakout Confirmed', entry_timing: 'ENTRY_NOW',
      resistance: 99, breakout_trigger: 99,
      entry_status: 'IN_ENTRY_ZONE', entry_status_label: 'Area Entry',
      respect_quality_label: 'Strong Respect', trend_label: 'Bullish Trend',
      volume_label: 'Strong Volume', volume_confirmation_label: 'Strong Volume',
      foreign_label: 'Foreign Accumulation', rr_quality_label: 'Healthy RR',
      tp_quality_label: 'TP realistic', sl_quality_label: 'Safe SL',
      pattern_label: 'Breakout Consolidation', notes: 'Siap Entry', status_reason: 'Siap Entry',
      telegram_verdict: 'Siap entry.',
      is_top5: true, is_verified: true, verified: true, final_quality_pass: true, final_quality_status: 'PASS',
      final_gate_pass: true, final_gate_status: 'PASS', final_quality_reason: 'Siap entry terkonfirmasi',
      entry_range_display: '100 - 100',
      setup_origin_at: nowIso,
      freshness_timestamp: nowIso,
      calculated_at: nowIso,
      price_date: today,
      price_freshness_status: 'FRESH'
    }
  ];

  function makeMockSupabaseWithCounter() {
    return {
      from(table) {
        if (table === 'telegram_daily_picks') {
          let isSlHitQuery = false;
          const api = {
            select() { return api; },
            eq(col, val) {
              if (col === 'status' && val === 'SL_HIT') {
                isSlHitQuery = true;
              }
              return api;
            },
            gte() { return api; },
            lt() { return api; },
            order() { return api; },
            limit() { return api; },
            insert() { return Promise.resolve({ data: [], error: null }); },
            then(resolve, reject) {
              if (isSlHitQuery) {
                slHitQueryCount++;
              }
              return Promise.resolve({ data: [], error: null }).then(resolve, reject);
            }
          };
          return api;
        }
        if (table === 'swing_screener_latest' || table === 'swing_screener_non_konglo_latest' || table === 'daytrade_screener_latest') {
          return {
            select() { return this; },
            order() { return this; },
            limit() { return Promise.resolve({ data: mockRows, error: null }); },
            eq() { return this; },
            maybeSingle() { return Promise.resolve({ data: { calculated_at: nowIso, run_date: today, run_id: 'r1', status: 'published' }, error: null }); }
          };
        }
        return {
          select() { return this; },
          eq() { return this; },
          order() { return this; },
          limit() { return Promise.resolve({ data: [], error: null }); },
          maybeSingle() { return Promise.resolve({ data: { calculated_at: nowIso, run_date: today, status: 'published' }, error: null }); },
          insert() { return Promise.resolve({ data: [], error: null }); }
        };
      }
    };
  }

  const notifier = require('../lib/telegram-notifier');
  const origSend = notifier.sendTelegramMessage;
  notifier.sendTelegramMessage = async () => ({ sent: true });

  try {
    // 1. Swing Konglo
    slHitQueryCount = 0;
    const sup1 = makeMockSupabaseWithCounter();
    await sectorHot.__test.sendSwingKongloTelegramNotification(sup1, 1);
    assert.equal(slHitQueryCount, 1, 'Swing Konglo should query SL_HIT cooldown table exactly once');

    // 2. Swing Non-Konglo
    slHitQueryCount = 0;
    const sup2 = makeMockSupabaseWithCounter();
    await sectorHot.__test.sendSwingNkTelegramNotification(sup2, 1);
    assert.equal(slHitQueryCount, 1, 'Swing Non-Konglo should query SL_HIT cooldown table exactly once');

    // 3. Day Trade
    slHitQueryCount = 0;
    const sup3 = makeMockSupabaseWithCounter();
    const dtRunId = 'dt-run-' + Date.now();
    const dtRes = await sectorHot.__test.sendDayTradeTelegramNotification(sup3, dtRunId, today, 1, false, false, {});
    assert.equal(dtRes.strict_signal_count, 1, 'dtRes: ' + JSON.stringify(dtRes));
    assert.equal(slHitQueryCount, 1, 'Day Trade should query SL_HIT cooldown table exactly once');
  } finally {
    notifier.sendTelegramMessage = origSend;
  }
});
