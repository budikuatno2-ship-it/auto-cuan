'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const insiderNetworkService = require('../lib/insider-network-service');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

test('Batch 3: Roster dataset integrity and zero duplicate holders', () => {
  const rosterFile = path.join(__dirname, '..', 'data', 'insider-network', 'roster.json');
  assert.ok(fs.existsSync(rosterFile), 'roster.json must exist');
  const rosterData = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
  const tickers = Object.keys(rosterData.tickers || rosterData);

  assert.equal(tickers.length, 907, 'Must cover 907 tickers');

  let totalEntries = 0;
  let tickersWithDupes = 0;

  tickers.forEach((t) => {
    const list = rosterData.tickers ? rosterData.tickers[t] : rosterData[t];
    totalEntries += list.length;
    const names = new Set();
    for (const item of list) {
      if (names.has(item.name)) {
        tickersWithDupes++;
        break;
      }
      names.add(item.name);
    }
  });

  assert.equal(totalEntries, 2751, 'Total entries must match 2,751');
  assert.equal(tickersWithDupes, 0, 'Zero tickers should contain duplicate holders');
});

test('Batch 3: Missing shareholder data returns empty array without throwing or hallucinating', () => {
  const missingSamples = ['AALI', 'ADCP', 'DLTA', 'HMSP'];
  for (const ticker of missingSamples) {
    const roster = insiderNetworkService.getRosterForTicker(ticker);
    assert.ok(Array.isArray(roster), 'Should return array');
    assert.equal(roster.length, 0, 'Should be empty for tickers without filed >5% insiders');
  }
});

test('Batch 3: Ownership percentage invariant — Unknown is never 0% or 0.00%', () => {
  const rawMissingPct = [{ name: 'Test Holder', position: 'Direktur', shares: 1000000, percentage: null }];
  const roster = insiderNetworkService.getRosterForTicker('UNKNOWN_TICKER');
  assert.equal(roster.length, 0);

  // Directly check parsePercentage behavior
  const runtimeSource = read('public/analisis-saham-runtime.js');
  assert.match(runtimeSource, /var pct = \(pctRaw == null \|\| pctRaw === ''\)\s*\?\s*null/);
  assert.match(runtimeSource, /var pctStr = r\.percentage_formatted \|\| \(pct != null \? pct\.toFixed\(2\) \+ '%' : '-'\)/);
});

