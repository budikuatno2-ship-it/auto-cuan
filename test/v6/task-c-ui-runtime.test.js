'use strict';
/**
 * TASK C — UI runtime proof: the Admin Console button rendered from the
 * incomplete list issues the authenticated POST and re-reads state. Executed
 * in a minimal DOM/fetch stub (no browser, no network, no production state).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

if (process.env.TASK_C_UI !== '1') throw new Error('TASK_C_UI=1 required');
const ROOT = path.resolve(__dirname, '../..');
const runtime = fs.readFileSync(path.join(ROOT, 'public/admin-console-runtime.js'), 'utf8');

function makeDom() {
  const nodes = {};
  function el(id) {
    if (!nodes[id]) {
      const node = { id, innerHTML: '', _text: '', textHistory: [], style: {}, attrs: {}, getAttribute(k) { return this.attrs[k]; }, setAttribute(k, v) { this.attrs[k] = v; } };
      Object.defineProperty(node, 'textContent', {
        get() { return this._text; },
        set(v) { this._text = String(v); this.textHistory.push(this._text); }
      });
      nodes[id] = node;
    }
    return nodes[id];
  }
  return {
    nodes,
    document: {
      readyState: 'complete',
      getElementById: el,
      addEventListener() {},
      body: { appendChild() {} }
    }
  };
}

test('UI-1: runtime exposes loadFinancialPublicationPanel and fpManualFetch', () => {
  const dom = makeDom();
  const calls = [];
  const sandbox = {
    window: {
      location: { pathname: '/admin-console' },
      fetch: async (url, opts) => {
        calls.push({ url, opts });
        return { ok: true, json: async () => ({ success: true }) };
      }
    },
    document: dom.document,
    fetch: async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, json: async () => ({ success: true }) };
    },
    console, setTimeout, clearTimeout, setInterval: function(){return 0;}, clearInterval: function(){}, Intl, Date, JSON, Math, Number, String, Object, Array, Set, Map, Promise, RegExp, Error
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(runtime, sandbox, { timeout: 5000 });
  assert.equal(typeof sandbox.window.loadFinancialPublicationPanel, 'function');
  assert.equal(typeof sandbox.window.fpManualFetch, 'function');
});

test('UI-2: panel renders incomplete issuer with a Fetch (Mock) button carrying ticker|FY|period', async () => {
  const dom = makeDom();
  const responses = {
    '/api/admin/financial-publication?view=status': {
      success: true,
      fetch_windows: { version: 3, periods: { Q1: { startDay: 5, endDay: 15 }, Q2: { startDay: 5, endDay: 15 }, Q3: { startDay: 5, endDay: 15 }, Q4: { startDay: 5, endDay: 15 }, FY: { startDay: 5, endDay: 15 } } },
      incomplete_issuers: { version: 2, count: 1, entries: [{
        ticker: 'E2E', fiscal_year: 2026, period: 'Q3', status: 'MISSING',
        source: 'OFFLINE SYNTHETIC observation', as_of: '2026-11-20', reason: 'no verified publication receipt'
      }] }
    }
  };
  const sandbox = {
    window: { location: { pathname: '/admin-console' }, fetch: async () => ({ ok: true, json: async () => ({ success: true }) }) },
    document: dom.document,
    fetch: async (url) => ({ ok: true, json: async () => responses[url] || { success: true } }),
    console, setTimeout, clearTimeout, setInterval: function(){return 0;}, clearInterval: function(){}, Intl, Date, JSON, Math, Number, String, Object, Array, Set, Map, Promise, RegExp, Error
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(runtime, sandbox, { timeout: 5000 });
  await sandbox.window.loadFinancialPublicationPanel();
  const html = dom.nodes.fpIncompleteTbody.innerHTML;
  assert.ok(html.includes('E2E'), 'ticker rendered');
  assert.ok(html.includes('data-fp-fetch="E2E|2026|Q3"'), 'button carries target key');
  assert.ok(html.includes('Fetch (Mock)'), 'manual fetch button present');
  assert.ok(html.includes('OFFLINE SYNTHETIC observation'), 'source rendered');
  assert.ok(html.includes('no verified publication receipt'), 'reason rendered');
  assert.equal(dom.nodes.fpWindowVersion.textContent, 'v3');
});

test('UI-3: fpManualFetch click issues authenticated POST then re-reads state', async () => {
  const dom = makeDom();
  const calls = [];
  const sandbox = {
    window: { location: { pathname: '/admin-console' }, fetch: async () => ({ ok: true, json: async () => ({ success: true }) }) },
    document: dom.document,
    fetch: async (url, opts) => {
      calls.push({ url, method: opts && opts.method, body: opts && opts.body ? JSON.parse(opts.body) : null });
      if (opts && opts.method === 'POST') {
        return { ok: true, json: async () => ({ success: true, outcome: 'NOT_PUBLISHED', httpRequests: 0, billedUnits: 0 }) };
      }
      return { ok: true, json: async () => ({ success: true, fetch_windows: { version: 1, periods: {} }, incomplete_issuers: { count: 0, entries: [] } }) };
    },
    console, setTimeout, clearTimeout, setInterval: function(){return 0;}, clearInterval: function(){}, Intl, Date, JSON, Math, Number, String, Object, Array, Set, Map, Promise, RegExp, Error
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(runtime, sandbox, { timeout: 5000 });
  const btn = { getAttribute: (k) => (k === 'data-fp-fetch' ? 'E2E|2026|Q3' : null) };
  await sandbox.window.fpManualFetch(btn);
  const post = calls.find((c) => c.method === 'POST' && c.url === '/api/admin/financial-publication');
  assert.ok(post, 'POST issued');
  assert.equal(post.url, '/api/admin/financial-publication');
  assert.equal(post.body.action, 'manual_fetch');
  assert.equal(post.body.ticker, 'E2E');
  assert.equal(post.body.fiscal_year, 2026);
  assert.equal(post.body.period, 'Q3');
  assert.ok(calls.some((c) => c.method !== 'POST'), 'state re-read after click');
  const outcomeText = dom.nodes.fpActionStatus.textHistory.find((t) => t.includes('NOT_PUBLISHED')) || '';
  assert.ok(outcomeText.includes('NOT_PUBLISHED'), 'outcome displayed');
  assert.ok(outcomeText.includes('http=0'), 'zero HTTP calls displayed');
  assert.ok(outcomeText.includes('billed=0'), 'zero billed units displayed');
});
