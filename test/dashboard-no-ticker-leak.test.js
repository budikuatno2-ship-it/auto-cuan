'use strict';

/**
 * Dashboard must never adopt an emiten context.
 *
 * A ?ticker= parameter on /dashboard is a state leak: it makes the page look
 * like a stock view, it survives navigation into unrelated tabs, and it causes
 * per-emiten quote/candle/fundamental requests to fire while the user is only
 * looking at macro data. That fan-out is what pushed the origin into the
 * Cloudflare 504 window. These assertions pin the three places that could
 * re-introduce the leak.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const indexHtml = read('public/index.html');
const cockpitRuntime = read('public/unified-cockpit-runtime.js');

test('canonical route builder drops ?ticker= on every non-analisis page', () => {
  const fn = indexHtml.match(/function getCanonicalRouteUrl\(page, subTab\) \{[\s\S]*?\n\}/);
  assert.ok(fn, 'getCanonicalRouteUrl must exist');
  assert.match(
    fn[0],
    /if \(page !== 'analisis'\) searchParams\.delete\('ticker'\);/,
    'non-analisis routes must delete the ticker parameter'
  );
});

test('showDashboard strips a leftover ticker from the address bar', () => {
  assert.match(indexHtml, /function stripTickerFromUrl\(\)\s*\{/, 'stripTickerFromUrl must exist');
  assert.match(
    indexHtml,
    /stripTickerFromUrl\(\);\n\}/,
    'showDashboard must call stripTickerFromUrl()'
  );
  const strip = indexHtml.match(/function stripTickerFromUrl\(\) \{[\s\S]*?\n\}/);
  assert.match(strip[0], /url\.searchParams\.delete\('ticker'\)/, 'the helper must delete the ticker');
  assert.match(strip[0], /replaceState/, 'the helper must use replaceState so Back is not polluted');
});

test('navigateTo only syncs the active ticker on the analisis page', () => {
  assert.match(
    indexHtml,
    /if \(page === 'analisis' && window\.UnifiedCockpit && typeof window\.UnifiedCockpit\.syncActiveTicker === 'function'\)/,
    'the global ticker sync must be gated on the analisis page'
  );
});

test('syncActiveTicker writes the URL ticker only while analisis is visible', () => {
  const fn = cockpitRuntime.match(/function syncActiveTicker\(rawTicker, options\) \{[\s\S]*?\n  \}\n/);
  assert.ok(fn, 'syncActiveTicker must exist');
  assert.match(fn[0], /var onAnalisisPage = document\.getElementById\('page-analisis'\)/, 'must read the analisis page state');
  assert.match(fn[0], /url\.searchParams\.delete\('ticker'\)/, 'must delete the ticker off-page');
});

test('getActiveTicker has no invented BBCA default', () => {
  const fn = cockpitRuntime.match(/function getActiveTicker\(\) \{[\s\S]*?\n  \}/);
  assert.ok(fn, 'getActiveTicker must exist');
  assert.doesNotMatch(fn[0], /\|\| 'BBCA'/, 'a hardcoded BBCA default would be written into the URL');
  assert.match(fn[0], /fromWindow \|\| fromInput \|\| fromChartInput \|\| '';/, 'must return an empty string when unset');
});

test('initCockpit only adopts a URL ticker when the analisis page is visible', () => {
  assert.match(
    cockpitRuntime,
    /if \(analisisVisible && typeof window !== 'undefined' && window\.location\)/,
    'the initial URL ticker read must be gated on the analisis page'
  );
  assert.match(
    cockpitRuntime,
    /if \(current && analisisVisible\) \{\n      loadUnifiedChart\(current\);/,
    'the initial chart load must be gated on the analisis page'
  );
});

test('Dashboard macro loaders do not request a per-emiten ticker', () => {
  // loadDashboardTop5Monitor is the Dashboard's only data entry point and must
  // stay on the macro endpoints.
  const fn = indexHtml.match(/async function loadDashboardTop5Monitor\(silent, opts\) \{[\s\S]*?\n\}/);
  assert.ok(fn, 'loadDashboardTop5Monitor must exist');
  assert.doesNotMatch(fn[0], /api\/quote\?ticker=/, 'Dashboard must not call the per-ticker quote endpoint');
  assert.doesNotMatch(fn[0], /api\/candles\?ticker=/, 'Dashboard must not call the per-ticker candle endpoint');
});
