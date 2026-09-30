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
  assert.deepEqual(summary.missing_details, [
    {
      ticker: 'CCC',
      history_count: 2,
      latest_trade_date: '2026-09-30',
      repairable_from_local_history: true
    },
    {
      ticker: 'DDD',
      history_count: 0,
      latest_trade_date: null,
      repairable_from_local_history: false
    }
  ]);
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
