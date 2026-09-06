'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const arjumClient = require('../lib/arjum-client');
const bandarmologiService = require('../lib/bandarmologi-service');
const sectorHot = require('../api/sector-hot');

test('arjumClient: cleanTicker cleans non-alphanumerics and normalizes to uppercase', () => {
  assert.equal(arjumClient.cleanTicker('bbca'), 'BBCA');
  assert.equal(arjumClient.cleanTicker(' BBRI.JK '), 'BBRIJK');
  assert.equal(arjumClient.cleanTicker(null), '');
});

test('arjumClient: hasArjumApiKey checks environment variable safely without leaking', () => {
  const isConfigured = arjumClient.hasArjumApiKey();
  assert.equal(typeof isConfigured, 'boolean');
});

test('bandarmologiService: generateDemoData produces complete structure for UI', () => {
  const data = bandarmologiService.generateDemoData('BBCA', '2026-09-04');
  assert.equal(data.ticker, 'BBCA');
  assert.equal(data.date, '2026-09-04');
  assert.equal(data.is_demo, true);
  assert.ok(data.broker_summary);
  assert.ok(data.broker_summary.top_buyers.length >= 5);
  assert.ok(data.broker_summary.top_sellers.length >= 5);
  assert.ok(data.broker_accumulation);
  assert.ok(Array.isArray(data.broker_accumulation.series));
  assert.ok(Array.isArray(data.insiders));
});

test('bandarmologiService: getBandarmologiData returns demo fallback gracefully when key is unset', async () => {
  const res = await bandarmologiService.getBandarmologiData('BBRI');
  assert.equal(res.success, true);
  assert.equal(res.ticker, 'BBRI');
  assert.ok(res.broker_summary);
  assert.ok(res.broker_accumulation);
  assert.ok(res.insiders);
});

test('sectorHot: handleBandarmologi responds with status 200 and payload', async () => {
  const handler = sectorHot.__test.handleBandarmologi;
  assert.equal(typeof handler, 'function');

  let statusCode = 0;
  let responseData = null;

  const req = {
    query: { ticker: 'TLKM' }
  };
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(data) {
      responseData = data;
      return this;
    }
  };

  await handler(req, res);
  assert.equal(statusCode, 200);
  assert.equal(responseData.success, true);
  assert.equal(responseData.ticker, 'TLKM');
});

test('bandarmologiService: normalizeBrokerSummary converts raw broker_levels to top_buyers/sellers', () => {
  const raw = {
    stock_code: 'BBCA',
    broker_start_date: '2026-09-04',
    broker_end_date: '2026-09-04',
    broker_levels: [
      {
        buy: { broker_code: 'YU', broker_name: 'CGS', bval: 154000000, bvol: 22000, bavg: 7000 },
        sell: { broker_code: 'AK', broker_name: 'UBS', sval: 120000000, svol: 17000, savg: 7050 }
      }
    ]
  };

  const norm = bandarmologiService.normalizeBrokerSummary(raw, '2026-09-04');
  assert.equal(norm.date, '2026-09-04');
  assert.equal(norm.top_buyers[0].broker, 'YU');
  assert.equal(norm.top_sellers[0].broker, 'AK');
  assert.equal(norm.net_status, 'BIG_ACCUMULATION');
  assert.ok(Array.isArray(norm.gross_buyers));
  assert.ok(Array.isArray(norm.net_buyers));
});

