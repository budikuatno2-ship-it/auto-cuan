'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('Broker Accumulation Bubble: BandarmologiRuntime exports accumulation view toggles', () => {
  const runtimeSource = read('public/bandarmologi-runtime.js');

  const elements = {};
  function mockEl(id) {
    if (!elements[id]) {
      elements[id] = {
        id,
        style: {},
        classList: {
          contains: () => false,
          add: () => {},
          remove: () => {},
          toggle: () => {}
        },
        setAttribute: () => {},
        innerHTML: '',
        textContent: ''
      };
    }
    return elements[id];
  }

  mockEl('bandarmologiContent');

  const sandbox = {
    window: {},
    document: {
      head: { appendChild: () => {} },
      getElementById: mockEl,
      querySelectorAll: () => []
    },
    Intl,
    Date,
    console
  };
  sandbox.globalThis = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(runtimeSource, sandbox);

  const runtime = sandbox.window.BandarmologiRuntime;
  assert.equal(typeof runtime.setBrokerAccumulationView, 'function');
  assert.equal(typeof runtime.getBrokerAccumulationView, 'function');
  assert.equal(runtime.getBrokerAccumulationView(), 'bubble');

  runtime.setBrokerAccumulationView('table');
  assert.equal(runtime.getBrokerAccumulationView(), 'table');

  runtime.setBrokerAccumulationView('bubble');
  assert.equal(runtime.getBrokerAccumulationView(), 'bubble');
});

test('Broker Accumulation Bubble: Akumulasi section renders bubble cluster, flow filter, and detail card', () => {
  const runtimeSource = read('public/bandarmologi-runtime.js');

  const elements = {};
  function mockEl(id) {
    if (!elements[id]) {
      elements[id] = {
        id,
        style: {},
        classList: {
          contains: () => false,
          add: () => {},
          remove: () => {},
          toggle: () => {}
        },
        setAttribute: () => {},
        innerHTML: '',
        textContent: ''
      };
    }
    return elements[id];
  }

  const container = mockEl('bandarmologiContent');

  const sandbox = {
    window: {},
    document: {
      head: { appendChild: () => {} },
      getElementById: mockEl,
      querySelectorAll: () => []
    },
    Intl,
    Date,
    console
  };
  sandbox.globalThis = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(runtimeSource, sandbox);

  const runtime = sandbox.window.BandarmologiRuntime;

  const sampleData = {
    success: true,
    ticker: 'GPRA',
    date: '2026-09-04',
    broker_summary: {
      date: '2026-09-04',
      net_status: 'ACCUMULATION',
      net_label: 'Akumulasi',
      net_flow: 500000000,
      net_buyers: [
        { broker: 'XL', broker_name: 'Stockbit', bval: 823600000, sval: 0, bvol: 8000, svol: 0, nval: 823600000, nvol: 8000, avg_buy: 103 },
        { broker: 'CP', broker_name: 'Valbury', bval: 383200000, sval: 0, bvol: 3700, svol: 0, nval: 383200000, nvol: 3700, avg_buy: 104 }
      ],
      net_sellers: [
        { broker: 'MG', broker_name: 'Semesta', bval: 0, sval: 1600000000, bvol: 0, svol: 15500, nval: -1600000000, nvol: -15500, avg_sell: 103 },
        { broker: 'CC', broker_name: 'Mandiri', bval: 0, sval: 693900000, bvol: 0, svol: 6700, nval: -693900000, nvol: -6700, avg_sell: 104 }
      ]
    },
    broker_accumulation: {
      ticker: 'GPRA',
      accumulation_score: 82,
      status: 'ACCUMULATION',
      series: [
        { date: '2026-09-02', net_val: 200000000, status: 'ACC', top_buyer: 'XL', top_seller: 'MG' },
        { date: '2026-09-03', net_val: -100000000, status: 'DIST', top_buyer: 'CP', top_seller: 'CC' },
        { date: '2026-09-04', net_val: 400000000, status: 'ACC', top_buyer: 'XL', top_seller: 'MG' }
      ]
    },
    insiders: []
  };

  // Switch to akumulasi section
  runtime.setBandarSection('akumulasi');
  runtime.setBrokerAccumulationView('bubble');

  // Render directly via renderBandarmologiUI
  runtime.renderBandarmologiUI(container, sampleData);

  const html = container.innerHTML;

  // 1. Check Toggle Tampilan buttons exist
  assert.ok(html.includes('toggleAccViewBubble'), 'Contains toggleAccViewBubble button');
  assert.ok(html.includes('toggleAccViewTable'), 'Contains toggleAccViewTable button');
  assert.ok(html.includes('Visual Bubble'), 'Renders Visual Bubble label');
  assert.ok(html.includes('Tabel Rinci'), 'Renders Tabel Rinci label');

  // 2. Check Flow Filter buttons exist
  assert.ok(html.includes('toggleAccFlowAll'), 'Contains toggleAccFlowAll button');
  assert.ok(html.includes('toggleAccFlowForeign'), 'Contains toggleAccFlowForeign button');
  assert.ok(html.includes('toggleAccFlowDomestic'), 'Contains toggleAccFlowDomestic button');

  // 3. Check Bubble Cluster container & bubbles exist
  assert.ok(html.includes('brokerBubbleClusterContainer'), 'Renders bubble cluster container');
  assert.ok(html.includes('broker-bubble-XL'), 'Renders buyer bubble for XL');
  assert.ok(html.includes('broker-bubble-MG'), 'Renders seller bubble for MG');

  // 4. Check Detail card rendered
  assert.ok(html.includes('brokerBubbleDetailCard'), 'Renders broker detail card');
  assert.ok(html.includes('Kontribusi:'), 'Detail card displays contribution percentage');

  // 5. Test switching to Table View
  runtime.setBrokerAccumulationView('table');
  const tableHtml = container.innerHTML;
  assert.ok(tableHtml.includes('Riwayat Harian Broker Summary (Breakdown Per Hari)'), 'Renders daily breakdown table in table mode');
  assert.ok(tableHtml.includes('Grafik Tren Akumulasi vs Distribusi Historis'), 'Renders accumulation trend bar chart in table mode');
});
