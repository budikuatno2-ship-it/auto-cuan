'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const universe = require('../lib/daytrade-full-eligible-universe');

test('full eligible Day Trade universe uses official boards and deterministic eligibility exclusions', () => {
  const boardRows = Array.from({ length: 772 }, (_, i) => ({ ticker: `U${String(i).padStart(4, '0')}`, board: i % 2 ? 'UTAMA' : 'PENGEMBANGAN' }));
  boardRows.push({ ticker: 'ACCEL', board: 'AKSELERASI' }, { ticker: 'ECON', board: 'EKONOMI BARU' }, { ticker: 'CHEAP', board: 'UTAMA', last_price: 49 }, { ticker: 'FCA', board: 'UTAMA', status: 'FCA' });
  const result = universe.buildFullEligibleUniverse(boardRows, [{ ticker: 'FOREIGN', board: null, last_price: 100 }]);
  assert.equal(result.source, 'full_daytrade_eligible_universe');
  assert.equal(result.tickers.length, 772);
  assert.equal(result.diagnostics.excluded_by_reason.invalid_or_unknown_board, 3);
  assert.equal(result.diagnostics.excluded_by_reason.price_below_50, 1);
  assert.equal(result.diagnostics.excluded_by_reason.restricted_board_or_status, 1);
});

test('observe reports full loaded coverage separately from published candidate count', async () => {
  const observe = require('../lib/daytrade-intraday-observe');
  const report = await observe.runObserve({
    fullUniverseRows: [{ ticker: 'UTAM', board: 'UTAMA' }, { ticker: 'PENG', board: 'PENGEMBANGAN' }],
    candidateRows: [{ ticker: 'UTAM' }],
    noFetch: true,
    cacheDir: '/tmp/auto-cuan-nonexistent-intraday-cache',
    nowMs: Date.UTC(2026, 0, 1)
  });
  assert.equal(report.coverage.universe_source, 'full_daytrade_eligible_universe');
  assert.equal(report.coverage.universe_count, 2);
  assert.equal(report.coverage.evaluated_universe_count, 2);
  assert.equal(report.coverage.provider_checked_count, 2);
  assert.equal(report.coverage.candidate_count, 1);
  assert.equal(report.coverage.requested_limit, 2);
});
