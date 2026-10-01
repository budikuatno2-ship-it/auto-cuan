'use strict';

/**
 * Pure informational cooldown flag: when a ticker was published again with an
 * entry/SL/TP setup very close to one that recently hit SL, callers can show
 * `recently_failed_similar_setup` to the user. It never filters, re-scores,
 * or blocks a candidate — the decision to act stays with the user.
 */

// How many calendar days back to look for a prior SL_HIT on the same ticker.
const RECENT_SL_HIT_COOLDOWN_DAYS = 5;

// How close the new entry/SL/TP levels must be to the failed setup's levels
// (as a fraction of the failed level) to be considered "the same setup".
const RECENT_SL_HIT_LEVEL_TOLERANCE_PCT = 0.03;

function toNumber(v) {
  var n = typeof v === 'number' ? v : parseFloat(v);
  return isFinite(n) ? n : null;
}

function withinTolerance(a, b, tolerancePct) {
  a = toNumber(a);
  b = toNumber(b);
  if (a == null || b == null || a === 0) return false;
  return Math.abs(a - b) / Math.abs(a) <= tolerancePct;
}

function candidateLevels(candidate) {
  candidate = candidate || {};
  var entryLow = toNumber(candidate.entry_low != null ? candidate.entry_low : (candidate.entry2 != null ? candidate.entry2 : candidate.entry1));
  var entryHigh = toNumber(candidate.entry_high != null ? candidate.entry_high : (candidate.entry1 != null ? candidate.entry1 : candidate.entry2));
  if (entryLow != null && entryHigh != null && entryLow > entryHigh) {
    var t = entryLow; entryLow = entryHigh; entryHigh = t;
  }
  var sl = toNumber(candidate.sl != null ? candidate.sl : candidate.stop_loss);
  var tp1 = toNumber(candidate.tp1n != null ? candidate.tp1n : (candidate.tp1 != null ? candidate.tp1 : candidate.target1));
  return { entry_low: entryLow, entry_high: entryHigh, sl: sl, tp1: tp1 };
}

function daysBetween(dateA, dateB) {
  var a = new Date(dateA);
  var b = new Date(dateB);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return null;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/**
 * Given a candidate and a list of that ticker's recent SL_HIT rows (already
 * filtered to the cooldown window), return the most recent one whose levels
 * are within tolerance of the candidate's new levels, or null.
 */
function findSimilarRecentSlHit(candidate, recentSlHitRowsForTicker, opts) {
  opts = opts || {};
  var tolerancePct = opts.tolerance_pct != null ? opts.tolerance_pct : RECENT_SL_HIT_LEVEL_TOLERANCE_PCT;
  var levels = candidateLevels(candidate);
  if (levels.entry_low == null && levels.entry_high == null && levels.sl == null && levels.tp1 == null) return null;
  var rows = (recentSlHitRowsForTicker || []).slice().sort(function(a, b) {
    return String(b.date || '').localeCompare(String(a.date || ''));
  });
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var rowLevels = candidateLevels(row);
    var entryMatches =
      (levels.entry_low != null && rowLevels.entry_low != null && withinTolerance(rowLevels.entry_low, levels.entry_low, tolerancePct)) ||
      (levels.entry_high != null && rowLevels.entry_high != null && withinTolerance(rowLevels.entry_high, levels.entry_high, tolerancePct));
    var slMatches = levels.sl != null && rowLevels.sl != null && withinTolerance(rowLevels.sl, levels.sl, tolerancePct);
    var tp1Matches = levels.tp1 != null && rowLevels.tp1 != null && withinTolerance(rowLevels.tp1, levels.tp1, tolerancePct);
    if (entryMatches && slMatches && tp1Matches) return row;
  }
  return null;
}

/**
 * Mutates `candidates` in place, adding `recently_failed_similar_setup` and
 * `recently_failed_similar_setup_note` when a matching recent SL_HIT setup is
 * found. `fetchRecentSlHitRows` is injected so this stays testable without a
 * real supabase client: it must resolve to an array of
 * { ticker, date, entry_low, entry_high, sl, tp1 } rows.
 */
async function annotateRecentlyFailedSimilarSetups(candidates, date, fetchRecentSlHitRows, opts) {
  opts = opts || {};
  if (!Array.isArray(candidates) || candidates.length === 0) return candidates || [];
  var cooldownDays = opts.cooldown_days != null ? opts.cooldown_days : RECENT_SL_HIT_COOLDOWN_DAYS;
  var byTicker = {};
  try {
    var rows = await fetchRecentSlHitRows(date, cooldownDays) || [];
    rows.forEach(function(r) {
      if (!r || !r.ticker) return;
      var t = String(r.ticker).toUpperCase();
      if (!byTicker[t]) byTicker[t] = [];
      byTicker[t].push(r);
    });
  } catch (e) {
    return candidates;
  }
  candidates.forEach(function(c) {
    if (!c || !c.ticker) return;
    var ticker = String(c.ticker).toUpperCase();
    var priorRows = byTicker[ticker];
    if (!priorRows || !priorRows.length) return;
    var match = findSimilarRecentSlHit(c, priorRows, opts);
    if (!match) return;
    var ageDays = daysBetween(match.date, date);
    c.recently_failed_similar_setup = true;
    c.recently_failed_similar_setup_note =
      'Ticker ini SL_HIT pada ' + match.date + ' dengan level entry/SL/TP serupa' +
      (ageDays != null ? ' (' + ageDays + ' hari lalu)' : '') + '. Bukan filter otomatis — silakan pertimbangkan sendiri.';
  });
  return candidates;
}

module.exports = {
  RECENT_SL_HIT_COOLDOWN_DAYS: RECENT_SL_HIT_COOLDOWN_DAYS,
  RECENT_SL_HIT_LEVEL_TOLERANCE_PCT: RECENT_SL_HIT_LEVEL_TOLERANCE_PCT,
  withinTolerance: withinTolerance,
  candidateLevels: candidateLevels,
  findSimilarRecentSlHit: findSimilarRecentSlHit,
  annotateRecentlyFailedSimilarSetups: annotateRecentlyFailedSimilarSetups
};
