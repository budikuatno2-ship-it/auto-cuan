'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bandarmologiService = require('../lib/bandarmologi-service');
const bandarmologiRuntime = require('../public/bandarmologi-runtime');

test('Engine Data Parity: normalizeBrokerValue handles trillion scale anomalies unconditionally', () => {
  // 4.26 Triliun artifact without avgPrice/vol
  const trillionArtifact = -4260000000000;
  const normalized = bandarmologiRuntime.normalizeBrokerValue(trillionArtifact);
  assert.equal(normalized, -42600000000, 'Must unconditionally divide >= 5e11 by 100 into Miliar scale');

  const positiveTrillion = 5200000000000;
  const normPos = bandarmologiRuntime.normalizeBrokerValue(positiveTrillion);
  assert.equal(normPos, 52000000000, 'Must unconditionally divide positive >= 5e11 by 100');

  // Normal scale values below 500 Miliar should not be altered
  const normalVal = 45000000000; // 45 Miliar
  assert.equal(bandarmologiRuntime.normalizeBrokerValue(normalVal), 45000000000);
});

test('Engine Data Parity: BBCA accumulation normalizes raw trillion points into Miliar scale', () => {
  const rawData = {
    code: 'BBCA',
    accumulation_score: 82,
    series: [
      {
        broker_code: 'CC',
        broker_name: 'Mandiri Sekuritas',
        points: [
          { date: '2026-09-01', nval: -4260000000000, nvol: 5000000 },
          { date: '2026-09-02', nval: 3800000000000, nvol: 4500000 }
        ]
      },
      {
        broker_code: 'YP',
        broker_name: 'Mirae Asset Sekuritas',
        points: [
          { date: '2026-09-01', nval: 2500000000000, nvol: 3000000 },
          { date: '2026-09-02', nval: -1200000000000, nvol: 1500000 }
        ]
      }
    ]
  };

  const normAcc = bandarmologiService.normalizeBrokerAccumulation(rawData, 'BBCA');
  assert.ok(normAcc);
  assert.ok(Array.isArray(normAcc.series));
  assert.equal(normAcc.series.length, 2);

  // Series points must not be in trillions
  for (const pt of normAcc.series) {
    assert.ok(Math.abs(pt.net_val) < 5e11, `Daily net_val ${pt.net_val} must be < 500 Miliar`);
  }

  // Top buyers and top sellers must both be populated and in Miliar scale
  assert.ok(normAcc.top_buyers.length > 0, 'Top buyers must be populated');
  assert.ok(normAcc.top_sellers.length > 0, 'Top sellers must be populated');
  for (const b of normAcc.top_buyers) {
    assert.ok(Math.abs(b.nval) < 5e11, `Buyer nval ${b.nval} must be < 500 Miliar`);
  }
  for (const s of normAcc.top_sellers) {
    assert.ok(Math.abs(s.nval) < 5e11, `Seller nval ${s.nval} must be < 500 Miliar`);
  }
});

test('Bubble Synchronization: buildBrokerBubbleItems balances Top 10 Buyers and Top 10 Sellers in Net Mode', () => {
  const buyers = [
    { broker: 'YP', bval: 120000000000, sval: 20000000000, nval: 100000000000 },
    { broker: 'CC', bval: 80000000000, sval: 30000000000, nval: 50000000000 },
    { broker: 'BK', bval: 60000000000, sval: 20000000000, nval: 40000000000 }
  ];
  const sellers = [
    { broker: 'XC', bval: 10000000000, sval: 90000000000, nval: -80000000000 },
    { broker: 'NI', bval: 5000000000, sval: 45000000000, nval: -40000000000 },
    { broker: 'CP', bval: 5000000000, sval: 35000000000, nval: -30000000000 }
  ];

  const netBubbles = bandarmologiRuntime.buildBrokerBubbleItems(buyers, sellers, 'net');
  assert.equal(netBubbles.length, 6, 'Should have 6 bubbles total (3 buyers + 3 sellers)');

  const buyerBubbles = netBubbles.filter(b => b.isNetBuyer);
  const sellerBubbles = netBubbles.filter(b => !b.isNetBuyer);
  assert.equal(buyerBubbles.length, 3, 'Must have exactly 3 buyer bubbles');
  assert.equal(sellerBubbles.length, 3, 'Must have exactly 3 seller bubbles');

  // Verify renderBrokerBubbleClusterHtml
  const html = bandarmologiRuntime.renderBrokerBubbleClusterHtml(netBubbles, 'YP', 'net', 'all');
  assert.match(html, /🟢 Buyers \(3\)/, 'Pill count must show 3 buyers');
  assert.match(html, /🔴 Sellers \(3\)/, 'Pill count must show 3 sellers');
});

