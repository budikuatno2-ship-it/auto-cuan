'use strict';

// Regression coverage for a confirmed dead-code scoring bug in the Day Trade
// Telegram "actionable" shortlist builder (api/sector-hot.js, inside
// sendDayTradeTelegramNotification): a "Step 4: Sort by priority then score"
// comparator (status-tier priority, then telegram_conviction_score/
// daytrade_score) ran first, but its result was immediately discarded by a
// SECOND `actionable.sort(...)` call on the very next line using an entirely
// different comparator (rankCandidatesByPotential). Array.prototype.sort
// only reflects the LAST sort applied to an array, so the priority-tier
// ordering never had any effect on the real published Telegram digest —
// pure wasted computation plus a maintenance trap (editing the dead
// comparator silently changes nothing).
//
// rankCandidatesByPotential + ticker tiebreak is the codebase's established,
// widely-used (10+ call sites) canonical final-list ordering, so it was
// already the one determining live behavior at this exact call site — the
// fix removes only the dead first sort, changing zero live behavior.
//
// This file (api/sector-hot.js) is not unit-testable in isolation (huge
// handler, nothing exported for this code path) — following this repo's
// established pattern for such files (see test/ranking-page-scroll.test.js),
// these assertions run directly against the shipped source text.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const SOURCE_PATH = path.join(__dirname, '..', 'api', 'sector-hot.js');
const source = fs.readFileSync(SOURCE_PATH, 'utf8');

function extractRegion(marker, endMarker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, 'expected to find ' + JSON.stringify(marker));
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, 'expected to find end marker ' + JSON.stringify(endMarker) + ' after ' + JSON.stringify(marker));
  return source.slice(start, end);
}

test('REGRESSION: the Day Trade Telegram actionable shortlist has exactly ONE sort, not a dead-then-live double sort', () => {
  const region = extractRegion('Step 4: Sort by', 'var finalList = actionable.slice(0, 5);');

  const sortCallCount = (region.match(/actionable\.sort\(/g) || []).length;
  assert.equal(sortCallCount, 1, 'expected exactly one actionable.sort() call between "Step 4" and the slice(0,5) — found ' + sortCallCount +
    '; a second sort silently discards the first one\'s ordering (Array.prototype.sort only reflects the LAST sort applied)');
});

test('the surviving sort uses rankCandidatesByPotential, the codebase-wide canonical final-list ranking function', () => {
  const region = extractRegion('Step 4: Sort by', 'var finalList = actionable.slice(0, 5);');
  assert.match(region, /actionable\.sort\(function\(a,\s*b\)\s*\{\s*return rankCandidatesByPotential\(b\)\s*-\s*rankCandidatesByPotential\(a\)/);
});

test('the dead priority-tier-then-score comparator is gone from the actionable sort region', () => {
  const region = extractRegion('Step 4: Sort by', 'var finalList = actionable.slice(0, 5);');
  // The old dead comparator referenced setupPriority[a.status]/[b.status]
  // INSIDE a .sort() callback specifically — setupPriority itself is still
  // legitimately used earlier (Step 2's actionable filter), so this checks
  // the sort region only, not the whole file.
  assert.doesNotMatch(region, /setupPriority\[a\.status\]/);
  assert.doesNotMatch(region, /telegram_conviction_score \|\| 0\) - \(a\.telegram_conviction_score/);
});

test('rankCandidatesByPotential itself is untouched by this fix (dead-code removal only, no scoring-formula change)', () => {
  const fnBody = extractRegion('function rankCandidatesByPotential(candidate) {', 'function normalizeCombinedCandidate(');
  assert.match(fnBody, /upside \|\| 0\)\s*\*\s*100/);
  assert.match(fnBody, /rr \* 25/);
});
