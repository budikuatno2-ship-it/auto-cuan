'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const bandarmologiService = require('../lib/bandarmologi-service');
const bandarmologiIntelService = require('../lib/bandarmologi-intel-service');
const bandarmologiRuntime = require('../public/bandarmologi-runtime');

// =================================================================
// 1. GROSS BUY MODAL PRICE (NO CHURNING / SILUMAN PRICE DISTORTION)
// =================================================================

test('bandarmologiService.normalizeVwapPrice: preserves normal stock price range without dividing by 100', () => {
  // Normal Indonesian stock prices (Rp 50 to Rp 50,000) must NEVER be divided by 100
  assert.equal(bandarmologiService.normalizeVwapPrice(10150, 10150), 10150);
  assert.equal(bandarmologiService.normalizeVwapPrice(10150), 10150);
  assert.equal(bandarmologiService.normalizeVwapPrice(50), 50);
  assert.equal(bandarmologiService.normalizeVwapPrice(9500), 9500);

  // Scaled prices in cents (> 100,000) should be normalized
  assert.equal(bandarmologiService.normalizeVwapPrice(1015000), 10150);
});

test('bandarmologiService.enrichBrokerItem: calculates true Gross Buy modal price and prevents churning distortion', () => {
  // Broker CC churned heavily:
  // Bought 10,000 lots @ Rp 10,150 -> bval = 10,150,000,000, bvol = 10,000
  // Sold 9,000 lots @ Rp 10,575 -> sval = 9,517,500,000, svol = 9,000
  // Net: 1,000 lots, net_val = 632,500,000
  // Old faulty net formula: 632,500,000 / (1,000 * 100) = 6,325 (distorted!)
  // Gross Buy formula: 10,150,000,000 / (10,000 * 100) = 10,150 (authentic!)
  const churningBroker = {
    broker_code: 'CC',
    bval: 10150000000,
    bvol: 10000,
    sval: 9517500000,
    svol: 9000,
    net_val: 632500000,
    net_vol: 1000
  };

  const enrichedBuyer = bandarmologiService.enrichBrokerItem({ ...churningBroker }, true, 10150);

  assert.equal(enrichedBuyer.avg_buy, 10150, 'avg_buy must be gross buy VWAP (10,150)');
  assert.equal(enrichedBuyer.avg_sell, 10575, 'avg_sell must be gross sell VWAP (10,575)');
  assert.equal(enrichedBuyer.avg_price, 10150, 'buyer avg_price must equal gross buy price, NOT churning net 6,325');
  assert.notEqual(enrichedBuyer.avg_price, 6325, 'avg_price must never equal distorted net price');

  const enrichedSeller = bandarmologiService.enrichBrokerItem({ ...churningBroker }, false, 10150);
  assert.equal(enrichedSeller.avg_price, 10575, 'seller avg_price must equal gross sell price');
});

test('bandarmologiService.normalizeBrokerSummary: maps gross_buyers and net_buyers using pure gross buy modal price', () => {
  const rawSummary = {
    stock_code: 'BBCA',
    date: '2026-09-11',
    top_buyers: [
      {
        broker_code: 'CC',
        bval: 10150000000,
        bvol: 10000,
        sval: 9517500000,
        svol: 9000,
        net_val: 632500000,
        net_vol: 1000
      },
      {
        broker_code: 'AK',
        bval: 5075000000,
        bvol: 5000,
        sval: 1000000000,
        svol: 1000,
        net_val: 4075000000,
        net_vol: 4000
      }
    ],
    top_sellers: [
      {
        broker_code: 'YP',
        bval: 500000000,
        bvol: 500,
        sval: 8000000000,
        svol: 8000,
        net_val: -7500000000,
        net_vol: -7500
      }
    ],
    total_buy_val: 15225000000,
    total_sell_val: 18517500000,
    total_volume: 15000
  };

  const norm = bandarmologiService.normalizeBrokerSummary(rawSummary);

  assert.ok(norm.gross_buyers.length > 0, 'gross_buyers populated');
  assert.equal(norm.gross_buyers[0].broker, 'CC');
  assert.equal(norm.gross_buyers[0].avg_buy, 10150);
  assert.equal(norm.gross_buyers[0].avg_price, 10150, 'CC gross buyer avg_price must be 10,150');

  assert.ok(norm.net_buyers.length > 0, 'net_buyers populated');
  assert.equal(norm.net_buyers[0].broker, 'CC');
  assert.equal(norm.net_buyers[0].avg_buy, 10150);
  assert.equal(norm.net_buyers[0].avg_price, 10150, 'CC net buyer avg_price must be gross buy 10,150');

  // Verify turnover aggregates are populated
  assert.ok(norm.total_buy_val > 0, 'total_buy_val must be populated');
  assert.ok(norm.total_turnover > 0, 'total_turnover must be populated');
});

