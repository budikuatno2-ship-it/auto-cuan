'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bandarmologiRuntime = require('../public/bandarmologi-runtime.js');

test('BROKER_NAMES dictionary: covers major Indonesian brokers', () => {
  const names = bandarmologiRuntime.BROKER_NAMES;
  assert.ok(names, 'BROKER_NAMES exists');
  assert.equal(names.YP, 'Mirae Asset Sekuritas Indonesia');
  assert.equal(names.CC, 'Mandiri Sekuritas');
  assert.equal(names.PD, 'Indo Premier Sekuritas');
  assert.equal(names.BK, 'J.P. Morgan Sekuritas Indonesia');
  assert.equal(names.AK, 'UBS Sekuritas Indonesia');
  assert.equal(names.XC, 'Ajaib Sekuritas Asia');
  assert.equal(names.NI, 'BNI Sekuritas');
  assert.equal(names.CP, 'KB Valbury Sekuritas');
  assert.equal(names.GR, 'Panin Sekuritas');
  assert.equal(names.MG, 'Semesta Indovest Sekuritas');
});

test('getBrokerSecurityName: returns full security name or falls back gracefully', () => {
  assert.equal(bandarmologiRuntime.getBrokerSecurityName('YP'), 'Mirae Asset Sekuritas Indonesia');
  assert.equal(bandarmologiRuntime.getBrokerSecurityName('CC', 'Fallback Mandiri'), 'Mandiri Sekuritas');
  assert.equal(bandarmologiRuntime.getBrokerSecurityName('ZZ', 'Custom Broker ZZ'), 'Custom Broker ZZ');
  assert.equal(bandarmologiRuntime.getBrokerSecurityName('UNKNOWN'), 'Broker UNKNOWN');
});

test('buildBrokerBubbleItems: merges buyers and sellers, calculates proportions and 3-tier colors', () => {
  const buyers = [
    { broker: 'YP', broker_name: 'Mirae Asset', bval: 120000000000, sval: 20000000000, bvol: 1000000, svol: 200000, bfrq: 1500, sfrq: 300, avg_price: 9800 },
    { broker: 'CC', broker_name: 'Mandiri', bval: 50000000000, sval: 10000000000, bvol: 500000, svol: 100000, bfrq: 800, sfrq: 150, avg_price: 9800 },
    { broker: 'PD', broker_name: 'Indo Premier', bval: 15000000000, sval: 5000000000, bvol: 150000, svol: 50000, bfrq: 200, sfrq: 80, avg_price: 9800 }
  ];
  const sellers = [
    { broker: 'XC', broker_name: 'Ajaib', sval: 90000000000, bval: 10000000000, svol: 900000, bvol: 100000, sfrq: 1200, bfrq: 200, avg_price: 9800 },
    { broker: 'NI', broker_name: 'BNI', sval: 40000000000, bval: 5000000000, svol: 400000, bvol: 50000, sfrq: 600, bfrq: 100, avg_price: 9800 },
    { broker: 'MG', broker_name: 'Semesta', sval: 12000000000, bval: 2000000000, svol: 120000, bvol: 20000, sfrq: 150, bfrq: 40, avg_price: 9800 }
  ];

  // Test Gross mode
  const grossItems = bandarmologiRuntime.buildBrokerBubbleItems(buyers, sellers, 'gross');
  assert.equal(grossItems.length, 6);

  // Highest broker should be YP (max of 120B vs 20B is 120B)
  const yp = grossItems.find(b => b.broker === 'YP');
  assert.ok(yp);
  assert.equal(yp.fullName, 'Mirae Asset Sekuritas Indonesia');
  assert.equal(yp.isNetBuyer, true);
  assert.equal(yp.netVal, 100000000000);
  assert.equal(yp.txVal, 120000000000);
  assert.equal(yp.colorTier, 3, 'YP should be Tier 3 (deep green) due to dominant net buy');
  assert.ok(yp.size >= 90, 'Dominant broker diameter should be near top scale >= 90px');

  // XC should be top seller
  const xc = grossItems.find(b => b.broker === 'XC');
  assert.ok(xc);
  assert.equal(xc.isNetBuyer, false);
  assert.equal(xc.colorTier, 3, 'XC should be Tier 3 (crimson red) due to dominant net sell');

  // Smallest brokers should have Tier 1 or 2
  const mg = grossItems.find(b => b.broker === 'MG');
  assert.ok(mg);
  assert.equal(mg.colorTier <= 2, true);
  assert.ok(mg.size >= 56 && mg.size <= 80, 'Small broker size should be near min bound 56-80px');

  // Test Net mode
  const netItems = bandarmologiRuntime.buildBrokerBubbleItems(buyers, sellers, 'net');
  assert.equal(netItems.length, 6);
  const ypNet = netItems.find(b => b.broker === 'YP');
  assert.equal(ypNet.txVal, 100000000000, 'In net mode, txVal should equal abs(netVal)');
});

