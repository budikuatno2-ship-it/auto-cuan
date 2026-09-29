'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const html = read('public/index.html');
const runtime = read('public/landing-experience.js');
const css = read('public/landing-experience.css');
test('landing has one menu with desktop links and an accessible mobile disclosure', () => {
  assert.match(html, /id="landingMenu" class="landing-menu/);
  assert.match(html, /id="landingMenuToggle"[^>]+aria-controls="landingMenu"[^>]+aria-expanded="false"/);
  assert.doesNotMatch(html, /landing-menu hidden/);
  assert.equal((html.match(/src="\/landing-experience\.js/g) || []).length, 1);
});
test('native motion replaces the old unbounded interpolation and reveal timers', () => {
  assert.doesNotThrow(() => new vm.Script(runtime));
  assert.doesNotMatch(html, /function initScrollReveal|void element\.offsetWidth|function step\(timestamp\)/);
  assert.doesNotMatch(runtime, /setInterval|setTimeout|offsetWidth|requestAnimationFrame/);
  assert.match(runtime, /reduced\.addEventListener\('change'/);
  assert.match(runtime, /fill: 'none'/);
  assert.match(runtime, /--motion-stagger/);
});
test('exact latest financial value wins without intermediate invented prices', () => {
  const el = { textContent: '', classList: { remove() {} } };
  const root = { document: { getElementById: id => id === 'landingPage' ? { addEventListener() {}, querySelectorAll: () => [], classList: { toggle() {} } } : null, addEventListener() {}, documentElement: {} }, matchMedia: () => ({matches: true, addEventListener() {}}) };
  vm.runInNewContext(runtime, {window:root});
  root.AutoCuanNumberFlow.animate(el, 100, 116);
  root.AutoCuanNumberFlow.animate(el, 116, 92);
  assert.equal(el.textContent, '92');
  root.AutoCuanNumberFlow.animate(el, 92, NaN);
  assert.equal(el.textContent, '92');
});
test('snapshot load is singleflight and deadline covers JSON body reads', () => {
  assert.match(html, /if \(_landingShowcaseRequest\) return _landingShowcaseRequest/);
  assert.match(html, /Promise\.race\(\[request, deadline\]\)/);
  assert.match(html, /if \(!res\.ok\) throw/);
  assert.match(html, /Ringkasan data belum tersedia/);
  assert.match(html, /body\.removeAttribute\('aria-busy'\); _landingShowcaseRequest = null/);
  assert.doesNotMatch(html, /var labelMap = \['Entry', 'Watch', 'Radar'\]/);
});
test('auth manager covers dynamic reset and terms without delayed focus races', () => {
  const manager = html.slice(html.indexOf('var MODAL_CLOSERS'),html.indexOf('<script src="/website-approved-access'));
  assert.match(manager, /authV2ResetModal: 'closeSelfResetModal'/);
  assert.match(manager, /standaloneTermsModal: null/);
  assert.match(manager, /e\.stopImmediatePropagation\(\)/);
  assert.doesNotMatch(manager, /setTimeout|setInterval|subtree: true/);
  assert.match(manager, /function releaseBackground/);
});
test('mobile controls and short-height forms are sized without global Portfolio overrides', () => {
  assert.match(css, /100dvh - 32px/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /content-visibility: visible; contain-intrinsic-size: none/);
  assert.match(css, /font-size: 16px !important/);
  assert.doesNotMatch(css, /#portofolioPartialMount|#tabStrip|\.tab-strip/);
});
