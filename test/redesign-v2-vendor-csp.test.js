'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

test('F8: Self-hosted vendor files exist in public/vendor/ with valid payloads', () => {
  const lwcPath = path.join(ROOT, 'public', 'vendor', 'lightweight-charts.standalone.production.js');
  const jspdfPath = path.join(ROOT, 'public', 'vendor', 'jspdf.umd.min.js');
  const autoTablePath = path.join(ROOT, 'public', 'vendor', 'jspdf.plugin.autotable.min.js');

  assert.ok(fs.existsSync(lwcPath), 'lightweight-charts must exist in public/vendor');
  assert.ok(fs.existsSync(jspdfPath), 'jspdf.umd.min.js must exist in public/vendor');
  assert.ok(fs.existsSync(autoTablePath), 'jspdf.plugin.autotable.min.js must exist in public/vendor');

  assert.ok(fs.statSync(lwcPath).size > 100000, 'lightweight-charts must not be empty or stub');
  assert.ok(fs.statSync(jspdfPath).size > 200000, 'jspdf must not be empty or stub');
  assert.ok(fs.statSync(autoTablePath).size > 20000, 'autotable must not be empty or stub');

  // Verify LightweightCharts loads and exports version 4.1.1
  const lwcCode = fs.readFileSync(lwcPath, 'utf8');
  const win = { navigator: { userAgent: 'NodeTest' }, document: { createElement: () => ({}) } };
  win.window = win;
  const sandbox = { window: win, navigator: win.navigator, document: win.document };
  vm.createContext(sandbox);
  vm.runInContext(lwcCode, sandbox);
  assert.equal(typeof win.LightweightCharts, 'object', 'LightweightCharts object must be present');
  assert.equal(win.LightweightCharts.version(), '4.1.1', 'Must match exact expected version 4.1.1');
});

test('F8: Zero external CDN script and font URLs in public/ runtime assets', () => {
  const filesToCheck = [
    path.join(ROOT, 'public', 'index.html'),
    path.join(ROOT, 'public', 'market-feature-runtime.js'),
    path.join(ROOT, 'public', 'admin-console.html'),
    path.join(ROOT, 'public', 'ketentuan.html'),
    path.join(ROOT, 'public', 'maintenance.html'),
    path.join(ROOT, 'public', 'pattern-radar.html')
  ];

  const forbiddenDomains = [
    'unpkg.com',
    'cdnjs.cloudflare.com',
    'cdn.jsdelivr.net',
    'fonts.googleapis.com',
    'fonts.gstatic.com'
  ];

  for (const file of filesToCheck) {
    const content = fs.readFileSync(file, 'utf8');
    for (const domain of forbiddenDomains) {
      assert.ok(
        !content.includes(domain),
        `File ${path.basename(file)} must not contain external domain: ${domain}`
      );
    }
  }
});

test('F8: Script loaders route through local /vendor/ paths', () => {
  const mfr = fs.readFileSync(path.join(ROOT, 'public', 'market-feature-runtime.js'), 'utf8');
  assert.match(mfr, /\/vendor\/lightweight-charts\.standalone\.production\.js/, 'loadLightweightCharts must use local /vendor/ path');

  const idx = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.match(idx, /['"]\/vendor\/jspdf\.umd\.min\.js['"]/, 'index.html jspdfUrls must use /vendor/');
  assert.match(idx, /['"]\/vendor\/jspdf\.plugin\.autotable\.min\.js['"]/, 'index.html autoTableUrls must use /vendor/');
});

test('F8: Standalone HTML pages reference local fonts and anti-flicker theme-boot', () => {
  const pages = [
    'admin-console.html',
    'ketentuan.html',
    'maintenance.html',
    'pattern-radar.html'
  ];

  for (const page of pages) {
    const html = fs.readFileSync(path.join(ROOT, 'public', page), 'utf8');
    assert.match(html, /<link[^>]+href="\/fonts\/ac-fonts\.css"/, `${page} must link to local /fonts/ac-fonts.css`);
    assert.match(html, /<script[^>]+src="\/theme-boot\.js"/, `${page} must include /theme-boot.js in head`);
  }
});

test('F8: theme-boot.js boots theme safely and sets root attributes', () => {
  const code = fs.readFileSync(path.join(ROOT, 'public', 'theme-boot.js'), 'utf8');
  const classListSet = new Set();
  const attrs = {};
  const mockDoc = {
    documentElement: {
      classList: {
        add: (c) => classListSet.add(c),
        remove: (c) => classListSet.delete(c),
        toggle: (c, state) => { if (state) classListSet.add(c); else classListSet.delete(c); }
      },
      setAttribute: (k, v) => { attrs[k] = v; }
    }
  };
  const mockStorage = {
    autocuan_theme: 'light'
  };
  const win = {
    document: mockDoc,
    localStorage: {
      getItem: (k) => mockStorage[k] || null
    },
    matchMedia: () => ({ matches: false })
  };
  win.window = win;
  const sandbox = { ...win, document: mockDoc, window: win, localStorage: win.localStorage };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  assert.equal(attrs['data-theme'], 'light');
  assert.equal(attrs['data-theme-pref'], 'light');
  assert.ok(classListSet.has('light'));
  assert.ok(!classListSet.has('dark'));
});
