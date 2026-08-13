'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const runtime = require('../public/ui-bugfix-pack-v1');
const patcher = require('../tools/apply-ui-bugfix-pack-v1');

test('analysis page uses document scrolling on desktop', () => {
  assert.match(runtime.STYLE_TEXT, /@media \(min-width:1024px\)/);
  assert.match(runtime.STYLE_TEXT, /#page-analisis #analisisResult\{[^}]*overflow-y:visible!important/);
  assert.match(runtime.STYLE_TEXT, /#page-analisis #analisisResult\{[^}]*flex:0 0 auto!important/);
});

test('scroll chaining is enabled for common inner content regions', () => {
  assert.match(runtime.STYLE_TEXT, /html,body\{overscroll-behavior-y:auto!important/);
  assert.match(runtime.STYLE_TEXT, /#analisisResult,#aiMessages,\.chat-messages,\.ai-messages,\.table-wrap\{overscroll-behavior-y:auto!important/);
});

test('portfolio tabs use seven equal desktop tracks and mobile overflow', () => {
  assert.match(runtime.STYLE_TEXT, /grid-template-columns:repeat\(7,minmax\(0,1fr\)\)!important/);
  assert.match(runtime.STYLE_TEXT, /@media \(max-width:1180px\)/);
  assert.match(runtime.STYLE_TEXT, /#tabStrip\.tab-strip>.tab\{[^}]*flex:0 0 auto!important/);
});

test('portfolio selected tab uses a single green active indicator', () => {
  assert.match(runtime.STYLE_TEXT, /#tabStrip\.tab-strip>.tab::after\{content:none!important/);
  assert.match(runtime.STYLE_TEXT, /aria-selected="true"\]::after\{[^}]*background:#34d399!important/);
});

test('wheel helpers distinguish a scrollable inner region from its boundary', () => {
  const node = { scrollHeight: 500, clientHeight: 200, scrollTop: 100 };
  assert.equal(runtime.canScrollY(node, 40), true);
  assert.equal(runtime.canScrollY(node, -40), true);

  node.scrollTop = 300;
  assert.equal(runtime.canScrollY(node, 40), false);
  assert.equal(runtime.canScrollY(node, -40), true);

  node.scrollTop = 0;
  assert.equal(runtime.canScrollY(node, -40), false);
  assert.equal(runtime.canScrollY(node, 40), true);
});

test('wheel delta normalization preserves trackpad pixels and converts line/page units', () => {
  assert.equal(runtime.normalizedWheelDelta({ deltaY: 37, deltaMode: 0 }, 800), 37);
  assert.equal(runtime.normalizedWheelDelta({ deltaY: 3, deltaMode: 1 }, 800), 48);
  assert.equal(runtime.normalizedWheelDelta({ deltaY: 1, deltaMode: 2 }, 800), 800);
});

test('wheel handoff moves the page when an inner scroller is already at its bottom edge', () => {
  const html = { nodeType: 1, scrollHeight: 2000, clientHeight: 600, scrollTop: 500, parentElement: null };
  const body = { nodeType: 1, scrollHeight: 2000, clientHeight: 600, scrollTop: 500, parentElement: html };
  const inner = { nodeType: 1, scrollHeight: 500, clientHeight: 200, scrollTop: 300, parentElement: body };
  const doc = { scrollingElement: html, documentElement: html, body, head: {} };
  let wheelHandler = null;
  const root = {
    document: doc,
    innerHeight: 600,
    getComputedStyle(node) {
      if (node === inner) return { overflowY: 'auto' };
      return { overflowY: 'visible' };
    },
    addEventListener(type, handler) {
      if (type === 'wheel') wheelHandler = handler;
    }
  };

  assert.equal(runtime.installWheelHandoff(root), true);
  assert.equal(typeof wheelHandler, 'function');

  let prevented = false;
  wheelHandler({
    target: inner,
    deltaX: 0,
    deltaY: 120,
    deltaMode: 0,
    defaultPrevented: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault() { prevented = true; }
  });

  assert.equal(prevented, true);
  assert.equal(html.scrollTop, 620);
});

test('wheel handoff leaves an inner scroller alone while it still has room', () => {
  const html = { nodeType: 1, scrollHeight: 2000, clientHeight: 600, scrollTop: 500, parentElement: null };
  const body = { nodeType: 1, scrollHeight: 2000, clientHeight: 600, scrollTop: 500, parentElement: html };
  const inner = { nodeType: 1, scrollHeight: 500, clientHeight: 200, scrollTop: 100, parentElement: body };
  const doc = { scrollingElement: html, documentElement: html, body, head: {} };
  let wheelHandler = null;
  const root = {
    document: doc,
    innerHeight: 600,
    getComputedStyle(node) {
      if (node === inner) return { overflowY: 'auto' };
      return { overflowY: 'visible' };
    },
    addEventListener(type, handler) {
      if (type === 'wheel') wheelHandler = handler;
    }
  };

  runtime.installWheelHandoff(root);
  let prevented = false;
  wheelHandler({
    target: inner,
    deltaX: 0,
    deltaY: 120,
    deltaMode: 0,
    defaultPrevented: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault() { prevented = true; }
  });

  assert.equal(prevented, false);
  assert.equal(html.scrollTop, 500);
});

test('build patch injects the runtime once into both entry pages', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autocuan-ui-pack-'));
  const publicDir = path.join(root, 'public');
  fs.mkdirSync(publicDir, { recursive: true });
  const indexPath = path.join(publicDir, 'index.html');
  const portfolioPath = path.join(publicDir, 'portfolio-command-center-v2.html');

  fs.writeFileSync(indexPath, '<html><body><main></main></body></html>\n', 'utf8');
  fs.writeFileSync(
    portfolioPath,
    "<script>var assets = [\n    '/portfolio-runtime-fix.js?v=20260728-portfolio-runtime-fix-v1'\n];</script>\n",
    'utf8'
  );

  const first = patcher.applyAll(root);
  const second = patcher.applyAll(root);
  const index = fs.readFileSync(indexPath, 'utf8');
  const portfolio = fs.readFileSync(portfolioPath, 'utf8');

  assert.equal(first.index.changed, true);
  assert.equal(first.portfolio.changed, true);
  assert.equal(second.index.changed, false);
  assert.equal(second.portfolio.changed, false);
  assert.equal(index.split(patcher.INDEX_MARKER).length - 1, 1);
  assert.equal(portfolio.split(patcher.PORTFOLIO_ASSET).length - 1, 1);
});
