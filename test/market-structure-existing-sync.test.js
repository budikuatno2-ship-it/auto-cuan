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

  const out = sync.buildExistingMarketStructureRows(market, hsc, ['AAA','BBB']);

  assert.equal(out.summary.canonical_count, 3);
  assert.equal(out.summary.eligible_count, 2);
  assert.equal(out.summary.free_float_verified_canonical, 3);
  assert.equal(out.summary.free_float_verified_eligible, 2);
  assert.equal(out.summary.hsc_verified_canonical, 2);
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

test('existing dataset adapter accepts canonical active/revoked HSC buckets', () => {
  const market = {
    stocks: [
      { ticker: 'AAA', ownership: { as_of: '2026-08-31', derived_free_float_pct: 21 } },
      { ticker: 'BBB', ownership: { as_of: '2026-08-31', derived_free_float_pct: 18 } },
      { ticker: 'LUCY', ownership: { as_of: '2026-08-31', derived_free_float_pct: 14 } }
    ]
  };
  const hsc = {
    active_count: 2,
    revoked_count: 1,
    active: [
      {
        ticker: 'AAA',
        hsc_2026_status: 'IMPOSED',
        events: [
          { event_type: 'HSC', event_date: '2026-04-10' },
          { event_type: 'HSC', event_date: '2026-09-22' }
        ]
      },
      {
        ticker: 'BBB',
        official_status: 'ACTIVE',
        last_event: { event_date: '2026-08-15' }
      }
    ],
    revoked: [
      {
        ticker: 'LUCY',
        hsc_2026_status: 'REVOKED',
        events: [{ event_type: 'HSC_REVOKED', event_date: '2026-07-02' }]
      }
    ]
  };

  const out = sync.buildExistingMarketStructureRows(market, hsc, ['AAA','BBB','LUCY']);
  const byTicker = new Map(out.rows.map((row) => [row.ticker, row]));

  assert.equal(out.summary.hsc_dataset_count, 3);
  assert.equal(out.summary.hsc_active_in_universe, 2);
  assert.equal(out.summary.hsc_revoked_in_universe, 1);
  assert.equal(byTicker.get('AAA').hsc_flag, true);
  assert.equal(byTicker.get('AAA').hsc_as_of, '2026-09-22');
  assert.equal(byTicker.get('LUCY').hsc_flag, false);
  assert.equal(byTicker.get('LUCY').hsc_as_of, '2026-07-02');
});

test('existing dataset adapter uses snapshot generated_at when canonical HSC rows have no event date', () => {
  const rows = sync.normalizeHscDataset({
    generated_at: '2026-09-30T09:15:00.000Z',
    active: [
      {
        ticker: 'NICK',
        hsc_2026_status: 'IMPOSED',
        ownership_as_of: '2026-08-31',
        derived_free_float_pct: 1.37
      }
    ],
    revoked: [
      {
        ticker: 'LUCY',
        hsc_2026_status: 'REVOKED',
        ownership_as_of: '2026-08-31',
        derived_free_float_pct: 28.97
      }
    ]
  });

  const byTicker = new Map(rows.map((row) => [row.ticker, row]));
  assert.equal(byTicker.get('NICK').official_status, 'ACTIVE');
  assert.equal(byTicker.get('NICK').hsc_as_of, '2026-09-30');
  assert.equal(byTicker.get('LUCY').official_status, 'REVOKED');
  assert.equal(byTicker.get('LUCY').hsc_as_of, '2026-09-30');
});

test('existing dataset adapter normalizes IMPOSED as active HSC state', () => {
  const rows = sync.normalizeHscDataset({
    active: [
      {
        ticker: 'NICK',
        status: 'IMPOSED',
        last_event: { event_date: '2026-09-22' }
      }
    ],
    revoked: []
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].ticker, 'NICK');
  assert.equal(rows[0].official_status, 'ACTIVE');
  assert.equal(rows[0].last_event.event_date, '2026-09-22');
});

test('existing dataset adapter rejects a status that contradicts its HSC bucket', () => {
  assert.throws(() => sync.normalizeHscDataset({
    active: [
      {
        ticker: 'BAD',
        hsc_2026_status: 'REVOKED',
        last_event: { event_date: '2026-09-01' }
      }
    ],
    revoked: []
  }), /tidak cocok dengan bucket/);
});