test('bandarmologiService: normalizeBrokerSummary handles full raw brokers array with gross and net fields', () => {
  const rawWithBrokers = {
    stock_code: 'BBCA',
    date: '2026-09-04',
    brokers: [
      { broker_code: 'YU', broker_name: 'CGS', bval: 154000, sval: 15000, bvol: 2200, svol: 200, bfrq: 240, sfrq: 30, nval: 139000, nvol: 2000 },
      { broker_code: 'AK', broker_name: 'UBS', bval: 20000, sval: 120000, bvol: 300, svol: 1700, bfrq: 50, sfrq: 180, nval: -100000, nvol: -1400 }
    ]
  };

  const norm = bandarmologiService.normalizeBrokerSummary(rawWithBrokers, '2026-09-04');
  assert.equal(norm.gross_buyers[0].broker, 'YU');
  assert.equal(norm.gross_buyers[0].bval, 154000);
  assert.equal(norm.gross_buyers[0].sval, 15000);
  assert.equal(norm.gross_buyers[0].bfrq, 240);
  assert.equal(norm.gross_buyers[0].sfrq, 30);
  assert.equal(norm.gross_buyers[0].nval, 139000);

  assert.equal(norm.gross_sellers[0].broker, 'AK');
  assert.equal(norm.gross_sellers[0].sval, 120000);
  assert.equal(norm.gross_sellers[0].bval, 20000);

  assert.equal(norm.net_buyers[0].broker, 'YU');
  assert.equal(norm.net_buyers[0].nval, 139000);
  assert.equal(norm.net_sellers[0].broker, 'AK');
  assert.equal(norm.net_sellers[0].nval, -100000);
});

// Regression: header badge (net_label/net_status) must track the actual net
// flow direction, not get overridden by which list (buyer/seller) an item
// arrived in — the same class of bug fixed for the bubble visualization in
// PR #550 (isBuyerList overriding explicitNetVal).
test('bandarmologiService: normalizeBrokerSummary badge shows Big Distribution when sellers dominate', () => {
  const rawSellHeavy = {
    stock_code: 'BBCA',
    date: '2026-09-04',
    brokers: [
      { broker_code: 'YU', broker_name: 'CGS', bval: 20000, sval: 15000, bvol: 300, svol: 200, nval: 5000, nvol: 100 },
      { broker_code: 'AK', broker_name: 'UBS', bval: 10000, sval: 200000, bvol: 100, svol: 2500, nval: -190000, nvol: -2400 }
    ]
  };

  const norm = bandarmologiService.normalizeBrokerSummary(rawSellHeavy, '2026-09-04');
  assert.equal(norm.net_status, 'BIG_DISTRIBUTION');
  assert.equal(norm.net_label, 'Big Distribution');
  assert.ok(norm.net_flow < 0);
});

test('bandarmologiService: normalizeBrokerSummary badge respects explicit net_val even for pure seller items', () => {
  // Seller-side items reported with only net_val (no explicit sval) must not
  // have their sign flipped by an isBuyer-style override when computing the
  // net flow direction feeding the badge.
  const rawNetValOnly = {
    stock_code: 'BBCA',
    date: '2026-09-04',
    brokers: [
      { broker_code: 'YU', broker_name: 'CGS', net_val: 8000 },
      { broker_code: 'AK', broker_name: 'UBS', net_val: -50000 }
    ]
  };

  const norm = bandarmologiService.normalizeBrokerSummary(rawNetValOnly, '2026-09-04');
  assert.equal(norm.net_status, 'BIG_DISTRIBUTION');
  assert.equal(norm.net_label, 'Big Distribution');
});

test('bandarmologiService: normalizeBrokerAccumulation builds daily series per date', () => {
  const raw = {
    code: 'BBCA',
    series: [
      {
        broker_code: 'AK',
        points: [
          { date: '2026-09-03', nval: 10000000 },
          { date: '2026-09-04', nval: -5000000 }
        ]
      },
      {
        broker_code: 'YU',
        points: [
          { date: '2026-09-03', nval: 20000000 },
          { date: '2026-09-04', nval: 15000000 }
        ]
      }
    ]
  };

  const norm = bandarmologiService.normalizeBrokerAccumulation(raw, 'BBCA');
  assert.equal(norm.series.length, 2);
  assert.equal(norm.series[0].date, '2026-09-03');
  assert.equal(norm.series[0].net_val, 30000000);
  assert.equal(norm.series[1].date, '2026-09-04');
  assert.equal(norm.series[1].net_val, 10000000);
});

