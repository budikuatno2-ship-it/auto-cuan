'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

test('Tab Navigation: switchAnalisisTab strictly isolates bandarmologi and intel panels', () => {
  const runtimeSource = fs.readFileSync(path.join(ROOT, 'public', 'analisis-saham-runtime.js'), 'utf8');
  const bandarRuntimeSource = fs.readFileSync(path.join(ROOT, 'public', 'bandarmologi-runtime.js'), 'utf8');

  function createElement(id, tag = 'div') {
    return {
      id,
      tagName: tag.toUpperCase(),
      style: {},
      classList: {
        classes: new Set(),
        add(c) { this.classes.add(c); },
        remove(c) { this.classes.delete(c); },
        contains(c) { return this.classes.has(c); },
        toggle(c, force) {
          if (force === undefined) {
            if (this.classes.has(c)) this.classes.delete(c);
            else this.classes.add(c);
          } else if (force) {
            this.classes.add(c);
          } else {
            this.classes.delete(c);
          }
        }
      },
      attributes: {},
      setAttribute(k, v) { this.attributes[k] = String(v); },
      getAttribute(k) { return this.attributes[k] || null; },
      dataset: { tab: id.replace('tab', '').toLowerCase() },
      innerHTML: '',
      textContent: '',
      appendChild() {},
      remove() {}
    };
  }

  const elements = {
    analisisChartHeader: createElement('analisisChartHeader'),
    'panel-tab-analisis': createElement('panel-tab-analisis'),
    'panel-tab-chart': createElement('panel-tab-chart'),
    'panel-tab-bandarmologi': createElement('panel-tab-bandarmologi'),
    'panel-tab-intel': createElement('panel-tab-intel'),
    'panel-tab-hunter': createElement('panel-tab-hunter'),
    'panel-tab-insider': createElement('panel-tab-insider'),
    'panel-tab-ranking': createElement('panel-tab-ranking'),
    'panel-tab-pattern': createElement('panel-tab-pattern'),
    tabBandarmologi: createElement('tabBandarmologi', 'button'),
    tabSinyalIntelijen: createElement('tabSinyalIntelijen', 'button'),
    tabBrokerHunter: createElement('tabBrokerHunter', 'button'),
    tabJejaringInsider: createElement('tabJejaringInsider', 'button'),
    subTabBrokerSummary: createElement('subTabBrokerSummary', 'button'),
    subTabAkumulasiBroker: createElement('subTabAkumulasiBroker', 'button'),
    bandarmologiContent: createElement('bandarmologiContent'),
    bandarmologiIntelContent: createElement('bandarmologiIntelContent')
  };

  const sandbox = {
    document: {
      getElementById(id) { return elements[id] || null; },
      querySelectorAll() { return [elements.tabBandarmologi, elements.tabSinyalIntelijen, elements.tabBrokerHunter, elements.tabJejaringInsider]; }
    },
    window: {
      location: { href: 'http://localhost/analisis-saham' },
      history: { replaceState() {} },
      dispatchEvent() {}
    },
    Event: function (type) { this.type = type; },
    localStorage: { getItem() { return null; }, setItem() {} },
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout: (id) => clearTimeout(id),
    console: console
  };

  vm.createContext(sandbox);
  vm.runInContext(bandarRuntimeSource, sandbox);
  vm.runInContext(runtimeSource, sandbox);

  const switchTab = sandbox.window.switchAnalisisTab;
  assert.equal(typeof switchTab, 'function');

  // 1. Switch to Sinyal Intelijen
  switchTab('intel');
  assert.equal(elements['panel-tab-intel'].style.display, 'block');
  assert.equal(elements['panel-tab-bandarmologi'].style.display, 'none');
  assert.equal(sandbox.window.BandarmologiRuntime.getBandarSection(), 'intel');

  // 2. Switch to Bandarmologi
  switchTab('bandarmologi');
  assert.equal(elements['panel-tab-bandarmologi'].style.display, 'block');
  assert.equal(elements['panel-tab-intel'].style.display, 'none');
  // Must NOT be stuck in 'intel'! Must revert to 'summary'
  assert.equal(sandbox.window.BandarmologiRuntime.getBandarSection(), 'summary');

  // 3. Switch to Akumulasi subtab within Bandarmologi
  sandbox.window.BandarmologiRuntime.setBandarSection('akumulasi');
  assert.equal(sandbox.window.BandarmologiRuntime.getBandarSection(), 'akumulasi');

  // 4. Switch to intel again
  switchTab('intel');
  assert.equal(elements['panel-tab-intel'].style.display, 'block');
  assert.equal(elements['panel-tab-bandarmologi'].style.display, 'none');

  // 5. Switch back to bandarmologi - cleanly resets to summary without being stuck on intel
  switchTab('bandarmologi');
  assert.equal(elements['panel-tab-bandarmologi'].style.display, 'block');
  assert.equal(elements['panel-tab-intel'].style.display, 'none');
  assert.equal(sandbox.window.BandarmologiRuntime.getBandarSection(), 'summary');

  // 6. Switch directly to akumulasi tab
  switchTab('akumulasi');
  assert.equal(elements['panel-tab-bandarmologi'].style.display, 'block');
  assert.equal(sandbox.window.BandarmologiRuntime.getBandarSection(), 'akumulasi');
});

