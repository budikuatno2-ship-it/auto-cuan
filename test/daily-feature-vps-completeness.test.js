'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const audit = require('../tools/audit-daily-feature-vps-completeness');

test('daily feature coverage separates repairable missing rows from true no-history rows', () => {
  const summary = audit.summarizeFeatureCoverage(
    ['AAA', 'BBB', 'CCC', 'DDD'],
    [
      { ticker: 'AAA', as_of_trade_date: '2026-09-30' },
      { ticker: 'BBB', as_of_trade_date: '2026-09-30' }
    ],
    [
      { ticker: 'CCC', trade_date: '2026-09-29' },
      { ticker: 'CCC', trade_date: '2026-09-30' }
    ]
  );

  assert.equal(summary.eligible_count, 4);
  assert.equal(summary.feature_count_in_eligible, 2);
  assert.equal(summary.missing_count, 2);
  assert.deepEqual(summary.missing_tickers, ['CCC', 'DDD']);
  assert.equal(summary.repairable_count, 1);
  assert.equal(summary.no_history_count, 1);
  assert.equal(summary.missing_details[0].ticker, 'CCC');
  assert.equal(summary.missing_details[0].history_count, 2);
  assert.equal(summary.missing_details[0].repairable_from_local_history, true);
  assert.equal(summary.missing_details[1].ticker, 'DDD');
  assert.equal(summary.missing_details[1].history_count, 0);
  assert.equal(summary.missing_details[1].repairable_from_local_history, false);
});

test('daily feature coverage ignores non-eligible feature/history rows', () => {
  const summary = audit.summarizeFeatureCoverage(
    ['AAA', 'BBB'],
    [{ ticker: 'AAA' }, { ticker: 'OUTSIDE' }],
    [{ ticker: 'OUTSIDE', trade_date: '2026-09-30' }]
  );

  assert.equal(summary.feature_count_in_eligible, 1);
  assert.deepEqual(summary.missing_tickers, ['BBB']);
  assert.equal(summary.repairable_count, 0);
  assert.equal(summary.no_history_count, 1);
});


test('archive rehydrate candidate requires fresh positive-volume proof and price variation', () => {
  const base = {
    repairable_from_canonical_archive: true,
    archive_latest_date: '2026-09-29',
    archive_last_positive_volume_date: '2026-09-29',
    archive_zero_volume_tail: 0,
    archive_positive_volume_last20: 4,
    archive_distinct_close_last20: 4
  };
  assert.equal(audit.isArchiveRehydrateCandidate(base), true);
  assert.equal(audit.isArchiveRehydrateCandidate(Object.assign({}, base, {
    archive_last_positive_volume_date: '2026-09-01'
  })), false);
  assert.equal(audit.isArchiveRehydrateCandidate(Object.assign({}, base, {
    archive_positive_volume_last20: 0
  })), false);
  assert.equal(audit.isArchiveRehydrateCandidate(Object.assign({}, base, {
    archive_distinct_close_last20: 1
  })), false);
});

test('coverage reports feature rows outside eligible without deleting them', () => {
  const summary = audit.summarizeFeatureCoverage(
    ['AAA'],
    [{ ticker: 'AAA' }, { ticker: 'OLD' }],
    [],
    new Map()
  );
  assert.equal(summary.total_feature_rows, 2);
  assert.deepEqual(summary.feature_rows_outside_eligible, ['OLD']);
  assert.equal(summary.feature_count_in_eligible, 1);
});
