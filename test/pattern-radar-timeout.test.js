'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('Pattern Radar: analisis-saham.html includes Pattern Radar runtime scripts', () => {
  const html = read('public/analisis-saham.html');
  assert.ok(html.includes('/ui-stability-fix.js'), 'Loads ui-stability-fix.js');
  assert.ok(html.includes('/pattern-map.js'), 'Loads pattern-map.js');
  assert.ok(html.includes('/pattern-visual.js'), 'Loads pattern-visual.js');
  assert.ok(html.includes('/pattern-safety-hardening-v1.js'), 'Loads pattern-safety-hardening-v1.js');
  assert.ok(html.includes('/pattern-direction-safety.js'), 'Loads pattern-direction-safety.js');
  assert.ok(html.includes('/pattern-stable-runtime.js'), 'Loads pattern-stable-runtime.js');
});

test('Pattern Radar: pattern-stable-runtime.js supports panel-tab-pattern and switchAnalisisTab', () => {
  const src = read('public/pattern-stable-runtime.js');
  assert.ok(src.includes('panel-tab-pattern'), 'Supports panel-tab-pattern container');
  assert.ok(src.includes('switchAnalisisTab'), 'Supports switchAnalisisTab navigation');
  assert.ok(src.includes('AbortController'), 'Implements AbortController timeout protection for fetch calls');
  assert.ok(src.includes('timeoutMs'), 'Passes timeout to fetch requests');
  assert.match(src, /Scan belum berhasil atau waktu habis/, 'Provides clear timeout/failure message');
});

test('Pattern Radar: analisis-saham-runtime.js defines loadPatternRadarTab and renders error state on timeout', async () => {
  const runtimeSource = read('public/analisis-saham-runtime.js');

  const elements = {};
  function mockEl(id) {
    if (!elements[id]) {
      elements[id] = {
        id,
        style: {},
        classList: {
          contains: () => false,
          add: () => {},
          remove: () => {},
          toggle: () => {}
        },
        setAttribute: () => {},
        innerHTML: '',
        textContent: ''
      };
    }
    return elements[id];
  }

  // Pre-seed pattern container
  mockEl('patternSubTabContainer').innerHTML = '<span class="spinner-sm"></span> Menyiapkan Pattern Radar...';
  mockEl('panel-tab-pattern');
  mockEl('tabAnalisisPattern');

  const timers = [];
  const sandbox = {
    window: {
      location: { pathname: '/analisis-saham', search: '' },
      history: { replaceState: () => {} },
      dispatchEvent: () => {}
    },
    document: {
      addEventListener: () => {},
      readyState: 'complete',
      getElementById: mockEl,
      querySelectorAll: () => []
    },
    localStorage: {
      getItem: (k) => k === 'autocuan_user' ? 'budi' : (k === 'autocuan_is_admin' ? 'true' : null),
      setItem: () => {}
    },
    setTimeout: (fn, ms) => {
      const id = setTimeout(fn, Math.min(ms, 10));
      timers.push(id);
      return id;
    },
    clearTimeout: (id) => clearTimeout(id),
    Date,
    console
  };
  sandbox.globalThis = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(runtimeSource, sandbox);

  const root = sandbox.window;
  assert.equal(typeof root.loadPatternRadarTab, 'function', 'Exposes loadPatternRadarTab');
  assert.equal(typeof root.renderPatternRadarError, 'function', 'Exposes renderPatternRadarError');

  // Test when ensurePatternRadarMounted is available: it calls it immediately
  let mounted = false;
  root.ensurePatternRadarMounted = (target) => {
    mounted = true;
    target.innerHTML = '<div id="psShell">Pattern Radar Mounted</div>';
  };

  root.switchAnalisisTab('pattern');
  assert.ok(mounted, 'ensurePatternRadarMounted was called when tab switched to pattern');
  assert.ok(elements['patternSubTabContainer'].innerHTML.includes('Pattern Radar Mounted'));

  // Test error state rendering
  root.renderPatternRadarError(elements['patternSubTabContainer'], 'Uji pesan error timeout');
  assert.ok(elements['patternSubTabContainer'].innerHTML.includes('Gagal Menyiapkan Pattern Radar'));
  assert.ok(elements['patternSubTabContainer'].innerHTML.includes('Uji pesan error timeout'));
  assert.ok(elements['patternSubTabContainer'].innerHTML.includes('Coba Lagi'));

  timers.forEach(t => clearTimeout(t));
});