test('Batch 3: HSC Status actual rendering is strictly fail-closed when as_of date is missing', () => {
  const elements = new Map();
  function makeEl(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        innerHTML: '',
        textContent: '',
        className: '',
        hidden: false,
        style: { setProperty() {} },
        classList: {
          add(c) { this.className += ' ' + c; },
          remove(c) { this.className = (this.className || '').replace(c, ''); },
          contains(c) { return (this.className || '').includes(c); }
        },
        querySelectorAll() { return []; },
        querySelector() { return null; },
        setAttribute() {},
        getAttribute() { return null; },
        appendChild() {},
        addEventListener() {}
      });
    }
    return elements.get(id);
  }

  const document = {
    readyState: 'complete',
    addEventListener() {},
    getElementById(id) { return makeEl(id); },
    createElement(tag) { return makeEl('elem_' + Math.random().toString(36).slice(2)); },
    createDocumentFragment() { return { appendChild() {} }; },
    querySelectorAll() { return []; }
  };
  const window = {
    document,
    addEventListener() {},
    localStorage: { getItem() { return null; } },
    location: { href: 'http://localhost/analisis-saham', pathname: '/analisis-saham', search: '' }
  };

  const code = read('public/analisis-saham-runtime.js');
  vm.runInNewContext(code, {
    window,
    document,
    console,
    setTimeout,
    clearTimeout,
    URL,
    Intl
  });

  const AutoCuanMarketStructure = window.AutoCuanMarketStructure;
  assert.ok(AutoCuanMarketStructure, 'AutoCuanMarketStructure must be defined on window');

  const testRows = [
    { ticker: 'TRUE_NODATE', hsc_flag: true, hsc_as_of: null, free_float_pct: 20 },
    { ticker: 'FALSE_WITHDATE', hsc_flag: false, hsc_as_of: '2026-10-01', free_float_pct: 20 },
    { ticker: 'UNKNOWN_WITHDATE', hsc_flag: null, hsc_as_of: '2026-10-01', free_float_pct: 20 },
    { ticker: 'UNKNOWN_NODATE', hsc_flag: null, hsc_as_of: null, free_float_pct: 20 },
    { ticker: 'TRUE_WITHDATE', hsc_flag: true, hsc_as_of: '2026-10-01', free_float_pct: 20 }
  ];

  AutoCuanMarketStructure.universe = testRows;

  // 1. HSC true without verified date must NOT be claimed verified
  AutoCuanMarketStructure.selectRow('TRUE_NODATE');
  assert.equal(document.getElementById('marketStructureHsc').textContent, 'Belum Terverifikasi');

  // 2. HSC false with verified date must display Tidak Terindikasi HSC
  AutoCuanMarketStructure.selectRow('FALSE_WITHDATE');
  assert.equal(document.getElementById('marketStructureHsc').textContent, 'Tidak Terindikasi HSC');

  // 3. Unknown (null/undefined) must remain unknown (Belum Terverifikasi)
  AutoCuanMarketStructure.selectRow('UNKNOWN_WITHDATE');
  assert.equal(document.getElementById('marketStructureHsc').textContent, 'Belum Terverifikasi');
  AutoCuanMarketStructure.selectRow('UNKNOWN_NODATE');
  assert.equal(document.getElementById('marketStructureHsc').textContent, 'Belum Terverifikasi');

  // 4. HSC true with verified date displays HSC Aktif
  AutoCuanMarketStructure.selectRow('TRUE_WITHDATE');
  assert.equal(document.getElementById('marketStructureHsc').textContent, 'HSC Aktif');
});

