'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const updater = require('../tools/update-hsc-current-2026');

test('BIKE and MSJA additions enrich from canonical ownership/free-float snapshot', () => {
  const market = {
    stocks: [
      {
        ticker: 'BIKE',
        ownership: {
          as_of: '2026-08-31',
          recorded_ownership_pct: 90,
          derived_free_float_pct: 10,
          investor_count: 2,
          concentration: { top1_pct: 60, top3_pct: 90, top5_pct: 90 },
          investors: [{ investor_name: 'A', percentage: 60 }]
        },
        market: { market_cap: 1000, listed_shares: 100, close: 10 }
      },
      {
        ticker: 'MSJA',
        ownership: {
          as_of: '2026-08-31',
          recorded_ownership_pct: 95,
          derived_free_float_pct: 5,
          investor_count: 3,
          concentration: { top1_pct: 70, top3_pct: 95, top5_pct: 95 },
          investors: [{ investor_name: 'B', percentage: 70 }]
        },
        market: { market_cap: 2000, listed_shares: 200, close: 10 }
      }
    ]
  };

  const hsc = {
    generated_at: '2026-09-30T00:00:00.000Z',
    active_count: 1,
    revoked_count: 1,
    active: [{ ticker: 'NICK', hsc_2026_status: 'IMPOSED' }],
    revoked: [{ ticker: 'LUCY', hsc_2026_status: 'REVOKED' }]
  };

  const out = updater.updateHscPayload(hsc, market);
  const byTicker = new Map(out.payload.active.map((row) => [row.ticker, row]));

  assert.equal(out.payload.active_count, 3);
  assert.equal(out.payload.revoked_count, 1);

  assert.equal(byTicker.get('BIKE').hsc_2026_status, 'IMPOSED');
  assert.equal(byTicker.get('BIKE').hsc_as_of, '2026-10-01');
  assert.equal(byTicker.get('BIKE').official_concentration_pct, 93.08);
  assert.equal(byTicker.get('BIKE').concentration_basis_as_of, '2026-09-28');
  assert.equal(byTicker.get('BIKE').ownership_as_of, '2026-08-31');
  assert.equal(byTicker.get('BIKE').derived_free_float_pct, 10);

  assert.equal(byTicker.get('MSJA').hsc_2026_status, 'IMPOSED');
  assert.equal(byTicker.get('MSJA').official_concentration_pct, 98.62);
  assert.equal(byTicker.get('MSJA').concentration_basis_as_of, '2026-09-25');
  assert.equal(byTicker.get('MSJA').derived_free_float_pct, 5);
});

test('updater fails closed when ownership/free-float detail is missing', () => {
  const hsc = {
    active_count: 0,
    revoked_count: 0,
    active: [],
    revoked: []
  };

  assert.throws(() => updater.updateHscPayload(hsc, {
    stocks: [{ ticker: 'BIKE', ownership: null }, { ticker: 'MSJA', ownership: null }]
  }), /Ownership snapshot tidak tersedia/);
});

test('updater refuses to auto-reactivate a revoked ticker', () => {
  const market = {
    stocks: [{
      ticker: 'BIKE',
      ownership: { as_of: '2026-08-31', derived_free_float_pct: 10 }
    }]
  };

  const hsc = {
    active_count: 0,
    revoked_count: 1,
    active: [],
    revoked: [{ ticker: 'BIKE', hsc_2026_status: 'REVOKED' }]
  };

  assert.throws(() => updater.updateHscPayload(hsc, market, [{
    ticker: 'BIKE',
    hsc_as_of: '2026-10-01',
    official_concentration_pct: 93.08,
    concentration_basis_as_of: '2026-09-28'
  }]), /tidak boleh diaktifkan otomatis/);
});
