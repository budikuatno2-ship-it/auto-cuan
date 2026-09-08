'use strict';

/**
 * Unit tests for FASE 4 fix:
 * - aggregateBrokerSummaries returns date_headers with per-day breakdown
 * - synthesizeAccumulationFromSummary uses date_headers as series (multi-day)
 * - 7D vs 30D produce distinct date ranges
 * - No fake multiplication scaling applied to real aggregated data
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  aggregateBrokerSummaries,
  synthesizeAccumulationFromSummary,
  normalizeBrokerSummary,
  writeDiskCache,
  readDiskCache
} = require('../lib/bandarmologi-service');

// ─── Helpers ────────────────────────────────────────────────────────────────

// Override ARJUM_DATA_DIR to a temp dir for test isolation
let tmpDir;
const origEnv = process.env.ARJUM_DATA_DIR;

function setupTempDir() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actest-'));
  process.env.ARJUM_DATA_DIR = tmpDir;
}

function teardownTempDir() {
  if (origEnv !== undefined) {
    process.env.ARJUM_DATA_DIR = origEnv;
  } else {
    delete process.env.ARJUM_DATA_DIR;
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}

function makeBrokerSummaryRaw(date, netFlow, topBuyerCode, topSellerCode) {
  return {
    date,
    net_flow: netFlow,
    gross_buyers: [
      { broker: topBuyerCode, broker_name: 'Broker ' + topBuyerCode, bval: Math.abs(netFlow) + 10000000000, sval: 5000000000, nval: Math.abs(netFlow), bvol: 1000000, svol: 500000 },
      { broker: 'ZZ', broker_name: 'Other', bval: 5000000000, sval: 3000000000, nval: 2000000000, bvol: 500000, svol: 300000 }
    ],
    gross_sellers: [
      { broker: topSellerCode, broker_name: 'Seller ' + topSellerCode, sval: Math.abs(netFlow) + 8000000000, bval: 3000000000, nval: -Math.abs(netFlow), svol: 1000000, bvol: 300000 }
    ],
    net_buyers: [
      { broker: topBuyerCode, broker_name: 'Broker ' + topBuyerCode, bval: Math.abs(netFlow) + 10000000000, sval: 5000000000, nval: Math.abs(netFlow), bvol: 1000000, svol: 500000 }
    ],
    net_sellers: [
      { broker: topSellerCode, broker_name: 'Seller ' + topSellerCode, sval: Math.abs(netFlow) + 8000000000, bval: 3000000000, nval: -Math.abs(netFlow), svol: 1000000, bvol: 300000 }
    ]
  };
}

// ─── 1. aggregateBrokerSummaries returns date_headers ──────────────────────

{
  setupTempDir();
  try {
    const ticker = 'BBCA';
    const dates = ['2026-09-04', '2026-09-03', '2026-09-02'];
    const expectations = {
      '2026-09-04': { netFlow: 42300000000, buyer: 'YP', seller: 'XC' },
      '2026-09-03': { netFlow: -5400000000, buyer: 'CC', seller: 'NI' },
      '2026-09-02': { netFlow: 21000000000, buyer: 'BK', seller: 'CP' }
    };

    for (const d of dates) {
      const e = expectations[d];
      writeDiskCache('broker-summary', ticker, d, makeBrokerSummaryRaw(d, e.netFlow, e.buyer, e.seller));
    }

    const result = aggregateBrokerSummaries(ticker, dates, 3);

    assert.ok(Array.isArray(result.date_headers), 'date_headers should be an array');
    assert.strictEqual(result.date_headers.length, 3, 'date_headers should have 3 entries (one per date)');

    // Sorted oldest-first
    assert.strictEqual(result.date_headers[0].date, '2026-09-02', 'date_headers sorted oldest first');
    assert.strictEqual(result.date_headers[1].date, '2026-09-03');
    assert.strictEqual(result.date_headers[2].date, '2026-09-04');

    // Each entry has correct net_val and top_buyer/seller
    const d04 = result.date_headers.find(h => h.date === '2026-09-04');
    assert.strictEqual(d04.net_val, 42300000000, '2026-09-04 net_val');
    assert.strictEqual(d04.top_buyer, 'YP', '2026-09-04 top_buyer');
    assert.strictEqual(d04.status, 'ACC', '2026-09-04 status');

    const d03 = result.date_headers.find(h => h.date === '2026-09-03');
    assert.strictEqual(d03.net_val, -5400000000, '2026-09-03 net_val');
    assert.strictEqual(d03.status, 'DIST', '2026-09-03 status');

    console.log('✓ aggregateBrokerSummaries: date_headers has per-day entries sorted oldest-first');
  } finally {
    teardownTempDir();
  }
}

// ─── 2. aggregateBrokerSummaries net_flow is real sum (not multiplied) ──────

{
  setupTempDir();
  try {
    const ticker = 'BMRI';
    const data = [
      { date: '2026-09-04', netFlow: 10000000000, buyer: 'YP', seller: 'XC' },
      { date: '2026-09-03', netFlow: 20000000000, buyer: 'CC', seller: 'NI' },
      { date: '2026-09-02', netFlow: -5000000000, buyer: 'BK', seller: 'CP' },
      { date: '2026-09-01', netFlow: 15000000000, buyer: 'AK', seller: 'GR' },
      { date: '2026-08-28', netFlow: 8000000000, buyer: 'PD', seller: 'MG' },
      { date: '2026-08-27', netFlow: -3000000000, buyer: 'ZZ', seller: 'XC' },
      { date: '2026-08-26', netFlow: 12000000000, buyer: 'YP', seller: 'NI' }
    ];
    const dates = data.map(d => d.date);
    for (const d of data) {
      writeDiskCache('broker-summary', ticker, d.date, makeBrokerSummaryRaw(d.date, d.netFlow, d.buyer, d.seller));
    }

    const result7 = aggregateBrokerSummaries(ticker, dates.slice(0, 7), 7);

    const expectedSum = data.slice(0, 7).reduce((s, d) => s + d.netFlow, 0);
    assert.strictEqual(result7.net_flow, expectedSum, `7D net_flow should be real sum ${expectedSum}, got ${result7.net_flow}`);
    assert.ok(result7.range_label.includes('7 Hari'), 'range_label includes 7 Hari');
    assert.strictEqual(result7.date_headers.length, 7, '7D has 7 date_headers');

    console.log(`✓ aggregateBrokerSummaries 7D: net_flow = ${result7.net_flow} (real sum, not multiplied by 5)`);
  } finally {
    teardownTempDir();
  }
}

// ─── 3. synthesizeAccumulationFromSummary uses date_headers as series ────────

{
  const normSummaryMultiDay = {
    date: '2026-09-02 s/d 2026-09-04',
    range_label: '3 Hari Bursa (2026-09-02 s/d 2026-09-04)',
    range_days: 3,
    net_flow: 57900000000,
    date_headers: [
      { date: '2026-09-02', net_val: 21000000000, status: 'ACC', top_buyer: 'BK', top_seller: 'CP' },
      { date: '2026-09-03', net_val: -5400000000, status: 'DIST', top_buyer: 'CC', top_seller: 'NI' },
      { date: '2026-09-04', net_val: 42300000000, status: 'ACC', top_buyer: 'YP', top_seller: 'XC' }
    ],
    net_buyers: [{ broker: 'YP', nval: 40000000000, bval: 80000000000, sval: 40000000000 }],
    net_sellers: [{ broker: 'XC', nval: -35000000000, bval: 15000000000, sval: 50000000000 }],
    gross_buyers: [],
    gross_sellers: [],
    top_buyers: [],
    top_sellers: []
  };

  const result = synthesizeAccumulationFromSummary(normSummaryMultiDay, 'BBCA');

  assert.ok(Array.isArray(result.series), 'series is array');
  assert.strictEqual(result.series.length, 3, 'series has 3 entries (from date_headers)');
  assert.strictEqual(result.series[0].date, '2026-09-02', 'series[0] is oldest date');
  assert.strictEqual(result.series[2].date, '2026-09-04', 'series[2] is newest date');
  assert.strictEqual(result.series[0].top_buyer, 'BK', 'series top_buyer preserved');
  assert.strictEqual(result.series[1].status, 'DIST', 'DIST status preserved');

  console.log(`✓ synthesizeAccumulationFromSummary: multi-day series has ${result.series.length} per-day entries from date_headers`);
}

// ─── 4. synthesizeAccumulationFromSummary: single-day fallback ───────────────

{
  const normSummarySingleDay = {
    date: '2026-09-04',
    range_label: 'Tanggal: 2026-09-04',
    net_flow: 42300000000,
    net_buyers: [{ broker: 'YP', nval: 40000000000, bval: 80000000000, sval: 40000000000 }],
    net_sellers: [{ broker: 'XC', nval: -35000000000, bval: 15000000000, sval: 50000000000 }],
    gross_buyers: [],
    gross_sellers: [],
    top_buyers: [],
    top_sellers: []
    // no date_headers
  };

  const result = synthesizeAccumulationFromSummary(normSummarySingleDay, 'BBCA');

  assert.strictEqual(result.series.length, 1, 'single-day fallback: series has 1 entry');
  assert.strictEqual(result.series[0].net_val, 42300000000, 'single-day net_val matches net_flow');
  console.log('✓ synthesizeAccumulationFromSummary: single-day fallback series has 1 entry');
}

// ─── 5. 7D vs 30D produce different date ranges ───────────────────────────────

{
  setupTempDir();
  try {
    const ticker = 'TLKM';
    const allDates = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date('2026-09-04');
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      allDates.push(dateStr);
      writeDiskCache('broker-summary', ticker, dateStr, makeBrokerSummaryRaw(dateStr, (i % 3 === 0 ? -1 : 1) * (i + 1) * 1000000000, 'YP', 'XC'));
    }

    const result7 = aggregateBrokerSummaries(ticker, allDates.slice(0, 7), 7);
    const result30 = aggregateBrokerSummaries(ticker, allDates.slice(0, 30), 30);

    assert.notStrictEqual(result7.net_flow, result30.net_flow, '7D and 30D should have different net_flow');
    assert.strictEqual(result7.date_headers.length, 7, '7D has 7 date_headers');
    assert.strictEqual(result30.date_headers.length, 30, '30D has 30 date_headers');
    assert.ok(result7.range_label.includes('7 Hari'), '7D range_label includes 7 Hari');
    assert.ok(result30.range_label.includes('30 Hari'), '30D range_label includes 30 Hari');

    console.log(`✓ 7D vs 30D distinct: 7D net_flow=${result7.net_flow}, 30D net_flow=${result30.net_flow}`);
    console.log(`✓ 7D date_headers=${result7.date_headers.length}, 30D date_headers=${result30.date_headers.length}`);
  } finally {
    teardownTempDir();
  }
}

console.log('\n✅ All multi-day broker aggregation tests passed!\n');
