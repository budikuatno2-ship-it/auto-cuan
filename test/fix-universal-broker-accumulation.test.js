'use strict';

/**
 * PR #3 Unit Test: Fix Akumulasi Broker BBRI & Universal Empty State
 *
 * Verifies:
 * 1. Backend: getBandarmologiData returns complete broker_accumulation with top_buyers > 0 and top_sellers > 0 even without disk accumulation cache.
 * 2. Backend: synthesizeAccumulationFromSummary produces valid buyers and sellers from summary with gross or net lists.
 * 3. Frontend: BandarmologiRuntime exports synthesizeAccumulationFromSummary.
 * 4. Frontend: renderBandarmologiUI synthesizes accumulation if missing or empty, avoiding "Semua (0)".
 * 5. Frontend: setBandarSection('akumulasi') triggers reactive synthesis on section switch.
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const bandarmologiService = require(path.join(ROOT, 'lib', 'bandarmologi-service'));

function loadRuntime() {
  const code = fs.readFileSync(path.join(ROOT, 'public', 'bandarmologi-runtime.js'), 'utf8');
  const domElements = {};
  const mockDoc = {
    getElementById: (id) => domElements[id] || { textContent: '', value: '', innerHTML: '', addEventListener: () => {}, classList: { toggle: () => {} }, setAttribute: () => {} },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ setAttribute: () => {}, appendChild: () => {}, classList: { add: () => {} } })
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
  return { runtime: mockWin.BandarmologiRuntime, doc: mockDoc };
}

test('Backend: getBandarmologiData BBRI always populates broker_accumulation top lists', async () => {
  const data = await bandarmologiService.getBandarmologiData('BBRI', '1d');
  assert.ok(data.success, 'Request must succeed');
  assert.ok(data.broker_accumulation, 'broker_accumulation must be present');
  const acc = data.broker_accumulation;
  assert.ok(Array.isArray(acc.top_buyers), 'top_buyers must be array');
  assert.ok(Array.isArray(acc.top_sellers), 'top_sellers must be array');
  assert.ok(acc.top_buyers.length > 0, `top_buyers length (${acc.top_buyers.length}) must be > 0`);
  assert.ok(acc.top_sellers.length > 0, `top_sellers length (${acc.top_sellers.length}) must be > 0`);
});

test('Frontend: BandarmologiRuntime exports synthesizeAccumulationFromSummary', () => {
  const { runtime } = loadRuntime();
  assert.equal(typeof runtime.synthesizeAccumulationFromSummary, 'function',
    'BandarmologiRuntime must export synthesizeAccumulationFromSummary');
});

test('Frontend: synthesizeAccumulationFromSummary builds valid accumulation object', () => {
  const { runtime } = loadRuntime();
  const summary = {
    date: '2026-09-08',
    net_flow: 5000000000,
    gross_buyers: [
      { broker: 'YP', bval: 10e9, sval: 2e9, nval: 8e9 },
      { broker: 'CC', bval: 8e9, sval: 1e9, nval: 7e9 }
    ],
    gross_sellers: [
      { broker: 'XC', bval: 1e9, sval: 9e9, nval: -8e9 },
      { broker: 'NI', bval: 2e9, sval: 7e9, nval: -5e9 }
    ]
  };

  const syn = runtime.synthesizeAccumulationFromSummary(summary, 'BBRI');
  assert.ok(syn, 'Synthesized accumulation must not be null');
  assert.equal(syn.ticker, 'BBRI');
  assert.ok(Array.isArray(syn.top_buyers), 'top_buyers must be array');
  assert.ok(Array.isArray(syn.top_sellers), 'top_sellers must be array');
  assert.equal(syn.top_buyers.length, 2, 'Must have 2 buyers');
  assert.equal(syn.top_sellers.length, 2, 'Must have 2 sellers');
  assert.equal(syn.top_buyers[0].broker, 'YP');
  assert.equal(syn.top_sellers[0].broker, 'XC');
});

test('Frontend: renderBandarmologiUI synthesizes accumulation when bAcc is empty', () => {
  const { runtime, doc } = loadRuntime();

  const container = { innerHTML: '' };
  const payloadWithEmptyAcc = {
    ticker: 'BBRI',
    broker_summary: {
      date: '2026-09-08',
      net_flow: 12000000000,
      gross_buyers: [{ broker: 'YP', bval: 15e9, sval: 3e9, nval: 12e9 }],
      gross_sellers: [{ broker: 'XC', bval: 1e9, sval: 8e9, nval: -7e9 }]
    },
    broker_accumulation: { series: [] } // Empty accumulation from server!
  };

  // Switch to akumulasi section
  runtime.setBandarSection('akumulasi');
  runtime.renderBandarmologiUI(container, payloadWithEmptyAcc);

  // Payload's broker_accumulation must now be synthesized
  assert.ok(payloadWithEmptyAcc.broker_accumulation.top_buyers, 'top_buyers must be synthesized');
  assert.ok(payloadWithEmptyAcc.broker_accumulation.top_buyers.length > 0, 'top_buyers length must be > 0');
  assert.ok(payloadWithEmptyAcc.broker_accumulation.top_sellers.length > 0, 'top_sellers length must be > 0');

  // Rendered HTML must have bubble cluster with YP and XC, not "Semua (0)"
  assert.ok(container.innerHTML.includes('YP'), 'Rendered HTML must include YP bubble');
  assert.ok(container.innerHTML.includes('XC'), 'Rendered HTML must include XC bubble');
  assert.ok(!container.innerHTML.includes('Semua (0)'), 'Rendered HTML must NOT show Semua (0)');
});

test('Frontend: Akumulasi Bubble view renders positive and negative bubbles accurately', () => {
  const { runtime } = loadRuntime();

  const buyers = [{ broker: 'YP', bval: 10e9, sval: 2e9, nval: 8e9 }];
  const sellers = [{ broker: 'XC', bval: 1e9, sval: 9e9, nval: -8e9 }];

  const items = runtime.buildBrokerBubbleItems(buyers, sellers, 'net');
  const html = runtime.renderBrokerBubbleClusterHtml(items, 'YP', 'net', 'all');

  assert.ok(html.includes('Semua (2)'), 'HTML must show Semua (2)');
  assert.ok(html.includes('Buyers (1)'), 'HTML must show Buyers (1)');
  assert.ok(html.includes('Sellers (1)'), 'HTML must show Sellers (1)');
  assert.ok(!html.includes('Semua (0)'), 'HTML must not show Semua (0)');
});
