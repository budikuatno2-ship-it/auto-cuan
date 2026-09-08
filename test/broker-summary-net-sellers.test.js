'use strict';

/**
 * PR #2 Unit Test: Broker Summary Net Value Mode Sellers Fix
 *
 * Verifies:
 * 1. BBRI Net Value broker summary contains both net_buyers > 0 and net_sellers > 0
 * 2. buildBrokerBubbleItems in Net Mode produces items with both isNetBuyer=true and isNetBuyer=false
 * 3. Net Sellers have negative displayVal and '-' badge
 * 4. renderBrokerBubbleClusterHtml renders counter with both Buyers and Sellers > 0
 * 5. Filter pills [Semua], [Buyers], [Sellers] correctly partition bubbles
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const bandarmologiService = require(path.join(ROOT, 'lib', 'bandarmologi-service'));

// Helper to load BandarmologiRuntime in mock browser environment
function loadRuntime() {
  const code = fs.readFileSync(path.join(ROOT, 'public', 'bandarmologi-runtime.js'), 'utf8');
  const domElements = {};
  const mockDoc = {
    getElementById: (id) => domElements[id] || { textContent: '', value: '', innerHTML: '', addEventListener: () => {} },
    querySelector: () => null,
    querySelectorAll: () => []
  };
  const mockWin = {
    document: mockDoc,
    BandarmologiRuntime: null,
    formatIDR: (v) => 'Rp ' + Math.abs(v).toLocaleString('id-ID'),
    formatNumber: (v) => Number(v).toLocaleString('id-ID'),
    escapeHtml: (s) => String(s)
  };
  mockWin.window = mockWin;
  vm.runInNewContext(code, mockWin);
  return mockWin.BandarmologiRuntime;
}

test('BBRI getBandarmologiData Net Value mode has net_sellers > 0', async () => {
  const data = await bandarmologiService.getBandarmologiData('BBRI', '1d');
  assert.ok(data, 'data must be returned');
  assert.ok(data.broker_summary, 'broker_summary must exist');
  const bSum = data.broker_summary;
  assert.ok(Array.isArray(bSum.net_buyers), 'net_buyers must be an array');
  assert.ok(Array.isArray(bSum.net_sellers), 'net_sellers must be an array');
  assert.ok(bSum.net_buyers.length > 0, `net_buyers length (${bSum.net_buyers.length}) must be > 0`);
  assert.ok(bSum.net_sellers.length > 0, `net_sellers length (${bSum.net_sellers.length}) must be > 0`);

  // Verify all net_sellers have negative nval or net_val
  for (const s of bSum.net_sellers) {
    const val = s.nval != null ? s.nval : s.net_val;
    assert.ok(val < 0, `net_seller ${s.broker} must have negative net value, got ${val}`);
  }
});

test('buildBrokerBubbleItems in Net Mode produces both net buyers and net sellers', () => {
  const runtime = loadRuntime();
  assert.ok(runtime, 'BandarmologiRuntime must be loaded');

  const buyers = [
    { broker: 'YP', bval: 12000000000, sval: 2000000000, nval: 10000000000, buy_vol: 100000, sell_vol: 20000 },
    { broker: 'PD', bval: 8000000000, sval: 1000000000, nval: 7000000000, buy_vol: 80000, sell_vol: 10000 },
    { broker: 'XC', bval: 5000000000, sval: 1000000000, nval: 4000000000, buy_vol: 50000, sell_vol: 10000 }
  ];
  const sellers = [
    { broker: 'CC', bval: 1000000000, sval: 9000000000, nval: -8000000000, buy_vol: 10000, sell_vol: 90000 },
    { broker: 'AK', bval: 2000000000, sval: 8000000000, nval: -6000000000, buy_vol: 20000, sell_vol: 80000 },
    { broker: 'BK', bval: 500000000, sval: 5500000000, nval: -5000000000, buy_vol: 5000, sell_vol: 55000 }
  ];

  const items = runtime.buildBrokerBubbleItems(buyers, sellers, 'net');
  assert.ok(Array.isArray(items), 'items must be array');
  assert.equal(items.length, 6, 'items must contain all 6 brokers');

  const netBuyers = items.filter(x => x.isNetBuyer);
  const netSellers = items.filter(x => !x.isNetBuyer);

  assert.equal(netBuyers.length, 3, 'Must have exactly 3 net buyers');
  assert.equal(netSellers.length, 3, 'Must have exactly 3 net sellers');

  // Verify buyer properties
  for (const b of netBuyers) {
    assert.equal(b.side, 'buy');
    assert.equal(b.badge, '+');
    assert.ok(b.displayVal > 0, `Buyer displayVal must be positive, got ${b.displayVal}`);
  }

  // Verify seller properties: red badge '-', negative displayVal
  for (const s of netSellers) {
    assert.equal(s.side, 'sell');
    assert.equal(s.badge, '-');
    assert.ok(s.displayVal < 0, `Seller displayVal must be negative, got ${s.displayVal}`);
  }
});

test('renderBrokerBubbleClusterHtml renders counter with both Buyers and Sellers > 0', () => {
  const runtime = loadRuntime();

  const buyers = [
    { broker: 'YP', bval: 12e9, sval: 2e9, nval: 10e9, buy_vol: 100000, sell_vol: 20000 },
    { broker: 'PD', bval: 8e9, sval: 1e9, nval: 7e9, buy_vol: 80000, sell_vol: 10000 }
  ];
  const sellers = [
    { broker: 'CC', bval: 1e9, sval: 9e9, nval: -8e9, buy_vol: 10000, sell_vol: 90000 },
    { broker: 'AK', bval: 2e9, sval: 8e9, nval: -6e9, buy_vol: 20000, sell_vol: 80000 }
  ];

  const items = runtime.buildBrokerBubbleItems(buyers, sellers, 'net');
  const html = runtime.renderBrokerBubbleClusterHtml(items, 'YP', 'net', 'all');

  assert.ok(html.includes('Semua (4)'), `HTML must contain 'Semua (4)', got:\n${html}`);
  assert.ok(html.includes('Buyers (2)'), `HTML must contain 'Buyers (2)'`);
  assert.ok(html.includes('Sellers (2)'), `HTML must contain 'Sellers (2)'`);

  // Verify red negative bubbles are rendered
  assert.ok(html.includes('data-side="sell"'), `HTML must render 'data-side="sell"' for sellers`);
  assert.ok(html.includes('data-side="buy"'), `HTML must render 'data-side="buy"' for buyers`);
  assert.ok(html.includes('>-8.00 M<') || html.includes('>-'), `HTML must render negative values for sellers`);
});

test('Filter pills partition bubbles correctly in Net Mode', () => {
  const runtime = loadRuntime();

  const buyers = [
    { broker: 'YP', bval: 12e9, sval: 2e9, nval: 10e9, buy_vol: 100000, sell_vol: 20000 }
  ];
  const sellers = [
    { broker: 'CC', bval: 1e9, sval: 9e9, nval: -8e9, buy_vol: 10000, sell_vol: 90000 }
  ];

  const items = runtime.buildBrokerBubbleItems(buyers, sellers, 'net');

  // Filter: 'buy'
  const htmlBuy = runtime.renderBrokerBubbleClusterHtml(items, 'YP', 'net', 'buy');
  assert.ok(htmlBuy.includes('YP'), 'Buy filter must include YP');
  assert.ok(!htmlBuy.includes('>CC<'), 'Buy filter must NOT include CC');

  // Filter: 'sell'
  const htmlSell = runtime.renderBrokerBubbleClusterHtml(items, 'CC', 'net', 'sell');
  assert.ok(htmlSell.includes('CC'), 'Sell filter must include CC');
  assert.ok(!htmlSell.includes('>YP<'), 'Sell filter must NOT include YP');
});

test('Partition fallback recovers sellers when sellers array is initially empty', () => {
  const runtime = loadRuntime();

  // Only buyers supplied, but some have sell volume or negative net
  const buyersWithSellers = [
    { broker: 'YP', bval: 10e9, sval: 2e9, nval: 8e9, buy_vol: 100000, sell_vol: 20000 },
    { broker: 'CC', bval: 1e9, sval: 9e9, nval: -8e9, buy_vol: 10000, sell_vol: 90000 }
  ];

  const items = runtime.buildBrokerBubbleItems(buyersWithSellers, [], 'net');
  const netSellers = items.filter(x => !x.isNetBuyer);
  assert.ok(netSellers.length > 0, `Must recover net sellers from mixed array, got ${netSellers.length}`);
  assert.equal(netSellers[0].broker, 'CC');
  assert.equal(netSellers[0].badge, '-');
});
