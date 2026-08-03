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

test('portfolio tabs use seven equal desktop tracks and mobile overflow', () => {
  assert.match(runtime.STYLE_TEXT, /grid-template-columns:repeat\(7,minmax\(0,1fr\)\)!important/);
  assert.match(runtime.STYLE_TEXT, /@media \(max-width:1180px\)/);
  assert.match(runtime.STYLE_TEXT, /#tabStrip\.tab-strip>.tab\{[^}]*flex:0 0 auto!important/);
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
