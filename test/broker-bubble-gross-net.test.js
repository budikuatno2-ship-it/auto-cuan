'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const bandarmologiRuntime = require(path.join(__dirname, '..', 'public', 'bandarmologi-runtime.js'));

test('FASE 2: Mode Gross generates exactly 22 bubbles (11 Top Gross Buyers + 11 Top Gross Sellers)', () => {
  // Create 15 buyers and 15 sellers
  const mockBuyers = [
    { broker: 'YP', bval: 150000000000, sval: 140000000000, bvol: 150000, svol: 140000, avg_buy: 1000 },
    { broker: 'AK', bval: 140000000000, sval: 80000000000, bvol: 140000, svol: 80000, avg_buy: 1000 },
    { broker: 'BK', bval: 130000000000, sval: 60000000000, bvol: 130000, svol: 60000, avg_buy: 1000 },
    { broker: 'CC', bval: 120000000000, sval: 70000000000, bvol: 120000, svol: 70000, avg_buy: 1000 },
    { broker: 'PD', bval: 110000000000, sval: 50000000000, bvol: 110000, svol: 50000, avg_buy: 1000 },
    { broker: 'NI', bval: 100000000000, sval: 40000000000, bvol: 100000, svol: 40000, avg_buy: 1000 },
    { broker: 'RX', bval: 90000000000, sval: 30000000000, bvol: 90000, svol: 30000, avg_buy: 1000 },
    { broker: 'XC', bval: 80000000000, sval: 90000000000, bvol: 80000, svol: 90000, avg_buy: 1000 },
    { broker: 'SQ', bval: 70000000000, sval: 20000000000, bvol: 70000, svol: 20000, avg_buy: 1000 },
    { broker: 'GR', bval: 60000000000, sval: 10000000000, bvol: 60000, svol: 10000, avg_buy: 1000 },
    { broker: 'XL', bval: 50000000000, sval: 45000000000, bvol: 50000, svol: 45000, avg_buy: 1000 },
    { broker: 'YU', bval: 40000000000, sval: 15000000000, bvol: 40000, svol: 15000, avg_buy: 1000 },
    { broker: 'ZP', bval: 30000000000, sval: 10000000000, bvol: 30000, svol: 10000, avg_buy: 1000 },
    { broker: 'AI', bval: 20000000000, sval: 5000000000, bvol: 20000, svol: 5000, avg_buy: 1000 },
    { broker: 'DH', bval: 10000000000, sval: 2000000000, bvol: 10000, svol: 2000, avg_buy: 1000 }
  ];

  const mockSellers = [
    { broker: 'YP', bval: 150000000000, sval: 140000000000, bvol: 150000, svol: 140000, avg_sell: 1000 },
    { broker: 'XC', bval: 80000000000, sval: 90000000000, bvol: 80000, svol: 90000, avg_sell: 1000 },
    { broker: 'AK', bval: 140000000000, sval: 80000000000, bvol: 140000, svol: 80000, avg_sell: 1000 },
    { broker: 'CC', bval: 120000000000, sval: 70000000000, bvol: 120000, svol: 70000, avg_sell: 1000 },
    { broker: 'BK', bval: 130000000000, sval: 60000000000, bvol: 130000, svol: 60000, avg_sell: 1000 },
    { broker: 'PD', bval: 110000000000, sval: 50000000000, bvol: 110000, svol: 50000, avg_sell: 1000 },
    { broker: 'XL', bval: 50000000000, sval: 45000000000, bvol: 50000, svol: 45000, avg_sell: 1000 },
    { broker: 'NI', bval: 100000000000, sval: 40000000000, bvol: 100000, svol: 40000, avg_sell: 1000 },
    { broker: 'RX', bval: 90000000000, sval: 30000000000, bvol: 90000, svol: 30000, avg_sell: 1000 },
    { broker: 'SQ', bval: 70000000000, sval: 20000000000, bvol: 70000, svol: 20000, avg_sell: 1000 },
    { broker: 'YU', bval: 40000000000, sval: 15000000000, bvol: 40000, svol: 15000, avg_sell: 1000 },
    { broker: 'GR', bval: 60000000000, sval: 10000000000, bvol: 60000, svol: 10000, avg_sell: 1000 },
    { broker: 'ZP', bval: 30000000000, sval: 10000000000, bvol: 30000, svol: 10000, avg_sell: 1000 },
    { broker: 'AI', bval: 20000000000, sval: 5000000000, bvol: 20000, svol: 5000, avg_sell: 1000 },
    { broker: 'DH', bval: 10000000000, sval: 2000000000, bvol: 10000, svol: 2000, avg_sell: 1000 }
  ];

  const bubbles = bandarmologiRuntime.buildBrokerBubbleItems(mockBuyers, mockSellers, 'gross');

  // 1. Must produce exactly 22 bubbles total
  assert.equal(bubbles.length, 22, 'Gross mode must produce exactly 22 bubbles (11 buyers + 11 sellers)');

  // 2. Exactly 11 buyers and 11 sellers
  const buyersList = bubbles.filter(b => b.side === 'buy' && b.isBuyer === true);
  const sellersList = bubbles.filter(b => b.side === 'sell' && b.isBuyer === false);
  assert.equal(buyersList.length, 11, 'Must have exactly 11 top gross buyers');
  assert.equal(sellersList.length, 11, 'Must have exactly 11 top gross sellers');

  // 3. Dual-sided broker (YP) exists in both buyer and seller lists
  const ypBuyer = buyersList.find(b => b.broker === 'YP');
  const ypSeller = sellersList.find(b => b.broker === 'YP');
  assert.ok(ypBuyer, 'YP must exist as a buyer bubble');
  assert.ok(ypSeller, 'YP must exist as a seller bubble');
  assert.equal(ypBuyer.badge, 'BUY', 'YP buyer badge must be BUY');
  assert.equal(ypSeller.badge, 'SELL', 'YP seller badge must be SELL');
  assert.equal(ypBuyer.txVal, 150000000000, 'YP buyer txVal must be gross buy value');
  assert.equal(ypSeller.txVal, 140000000000, 'YP seller txVal must be gross sell value');
});

