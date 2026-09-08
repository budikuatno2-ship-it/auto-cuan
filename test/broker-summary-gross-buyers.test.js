'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const bandarmologiRuntime = require('../public/bandarmologi-runtime');
const bandarmologiService = require('../lib/bandarmologi-service');
const brokerHunterService = require('../lib/broker-hunter-service');

test('Broker Summary Gross Mode: dual-sided broker CC is classified as net buyer with positive net value', () => {
  const buyers = [
    { broker: 'CC', broker_name: 'Mandiri Sekuritas', bval: 84000000, bvol: 10000, nval: 20000000 },
    { broker: 'YP', broker_name: 'Mirae Asset', bval: 50000000, bvol: 6000, nval: 30000000 }
  ];
  const sellers = [
    { broker: 'CC', broker_name: 'Mandiri Sekuritas', sval: 64000000, svol: 8000, nval: 20000000 },
    { broker: 'XC', broker_name: 'Ajaib', sval: 45000000, svol: 5000, nval: -45000000 }
  ];

  const grossItems = bandarmologiRuntime.buildBrokerBubbleItems(buyers, sellers, 'gross');
  const cc = grossItems.find(b => b.broker === 'CC');

  assert.ok(cc, 'Broker CC must be present in items');
  assert.equal(cc.bval, 84000000, 'CC bval should be 84M');
  assert.equal(cc.sval, 64000000, 'CC sval should be 64M');
  assert.equal(cc.isNetBuyer, true, 'CC should be net buyer because bval (84M) >= sval (64M)');
  assert.equal(cc.netVal, 20000000, 'CC net value should be positive 20M, not overwritten into negative');
  assert.equal(cc.txVal, 84000000, 'CC gross txVal should be max(bval, sval) = 84M');

  // Verify renderBrokerBubbleClusterHtml in gross mode
  const htmlGross = bandarmologiRuntime.renderBrokerBubbleClusterHtml(grossItems, 'CC', 'gross', 'all');
  assert.match(htmlGross, /🟢 Buyers \(2\)/, 'Gross mode should show 2 buyers having bval > 0');
  assert.match(htmlGross, /🔴 Sellers \(2\)/, 'Gross mode should show 2 sellers having sval > 0');
});

test('Broker Summary Net Mode: correctly separates buyers and sellers by net value', () => {
  const buyers = [
    { broker: 'AK', bval: 50000000, sval: 10000000, nval: 40000000 },
    { broker: 'BK', bval: 30000000, sval: 0, nval: 30000000 }
  ];
  const sellers = [
    { broker: 'NI', bval: 5000000, sval: 25000000, nval: -20000000 }
  ];

  const netItems = bandarmologiRuntime.buildBrokerBubbleItems(buyers, sellers, 'net');
  const ak = netItems.find(b => b.broker === 'AK');
  const ni = netItems.find(b => b.broker === 'NI');

  assert.equal(ak.isNetBuyer, true);
  assert.equal(ni.isNetBuyer, false);

  const htmlNet = bandarmologiRuntime.renderBrokerBubbleClusterHtml(netItems, 'AK', 'net', 'all');
  assert.match(htmlNet, /🟢 Buyers \(2\)/);
  assert.match(htmlNet, /🔴 Sellers \(1\)/);
});

test('Broker Accumulation: normalizeBrokerAccumulation partitions negative net items into net_sellers', () => {
  const rawFlattened = {
    code: 'BBCA',
    series: [{ date: '2026-09-04', net_val: 10000000, status: 'ACC' }],
    top_buyers: [
      { broker: 'YP', bval: 100000000, sval: 20000000, nval: 80000000 },
      { broker: 'XC', bval: 10000000, sval: 50000000, nval: -40000000 }
    ],
    net_buyers: [
      { broker: 'YP', bval: 100000000, sval: 20000000, nval: 80000000 },
      { broker: 'XC', bval: 10000000, sval: 50000000, nval: -40000000 }
    ],
    net_sellers: [] // Previously empty, causing Sellers (0)
  };

  const norm = bandarmologiService.normalizeBrokerAccumulation(rawFlattened, 'BBCA');
  assert.ok(norm.net_buyers.length > 0, 'net_buyers should have items');
  assert.ok(norm.net_sellers.length > 0, 'net_sellers should not be empty');
  assert.equal(norm.net_sellers[0].broker, 'XC', 'XC with negative net value should be moved to net_sellers');
});

test('Multi-Day Range: demo and multi-day aggregation provides range_label and scales correctly', async () => {
  const res1d = await bandarmologiService.getBandarmologiData('BBCA', { range: '1d' });
  assert.equal(res1d.success, true);
  assert.ok(res1d.broker_summary.range_label || res1d.broker_summary.date);

  const res7d = await bandarmologiService.getBandarmologiData('BBCA', { range: '7d', days: 7 });
  assert.equal(res7d.success, true);
  assert.ok(res7d.broker_summary.range_label, '7d response must have range_label');
  assert.match(res7d.broker_summary.range_label, /7 Hari Bursa/);

  // If using demo fallback or aggregate, 7D net_flow or values are scaled
  if (res7d.is_demo && res1d.is_demo) {
    assert.ok(Math.abs(res7d.broker_summary.net_flow) >= Math.abs(res1d.broker_summary.net_flow) * 4, '7D net flow should be scaled multi-day');
  }
});

test('Broker Hunter Contract: getBrokerHunterData returns non-empty stocks active', async () => {
  const res = await brokerHunterService.getBrokerHunterData('AK', { range: '1d' });
  assert.equal(res.success, true);
  assert.equal(res.broker, 'AK');
  assert.ok(res.total_stocks_active > 0, 'Broker Hunter must never return total_stocks_active: 0');
  assert.ok(res.top_accumulated.length > 0, 'top_accumulated must not be empty');
  assert.ok(res.top_distributed.length > 0, 'top_distributed must not be empty');
  assert.ok(res.date_range_label, 'date_range_label must be present');
});
