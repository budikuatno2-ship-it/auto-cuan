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
        id,
        style: {},
        className: '',
        classList: {
          contains: (cls) => (elements[id].className || '').includes(cls),
          add: (cls) => {
            if (!(elements[id].className || '').includes(cls)) {
              elements[id].className = ((elements[id].className || '') + ' ' + cls).trim();
            }
          },
          remove: (cls) => {
            elements[id].className = (elements[id].className || '').replace(new RegExp('\\b' + cls + '\\b', 'g'), '').trim();
          },
          toggle: (cls, force) => {
            if (force === true) elements[id].classList.add(cls);
            else if (force === false) elements[id].classList.remove(cls);
          }
        },
        attributes: {},
        setAttribute: (k, v) => { elements[id].attributes[k] = String(v); },
        getAttribute: (k) => elements[id].attributes[k] || null,
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
  mockEl('tabBandarmologi');
  mockEl('tabAkumulasiBroker');
  mockEl('tabBrokerHunter');
  mockEl('bandarPanelTitle');
  mockEl('bandarActiveTickerTag');
  mockEl('bandarTickerSearchInput');
  mockEl('brokerHunterContent');

  const sandbox = {
    window: {
      location: {
        href: 'https://example.com/analisis-saham',
        search: '',
        pathname: '/analisis-saham',
        hash: ''
      },
      history: {
        replaceState: () => {}
      }
    },
    document: {
      head: { appendChild: () => {} },
      getElementById: mockEl,
      querySelectorAll: () => []
    },
    URL,
    Intl,
    Date,
    console,
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {}
    }
  };
  sandbox.window.localStorage = sandbox.localStorage;
  sandbox.globalThis = sandbox.window;
  vm.createContext(sandbox);

  return { sandbox, elements, mockEl };
}

test('HTML: analisis-saham.html includes pure Bandarmologi subtabs and independent Intel & Hunter tabs', () => {
  const html = read('public/analisis-saham.html');

  // Subtab switcher in Bandarmologi panel (purely Broker Summary & Akumulasi Broker)
  assert.ok(html.includes('id="subTabBrokerSummary"'), 'Has subTabBrokerSummary');
  assert.ok(html.includes('id="subTabAkumulasiBroker"'), 'Has subTabAkumulasiBroker');
  assert.ok(!html.includes('id="subTabIntelBandar"'), 'subTabIntelBandar removed from Bandarmologi panel');

  // Standalone top-level tabSinyalIntelijen and panel-tab-intel
  assert.ok(html.includes('id="tabSinyalIntelijen"'), 'Has dedicated tabSinyalIntelijen in top tab strip');
  assert.ok(html.includes("onclick=\"switchAnalisisTab('intel')\""), 'tabSinyalIntelijen calls switchAnalisisTab(intel)');
  assert.ok(html.includes('id="panel-tab-intel"'), 'Has standalone panel-tab-intel');
  assert.ok(html.includes('id="bandarmologiIntelContent"'), 'Has bandarmologiIntelContent');

  // Standalone Broker Hunter top tab and section
  assert.ok(html.includes('id="tabBrokerHunter"'), 'Has tabBrokerHunter in top tab strip');
  assert.ok(html.includes('id="panel-tab-hunter"'), 'Has standalone panel-tab-hunter');
  assert.ok(html.includes('id="brokerHunterContent"'), 'Has brokerHunterContent');
});

