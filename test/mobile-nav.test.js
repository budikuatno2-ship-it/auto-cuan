'use strict';

// ===========================================================================
// Tests for the mobile bottom navigation.
//
// WHY IT EXISTS: #mainNav is a horizontal scroll strip. On a 390px phone its
// buttons total ~680px, so the admin-only Pattern button — injected before the
// Chart button, i.e. 5th of 7 — sat off-screen and was undiscoverable.
//
// The runtime mirrors #mainNav into a fixed bottom bar plus a "Menu" sheet. It
// must add no navigation logic of its own: every tap delegates to the original
// button so navigateTo(), the Pattern wrapper and the approval gate keep owning
// behaviour.
//
// LOCAL / STATIC + MOCKED ONLY. No browser, network, or backend involvement.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const nav = require('../public/mobile-nav');

// ---------------------------------------------------------------------------
// Minimal fake DOM — only the surface mobile-nav.js actually uses.
// ---------------------------------------------------------------------------
function makeElement(doc, tagName) {
  const classes = new Set();
  const attributes = Object.create(null);
  const listeners = Object.create(null);
  const node = {
    tagName: String(tagName).toUpperCase(),
    children: [],
    parentNode: null,
    disabled: false,
    type: '',
    _text: '',
    _html: '',
    get className() { return Array.from(classes).join(' '); },
    set className(value) {
      classes.clear();
      String(value || '').split(/\s+/).filter(Boolean).forEach(name => classes.add(name));
    },
    classList: {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name),
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name); else classes.delete(name);
        return on;
      }
    },
    setAttribute(name, value) { attributes[name] = String(value); },
    getAttribute(name) { return name in attributes ? attributes[name] : null; },
    removeAttribute(name) { delete attributes[name]; },
    appendChild(child) { child.parentNode = node; node.children.push(child); return child; },
    addEventListener(type, handler) { (listeners[type] = listeners[type] || []).push(handler); },
    dispatch(type, event) { (listeners[type] || []).forEach(handler => handler(event || {})); },
    click() { node.dispatch('click', {}); },
    cloneNode() { const copy = makeElement(doc, node.tagName); copy.className = node.className; return copy; },
    get innerHTML() { return node._html; },
    set innerHTML(value) { node._html = String(value); },
    get textContent() {
      if (node.children.length) return node.children.map(child => child.textContent).join('');
      return node._text;
    },
    set textContent(value) { node.children = []; node._text = String(value); },
    descendants() {
      return node.children.reduce((all, child) => all.concat([child], child.descendants()), []);
    },
    matches(selector) {
      if (selector === '.nav-btn[data-page]') return classes.has('nav-btn') && attributes['data-page'] != null;
      if (selector.startsWith('.')) return classes.has(selector.slice(1));
      if (selector.startsWith('[data-page="')) return attributes['data-page'] === selector.slice(12, -2);
      if (selector === '.nav-btn[data-page="' + attributes['data-page'] + '"]') return classes.has('nav-btn');
      return false;
    },
    querySelectorAll(selector) { return node.descendants().filter(child => child.matches(selector)); },
    querySelector(selector) {
      if (selector === 'span') return node.descendants().find(child => child.tagName === 'SPAN') || null;
      if (selector === 'svg') return node.descendants().find(child => child.tagName === 'SVG') || null;
      const scoped = /^\.nav-btn\[data-page="(.+)"\]$/.exec(selector);
      if (scoped) {
        return node.descendants().find(child =>
          child.classList.contains('nav-btn') && child.getAttribute('data-page') === scoped[1]) || null;
      }
      return node.descendants().find(child => child.matches(selector)) || null;
    }
  };
  return node;
}