test('FASE 2: Mode Gross renders 22 bubbles, filter pills (Semua 22, Buyers 11, Sellers 11), and filter views', () => {
  const mockBuyers = [];
  const mockSellers = [];
  const codes = ['YP', 'AK', 'BK', 'CC', 'PD', 'NI', 'RX', 'XC', 'SQ', 'GR', 'XL'];
  for (let i = 0; i < codes.length; i++) {
    mockBuyers.push({
      broker: codes[i],
      bval: (100 - i * 5) * 1e9,
      sval: 10 * 1e9,
      nval: (90 - i * 5) * 1e9
    });
    mockSellers.push({
      broker: codes[codes.length - 1 - i],
      bval: 10 * 1e9,
      sval: (80 - i * 5) * 1e9,
      nval: -(70 - i * 5) * 1e9
    });
  }

  const bubbles = bandarmologiRuntime.buildBrokerBubbleItems(mockBuyers, mockSellers, 'gross');
  assert.equal(bubbles.length, 22, 'Precondition: exactly 22 bubbles');

  // 1. All view (Semua 22)
  const htmlAll = bandarmologiRuntime.renderBrokerBubbleClusterHtml(bubbles, 'YP', 'gross', 'all');
  assert.match(htmlAll, /Semua \(22\)/, 'Button must show Semua (22)');
  assert.match(htmlAll, /🟢 Buyers \(11\)/, 'Button must show Buyers (11)');
  assert.match(htmlAll, /🔴 Sellers \(11\)/, 'Button must show Sellers (11)');

  // Count buyer and seller badges in rendered HTML
  const buyBadges = (htmlAll.match(/BUY<\/span>/g) || []).length;
  const sellBadges = (htmlAll.match(/SELL<\/span>/g) || []).length;
  assert.equal(buyBadges, 11, 'HTML must render 11 BUY badges in all view');
  assert.equal(sellBadges, 11, 'HTML must render 11 SELL badges in all view');

  // Verify unique bubble keys for dual-sided brokers
  assert.ok(htmlAll.includes('broker-bubble-YP-buy'), 'Includes broker-bubble-YP-buy');
  assert.ok(htmlAll.includes('broker-bubble-YP-sell'), 'Includes broker-bubble-YP-sell');

  // 2. Buy filter view
  const htmlBuy = bandarmologiRuntime.renderBrokerBubbleClusterHtml(bubbles, 'YP', 'gross', 'buy');
  const buyOnlyBadges = (htmlBuy.match(/BUY<\/span>/g) || []).length;
  const sellInBuyBadges = (htmlBuy.match(/SELL<\/span>/g) || []).length;
  assert.equal(buyOnlyBadges, 11, 'Buy filter must render only 11 BUY bubbles');
  assert.equal(sellInBuyBadges, 0, 'Buy filter must have 0 SELL bubbles');

  // 3. Sell filter view
  const htmlSell = bandarmologiRuntime.renderBrokerBubbleClusterHtml(bubbles, 'YP', 'gross', 'sell');
  const sellOnlyBadges = (htmlSell.match(/SELL<\/span>/g) || []).length;
  const buyInSellBadges = (htmlSell.match(/BUY<\/span>/g) || []).length;
  assert.equal(sellOnlyBadges, 11, 'Sell filter must render only 11 SELL bubbles');
  assert.equal(buyInSellBadges, 0, 'Sell filter must have 0 BUY bubbles');
});

