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
