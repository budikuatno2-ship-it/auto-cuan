'use strict';

// Focused tests for the canonical-Production-domain redirect implemented as a
// browser-page-only script at the top of public/index.html <head>. Goal: visitors
// on https://auto-cuan.vercel.app/* are sent (via location.replace) to the
// equivalent path+query+hash on https://autocuan.web.id/*, while autocuan.web.id
// itself, localhost, 127.0.0.1, Vercel Preview hosts, and any other hostname are
// left untouched. This redirect must never affect /api/* traffic, VPS scripts,
// GitHub Actions crons, or CRON_SECRET Authorization headers, since those call
// the API directly and never load this HTML page.
//
// Static source assertions over public/index.html (matching the repo's existing
// test style) plus a sandboxed simulation of the extracted IIFE logic against a
// fake `window.location`. No DOM, no network, no production call, no deployment.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const vercelJsonRaw = fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8');
const vercelJson = JSON.parse(vercelJsonRaw);

// Extract the canonical-redirect <script> block (the first <script>...</script>
// in the file, immediately following <title>).
const marker = '// ===== CANONICAL PRODUCTION DOMAIN REDIRECT =====';
const markerIdx = html.indexOf(marker);
assert.ok(markerIdx >= 0, 'expected the canonical redirect marker comment in public/index.html');
const scriptOpenIdx = html.lastIndexOf('<script>', markerIdx);
const scriptCloseIdx = html.indexOf('</script>', markerIdx);
const redirectScriptBlock = html.slice(scriptOpenIdx + '<script>'.length, scriptCloseIdx);

// Locate the very first application script (device-id generation) to prove the
// redirect script physically precedes all auth/app-init code.
const firstAppScriptIdx = html.indexOf('function generateDeviceUuid');
const enterAppIdx = html.indexOf('function enterApp(');

