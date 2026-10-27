const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createMockDom() {
  const elements = {};
  function makeEl(id) {
    return {
      id,
      innerHTML: '',
      textContent: '',
      style: {},
      attributes: {},
      children: [],
      classList: {
        add: () => {},
        remove: () => {},
        contains: () => false,
        toggle: () => {}
      },
      setAttribute(k, v) { this.attributes[k] = v; },
      getAttribute(k) { return this.attributes[k]; }
    };
  }

  const elIds = [
    'bandarmologiIntelContent', 'bandarmologiContent', 'panel-tab-intel',
    'intelSearchBarContainer', 'intelSearchInput', 'btnIntelSearch', 'intelActiveTickerTag',
    'subTabBrokerSummary', 'subTabAkumulasiBroker', 'subTabIntelBandar',
    'bandarPanelTitle', 'bandarActiveTickerTag', 'bandarTickerSearchInput'
  ];
  for (const id of elIds) {
    elements[id] = makeEl(id);
  }

  const sandbox = {
    window: {},
    document: {
      getElementById: (id) => elements[id] || null,
      createElement: (tag) => makeEl('created-' + tag),
      querySelectorAll: () => []
    },
    console,
    URL,
    Intl,
    Date,
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {}
    }
  };
  sandbox.window.localStorage = sandbox.localStorage;
  sandbox.window.document = sandbox.document;
  sandbox.globalThis = sandbox.window;
  vm.createContext(sandbox);

  const runtimeSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'bandarmologi-runtime.js'), 'utf8');
  vm.runInContext(runtimeSrc, sandbox);

  return { sandbox, elements };
}

test('Sinyal Intelijen: exports pillar active control functions', () => {
  const { sandbox } = createMockDom();
  const runtime = sandbox.window.BandarmologiRuntime;

  assert.equal(typeof runtime.setBandarIntelActivePillar, 'function');
  assert.equal(typeof runtime.getBandarIntelActivePillar, 'function');
  assert.equal(runtime.getBandarIntelActivePillar(), 0);

  runtime.setBandarIntelActivePillar(2);
  assert.equal(runtime.getBandarIntelActivePillar(), 2);
});

test('Sinyal Intelijen: renders canvas 4-pillar board with confluence dots', () => {
  const { sandbox, elements } = createMockDom();
  const runtime = sandbox.window.BandarmologiRuntime;
  const container = elements.bandarmologiIntelContent;

  const mockData = {
    success: true,
    ticker: 'BBCA',
    result: {
      ticker: 'BBCA',
      evaluated_at: '2026-10-15',
      confluence_badge: 'STRONG_ACCUMULATION',
      bullish_signals_count: 3,
      signals: {
        harga_di_bawah_modal_bandar: { triggered: true, current_price: 10200, bandar_avg_buy: 10243 },
        silent_foreign_accumulation: { triggered: true, total_foreign_net_val: 412000000000 },
        ritel_cutloss_vs_bandar: { triggered: false },
        concentration_ratio: { cr3: 68.4, cr5: 82.1, top_3_brokers: ['ZP', 'CC', 'AK'] }
      }
    }
  };

  runtime.renderBandarmologiIntelUI(container, mockData);
  const html = container.innerHTML;

  // Canvas elements
  assert.ok(html.includes('class="pillars"'), 'Contains .pillars grid');
  assert.ok(html.includes('class="pil'), 'Contains .pil pillar buttons');
  assert.ok(html.includes('Aliran asing'), 'Contains Pillar 1 Aliran asing');
  assert.ok(html.includes('Broker bandar'), 'Contains Pillar 2 Broker bandar');
  assert.ok(html.includes('Struktur penawaran'), 'Contains Pillar 3 Struktur penawaran');
  assert.ok(html.includes('Teknikal'), 'Contains Pillar 4 Teknikal');
  assert.ok(html.includes('class="dots"'), 'Contains confluence dots');
  assert.ok(html.includes('bukti dasar'), 'Contains detail evidence card');
  assert.ok(html.includes('class="vb"'), 'Contains mini chart bars .vb');
  assert.ok(html.includes('class="adv-tools"'), 'Contains legacy tools in <details class="adv-tools">');
});

test('Sinyal Intelijen: switches to scanner mode and renders scanner table', () => {
  const { sandbox, elements } = createMockDom();
  const runtime = sandbox.window.BandarmologiRuntime;
  const container = elements.bandarmologiIntelContent;

  runtime.setBandarIntelViewMode('scanner');
  assert.equal(runtime.getBandarIntelViewMode(), 'scanner');

  runtime.renderBandarmologiIntelUI(container);
  const html = container.innerHTML;

  assert.ok(html.includes('Scanner konfluensi'), 'Contains Scanner konfluensi title');
  assert.ok(html.includes('class="tbl"'), 'Contains .tbl table');
  assert.ok(html.includes('Asing 3H'), 'Contains Asing 3H header');
  assert.ok(html.includes('Vol/Avg20'), 'Contains Vol/Avg20 header');
  assert.ok(html.includes('RSI 14'), 'Contains RSI 14 header');
});
