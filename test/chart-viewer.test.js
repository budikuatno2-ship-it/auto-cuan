'use strict';

// ===========================================================================
// Tests for the shared fullscreen chart viewer.
//
// One overlay serves both the Chart page and Pattern. What matters:
//   - it reuses the Chart page renderer rather than forking a second engine,
//     which is what makes the two views consistent;
//   - it falls back to a pinch-zoomable image when the engine is unavailable,
//     so Pattern never loses its visual;
//   - it locks and restores page scroll (the iOS rubber-band problem);
//   - it disposes the chart and restores focus on close.
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
const viewer = require('../public/chart-viewer');

// ---------------------------------------------------------------------------
// Minimal fake DOM
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
    style: {},
    focused: false,
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
      contains: name => classes.has(name)
    },
    setAttribute(name, value) { attributes[name] = String(value); },
    getAttribute(name) { return name in attributes ? attributes[name] : null; },
    removeAttribute(name) { delete attributes[name]; },
    hasAttribute(name) { return name in attributes; },
    appendChild(child) { child.parentNode = node; node.children.push(child); return child; },
    removeChild(child) {
      const index = node.children.indexOf(child);
      if (index >= 0) node.children.splice(index, 1);
      child.parentNode = null;
      return child;
    },
    addEventListener(type, handler) { (listeners[type] = listeners[type] || []).push(handler); },
    dispatch(type, event) { (listeners[type] || []).forEach(handler => handler(event || {})); },
    focus() { node.focused = true; doc.activeElement = node; },
    getBoundingClientRect() { return { width: 320, height: 240, top: 0, left: 0 }; },
    get innerHTML() { return node._html; },
    set innerHTML(value) { node._html = String(value); node.children = []; },
    get textContent() {
      if (node.children.length) return node.children.map(child => child.textContent).join('');
      return node._text;
    },
    set textContent(value) { node.children = []; node._text = String(value); },
    descendants() {
      return node.children.reduce((all, child) => all.concat([child], child.descendants()), []);
    },
    matches(selector) {
      return selector.split(',').map(part => part.trim()).some(part => {
        if (part.startsWith('.')) return classes.has(part.slice(1));
        return part.toUpperCase() === node.tagName;
      });
    },
    querySelectorAll(selector) { return node.descendants().filter(child => child.matches(selector)); },
    querySelector(selector) { return node.descendants().find(child => child.matches(selector)) || null; }
  };
  return node;
}

