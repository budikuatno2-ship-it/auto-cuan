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
    assert.notEqual(res14.cr3, 100, ticker + ' 14D CR3 must NEVER be 100% false monopoly');
    assert.notEqual(res14.cr5, 100, ticker + ' 14D CR5 must NEVER be 100% false monopoly');
    assert.ok(res14.cr3 > 0 && res14.cr3 <= 70, ticker + ' 14D CR3 (' + res14.cr3 + '%) should be in realistic range (0%-70%)');
    assert.ok(res14.total_turnover > res14.top_3_val, ticker + ' total turnover must strictly exceed top 3 val');
    assert.ok(res14.cr3 < 90, ticker + ' CR3 must not indicate full artificial monopoly');

    // Verify 7D as well
    const res7 = bandarmologiIntelService.computeConcentrationRatios(ticker, { range: '7d' });
    assert.notEqual(res7.cr3, 100, ticker + ' 7D CR3 must NEVER be 100% false monopoly');
    assert.ok(res7.total_turnover > res7.top_3_val, ticker + ' 7D total turnover must exceed top 3 val');
  }
});

test('BBCA 1D: Bandar Avg Buy is around reference price Rp 10.150 - 10.250 (never dragged down to 8.345 by stale 6.700)', () => {
  const hunter = bandarmologiIntelService.getBrokersFromHunterIndexes('BBCA', '1d');
  const res = bandarmologiIntelService.detectPriceBelowBandarCost('BBCA', {
    brokerSummary: hunter,
    range: '1d'
  });
  assert.ok(res, 'BBCA result must exist');

  assert.equal(res.current_price, 10150, 'BBCA current price must be 10150');
  assert.ok(res.bandar_avg_buy >= 9800 && res.bandar_avg_buy <= 10500, 'BBCA Bandar Avg Buy (' + res.bandar_avg_buy + ') must be realistic (9800-10500), not 8345 or 6700');

  // Verify individual brokers
  const topBrokers = res.top_3_brokers || [];
  for (const b of topBrokers) {
    assert.ok(b.avg_price >= 9800 && b.avg_price <= 10500, 'Broker ' + b.broker + ' avg price (' + b.avg_price + ') must be aligned around 10150-10250, never 6700');
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

  assert.notEqual(res.cr3, 100, 'CR3 must not be 100% when only 2 brokers are present');
  assert.notEqual(res.cr3, 50, 'CR3 must not be locked to artificial 50%');
  assert.ok(res.cr3 > 0 && res.cr3 < 60, 'CR3 (' + res.cr3 + '%) should be realistic');
  assert.ok(res.total_turnover > res.top_3_val, 'Total turnover must exceed top 3 val');
});
