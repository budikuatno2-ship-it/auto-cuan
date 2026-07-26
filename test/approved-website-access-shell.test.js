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

test('approved runtime is restore-only: no nav override, no broad observer', () => {
  const runtime = read('public/website-approved-access.js');
  assert.doesNotMatch(runtime, /window\.navigateTo\s*=/);
  assert.doesNotMatch(runtime, /window\.hasConfirmedPremiumAccess\s*=/);
  assert.doesNotMatch(runtime, /new MutationObserver/);
  assert.match(runtime, /action: 'portfolio_access'/);
  assert.match(runtime, /credentials: 'same-origin'/);
});

test('approved runtime restores a cookie-backed session into UI state', async () => {
  const runtime = read('public/website-approved-access.js');
  const storage = new Map();
  const removedSelectors = [];
  let enteredApp = null;
  let appliedUi = 0;

  const sandbox = {
    window: {
      location: { pathname: '/dashboard' },
      enterApp(opts) { enteredApp = opts; },
      applyPremiumAccessUi() { appliedUi += 1; },
      updateLandingCtas() {},
      closeAuthChoiceModal() {}
    },
    document: {
      readyState: 'complete',
      querySelectorAll(selector) { removedSelectors.push(selector); return []; },
      getElementById() { return null; },
      addEventListener() {}
    },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key)
    },
    fetch: async () => ({
      ok: true,
      json: async () => ({ success: true, user_id: 'uid-123', username: 'Trader' })
    }),
    Date,
    JSON,
    console
  };
  sandbox.window.localStorage = sandbox.localStorage;

  vm.createContext(sandbox);
  vm.runInContext(runtime, sandbox);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(storage.get('autocuan_user_id'), 'uid-123');
  assert.equal(storage.get('autocuan_user'), 'trader');
  assert.equal(storage.get('autocuan_logged_in'), 'true');
  assert.equal(sandbox.window.__AUTOCUAN_APPROVED_WEBSITE_ACCESS__.userId, 'uid-123');
  assert.equal(sandbox.window.__AUTOCUAN_APPROVED_WEBSITE_ACCESS__.username, 'Trader');
  assert.equal(sandbox.window.premiumAccessState.premium, true);
  assert.equal(sandbox.window.premiumAccessState.accessLevel, 'approved');
  assert.ok(appliedUi >= 1, 'native premium UI application runs');
  assert.equal(enteredApp && enteredApp.replaceHistory, true);
  assert.ok(removedSelectors.some((s) => s.includes('#page-subscription')));
});

test('a failed or anonymous status check never grants or fakes access', async () => {
  const runtime = read('public/website-approved-access.js');
  const storage = new Map();
  let enteredApp = false;

  const sandbox = {
    window: {
      location: { pathname: '/dashboard' },
      enterApp() { enteredApp = true; },
      applyPremiumAccessUi() {}
    },
    document: {
      readyState: 'complete',
      querySelectorAll() { return []; },
      getElementById() { return null; },
      addEventListener() {}
    },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key)
    },
    fetch: async () => ({ ok: false, status: 401, json: async () => ({ success: false }) }),
    Date,
    JSON,
    console
  };
  sandbox.window.localStorage = sandbox.localStorage;

  vm.createContext(sandbox);
  vm.runInContext(runtime, sandbox);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(storage.has('autocuan_logged_in'), false, 'no login flag from a rejected check');
  assert.equal(enteredApp, false, 'no forced app entry without server approval');
  assert.equal(sandbox.window.premiumAccessState, undefined, 'no fake premium state');
});

test('website data APIs use approval-based server access', () => {
  const auth = read('lib/subscription-auth.js');
  const sectorHot = read('api/sector-hot.js');
  const adminUsers = read('api/admin-users.js');

  assert.match(auth, /access\.account\.is_approved !== true/);
  assert.match(auth, /access_level:'approved'/);
  assert.match(sectorHot, /requirePremiumEntitlement\(req, supabase\)/);
  assert.match(adminUsers, /action === 'portfolio_access'/);
  assert.match(adminUsers, /account\.is_approved !== true/);
  assert.match(adminUsers, /account\.is_blocked === true/);
});
