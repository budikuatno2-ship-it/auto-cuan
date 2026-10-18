'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const broksumFlow = require('../lib/broksum-flow');
const bandarmologiService = require('../lib/bandarmologi-service');

test('Langkah 3: Pengaman Domestik saat all terpotong (25 levels) vs all lengkap', async (t) => {
  await t.test('all terpotong (25 broker levels) + F lengkap -> domestik ditandai belum lengkap', () => {
    // 25 levels without all_data: true
    const brokerLevels25 = [];
    for (let i = 1; i <= 25; i++) {
      brokerLevels25.push({
        buy: { broker_code: `B${i}`, bval: 1000000000, bvol: 10000, bfrq: 10 },
        sell: { broker_code: `S${i}`, sval: 1000000000, svol: 10000, sfrq: 10 }
      });
    }

    const allClipped = {
      stock_code: 'BBCA',
      broker_start_date: '2026-06-02',
      broker_end_date: '2026-06-02',
      flow: 'all',
      broker_levels: brokerLevels25
      // all_data is undefined/false
    };

    const foreignComplete = {
      stock_code: 'BBCA',
      broker_start_date: '2026-06-02',
      broker_end_date: '2026-06-02',
      flow: 'F',
      brokers: [
        { broker_code: 'AK', bval: 500000000, bvol: 5000, sval: 200000000, svol: 2000, bfrq: 5, sfrq: 2 },
        { broker_code: 'BK', bval: 300000000, bvol: 3000, sval: 100000000, svol: 1000, bfrq: 3, sfrq: 1 }
      ]
    };

    const dom = broksumFlow.computeDomestic(allClipped, foreignComplete);
    assert.ok(dom, 'Domestic result should exist');
    assert.equal(dom.flow, 'D');
    assert.equal(dom.is_complete, false, 'Should be flagged as incomplete');
    assert.equal(dom.status, 'incomplete');
    assert.equal(dom.message, 'belum lengkap · menunggu data lengkap');
    assert.equal(dom.reason, 'all_clipped_25');

    // Also test service normalization
    const normDom = bandarmologiService.normalizeBrokerSummary(dom, '2026-06-02', 'BBCA');
    assert.equal(normDom.is_complete, false);
    assert.equal(normDom.status, 'incomplete');
    assert.equal(normDom.net_status, 'INCOMPLETE');
    assert.equal(normDom.net_label, 'belum lengkap · menunggu data lengkap');
    assert.equal(normDom.net_flow_formatted, 'belum lengkap · menunggu data lengkap');

    // Foreign remains completely normal
    const normF = bandarmologiService.normalizeBrokerSummary(foreignComplete, '2026-06-02', 'BBCA');
    assert.equal(normF.is_complete, true);
    assert.notEqual(normF.net_status, 'INCOMPLETE');
  });

  await t.test('all lengkap (all_data: true) + F lengkap -> domestik = all - F tanpa nilai minus', () => {
    // 25 levels BUT marked all_data: true
    const brokerLevels = [
      {
        buy: { broker_code: 'YP', bval: 1000000000, bvol: 10000, bfrq: 10 },
        sell: { broker_code: 'PD', sval: 800000000, svol: 8000, sfrq: 8 }
      },
      {
        buy: { broker_code: 'AK', bval: 1500000000, bvol: 15000, bfrq: 15 },
        sell: { broker_code: 'AK', sval: 500000000, svol: 5000, sfrq: 5 }
      }
    ];

    const allComplete = {
      stock_code: 'BBCA',
      broker_start_date: '2026-06-02',
      broker_end_date: '2026-06-02',
      flow: 'all',
      all_data: true,
      broker_levels: brokerLevels
    };

    const foreignComplete = {
      stock_code: 'BBCA',
      broker_start_date: '2026-06-02',
      broker_end_date: '2026-06-02',
      flow: 'F',
      brokers: [
        // AK foreign buy: 1.000.000.000, foreign sell: 200.000.000
        { broker_code: 'AK', bval: 1000000000, bvol: 10000, sval: 200000000, svol: 2000, bfrq: 10, sfrq: 2 }
      ]
    };

    const dom = broksumFlow.computeDomestic(allComplete, foreignComplete);
    assert.ok(dom);
    assert.equal(dom.flow, 'D');
    assert.equal(dom.is_complete, true);
    assert.equal(dom.status, 'complete');

    // Verify AK domestic:
    // AK bval = All (1.500.000.000) - F (1.000.000.000) = 500.000.000
    // AK sval = All (500.000.000) - F (200.000.000) = 300.000.000
    const akDom = dom.brokers.find(b => b.broker_code === 'AK');
    assert.ok(akDom, 'AK should exist in domestic brokers');
    assert.equal(akDom.bval, 500000000);
    assert.equal(akDom.sval, 300000000);
    assert.equal(akDom.nval, 200000000);

    // Verify YP domestic: All (1.000.000.000) - F (0) = 1.000.000.000
    const ypDom = dom.brokers.find(b => b.broker_code === 'YP');
    assert.ok(ypDom, 'YP should exist in domestic brokers');
    assert.equal(ypDom.bval, 1000000000);

    // Verify absolutely no negative numbers across all domestic brokers
    for (const b of dom.brokers) {
      assert.ok(b.bval >= 0, `Broker ${b.broker_code} bval cannot be negative: ${b.bval}`);
      assert.ok(b.sval >= 0, `Broker ${b.broker_code} sval cannot be negative: ${b.sval}`);
      assert.ok(b.bvol >= 0, `Broker ${b.broker_code} bvol cannot be negative: ${b.bvol}`);
      assert.ok(b.svol >= 0, `Broker ${b.broker_code} svol cannot be negative: ${b.svol}`);
    }
  });
});