function makeRoot() {
  const timers = [];
  const doc = {
    body: null,
    _listeners: Object.create(null),
    createElement(tagName) { return makeElement(doc, tagName); },
    getElementById(id) {
      if (id === 'mainNav') return doc._mainNav;
      if (id === 'dashboardScreen') return doc._shell;
      return null;
    },
    addEventListener(type, handler) { (doc._listeners[type] = doc._listeners[type] || []).push(handler); },
    dispatch(type, event) { (doc._listeners[type] || []).forEach(handler => handler(event || {})); }
  };
  doc.body = makeElement(doc, 'body');
  doc._mainNav = makeElement(doc, 'div');
  doc._mainNav.className = 'nav-scroll-container';
  // The signed-in app shell; `hidden` on it means landing/blocked/maintenance.
  doc._shell = makeElement(doc, 'div');
  doc._shell.className = 'flex flex-col min-h-screen';

  const root = {
    document: doc,
    setTimeout(fn) { timers.push(fn); return timers.length; },
    flush() { const pending = timers.splice(0); pending.forEach(fn => fn()); },
    MutationObserver: function (callback) {
      this.callback = callback;
      this.observe = () => { root._observer = this; };
    }
  };
  return root;
}

function addNavButton(root, page, label, options) {
  const doc = root.document;
  const button = doc.createElement('button');
  button.className = 'nav-btn' + (options && options.hidden ? ' hidden' : '') + (options && options.active ? ' active' : '');
  button.setAttribute('data-page', page);
  const svg = doc.createElement('svg');
  button.appendChild(svg);
  const span = doc.createElement('span');
  span.textContent = label;
  button.appendChild(span);
  doc._mainNav.appendChild(button);
  return button;
}

function pagesIn(container) {
  return container.children.map(child => child.getAttribute('data-page')).filter(Boolean);
}

// ---------------------------------------------------------------------------
// 1. Pure model
// ---------------------------------------------------------------------------
test('hidden nav buttons never reach the bottom bar or the menu sheet', () => {
  const model = nav.buildNavModel([
    { page: 'dashboard', label: 'Dashboard' },
    { page: 'sektor', label: 'Sektor Hot', hidden: true },
    { page: 'chart', label: 'Chart' }
  ]);
  assert.deepEqual(model.all.map(item => item.page), ['dashboard', 'chart']);
  assert.equal(model.all.some(item => item.page === 'sektor'), false);
});

test('a disabled or aria-hidden button counts as hidden', () => {
  const root = makeRoot();
  addNavButton(root, 'dashboard', 'Dashboard');
  const gated = addNavButton(root, 'screener', 'Screener');
  gated.disabled = true;
  const aria = addNavButton(root, 'sektor', 'Sektor Hot');
  aria.setAttribute('aria-hidden', 'true');

  const items = nav.readNavItems(root.document._mainNav);
  assert.deepEqual(items.filter(item => !item.hidden).map(item => item.page), ['dashboard']);
});

// The whole point of the redesign: Pattern must never be the item that falls
// off the end of the bar.
test('Pattern takes a permanent bar slot instead of overflowing off-screen', () => {
  const model = nav.buildNavModel([
    { page: 'dashboard', label: 'Dashboard' },
    { page: 'analisis', label: 'Analisis Saham' },
    { page: 'sektor', label: 'Sektor Hot' },
    { page: 'screener', label: 'Screener' },
    { page: 'pattern', label: 'Pattern' },
    { page: 'chart', label: 'Chart' },
    { page: 'portofolio', label: 'Portofolio' }
  ]);
  assert.equal(model.primary.length, 4);
  assert.ok(model.primary.some(item => item.page === 'pattern'), 'Pattern must be a primary destination');
  assert.deepEqual(model.all.length, 7, 'every destination stays reachable via the sheet');
  assert.deepEqual(model.overflow.map(item => item.page), ['sektor', 'screener', 'portofolio']);
});

test('bar slots keep the nav order so they do not reshuffle as gates resolve', () => {
  const model = nav.buildNavModel([
    { page: 'dashboard', label: 'Dashboard' },
    { page: 'analisis', label: 'Analisis Saham' },
    { page: 'pattern', label: 'Pattern' },
    { page: 'chart', label: 'Chart' }
  ]);
  assert.deepEqual(model.primary.map(item => item.page), ['dashboard', 'analisis', 'pattern', 'chart']);
});