function makeRoot(options) {
  const settings = options || {};
  const doc = {
    activeElement: null,
    _listeners: Object.create(null),
    createElement(tagName) { return makeElement(doc, tagName); },
    getElementById() { return null; },
    addEventListener(type, handler) { (doc._listeners[type] = doc._listeners[type] || []).push(handler); },
    removeEventListener(type, handler) {
      const list = doc._listeners[type] || [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    dispatch(type, event) { (doc._listeners[type] || []).slice().forEach(handler => handler(event || {})); }
  };
  doc.body = makeElement(doc, 'body');
  doc.documentElement = makeElement(doc, 'html');

  const root = {
    document: doc,
    pageYOffset: settings.scrollY || 0,
    scrolledTo: null,
    innerWidth: 390,
    innerHeight: 780,
    __chartRegistry: {},
    disposed: [],
    rendered: [],
    _listeners: Object.create(null),
    addEventListener(type, handler) { (root._listeners[type] = root._listeners[type] || []).push(handler); },
    removeEventListener(type, handler) {
      const list = root._listeners[type] || [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    scrollTo(x, y) { root.scrolledTo = y; },
    disposeChart(id) { root.disposed.push(id); }
  };
  if (settings.withRenderer !== false) {
    root.renderLightweightChart = function (chartId, candles, metrics, ticker, opts) {
      root.rendered.push({ chartId, candles, metrics, ticker, opts });
      return Promise.resolve();
    };
  }
  if (settings.rendererThrows) {
    root.renderLightweightChart = function () { return Promise.reject(new Error('no engine')); };
  }
  return root;
}

const CANDLES = ['2026-07-20', '2026-07-21', '2026-07-22'].map((time, i) => ({
  time, open: 100 + i, high: 105 + i, low: 95 + i, close: 102 + i, volume: 1000 + i
}));

function overlayOf(root) {
  return root.document.body.children.find(child => child.id === 'acChartViewer') || null;
}

// ---------------------------------------------------------------------------
// 1. Pure zoom / pan maths
// ---------------------------------------------------------------------------
test('pan is clamped so the image can never leave its frame', () => {
  // At zoom 1 there is no overflow, so no panning is possible at all.
  assert.equal(viewer.clampPan(500, 300, 300, 1), 0);
  assert.equal(viewer.clampPan(-500, 300, 300, 1), 0);
  // At zoom 2 the overflow each way is (300*2 - 300) / 2 = 150.
  assert.equal(viewer.clampPan(500, 300, 300, 2), 150);
  assert.equal(viewer.clampPan(-500, 300, 300, 2), -150);
  assert.equal(viewer.clampPan(40, 300, 300, 2), 40);
});

test('double-tap toggles between fit and a readable zoom', () => {
  assert.ok(viewer.toggleZoom(viewer.MIN_ZOOM) > viewer.MIN_ZOOM);
  assert.equal(viewer.toggleZoom(2.5), viewer.MIN_ZOOM);
  assert.equal(viewer.toggleZoom(viewer.MAX_ZOOM), viewer.MIN_ZOOM);
});

test('zoom stays inside its bounds', () => {
  assert.equal(viewer.clamp(99, viewer.MIN_ZOOM, viewer.MAX_ZOOM), viewer.MAX_ZOOM);
  assert.equal(viewer.clamp(-4, viewer.MIN_ZOOM, viewer.MAX_ZOOM), viewer.MIN_ZOOM);
});

// ---------------------------------------------------------------------------
// 2. Scroll lock — the iOS rubber-band fix
// ---------------------------------------------------------------------------
test('scroll lock pins the body and restores the exact scroll position', () => {
  const root = makeRoot({ scrollY: 640 });
  viewer.lockScroll(root);
  assert.equal(root.document.body.style.position, 'fixed');
  assert.equal(root.document.body.style.top, '-640px');

  viewer.unlockScroll(root);
  assert.equal(root.document.body.style.position, '');
  assert.equal(root.scrolledTo, 640, 'the page must return to where the user left it');
  assert.equal(root.document.body.hasAttribute('data-ac-scroll-locked'), false);
});

test('locking twice does not lose the original scroll position', () => {
  const root = makeRoot({ scrollY: 300 });
  viewer.lockScroll(root);
  root.pageYOffset = 0; // the pinned body reports 0
  viewer.lockScroll(root);
  viewer.unlockScroll(root);
  assert.equal(root.scrolledTo, 300);
});

test('unlocking without a lock is a no-op', () => {
  const root = makeRoot({ scrollY: 120 });
  viewer.unlockScroll(root);
  assert.equal(root.scrolledTo, null);
});

// ---------------------------------------------------------------------------
// 3. Interactive path
// ---------------------------------------------------------------------------
test('the viewer drives the Chart page renderer rather than a second engine', async () => {
  const root = makeRoot();
  viewer.open(root, { title: 'Chart BBCA', ticker: 'BBCA', candles: CANDLES, metrics: { rsi14: 55 } });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(root.rendered.length, 1);
  const call = root.rendered[0];
  assert.equal(call.ticker, 'BBCA');
  assert.equal(call.opts.variant, 'fullscreen');
  assert.deepEqual(call.candles, CANDLES);
  assert.ok(overlayOf(root), 'overlay must be mounted');
  assert.equal(root.document.body.style.position, 'fixed', 'page scroll must be locked');
});

test('Pattern geometry reaches the renderer as price lines and markers', async () => {
  const root = makeRoot();
  const priceLines = [{ title: 'Konfirmasi', price: 9300, color: '#22c55e' }];
  const markers = [{ time: '2026-07-21', text: 'D', position: 'belowBar' }];
  viewer.open(root, { title: 'BBCA · ABCD', candles: CANDLES, priceLines, markers });
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(root.rendered[0].opts.priceLines, priceLines);
  assert.deepEqual(root.rendered[0].opts.markers, markers);
});

test('the overlay is a labelled modal dialog', () => {
  const root = makeRoot();
  viewer.open(root, { title: 'Chart BBCA', subtitle: 'T-1', candles: CANDLES });
  const overlay = overlayOf(root);
  assert.equal(overlay.getAttribute('role'), 'dialog');
  assert.equal(overlay.getAttribute('aria-modal'), 'true');
  assert.equal(overlay.getAttribute('aria-label'), 'Chart BBCA');
});

// ---------------------------------------------------------------------------
// 4. Fallback path
// ---------------------------------------------------------------------------
test('without candles the viewer shows the high-resolution image instead', () => {
  const root = makeRoot();
  viewer.open(root, { title: 'Pattern BBCA', image: { src: 'blob:x', width: 1200, height: 700, alt: 'Pattern' } });
  assert.equal(root.rendered.length, 0);
  const overlay = overlayOf(root);
  assert.ok(overlay.querySelector('.ac-viewer-imageframe'), 'image frame must be mounted');
  assert.ok(overlay.querySelector('.ac-viewer-image'));
});

test('a missing image degrades to a message, not a blank overlay', () => {
  const root = makeRoot({ withRenderer: false });
  viewer.open(root, { title: 'Pattern BBCA' });
  assert.ok(overlayOf(root).querySelector('.ac-viewer-empty'));
});

test('pinch and drag on the image frame do not throw', () => {
  const root = makeRoot({ withRenderer: false });
  viewer.open(root, { title: 'Pattern', image: { src: 'blob:x', width: 600, height: 480 } });
  const frame = overlayOf(root).querySelector('.ac-viewer-imageframe');
  frame.dispatch('pointerdown', { pointerId: 1, clientX: 10, clientY: 10 });
  frame.dispatch('pointerdown', { pointerId: 2, clientX: 110, clientY: 10 });
  frame.dispatch('pointermove', { pointerId: 2, clientX: 210, clientY: 10, preventDefault() {} });
  frame.dispatch('pointerup', { pointerId: 2 });
  frame.dispatch('pointerup', { pointerId: 1 });
  frame.dispatch('dblclick', { preventDefault() {} });
  assert.match(String(overlayOf(root).querySelector('.ac-viewer-image').style.transform || ''), /scale\(/);
});

test('a download href is offered when the caller supplies one', () => {
  const root = makeRoot({ withRenderer: false });
  viewer.open(root, {
    title: 'Pattern', image: { src: 'blob:x' },
    download: { href: 'blob:x', name: 'auto-cuan-BBCA-pattern.png' }
  });
  const link = overlayOf(root).querySelector('.ac-viewer-btn');
  assert.equal(link.getAttribute('download'), 'auto-cuan-BBCA-pattern.png');
});

// ---------------------------------------------------------------------------
// 5. Teardown
// ---------------------------------------------------------------------------
test('Escape closes the viewer, disposes the chart and restores scroll', async () => {
  const root = makeRoot({ scrollY: 420 });
  const opener = makeElement(root.document, 'button');
  root.document.activeElement = opener;
  const handle = viewer.open(root, { title: 'Chart', candles: CANDLES });
  await Promise.resolve();

  root.document.dispatch('keydown', { key: 'Escape', preventDefault() {} });

  assert.equal(overlayOf(root), null, 'overlay must be removed');
  assert.deepEqual(root.disposed, [handle.chartId], 'the chart instance must be disposed');
  assert.equal(root.scrolledTo, 420);
  assert.equal(opener.focused, true, 'focus must return to whatever opened the viewer');
});

test('the close button tears the viewer down too', () => {
  const root = makeRoot();
  viewer.open(root, { title: 'Chart', candles: CANDLES });
  overlayOf(root).querySelector('.ac-viewer-close').dispatch('click', {});
  assert.equal(overlayOf(root), null);
});

test('opening twice replaces rather than stacks overlays', () => {
  const root = makeRoot();
  viewer.open(root, { title: 'One', candles: CANDLES });
  viewer.open(root, { title: 'Two', candles: CANDLES });
  const overlays = root.document.body.children.filter(child => child.id === 'acChartViewer');
  assert.equal(overlays.length, 1);
  assert.equal(overlays[0].getAttribute('aria-label'), 'Two');
});

test('onClose fires exactly once', () => {
  const root = makeRoot();
  let closed = 0;
  const handle = viewer.open(root, { title: 'Chart', candles: CANDLES, onClose: function () { closed += 1; } });
  handle.close();
  handle.close();
  assert.equal(closed, 1);
});

// ---------------------------------------------------------------------------
// 6. Wiring and boundaries
// ---------------------------------------------------------------------------
test('the viewer is loaded, served no-store, and crosses no protected boundary', () => {
  const source = read('public/chart-viewer.js');
  new vm.Script(source, { filename: 'chart-viewer.js' });
  assert.match(read('public/assets/fca-stocks.js'), /\/chart-viewer\.js\?v=/);
  assert.doesNotMatch(source, /fetch\(|supabase|telegram|navigateTo\s*=/i);
  const headers = JSON.parse(read('vercel.json')).headers || [];
  assert.ok(headers.some(row => row.source === '/chart-viewer.js'));
});

test('the Chart page and Pattern both open the same viewer', () => {
  const html = read('public/index.html');
  const patternStable = read('public/pattern-stable-runtime.js');
  assert.match(html, /function openChartPageFullscreen\(\)/);
  // openChartPageFullscreen() resolves openChartViewer defensively (falling back to
  // window.AutoCuanChartViewer.open if the global isn't wired up yet) rather than
  // calling it as a bare literal, so this checks for that resolution plus the
  // actual invocation with the shared config shape.
  assert.match(html, /typeof openChartViewer === 'function'\)\s*\?\s*openChartViewer/);
  assert.match(html, /viewer\(\{/);
  assert.match(html, /id="' \+ chartId \+ '_fs"/);
  assert.match(patternStable, /root\.openChartViewer\(\{/);
  assert.match(patternStable, /data-ps-zoom/);
});

test('the Chart page fullscreen path reuses loaded data and never refetches', () => {
  const html = read('public/index.html');
  const start = html.indexOf('function openChartPageFullscreen()');
  const body = html.slice(start, html.indexOf('\n}', start));
  assert.match(body, /_chartPageData/);
  assert.doesNotMatch(body, /fetch\(/);
});
