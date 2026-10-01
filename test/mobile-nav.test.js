'use strict';

// ===========================================================================
// Tests for the floating mobile navigation launcher.
//
// WHY IT EXISTS: #mainNav is a horizontal scroll strip. On a 390px phone its
// buttons total ~680px, so the admin-only Pattern button — injected before the
// Chart button, i.e. 5th of 7 — sat off-screen and was undiscoverable.
//
// The runtime mirrors #mainNav into a draggable, edge-snapping launcher that
// opens a compact popover with every destination. It must add no navigation
// logic of its own: every tap delegates to the original button so navigateTo(),
// the Pattern wrapper and the approval gate keep owning behaviour.
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
    offsetHeight: 56,
    style: {},
    _text: '',
    _html: '',
    focused: false,
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
    click() { node.dispatch('click', { detail: 1 }); },
    focus() { node.focused = true; doc.activeElement = node; },
    cloneNode() { const copy = makeElement(doc, node.tagName); copy.className = node.className; return copy; },
    getBoundingClientRect() { return { width: 56, height: 56, top: 0, left: 0 }; },
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

function makeRoot(options) {
  const settings = options || {};
  const timers = [];
  const storage = new Map();
  const doc = {
    body: null,
    activeElement: null,
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
    innerWidth: settings.width || 390,
    innerHeight: settings.height || 780,
    localStorage: {
      getItem: key => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key)
    },
    _storage: storage,
    _windowListeners: Object.create(null),
    addEventListener(type, handler) { (root._windowListeners[type] = root._windowListeners[type] || []).push(handler); },
    dispatch(type, event) { (root._windowListeners[type] || []).forEach(handler => handler(event || {})); },
    setTimeout(fn) { timers.push(fn); return timers.length; },
    flush() { timers.splice(0).forEach(fn => fn()); },
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
  button.appendChild(doc.createElement('svg'));
  const span = doc.createElement('span');
  span.textContent = label;
  button.appendChild(span);
  doc._mainNav.appendChild(button);
  return button;
}

function pagesIn(container) {
  return container.children.map(child => child.getAttribute('data-page')).filter(Boolean);
}

function install(options) {
  const root = makeRoot(options);
  addNavButton(root, 'dashboard', 'Dashboard', { active: true });
  addNavButton(root, 'analisis', 'Analisis Saham');
  addNavButton(root, 'sektor', 'Sektor Hot', { hidden: true });
  addNavButton(root, 'chart', 'Chart');
  nav.install(root);
  return root;
}

function press(launcher, x, y, id) {
  launcher.dispatch('pointerdown', { pointerId: id || 1, clientX: x, clientY: y, pointerType: 'touch', button: 0 });
}
function move(launcher, x, y, id) {
  launcher.dispatch('pointermove', { pointerId: id || 1, clientX: x, clientY: y, preventDefault() {} });
}
function release(launcher, id) {
  launcher.dispatch('pointerup', { pointerId: id || 1 });
}