test('duplicate pages collapse and unknown pages still fit when slots are free', () => {
  const model = nav.buildNavModel([
    { page: 'chart', label: 'Chart' },
    { page: 'chart', label: 'Chart duplicate' },
    { page: 'baru', label: 'Halaman Baru' }
  ]);
  assert.deepEqual(model.all.map(item => item.page), ['chart', 'baru']);
  assert.deepEqual(model.primary.map(item => item.page), ['chart', 'baru']);
});

test('bar labels are shortened but the sheet keeps the full wording', () => {
  assert.equal(nav.shortLabel('analisis', 'Analisis Saham'), 'Analisis');
  assert.equal(nav.shortLabel('portofolio', 'Portofolio'), 'Porto');
  assert.equal(nav.shortLabel('chart', 'Chart'), 'Chart');
});

// ---------------------------------------------------------------------------
// 2. Runtime against the fake DOM
// ---------------------------------------------------------------------------
function install() {
  const root = makeRoot();
  addNavButton(root, 'dashboard', 'Dashboard', { active: true });
  addNavButton(root, 'analisis', 'Analisis Saham');
  addNavButton(root, 'sektor', 'Sektor Hot', { hidden: true });
  addNavButton(root, 'chart', 'Chart');
  nav.install(root);
  return root;
}