test('bandarmologiService: readDiskCache does NOT fallback to other dates when specific date identifier is missing', () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'arjum-cache-test-'));
  const testDir = path.join(tmpBase, 'broker-summary', 'TEST_TICKER');
  fs.mkdirSync(testDir, { recursive: true });

  // Save only 2026-08-03.json
  const fileData = { date: '2026-08-03', stock_code: 'TEST_TICKER', net_status: 'ACC' };
  fs.writeFileSync(path.join(testDir, '2026-08-03.json'), JSON.stringify(fileData));

  const origEnv = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmpBase;

  try {
    // 1. Exact existing date returns exact file
    const exact = bandarmologiService.readDiskCache('broker-summary', 'TEST_TICKER', '2026-08-03');
    assert.ok(exact, '2026-08-03 must exist');
    assert.equal(exact.date, '2026-08-03');
    assert.equal(bandarmologiService.hasDiskCache('broker-summary', 'TEST_TICKER', '2026-08-03'), true);

    // 2. Unsaved date MUST return null, NOT 2026-08-03
    const missing = bandarmologiService.readDiskCache('broker-summary', 'TEST_TICKER', '2026-08-04');
    assert.equal(missing, null, 'readDiskCache must return null for missing date, never return other dates as false fallback');
    assert.equal(bandarmologiService.hasDiskCache('broker-summary', 'TEST_TICKER', '2026-08-04'), false);

    // 3. Requesting 'latest' or omitting identifier falls back to newest available file
    const latest = bandarmologiService.readDiskCache('broker-summary', 'TEST_TICKER', 'latest');
    assert.ok(latest, 'latest can fall back to newest file');
    assert.equal(latest.date, '2026-08-03');
    assert.equal(bandarmologiService.hasDiskCache('broker-summary', 'TEST_TICKER', 'latest'), true);
  } finally {
    if (origEnv !== undefined) {
      process.env.ARJUM_DATA_DIR = origEnv;
    } else {
      delete process.env.ARJUM_DATA_DIR;
    }
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('bandarmologiService: aggregateBrokerSummaries sums transaction metrics across multiple dates', () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'arjum-agg-test-'));
  const testDir = path.join(tmpBase, 'broker-summary', 'TEST_AGGR');
  fs.mkdirSync(testDir, { recursive: true });

  // Day 1
  const day1 = {
    date: '2026-08-01',
    stock_code: 'TEST_AGGR',
    gross_buyers: [{ broker: 'YP', broker_name: 'Mirae', bval: 100, sval: 20, bvol: 10, svol: 2, bfrq: 5, sfrq: 1 }],
    gross_sellers: [{ broker: 'CC', broker_name: 'Mandiri', bval: 10, sval: 80, bvol: 1, svol: 8, bfrq: 1, sfrq: 4 }],
    net_flow: 50
  };
  // Day 2
  const day2 = {
    date: '2026-08-02',
    stock_code: 'TEST_AGGR',
    gross_buyers: [{ broker: 'YP', broker_name: 'Mirae', bval: 150, sval: 30, bvol: 15, svol: 3, bfrq: 6, sfrq: 2 }],
    gross_sellers: [{ broker: 'CC', broker_name: 'Mandiri', bval: 20, sval: 120, bvol: 2, svol: 12, bfrq: 2, sfrq: 6 }],
    net_flow: 70
  };

  fs.writeFileSync(path.join(testDir, '2026-08-01.json'), JSON.stringify(day1));
  fs.writeFileSync(path.join(testDir, '2026-08-02.json'), JSON.stringify(day2));

  const origEnv = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmpBase;

  try {
    const agg = bandarmologiService.aggregateBrokerSummaries('TEST_AGGR', ['2026-08-02', '2026-08-01']);
    assert.ok(agg, 'Aggregated result must exist');
    assert.equal(agg.range_days, 2);
    assert.equal(agg.net_flow, 120);

    const yp = agg.gross_buyers.find(b => b.broker === 'YP');
    assert.ok(yp, 'YP must be present in gross_buyers');
    assert.equal(yp.bval, 250); // 100 + 150
    assert.equal(yp.sval, 50);  // 20 + 30
    assert.equal(yp.bvol, 25);  // 10 + 15
    assert.equal(yp.svol, 5);   // 2 + 3
    assert.equal(yp.bfrq, 11);  // 5 + 6
    assert.equal(yp.sfrq, 3);   // 1 + 2
    assert.equal(yp.nval, 200); // 250 - 50
  } finally {
    if (origEnv !== undefined) {
      process.env.ARJUM_DATA_DIR = origEnv;
    } else {
      delete process.env.ARJUM_DATA_DIR;
    }
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});
