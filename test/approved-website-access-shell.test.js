'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('obsolete stacked runtime patches stay removed', () => {
  [
    'public/dashboard-loader.html',
    'public/dashboard-approved-access-guard.js',
    'public/dashboard-approved-enhancements.js',
    'public/admin-delete-user.js',
    'public/dashboard-responsive-fixes.css',
    'public/portfolio-ai-recovery.js',
    'public/portfolio-enhancements.js',
    'public/portfolio-enhancements.css',
    'public/portfolio-decision-center-v1.html',
    'lib/sector-hot-legacy.js',
    '.github/workflows/oneoff-startup-watchdog-hotfix.yml'
  ].forEach((file) => {
    assert.equal(fs.existsSync(path.join(ROOT, file)), false, file + ' must stay deleted');
  });
});

test('index.html gates website features on the approval endpoint, not entitlement', () => {
  const html = read('public/index.html');
  assert.match(html, /function isDeniedWebsiteAccess\(\)/);
  assert.match(html, /body:JSON\.stringify\(\{action:'portfolio_access'\}\)/);
  assert.doesNotMatch(html, /fetch\('\/api\/login-user\?action=premium-access-status'/);
  // Only a definitive server "no" locks navigation or bounces the page.
  assert.match(html, /isPremiumFeaturePage\(page\) && isDeniedWebsiteAccess\(\)/);
  assert.match(html, /isDeniedWebsiteAccess\(\) && isPremiumFeaturePage\(currentPage\)/);
  assert.doesNotMatch(html, /navigateTo\('subscription'\)/);
});

// website-approved-access.js was refactored into a thin bootstrap loader; the
// cookie-first session restore it used to own directly now lives in auth-v2.js
// (session-status) and the premium-UI restore lives in subscription-access-gate-v1.js
// (account-profile) — both loaded by the bootstrapper. The restore-only invariant
// (no nav override, no broad observer) must hold on the files that actually do it.
test('approved runtime is restore-only: no nav override, no broad observer', () => {
  const bootstrap = read('public/website-approved-access.js');
  const authRuntime = read('public/auth-v2.js');
  const subscriptionGate = read('public/subscription-access-gate-v1.js');
  [bootstrap, authRuntime, subscriptionGate].forEach((src) => {
    assert.doesNotMatch(src, /window\.navigateTo\s*=/);
    assert.doesNotMatch(src, /window\.hasConfirmedPremiumAccess\s*=/);
    assert.doesNotMatch(src, /new MutationObserver/);
  });
  assert.match(authRuntime, /authRequest\('session-status'\)/);
  assert.match(subscriptionGate, /action:'account-profile'/);
  assert.match(authRuntime, /credentials: 'same-origin'/);
  assert.match(subscriptionGate, /credentials: 'same-origin'/);
});

// The cookie-first session restore this used to test directly in
// website-approved-access.js now lives in auth-v2.js: it POSTs
// action:'session-status' to /api/reset-password, stores the session into
// localStorage, and calls window.enterApp() only on a definitive server "yes".
function makeAuthV2Sandbox(fetchImpl) {
  const storage = new Map();
  let enteredApp = null;
  let closedAuthChoiceModal = 0;
  let openedAuthChoiceModal = null;

  const sandbox = {
    window: {
      location: { pathname: '/dashboard', href: 'https://app.test/dashboard', search: '' },
      navigator: { userAgent: 'ua' },
      enterApp(opts) { enteredApp = opts; },
      closeAuthChoiceModal() { closedAuthChoiceModal += 1; },
      openAuthChoiceModal(msg) { openedAuthChoiceModal = msg; },
      updateDashGreeting() {},
      updateLandingCtas() {},
      showLandingPage() {}
    },
    document: {
      readyState: 'complete',
      getElementById() { return null; },
      addEventListener() {}
    },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key)
    },
    navigator: { userAgent: 'ua' },
    URLSearchParams,
    AbortController: typeof AbortController !== 'undefined' ? AbortController : undefined,
    setTimeout,
    clearTimeout,
    fetch: fetchImpl,
    Date,
    JSON,
    console,
    String
  };
  sandbox.window.localStorage = sandbox.localStorage;
  vm.createContext(sandbox);
  return { sandbox, storage, getEnteredApp: () => enteredApp, getClosedAuthChoiceModal: () => closedAuthChoiceModal, getOpenedAuthChoiceModal: () => openedAuthChoiceModal };
}