test('existing dataset adapter rejects unknown raw HSC statuses fail-closed', () => {
  assert.throws(() => sync.normalizeHscDataset({
    active: [
      {
        ticker: 'BAD',
        status: 'SOMETHING_NEW',
        last_event: { event_date: '2026-09-01' }
      }
    ],
    revoked: []
  }), /Status HSC tidak valid/);
});

test('existing dataset adapter reports missing free float without fabricating it', () => {
  const market = {
    stocks: [
      { ticker: 'AAA', ownership: { as_of: '2026-08-31', derived_free_float_pct: 20 } },
      { ticker: 'MISS', ownership: null }
    ]
  };
  const hsc = { active_count: 0, revoked_count: 0, stocks: [] };

  const out = sync.buildExistingMarketStructureRows(market, hsc, ['AAA']);
  assert.deepEqual(out.summary.missing_free_float_canonical, ['MISS']);
  assert.deepEqual(out.summary.missing_free_float_eligible, []);

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


test('canonical market structure includes non-scanner tickers while scanner summary stays eligible-only', () => {
  const market = {
    stocks: [
      { ticker: 'AAA', ownership: { as_of: '2026-08-31', derived_free_float_pct: 25 } },
      { ticker: 'OUT', ownership: { as_of: '2026-08-31', derived_free_float_pct: 30 } }
    ]
  };
  const hsc = {
    generated_at: '2026-09-30T10:00:00.000Z',
    active_count: 1,
    revoked_count: 0,
    active: [{ ticker: 'OUT', hsc_2026_status: 'IMPOSED' }],
    revoked: []
  };

  const out = sync.buildExistingMarketStructureRows(market, hsc, ['AAA']);
  const byTicker = new Map(out.rows.map((row) => [row.ticker, row]));

  assert.equal(out.summary.canonical_count, 2);
  assert.equal(out.summary.eligible_count, 1);
  assert.equal(out.summary.free_float_verified_canonical, 2);
  assert.equal(out.summary.free_float_verified_eligible, 1);
  assert.equal(out.summary.hsc_verified_canonical, 1);
  assert.equal(out.summary.hsc_verified_in_universe, 0);
  assert.deepEqual(out.summary.hsc_outside_universe, ['OUT']);
  assert.equal(byTicker.has('OUT'), true);
  assert.equal(byTicker.get('OUT').free_float_pct, 30);
  assert.equal(byTicker.get('OUT').hsc_flag, true);
});


test('verified MSKY fallback closes canonical free-float gap and carries market cap', () => {
  const market = {
    stocks: [
      { ticker: 'AAA', ownership: { as_of: '2026-08-31', derived_free_float_pct: 20 } },
      { ticker: 'MSKY', ownership: null }
    ]
  };
  const hsc = { active_count: 0, revoked_count: 0, stocks: [] };
  const overrides = {
    rows: [{
      ticker: 'MSKY',
      free_float_pct: 40.5,
      free_float_source: 'IDX Peng-S-00011/BEI.PLP/04-2026',
      free_float_as_of: '2026-03-31',
      market_cap: 145589045040,
      market_cap_source: 'IDX Peng-S-00011/BEI.PLP/04-2026',
      market_cap_as_of: '2026-03-31'
    }]
  };

  const out = sync.buildExistingMarketStructureRows(market, hsc, ['AAA','MSKY'], overrides);
  const byTicker = new Map(out.rows.map((row) => [row.ticker, row]));

  assert.equal(out.summary.free_float_verified_canonical, 2);
  assert.deepEqual(out.summary.missing_free_float_canonical, []);
  assert.equal(byTicker.get('MSKY').free_float_pct, 40.5);
  assert.equal(byTicker.get('MSKY').free_float_source, 'IDX Peng-S-00011/BEI.PLP/04-2026');
  assert.equal(byTicker.get('MSKY').free_float_as_of, '2026-03-31');
  assert.equal(byTicker.get('MSKY').market_cap, 145589045040);
  assert.equal(byTicker.get('MSKY').market_cap_as_of, '2026-03-31');
});