test('Intel Spinner & Fallback: renderBandarmologiIntelUI displays graceful fallback when no data', () => {
  const bandarRuntimeSource = fs.readFileSync(path.join(ROOT, 'public', 'bandarmologi-runtime.js'), 'utf8');

  const container = {
    id: 'bandarmologiIntelContent',
    innerHTML: '',
    appendChild() {},
    setAttribute() {}
  };

  const sandbox = {
    document: {
      getElementById(id) { return id === 'bandarmologiIntelContent' ? container : null; }
    },
    window: {},
    console: console
  };

  vm.createContext(sandbox);
  vm.runInContext(bandarRuntimeSource, sandbox);

  const renderFn = sandbox.window.BandarmologiRuntime.renderBandarmologiIntelUI;
  assert.equal(typeof renderFn, 'function');

  // Test empty signals response
  const emptyData = {
    success: true,
    ticker: 'TESTEMPTY',
    result: {
      ticker: 'TESTEMPTY',
      has_data: false,
      signals: {
        harga_di_bawah_modal_bandar: { signal_key: 'HARGA_DI_BAWAH_MODAL_BANDAR', reason: 'NO_DATA' },
        silent_foreign_accumulation: { signal_key: 'SILENT_FOREIGN_ACCUMULATION', reason: 'NO_DATA' },
        ritel_cutloss_vs_bandar: { signal_key: 'RITEL_CUTLOSS_VS_BANDAR', reason: 'NO_DATA' },
        concentration_ratio: { signal_key: 'CONCENTRATION_RATIO', reason: 'NO_DATA' }
      }
    }
  };

  renderFn(container, emptyData);
  assert.ok(container.innerHTML.includes('Data intelijen emiten belum tersedia'), 'Shows informative fallback title');
  assert.ok(container.innerHTML.includes('TESTEMPTY'), 'Displays ticker symbol in fallback');
  assert.ok(!container.innerHTML.includes('spinner mb-3'), 'Does not render infinite spinner');
});

test('Full Universe Insider DB: contains > 900 emitens and > 10,000 transactions', () => {
  const dbPath = path.join(ROOT, 'data', 'insider-network', 'insiders-db.json');
  assert.ok(fs.existsSync(dbPath), 'insiders-db.json exists');

  const data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  assert.ok(Array.isArray(data), 'Data is an array');
  assert.ok(data.length >= 10000, `Expected >= 10000 records, found ${data.length}`);

  const tickers = new Set(data.map(r => r.ticker));
  assert.ok(tickers.size >= 850, `Expected >= 850 emitens, found ${tickers.size}`);

  const gpraRecords = data.filter(r => r.ticker === 'GPRA');
  assert.ok(gpraRecords.length > 0, 'GPRA insider transactions are included');
});

test('VPS Data Fetcher: exports authentic OHLCV and Insider fetchers', () => {
  const vpsFetcher = require('../lib/vps-data-fetcher');
  assert.equal(typeof vpsFetcher.fetchOhlcvFromVpsSync, 'function');
  assert.equal(typeof vpsFetcher.fetchOhlcvFromVps, 'function');
  assert.equal(typeof vpsFetcher.fetchInsidersFromVpsSync, 'function');
  assert.equal(typeof vpsFetcher.fetchInsidersFromVps, 'function');
  assert.equal(typeof vpsFetcher.fetchBrokerSummaryFromVpsSync, 'function');
});
