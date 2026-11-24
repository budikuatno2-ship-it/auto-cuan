'use strict';

/**
 * test/v6/w2b-ux-bug-matrix.test.js
 * ============================================================================
 * V6 (W2b / Feature 13F) — UX bug matrix fixes.
 *
 *   VIDEO-09  S/R + Fibonacci axis label overlap -> resolveLabelCollisions()
 *   VIDEO-18  intel timeout -> explicit AbortController timeout constants
 *   VIDEO-19  catalogue -> real data/bandarmologi-intel-indexes/*.json
 *   VIDEO-20  GPRA freshness -> explicit freshness text in portfolio runtime
 *   duplicate `rankingContentWrap` id in public/analisis-saham.html
 *
 * These are source/unit assertions. The live browser behaviour of VIDEO-18/19/20
 * needs a running intel endpoint and is marked NOT_TESTED with manual steps in
 * docs/v6/V6_W2B_CHART_SCREENER_UX.md.
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* -------------------------------------------------------------------------- */
/* Duplicate id                                                               */
/* -------------------------------------------------------------------------- */

test('13F-(a): public/analisis-saham.html has no duplicate element ids', () => {
  const html = read('public/analisis-saham.html');
  const ids = {};
  const re = /id="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) ids[m[1]] = (ids[m[1]] || 0) + 1;
  const dup = Object.entries(ids).filter((e) => e[1] > 1);
  assert.deepEqual(dup, [], 'duplicate ids: ' + JSON.stringify(dup));
});

test('13F-(b): rankingContentWrap appears exactly once', () => {
  const html = read('public/analisis-saham.html');
  const count = (html.match(/id="rankingContentWrap"/g) || []).length;
  assert.equal(count, 1);
});

test('13F-(c): the JS ref to rankingContentWrap still resolves', () => {
  const runtime = read('public/analisis-saham-runtime.js');
  assert.match(runtime, /byId\('rankingContentWrap'\)/);
});

/* -------------------------------------------------------------------------- */
/* VIDEO-09 label collision                                                   */
/* -------------------------------------------------------------------------- */

test('13F-(d): drawing module exports a label collision resolver', () => {
  const draw = require(path.join(ROOT, 'public', 'chart-drawing-tools.js'));
  assert.equal(typeof draw.resolveLabelCollisions, 'function');
  const out = draw.resolveLabelCollisions([{ y: 10 }, { y: 12 }, { y: 14 }], 12);
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].y - out[i - 1].y >= 12);
  }
});

test('13F-(e): the chart overlay uses the collision resolver for Fib labels', () => {
  const src = read('public/chart-drawing-tools.js');
  assert.match(src, /resolveLabelCollisions\(labels, 12\)/);
});

/* -------------------------------------------------------------------------- */
/* VIDEO-18 intel timeout                                                     */
/* -------------------------------------------------------------------------- */

test('13F-(f): bandarmologi runtime has explicit intel timeout constants', () => {
  const src = read('public/bandarmologi-runtime.js');
  assert.match(src, /REQ-15/);
  assert.match(src, /60000/);
  assert.match(src, /25000/);
  assert.match(src, /AbortController/);
});

/* -------------------------------------------------------------------------- */
/* VIDEO-19 catalogue                                                         */
/* -------------------------------------------------------------------------- */

test('13F-(g): the intel catalogue is backed by real on-disk index files', () => {
  const dir = path.join(ROOT, 'data', 'bandarmologi-intel-indexes');
  assert.ok(fs.existsSync(dir), 'catalogue dir must exist');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 10, 'expected real catalogue files, found ' + files.length);
  assert.ok(files.indexOf('catalog.json') !== -1);
});

/* -------------------------------------------------------------------------- */
/* VIDEO-20 GPRA freshness                                                    */
/* -------------------------------------------------------------------------- */

test('13F-(h): portfolio runtime surfaces an explicit freshness phrase', () => {
  const src = read('public/portfolio-command-center.js');
  assert.match(src, /harga berhasil diperbarui/);
});

/* -------------------------------------------------------------------------- */
/* Script wiring                                                              */
/* -------------------------------------------------------------------------- */

test('13F-(i): drawing tools script is wired into both chart pages', () => {
  assert.match(read('public/index.html'), /chart-drawing-tools\.js/);
  assert.match(read('public/analisis-saham.html'), /chart-drawing-tools\.js/);
});

test('13F-(j): market-feature-runtime attaches the drawing layer', () => {
  const src = read('public/market-feature-runtime.js');
  assert.match(src, /AutoCuanChartDrawing\.attach/);
});
