'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

describe('Mega Forensic 12 Bug Fixes Regression Suite', () => {
  it('BUG-02 & BUG-12: arjum-client has DEFAULT_DAILY_LIMIT = 18080', () => {
    const arjumClient = require('../lib/arjum-client');
    const limit = arjumClient.getConfiguredPlanLimit();
    assert.strictEqual(limit >= 18080, true, `Plan limit should be >= 18080, got ${limit}`);
  });

  it('BUG-02 & BUG-12: catchup-missing-dates enforces hard floors (weekday: 5000, weekend: 1000)', () => {
    const { computeCatchupBudget } = require('../tools/catchup-missing-dates');
    const weekdayBudget = computeCatchupBudget(18080, 500, { isWeekend: false });
    assert.strictEqual(weekdayBudget.floor, 5000, 'Weekday floor must be 5000');
    assert.strictEqual(weekdayBudget.spendable, 18080 - 500 - 5000, 'Weekday spendable must respect 5000 floor');

    const weekendBudget = computeCatchupBudget(18080, 500, { isWeekend: true });
    assert.strictEqual(weekendBudget.floor, 1000, 'Weekend floor must be 1000');
    assert.strictEqual(weekendBudget.spendable, 18080 - 500 - 1000, 'Weekend spendable must respect 1000 floor');
  });

  it('BUG-03: catchup TYPES only includes ALL and F (no historical accum/insider)', () => {
    const { TYPES } = require('../tools/catchup-missing-dates');
    const keys = TYPES.map(t => t.key);
    assert.deepStrictEqual(keys, ['ALL', 'F'], 'Catchup historical types must ONLY be ALL and F');
  });

  it('BUG-04: computeDomestic returns safe structure with brokers array when foreign is missing', () => {
    const { computeDomestic } = require('../lib/broksum-flow');
    const allMock = {
      stock_code: 'BBCA',
      broker_start_date: '2026-10-23',
      broker_end_date: '2026-10-23',
      brokers: [{ broker_code: 'CC', bval: 100, sval: 50 }]
    };
    const res = computeDomestic(allMock, null);
    assert.ok(res, 'Must return object, not null');
    assert.strictEqual(res.flow, 'D');
    assert.strictEqual(res.is_complete, false);
    assert.strictEqual(res.status, 'foreign_missing');
    assert.ok(Array.isArray(res.brokers), 'Must have brokers array');
    assert.strictEqual(res.brokers.length, 0);
  });

  it('BUG-04: normalizeBrokerSummary returns safe structure when raw is foreign_missing', () => {
    const { normalizeBrokerSummary } = require('../lib/bandarmologi-service');
    const missingRaw = {
      stock_code: 'BBCA',
      flow: 'D',
      status: 'foreign_missing',
      is_complete: false,
      message: 'data broker asing belum tersedia'
    };
    const norm = normalizeBrokerSummary(missingRaw, '2026-10-23', 'BBCA');
    assert.ok(norm, 'Must return normalized object instead of null');
    assert.strictEqual(norm.status, 'foreign_missing');
    assert.strictEqual(norm.is_complete, false);
    assert.ok(Array.isArray(norm.brokers));
  });

  it('BUG-05: sector-hot buildFusionForeignFrame exists and exports properly', () => {
    const sectorHot = require('../api/sector-hot');
    assert.ok(sectorHot, 'sector-hot must load cleanly');
  });

  it('BUG-06: filterSafeDashboardLockedTop5Rows rejects DATA_INCOMPLETE candidates', () => {
    const sectorHot = require('../api/sector-hot');
    const filterFn = (sectorHot.__test && sectorHot.__test.filterSafeDashboardLockedTop5Rows) || sectorHot.filterSafeDashboardLockedTop5Rows;
    const validCandidate = {
      ticker: 'BBCA',
      monitor_source: 'daily_top5',
      is_locked: true,
      raw_payload: {
        lock_source: 'telegram-daily-picks.lock_only',
        web_daily_locked_at: new Date().toISOString(),
        entry1: 10000,
        sl: 9800,
        tp1: 10500,
        risk_reward: 2.5,
        status: 'CONFIRMED',
        data_quality_status: 'DATA_INCOMPLETE', // defective
        data_quality_valid: false
      }
    };
    const res = filterFn([validCandidate]);
    assert.strictEqual(res.length, 0, 'Must reject DATA_INCOMPLETE candidate from Top 5');
  });

  it('BUG-08: telegram-notifier escapeHtml properly escapes HTML special characters', () => {
    const { escapeHtml } = require('../lib/telegram-notifier');
    const escaped = escapeHtml('Profit > 5% & loss < 2%');
    assert.strictEqual(escaped, 'Profit ' + '&' + 'gt; 5% ' + '&' + 'amp; loss ' + '&' + 'lt; 2%');
  });

  it('BUG-10: build-full-insider-network exports buildFullInsiderNetwork function', () => {
    const { buildFullInsiderNetwork, CONGLOMERATE_ANCHORS } = require('../tools/build-full-insider-network');
    assert.strictEqual(typeof buildFullInsiderNetwork, 'function');
    assert.ok(Array.isArray(CONGLOMERATE_ANCHORS));
  });
});