test('FASE 2: Mode Net balances Top Net Buyers and Top Net Sellers without duplicating brokers', () => {
  const mockNetData = [
    { broker: 'YP', bval: 120e9, sval: 20e9, nval: 100e9 },
    { broker: 'AK', bval: 110e9, sval: 20e9, nval: 90e9 },
    { broker: 'BK', bval: 100e9, sval: 20e9, nval: 80e9 },
    { broker: 'CC', bval: 90e9, sval: 20e9, nval: 70e9 },
    { broker: 'PD', bval: 80e9, sval: 20e9, nval: 60e9 },
    { broker: 'XC', bval: 10e9, sval: 110e9, nval: -100e9 },
    { broker: 'NI', bval: 10e9, sval: 100e9, nval: -90e9 },
    { broker: 'CP', bval: 10e9, sval: 90e9, nval: -80e9 },
    { broker: 'SQ', bval: 10e9, sval: 80e9, nval: -70e9 },
    { broker: 'XL', bval: 10e9, sval: 70e9, nval: -60e9 }
  ];

  const netBubbles = bandarmologiRuntime.buildBrokerBubbleItems(mockNetData, [], 'net');
  assert.equal(netBubbles.length, 10, 'Total net bubbles must be 10 (5 buyers + 5 sellers)');

  const netBuyers = netBubbles.filter(b => b.isNetBuyer);
  const netSellers = netBubbles.filter(b => !b.isNetBuyer);
  assert.equal(netBuyers.length, 5, 'Must have 5 net buyers');
  assert.equal(netSellers.length, 5, 'Must have 5 net sellers');

  // Verify that no broker appears in both net buyers and net sellers
  const buyerCodes = new Set(netBuyers.map(b => b.broker));
  for (const s of netSellers) {
    assert.ok(!buyerCodes.has(s.broker), `Broker ${s.broker} must not appear in both net buyers and net sellers`);
  }

  // Verify renderBrokerBubbleClusterHtml in Net Mode
  const html = bandarmologiRuntime.renderBrokerBubbleClusterHtml(netBubbles, 'YP', 'net', 'all');
  assert.match(html, /Semua \(10\)/, 'Must show Semua (10)');
  assert.match(html, /🟢 Buyers \(5\)/, 'Must show Buyers (5)');
  assert.match(html, /🔴 Sellers \(5\)/, 'Must show Sellers (5)');
});