test('BandarmologiRuntime: exports all Intelligence functions and broker classifications', () => {
  const runtimeSource = read('public/bandarmologi-runtime.js');
  const { sandbox } = createMockDom();
  vm.runInContext(runtimeSource, sandbox);

  const runtime = sandbox.window.BandarmologiRuntime;
  assert.equal(typeof runtime.setBandarSection, 'function');
  assert.equal(typeof runtime.getBandarSection, 'function');
  assert.equal(typeof runtime.loadBandarmologiIntel, 'function');
  assert.equal(typeof runtime.renderBandarmologiIntelUI, 'function');
  assert.equal(typeof runtime.setBandarIntelViewMode, 'function');
  assert.equal(typeof runtime.getBandarIntelViewMode, 'function');
  assert.equal(typeof runtime.setBandarIntelRange, 'function');
  assert.equal(typeof runtime.getBandarIntelRange, 'function');
  assert.equal(typeof runtime.setBandarIntelScannerCategory, 'function');
  assert.equal(typeof runtime.getBandarIntelScannerCategory, 'function');
  assert.equal(typeof runtime.selectIntelTicker, 'function');

  assert.ok(Array.isArray(runtime.RETAIL_BROKERS), 'RETAIL_BROKERS is an array');
  assert.ok(runtime.RETAIL_BROKERS.includes('YP'), 'YP is in retail list');
  assert.ok(runtime.RETAIL_BROKERS.includes('PD'), 'PD is in retail list');
  assert.ok(runtime.RETAIL_BROKERS.includes('XC'), 'XC is in retail list');
  assert.ok(runtime.RETAIL_BROKERS.includes('XL'), 'XL is in retail list');
  assert.ok(runtime.RETAIL_BROKERS.includes('NI'), 'NI is in retail list');

  assert.equal(runtime.isRetailBroker('YP'), true);
  assert.equal(runtime.isRetailBroker('AK'), false);
  assert.equal(runtime.isInstitutionalBroker('AK'), true);
  assert.equal(runtime.isInstitutionalBroker('BK'), true);
  assert.equal(runtime.isInstitutionalBroker('YP'), false);
});

test('BandarmologiRuntime: setBandarSection toggles active subtabs correctly and decouples broker hunter', () => {
  const runtimeSource = read('public/bandarmologi-runtime.js');
  const { sandbox, elements } = createMockDom();
  vm.runInContext(runtimeSource, sandbox);

  const runtime = sandbox.window.BandarmologiRuntime;

  // Default is summary
  assert.equal(runtime.getBandarSection(), 'summary');

  // Switch to intel
  runtime.setBandarSection('intel');
  assert.equal(runtime.getBandarSection(), 'intel');
  assert.equal(elements.subTabIntelBandar.attributes['aria-selected'], 'true');
  assert.equal(elements.subTabBrokerSummary.attributes['aria-selected'], 'false');
  assert.equal(elements.subTabAkumulasiBroker.attributes['aria-selected'], 'false');
  assert.ok(elements.subTabIntelBandar.className.includes('bg-emerald-500'));
  assert.equal(elements.bandarPanelTitle.textContent, 'Sinyal Intelijen Bandarmologi (4 Sinyal Strategis)');

  // Switch to akumulasi
  runtime.setBandarSection('akumulasi');
  assert.equal(runtime.getBandarSection(), 'akumulasi');
  assert.equal(elements.subTabAkumulasiBroker.attributes['aria-selected'], 'true');
  assert.equal(elements.subTabIntelBandar.attributes['aria-selected'], 'false');
  assert.equal(elements.bandarPanelTitle.textContent, 'Akumulasi Broker & Deteksi Smart Money');

  // Switch to summary
  runtime.setBandarSection('summary');
  assert.equal(runtime.getBandarSection(), 'summary');
  assert.equal(elements.subTabBrokerSummary.attributes['aria-selected'], 'true');
  assert.equal(elements.subTabIntelBandar.attributes['aria-selected'], 'false');
  assert.equal(elements.bandarPanelTitle.textContent, 'Analisis Bandarmologi & Kepemilikan Insider');
});

