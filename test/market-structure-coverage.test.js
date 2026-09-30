'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const coverage = require('../lib/market-structure-coverage');

test('coverage report distinguishes verified, caution, normal, and unknown rows', () => {
  const report = coverage.buildCoverageReport(
    ['AAA','BBB','CCC','DDD'],
    [
      {
        ticker: 'AAA',
        free_float_pct: 22,
        free_float_source: 'idx_master',
        free_float_as_of: '2026-09-30',
        hsc_flag: false,
        hsc_source: 'idx_hsc',
        hsc_as_of: '2026-09-30'
      },
      {
        ticker: 'BBB',
        free_float_pct: 12,
        free_float_source: 'idx_master',
        free_float_as_of: '2026-09-30',
        hsc_flag: false,
        hsc_source: 'idx_hsc',
        hsc_as_of: '2026-09-30'
      },
      {
        ticker: 'CCC',
        hsc_flag: true,
        hsc_source: 'idx_hsc',
        hsc_as_of: '2026-09-30'
      }
    ],
    { expectedUniverse: 4, generatedAt: '2026-09-30T12:00:00.000Z' }
  );

  assert.equal(report.universe.contract_ok, true);
  assert.equal(report.coverage.free_float_verified, 2);
  assert.equal(report.coverage.hsc_verified, 3);
  assert.equal(report.coverage.both_verified, 2);
  assert.equal(report.coverage.missing_both, 1);
  assert.equal(report.risk_context.below_idx_min_free_float, 1);
  assert.equal(report.risk_context.hsc_flagged, 1);
  assert.equal(report.risk_context.normal, 1);
  assert.equal(report.risk_context.caution, 2);
  assert.equal(report.risk_context.unknown, 1);
  assert.deepEqual(report.missing.both, ['DDD']);
  assert.deepEqual(report.caution_tickers, ['BBB','CCC']);
  assert.equal(report.provenance.free_float_sources.idx_master, 2);
  assert.equal(report.provenance.hsc_sources.idx_hsc, 3);
});

test('coverage report never treats missing provenance as verified', () => {
  const report = coverage.buildCoverageReport(
    ['AAA'],
    [{ ticker: 'AAA', free_float_pct: 30, hsc_flag: false }],
    { expectedUniverse: 1 }
  );

  assert.equal(report.coverage.free_float_verified, 0);
  assert.equal(report.coverage.hsc_verified, 0);
  assert.equal(report.coverage.missing_both, 1);
  assert.equal(report.risk_context.unknown, 1);
});

test('coverage report deduplicates and normalizes universe tickers', () => {
  const report = coverage.buildCoverageReport(
    ['bbca', 'BBCA.JK', 'BBRI'],
    [],
    { expectedUniverse: 2 }
  );

  assert.equal(report.universe.actual, 2);
  assert.equal(report.universe.contract_ok, true);
  assert.deepEqual(report.missing.both, ['BBCA','BBRI']);
});
