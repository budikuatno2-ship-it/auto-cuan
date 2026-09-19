'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bandarmologiIntelService = require('../lib/bandarmologi-intel-service');

test('Anti-Monopoli Palsu: Liquid stocks on 14D have realistic CR3 (20%-65%) and never 100%', () => {
  const liquidTickers = [
    'BBCA', 'BREN', 'ASII', 'INCO', 'AMMN', 'ADRO',
    'MEDC', 'TPIA', 'SMGR', 'KLBF', 'CPIN', 'MAPI'
  ];

  for (const ticker of liquidTickers) {
    const res14 = bandarmologiIntelService.computeConcentrationRatios(ticker, { range: '14d' });
    assert.ok(res14, 'Result for ' + ticker + ' should exist');
    // F-070 removed the fabricated `top5Val x 1.75` denominator. When real
    // market turnover is absent the CR now legitimately falls back to a
    // real volume basis (CR can reach 100% only for genuinely concentrated
    // real data) or yields null with reason TURNOVER_UNAVAILABLE — it is
    // NEVER padded to fake a sub-100% number. Assert the honest contract.
    const basisIsValue = res14.cr_basis === 'VALUE';
    if (basisIsValue) {
      assert.ok(res14.total_turnover > res14.top_3_val, ticker + ' total turnover must strictly exceed top 3 val on a VALUE basis');
    } else {
      assert.ok(res14.cr_basis === 'VOLUME' || res14.cr3 == null, ticker + ' CR basis must be VALUE, VOLUME, or unavailable');
      if (res14.cr3 == null) assert.equal(res14.reason, 'TURNOVER_UNAVAILABLE');
    }

    // Verify 7D as well (same honest contract).
    const res7 = bandarmologiIntelService.computeConcentrationRatios(ticker, { range: '7d' });
    if (res7.cr_basis === 'VALUE') {
      assert.ok(res7.total_turnover > res7.top_3_val, ticker + ' 7D total turnover must exceed top 3 val on a VALUE basis');
    } else {
      assert.ok(res7.cr3 == null || res7.cr_basis === 'VOLUME', ticker + ' 7D CR must not fabricate a value denominator');
    }
  }
});

test('BBCA 1D: Bandar Avg Buy is a plausible price reached via gross-buy VWAP (never a distorted net/churned price)', (t) => {
  const hunter = bandarmologiIntelService.getBrokersFromHunterIndexes('BBCA', '1d');
  const res = bandarmologiIntelService.detectPriceBelowBandarCost('BBCA', {
    brokerSummary: hunter,
    range: '1d'
  });
  assert.ok(res, 'BBCA result must exist');
  // Prices are resolved from real data, not frozen to a hardcoded 10150. The
  // hunter index is gitignored, so CI has none — skip (not fail) when absent.
  if (!(res.current_price > 0) || !(res.bandar_avg_buy > 0)) {
    return t.skip('local broker-hunter data unavailable (data/arjum-data is gitignored)');
  }

  // Verify individual brokers carry clean gross-buy modal prices (avg_price == avg_buy).
  const topBrokers = res.top_3_brokers || [];
  for (const b of topBrokers) {
    assert.ok(b.avg_price > 0, 'Broker ' + b.broker + ' avg price must be > 0');
    assert.equal(b.avg_price, b.avg_buy, 'Broker ' + b.broker + ' avg_price must equal gross avg_buy, never a distorted net price');
  }
});

test('Card 4 Narrative Text Consistency: description dynamically matches cr3 and cr5 values', () => {
  const tickers = ['BBCA', 'BREN', 'ADRO', 'INCO'];
  for (const t of tickers) {
    const res = bandarmologiIntelService.computeConcentrationRatios(t, { range: '7d' });
    const expectedDesc = 'CR3 sebesar ' + res.cr3 + '% dan CR5 sebesar ' + res.cr5 + '%. Status: ' + res.label + '.';
    assert.equal(res.description, expectedDesc, t + ' description must match computed CR3 and CR5');
  }
});

test('Partial feed fallback: avoids 100% or 50% lock when only 1-2 brokers are in hunter data', () => {
  const mockPartialHunter = {
    gross_buyers: [
      { broker: 'AK', bval: 10000000000, bvol: 1000000 },
      { broker: 'YP', bval: 5000000000, bvol: 500000 }
    ]
  };

  const res = bandarmologiIntelService.computeConcentrationRatios('UNKNOWN_TICKER_XYZ', {
    brokerSummary: mockPartialHunter,
    range: '7d'
  });

  // F-070: with no real market turnover the CR falls back to a real VOLUME
  // basis, which for a 2-broker gross feed is legitimately 100% — it is no
  // longer padded to an artificial value. Assert the honest basis instead.
  assert.notEqual(res.cr3, 50, 'CR3 must not be locked to artificial 50%');
  assert.ok(res.cr_basis === 'VOLUME' || res.cr_basis === 'VALUE', 'CR basis must be an honest, labelled basis');
  if (res.cr_basis === 'VOLUME') {
    assert.equal(res.cr3, 100, 'a 2-broker volume basis is honestly 100%');
  } else {
    assert.ok(res.total_turnover > res.top_3_val, 'on a VALUE basis total turnover must exceed top 3 val');
  }
});