test('the bottom bar renders the primary destinations plus a Menu button', () => {
  const root = install();
  const runtime = root.AutoCuanMobileNavRuntime;
  assert.ok(runtime, 'runtime must install');
  assert.deepEqual(pagesIn(runtime.bar), ['dashboard', 'analisis', 'chart']);
  const more = runtime.bar.children[runtime.bar.children.length - 1];
  assert.equal(more.classList.contains('ac-mobilenav-more'), true);
  assert.equal(more.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(root.document.body.classList.contains('has-mobile-nav'), true);
});

test('the active destination is mirrored onto the bar', () => {
  const root = install();
  const active = root.AutoCuanMobileNavRuntime.bar.children.filter(child => child.classList.contains('active'));
  assert.equal(active.length, 1);
  assert.equal(active[0].getAttribute('data-page'), 'dashboard');
  assert.equal(active[0].getAttribute('aria-current'), 'page');
});

test('tapping a bar item delegates to the original nav button', () => {
  const root = install();
  const origin = root.document._mainNav.querySelector('.nav-btn[data-page="chart"]');
  let clicks = 0;
  origin.addEventListener('click', () => { clicks += 1; });

  root.AutoCuanMobileNavRuntime.bar.children
    .find(child => child.getAttribute('data-page') === 'chart')
    .dispatch('click', {});

  assert.equal(clicks, 1, 'navigation must run through the existing handler');
});

test('the runtime never defines navigation of its own', () => {
  const source = read('public/mobile-nav.js');
  new vm.Script(source, { filename: 'mobile-nav.js' });
  assert.doesNotMatch(source, /navigateTo\s*=/);
  assert.doesNotMatch(source, /function navigateTo/);
  assert.match(source, /target\.click\(\)/);
  assert.doesNotMatch(source, /fetch\(|supabase|telegram/i);
});

test('the Menu sheet lists every destination and toggles open and closed', () => {
  const root = install();
  const runtime = root.AutoCuanMobileNavRuntime;
  const more = runtime.bar.children[runtime.bar.children.length - 1];

  assert.equal(runtime.sheet.classList.contains('hidden'), true);
  more.dispatch('click', {});
  assert.equal(runtime.sheet.classList.contains('hidden'), false);
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(pagesIn(runtime.grid), ['dashboard', 'analisis', 'chart']);

  root.document.dispatch('keydown', { key: 'Escape' });
  assert.equal(runtime.sheet.classList.contains('hidden'), true);
});

test('choosing a page from the sheet closes it and delegates the tap', () => {
  const root = install();
  const runtime = root.AutoCuanMobileNavRuntime;
  runtime.openSheet();
  const origin = root.document._mainNav.querySelector('.nav-btn[data-page="analisis"]');
  let clicks = 0;
  origin.addEventListener('click', () => { clicks += 1; });

  runtime.grid.children.find(child => child.getAttribute('data-page') === 'analisis').dispatch('click', {});

  assert.equal(clicks, 1);
  assert.equal(runtime.sheet.classList.contains('hidden'), true);
});

// The Pattern button is injected by pattern-stable-runtime.js only after the
// signed admin gate resolves, long after this runtime has rendered.
test('a Pattern button injected later shows up without any Pattern-specific code', () => {
  const root = install();
  const runtime = root.AutoCuanMobileNavRuntime;
  assert.equal(pagesIn(runtime.bar).includes('pattern'), false);

  addNavButton(root, 'pattern', 'Pattern');
  root._observer.callback([]);
  root.flush();

  assert.ok(pagesIn(runtime.bar).includes('pattern'), 'Pattern must reach the bar automatically');
  assert.ok(pagesIn(runtime.grid).includes('pattern'));
  assert.doesNotMatch(read('public/mobile-nav.js'), /PatternMapAdminAccess|page-pattern/);
});

test('a revoked Pattern grant removes it from the bar again', () => {
  const root = install();
  const runtime = root.AutoCuanMobileNavRuntime;
  const button = addNavButton(root, 'pattern', 'Pattern');
  root._observer.callback([]);
  root.flush();
  assert.ok(pagesIn(runtime.bar).includes('pattern'));

  button.classList.add('hidden');
  root._observer.callback([]);
  root.flush();

  assert.equal(pagesIn(runtime.bar).includes('pattern'), false);
  assert.equal(pagesIn(runtime.grid).includes('pattern'), false);
});

// The landing page, the blocked screen and the maintenance screen share the
// same <body>, so app navigation must not leak onto them.
test('the bar stays hidden while the dashboard shell is not the active view', () => {
  const root = makeRoot();
  root.document._shell.classList.add('hidden');
  addNavButton(root, 'dashboard', 'Dashboard');
  nav.install(root);

  const runtime = root.AutoCuanMobileNavRuntime;
  assert.equal(runtime.bar.classList.contains('ac-hidden'), true);
  assert.equal(root.document.body.classList.contains('has-mobile-nav'), false);
});

test('logging in reveals the bar and logging out hides it again', () => {
  const root = install();
  const runtime = root.AutoCuanMobileNavRuntime;
  assert.equal(runtime.bar.classList.contains('ac-hidden'), false);

  runtime.openSheet();
  root.document._shell.classList.add('hidden');
  root._observer.callback([]);
  root.flush();

  assert.equal(runtime.bar.classList.contains('ac-hidden'), true);
  assert.equal(runtime.sheet.classList.contains('hidden'), true, 'the sheet must close with the shell');
  assert.equal(root.document.body.classList.contains('has-mobile-nav'), false);

  root.document._shell.classList.remove('hidden');
  root._observer.callback([]);
  root.flush();
  assert.equal(runtime.bar.classList.contains('ac-hidden'), false);
});

test('installing twice is a no-op', () => {
  const root = install();
  const first = root.AutoCuanMobileNavRuntime;
  assert.equal(nav.install(root), false);
  assert.equal(root.AutoCuanMobileNavRuntime, first);
});

// ---------------------------------------------------------------------------
// 3. Wiring
// ---------------------------------------------------------------------------
test('the runtime is loaded and #mainNav stays in the DOM as its source', () => {
  const loader = read('public/assets/fca-stocks.js');
  const html = read('public/index.html');
  const theme = read('public/ui-theme.css');
  assert.match(loader, /\/mobile-nav\.js\?v=/);
  assert.match(html, /id="mainNav"/, '#mainNav must remain the nav source of truth');
  // Only the strip's display is dropped on mobile; the element itself stays so
  // other runtimes keep injecting into it.
  assert.match(theme, /\.mobile-nav-row \{ display: none !important; \}/);
  assert.match(theme, /body\.has-mobile-nav \{ padding-bottom/);
});
