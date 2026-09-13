const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const bandarmologiService = require('../lib/bandarmologi-service');
const bandarmologiIntelService = require('../lib/bandarmologi-intel-service');
const bandarmologiRuntime = require('../public/bandarmologi-runtime');

test('Pillar 1: Date & Exchange Calendar Reconciliation', () => {
  // 1. Weekend date Sunday 2026-09-13 must fallback to Friday 2026-09-11
  const effectiveDate = bandarmologiService.getEffectiveTradingDate('BBCA', '2026-09-13');
  assert.equal(effectiveDate, '2026-09-11', 'Sunday 2026-09-13 must fallback to previous active trading day 2026-09-11');

  // 2. Uniform ISO format YYYY-MM-DD in formatDateDisplay
  const formatted = bandarmologiRuntime.formatDateDisplay('2026-09-11T00:00:00.000Z');
  assert.equal(formatted, '2026-09-11', 'formatDateDisplay must output uniform YYYY-MM-DD');

  const formattedStr = bandarmologiRuntime.formatDateDisplay('2026-09-11');
  assert.equal(formattedStr, '2026-09-11', 'formatDateDisplay must preserve YYYY-MM-DD string');
});

test('Pillar 2: Bubble SVG Logic & Neutral States', () => {
  // 1. Zero activity broker must not generate dummy +1 or -1 bubble
  const buyersZero = [{ broker: 'DX', bval: 0, sval: 0, nval: 0 }];
  const sellersZero = [];
  const bubblesZero = bandarmologiRuntime.buildBrokerBubbleItems(buyersZero, sellersZero, 'net');
  assert.equal(bubblesZero.length, 0, 'Zero activity broker must not generate dummy bubbles');

  // 2. Equal gross buy/sell broker (DX net 0 with real turnover) must be marked neutral
  const buyersDx = [{ broker: 'DX', bval: 5000000000, sval: 5000000000, nval: 0, bvol: 50000, svol: 50000 }];
  const sellersDx = [{ broker: 'DX', bval: 5000000000, sval: 5000000000, nval: 0, bvol: 50000, svol: 50000 }];
  const bubblesDx = bandarmologiRuntime.buildBrokerBubbleItems(buyersDx, sellersDx, 'net');
  assert.equal(bubblesDx.length, 1, 'Should create 1 neutral bubble for DX');
  assert.equal(bubblesDx[0].isNeutral, true, 'DX bubble must be marked isNeutral');
  assert.equal(bubblesDx[0].badge, '0', 'DX bubble badge must be 0, not + or -');

  // 3. Detail card for DX net 0 must show 50% / 50% Netral or 0% / 0% Netral, never 0 (100%)
  const detailCardHtml = bandarmologiRuntime.renderBrokerDetailCardHtml(bubblesDx[0], 'net');
  assert.match(detailCardHtml, /Netral/i, 'Detail card must label status as Netral');
  assert.doesNotMatch(detailCardHtml, /0\s*\(100%\)/, 'Detail card must never show 0 (100%)');
});