test('BandarmologiRuntime: renders all 4 Bandarmologi Intelligence Signals in active ticker view', () => {
  const runtimeSource = read('public/bandarmologi-runtime.js');
  const { sandbox, elements } = createMockDom();
  vm.runInContext(runtimeSource, sandbox);

  const runtime = sandbox.window.BandarmologiRuntime;
  const container = elements.bandarmologiContent;

  const mockIntelData = {
    success: true,
    ticker: 'BBCA',
    result: {
      ticker: 'BBCA',
      evaluated_at: '2026-09-08T08:00:00.000Z',
      confluence_badge: 'STRONG_ACCUMULATION',
      bullish_signals_count: 3,
      bearish_signals_count: 0,
      signals: {
        harga_di_bawah_modal_bandar: {
          signal_key: 'HARGA_DI_BAWAH_MODAL_BANDAR',
          signal_name: 'Harga di Bawah Modal Bandar',
          triggered: true,
          current_price: 9850,
          bandar_avg_price: 10120,
          discount_pct: 2.67,
          is_sweet_spot: true,
          top_brokers: ['AK', 'BK', 'CC'],
          top_broker_details: [
            { broker: 'AK', avg_price: 10150 },
            { broker: 'BK', avg_price: 10100 },
            { broker: 'CC', avg_price: 10110 }
          ],
          description: 'Harga saat ini Rp 9,850 lebih murah 2.67% dibanding modal bandar.'
        },
        silent_foreign_accumulation: {
          signal_key: 'SILENT_FOREIGN_ACCUMULATION',
          signal_name: 'Silent Foreign Accumulation',
          triggered: true,
          consecutive_days: 4,
          price_change_pct: 0.8,
          is_sideways: true,
          total_foreign_net_val: 85000000000,
          description: 'Net Foreign Buy positif 4 hari beruntun dengan harga tenang (+0.8%).'
        },
        ritel_cutloss_vs_bandar: {
          signal_key: 'RITEL_CUTLOSS_VS_BANDAR',
          signal_name: 'Ritel Cutloss vs Bandar Nampung',
          triggered: true,
          sub_type: 'BANDAR_NAMPUNG_RITEL_CUTLOSS',
          is_bandar_nampung: true,
          is_distribusi_ke_ritel: false,
          top_buyers: ['AK', 'BK', 'RX'],
          top_sellers: ['YP', 'PD', 'XC'],
          inst_buyer_count: 3,
          retail_seller_count: 3,
          description: 'Top Buyer didominasi institusi (AK, BK, RX) dan Top Seller didominasi ritel cutloss (YP, PD, XC).'
        },
        concentration_ratio: {
          signal_key: 'CONCENTRATION_RATIO',
          signal_name: 'Concentration Ratio (CR3 & CR5)',
          triggered: true,
          is_massive: true,
          cr3: 68.4,
          cr5: 82.1,
          status: 'AKUMULASI_MASIF',
          label: 'Akumulasi Sangat Masif (Monopoli)',
          top_3_brokers: ['AK', 'BK', 'CC'],
          description: 'CR3 sebesar 68.4% dan CR5 sebesar 82.1%. Status: Akumulasi Sangat Masif.'
        }
      }
    }
  };

  runtime.renderBandarmologiIntelUI(container, mockIntelData);
  const html = container.innerHTML;

  // 1. Header & Confluence Banner
  assert.ok(html.includes('Sinyal Intelijen Bandarmologi'), 'Has panel title');
  assert.ok(html.includes('STRONG_ACCUMULATION') || html.includes('SANGAT KUAT (BULLISH CONFLUENCE)'), 'Renders confluence badge');
  assert.ok(html.includes('3 Bullish'), 'Renders 3 Bullish signals count');
  assert.ok(html.includes('0 Bearish'), 'Renders 0 Bearish signals count');

  // 2. Signal 1: Harga di Bawah Modal Bandar
  assert.ok(html.includes('intelCardHargaModal'), 'Renders Card 1 container');
  assert.ok(html.includes('SWEET SPOT'), 'Renders sweet spot badge');
  assert.ok(html.includes('9.850') || html.includes('9,850'), 'Renders current price');
  assert.ok(html.includes('10.120') || html.includes('10,120'), 'Renders bandar avg price');
  assert.ok(html.includes('2.67%'), 'Renders discount percentage');
  assert.ok(html.includes('AK'), 'Renders broker AK');
  assert.ok(html.includes('BK'), 'Renders broker BK');

  // 3. Signal 2: Silent Foreign Accumulation
  assert.ok(html.includes('intelCardSilentForeign'), 'Renders Card 2 container');
  assert.ok(html.includes('ASING AKUMULASI DIAM-DIAM'), 'Renders silent foreign accumulation badge');
  assert.ok(html.includes('4 Hari'), 'Renders 4 consecutive days');
  assert.ok(html.includes('0.8%'), 'Renders price change %');
  assert.ok(html.includes('Tenang'), 'Renders calm/sideways tag');

  // 4. Signal 3: Ritel Cutloss vs Bandar Nampung
  assert.ok(html.includes('intelCardRitelCutloss'), 'Renders Card 3 container');
  assert.ok(html.includes('BANDAR NAMPUNG'), 'Renders bandar nampung badge');
  assert.ok(html.includes('[Inst]'), 'Labels institutional buyers');
  assert.ok(html.includes('[Ritel]'), 'Labels retail sellers');
  assert.ok(html.includes('YP'), 'Renders retail seller YP');
  assert.ok(html.includes('PD'), 'Renders retail seller PD');

  // 5. Signal 4: Concentration Ratio CR3 & CR5
  assert.ok(html.includes('intelCardConcentrationRatio'), 'Renders Card 4 container');
  assert.ok(html.includes('AKUMULASI SANGAT MASIF'), 'Renders massive accumulation badge');
  assert.ok(html.includes('68.4%'), 'Renders CR3 percentage');
  assert.ok(html.includes('82.1%'), 'Renders CR5 percentage');
});

