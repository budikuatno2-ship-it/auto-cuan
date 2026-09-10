'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

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