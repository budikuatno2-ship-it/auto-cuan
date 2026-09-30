'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sync = require('../lib/market-structure-existing-sync');

test('existing dataset adapter maps free float and HSC statuses conservatively', () => {
  const market = {
    stocks: [
      {
        ticker: 'AAA',
        ownership: { as_of: '2026-08-31', derived_free_float_pct: 22.5 }
      },
      {
        ticker: 'BBB',
        ownership: { as_of: '2026-08-31', derived_free_float_pct: 12.25 }
      },
      {
        ticker: 'CCC',
        ownership: { as_of: '2026-08-31', derived_free_float_pct: 33 }
      }
    ]
  };
  const hsc = {
    active_count: 1,
    revoked_count: 1,
    stocks: [
      {
        ticker: 'AAA',
        official_status: 'ACTIVE',
        last_event: { event_date: '2026-09-22' }
      },
      {
        ticker: 'BBB',
        official_status: 'REVOKED',
        last_event: { event_date: '2026-07-02' }
      }
    ]
  };

  const out = sync.buildExistingMarketStructureRows(market, hsc, ['AAA','BBB','CCC']);

  assert.equal(out.summary.free_float_verified, 3);
  assert.equal(out.summary.hsc_verified_in_universe, 2);
  assert.equal(out.summary.hsc_active_in_universe, 1);
  assert.equal(out.summary.hsc_revoked_in_universe, 1);

  const byTicker = new Map(out.rows.map((row) => [row.ticker, row]));
  assert.equal(byTicker.get('AAA').free_float_pct, 22.5);
  assert.equal(byTicker.get('AAA').hsc_flag, true);
  assert.equal(byTicker.get('AAA').hsc_source, 'IDX HSC 2026');

  assert.equal(byTicker.get('BBB').hsc_flag, false);
  assert.equal(byTicker.get('BBB').hsc_as_of, '2026-07-02');

  assert.equal(byTicker.get('CCC').free_float_pct, 33);
  assert.equal(byTicker.get('CCC').hsc_flag, null);
  assert.equal(byTicker.get('CCC').hsc_source, null);
});

test('existing dataset adapter reports missing free float without fabricating it', () => {
  const market = {
    stocks: [
      { ticker: 'AAA', ownership: { as_of: '2026-08-31', derived_free_float_pct: 20 } },
      { ticker: 'MISS', ownership: null }
    ]
  };
  const hsc = { active_count: 0, revoked_count: 0, stocks: [] };

  const out = sync.buildExistingMarketStructureRows(market, hsc, ['AAA','MISS']);
  assert.deepEqual(out.summary.missing_free_float, ['MISS']);

  const byTicker = new Map(out.rows.map((row) => [row.ticker, row]));
  assert.equal(byTicker.has('MISS'), false);
});

test('existing dataset adapter validates HSC declared counts', () => {
  assert.throws(() => sync.buildExistingMarketStructureRows(
    { stocks: [{ ticker: 'AAA', ownership: { as_of: '2026-08-31', derived_free_float_pct: 20 } }] },
    {
      active_count: 2,
      revoked_count: 0,
      stocks: [
        { ticker: 'AAA', official_status: 'ACTIVE', last_event: { event_date: '2026-09-22' } }
      ]
    },
    ['AAA']
  ), /active_count tidak cocok/);
});