test('approved runtime restores a cookie-backed session into UI state', async () => {
  const runtime = read('public/auth-v2.js');
  const { sandbox, storage, getEnteredApp } = makeAuthV2Sandbox(async (url, opts) => {
    assert.equal(JSON.parse(opts.body).action, 'session-status');
    return { ok: true, json: async () => ({ success: true, userId: 'uid-123', username: 'Trader', isAdmin: false }) };
  });

  vm.runInContext(runtime, sandbox);
  const status = await sandbox.window.autocuanAuthReady;

  assert.equal(status.valid, true, 'window.autocuanAuthReady must resolve with the real session-status result');
  assert.equal(storage.get('autocuan_user_id'), 'uid-123');
  assert.equal(storage.get('autocuan_user'), 'trader');
  assert.equal(storage.get('autocuan_logged_in'), 'true');
  assert.equal(sandbox.window.__AUTOCUAN_AUTHENTICATED_SESSION__.userId, 'uid-123');
  assert.equal(getEnteredApp() && getEnteredApp().replaceHistory, true);
});

test('a failed or anonymous status check never grants or fakes access', async () => {
  const runtime = read('public/auth-v2.js');
  const { sandbox, storage, getEnteredApp, getOpenedAuthChoiceModal } = makeAuthV2Sandbox(async () => ({
    ok: false, status: 401, json: async () => ({ success: false })
  }));

  vm.runInContext(runtime, sandbox);
  const status = await sandbox.window.autocuanAuthReady;

  assert.equal(status.valid, false, 'a 401 must never be reported as a valid session');
  assert.equal(storage.has('autocuan_logged_in'), false, 'no login flag from a rejected check');
  assert.equal(getEnteredApp(), null, 'no forced app entry without server approval');
  assert.equal(sandbox.window.__AUTOCUAN_AUTHENTICATED_SESSION__, null, 'no fake authenticated session');
  assert.ok(getOpenedAuthChoiceModal(), 'a rejected session on /dashboard must re-open the auth choice modal');
});

// Regression test for a dead-code bug: window.autocuanAuthReady used to be
// silently undefined (the `new Promise(...)` assignment was dropped from a
// refactor while the authReadyResolve(status) call that resolves it stayed
// behind), which threw an unhandled rejection on every page load and made
// every consumer (subscription-access-gate-v1.js, subscription-manual-payment-v1.js,
// index.html) silently skip waiting for session validation and fire immediately.
test('window.autocuanAuthReady is a real promise that resolves after session validation, never throws', async () => {
  const runtime = read('public/auth-v2.js');
  const { sandbox } = makeAuthV2Sandbox(async () => ({ ok: true, json: async () => ({ success: true, userId: 'u1', username: 'trader' }) }));
  vm.runInContext(runtime, sandbox);
  assert.ok(sandbox.window.autocuanAuthReady, 'window.autocuanAuthReady must be assigned');
  assert.equal(typeof sandbox.window.autocuanAuthReady.then, 'function', 'must be a real promise consumers can await');
  const result = await sandbox.window.autocuanAuthReady;
  assert.equal(result.valid, true);
});

// Website access is now premium-entitlement based (lib/entitlements.js), with
// approval remaining a separate, still-enforced prerequisite — not an
// 'approved' access_level as before. See the "never from approval state alone"
// contract comment directly above requirePremiumEntitlement() in subscription-auth.js.
test('website data APIs use approval-based server access', () => {
  const auth = read('lib/subscription-auth.js');
  const sectorHot = read('api/sector-hot.js');
  const adminUsers = read('api/admin-users.js');

  assert.match(auth, /access\.account\.is_approved !== true/);
  assert.match(auth, /never from approval state alone/);
  assert.match(sectorHot, /requirePremiumEntitlement\(req, supabase\)/);
  assert.match(adminUsers, /action === 'portfolio_access'/);
  assert.match(adminUsers, /account\.is_approved !== true/);
  assert.match(adminUsers, /account\.is_blocked === true/);
});
