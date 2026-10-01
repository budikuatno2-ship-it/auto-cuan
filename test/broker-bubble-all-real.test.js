'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const bandarmologiRuntime = require('../public/bandarmologi-runtime');

test('PR #4 Dynamic Broker Universe: Renders all real active brokers without artificial .slice()', () => {
  // Scenario A: 24 active buyers, 18 active sellers
  const mockBuyers24 = [];
  for (let i = 1; i <= 24; i++) {
    const code = 'B' + (i < 10 ? '0' + i : i);
    mockBuyers24.push({
      broker: code,
      bval: (30 - i) * 1e9,
      sval: 0,
      bvol: 10000,
      svol: 0
    });
  }

  const mockSellers18 = [];
  for (let j = 1; j <= 18; j++) {
    const code = 'S' + (j < 10 ? '0' + j : j);
    mockSellers18.push({
      broker: code,
      bval: 0,
      sval: (25 - j) * 1e9,
      bvol: 0,
      svol: 8000
    });
  }

  // Gross Mode: 24 buyers + 18 sellers = 42 bubbles
  const grossBubbles = bandarmologiRuntime.buildBrokerBubbleItems(mockBuyers24, mockSellers18, 'gross');
  assert.equal(grossBubbles.length, 42, 'Gross mode must render all 42 bubbles without slicing to 11 or 20');

  const buyersList = grossBubbles.filter(b => b.side === 'buy' || b.isBuyer);
  const sellersList = grossBubbles.filter(b => b.side === 'sell' || !b.isBuyer);
  assert.equal(buyersList.length, 24, 'Must render all 24 real buyers');
  assert.equal(sellersList.length, 18, 'Must render all 18 real sellers');

  // Verify pills show exact dynamic counts: Semua (42), Buyers (24), Sellers (18)
  const html = bandarmologiRuntime.renderBrokerBubbleClusterHtml(grossBubbles, 'B01', 'gross', 'all');
  assert.match(html, /Semua \(42\)/, 'Pill must render Semua (42)');
  assert.match(html, /🟢 Buyers \(24\)/, 'Pill must render 🟢 Buyers (24)');
  assert.match(html, /🔴 Sellers \(18\)/, 'Pill must render 🔴 Sellers (18)');
});

test('PR #4 High-Density Universe: 50+ brokers scale gracefully in flex-wrap container', () => {
  // Scenario B: 35 pure buyers and 30 pure sellers (total 65 active brokers)
  const mockBuyers35 = [];
  for (let i = 1; i <= 35; i++) {
    mockBuyers35.push({
      broker: 'K' + (i < 10 ? '0' + i : i),
      bval: (40 - i) * 1e9,
      sval: 0,
      nval: (40 - i) * 1e9
    });
  }

  const mockSellers30 = [];
  for (let j = 1; j <= 30; j++) {
    mockSellers30.push({
      broker: 'Z' + (j < 10 ? '0' + j : j),
      bval: 0,
      sval: (35 - j) * 1e9,
      nval: -(35 - j) * 1e9
    });
  }

  const grossItems = bandarmologiRuntime.buildBrokerBubbleItems(mockBuyers35, mockSellers30, 'gross');
  assert.equal(grossItems.length, 65, 'Must render all 65 brokers dynamically');

  // Verify diameter density scaling clamped appropriately for high-density universe
  for (const item of grossItems) {
    assert.ok(item.size >= 44 && item.size <= 88, `Bubble diameter (${item.size}px) must be clamped for high density`);
  }

  const html = bandarmologiRuntime.renderBrokerBubbleClusterHtml(grossItems, 'K01', 'gross', 'all');
  assert.ok(html.includes('id="brokerBubbleClusterContainer"'), 'Must have cluster container');
  assert.ok(html.includes('flex flex-wrap'), 'Must use flex-wrap layout');
  assert.match(html, /Semua \(65\)/);
  assert.match(html, /🟢 Buyers \(35\)/);
  assert.match(html, /🔴 Sellers \(30\)/);
});

test('PR #4 Net Mode Dynamic Rendering: Preserves all net buyers and net sellers without artificial bounds', () => {
  // 17 net buyers and 14 net sellers
  const mockNet = [];
  for (let i = 1; i <= 17; i++) {
    mockNet.push({
      broker: 'NB' + (i < 10 ? '0' + i : i),
      bval: 20e9,
      sval: 5e9,
      nval: 15e9
    });
  }
  for (let j = 1; j <= 14; j++) {
    mockNet.push({
      broker: 'NS' + (j < 10 ? '0' + j : j),
      bval: 5e9,
      sval: 20e9,
      nval: -15e9
    });
  }

  const netItems = bandarmologiRuntime.buildBrokerBubbleItems(mockNet, [], 'net');
  assert.equal(netItems.length, 31, 'Net mode must render all 31 brokers (17 buyers + 14 sellers)');

  const buyers = netItems.filter(b => b.isNetBuyer);
  const sellers = netItems.filter(b => !b.isNetBuyer);
  assert.equal(buyers.length, 17, 'Must have all 17 net buyers');
  assert.equal(sellers.length, 14, 'Must have all 14 net sellers');

  const html = bandarmologiRuntime.renderBrokerBubbleClusterHtml(netItems, 'NB01', 'net', 'all');
  assert.match(html, /Semua \(31\)/);
  assert.match(html, /🟢 Buyers \(17\)/);
  assert.match(html, /🔴 Sellers \(14\)/);
});
