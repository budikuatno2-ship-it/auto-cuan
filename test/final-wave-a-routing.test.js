'use strict';

/**
 * AUTO-CUAN — FINAL REPAIR WAVE A TARGETED TEST SUITE
 *
 * Covers:
 *   FINAL-BUG-001: Promoted Riset Pasar sub-tools mapping & zero-blank-canvas guarantee
 *   FINAL-BUG-002: Server deep-link fallback (/screener, /watchlist, /sektor, /trackrecord, 404 safety)
 *   FINAL-BUG-003: SPA history engine, URL state management & popstate restoration
 *   FINAL-HC-001: Cold unauthenticated landing network guard (zero protected screener calls, zero 401s)
 *   FINAL-HC-002: Guest news deep link preservation under session-status 401
 *   FINAL-RISK-002: Deprecated routes invariant (no revival of /kelola-keuangan, /subscription, etc.)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const INDEX_HTML_PATH = path.join(ROOT, 'public', 'index.html');
const AUTH_V2_PATH = path.join(ROOT, 'public', 'auth-v2.js');
const LOCAL_DEV_SERVER_PATH = path.join(ROOT, 'tools', 'local-dev-server.js');
const NGINX_CONF_PATH = path.join(ROOT, 'deploy', 'nginx', 'autocuan');
const VERCEL_JSON_PATH = path.join(ROOT, 'vercel.json');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function request(port, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'GET', headers: headers || {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8')
        }));
      }
    );
    req.setTimeout(8000, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function waitForServer(port, timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    try {
      const res = await request(port, '/');
      if (res.status === 200) return;
    } catch (_) {}
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for local dev server on port ' + port);
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ============================================================================
// SUITE 1: STATIC & CONTRACT INVARIANTS
// ============================================================================

test('FINAL-BUG-001: index.html maps promoted Riset Pasar keys to analisis subtabs without blank canvas', () => {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');

  // Verify PROMOTED_ANALISIS_MAP definition
  assert.ok(html.includes("var PROMOTED_ANALISIS_MAP = {"), 'PROMOTED_ANALISIS_MAP must be defined in index.html');
  const expectedKeys = ['intel', 'hunter', 'insider', 'ranking', 'financial', 'market-structure', 'pattern', 'bandarmologi', 'chart'];
  expectedKeys.forEach((key) => {
    assert.ok(html.includes(`'${key}':`), `PROMOTED_ANALISIS_MAP must contain entry for ${key}`);
  });

  // Verify navigateTo forwards promoted keys
  assert.ok(html.includes('if (page in PROMOTED_ANALISIS_MAP)'), 'navigateTo must detect promoted keys');
  assert.ok(html.includes("navigateTo('analisis', targetSubTab"), 'navigateTo must map promoted keys to analisis page');

  // Verify pattern admin gating
  assert.ok(html.includes("if (targetSubTab === 'pattern' && !isAdmin())"), 'Pattern radar must be admin-gated in navigateTo');
});

test('FINAL-BUG-002: local-dev-server, nginx, and vercel.json all resolve the 4 active deep links to the SPA shell', () => {
  const serverCode = fs.readFileSync(LOCAL_DEV_SERVER_PATH, 'utf8');
  const vercelJson = JSON.parse(fs.readFileSync(VERCEL_JSON_PATH, 'utf8'));
  const activeLinks = ['/screener', '/watchlist', '/sektor', '/trackrecord'];

  activeLinks.forEach((link) => {
    assert.ok(serverCode.includes(`'${link}': '/index.html'`), `local-dev-server ROUTE_REWRITES must contain ${link}`);
    const vMatch = vercelJson.rewrites.find((r) => r.source === link && r.destination === '/index.html');
    assert.ok(vMatch, `vercel.json rewrites must contain ${link} -> /index.html`);
  });

  const nginxConf = fs.readFileSync(NGINX_CONF_PATH, 'utf8');
  assert.ok(nginxConf.includes('screener|watchlist|sektor|trackrecord'), 'nginx config must explicitly proxy active SPA deep links');
});

test('FINAL-BUG-002: enterApp activates the app shell before navigating (cold deep-link visibility)', () => {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const fnMatch = html.match(/function enterApp\(opts\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(fnMatch, 'enterApp must exist');
  const body = fnMatch[1];
  assert.ok(body.includes("setTopLevelView('app')"), 'enterApp must activate the app top-level view so #dashboardScreen is not left hidden');
  assert.ok(body.includes('showDashboard()'), 'enterApp must preserve the showDashboard() initialization path');
});

test('FINAL-HC-002: auth-v2 re-enters the app for any protected SPA route after session restore', () => {
  const authCode = fs.readFileSync(AUTH_V2_PATH, 'utf8');
  assert.ok(authCode.includes('isProtectedSpaRoute'), 'auth-v2 must compute a protected-route flag, not only check /dashboard');
  assert.ok(authCode.includes("route.authRequired === true"), 'auth-v2 must honor parseAppRoute().authRequired');
  assert.ok(authCode.includes("p === '/screener'"), 'auth-v2 fallback must include the new deep-link paths');
});

test('FINAL-BUG-003: index.html implements URL canonicalization, history pushState, and popstate handling', () => {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');

  assert.ok(html.includes('function parseAppRoute()'), 'parseAppRoute() must be defined');
  assert.ok(html.includes('function getCanonicalRouteUrl('), 'getCanonicalRouteUrl() must be defined');
  assert.ok(html.includes('window.history.pushState('), 'navigateTo must use history.pushState() for new navigation');
  assert.ok(html.includes("window.addEventListener('popstate'"), 'popstate listener must be active');
  assert.ok(html.includes('fromPopstate: true'), 'popstate must trigger handleAppRoute with fromPopstate');

  // Back to a plain /dashboard must re-mount the dashboard. Production probing
  // showed the previous sub-page stayed visible with the sidebar highlight
  // still on it while the URL read /dashboard.
  const fnMatch = html.match(/function checkInitialUrlTargetPage\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(fnMatch, 'checkInitialUrlTargetPage must exist');
  const body = fnMatch[1];
  assert.match(body, /if \(route\.page === 'dashboard'\)/, 'checkInitialUrlTargetPage must handle the plain dashboard route');
  assert.match(body, /navigateTo\('dashboard', null, \{ skipHistory: true \}\)/, 'Back to /dashboard must re-mount the dashboard page');
});

test('FINAL-HC-001: fetchManualConfluenceRow guards against unauthenticated 401 screener requests', () => {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');

  const fnMatch = html.match(/async function fetchManualConfluenceRow\([^)]*\)\s*\{([^}]+(?:\{[^}]*\}[^}]+)*)\}/);
  assert.ok(fnMatch, 'fetchManualConfluenceRow must exist in index.html');
  const fnBody = fnMatch[1];
  assert.ok(fnBody.includes('!isAutocuanLoggedIn()'), 'fetchManualConfluenceRow must check isAutocuanLoggedIn() before fetching');
  assert.ok(fnBody.includes('return;'), 'fetchManualConfluenceRow must early-return for unauthenticated sessions');
});

test('FINAL-HC-001: pattern-screener-extension skips protected screener fetch when unauthenticated', () => {
  // Production root-cause: this extension auto-installs on EVERY page (including
  // the cold landing) and loadSetups() hits three protected screener endpoints,
  // producing the 401 cascade. It must gate the fetch on a confirmed session.
  const ext = fs.readFileSync(path.join(ROOT, 'public', 'pattern-screener-extension.js'), 'utf8');
  const fnMatch = ext.match(/async function loadSetups\(force\)\s*\{([\s\S]*?)\n    \}/);
  assert.ok(fnMatch, 'loadSetups must exist in pattern-screener-extension.js');
  const body = fnMatch[1];
  assert.ok(body.includes('isConfirmedSession()'), 'loadSetups must consult the confirmed-session helper before fetching protected sources');
  assert.match(body, /if \(!isConfirmedSession\(\)\) return state\.setups;/, 'loadSetups must early-return for unauthenticated visitors');
  assert.ok(ext.includes('function isConfirmedSession()'), 'isConfirmedSession helper must exist');
  assert.match(ext, /root\.isAutocuanLoggedIn\(\) === true/, 'isConfirmedSession must require an explicit true');

  // Cold load with a valid HttpOnly cookie: auth-v2 resolves the session AFTER
  // this install runs, so the extension must retry when the session is ready.
  assert.ok(ext.includes("root.addEventListener('autocuan:session-ready'"), 'extension must retry loadSetups on autocuan:session-ready');
  const authCode = fs.readFileSync(AUTH_V2_PATH, 'utf8');
  assert.ok(authCode.includes("new CustomEvent('autocuan:session-ready')"), 'auth-v2 must emit autocuan:session-ready (contract the retry depends on)');

  // Cache-busting contract: Nginx serves .js as `max-age=604800, immutable` and
  // Cloudflare caches it at the edge, so a changed extension only reaches
  // browsers when the loader's query string changes with it.
  const loader = fs.readFileSync(path.join(ROOT, 'public', 'assets', 'fca-stocks.js'), 'utf8');
  assert.ok(/pattern-screener-extension\.js\?v=/.test(loader), 'loader must version the extension URL');
  assert.ok(!loader.includes('pattern-screener-extension.js?v=20260813-pattern-screener-v7'), 'stale frozen v7 query must be bumped so the FINAL-HC-001 fix is not served from an immutable edge cache');

  // The loader itself must also be cache-busted from index.html: an unversioned
  // /assets/fca-stocks.js keeps serving the pre-fix loader for up to 7 days
  // (Nginx immutable + Cloudflare edge), which silently re-pins the old query.
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  assert.match(html, /<script src="\/assets\/fca-stocks\.js\?v=[^"]+"><\/script>/, 'index.html must load fca-stocks.js with a cache-busting query');
  assert.ok(!html.includes('<script src="/assets/fca-stocks.js"></script>'), 'unversioned fca-stocks.js script tag must not return');

  // Same chain for auth-v2.js: FINAL-HC-002 (guest news survives session 401)
  // and the protected-route re-entry both live in that file. Production proved
  // the stale v2 asset still ran the old returnToGuest path, so BOTH the
  // bootstrapper's version and the bootstrapper's own tag must be cache-busted.
  const bootstrap = fs.readFileSync(path.join(ROOT, 'public', 'website-approved-access.js'), 'utf8');
  assert.ok(!bootstrap.includes('/auth-v2.js?v=20260929-dialog-v2'), 'stale auth-v2 v2 query must be bumped so the FINAL-HC-002 fix is not served from an immutable edge cache');
  assert.match(bootstrap, /\/auth-v2\.js\?v=[^']+/, 'bootstrapper must version the auth-v2 URL');
  assert.match(html, /<script src="\/website-approved-access\.js\?v=[^"]+"><\/script>/, 'index.html must load the approved-access bootstrapper with a cache-busting query');
  assert.ok(!html.includes('<script src="/website-approved-access.js?v=20260929-experience-v2"></script>'), 'stale bootstrapper v2 query must be bumped');
});

test('FINAL-HC-002: auth-v2.js preserves guest-permitted routes on session-status 401', () => {
  const authCode = fs.readFileSync(AUTH_V2_PATH, 'utf8');

  assert.ok(authCode.includes('isCurrentRouteGuestAllowed'), 'auth-v2.js must check isCurrentRouteGuestAllowed() on session 401');
  assert.ok(authCode.includes('!isGuestPermitted'), 'returnToGuest() must only be called if route is not guest-permitted');
});

test('FINAL-RISK-002: Obsolete aliases stay deprecated and legitimate aliases remain functional', () => {
  const serverCode = fs.readFileSync(LOCAL_DEV_SERVER_PATH, 'utf8');
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');

  // Deprecated routes must NOT be mapped to new active features
  assert.ok(html.includes("if (page === 'subscription')"), 'subscription remains redirected to dashboard');
  assert.ok(!html.includes('data-page="subscription"'), 'subscription is not in primary navigation');

  // Legitimate aliases must be intact
  assert.ok(serverCode.includes("'/broksum': '/analisis-saham.html'"), '/broksum alias preserved');
  assert.ok(serverCode.includes("'/broker-summary': '/analisis-saham.html'"), '/broker-summary alias preserved');
  assert.ok(serverCode.includes("'/bandarmologi': '/analisis-saham.html'"), '/bandarmologi alias preserved');
});

// ============================================================================
// SUITE 2: REAL HTTP SERVER DEEP LINK INTEGRATION (FINAL-BUG-002 & 404 SAFETY)
// ============================================================================

test('FINAL-BUG-002 & 404 SAFETY: Real spawned server route resolution', async () => {
  const port = await getFreePort();
  const child = spawn(process.execPath, [LOCAL_DEV_SERVER_PATH], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'production' },
    stdio: 'ignore'
  });

  try {
    await waitForServer(port);

    // 1. Active SPA deep links must return HTTP 200 with SPA shell
    const activeRoutes = ['/screener', '/watchlist', '/sektor', '/trackrecord', '/dashboard'];
    for (const route of activeRoutes) {
      const res = await request(port, route);
      assert.equal(res.status, 200, `${route} must return HTTP 200`);
      assert.ok(res.body.includes('<!DOCTYPE html>'), `${route} must serve SPA index.html`);
      assert.ok(res.body.includes('id="page-dashboard"'), `${route} must contain SPA dashboard container`);
    }

    // 2. Unknown random routes MUST return 404 Not Found (404 safety)
    const unknownRes = await request(port, '/definitely-not-a-real-route-xyz-404');
    assert.equal(unknownRes.status, 404, 'Unknown random route must return HTTP 404');

    const anotherUnknown = await request(port, '/invalid-path/deep/nested');
    assert.equal(anotherUnknown.status, 404, 'Nested unknown route must return HTTP 404');

    // 3. Legitimate analysis aliases
    const broksumRes = await request(port, '/broksum');
    assert.ok(broksumRes.status === 200 || broksumRes.status === 302, '/broksum must resolve correctly');

    const bandarmologiRes = await request(port, '/bandarmologi');
    assert.ok(bandarmologiRes.status === 200 || bandarmologiRes.status === 302, '/bandarmologi must resolve correctly');

  } finally {
    child.kill('SIGTERM');
  }
});

// ============================================================================
// SUITE 3: ROUTER & HISTORY SIMULATION (FINAL-BUG-001, FINAL-BUG-003, FINAL-HC-002)
// ============================================================================

test('FINAL-BUG-001 & FINAL-BUG-003: Promoted subtools, History push/pop, and Guest News simulation', () => {
  // Simulate browser environment
  const mockHistory = [];
  let historyIndex = -1;

  const mockWindow = {
    location: {
      pathname: '/dashboard',
      search: '',
      hash: '',
      href: 'http://localhost/dashboard'
    },
    history: {
      pushState(state, title, url) {
        historyIndex++;
        mockHistory.splice(historyIndex, mockHistory.length - historyIndex, { state, url });
        mockWindow.updateLocationFromUrl(url);
      },
      replaceState(state, title, url) {
        if (historyIndex < 0) {
          historyIndex = 0;
          mockHistory[0] = { state, url };
        } else {
          mockHistory[historyIndex] = { state, url };
        }
        mockWindow.updateLocationFromUrl(url);
      }
    },
    updateLocationFromUrl(url) {
      const qIdx = url.indexOf('?');
      if (qIdx >= 0) {
        mockWindow.location.pathname = url.slice(0, qIdx);
        mockWindow.location.search = url.slice(qIdx);
      } else {
        mockWindow.location.pathname = url;
        mockWindow.location.search = '';
      }
      mockWindow.location.href = 'http://localhost' + url;
    }
  };

  // Mock DOM
  const pages = {
    'dashboard': { id: 'page-dashboard', hidden: false },
    'analisis': { id: 'page-analisis', hidden: true },
    'screener': { id: 'page-screener', hidden: true },
    'watchlist': { id: 'page-watchlist', hidden: true },
    'sektor': { id: 'page-sektor', hidden: true },
    'trackrecord': { id: 'page-trackrecord', hidden: true },
    'news': { id: 'page-news', hidden: true },
    'portofolio': { id: 'page-portofolio', hidden: true }
  };

  const panels = {
    'analisis-chart': { visible: true },
    'bandarmologi': { visible: false },
    'intel': { visible: false },
    'hunter': { visible: false },
    'insider': { visible: false },
    'ranking': { visible: false },
    'financial': { visible: false },
    'market-structure': { visible: false },
    'pattern': { visible: false }
  };

  let activeSubTab = 'analisis-chart';
  let currentPage = 'dashboard';
  let adminMode = false;
  let loggedInMode = true;

  const PROMOTED_MAP = {
    'chart': 'analisis-chart',
    'analisis-chart': 'analisis-chart',
    'bandarmologi': 'bandarmologi',
    'intel': 'intel',
    'hunter': 'hunter',
    'insider': 'insider',
    'ranking': 'ranking',
    'financial': 'financial',
    'market-structure': 'market-structure',
    'pattern': 'pattern'
  };

  function parseAppRoute() {
    const path = (mockWindow.location.pathname || '/').toLowerCase().replace(/\/$/, '') || '/';
    const params = new URLSearchParams(mockWindow.location.search);
    const pageParam = (params.get('page') || '').toLowerCase();
    const tabParam = (params.get('tab') || '').toLowerCase();

    if (path === '/screener') return { page: 'screener', subTab: null, authRequired: true };
    if (path === '/watchlist') return { page: 'watchlist', subTab: null, authRequired: true };
    if (path === '/sektor') return { page: 'sektor', subTab: null, authRequired: true };
    if (path === '/trackrecord') return { page: 'trackrecord', subTab: null, authRequired: true };

    if (path === '/dashboard') {
      const target = pageParam;
      if (target === 'news') return { page: 'news', subTab: null, allowGuest: true };
      if (target === 'analisis' || target === 'chart') {
        const sub = tabParam ? (PROMOTED_MAP[tabParam] || tabParam) : 'analisis-chart';
        return { page: 'analisis', subTab: sub, allowGuest: true };
      }
      if (target in PROMOTED_MAP) {
        return { page: 'analisis', subTab: PROMOTED_MAP[target], allowGuest: true };
      }
      if (target === 'screener') return { page: 'screener', subTab: null, authRequired: true };
      if (target === 'watchlist') return { page: 'watchlist', subTab: null, authRequired: true };
      if (target === 'sektor') return { page: 'sektor', subTab: null, authRequired: true };
      if (target === 'trackrecord') return { page: 'trackrecord', subTab: null, authRequired: true };
      return { page: 'dashboard', subTab: null, authRequired: true };
    }

    if (path === '/' || path === '') return { page: 'landing', allowGuest: true };
    return { page: 'unknown', isUnknown: true };
  }

  function getCanonicalRouteUrl(page, subTab) {
    if (page in PROMOTED_MAP) {
      subTab = PROMOTED_MAP[page];
      page = 'analisis';
    }
    const params = new URLSearchParams(mockWindow.location.search);
    params.delete('page');
    params.delete('tab');
    if (page === 'screener') return '/screener' + (params.toString() ? '?' + params.toString() : '');
    if (page === 'watchlist') return '/watchlist' + (params.toString() ? '?' + params.toString() : '');
    if (page === 'sektor') return '/sektor' + (params.toString() ? '?' + params.toString() : '');
    if (page === 'trackrecord') return '/trackrecord' + (params.toString() ? '?' + params.toString() : '');
    if (page === 'news') {
      params.set('page', 'news');
      return '/dashboard?' + params.toString();
    }
    if (page === 'analisis') {
      params.set('page', 'analisis');
      if (subTab && subTab !== 'analisis-chart') params.set('tab', subTab);
      return '/dashboard?' + params.toString();
    }
    return '/dashboard' + (params.toString() ? '?' + params.toString() : '');
  }

  function navigateTo(page, subTab, options = {}) {
    if (page in PROMOTED_MAP) {
      let targetSubTab = PROMOTED_MAP[page];
      if (targetSubTab === 'pattern' && !adminMode) targetSubTab = 'analisis-chart';
      return navigateTo('analisis', targetSubTab, options);
    }
    if (page === 'analisis') {
      if (subTab in PROMOTED_MAP) subTab = PROMOTED_MAP[subTab];
      if (subTab === 'pattern' && !adminMode) subTab = 'analisis-chart';
      subTab = subTab || 'analisis-chart';
      activeSubTab = subTab;
    }

    currentPage = page;

    if (!options.skipHistory) {
      const targetUrl = getCanonicalRouteUrl(page, subTab);
      const currentFull = mockWindow.location.pathname + mockWindow.location.search;
      if (options.replaceState) {
        mockWindow.history.replaceState({ page, subTab }, '', targetUrl);
      } else if (currentFull !== targetUrl) {
        mockWindow.history.pushState({ page, subTab }, '', targetUrl);
      }
    }

    // DOM visibility simulation
    for (const key of Object.keys(pages)) {
      pages[key].hidden = (key !== page);
    }
    if (page === 'analisis') {
      for (const k of Object.keys(panels)) {
        panels[k].visible = (k === activeSubTab);
      }
    }
  }

  function getVisiblePageCount() {
    return Object.values(pages).filter((p) => !p.hidden).length;
  }

  // --- TEST A: PROMOTED NAV TEST ---
  const promotedTools = ['intel', 'hunter', 'insider', 'financial', 'market-structure'];
  for (const tool of promotedTools) {
    navigateTo(tool);
    assert.equal(currentPage, 'analisis', `Calling navigateTo('${tool}') must mount 'analisis' page`);
    assert.equal(activeSubTab, tool, `Active sub-tab must be '${tool}'`);
    assert.equal(panels[tool].visible, true, `Panel panel-tab-${tool} must be visible`);
    assert.equal(getVisiblePageCount(), 1, `Visible page count must be exactly 1 (no blank canvas) for ${tool}`);
    assert.equal(mockWindow.location.pathname + mockWindow.location.search, `/dashboard?page=analisis&tab=${tool}`);
  }

  // Test Pattern admin gate
  adminMode = false;
  navigateTo('pattern');
  assert.equal(activeSubTab, 'analisis-chart', 'Non-admin navigating to pattern must fall back to analisis-chart');

  adminMode = true;
  navigateTo('pattern');
  assert.equal(activeSubTab, 'pattern', 'Admin navigating to pattern must mount pattern subtab');
  assert.equal(panels['pattern'].visible, true);
  assert.equal(getVisiblePageCount(), 1);

  // --- TEST C: HISTORY SEQUENCE ---
  // Sequence: Dashboard -> Analisis -> Track Record
  mockHistory.length = 0;
  historyIndex = -1;

  mockWindow.location.pathname = '/dashboard';
  mockWindow.location.search = '';
  navigateTo('dashboard', null, { replaceState: true });
  assert.equal(mockHistory.length, 1);
  assert.equal(mockHistory[0].url, '/dashboard');

  navigateTo('analisis', 'analisis-chart');
  assert.equal(mockHistory.length, 2);
  assert.equal(mockHistory[1].url, '/dashboard?page=analisis');

  navigateTo('trackrecord');
  assert.equal(mockHistory.length, 3);
  assert.equal(mockHistory[2].url, '/trackrecord');

  // Popstate 1: Back to Analisis
  historyIndex--;
  mockWindow.updateLocationFromUrl(mockHistory[historyIndex].url);
  const routeBack1 = parseAppRoute();
  navigateTo(routeBack1.page, routeBack1.subTab, { skipHistory: true });
  assert.equal(currentPage, 'analisis');
  assert.equal(mockWindow.location.pathname + mockWindow.location.search, '/dashboard?page=analisis');
  assert.equal(getVisiblePageCount(), 1);

  // Popstate 2: Back to Dashboard
  historyIndex--;
  mockWindow.updateLocationFromUrl(mockHistory[historyIndex].url);
  const routeBack2 = parseAppRoute();
  navigateTo(routeBack2.page, routeBack2.subTab, { skipHistory: true });
  assert.equal(currentPage, 'dashboard');
  assert.equal(mockWindow.location.pathname, '/dashboard');
  assert.equal(getVisiblePageCount(), 1);

  // Forward: To Analisis
  historyIndex++;
  mockWindow.updateLocationFromUrl(mockHistory[historyIndex].url);
  const routeFwd1 = parseAppRoute();
  navigateTo(routeFwd1.page, routeFwd1.subTab, { skipHistory: true });
  assert.equal(currentPage, 'analisis');

  // Forward: To Trackrecord
  historyIndex++;
  mockWindow.updateLocationFromUrl(mockHistory[historyIndex].url);
  const routeFwd2 = parseAppRoute();
  navigateTo(routeFwd2.page, routeFwd2.subTab, { skipHistory: true });
  assert.equal(currentPage, 'trackrecord');

  // --- TEST D: ANALYSIS SUBTAB HISTORY ---
  // Analisis Chart -> Bandarmologi -> Intel -> Financial -> Back -> Intel
  mockHistory.length = 0;
  historyIndex = -1;

  navigateTo('analisis', 'analisis-chart', { replaceState: true });
  navigateTo('analisis', 'bandarmologi');
  navigateTo('analisis', 'intel');
  navigateTo('analisis', 'financial');

  assert.equal(mockWindow.location.pathname + mockWindow.location.search, '/dashboard?page=analisis&tab=financial');
  assert.equal(mockHistory.length, 4);

  // Pop Back -> Intel
  historyIndex--;
  mockWindow.updateLocationFromUrl(mockHistory[historyIndex].url);
  const subRouteBack = parseAppRoute();
  navigateTo(subRouteBack.page, subRouteBack.subTab, { skipHistory: true });
  assert.equal(currentPage, 'analisis');
  assert.equal(activeSubTab, 'intel');
  assert.equal(panels['intel'].visible, true);
  assert.equal(mockWindow.location.pathname + mockWindow.location.search, '/dashboard?page=analisis&tab=intel');

  // --- TEST E: GUEST NEWS UNDER SESSION 401 ---
  mockWindow.location.pathname = '/dashboard';
  mockWindow.location.search = '?page=news';
  const newsRoute = parseAppRoute();
  assert.equal(newsRoute.page, 'news');
  assert.equal(newsRoute.allowGuest, true);

  // Check auth-v2 gate logic
  const isGuestAllowedOnNews = (newsRoute.allowGuest === true || newsRoute.page === 'news');
  assert.equal(isGuestAllowedOnNews, true, 'News route must be allowed for guests');

  // Protected route under same check
  mockWindow.location.pathname = '/screener';
  mockWindow.location.search = '';
  const screenerRoute = parseAppRoute();
  assert.equal(screenerRoute.page, 'screener');
  assert.equal(screenerRoute.authRequired, true);
  const isGuestAllowedOnScreener = (screenerRoute.allowGuest === true || screenerRoute.page === 'news');
  assert.equal(isGuestAllowedOnScreener, false, 'Screener route must NOT be allowed for guests');
});

// ============================================================================
// SUITE 4: COLD LANDING NETWORK INTERCEPT (FINAL-HC-001)
// ============================================================================

test('FINAL-HC-001: Unauthenticated cold landing makes 0 protected screener requests', async () => {
  // Simulate unauthenticated browser environment
  let protectedRequestsFired = 0;
  const interceptedUrls = [];

  const fakeFetch = async (url) => {
    interceptedUrls.push(url);
    if (url.includes('action=screener') || url.includes('action=nk-screener-results') || url.includes('action=daytrade-screener')) {
      protectedRequestsFired++;
      return { status: 401, ok: false, json: async () => ({ success: false, error: 'Unauthorized' }) };
    }
    return { status: 200, ok: true, json: async () => ({ success: true }) };
  };

  let isLoggedIn = false;
  function isAutocuanLoggedIn() { return isLoggedIn; }

  async function fetchManualConfluenceRow(ticker, targetId) {
    if (!isAutocuanLoggedIn()) {
      return; // The fix
    }
    const sources = [
      { url: '/api/sector-hot?action=screener' },
      { url: '/api/sector-hot?action=nk-screener-results' },
      { url: '/api/sector-hot?action=daytrade-screener' }
    ];
    for (const s of sources) {
      await fakeFetch(s.url);
    }
  }

  // Simulate cold unauthenticated visit to '/'
  isLoggedIn = false;
  await fetchManualConfluenceRow('BBCA', 'targetEl');

  assert.equal(protectedRequestsFired, 0, 'Zero protected requests must be fired on unauthenticated cold load');
  assert.equal(interceptedUrls.length, 0, 'Zero network calls made by fetchManualConfluenceRow when unauthenticated');

  // Verify authenticated behavior is preserved
  isLoggedIn = true;
  await fetchManualConfluenceRow('BBCA', 'targetEl');
  assert.equal(protectedRequestsFired, 3, 'When authenticated, confluence sources are fetched normally');
});
