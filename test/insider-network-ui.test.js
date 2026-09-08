'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

function createMockDom() {
  const elements = {};
  function mockEl(id) {
    if (!elements[id]) {
      elements[id] = {
        id: id,
        style: {},
        className: '',
        classList: {
          contains: function(cls) { return (elements[id].className || '').includes(cls); },
          add: function(cls) {
            if (!(elements[id].className || '').includes(cls)) {
              elements[id].className = ((elements[id].className || '') + ' ' + cls).trim();
            }
          },
          remove: function(cls) {
            elements[id].className = (elements[id].className || '').replace(new RegExp('\\b' + cls + '\\b', 'g'), '').trim();
          },
          toggle: function(cls, force) {
            if (force === true) elements[id].classList.add(cls);
            else if (force === false) elements[id].classList.remove(cls);
          }
        },
        attributes: {},
        setAttribute: function(k, v) { elements[id].attributes[k] = String(v); },
        getAttribute: function(k) { return elements[id].attributes[k] || null; },
        innerHTML: '',
        textContent: '',
        value: ''
      };
    }
    return elements[id];
  }

  // Prepopulate standard IDs
  mockEl('bandarmologiContent');
  mockEl('subTabBrokerSummary');
  mockEl('subTabAkumulasiBroker');
  mockEl('subTabIntelBandar');
  mockEl('subTabJejaringInsider');
  mockEl('tabBandarmologi');
  mockEl('bandarPanelTitle');
  mockEl('bandarActiveTickerTag');
  mockEl('bandarTickerSearchInput');
  mockEl('bandarTickerInput');
  mockEl('activeTickerInput');
  mockEl('insiderSearchInput');
  mockEl('insiderSearchDropdown');
  mockEl('btnClearInsiderSearch');
  mockEl('activeGraphEntityTitle');
  mockEl('insiderGraphSvgWrap');
  mockEl('insiderDetailPanel');

  const sandbox = {
    window: {
      location: {
        href: 'https://example.com/analisis-saham',
        search: '',
        pathname: '/analisis-saham',
        hash: ''
      },
      history: {
        replaceState: function() {}
      }
    },
    document: {
      head: { appendChild: function() {} },
      getElementById: mockEl,
      querySelectorAll: function() { return []; }
    },
    URL: URL,
    Intl: Intl,
    Date: Date,
    console: console,
    require: require,
    localStorage: {
      getItem: function() { return null; },
      setItem: function() {},
      removeItem: function() {}
    }
  };
  sandbox.window.localStorage = sandbox.localStorage;
  sandbox.globalThis = sandbox.window;
  vm.createContext(sandbox);

  return { sandbox: sandbox, elements: elements, mockEl: mockEl };
}

test('HTML: analisis-saham.html includes Jejaring Insider subtab button', () => {
  const html = read('public/analisis-saham.html');
  assert.ok(html.includes('id="subTabJejaringInsider"'), 'Has subTabJejaringInsider');
  assert.ok(html.includes("BandarmologiRuntime.setBandarSection('network')"), 'SubTabJejaringInsider onclick calls setBandarSection(network)');
  assert.ok(html.includes('Jejaring Insider'), 'Button label is Jejaring Insider');
});

test('BandarmologiRuntime: exports all Insider Network UI functions', () => {
  const runtimeSource = read('public/bandarmologi-runtime.js');
  const { sandbox } = createMockDom();
  vm.runInContext(runtimeSource, sandbox);

  const runtime = sandbox.window.BandarmologiRuntime;
  assert.equal(typeof runtime.setBandarSection, 'function');
  assert.equal(typeof runtime.renderInsiderNetworkUI, 'function');
  assert.equal(typeof runtime.renderInsiderNetworkGraph, 'function');
  assert.equal(typeof runtime.renderInsiderNetworkSvg, 'function');
  assert.equal(typeof runtime.renderInsiderDetailPanelHtml, 'function');
  assert.equal(typeof runtime.selectInsiderEmitenNode, 'function');
  assert.equal(typeof runtime.handleInsiderSearchInput, 'function');
  assert.equal(typeof runtime.selectInsiderSearchResult, 'function');
  assert.equal(typeof runtime.selectInsiderQuickChip, 'function');
  assert.equal(typeof runtime.clearInsiderSearch, 'function');
  assert.equal(typeof runtime.analyzeInsiderTicker, 'function');
  assert.equal(typeof runtime.getInsiderNetworkEntity, 'function');
  assert.equal(typeof runtime.getInsiderNetworkSelectedTicker, 'function');
});

