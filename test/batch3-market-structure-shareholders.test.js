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
  assert.match(runtimeSource, /var pctStr = r\.percentage_formatted \|\| \(pct != null \? pct\.toFixed\(2\) \+ '%' : '—'\)/);
});

test('Batch 3: HSC Status formatting is strictly fail-closed when as_of date is missing', () => {
  const runtimeSource = read('public/analisis-saham-runtime.js');
  // function formatHscStatus(flag, asOf)
  assert.match(runtimeSource, /function formatHscStatus\(flag,\s*asOf\)\s*\{/);
  assert.match(runtimeSource, /if \(!asOf && flag !== true\) return 'Belum Terverifikasi';/);
  assert.match(runtimeSource, /if \(flag === true\) return 'HSC Aktif';/);
  assert.match(runtimeSource, /if \(flag === false\) return 'Tidak Terindikasi HSC';/);
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
  assert.match(css, /#marketStructureTableContainer\s*\{[^}]*max-height:\s*min\(65vh,\s*680px\);[^}]*overflow-y:\s*auto;/);
  assert.match(css, /#marketStructureTable thead th\s*\{[^}]*position:\s*sticky;\s*top:\s*0;/);
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
  const fetchMock = async (url) => {
    requestedUrl = url;
    return {
      json: async () => ({ success: true, ticker: 'BBCA', count: 2, roster: sampleRoster })
    };
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
});
