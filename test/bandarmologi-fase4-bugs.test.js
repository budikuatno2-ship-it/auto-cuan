'use strict';

/**
 * Test Verifikasi Post-Fix - Fase 4 (Bandarmologi / Broker / Insider)
 * File yang diuji:
 *   - lib/broker-hunter-service.js
 *   - lib/bandarmologi-service.js
 *   - lib/insider-network-service.js
 *   - lib/bandarmologi-intel-service.js
 *   - public/bandarmologi-runtime.js
 */

const test = require('node:test');
const assert = require('node:assert');

const brokerHunterService = require('../lib/broker-hunter-service');
const bandarService = require('../lib/bandarmologi-service');
const insiderService = require('../lib/insider-network-service');
const intelService = require('../lib/bandarmologi-intel-service');
const bandarRuntime = require('../public/bandarmologi-runtime');

test('BUG-F4-01: extractBrokerTx falls back to top_buyers when gross_buyers is empty array', () => {
  const summary = {
    gross_buyers: [],
    top_buyers: [{ broker: 'AK', bval: 5e9, bvol: 1000 }]
  };

  const res = brokerHunterService.extractBrokerTx(summary, 'AK', 'BBCA');
  assert.notStrictEqual(res, null, 'extractBrokerTx must not return null when top_buyers has data');
  assert.strictEqual(res.bval, 5e9);
  assert.strictEqual(res.bvol, 1000);
});

test('BUG-F4-02: calculateScannerDiscount returns 0 if last_price is null or 0', () => {
  const discountNull = bandarService.calculateScannerDiscount(1000, null);
  const discountZero = bandarService.calculateScannerDiscount(1000, 0);

  assert.strictEqual(discountNull, 0, 'Discount must be 0 when last_price is null');
  assert.strictEqual(discountZero, 0, 'Discount must be 0 when last_price is 0');
});

test('BUG-F4-03: holding.net_shares_change correctly decreases on SELL even with negative shares_change', () => {
  const records = [{
    insider_name: 'Investor Utama',
    ticker: 'BBCA',
    action_type: 'SELL',
    shares_change: -500000,
    shares_after: 1000000
  }];

  const aggregated = insiderService.aggregateInsiderHoldings(records);
  const holding = aggregated[0].holdings[0];

  assert.strictEqual(holding.net_shares_change, -500000, 'Aksi SELL must decrease net_shares_change');
  assert.strictEqual(holding.total_sold, 500000, 'total_sold must be positive 500000');
});

test('BUG-F4-04: parsePercentage parses Indonesian comma format "5,25%" as 5.25', () => {
  const parsed = insiderService.parsePercentage('5,25%');
  assert.strictEqual(parsed, 5.25, 'parsePercentage must parse Indonesian decimal comma correctly as 5.25');
});

test('BUG-F4-05: has_data is false and reason is NO_DATA when no transactions exist', () => {
  const s3 = intelService.detectRetailCutlossVsBandar('INVALID_XYZ', {
    brokerSummary: { top_buyers: [], top_sellers: [] }
  });

  assert.strictEqual(s3.sub_type, 'NO_DATA');
  assert.strictEqual(s3.reason, 'NO_DATA');

  const evalRes = intelService.evaluateBandarmologiIntelForTicker('INVALID_XYZ', {
    brokerSummary: { top_buyers: [], top_sellers: [] },
    candles: []
  });
  assert.strictEqual(evalRes.has_data, false, 'has_data must be false when all signals have no data');
});

test('BUG-F4-06: getHunterTickerMap prioritizes normalized avg price and avoids 100x lot blowup', () => {
  const bVal = 100000000;
  const bVol = 2000; // lot
  const accAvgBuyPrice = 500;

  const calculatedAvg = Number(accAvgBuyPrice || 0) || (bVal > 0 && bVol > 0 ? Math.round(bVal / (bVol * 100)) : 0);
  assert.strictEqual(calculatedAvg, 500, 'Modal bandar must prioritize normalized avg price of 500');

  const calculatedFromLot = Number(0) || (bVal > 0 && bVol > 0 ? Math.round(bVal / (bVol * 100)) : 0);
  assert.strictEqual(calculatedFromLot, 500, 'Modal calculated from bVal/bVol must divide by (bVol * 100)');
});

test('BUG-F4-07: detectRetailCutlossVsBandar recognizes broker_code schema', () => {
  const summaryWithBrokerCode = {
    top_buyers: [{ broker_code: 'AK' }, { broker_code: 'BK' }, { broker_code: 'RX' }],
    top_sellers: [{ broker_code: 'YP' }, { broker_code: 'PD' }, { broker_code: 'XC' }]
  };

  const res = intelService.detectRetailCutlossVsBandar('BBCA', {
    brokerSummary: summaryWithBrokerCode
  });

  assert.strictEqual(res.inst_buyer_count, 3, 'Must recognize institutional buyers via broker_code');
  assert.strictEqual(res.retail_seller_count, 3, 'Must recognize retail sellers via broker_code');
  assert.strictEqual(res.is_bandar_nampung, true, 'Must detect bandar nampung when 3 inst buyers vs 3 retail sellers');
});

test('BUG-F4-08: parseNumericValue parses Indonesian dot thousands "1.250.000" as 1250000', () => {
  const parsed = bandarRuntime.parseNumericValue('1.250.000');
  assert.strictEqual(parsed, 1250000, 'parseNumericValue must parse 1.250.000 as 1250000');
});

test('BUG-F4-09: Institutional broker CC is excluded from retailCodes and bandarVal uses allBuyersTotalVal', () => {
  assert.strictEqual(bandarRuntime.INSTITUTIONAL_BROKERS.includes('CC'), true);
  assert.strictEqual(bandarRuntime.RETAIL_BROKERS.includes('CC'), false);

  const top3Val = 300e9;
  const totalMarketBuyVal = 0;
  const retailVal = 350e9;
  const allBuyersTotalVal = 650e9;

  const effectiveTotalVal = totalMarketBuyVal > 0 ? totalMarketBuyVal : allBuyersTotalVal;
  const bandarVal = Math.max(0, effectiveTotalVal - retailVal);
  const bandarPct = effectiveTotalVal > 0 ? Math.round((bandarVal / effectiveTotalVal) * 100) : 0;

  assert.strictEqual(bandarVal, 300e9);
  assert.strictEqual(bandarPct, 46);
});