test('renderBrokerDetailCardHtml: produces complete card with full name, comparison bar, and 6 stats', () => {
  const broker = {
    broker: 'YP',
    fullName: 'Mirae Asset Sekuritas Indonesia',
    bval: 122500000000,
    sval: 77500000000,
    bvol: 12500000,
    svol: 7900000,
    bfrq: 3120,
    sfrq: 1840,
    netVal: 45000000000,
    nvol: 4600000,
    avgBuy: 9800,
    avgSell: 9810,
    isNetBuyer: true,
    txVal: 122500000000
  };

  const html = bandarmologiRuntime.renderBrokerDetailCardHtml(broker, 'gross');
  assert.ok(html.includes('Mirae Asset Sekuritas Indonesia'));
  assert.ok(html.includes('YP'));
  assert.ok(html.includes('NET BUYER'));
  assert.ok(html.includes('Volume Beli'));
  assert.ok(html.includes('Volume Jual'));
  assert.ok(html.includes('Net Volume'));
  assert.ok(html.includes('Frekuensi Order'));
  assert.ok(html.includes('Avg Harga Beli'));
  assert.ok(html.includes('Avg Harga Jual'));
  assert.ok(html.includes('@ Rp 9.800'));
});

test('buildBrokerBubbleItems: net seller broker (sval > bval) gets isNetBuyer=false correctly', () => {
  // Simulates aggregated data where a broker appears only in sellers list
  const buyers = [];
  const sellers = [
    {
      broker: 'RX',
      broker_name: 'Macquarie',
      bval: 10000000000,
      sval: 80000000000,
      bvol: 1000000,
      svol: 8000000,
      bfrq: 100,
      sfrq: 500,
      nval: -70000000000,
      net_val: -70000000000,
      nvol: -7000000
    }
  ];
  const items = bandarmologiRuntime.buildBrokerBubbleItems(buyers, sellers, 'gross');
  assert.equal(items.length, 1);
  const rx = items[0];
  assert.equal(rx.broker, 'RX');
  assert.equal(rx.isNetBuyer, false, 'Net seller must have isNetBuyer=false');
  assert.ok(rx.netVal < 0, 'netVal must be negative for net seller');
  assert.equal(rx.sval, 80000000000);
});

test('buildBrokerBubbleItems: avgSell computed from svol when avg_price not available', () => {
  const buyers = [];
  const sellers = [
    {
      broker: 'CC',
      broker_name: 'Mandiri Sekuritas',
      bval: 0,
      sval: 50000000000,
      bvol: 0,
      svol: 5000000,
      bfrq: 0,
      sfrq: 300,
      nval: -50000000000
    }
  ];
  const items = bandarmologiRuntime.buildBrokerBubbleItems(buyers, sellers, 'gross');
  const cc = items.find(b => b.broker === 'CC');
  assert.ok(cc, 'CC must exist');
  assert.ok(cc.avgSell > 0, 'avgSell must be computed from sval/svol when avg_price not present');
  assert.equal(cc.avgSell, 10000); // 50000000000 / 5000000 = 10000
});

// Regression: the "Semua" (all) flow bubble view showed every broker as BUY
// with "Sellers (0)", because `bSum.gross_sellers || bSum.top_sellers || []`
// does not fall back past an empty array (`[]` is truthy in JS) — an empty
// gross_sellers field silently discarded a populated top_sellers, so
// buildBrokerBubbleItems never even ran its seller-side loop.
test('firstNonEmptyList: falls back past an empty array (unlike `||`), never past a populated one', () => {
  const populatedSellers = [{ broker: 'AK', bval: 0, sval: 5000000 }];
  assert.deepEqual(bandarmologiRuntime.firstNonEmptyList([], populatedSellers), populatedSellers, 'an empty first candidate must not shadow a populated fallback');
  assert.deepEqual(bandarmologiRuntime.firstNonEmptyList(undefined, populatedSellers), populatedSellers, 'a missing first candidate must fall back too');
  assert.deepEqual(bandarmologiRuntime.firstNonEmptyList(populatedSellers, []), populatedSellers, 'a populated first candidate must win over the fallback');
  assert.deepEqual(bandarmologiRuntime.firstNonEmptyList([], []), [], 'every candidate empty must resolve to [], not throw or return undefined');
  assert.deepEqual(bandarmologiRuntime.firstNonEmptyList(), [], 'no arguments at all must resolve to []');
});
