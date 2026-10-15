'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../lib/market-intelligence-engine');

test('Market Intelligence: 8 official screener presets defined with full contract', () => {
  assert.equal(engine.SCREENER_PRESETS.length, 8);

  const officialIds = [
    'bullish_lpm_divergence',
    'intensity_spike',
    'oversold_reversal_watch',
    'money_flow_accumulation',
    'volume_rotation_heating_up',
    'smart_money_technical',
    'foreign_accumulation',
    'technical_breakout'
  ];

  officialIds.forEach(id => {
    const p = engine.SCREENER_PRESETS.find(item => item.id === id || item.alias === id);
    assert.ok(p, `Preset ${id} must exist`);
    assert.ok(p.name, `Preset ${id} must have a name`);
    assert.ok(p.category, `Preset ${id} must have a category`);
    assert.ok(p.timeframe, `Preset ${id} must have a timeframe`);
    assert.ok(p.formula, `Preset ${id} must have a formula`);
    assert.ok(p.riskGate, `Preset ${id} must have a riskGate definition`);
    assert.ok(!p.description.includes('—'), `Preset ${id} must not contain em-dashes`);
  });

  const presetsWithCounts = engine.getScreenerPresetsWithCounts();
  assert.equal(presetsWithCounts.length, 8);
  presetsWithCounts.forEach(p => {
    assert.ok(typeof p.count === 'number' && p.count >= 0, `Preset ${p.id} must have non-negative count`);
    assert.ok(p.nameWithCount.includes(`(${p.count})`), `Preset ${p.id} nameWithCount must contain count`);
  });
});

test('Market Intelligence: isForeignBroker correctly identifies foreign firms and asterisks', () => {
  assert.equal(engine.isForeignBroker('ZP'), true);
  assert.equal(engine.isForeignBroker('RX'), true);
  assert.equal(engine.isForeignBroker('AK'), true);
  assert.equal(engine.isForeignBroker('BK'), true);
  assert.equal(engine.isForeignBroker('YP*'), true);
  assert.equal(engine.isForeignBroker('PD*'), true);
  assert.equal(engine.isForeignBroker('XC'), false);
  assert.equal(engine.isForeignBroker('XL'), false);
  assert.equal(engine.isForeignBroker(''), false);
});

test('Market Intelligence: calculateMarketBreadth returns valid ratios and totals', () => {
  const mb = engine.calculateMarketBreadth();
  assert.equal(mb.success, true);
  assert.ok(mb.totalStocks > 0);
  assert.ok(mb.gainers >= 0);
  assert.ok(mb.losers >= 0);
  assert.ok(mb.unchanged >= 0);

  const sumPct = Math.round(mb.gainerPct + mb.loserPct + mb.unchangedPct);
  assert.ok(sumPct >= 99 && sumPct <= 101, 'Percentage of stocks must sum to ~100%');
  assert.ok(typeof mb.totalTurnoverDisplay === 'string');
  assert.ok(typeof mb.sentiment === 'string');
});

test('Market Intelligence: getSmartBrokerSummary structures 2-column Net Buy vs Net Sell', () => {
  const broksum = engine.getSmartBrokerSummary('BBCA');
  assert.equal(broksum.success, true);
  assert.equal(broksum.ticker, 'BBCA');
  assert.ok(Array.isArray(broksum.topBuyers));
  assert.ok(Array.isArray(broksum.topSellers));
  assert.ok(broksum.topBuyers.length > 0);
  assert.ok(broksum.topSellers.length > 0);

  // Check top buyers structure
  const b0 = broksum.topBuyers[0];
  assert.ok(b0.code);
  assert.ok(b0.origin === 'ASING' || b0.origin === 'DOMESTIK');
  assert.ok(b0.netValue > 0);
  assert.ok(b0.netLot > 0);
  assert.ok(b0.avgPrice > 0);

  // Check concentration ratios
  assert.ok(broksum.top1Ratio >= 0 && broksum.top1Ratio <= 100);
  assert.ok(broksum.top3Ratio >= broksum.top1Ratio);
  assert.ok(broksum.top5Ratio >= broksum.top3Ratio);
  assert.ok(typeof broksum.bandarStatus === 'string');
  assert.ok(typeof broksum.bandarSummaryText === 'string');
});

test('Market Intelligence: evaluateScreenerPreset produces filtered list with reasons', () => {
  const res = engine.evaluateScreenerPreset('silent_accumulation');
  assert.equal(res.success, true);
  assert.ok(res.preset);
  assert.ok(Array.isArray(res.results));

  if (res.results.length > 0) {
    const row = res.results[0];
    assert.ok(row.ticker);
    assert.ok(row.close > 0);
    assert.ok(row.turnover > 0);
    assert.ok(typeof row.matchReason === 'string');
  }
});

test('Market Intelligence: searchStocks performs instant case-insensitive fuzzy match', () => {
  const emptyRes = engine.searchStocks('');
  assert.equal(emptyRes.success, true);
  assert.ok(emptyRes.results.length >= 10, 'Default search returns bellwether stocks');

  const bcaRes = engine.searchStocks('BBCA');
  assert.equal(bcaRes.success, true);
  assert.ok(bcaRes.results.length > 0);
  assert.equal(bcaRes.results[0].ticker, 'BBCA');

  const bankRes = engine.searchStocks('Bank');
  assert.equal(bankRes.success, true);
  assert.ok(bankRes.results.length > 0);
  assert.ok(bankRes.results.some(r => r.name.toLowerCase().includes('bank')));
});
