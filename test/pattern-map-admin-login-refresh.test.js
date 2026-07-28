'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'pattern-map.js'), 'utf8');

function element(classes) {
  const values = new Set(String(classes || '').split(/\s+/).filter(Boolean));
  return {
    textContent: '',
    attributes: {},
    classList: {
      add(name) { values.add(name); },
      remove(name) { values.delete(name); },
      contains(name) { return values.has(name); },
      toggle(name, force) {
        if (force === undefined) force = !values.has(name);
        if (force) values.add(name); else values.delete(name);
        return force;
      }
    },
    setAttribute(name, value) { this.attributes[name] = value; }
  };
}

function adminResponse() {
  return {
    success: true,
    allowed: true,
    access: 'admin',
    username: 'budi',
    expires_at: new Date(Date.now() + 60_000).toISOString()
  };
}

function harness(fetchImpl) {
  const elements = {
    technicalChartTab: element('bg-emerald-500 text-black'),
    patternChartTab: element('hidden bg-dark-700 text-gray-300'),
    chartPageContainer: element(''),
    patternPageContainer: element('hidden')
  };
  const calls = { enterApp: 0, reset: 0, render: 0 };
  const sandbox = {
    console,
    Promise,
    Map,
    Set,
    Date,
    JSON,
    Object,
    String,
    Number,
    Boolean,
    Math,
    RegExp,
    AbortController,
    document: {
      readyState: 'complete',
      visibilityState: 'visible',
      getElementById(id) { return elements[id] || null; },
      addEventListener() {}
    },
    addEventListener() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    fetch: fetchImpl,
    setChartTabSelected(tab, selected) {
      tab.setAttribute('aria-selected', String(selected));
      tab.classList.toggle('bg-emerald-500', selected);
      tab.classList.toggle('text-black', selected);
      tab.classList.toggle('bg-dark-700', !selected);
      tab.classList.toggle('text-gray-300', !selected);
    },
    resetPatternMap() { calls.reset += 1; },
    renderPatternTab() { calls.render += 1; },
    enterApp() { calls.enterApp += 1; }
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { sandbox, elements, calls };
}

function jsonResponse(body, ok) {
  return { ok: ok !== false, status: ok === false ? 403 : 200, json: async () => body };
}

test('an in-page admin login refreshes signed Pattern access without a reload', async () => {
  let response = jsonResponse({ success: false, allowed: false }, false);
  const h = harness(async () => response);

  await h.sandbox.PatternMapAdminAccess.refresh(true);
  assert.equal(h.sandbox.PatternMapAdminAccess.isAllowed(), false);
  assert.equal(h.elements.patternChartTab.classList.contains('hidden'), true);

  response = jsonResponse(adminResponse(), true);
  h.sandbox.enterApp();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(h.calls.enterApp, 1);
  assert.equal(h.sandbox.PatternMapAdminAccess.isAllowed(), true);
  assert.equal(h.elements.patternChartTab.classList.contains('hidden'), false);
  assert.equal(h.elements.patternChartTab.textContent, 'Pattern Map');
  assert.equal(h.calls.render, 0, 'login refresh must not eagerly invoke QuickChart rendering');
});

test('Technical Chart does not abort a pending admin-session verification', async () => {
  let release;
  let capturedSignal;
  const pending = new Promise(resolve => { release = resolve; });
  const h = harness(async (url, options) => {
    capturedSignal = options.signal;
    return pending;
  });

  const access = h.sandbox.PatternMapAdminAccess.refresh(true);
  assert.equal(h.sandbox.showChartTab('technical'), true);
  assert.equal(capturedSignal.aborted, false);
  assert.equal(h.elements.chartPageContainer.classList.contains('hidden'), false);

  release(jsonResponse(adminResponse(), true));
  assert.equal(await access, true);
  assert.equal(h.sandbox.PatternMapAdminAccess.isAllowed(), true);
  assert.equal(h.elements.patternChartTab.classList.contains('hidden'), false);
  assert.equal(h.calls.render, 0);
});
