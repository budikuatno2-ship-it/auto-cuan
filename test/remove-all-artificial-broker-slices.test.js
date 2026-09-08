'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const arjumClient = require('../lib/arjum-client');
const bandarmologiService = require('../lib/bandarmologi-service');
const bandarmologiRuntime = require('../public/bandarmologi-runtime');

test('PR #4: arjumClient defaults broker_limit and level_limit to at least 100 (full IDX broker universe)', async () => {
  assert.ok(arjumClient.DEFAULT_BROKER_LIMIT >= 100, `DEFAULT_BROKER_LIMIT must be >= 100, got ${arjumClient.DEFAULT_BROKER_LIMIT}`);
  assert.ok(arjumClient.DEFAULT_LEVEL_LIMIT >= 100, `DEFAULT_LEVEL_LIMIT must be >= 100, got ${arjumClient.DEFAULT_LEVEL_LIMIT}`);

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'arjum-limit-test-'));
  const origEnv = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmpBase;

  const origFetch = global.fetch;
  let capturedUrl = '';
  global.fetch = async (url) => {
    capturedUrl = url;
    return { ok: true, json: async () => ({ success: true }) };
  };

  try {
    await arjumClient.fetchBrokerSummary('BBRI');
    assert.match(capturedUrl, /broker_limit=100/, 'fetchBrokerSummary must send broker_limit=100');
    assert.match(capturedUrl, /level_limit=100/, 'fetchBrokerSummary must send level_limit=100');
  } finally {
    global.fetch = origFetch;
    if (origEnv !== undefined) process.env.ARJUM_DATA_DIR = origEnv;
    else delete process.env.ARJUM_DATA_DIR;
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('PR #4: bandarmologiService.normalizeBrokerSummary preserves 50+ brokers without .slice(0, 20) cap', () => {
  // Scenario: 30 buyers and 25 sellers (total 55 brokers in unified `brokers` array)
  const brokers = [];
  for (let i = 1; i <= 30; i++) {
    const code = 'B' + (i < 10 ? '0' + i : i);
    brokers.push({
      broker_code: code,
      bval: (35 - i) * 1e9,
      sval: 1e8,
      bvol: 10000,
      svol: 100,
      nval: (35 - i) * 1e9 - 1e8
    });
  }
  for (let j = 1; j <= 25; j++) {
    const code = 'S' + (j < 10 ? '0' + j : j);
    brokers.push({
      broker_code: code,
      bval: 1e8,
      sval: (30 - j) * 1e9,
      bvol: 100,
      svol: 8000,
      nval: -(30 - j) * 1e9 + 1e8
    });
  }

  const raw = {
    stock_code: 'BBRI',
    date: '2026-09-08',
    brokers: brokers
  };

  const norm = bandarmologiService.normalizeBrokerSummary(raw, '2026-09-08');
  assert.ok(norm, 'Normalized summary must not be null');
  assert.equal(norm.gross_buyers.length, 55, 'gross_buyers must contain all brokers with bval > 0 without 20 cap');
  assert.equal(norm.gross_sellers.length, 55, 'gross_sellers must contain all brokers with sval > 0 without 20 cap');
  assert.equal(norm.top_buyers.length, 55, 'top_buyers must match gross_buyers without 20 cap');
  assert.equal(norm.top_sellers.length, 55, 'top_sellers must match gross_sellers without 20 cap');
  assert.equal(norm.net_buyers.length, 30, 'net_buyers must contain all 30 positive net brokers');
  assert.equal(norm.net_sellers.length, 25, 'net_sellers must contain all 25 negative net brokers');
});

test('PR #4: bandarmologiService.aggregateBrokerSummaries preserves all brokers across multi-day aggregation', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'arjum-agg-test-'));
  const origEnv = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmpBase;

  try {
    const tickerDir = path.join(tmpBase, 'broker-summary', 'BBRI');
    fs.mkdirSync(tickerDir, { recursive: true });

    // Day 1: 25 distinct brokers
    const day1Brokers = [];
    for (let i = 1; i <= 25; i++) {
      day1Brokers.push({
        broker: 'D1_' + (i < 10 ? '0' + i : i),
        bval: 2e9,
        sval: 0,
        bvol: 1000,
        svol: 0
      });
    }
    fs.writeFileSync(path.join(tickerDir, '2026-09-07.json'), JSON.stringify({
      stock_code: 'BBRI',
      date: '2026-09-07',
      gross_buyers: day1Brokers,
      gross_sellers: [{ broker: 'SL01', bval: 0, sval: 50e9, bvol: 0, svol: 25000 }],
      top_buyers: day1Brokers,
      top_sellers: [{ broker: 'SL01', bval: 0, sval: 50e9, bvol: 0, svol: 25000 }]
    }));

    // Day 2: 25 other distinct brokers
    const day2Brokers = [];
    for (let j = 1; j <= 25; j++) {
      day2Brokers.push({
        broker: 'D2_' + (j < 10 ? '0' + j : j),
        bval: 0,
        sval: 2e9,
        bvol: 0,
        svol: 1000
      });
    }
    fs.writeFileSync(path.join(tickerDir, '2026-09-08.json'), JSON.stringify({
      stock_code: 'BBRI',
      date: '2026-09-08',
      gross_buyers: [{ broker: 'BY01', bval: 50e9, sval: 0, bvol: 25000, svol: 0 }],
      gross_sellers: day2Brokers,
      top_buyers: [{ broker: 'BY01', bval: 50e9, sval: 0, bvol: 25000, svol: 0 }],
      top_sellers: day2Brokers
    }));

    const agg = bandarmologiService.aggregateBrokerSummaries('BBRI', ['2026-09-08', '2026-09-07'], 2);
    assert.ok(agg, 'Aggregated summary must not be null');
    assert.ok(agg.gross_buyers.length > 20, `gross_buyers length (${agg.gross_buyers.length}) must exceed 20`);
    assert.ok(agg.gross_sellers.length > 20, `gross_sellers length (${agg.gross_sellers.length}) must exceed 20`);
    assert.equal(agg.gross_buyers.length, 52, 'All 52 brokers must be preserved in multi-day aggregation without 20 cap');
    assert.equal(agg.gross_sellers.length, 52, 'All 52 brokers must be preserved in multi-day aggregation without 20 cap');
  } finally {
    if (origEnv !== undefined) process.env.ARJUM_DATA_DIR = origEnv;
    else delete process.env.ARJUM_DATA_DIR;
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('PR #4: bandarmologiRuntime Gross Mode renders full 50+ brokers without 20+20=40 cap', () => {
  // Scenario: 32 buyers and 28 sellers (total 60 bubbles in Gross Mode)
  const buyers32 = [];
  for (let i = 1; i <= 32; i++) {
    buyers32.push({
      broker: 'BY' + (i < 10 ? '0' + i : i),
      bval: (40 - i) * 1e9,
      sval: 0,
      bvol: 10000,
      svol: 0
    });
  }

  const sellers28 = [];
  for (let j = 1; j <= 28; j++) {
    sellers28.push({
      broker: 'SL' + (j < 10 ? '0' + j : j),
      bval: 0,
      sval: (35 - j) * 1e9,
      bvol: 0,
      svol: 8000
    });
  }

  const grossItems = bandarmologiRuntime.buildBrokerBubbleItems(buyers32, sellers28, 'gross');
  assert.equal(grossItems.length, 60, 'Gross mode must render all 60 bubbles (not capped at 40)');

  const buyers = grossItems.filter(b => b.side === 'buy' || b.isBuyer);
  const sellers = grossItems.filter(b => b.side === 'sell' || !b.isBuyer);
  assert.equal(buyers.length, 32, 'Must have all 32 buyers');
  assert.equal(sellers.length, 28, 'Must have all 28 sellers');

  const html = bandarmologiRuntime.renderBrokerBubbleClusterHtml(grossItems, 'BY01', 'gross', 'all');
  assert.match(html, /Semua \(60\)/, 'Counter pill must show Semua (60)');
  assert.match(html, /🟢 Buyers \(32\)/, 'Counter pill must show 🟢 Buyers (32)');
  assert.match(html, /🔴 Sellers \(28\)/, 'Counter pill must show 🔴 Sellers (28)');

  // Ensure 60 individual bubble buttons are rendered
  const bubbleMatches = html.match(/id="broker-bubble-/g);
  assert.equal(bubbleMatches ? bubbleMatches.length : 0, 60, 'Must render exactly 60 bubble buttons in the DOM');
});

test('PR #4: Codebase audit ensures no .slice(0, 20) caps broker lists', () => {
  const serviceFile = fs.readFileSync(path.join(__dirname, '../lib/bandarmologi-service.js'), 'utf8');
  assert.ok(!serviceFile.includes('.slice(0, 20)'), 'lib/bandarmologi-service.js must not contain .slice(0, 20)');

  const runtimeFile = fs.readFileSync(path.join(__dirname, '../public/bandarmologi-runtime.js'), 'utf8');
  assert.ok(!runtimeFile.includes('.slice(0, 20)'), 'public/bandarmologi-runtime.js must not contain .slice(0, 20)');
  assert.ok(!runtimeFile.includes('.slice(0, 40)'), 'public/bandarmologi-runtime.js must not contain .slice(0, 40)');
});