// =================================================================
// 2. CR3 CONCENTRATION RATIO (NO 100% LOCK & AUTHENTIC DENOMINATOR)
// =================================================================

test('bandarmologiIntelService.computeConcentrationRatios: calculates authentic CR3 without 100% lock', () => {
  const mockSummary = {
    ticker: 'MOCK_CR3',
    gross_buyers: [
      { broker: 'CC', bval: 10000000000, bvol: 10000, avg_price: 3200 },
      { broker: 'AK', bval: 10000000000, bvol: 10000, avg_price: 3200 },
      { broker: 'ZP', bval: 10000000000, bvol: 10000, avg_price: 3200 }
    ],
    // Top 3 buyers total = Rp 30,000,000,000 (30B)
    // Total emiten turnover = Rp 100,000,000,000 (100B)
    total_buy_val: 100000000000,
    total_turnover: 100000000000
  };

  const cr = bandarmologiIntelService.computeConcentrationRatios('MOCK_CR3', { brokerSummary: mockSummary });

  // CR3 should be (30B / 100B) * 100 = 30.0%
  assert.equal(cr.cr3, 30, 'CR3 should be 30%, NOT locked to 100%');
  assert.notEqual(cr.cr3, 100, 'CR3 must NOT be 100% when turnover is higher than top 3');
  assert.ok(cr.description.includes('CR3 sebesar 30%'));
  assert.equal(cr.top_3_val, 30000000000);
  assert.equal(cr.total_turnover, 100000000000);
});

test('bandarmologiIntelService.computeConcentrationRatios: resolves turnover from all brokers if total_turnover missing', () => {
  // 6 brokers trading in the market
  const brokers = [
    { broker: 'CC', bval: 10000000000, bvol: 10000 },
    { broker: 'AK', bval: 10000000000, bvol: 10000 },
    { broker: 'ZP', bval: 10000000000, bvol: 10000 },
    { broker: 'YP', bval: 5000000000, bvol: 5000 },
    { broker: 'PD', bval: 5000000000, bvol: 5000 },
    { broker: 'NI', bval: 10000000000, bvol: 10000 }
  ];
  // Top 3 = 30B, Total All 6 = 50B -> CR3 = (30/50)*100 = 60%
  const mockSummary = {
    ticker: 'MOCK_ALL_BROKERS',
    gross_buyers: brokers.slice(0, 3),
    brokers: brokers
  };

  const cr = bandarmologiIntelService.computeConcentrationRatios('MOCK_ALL_BROKERS', { brokerSummary: mockSummary });
  assert.equal(cr.cr3, 60, 'CR3 should be 60% based on full broker turnover');
});

// =================================================================
// 3. DETECT PRICE BELOW BANDAR COST (GROSS BUY & DISCOUNT)
// =================================================================

