'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const bandarmologiService = require('../lib/bandarmologi-service');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

function createMockDom() {
  const elements = {};
  function makeEl(id, tag = 'div') {
    if (!elements[id]) {
      elements[id] = {
        id,
        tagName: tag.toUpperCase(),
        className: '',
        style: {},
        innerHTML: '',
        textContent: '',
        value: '',
        attributes: {},
        children: [],
        classList: {
          add: function (...classes) { classes.forEach(c => { if (!elements[id].className.includes(c)) elements[id].className += ' ' + c; }); },
          remove: function (...classes) { classes.forEach(c => { elements[id].className = elements[id].className.replace(new RegExp('\\b' + c + '\\b', 'g'), '').trim(); }); },
          contains: function (c) { return elements[id].className.includes(c); }
        },
        setAttribute: function (k, v) { elements[id].attributes[k] = String(v); },
        getAttribute: function (k) { return elements[id].attributes[k] || null; },
        removeAttribute: function (k) { delete elements[id].attributes[k]; },
        addEventListener: function () {},
        scrollIntoView: function () {}
      };
    }
    return elements[id];
  }

  makeEl('insiderNetworkDedicatedContent');
  makeEl('bandarmologiContent');

  const document = {
    getElementById: function (id) {
      return makeEl(id);
    },
    querySelectorAll: function () { return []; },
    head: { appendChild: function () {} },
    createElement: function (tag) { return makeEl('elem_' + Math.random().toString(36).slice(2), tag); }
  };

  const sandbox = {
    window: {
      document,
      location: { href: 'http://localhost/', pathname: '/', search: '', hash: '' },
      history: { replaceState: function () {} },
      addEventListener: function () {},
      fetch: async function () { return { json: async () => ({ success: true, roster: [] }) }; }
    },
    document,
    console,
    Intl,
    Date,
    URL,
    setTimeout: function () { return 1; },
    clearTimeout: function () {},
    formatIDR: function (n) { return String(n); }
  };
  sandbox.global = sandbox.window;
  sandbox.globalThis = sandbox.window;
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  return { sandbox, elements };
}

test('normalizeInsiders: separates absolute balance (shares) from transaction mutation (last_change)', () => {
  const mockRaw = [
    {
      date: '2026-09-08',
      name: 'PT Abadimukti Gunalestari',
      position: 'Pengendali',
      action_type: 'BUY',
      shares_after: '2,147,483,648',
      changes_value: '1,500,000',
      pct_change: '0.07%'
    },
    {
      date: '2026-09-05',
      name: 'Direktur Utama',
      position: 'Direksi',
      action_type: 'SELL',
      current_value: 50000000,
      volume: 250000,
      pct_change: '-0.5%'
    }
  ];

  const normalized = bandarmologiService.normalizeInsiders(mockRaw);

  assert.equal(normalized.length, 2);

  // Item 1: GPRA controlling shareholder
  assert.equal(normalized[0].name, 'PT Abadimukti Gunalestari');
  assert.equal(normalized[0].shares, 2147483648, 'shares must reflect total absolute holding (shares_after)');
  assert.equal(normalized[0].last_change, 1500000, 'last_change must reflect transaction mutation (changes_value)');
  assert.equal(normalized[0].action_type, 'BUY');

  // Item 2: Director transaction
  assert.equal(normalized[1].shares, 50000000, 'shares must reflect current_value when shares_after is null');
  assert.equal(normalized[1].last_change, 250000, 'last_change must reflect volume');
  assert.equal(normalized[1].action_type, 'SELL');
});

test('normalizeInsiders: preserves null when absolute balance fields are absent without falling back to changes_value', () => {
  const mockOnlyMutation = [
    {
      date: '2026-09-01',
      name: 'Investor X',
      action_type: 'BUY',
      changes_value: '10,000',
      pct_change: '0.01%'
    }
  ];

  const normalized = bandarmologiService.normalizeInsiders(mockOnlyMutation);
  assert.equal(normalized[0].shares, null, 'shares must be null when no absolute balance field is present');
  assert.equal(normalized[0].last_change, 10000, 'last_change must capture changes_value');
});

test('BandarmologiRuntime: renderInsiderNetworkUI renders structured roster table at top', () => {
  const runtimeSource = read('public/bandarmologi-runtime.js');
  const { sandbox, elements } = createMockDom();
  vm.runInContext(runtimeSource, sandbox);

  const runtime = sandbox.window.BandarmologiRuntime;
  const container = elements.bandarmologiContent;
  runtime.renderInsiderNetworkUI(container, 'BBCA');

  assert.ok(container.innerHTML.includes('id="insiderRosterSection"'), 'Contains roster section');
  assert.ok(container.innerHTML.includes('Daftar Pemegang Saham &amp; Insider'), 'Contains title');
  assert.ok(container.innerHTML.includes('id="insiderRosterTbody"'), 'Contains table tbody');
  assert.ok(container.innerHTML.includes('id="insiderRosterTickerInput"'), 'Contains ticker input');
  assert.ok(container.innerHTML.includes('id="insiderGraphSection"'), 'Contains graph section below table');
});

test('BandarmologiRuntime: renderRosterTableRows correctly formats and filters roster items', () => {
  const runtimeSource = read('public/bandarmologi-runtime.js');
  const { sandbox, elements } = createMockDom();
  vm.runInContext(runtimeSource, sandbox);

  const runtime = sandbox.window.BandarmologiRuntime;
  const container = elements.bandarmologiContent;
  runtime.renderInsiderNetworkUI(container, 'BBCA');

  const sampleRoster = [
    { no: 1, name: 'Robert Budi Hartono', category: 'Pengendali', position: 'Pengendali Terakhir', shares: 67729700000, percentage: 54.94, percentage_formatted: '54.94%', last_change: '+0.01%', last_date: '2026-09-04' },
    { no: 2, name: 'JAHJA SETIAATMADJA', category: 'Komisaris', position: 'KOMISARIS', shares: 35802700, percentage: 0.03, percentage_formatted: '0.03%', last_change: '+0.0006%', last_date: '2026-03-25' }
  ];

  runtime.renderRosterTableRows(sampleRoster);
  const tbody = elements.insiderRosterTbody;

  assert.ok(tbody.innerHTML.includes('Robert Budi Hartono'), 'Shows Robert Budi Hartono');
  assert.ok(tbody.innerHTML.includes('54.94%'), 'Shows 54.94%');
  assert.ok(tbody.innerHTML.includes('JAHJA SETIAATMADJA'), 'Shows JAHJA SETIAATMADJA');
  assert.ok(tbody.innerHTML.includes('Lihat Graf'), 'Includes action button to view graph');
});

test('API: sector-hot handles action=insider-roster', async () => {
  const handler = require('../api/sector-hot');
  let result = null;
  const res = {
    status: function (code) {
      return {
        json: function (data) {
          result = { code, data };
          return data;
        }
      };
    }
  };

  await handler.__test.handleInsiderRoster({ query: { ticker: 'BBCA' } }, res);
  assert.ok(result, 'Result should exist');
  assert.equal(result.code, 200);
  assert.equal(result.data.success, true);
  assert.equal(result.data.ticker, 'BBCA');
  assert.ok(Array.isArray(result.data.roster));
  assert.ok(result.data.roster.length > 0);
});