test('BandarmologiRuntime: renders Market-Wide Scanner view with 5 signal categories', () => {
  const runtimeSource = read('public/bandarmologi-runtime.js');
  const { sandbox, elements } = createMockDom();
  vm.runInContext(runtimeSource, sandbox);

  const runtime = sandbox.window.BandarmologiRuntime;
  const container = elements.bandarmologiContent;

  const mockScannerData = {
    success: true,
    total_evaluated: 45,
    summary: {
      harga_di_bawah_modal_bandar_count: 2,
      silent_foreign_accumulation_count: 1,
      ritel_cutloss_bandar_nampung_count: 1,
      distribusi_ke_ritel_count: 1,
      cr3_massive_count: 2
    },
    indexes: {
      harga_di_bawah_modal_bandar: [
        { ticker: 'BBCA', discount_pct: 3.4, note: 'Diskon 3.4% dari modal bandar' },
        { ticker: 'ASII', discount_pct: 4.1, note: 'Diskon 4.1% dari modal bandar' }
      ],
      silent_foreign_accumulation: [
        { ticker: 'BMRI', consecutive_days: 5, note: 'Net foreign buy 5 hari berturut-turut' }
      ],
      ritel_cutloss_bandar_nampung: [
        { ticker: 'TLKM', note: 'Top buyer institusi, seller ritel cutloss' }
      ],
      distribusi_ke_ritel: [
        { ticker: 'GOTO', note: 'Bandar distribusi ke ritel' }
      ],
      cr3_massive: [
        { ticker: 'BBRI', cr3: 71.5, note: 'CR3 71.5% akumulasi sangat masif' },
        { ticker: 'BREN', cr3: 84.2, note: 'CR3 84.2% monopoli bandar' }
      ]
    }
  };

  runtime.setBandarIntelViewMode('scanner');
  runtime.renderBandarmologiIntelUI(container, mockScannerData);
  const html = container.innerHTML;

  // Check 5 categories exist
  assert.ok(html.includes('Di Bawah Modal'), 'Category 1 exists');
  assert.ok(html.includes('Akumulasi Asing'), 'Category 2 exists');
  assert.ok(html.includes('Ritel Cutloss'), 'Category 3 exists');
  assert.ok(html.includes('Distribusi ke Ritel'), 'Category 4 exists');
  assert.ok(html.includes('CR3 Masif'), 'Category 5 exists');

  // Check table content for default category (harga_di_bawah_modal_bandar)
  assert.ok(html.includes('BBCA'), 'Table lists BBCA');
  assert.ok(html.includes('ASII'), 'Table lists ASII');
  assert.ok(html.includes('Analisis &rarr;') || html.includes('Buka Intel &rarr;'), 'Has action button to inspect intel');
});

test('AnalisisSahamRuntime: switchAnalisisTab routes intel to bandarmologi panel and maintains active section', () => {
  const runtimeSource = read('public/analisis-saham-runtime.js');
  const bandarRuntimeSource = read('public/bandarmologi-runtime.js');
  const { sandbox, elements } = createMockDom();

  // Load both runtimes
  vm.runInContext(bandarRuntimeSource, sandbox);
  vm.runInContext(runtimeSource, sandbox);

  const switchTab = sandbox.window.switchAnalisisTab;
  assert.equal(typeof switchTab, 'function');

  // Switch to intel
  switchTab('intel');
  assert.equal(sandbox.window.BandarmologiRuntime.getBandarSection(), 'intel');

  // Switch to akumulasi
  switchTab('akumulasi');
  assert.equal(sandbox.window.BandarmologiRuntime.getBandarSection(), 'akumulasi');

  // Switch to bandarmologi preserving current
  switchTab('bandarmologi');
  assert.equal(sandbox.window.BandarmologiRuntime.getBandarSection(), 'akumulasi');

  // Switch to hunter (standalone)
  switchTab('hunter');
  // Bandarmologi section is NOT changed to hunter
  assert.notEqual(sandbox.window.BandarmologiRuntime.getBandarSection(), 'hunter');
});
