'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const html = read('public/index.html');
const css = read('public/final-uiux-polish.css');
const runtime = read('public/final-uiux-polish.js');

test('final UI polish assets are loaded once and light is the first-run default', () => {
  assert.equal((html.match(/\/final-uiux-polish\.css/g) || []).length, 1);
  assert.equal((html.match(/\/final-uiux-polish\.js/g) || []).length, 1);
  assert.match(html, /localStorage\.getItem\('autocuan_theme'\) \|\| 'light'/);
  assert.match(html, /<meta name="color-scheme" content="light dark">/);
  assert.match(html, /<meta name="theme-color" content="#f3f5f4">/);
});

test('final UI runtime stays syntax-safe and does not own business data', () => {
  assert.doesNotThrow(() => new vm.Script(runtime));
  assert.match(runtime, /requestIdleCallback/);
  assert.match(runtime, /\/partials\/analisis-saham\.partial\.html/);
  assert.match(runtime, /\/partials\/portfolio-command-center\.partial\.html/);
  assert.doesNotMatch(runtime, /score|recommendation|supabase|market\.sqlite|localStorage\.setItem/);
});

test('final visual layer respects reduced motion and keeps semantic data colors', () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /--data-positive:\s*#0f7a57/);
  assert.match(css, /--data-negative:\s*#c13f4d/);
  assert.match(css, /--accent-primary:\s*#0f7458/);
  assert.match(css, /\.sidebar-item\.active[\s\S]*background:\s*#17211e/);
});

test('landing final layer is light-premium without copying reference assets', () => {
  assert.match(css, /html\.light #landingPage[\s\S]*--lp-bg:\s*#f2f4f1/);
  assert.match(css, /html\.light #landingPage \.landing-nav[\s\S]*border-radius:\s*999px/);
  assert.match(css, /html\.light #landingPage \.landing-radar-window[\s\S]*background:\s*#101613/);
  assert.doesNotMatch(html + css + runtime, /profits|stockbit|ajaib/i);
});