test('Pillar 3: Price & Cost Reconciliation (Independent Broker Averages & No Net Sellers)', () => {
  // Mock broker summary with diverse prices and net values
  const mockSummary = {
    top_buyers: [
      { broker: 'YU', buy_val: 10000000000, buy_vol: 1587301, avg_price: 6300, net_val: 8000000000 },
      { broker: 'AZ', buy_val: 8000000000, buy_vol: 1250000, avg_price: 6400, net_val: 6000000000 },
      { broker: 'AK', buy_val: 5000000000, buy_vol: 769230, avg_price: 6500, net_val: 4000000000 },
      // Net seller disguised in gross buyers
      { broker: 'ZP', buy_val: 3000000000, buy_vol: 500000, avg_price: 6000, net_val: -374000000000 },
      { broker: 'CC', buy_val: 2000000000, buy_vol: 333333, avg_price: 6000, net_val: -232000000000 }
    ],
    top_sellers: [
      { broker: 'ZP', sell_val: 377000000000, sell_vol: 60000000, avg_price: 6280, net_val: -374000000000 },
      { broker: 'CC', sell_val: 234000000000, sell_vol: 38000000, avg_price: 6150, net_val: -232000000000 }
    ]
  };

  // 1. detectPriceBelowBandarCost
  const intelCost = bandarmologiIntelService.detectPriceBelowBandarCost('BBCA', {
    brokerSummary: mockSummary,
    currentPrice: 6250
  });

  assert.ok(intelCost);
  assert.equal(intelCost.top_3_brokers.length, 3);
  const brokerCodes = intelCost.top_3_brokers.map(b => b.broker);
  assert.deepEqual(brokerCodes, ['YU', 'AZ', 'AK'], 'Top 3 accumulators must strictly exclude net sellers ZP and CC');

  // Verify independent broker averages (no twin prices)
  const yuPrice = intelCost.top_3_brokers[0].avg_price;
  const azPrice = intelCost.top_3_brokers[1].avg_price;
  assert.notEqual(yuPrice, azPrice, 'YU and AZ must have distinct independent buy averages');

  // 2. Sweet spot threshold: currentPrice 6250 vs avg ~6350 is ~1.57% discount -> Sweet Spot
  assert.equal(intelCost.in_sweet_spot, true, 'Discount of ~1.6% must trigger sweet spot (1.5% - 5.0%)');

  // 3. At Par threshold: currentPrice 6348 vs avg ~6350 is 0.03% difference -> Not triggered, marked is_at_par
  const intelAtPar = bandarmologiIntelService.detectPriceBelowBandarCost('BBCA', {
    brokerSummary: mockSummary,
    currentPrice: 6348
  });
  assert.equal(intelAtPar.triggered, false, 'Difference < 1.0% must NOT trigger aggressive buy signal');
  assert.equal(intelAtPar.is_at_par, true, 'Difference < 1.0% must be flagged is_at_par');
  assert.match(intelAtPar.description, /harga wajar \/ at par/i, 'Description must state harga wajar / at par');
});

test('Pillar 4: Range Integration & Multi-Day Aggregation', () => {
  // Concentration Ratio must filter top_3_brokers strictly to net accumulators
  const mockSummary = {
    gross_buyers: [
      { broker: 'YU', bval: 10000000000, bvol: 1500000, net_val: 8000000000 },
      { broker: 'ZP', bval: 9000000000, bvol: 1400000, net_val: -5000000000 },
      { broker: 'AZ', bval: 8000000000, bvol: 1200000, net_val: 6000000000 },
      { broker: 'AK', bval: 7000000000, bvol: 1000000, net_val: 5000000000 }
    ],
    net_buyers: [
      { broker: 'YU', bval: 10000000000, bvol: 1500000, net_val: 8000000000 },
      { broker: 'AZ', bval: 8000000000, bvol: 1200000, net_val: 6000000000 },
      { broker: 'AK', bval: 7000000000, bvol: 1000000, net_val: 5000000000 }
    ],
    total_turnover: 50000000000
  };

  const cr = bandarmologiIntelService.computeConcentrationRatios('BBCA', {
    brokerSummary: mockSummary,
    range: '7d'
  });

  assert.ok(cr);
  assert.deepEqual(cr.top_3_brokers, ['YU', 'AZ', 'AK'], 'Concentration ratio top 3 must exclude net seller ZP');

  // Full evaluation must attach effective_date and range metadata
  const evalResult = bandarmologiIntelService.evaluateBandarmologiIntelForTicker('BBCA', {
    brokerSummary: mockSummary,
    range: '60d',
    currentPrice: 6250
  });

  assert.equal(evalResult.range, '60D', 'Evaluated range metadata must reflect 60D');
  assert.equal(evalResult.effective_date, '2026-09-11', 'Effective date must reflect active trading day');
});