test('BandarmologiRuntime: setBandarSection("network") switches to network graph section', () => {
  const runtimeSource = read('public/bandarmologi-runtime.js');
  const { sandbox, elements } = createMockDom();
  vm.runInContext(runtimeSource, sandbox);

  const runtime = sandbox.window.BandarmologiRuntime;
  runtime.setBandarSection('network');

  assert.equal(runtime.getBandarSection(), 'network');
  assert.equal(elements.subTabJejaringInsider.attributes['aria-selected'], 'true');
  assert.equal(elements.subTabBrokerSummary.attributes['aria-selected'], 'false');
  assert.equal(elements.subTabAkumulasiBroker.attributes['aria-selected'], 'false');
  assert.equal(elements.subTabIntelBandar.attributes['aria-selected'], 'false');
  assert.ok(elements.subTabJejaringInsider.className.includes('bg-emerald-500'));
  assert.equal(elements.bandarPanelTitle.textContent, 'Jejaring Relasi Insider & Pemegang Saham Multi-Emiten');
});

test('BandarmologiRuntime: renderInsiderNetworkUI renders dark container, search input, chips, and panels', () => {
  const runtimeSource = read('public/bandarmologi-runtime.js');
  const { sandbox, elements } = createMockDom();
  vm.runInContext(runtimeSource, sandbox);

  const runtime = sandbox.window.BandarmologiRuntime;
  const container = elements.bandarmologiContent;

  runtime.renderInsiderNetworkUI(container);

  assert.ok(container.innerHTML.includes('id="insiderSearchInput"'), 'Contains search input');
  assert.ok(container.innerHTML.includes('placeholder="Cari nama insider/tokoh'), 'Contains expected placeholder');
  assert.ok(container.innerHTML.includes('id="insiderSearchDropdown"'), 'Contains search dropdown container');
  assert.ok(container.innerHTML.includes('Belvin Tannadi'), 'Contains Belvin Tannadi chip');
  assert.ok(container.innerHTML.includes('Prajogo Pangestu'), 'Contains Prajogo Pangestu chip');
  assert.ok(container.innerHTML.includes('Lo Kheng Hong'), 'Contains Lo Kheng Hong chip');
  assert.ok(container.innerHTML.includes('Anthoni Salim'), 'Contains Anthoni Salim chip');
  assert.ok(container.innerHTML.includes('BlackRock Inc.'), 'Contains BlackRock Inc. chip');
  assert.ok(container.innerHTML.includes('id="insiderGraphSvgWrap"'), 'Contains SVG wrap');
  assert.ok(container.innerHTML.includes('id="insiderDetailPanel"'), 'Contains detail panel');
});

