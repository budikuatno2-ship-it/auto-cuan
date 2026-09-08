const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const bandarmologiService = require('../lib/bandarmologi-service');
const arjumClient = require('../lib/arjum-client');

test('Akumulasi Universal Fallback: getBandarmologiData ensures broker_accumulation is never empty when summary exists', async () => {
  // Simulate GPRA with broker summary but no accumulation from upstream
  const origHasKey = arjumClient.hasArjumApiKey;
  const origSum = arjumClient.fetchBrokerSummary;
  const origAcc = arjumClient.fetchBrokerAccumulation;
  const origIns = arjumClient.fetchInsiders;

  try {
    arjumClient.hasArjumApiKey = () => true;
    arjumClient.fetchBrokerSummary = async () => ({
      ok: true,
      data: {
        stock_code: 'GPRA',
        date: '2026-09-04',
        top_buyers: [{ broker: 'XL', bval: 823600000, svol: 0 }],
        top_sellers: [{ broker: 'MG', sval: 1600000000, bval: 0 }]
      }
    });
    arjumClient.fetchBrokerAccumulation = async () => ({ ok: false, status: 404 });
    arjumClient.fetchInsiders = async () => ({ ok: true, data: [] });

    const result = await bandarmologiService.getBandarmologiData('GPRA', { forceRefresh: true });
    assert.equal(result.success, true);
    assert.ok(result.broker_accumulation, 'Must have broker_accumulation object');
    assert.ok(Array.isArray(result.broker_accumulation.top_buyers), 'top_buyers must be array');
    assert.ok(Array.isArray(result.broker_accumulation.top_sellers), 'top_sellers must be array');
    assert.ok(result.broker_accumulation.top_buyers.length > 0, 'top_buyers must not be empty');
    assert.ok(result.broker_accumulation.top_sellers.length > 0, 'top_sellers must not be empty');
    assert.equal(result.broker_accumulation.top_buyers[0].broker, 'XL');
    assert.equal(result.broker_accumulation.top_sellers[0].broker, 'MG');
  } finally {
    arjumClient.hasArjumApiKey = origHasKey;
    arjumClient.fetchBrokerSummary = origSum;
    arjumClient.fetchBrokerAccumulation = origAcc;
    arjumClient.fetchInsiders = origIns;
  }
});

test('Akumulasi UI Fallback: BandarmologiRuntime renders Akumulasi bubbles and informative flow reset', async () => {
  const runtimeSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'bandarmologi-runtime.js'), 'utf8');
  const dom = {
    getElementById: (id) => ({
      id,
      innerHTML: '',
      textContent: '',
      value: '',
      classList: { add: () => {}, remove: () => {}, toggle: () => {} },
      setAttribute: () => {},
      appendChild: () => {}
    }),
    createElement: () => ({ id: '', textContent: '', appendChild: () => {} }),
    head: { appendChild: () => {} }
  };
  const sandbox = {
    window: {
      location: { href: 'http://localhost/analisis-saham', pathname: '/analisis-saham', search: '', hash: '' },
      history: { replaceState: () => {} }
    },
    document: dom,
    console, Intl, Date, setTimeout, clearTimeout
  };
  sandbox.globalThis = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(runtimeSource, sandbox);

  const runtime = sandbox.window.BandarmologiRuntime;

  const sampleData = {
    success: true,
    ticker: 'GPRA',
    broker_summary: {
      date: '2026-09-04',
      top_buyers: [{ broker: 'XL', bval: 823600000, sval: 0 }],
      top_sellers: [{ broker: 'MG', sval: 1600000000, bval: 0 }]
    },
    broker_accumulation: {
      ticker: 'GPRA',
      top_buyers: [{ broker: 'XL', bval: 823600000, sval: 0 }],
      top_sellers: [{ broker: 'MG', sval: 1600000000, bval: 0 }]
    }
  };

  const container = { innerHTML: '' };
  runtime.setBandarSection('akumulasi');
  runtime.renderBandarmologiUI(container, sampleData);

  // Assert bubbles are rendered
  assert.ok(container.innerHTML.includes('broker-bubble-XL'), 'Must render buyer bubble for XL');
  assert.ok(container.innerHTML.includes('broker-bubble-MG'), 'Must render seller bubble for MG');
  assert.ok(!container.innerHTML.includes('Semua (0)'), 'Must not display Semua (0)');

  // Test flow filter F on stock with no foreign brokers
  runtime.setBrokerFlowFilter('F');
  runtime.renderBandarmologiUI(container, sampleData);
  assert.ok(container.innerHTML.includes('Tidak ada broker Asing (Foreign) pada filter ini'), 'Informative message for flow filter');
  assert.ok(container.innerHTML.includes('Tampilkan Semua Broker'), 'Reset button present');

  // Test ticker switch resets brokerFlowFilter to 'all'
  runtime.loadBandarmologiTab('BBCA');
  assert.equal(runtime.getBrokerFlowFilter(), 'all', 'Flow filter must reset to all on ticker change');
});