test('Batch 3: Struktur Pasar markup includes isolated scroll and shareholder roster table', () => {
  const files = [
    'public/partials/analisis-saham.partial.html',
    'partials/analisis-saham.partial.html',
    'public/analisis-saham.html',
    'public/index.html'
  ];

  for (const file of files) {
    const content = read(file);
    assert.match(content, /id="marketStructureDetailBody"/, file + ' must have marketStructureDetailBody');
    assert.match(content, /id="marketStructureShareholderSection"/, file + ' must have shareholder section');
    assert.match(content, /id="marketStructureRosterTbody"/, file + ' must have roster table body');
    assert.match(content, /id="marketStructureRosterBadge"/, file + ' must have roster badge');
  }

  const css = read('public/ui-theme.css');
  assert.match(css, /#marketStructureAccordionContainer\s*\{[^}]*max-height:\s*calc\([^}]*overflow-y:\s*auto;/);
});

test('Batch 3: Runtime controller renders shareholder roster into detail pane', async () => {
  const elements = new Map();
  function makeEl(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        innerHTML: '',
        textContent: '',
        className: '',
        hidden: false,
        style: { setProperty() {} },
        classList: {
          add(c) { this.className += ' ' + c; },
          remove(c) { this.className = (this.className || '').replace(c, ''); },
          contains(c) { return (this.className || '').includes(c); }
        },
        querySelectorAll() { return []; },
        querySelector() { return null; },
        setAttribute() {},
        getAttribute() { return null; },
        appendChild() {}
      });
    }
    return elements.get(id);
  }

  const document = {
    readyState: 'loading',
    addEventListener() {},
    getElementById(id) { return makeEl(id); },
    createElement(tag) { return makeEl('elem_' + Math.random().toString(36).slice(2)); },
    createDocumentFragment() {
      return { appendChild() {} };
    }
  };

  const sampleRoster = [
    { no: 1, name: 'PT Dwimuria Investama Andalan', category: 'Pengendali', shares: 67729700000, percentage: 54.94, percentage_formatted: '54.94%' },
    { no: 2, name: 'JAHJA SETIAATMADJA', category: 'Direksi', position: 'Presiden Direktur', shares: 40802700, percentage: 0.03, percentage_formatted: '0.03%' }
  ];

  let requestedUrl = null;
  let fetchResponseGen = () => ({
    ok: true,
    json: async () => ({ success: true, ticker: 'BBCA', count: 2, roster: sampleRoster })
  });

  const fetchMock = async (url) => {
    requestedUrl = url;
    return fetchResponseGen();
  };

  const sandbox = {
    window: { document, addEventListener() {}, localStorage: { getItem() {} } },
    document,
    fetch: fetchMock,
    console,
    setTimeout,
    clearTimeout,
    URL,
    Intl
  };

  vm.runInNewContext(read('public/analisis-saham-runtime.js'), sandbox);

  const controller = sandbox.window.AutoCuanMarketStructure;
  assert.ok(controller, 'AutoCuanMarketStructure controller must exist');
  assert.equal(typeof controller.loadMarketStructureShareholders, 'function');

  await controller.loadMarketStructureShareholders('BBCA');
  assert.match(requestedUrl, /action=insider-roster&ticker=BBCA/);

  const tbody = elements.get('marketStructureRosterTbody');
  assert.ok(tbody.innerHTML.includes('PT Dwimuria Investama Andalan'));
  assert.ok(tbody.innerHTML.includes('54.94%'));
  assert.ok(tbody.innerHTML.includes('JAHJA SETIAATMADJA'));

  const badge = elements.get('marketStructureRosterBadge');
  assert.equal(badge.textContent, '2 Entitas');
  assert.equal(controller.getRosterCache()['BBCA'].length, 2);

  // Test 1: Valid empty data (success: true, roster: [])
  controller.clearRosterCache();
  fetchResponseGen = () => ({
    ok: true,
    json: async () => ({ success: true, ticker: 'EMPTY', count: 0, roster: [] })
  });
  await controller.loadMarketStructureShareholders('EMPTY');
  assert.equal(badge.textContent, 'Belum tersedia');
  assert.ok(tbody.innerHTML.includes('belum dilaporkan pada feed resmi bursa'));
  assert.ok(Array.isArray(controller.getRosterCache()['EMPTY']));
  assert.equal(controller.getRosterCache()['EMPTY'].length, 0);

  // Test 2: HTTP Error response (ok: false, status: 500)
  controller.clearRosterCache();
  fetchResponseGen = () => ({
    ok: false,
    status: 500,
    json: async () => ({ error: 'Internal Server Error' })
  });
  await controller.loadMarketStructureShareholders('ERR500');
  assert.equal(badge.textContent, 'Gagal memuat');
  assert.ok(tbody.innerHTML.includes('Gagal memuat data pemegang saham: HTTP 500'));
  // CRITICAL: Failed HTTP response must NEVER be cached!
  assert.equal(controller.getRosterCache()['ERR500'], undefined);

  // Test 3: API success: false response
  controller.clearRosterCache();
  fetchResponseGen = () => ({
    ok: true,
    json: async () => ({ success: false, error: 'Database service unavailable' })
  });
  await controller.loadMarketStructureShareholders('ERR_API');
  assert.equal(badge.textContent, 'Gagal memuat');
  assert.ok(tbody.innerHTML.includes('Gagal memuat data pemegang saham: Database service unavailable'));
  // CRITICAL: success:false must NEVER be cached!
  assert.equal(controller.getRosterCache()['ERR_API'], undefined);

  // Test 4: Network throw
  controller.clearRosterCache();
  fetchResponseGen = () => {
    throw new Error('Network offline');
  };
  await controller.loadMarketStructureShareholders('ERR_NET');
  assert.equal(badge.textContent, 'Gagal memuat');
  assert.ok(tbody.innerHTML.includes('Gagal memuat data pemegang saham: Network offline'));
  assert.equal(controller.getRosterCache()['ERR_NET'], undefined);
});
