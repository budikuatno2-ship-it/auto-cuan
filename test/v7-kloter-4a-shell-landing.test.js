'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('V7 Kloter 4A assets, NOTICE attribution, and tokens-v7.css exist with zero !important', () => {
  const notice = read('NOTICE');
  assert.match(notice, /TradingView Lightweight Charts/i);
  assert.match(notice, /Apache ECharts/i);
  assert.match(notice, /Kaleksanan Barqi Aji Massani/i);
  assert.match(notice, /Motion \(motion\/mini\)/i);
  assert.match(notice, /Floating UI/i);
  assert.match(notice, /focus-trap/i);

  const tokensCss = read('public/tokens-v7.css');
  assert.match(tokensCss, /@layer\s+reset,\s*tokens,\s*base,\s*components,\s*utilities,\s*overrides/);
  assert.match(tokensCss, /--ac-on-brand:\s*#FFFFFF/i);
  assert.match(tokensCss, /--ac-on-brand:\s*#0A0A0A/i);
  assert.equal(tokensCss.includes('!important'), false, 'tokens-v7.css must contain zero !important');

  for (const rel of [
    'public/vendor/motion-mini.min.js',
    'public/vendor/floating-ui.dom.umd.min.js',
    'public/vendor/focus-trap.umd.min.js',
    'public/v7-shell.css',
    'public/v7-motion-shell.js'
  ]) {
    const abs = path.join(ROOT, rel);
    assert.ok(fs.existsSync(abs), rel + ' must exist');
    if (rel.endsWith('.js')) {
      assert.doesNotThrow(() => new vm.Script(read(rel), { filename: rel }));
    }
  }
});

test('public/index.html enables V7 scoped tokens, frosted shell, auth switcher, and attribution trigger without breaking legacy IDs', () => {
  const html = read('public/index.html');
  assert.match(html, /<html[^>]+data-ac-v7="true"/);
  assert.match(html, /href="\/tokens-v7\.css\?v=v7-4a"/);
  assert.match(html, /href="\/v7-shell\.css\?v=v7-4a"/);
  assert.match(html, /src="\/vendor\/motion-mini\.min\.js/);
  assert.match(html, /src="\/vendor\/floating-ui\.dom\.umd\.min\.js/);
  assert.match(html, /src="\/vendor\/focus-trap\.umd\.min\.js/);
  assert.match(html, /src="\/v7-motion-shell\.js/);
  assert.match(html, /data-v7-open-notice="1"/);
  assert.match(html, /class="v7-auth-switcher"/);

  for (const id of ['landingPage', 'authChoiceModal', 'loginModal', 'registerModal', 'dashboardScreen', 'page-dashboard', 'page-subscription', 'nav-subscription', 'sidebarAccountEntry', 'headerUserLabel']) {
    assert.ok(html.includes('id="' + id + '"'), 'Key ID preserved: ' + id);
  }
});

test('v7-shell.css & v7-motion-shell.js enforce living motion, fluid sliding pill, reduced motion, and Light/Dark parity', () => {
  const css = read('public/v7-shell.css');
  assert.match(css, /backdrop-filter:\s*blur\(/);
  assert.match(css, /\.v7-sliding-pill/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.doesNotMatch(css, /#000000/);

  const js = read('public/v7-motion-shell.js');
  assert.match(js, /window\.AutoCuanV7Motion|root\.AutoCuanV7Motion/);
  assert.match(js, /syncSlidingIndicator/);
  assert.match(js, /FloatingUIDOM/);
  assert.match(js, /focusTrap/);
  assert.match(js, /prefers-reduced-motion/);
});

test('DESIGN.md v2.0 preserves FIX-23 contracts while retiring legacy Konglo Screener phrasing', () => {
  const design = read('DESIGN.md');
  assert.match(design, /Auto-Cuan DESIGN\.md — V2\.0/);
  assert.match(design, /Three-Horizon/);
  assert.match(design, /## 109\. V7 Design System/);
  assert.doesNotMatch(design, /Primary modes:\s*Konglo,\s*Non-Konglo,\s*Day Trade/);
});

test('Manual payment installBuyButtons wires onto visible #acPanelLangganan as well as #acPanelSubscription', () => {
  const payJs = read('public/subscription-manual-payment-v1.js');
  assert.match(payJs, /#acPanelLangganan/);
  assert.match(payJs, /ac-pay-stepper/);
});
