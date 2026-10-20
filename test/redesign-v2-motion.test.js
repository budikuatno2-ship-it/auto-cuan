'use strict';

// Redesign v2 motion layer and Si Mata (HANDOFF §2.4, §7).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'public', 'ac-motion.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'ui-theme.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function load() {
  const listeners = {};
  const doc = {
    readyState: 'complete',
    body: { appendChild() {} },
    documentElement: { classList: { toggle() {} } },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    getElementById: () => null,
    querySelector: () => null,
    createElement: () => ({ classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, setAttribute() {}, querySelector: () => ({ addEventListener() {}, classList: { remove() {}, add() {} } }), querySelectorAll: () => [] })
  };
  const win = {
    document: doc,
    matchMedia: () => ({ matches: true }),
    addEventListener() {},
    requestAnimationFrame: (fn) => fn(),
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: { getItem: () => null, setItem() {} }
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(source, win);
  return win;
}

test('mood thresholds follow the HANDOFF §7 table', () => {
  const { AutoCuanMata } = load();
  const cases = [[2, 'up2'], [1.5, 'up2'], [1.49, 'up'], [0.3, 'up'], [0.29, 'flat'], [0, 'flat'], [-0.29, 'flat'], [-0.3, 'down'], [-1.49, 'down'], [-1.5, 'down2'], [-4, 'down2']];
  for (const [chg, mood] of cases) assert.equal(AutoCuanMata.moodOf(chg), mood, String(chg));
});

test('Si Mata copy never tells anyone to buy or sell or promises gains', () => {
  const { AutoCuanMata } = load();
  const all = JSON.stringify(AutoCuanMata.copy);
  // "belum berarti wajib beli" is a warning, not an instruction.
  assert.doesNotMatch(all, /(?<!belum berarti )\b(beli sekarang|jual sekarang|pasti (untung|cuan|naik)|dijamin|tanpa risiko|wajib beli|harus beli|all in|hajar)\b/i);
  assert.doesNotMatch(all, /—/, 'no em dash in UI copy');
});

test('the mascot is mounted only by script and hidden on auth screens', () => {
  assert.match(html, /<script src="\/ac-motion\.js\?v=[^"]+"><\/script>/);
  assert.match(css, /body:has\(#loginModal:not\(\.hidden\), #registerModal:not\(\.hidden\), #selfResetModal:not\(\.hidden\)[^)]*\)[^{]*\.mm \{ display: none !important; \}/);
});

test('blink pauses in a background tab and all motion stops for reduced motion', () => {
  assert.match(css, /html\.ac-tab-hidden \.mm-lid[^{]*\{ animation-play-state: paused; \}/);
  const block = css.slice(css.indexOf('/* 9c. Motion layer'));
  assert.match(block, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.mm-eye, \.mm-lid, \.mm\.talk \.mm-mouth, \.mm-eye\.hop \{ animation: none !important; \}/);
});

test('motion keyframes animate only transform or opacity', () => {
  const block = css.slice(css.indexOf('/* 9c. Motion layer'));
  const frames = block.match(/@keyframes [\w-]+\s*\{[\s\S]*?\}\s*\}/g) || [];
  assert.ok(frames.length >= 6);
  for (const f of frames) {
    const props = (f.match(/\{\s*([a-z-]+)\s*:/g) || []).map(p => p.replace(/[{\s:]/g, ''));
    for (const p of props) assert.ok(['transform', 'opacity'].includes(p), f.split('{')[0] + ' animates ' + p);
  }
});

test('show/hide is remembered with guarded storage, and navigation stays synchronous', () => {
  assert.match(source, /try \{ return root\.localStorage\.getItem\(k\); \} catch/);
  assert.match(source, /store\.set\('ac-mata-off', '1'\)/);
  assert.match(source, /var result = original\.apply\(this, arguments\);/);
  assert.doesNotMatch(source, /startViewTransition/);
});