test('Bubble Synchronization: buildBrokerBubbleItems balances Gross Mode and preserves dual-sided brokers', () => {
  const buyers = [
    { broker: 'CC', broker_name: 'Mandiri Sekuritas', bval: 84000000, sval: 64000000, nval: 20000000 },
    { broker: 'YP', broker_name: 'Mirae Asset', bval: 50000000, nval: 40000000 }
  ];
  const sellers = [
    { broker: 'CC', broker_name: 'Mandiri Sekuritas', bval: 84000000, sval: 64000000, nval: 20000000 },
    { broker: 'XC', broker_name: 'Ajaib', bval: 0, sval: 45000000, nval: -45000000 }
  ];

  const grossBubbles = bandarmologiRuntime.buildBrokerBubbleItems(buyers, sellers, 'gross');
  const cc = grossBubbles.find(b => b.broker === 'CC');
  assert.ok(cc, 'CC must be present');
  assert.equal(cc.bval, 84000000, 'CC buy value must be 84M');
  assert.equal(cc.sval, 64000000, 'CC sell value must be 64M');

  const html = bandarmologiRuntime.renderBrokerBubbleClusterHtml(grossBubbles, 'CC', 'gross', 'all');
  assert.match(html, /🟢 Buyers \(2\)/, 'Must show 2 buyers');
  assert.match(html, /🔴 Sellers \(2\)/, 'Must show 2 sellers');

  // When filtering by sell side, sell value is rendered
  const htmlSell = bandarmologiRuntime.renderBrokerBubbleClusterHtml(grossBubbles, 'CC', 'gross', 'sell');
  assert.match(htmlSell, /-64(\.0)?\s*[Jj]t/, 'Sell filter must display sell value for CC');
});

test('Partition Guard: recovers sellers when raw seller list is empty but buyer list contains sellers', () => {
  const allMixedInBuyers = [
    { broker: 'YP', bval: 100000000, sval: 0, nval: 100000000 },
    { broker: 'BK', bval: 80000000, sval: 0, nval: 80000000 },
    { broker: 'XC', bval: 0, sval: 70000000, nval: -70000000 },
    { broker: 'NI', bval: 0, sval: 50000000, nval: -50000000 }
  ];

  const items = bandarmologiRuntime.buildBrokerBubbleItems(allMixedInBuyers, [], 'net');
  const buyers = items.filter(b => b.isNetBuyer);
  const sellers = items.filter(b => !b.isNetBuyer);

  assert.equal(buyers.length, 2, 'Should extract 2 buyers');
  assert.equal(sellers.length, 2, 'Should extract 2 sellers despite empty seller input array');
  assert.equal(sellers[0].broker, 'XC');
  assert.equal(sellers[1].broker, 'NI');
});

test('Multi-Day Aggregation: 7D range scales values and attaches range_label', async () => {
  const data1d = await bandarmologiService.getBandarmologiData('BBCA', { range: '1d' });
  assert.ok(data1d.success);
  assert.ok(data1d.broker_summary);
  const flow1d = Math.abs(data1d.broker_summary.net_flow || 0);

  const data7d = await bandarmologiService.getBandarmologiData('BBCA', { range: '7d' });
  assert.ok(data7d.success);
  assert.ok(data7d.broker_summary);
  assert.ok(data7d.broker_summary.range_label, '7D must include range_label');
  assert.match(data7d.broker_summary.range_label, /7 Hari/, 'range_label must mention 7 Hari');

  const flow7d = Math.abs(data7d.broker_summary.net_flow || 0);
  if (flow1d > 0) {
    assert.ok(flow7d > flow1d, `7D net flow (${flow7d}) should be aggregated/larger than 1D (${flow1d})`);
  }
});