// Helper: run the redirect IIFE in a fresh VM sandbox against a fake location,
// and capture whether/what location.replace was called with.
function runRedirectAgainst(hostname, pathname, search, hash) {
  var calls = [];
  var sandbox = {
    window: {
      location: {
        hostname: hostname,
        pathname: pathname || '/',
        search: search || '',
        hash: hash || '',
        replace: function (url) { calls.push(url); }
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(redirectScriptBlock, sandbox);
  return calls;
}

// 1. Exact hostname auto-cuan.vercel.app redirects.
test('1: auto-cuan.vercel.app redirects to the canonical domain', () => {
  var calls = runRedirectAgainst('auto-cuan.vercel.app', '/', '', '');
  assert.equal(calls.length, 1);
  assert.equal(calls[0], 'https://autocuan.web.id/');
});

// 2. autocuan.web.id does not redirect.
test('2: autocuan.web.id does not redirect', () => {
  var calls = runRedirectAgainst('autocuan.web.id', '/dashboard', '', '');
  assert.equal(calls.length, 0);
});

// 3. Preview hosts do not redirect.
test('3: Vercel Preview deployment hostnames do not redirect', () => {
  var previewHosts = [
    'auto-cuan-git-feature-branch-budikuatno2.vercel.app',
    'auto-cuan-abc123xyz.vercel.app',
    'auto-cuan-budikuatno2-ship-it.vercel.app'
  ];
  previewHosts.forEach(function (h) {
    var calls = runRedirectAgainst(h, '/', '', '');
    assert.equal(calls.length, 0, h + ' must not redirect');
  });
});

// 4. localhost and 127.0.0.1 do not redirect.
test('4: localhost and 127.0.0.1 do not redirect', () => {
  assert.equal(runRedirectAgainst('localhost', '/', '', '').length, 0);
  assert.equal(runRedirectAgainst('127.0.0.1', '/', '', '').length, 0);
});

// 5. Path, query, and hash are preserved exactly.
test('5: path, query string, and hash are all preserved', () => {
  var calls = runRedirectAgainst('auto-cuan.vercel.app', '/dashboard', '?tab=daytrade', '#latest');
  assert.equal(calls.length, 1);
  assert.equal(calls[0], 'https://autocuan.web.id/dashboard?tab=daytrade#latest');
});

test('5b: root path with no query/hash preserves exactly "/"', () => {
  var calls = runRedirectAgainst('auto-cuan.vercel.app', '/', '', '');
  assert.equal(calls[0], 'https://autocuan.web.id/');
});

test('5c: /dashboard with no query/hash preserves the plain path', () => {
  var calls = runRedirectAgainst('auto-cuan.vercel.app', '/dashboard', '', '');
  assert.equal(calls[0], 'https://autocuan.web.id/dashboard');
});

// 6. location.replace is used (not location.href / location.assign).
test('6: the redirect uses location.replace, not href/assign', () => {
  assert.match(redirectScriptBlock, /window\.location\.replace\(/);
  assert.doesNotMatch(redirectScriptBlock, /window\.location\.href\s*=/);
  assert.doesNotMatch(redirectScriptBlock, /window\.location\.assign\(/);
});

// 7. The redirect script physically runs before login/application initialization.
test('7: the redirect script appears before device-id generation and enterApp()', () => {
  assert.ok(firstAppScriptIdx > 0, 'expected to find generateDeviceUuid in the file');
  assert.ok(enterAppIdx > 0, 'expected to find enterApp( in the file');
  assert.ok(scriptCloseIdx < firstAppScriptIdx,
    'redirect script must close before generateDeviceUuid (device-id/login init) is defined');
  assert.ok(scriptCloseIdx < enterAppIdx,
    'redirect script must close before enterApp (app init) is defined');
  // Also confirm it is the very first <script> tag in the document.
  var firstScriptOpen = html.indexOf('<script');
  assert.equal(firstScriptOpen, scriptOpenIdx, 'redirect script must be the first <script> tag in the document');
});

// 8. vercel.json has no host-wide redirect (reverted from the prior approach).
test('8: vercel.json contains no "redirects" key / no host-based redirect rule', () => {
  assert.equal(Object.prototype.hasOwnProperty.call(vercelJson, 'redirects'), false,
    'vercel.json must not define a redirects array for this feature');
  assert.doesNotMatch(vercelJsonRaw, /"type"\s*:\s*"host"/);
  assert.doesNotMatch(vercelJsonRaw, /autocuan\.web\.id/);
});

// 9. Existing /dashboard and /review rewrites remain unchanged, and the
// portfolio planner keeps its clean route. No other rewrites may appear.
test('9: existing /review and /dashboard rewrites remain intact', () => {
  var rewrites = vercelJson.rewrites || [];
  var review = rewrites.find(function (r) { return r.source === '/review'; });
  var dashboard = rewrites.find(function (r) { return r.source === '/dashboard'; });
  var planner = rewrites.find(function (r) { return r.source === '/portfolio-planner'; });
  assert.ok(review, 'expected /review rewrite');
  assert.equal(review.destination, '/index.html');
  assert.ok(dashboard, 'expected /dashboard rewrite');
  assert.equal(dashboard.destination, '/index.html');
  assert.ok(planner, 'expected /portfolio-planner rewrite');
  // Portfolio Planner v2 rollout: the route now serves the v2 file.
  assert.equal(planner.destination, '/portfolio-command-center-v2.html');
  // Routing consolidation onto shared Vercel Function slots (Hobby plan function
  // limit) added /pattern and the /api/subscription-* -> /api/review-access rewrites.
  assert.equal(rewrites.length, 6, 'no unexpected extra rewrites were introduced');
});

// 10. Existing Vercel cron remains unchanged.
test('10: existing telegram-daily-picks cron entry remains present and unchanged', () => {
  var crons = vercelJson.crons || [];
  assert.equal(crons.length, 1, 'no extra cron entries were introduced');
  var dailyPicks = crons.find(function (c) {
    return c.path === '/api/sector-hot?action=telegram-daily-picks';
  });
  assert.ok(dailyPicks, 'expected telegram-daily-picks cron entry');
  assert.equal(dailyPicks.schedule, '0 1 * * 1-5');
});

// 11. Existing API and automation URLs are not modified by this patch.
test('11: APP_BASE_URL / automation base URLs are untouched', () => {
  var runAllScreeners = fs.readFileSync(path.join(ROOT, 'tools', 'run-all-screeners-vps.js'), 'utf8');
  var runAfterMarket = fs.readFileSync(path.join(ROOT, 'tools', 'run-after-market-top5-lock.js'), 'utf8');
  assert.match(runAllScreeners, /https:\/\/auto-cuan\.vercel\.app/,
    'run-all-screeners-vps.js must still default to the original Vercel base URL');
  assert.match(runAfterMarket, /https:\/\/auto-cuan\.vercel\.app/,
    'run-after-market-top5-lock.js must still default to the original Vercel base URL');
});

// 12. API endpoint JavaScript count remains exactly 12.
test('12: api endpoint count remains exactly 12', () => {
  var files = fs.readdirSync(path.join(ROOT, 'api')).filter(function (f) { return f.endsWith('.js'); });
  assert.equal(files.length, 12, 'found: ' + files.join(', '));
});