test('bandarmologiIntelService.detectPriceBelowBandarCost: uses gross buy modal and calculates accurate discount_pct', () => {
  // BBCA hunter cache has avg bandar buy = 6629
  // If market price is 6000 (< 6629), discount_pct must be positive
  const resBelow = bandarmologiIntelService.detectPriceBelowBandarCost('BBCA', {
    range: '7d',
    currentPrice: 6000
  });

  assert.equal(resBelow.signal_key, 'HARGA_DI_BAWAH_MODAL_BANDAR');
  assert.ok(resBelow.bandar_avg_buy > 0, 'bandar_avg_buy must be positive');
  assert.ok(resBelow.discount_pct > 0, 'discount_pct should be positive when currentPrice < bandar modal');
  assert.equal(resBelow.triggered, true, 'Signal must be triggered when currentPrice < bandar modal');
  assert.equal(resBelow.current_price, 6000);

  // Verify top 3 brokers carry clean gross buy modal prices
  resBelow.top_3_brokers.forEach(b => {
    assert.ok(b.avg_price > 0, 'Broker avg_price must be > 0');
    assert.ok(b.avg_buy > 0, 'Broker avg_buy must be > 0');
    assert.equal(b.avg_price, b.avg_buy, 'avg_price must equal avg_buy');
    assert.ok(b.avg_price >= 50 && b.avg_price <= 100000, `Broker avg_price ${b.avg_price} in valid stock range`);
  });

  // If market price is 7000 (> 6629), discount_pct must be negative and price_diff_pct positive
  const resAbove = bandarmologiIntelService.detectPriceBelowBandarCost('BBCA', {
    range: '7d',
    currentPrice: 7000
  });
  assert.ok(resAbove.discount_pct < 0, 'discount_pct should be negative when currentPrice > bandar modal');
  assert.ok(resAbove.price_diff_pct > 0, 'price_diff_pct should be positive when price is above bandar cost');
  assert.equal(resAbove.triggered, false);
});

// =================================================================
// 4. FRONTEND UI DATE SELECT DROPDOWN (brokerDateSelect)
// =================================================================

test('bandarmologiRuntime.renderBandarmologiUI: renders brokerDateSelect dropdown with all available dates', () => {
  const dates = ['2026-09-11', '2026-09-10', '2026-09-09', '2026-09-08', '2026-09-05'];
  const mockContainer = { innerHTML: '' };
  const mockData = {
    ticker: 'BBCA',
    available_dates: dates,
    broker_summary: {
      date: '2026-09-10',
      stock_code: 'BBCA',
      gross_buyers: [{ broker: 'CC', bval: 10000000, bvol: 1000, avg_price: 10150, avg_buy: 10150 }],
      gross_sellers: [{ broker: 'YP', sval: 10000000, svol: 1000, avg_price: 10150, avg_sell: 10150 }],
      net_buyers: [{ broker: 'CC', nval: 5000000, nvol: 500, avg_price: 10150, avg_buy: 10150 }],
      net_sellers: [{ broker: 'YP', nval: -5000000, nvol: -500, avg_price: 10150, avg_sell: 10150 }]
    }
  };

  bandarmologiRuntime.renderBandarmologiUI(mockContainer, mockData);
  const html = mockContainer.innerHTML;

  // Must contain <select id="brokerDateSelect"
  assert.ok(html.includes('<select id="brokerDateSelect"'), 'Must include <select id="brokerDateSelect"');
  assert.ok(html.includes('onchange="BandarmologiRuntime.loadBandarmologiTab(null, this.value)"'), 'Must include onchange handler');

  // Must include all dates as options
  for (const d of dates) {
    assert.ok(html.includes(`value="${d}"`), `Must include option for date ${d}`);
  }

  // Selected date must have selected attribute
  assert.ok(html.includes('value="2026-09-10" selected'), 'Selected date 2026-09-10 must be marked selected');

  // Latest date (first in array) must have "(Terbaru)" badge in option text
  assert.ok(html.includes('2026-09-11 (Terbaru)'), 'Latest date must have (Terbaru) label');
});