test('BandarmologiRuntime: renderInsiderNetworkSvg produces valid SVG elements and nodes', () => {
  const runtimeSource = read('public/bandarmologi-runtime.js');
  const { sandbox } = createMockDom();
  vm.runInContext(runtimeSource, sandbox);

  const runtime = sandbox.window.BandarmologiRuntime;

  const mockGraph = {
    summary: { entity_name: 'Belvin Tannadi', total_emitens: 3 },
    nodes: [
      { id: 'insider:belvin tannadi', label: 'Belvin Tannadi', type: 'insider', is_central: true, total_emitens: 3, nationality: 'local' },
      { id: 'ticker:BUMI', label: 'BUMI', ticker: 'BUMI', type: 'ticker' },
      { id: 'ticker:BRMS', label: 'BRMS', ticker: 'BRMS', type: 'ticker' },
      { id: 'ticker:DEWA', label: 'DEWA', ticker: 'DEWA', type: 'ticker' }
    ],
    edges: [
      { source: 'insider:belvin tannadi', target: 'ticker:BUMI', ticker: 'BUMI', shares: 850000000, percentage: 2.45, percentage_raw: '2.45%', broker: 'YP', brokers: ['YP'], latest_action: 'BUY' },
      { source: 'insider:belvin tannadi', target: 'ticker:BRMS', ticker: 'BRMS', shares: 420000000, percentage: 1.80, percentage_raw: '1.80%', broker: 'XL', brokers: ['XL'], latest_action: 'BUY' },
      { source: 'insider:belvin tannadi', target: 'ticker:DEWA', ticker: 'DEWA', shares: 180000000, percentage: 1.15, percentage_raw: '1.15%', broker: 'YP', brokers: ['YP'], latest_action: 'BUY' }
    ]
  };

  const svg = runtime.renderInsiderNetworkSvg(mockGraph, 'BUMI');

  assert.ok(svg.includes('<svg id="insiderNetworkSvg"'), 'Includes svg with id insiderNetworkSvg');
  assert.ok(svg.includes('class="central-insider-node'), 'Includes central insider node');
  assert.ok(svg.includes('Belvin Tannadi'), 'Central node displays name');
  assert.ok(svg.includes('class="emiten-node'), 'Includes emiten nodes');
  assert.ok(svg.includes('BUMI'), 'Includes BUMI emiten node');
  assert.ok(svg.includes('BRMS'), 'Includes BRMS emiten node');
  assert.ok(svg.includes('DEWA'), 'Includes DEWA emiten node');
  assert.ok(svg.includes('class="network-edge"'), 'Includes network edge lines');
  assert.ok(svg.includes('class="broker-chip'), 'Includes midpoint broker chips');
  assert.ok(svg.includes('YP'), 'Includes YP broker chip');
  assert.ok(svg.includes('XL'), 'Includes XL broker chip');
});

test('BandarmologiRuntime: renderInsiderDetailPanelHtml renders holding details and stock analysis CTA', () => {
  const runtimeSource = read('public/bandarmologi-runtime.js');
  const { sandbox } = createMockDom();
  vm.runInContext(runtimeSource, sandbox);

  const runtime = sandbox.window.BandarmologiRuntime;

  const mockGraph = {
    summary: { entity_name: 'Belvin Tannadi', total_emitens: 2 },
    edges: [
      {
        ticker: 'BUMI',
        shares: 850000000,
        percentage: 2.45,
        percentage_raw: '2.45%',
        latest_action: 'BUY',
        latest_price: 142,
        latest_date: '2026-09-04',
        brokers: ['YP']
      }
    ]
  };

  const panelHtml = runtime.renderInsiderDetailPanelHtml(mockGraph, 'BUMI');

  assert.ok(panelHtml.includes('BUMI'), 'Displays ticker BUMI');
  assert.ok(panelHtml.includes('BELI'), 'Displays action BELI');
  assert.ok(panelHtml.includes('2.45%'), 'Displays percentage 2.45%');
  assert.ok(panelHtml.includes('850,000,000 lembar') || panelHtml.includes('850.000.000 lembar'), 'Displays shares');
  assert.ok(panelHtml.includes('142'), 'Displays price 142');
  assert.ok(panelHtml.includes('2026-09-04'), 'Displays date 2026-09-04');
  assert.ok(panelHtml.includes('YP'), 'Displays broker YP');
  assert.ok(panelHtml.includes("BandarmologiRuntime.analyzeInsiderTicker('BUMI')"), 'Shortcut CTA calls analyzeInsiderTicker');
  assert.ok(panelHtml.includes('Analisis Saham BUMI'), 'CTA button text mentions Analisis Saham BUMI');
});