// ---------------------------------------------------------------------------
// 1. Pure model
// ---------------------------------------------------------------------------
test('hidden nav buttons never reach the launcher menu', () => {
  const model = nav.buildNavModel([
    { page: 'dashboard', label: 'Dashboard' },
    { page: 'sektor', label: 'Sektor Hot', hidden: true },
    { page: 'chart', label: 'Chart' }
  ]);
  assert.deepEqual(model.all.map(item => item.page), ['dashboard', 'chart']);
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

// The whole point of the redesign: nothing can fall off the end any more.
test('every destination is reachable, ordered by priority', () => {
  const model = nav.buildNavModel([
    { page: 'dashboard', label: 'Dashboard' },
    { page: 'chart', label: 'Chart' },
    { page: 'sektor', label: 'Sektor Hot' },
    { page: 'pattern', label: 'Pattern' },
    { page: 'portofolio', label: 'Portofolio' }
  ]);
  assert.equal(model.all.length, 5);
  assert.deepEqual(model.all.map(item => item.page), ['dashboard', 'pattern', 'chart', 'sektor', 'portofolio']);
});

test('duplicates collapse and the active page is exposed', () => {
  const model = nav.buildNavModel([
    { page: 'chart', label: 'Chart', active: true },
    { page: 'chart', label: 'Chart duplicate' },
    { page: 'baru', label: 'Halaman Baru' }
  ]);
  assert.deepEqual(model.all.map(item => item.page), ['chart', 'baru']);
  assert.equal(model.active.page, 'chart');
});

// ---------------------------------------------------------------------------
// 2. Placement — the launcher must never become unreachable
// ---------------------------------------------------------------------------
test('the launcher snaps to whichever edge it was released nearest', () => {
  const viewport = { width: 390, height: 780, size: 56, insets: { top: 0, right: 0, bottom: 0, left: 0 } };
  assert.equal(nav.snapPosition({ x: 20, y: 300 }, viewport).side, 'left');
  assert.equal(nav.snapPosition({ x: 300, y: 300 }, viewport).side, 'right');
  assert.equal(nav.snapPosition({ x: 20, y: 300 }, viewport).x, nav.EDGE_GAP);
  assert.equal(nav.snapPosition({ x: 300, y: 300 }, viewport).x, 390 - 56 - nav.EDGE_GAP);
});

test('a drag toward any corner is clamped inside the safe area', () => {
  const viewport = { width: 390, height: 780, size: 56, insets: { top: 44, right: 0, bottom: 34, left: 0 } };
  assert.equal(nav.snapPosition({ x: 0, y: -900 }, viewport).y, nav.EDGE_GAP + 44);
  assert.equal(nav.snapPosition({ x: 0, y: 9000 }, viewport).y, 780 - 56 - nav.EDGE_GAP - 34);
});

test('a viewport narrower than the launcher still yields a usable position', () => {
  const viewport = { width: 40, height: 90, size: 56, insets: { top: 0, right: 0, bottom: 0, left: 0 } };
  const pos = nav.snapPosition({ x: 500, y: 500 }, viewport);
  assert.ok(pos.x >= nav.EDGE_GAP);
  assert.ok(pos.y >= nav.EDGE_GAP);
});

test('the popover opens away from the launcher and flips when space runs out', () => {
  const viewport = { width: 390, height: 780, size: 56 };
  assert.equal(nav.panelPlacement({ x: 10, y: 100 }, viewport).side, 'left');
  assert.equal(nav.panelPlacement({ x: 320, y: 100 }, viewport).side, 'right');
  assert.equal(nav.panelPlacement({ x: 320, y: 100 }, viewport).origin, 'below');
  assert.equal(nav.panelPlacement({ x: 320, y: 700 }, viewport).origin, 'above');
});

// ---------------------------------------------------------------------------
// 3. Runtime against the fake DOM
// ---------------------------------------------------------------------------
test('the launcher installs hidden-by-default styling hooks and menu contents', () => {
  const root = install();
  const runtime = root.AutoCuanMobileNavRuntime;
  assert.ok(runtime, 'runtime must install');
  assert.equal(runtime.launcher.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(runtime.launcher.getAttribute('aria-expanded'), 'false');
  assert.equal(runtime.panel.getAttribute('role'), 'dialog');
  assert.deepEqual(pagesIn(runtime.grid), ['dashboard', 'analisis', 'chart']);
});

test('the active destination is mirrored into the menu and the launcher label', () => {
  const root = install();
  const runtime = root.AutoCuanMobileNavRuntime;
  const active = runtime.grid.children.filter(child => child.classList.contains('active'));
  assert.equal(active.length, 1);
  assert.equal(active[0].getAttribute('data-page'), 'dashboard');
  assert.equal(active[0].getAttribute('aria-current'), 'page');
  assert.match(runtime.launcher.getAttribute('aria-label'), /Dashboard/);
});

// Tap and drag share one gesture stream, so the threshold is what separates them.
test('a tap under the drag threshold opens the menu', () => {
  const root = install();
  const runtime = root.AutoCuanMobileNavRuntime;
  press(runtime.launcher, 300, 500);
  move(runtime.launcher, 302, 501);
  release(runtime.launcher);
  assert.equal(runtime.panel.classList.contains('hidden'), false);
  assert.equal(runtime.launcher.getAttribute('aria-expanded'), 'true');
});

test('a drag past the threshold moves the launcher and does not open the menu', () => {
  const root = install();
  const runtime = root.AutoCuanMobileNavRuntime;
  press(runtime.launcher, 300, 500);
  move(runtime.launcher, 240, 300);
  move(runtime.launcher, 60, 220);
  release(runtime.launcher);
  assert.equal(runtime.panel.classList.contains('hidden'), true, 'a drag must not be read as a tap');
  assert.equal(runtime.launcher.getAttribute('data-side'), 'left');
  assert.equal(runtime.position().x, nav.EDGE_GAP);
});

test('the dragged position survives a reload', () => {
  const root = install();
  press(root.AutoCuanMobileNavRuntime.launcher, 300, 500);
  move(root.AutoCuanMobileNavRuntime.launcher, 60, 240);
  release(root.AutoCuanMobileNavRuntime.launcher);
  const stored = JSON.parse(root._storage.get(nav.STORAGE_KEY));
  assert.equal(stored.x, nav.EDGE_GAP);
  assert.ok(Number.isFinite(stored.y));
});

test('a corrupt stored position is ignored rather than breaking the launcher', () => {
  const root = makeRoot();
  root.localStorage.setItem(nav.STORAGE_KEY, '{not json');
  addNavButton(root, 'dashboard', 'Dashboard');
  nav.install(root);
  assert.ok(root.AutoCuanMobileNavRuntime, 'runtime still installs');
  assert.ok(Number.isFinite(root.AutoCuanMobileNavRuntime.position().x));
});

test('tapping a destination delegates to the original nav button and closes the menu', () => {
  const root = install();
  const runtime = root.AutoCuanMobileNavRuntime;
  runtime.openPanel();
  const origin = root.document._mainNav.querySelector('.nav-btn[data-page="chart"]');
  let clicks = 0;
  origin.addEventListener('click', () => { clicks += 1; });

  runtime.grid.children.find(child => child.getAttribute('data-page') === 'chart').dispatch('click', {});

  assert.equal(clicks, 1, 'navigation must run through the existing handler');
  assert.equal(runtime.panel.classList.contains('hidden'), true);
});

test('the runtime never defines navigation of its own', () => {
  const source = read('public/mobile-nav.js');
  new vm.Script(source, { filename: 'mobile-nav.js' });
  assert.doesNotMatch(source, /navigateTo\s*=/);
  assert.doesNotMatch(source, /function navigateTo/);
  assert.match(source, /target\.click\(\)/);
  assert.doesNotMatch(source, /fetch\(|supabase|telegram/i);
});

test('Escape closes the menu and returns focus to the launcher', () => {
  const root = install();
  const runtime = root.AutoCuanMobileNavRuntime;
  root.document.activeElement = runtime.launcher;
  runtime.openPanel();
  assert.equal(runtime.panel.classList.contains('hidden'), false);

  root.document.dispatch('keydown', { key: 'Escape', preventDefault() {} });

  assert.equal(runtime.panel.classList.contains('hidden'), true);
  assert.equal(runtime.launcher.focused, true, 'focus must return to the control that opened the menu');
});

test('arrow keys rove between destinations', () => {
  const root = install();
  const runtime = root.AutoCuanMobileNavRuntime;
  runtime.openPanel();
  assert.equal(root.document.activeElement, runtime.grid.children[0]);

  root.document.dispatch('keydown', { key: 'ArrowDown', preventDefault() {} });
  assert.equal(root.document.activeElement, runtime.grid.children[1]);

  root.document.dispatch('keydown', { key: 'ArrowUp', preventDefault() {} });
  assert.equal(root.document.activeElement, runtime.grid.children[0]);
});

test('keyboard activation opens the menu without any pointer gesture', () => {
  const root = install();
  const runtime = root.AutoCuanMobileNavRuntime;
  // detail === 0 is how browsers report Enter/Space activation of a button.
  runtime.launcher.dispatch('click', { detail: 0 });
  assert.equal(runtime.panel.classList.contains('hidden'), false);
});

// The Pattern button is injected by pattern-stable-runtime.js only after the
// signed admin gate resolves, long after this runtime has rendered.
test('a Pattern button injected later shows up without any Pattern-specific code', () => {
  const root = install();
  const runtime = root.AutoCuanMobileNavRuntime;
  assert.equal(pagesIn(runtime.grid).includes('pattern'), false);

  addNavButton(root, 'pattern', 'Pattern');
  root._observer.callback([]);
  root.flush();

  assert.ok(pagesIn(runtime.grid).includes('pattern'), 'Pattern must reach the menu automatically');
  assert.doesNotMatch(read('public/mobile-nav.js'), /PatternMapAdminAccess|page-pattern/);
});

test('a revoked Pattern grant removes it from the menu again', () => {
  const root = install();
  const runtime = root.AutoCuanMobileNavRuntime;
  const button = addNavButton(root, 'pattern', 'Pattern');
  root._observer.callback([]);
  root.flush();
  assert.ok(pagesIn(runtime.grid).includes('pattern'));

  button.classList.add('hidden');
  root._observer.callback([]);
  root.flush();

  assert.equal(pagesIn(runtime.grid).includes('pattern'), false);
});

// The landing page, the blocked screen and the maintenance screen share the
// same <body>, so app navigation must not leak onto them.
test('the launcher stays hidden while the dashboard shell is not the active view', () => {
  const root = makeRoot();
  root.document._shell.classList.add('hidden');
  addNavButton(root, 'dashboard', 'Dashboard');
  nav.install(root);
  assert.equal(root.AutoCuanMobileNavRuntime.launcher.classList.contains('ac-hidden'), true);
});

test('logging out hides the launcher and closes an open menu', () => {
  const root = install();
  const runtime = root.AutoCuanMobileNavRuntime;
  assert.equal(runtime.launcher.classList.contains('ac-hidden'), false);
  runtime.openPanel();

  root.document._shell.classList.add('hidden');
  root._observer.callback([]);
  root.flush();

  assert.equal(runtime.launcher.classList.contains('ac-hidden'), true);
  assert.equal(runtime.panel.classList.contains('hidden'), true);
});

test('rotation re-snaps the launcher and dismisses a stale popover', () => {
  const root = install();
  const runtime = root.AutoCuanMobileNavRuntime;
  runtime.openPanel();

  root.innerWidth = 780;
  root.innerHeight = 390;
  root.dispatch('orientationchange', {});

  assert.equal(runtime.panel.classList.contains('hidden'), true);
  assert.equal(runtime.position().x, 780 - 56 - nav.EDGE_GAP);
});

test('installing twice is a no-op', () => {
  const root = install();
  const first = root.AutoCuanMobileNavRuntime;
  assert.equal(nav.install(root), false);
  assert.equal(root.AutoCuanMobileNavRuntime, first);
});

// ---------------------------------------------------------------------------
// 4. Wiring
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
  assert.match(theme, /\.ac-launcher \{/);
});

test('the replaced bottom bar is fully gone', () => {
  const theme = read('public/ui-theme.css');
  const source = read('public/mobile-nav.js');
  assert.doesNotMatch(theme, /\.ac-mobilenav/);
  assert.doesNotMatch(theme, /has-mobile-nav/);
  assert.doesNotMatch(source, /has-mobile-nav/);
});
