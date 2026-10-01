'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sectorHot = require('../api/sector-hot');
const sectorHotTest = sectorHot.__test || sectorHot;

test('Finding #1: handleNkScreenerFinalize uses atomic upsert and post-upsert stale cleanup', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'sector-hot.js'), 'utf8');
  const nkFinalizeStart = source.indexOf('async function handleNkScreenerFinalize');
  const nkFinalizeEnd = source.indexOf('async function handleNkScreenerBatch', nkFinalizeStart);
  const nkBlock = source.slice(nkFinalizeStart, nkFinalizeEnd);

  // Must not have unqualified delete before upsert
  assert.equal(nkBlock.includes(".delete().neq('ticker', '')"), false, 'Must not delete all rows before upsert');
  assert.match(nkBlock, /from\('swing_screener_non_konglo_latest'\)\.upsert\(publishRows,\s*\{\s*onConflict:\s*'ticker'\s*\}\)/, 'Must upsert onConflict ticker');
  assert.match(nkBlock, /from\('swing_screener_non_konglo_latest'\)\.delete\(\)\.in\('ticker',\s*staleTickers\)/, 'Must prune stale tickers after upsert');
});

test('Finding #2: handleTelegramMonitorPicks uses resolveMonitorSource for source resolution', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'sector-hot.js'), 'utf8');
  const monStart = source.indexOf('async function handleTelegramMonitorPicks');
  const monEnd = source.indexOf('async function handleTelegramMonitorDryRun', monStart);
  const monBlock = source.slice(monStart, monEnd);

  assert.match(monBlock, /var src = resolveMonitorSource\(pck\) \|\| '';/, 'Must use resolveMonitorSource to check physical column monitor_source');
});

test('Finding #3: applyFallbackFibConfluence returns well-formed fallback when support/resistance are missing', () => {
  const rowNoSupport = {
    ticker: 'TEST',
    last_price: 1000,
    entry_low: 950,
    entry_high: 980,
    support: null,
    resistance: null
  };

  const result = sectorHotTest.applyFallbackFibConfluence(rowNoSupport);
  assert.equal(result.fib_confluence_status, 'insufficient_data');
  assert.equal(result.fib_confluence_label, 'Fib belum cukup data');
  assert.ok(result.fib_confluence_note.includes('belum cukup'));
  assert.equal(result.fib_levels, null);
});

test('Finding #3: applyFallbackFibConfluence computes healthy zone when support/resistance are valid', () => {
  const rowWithSupport = {
    ticker: 'TEST2',
    last_price: 1000,
    entry_low: 950,
    entry_high: 970,
    support: 900,
    resistance: 1100
  };

  const result = sectorHotTest.applyFallbackFibConfluence(rowWithSupport);
  assert.ok(result.fib_confluence_status, 'Must have a non-null fib confluence status');
  assert.ok(result.fib_confluence_label, 'Must have a non-null fib confluence label');
  assert.ok(result.fib_levels, 'Must populate fib_levels');
  assert.ok(result.fib_levels.fib_382 != null);
  assert.ok(result.fib_levels.fib_500 != null);
  assert.ok(result.fib_levels.fib_618 != null);
});