test('BandarmologiRuntime: handleInsiderSearchInput live filters results upon >= 2 characters', () => {
  const runtimeSource = read('public/bandarmologi-runtime.js');
  const { sandbox, elements } = createMockDom();
  vm.runInContext(runtimeSource, sandbox);

  const runtime = sandbox.window.BandarmologiRuntime;

  // Short query (< 2 chars): hides dropdown
  runtime.handleInsiderSearchInput('B');
  assert.equal(elements.insiderSearchDropdown.style.display, 'none');

  // Query >= 2 chars: populates dropdown
  runtime.handleInsiderSearchInput('Belvin');
  assert.equal(elements.insiderSearchDropdown.style.display, 'block');
  assert.ok(elements.insiderSearchDropdown.innerHTML.includes('Belvin Tannadi'), 'Shows Belvin Tannadi');
  assert.ok(elements.insiderSearchDropdown.innerHTML.includes('BUMI'), 'Shows ticker BUMI');
  assert.ok(elements.insiderSearchDropdown.innerHTML.includes('Local') || elements.insiderSearchDropdown.innerHTML.includes('🇮🇩'), 'Shows local badge');
});

test('BandarmologiRuntime: selectInsiderQuickChip and selectInsiderEmitenNode update active states', () => {
  const runtimeSource = read('public/bandarmologi-runtime.js');
  const { sandbox, elements } = createMockDom();
  vm.runInContext(runtimeSource, sandbox);

  const runtime = sandbox.window.BandarmologiRuntime;

  // Select Prajogo Pangestu
  runtime.selectInsiderQuickChip('Prajogo Pangestu');
  assert.equal(runtime.getInsiderNetworkEntity(), 'Prajogo Pangestu');
  assert.equal(elements.activeGraphEntityTitle.textContent, 'Prajogo Pangestu');
  assert.ok(elements.insiderGraphSvgWrap.innerHTML.includes('Prajogo Pangestu'), 'SVG wrap updated with Prajogo');

  // Select node emiten
  const selectedTicker = runtime.getInsiderNetworkSelectedTicker();
  assert.ok(selectedTicker, 'A ticker is selected');
  runtime.selectInsiderEmitenNode(selectedTicker);
  assert.ok(elements.insiderDetailPanel.innerHTML.includes(selectedTicker), 'Detail panel updated with selected ticker');
});

test('BandarmologiRuntime: analyzeInsiderTicker navigates to summary section with selected ticker', () => {
  const runtimeSource = read('public/bandarmologi-runtime.js');
  const { sandbox, elements } = createMockDom();
  vm.runInContext(runtimeSource, sandbox);

  const runtime = sandbox.window.BandarmologiRuntime;
  runtime.setBandarSection('network');
  assert.equal(runtime.getBandarSection(), 'network');

  let loadedTicker = null;
  sandbox.window.loadBandarmologiTab = function (t) { loadedTicker = t; };

  runtime.analyzeInsiderTicker('BUMI');
  assert.equal(runtime.getBandarSection(), 'summary');
  assert.equal(elements.bandarTickerInput.value, 'BUMI');
  assert.equal(loadedTicker, 'BUMI');
});

test('API Endpoint: api/sector-hot.js handles action=insider-network', async () => {
  const sectorHotHandler = require('../api/sector-hot');
  assert.equal(typeof sectorHotHandler, 'function');

  // 1. Search Mode
  let status1 = null;
  let json1 = null;
  const res1 = {
    status: function(code) { status1 = code; return res1; },
    json: function(data) { json1 = data; return res1; },
    setHeader: function() { return res1; }
  };
  await sectorHotHandler({ method: 'GET', query: { action: 'insider-network', search: '1', query: 'Belvin' } }, res1);
  assert.equal(status1, 200);
  assert.equal(json1.success, true);
  assert.ok(Array.isArray(json1.results), 'results is an array');
  assert.ok(json1.results.some(function(r) { return r.name.toLowerCase().includes('belvin'); }), 'Search returns Belvin');

  // 2. Full Graph Mode
  let status2 = null;
  let json2 = null;
  const res2 = {
    status: function(code) { status2 = code; return res2; },
    json: function(data) { json2 = data; return res2; },
    setHeader: function() { return res2; }
  };
  await sectorHotHandler({ method: 'GET', query: { action: 'insider-network', query: 'Belvin Tannadi' } }, res2);
  assert.equal(status2, 200);
  assert.equal(json2.success, true);
  assert.ok(Array.isArray(json2.nodes), 'nodes is an array');
  assert.ok(Array.isArray(json2.edges), 'edges is an array');
  assert.equal(json2.summary.entity_name.toLowerCase(), 'belvin tannadi');
});
