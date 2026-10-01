'use strict';

// ===========================================================================
// Maintenance gating.
//
// The reported defect: with maintenance active the maintenance screen appeared,
// but the public landing / login / register flow became reachable again after a
// reload. Three separate paths produced that, all of the same shape — the gate
// was applied ONCE, after the shell had already been routed, so anything that
// selected a view afterwards simply replaced it:
//
//   1. auth-v2.js validates the session on DOMContentLoaded. Anonymous users get
//      a 401, returnToGuest() runs, and it calls showLandingPage(). Deterministic
//      on every anonymous reload, not a race.
//   2. Back/forward -> popstate -> handleAppRoute() -> showLandingPage().
//   3. isAdmin() was `getUsername() === 'budi' && localStorage.autocuan_is_admin
//      === 'true'` — two client-writable values — so two localStorage keys
//      skipped the gate outright.
//
// The fix evaluates the gate inside setTopLevelView(), the single function every
// transition already funnels through, and sources admin status only from the
// server's session-status answer.
//
// These tests execute the real gate functions lifted from public/index.html
// against a stub DOM, rather than asserting on source text, so they fail if the
// behaviour regresses even when the wording survives.
//
// LOCAL / STATIC ONLY. No network, no Supabase, no credentials.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const SCREEN_IDS = ['initialLoader', 'blockedScreen', 'maintenanceScreen', 'serviceStatusScreen', 'landingPage', 'dashboardScreen'];

// Lift a named function's source out of index.html by brace matching.
function extract(name) {
  let start = html.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'function ' + name + ' not found in public/index.html');
  // Keep an `async` prefix, or the extracted body's `await` is a syntax error.
  const preceding = html.slice(Math.max(0, start - 6), start);
  if (preceding === 'async ') start -= 6;
  let depth = 0;
  let i = html.indexOf('{', start);
  const open = i;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  assert.fail('unbalanced braces while extracting ' + name);
  return open;
}

// A stub DOM carrying only what setTopLevelView touches.
function makeContext(options) {
  const opts = options || {};
  const elements = {};
  SCREEN_IDS.forEach(id => {
    elements[id] = {
      id,
      _hidden: true,
      attrs: {},
      inert: true,
      classList: {
        toggle(cls, force) { if (cls === 'hidden') elements[id]._hidden = force; },
        add(cls) { if (cls === 'hidden') elements[id]._hidden = true; },
        contains(cls) { return cls === 'hidden' ? elements[id]._hidden : false; }
      },
      setAttribute(k, v) { elements[id].attrs[k] = v; }
    };
  });

  const sandbox = {
    document: { getElementById: id => elements[id] || null },
    window: { __AUTOCUAN_AUTHENTICATED_SESSION__: opts.session || null },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: id => clearTimeout(id),
    AbortController: global.AbortController,
    fetch: opts.fetch || (() => Promise.reject(new Error('no fetch stub'))),
    maintenanceConfig: { maintenanceMode: false, message: '' },
    MAINTENANCE_UNKNOWN: 'unknown',
    MAINTENANCE_ON: 'on',
    MAINTENANCE_OFF: 'off',
    maintenanceStatus: opts.status || 'unknown',
    // setTopLevelView calls these; they are irrelevant to gating.
    loadPremiumAccess() {},
    resetPremiumAccess() {},
    localStorage: {
      store: opts.localStorage || {},
      getItem(k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null; },
      setItem(k, v) { this.store[k] = String(v); }
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    extract('isServerVerifiedAdmin') + '\n' +
    extract('maintenanceLockActive') + '\n' +
    extract('serviceStatusUnverified') + '\n' +
    extract('checkMaintenanceStatus') + '\n' +
    extract('setTopLevelView') + '\n',
    sandbox
  );
  sandbox.visibleScreen = () => SCREEN_IDS.filter(id => !elements[id]._hidden).join(',') || 'none';
  sandbox.elements = elements;
  return sandbox;
}

const ON = 'on';
const OFF = 'off';
const UNKNOWN = 'unknown';
const ADMIN_SESSION = { userId: '42', username: 'budi', isAdmin: true };
const USER_SESSION = { userId: '7', username: 'siti', isAdmin: false };

// Response shapes the endpoint can produce.
const okResponse = mode => () => Promise.resolve({
  ok: true, json: () => Promise.resolve({ success: true, config: { maintenanceMode: mode, message: 'pesan' } })
});
const serverError = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ success: false }) });
const unparseable = () => Promise.resolve({ ok: true, json: () => Promise.reject(new SyntaxError('not json')) });
const successFalse = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: false, error: 'table missing' }) });
const networkDown = () => Promise.reject(new TypeError('Failed to fetch'));
const neverResolves = (url, init) => new Promise((_, reject) => {
  // Mirrors a real abort: reject when the caller's AbortController fires.
  if (init && init.signal) init.signal.addEventListener('abort', () => reject(new Error('AbortError')));
});

// ---------------------------------------------------------------------------
// Public users cannot leave maintenance
// ---------------------------------------------------------------------------

test('every non-maintenance view is forced back to maintenance while locked', () => {
  const ctx = makeContext({ status: ON });
  ['landing', 'app', 'loading', 'blocked'].forEach(state => {
    vm.runInContext('setTopLevelView(' + JSON.stringify(state) + ')', ctx);
    assert.equal(ctx.visibleScreen(), 'maintenanceScreen', 'requested view: ' + state);
  });
});

test('the landing page cannot be restored by the anonymous session-restore path', () => {
  // Reproduces auth-v2 returnToGuest() -> showLandingPage() after the gate.
  const ctx = makeContext({ status: ON });
  vm.runInContext('setTopLevelView("maintenance")', ctx);
  assert.equal(ctx.visibleScreen(), 'maintenanceScreen');
  vm.runInContext('setTopLevelView("landing")', ctx);
  assert.equal(ctx.visibleScreen(), 'maintenanceScreen');
});

test('a hidden screen is also inert and aria-hidden, so it cannot be tabbed into', () => {
  const ctx = makeContext({ status: ON });
  vm.runInContext('setTopLevelView("landing")', ctx);
  assert.equal(ctx.elements.landingPage.inert, true);
  assert.equal(ctx.elements.landingPage.attrs['aria-hidden'], 'true');
  assert.equal(ctx.elements.maintenanceScreen.inert, false);
  assert.equal(ctx.elements.maintenanceScreen.attrs['aria-hidden'], 'false');
});

// ---------------------------------------------------------------------------
// UNKNOWN must not be treated as OFF
// ---------------------------------------------------------------------------
// The status began life as a boolean defaulting to false, which conflated
// "confirmed not in maintenance" with "we could not find out". A timeout or a
// 5xx therefore rendered the normal public site — precisely the situation where
// maintenance may in fact be active.

test('an unresolved status withholds landing, app and every other public view', () => {
  const ctx = makeContext({ status: UNKNOWN });
  ['landing', 'app', 'blocked'].forEach(state => {
    vm.runInContext('setTopLevelView(' + JSON.stringify(state) + ')', ctx);
    assert.equal(ctx.visibleScreen(), 'serviceStatusScreen', 'requested view: ' + state);
  });
});

test('an unresolved status leaves the startup loader alone', () => {
  // 'loading' is exempt, or the status screen would replace the spinner before
  // the very first check has had a chance to answer.
  const ctx = makeContext({ status: UNKNOWN });
  vm.runInContext('setTopLevelView("loading")', ctx);
  assert.equal(ctx.visibleScreen(), 'initialLoader');
});

test('the unresolved state is distinct from maintenance, not a synonym for it', () => {
  const unknown = makeContext({ status: UNKNOWN });
  vm.runInContext('setTopLevelView("landing")', unknown);
  assert.equal(unknown.visibleScreen(), 'serviceStatusScreen');
  assert.equal(vm.runInContext('maintenanceLockActive()', unknown), false,
    'unknown must not claim maintenance is active');

  const on = makeContext({ status: ON });
  vm.runInContext('setTopLevelView("landing")', on);
  assert.equal(on.visibleScreen(), 'maintenanceScreen');
  assert.equal(vm.runInContext('serviceStatusUnverified()', on), false);
});

test('an unresolved status still holds an authenticated non-admin', () => {
  const ctx = makeContext({ status: UNKNOWN, session: USER_SESSION });
  vm.runInContext('setTopLevelView("app")', ctx);
  assert.equal(ctx.visibleScreen(), 'serviceStatusScreen');
});

test('an unresolved status does not hold a server-verified admin', () => {
  // Holding them would lock administrators out during the exact incident they
  // need to sign in for. Their authorization is independent of this status.
  const ctx = makeContext({ status: UNKNOWN, session: ADMIN_SESSION });
  assert.equal(vm.runInContext('serviceStatusUnverified()', ctx), false);
  vm.runInContext('setTopLevelView("app")', ctx);
  assert.equal(ctx.visibleScreen(), 'dashboardScreen');
});

// ---------------------------------------------------------------------------
// checkMaintenanceStatus: only a confirmed answer may move the state
// ---------------------------------------------------------------------------

test('first load + status request timeout leaves the app inaccessible', async () => {
  const ctx = makeContext({ status: UNKNOWN, fetch: neverResolves });
  await vm.runInContext('checkMaintenanceStatus(50)', ctx);
  assert.equal(ctx.maintenanceStatus, UNKNOWN, 'a timeout must not confirm anything');
  vm.runInContext('setTopLevelView("landing")', ctx);
  assert.equal(ctx.visibleScreen(), 'serviceStatusScreen');
});

test('first load + status request 5xx leaves the app inaccessible', async () => {
  const ctx = makeContext({ status: UNKNOWN, fetch: serverError });
  await vm.runInContext('checkMaintenanceStatus(500)', ctx);
  assert.equal(ctx.maintenanceStatus, UNKNOWN);
  vm.runInContext('setTopLevelView("landing")', ctx);
  assert.equal(ctx.visibleScreen(), 'serviceStatusScreen');
});

test('other unusable answers also leave the app inaccessible', async () => {
  for (const [label, stub] of [['network down', networkDown], ['unparseable body', unparseable], ['success:false', successFalse]]) {
    const ctx = makeContext({ status: UNKNOWN, fetch: stub });
    await vm.runInContext('checkMaintenanceStatus(500)', ctx);
    assert.equal(ctx.maintenanceStatus, UNKNOWN, label);
    vm.runInContext('setTopLevelView("landing")', ctx);
    assert.equal(ctx.visibleScreen(), 'serviceStatusScreen', label);
  }
});

test('first load + confirmed maintenance OFF lets the app work normally', async () => {
  const ctx = makeContext({ status: UNKNOWN, fetch: okResponse(false) });
  await vm.runInContext('checkMaintenanceStatus(500)', ctx);
  assert.equal(ctx.maintenanceStatus, OFF);
  vm.runInContext('setTopLevelView("landing")', ctx);
  assert.equal(ctx.visibleScreen(), 'landingPage');
  vm.runInContext('setTopLevelView("app")', ctx);
  assert.equal(ctx.visibleScreen(), 'dashboardScreen');
});

test('a confirmed maintenance gate survives every later status failure', async () => {
  for (const [label, stub] of [['timeout', neverResolves], ['5xx', serverError],
                               ['network down', networkDown], ['unparseable', unparseable],
                               ['success:false', successFalse]]) {
    const ctx = makeContext({ status: UNKNOWN, fetch: okResponse(true) });
    await vm.runInContext('checkMaintenanceStatus(500)', ctx);
    assert.equal(ctx.maintenanceStatus, ON, 'precondition: confirmed on');

    ctx.fetch = stub;
    await vm.runInContext('checkMaintenanceStatus(50)', ctx);
    assert.equal(ctx.maintenanceStatus, ON, 'a ' + label + ' must not lift a confirmed gate');
    vm.runInContext('setTopLevelView("landing")', ctx);
    assert.equal(ctx.visibleScreen(), 'maintenanceScreen', label);
  }
});

test('a confirmed OFF is not turned into a lockout by a later failure', async () => {
  const ctx = makeContext({ status: UNKNOWN, fetch: okResponse(false) });
  await vm.runInContext('checkMaintenanceStatus(500)', ctx);
  assert.equal(ctx.maintenanceStatus, OFF);
  ctx.fetch = serverError;
  await vm.runInContext('checkMaintenanceStatus(500)', ctx);
  assert.equal(ctx.maintenanceStatus, OFF, 'a transient error must not invent a lockout');
  vm.runInContext('setTopLevelView("landing")', ctx);
  assert.equal(ctx.visibleScreen(), 'landingPage');
});

test('retry from UNKNOWN can settle to either confirmed state', async () => {
  const toOn = makeContext({ status: UNKNOWN, fetch: serverError });
  await vm.runInContext('checkMaintenanceStatus(200)', toOn);
  assert.equal(toOn.maintenanceStatus, UNKNOWN);
  toOn.fetch = okResponse(true);
  await vm.runInContext('checkMaintenanceStatus(500)', toOn);
  assert.equal(toOn.maintenanceStatus, ON);
  vm.runInContext('setTopLevelView("landing")', toOn);
  assert.equal(toOn.visibleScreen(), 'maintenanceScreen');

  const toOff = makeContext({ status: UNKNOWN, fetch: serverError });
  await vm.runInContext('checkMaintenanceStatus(200)', toOff);
  assert.equal(toOff.maintenanceStatus, UNKNOWN);
  toOff.fetch = okResponse(false);
  await vm.runInContext('checkMaintenanceStatus(500)', toOff);
  assert.equal(toOff.maintenanceStatus, OFF);
  vm.runInContext('setTopLevelView("landing")', toOff);
  assert.equal(toOff.visibleScreen(), 'landingPage');
});

// ---------------------------------------------------------------------------
// Admin status is never taken from the client
// ---------------------------------------------------------------------------

test('localStorage cannot grant a maintenance bypass', () => {
  const ctx = makeContext({
    status: ON,
    localStorage: { autocuan_user: 'budi', autocuan_is_admin: 'true', autocuan_logged_in: 'true' }
  });
  assert.equal(vm.runInContext('maintenanceLockActive()', ctx), true);
  vm.runInContext('setTopLevelView("app")', ctx);
  assert.equal(ctx.visibleScreen(), 'maintenanceScreen');
});

test('an authenticated non-admin cannot bypass maintenance', () => {
  const ctx = makeContext({ status: ON, session: USER_SESSION });
  assert.equal(vm.runInContext('maintenanceLockActive()', ctx), true);
  vm.runInContext('setTopLevelView("app")', ctx);
  assert.equal(ctx.visibleScreen(), 'maintenanceScreen');
});

test('a forged session object without isAdmin===true is rejected', () => {
  [
    { userId: '1', isAdmin: 'true' },   // string, not boolean
    { userId: '1', isAdmin: 1 },        // truthy, not boolean
    { isAdmin: true },                  // no userId
    { userId: '', isAdmin: true },      // empty userId
    {}
  ].forEach(session => {
    const ctx = makeContext({ status: ON, session });
    assert.equal(vm.runInContext('isServerVerifiedAdmin()', ctx), false, JSON.stringify(session));
    vm.runInContext('setTopLevelView("app")', ctx);
    assert.equal(ctx.visibleScreen(), 'maintenanceScreen', JSON.stringify(session));
  });
});

test('a server-verified admin passes the gate', () => {
  const ctx = makeContext({ status: ON, session: ADMIN_SESSION });
  assert.equal(vm.runInContext('maintenanceLockActive()', ctx), false);
  vm.runInContext('setTopLevelView("app")', ctx);
  assert.equal(ctx.visibleScreen(), 'dashboardScreen');
});

test('clearing the verified session re-locks immediately, which is what logout does', () => {
  const ctx = makeContext({ status: ON, session: ADMIN_SESSION });
  vm.runInContext('setTopLevelView("app")', ctx);
  assert.equal(ctx.visibleScreen(), 'dashboardScreen');
  vm.runInContext('window.__AUTOCUAN_AUTHENTICATED_SESSION__ = null; setTopLevelView("landing")', ctx);
  assert.equal(ctx.visibleScreen(), 'maintenanceScreen');
});

// ---------------------------------------------------------------------------
// Maintenance off must behave exactly as before
// ---------------------------------------------------------------------------

test('with maintenance off every view is selected normally', () => {
  const ctx = makeContext({ status: OFF });
  const expected = { loading: 'initialLoader', blocked: 'blockedScreen', landing: 'landingPage', app: 'dashboardScreen' };
  Object.keys(expected).forEach(state => {
    vm.runInContext('setTopLevelView(' + JSON.stringify(state) + ')', ctx);
    assert.equal(ctx.visibleScreen(), expected[state]);
  });
});

test('before any check has run the app is withheld, not exposed', () => {
  // This previously asserted the opposite — that an unset config never locks —
  // which was the fail-open policy this change exists to remove. The starting
  // state is UNKNOWN, and UNKNOWN withholds.
  const ctx = makeContext({});
  assert.equal(ctx.maintenanceStatus, UNKNOWN, 'the initial state must be unknown');
  assert.equal(vm.runInContext('maintenanceLockActive()', ctx), false, 'unknown is not a maintenance claim');
  assert.equal(vm.runInContext('serviceStatusUnverified()', ctx), true);
  vm.runInContext('setTopLevelView("landing")', ctx);
  assert.equal(ctx.visibleScreen(), 'serviceStatusScreen');
});

// ---------------------------------------------------------------------------
// Wiring that the behavioural tests above cannot observe
// ---------------------------------------------------------------------------

test('startup resolves maintenance before any routing decision', () => {
  const initAt = html.indexOf('(async function init() {');
  assert.notEqual(initAt, -1);
  const checkAt = html.indexOf('await checkMaintenanceStatus(', initAt);
  const shareAt = html.indexOf("_shareParams.get('share')", initAt);
  const reviewAt = html.indexOf('isValidReviewMode()', initAt);
  const routeAt = html.indexOf('handleAppRoute({ duringInit: true })', initAt);
  assert.ok(checkAt > initAt, 'init must await the maintenance check');
  assert.ok(checkAt < shareAt, 'share-mode entry must not precede the maintenance check');
  assert.ok(checkAt < reviewAt, 'review-mode entry must not precede the maintenance check');
  assert.ok(checkAt < routeAt, 'routing must not precede the maintenance check');
});

test('share and review query-string entry points are gated', () => {
  assert.match(html, /!_maintenanceLocked && _shareParams\.get\('share'\)/);
  assert.match(html, /!_maintenanceLocked && _shareParams\.get\('s'\)/);
  assert.match(html, /!_maintenanceLocked && isValidReviewMode\(\)/);
});

test('the maintenance check is bounded so a hung endpoint cannot strand startup', () => {
  const fn = extract('checkMaintenanceStatus');
  assert.match(fn, /AbortController/);
  assert.match(fn, /signal:/);
  // A failed or aborted check must not clear a known-active gate.
  assert.doesNotMatch(fn, /maintenanceMode:\s*false/);
});

test('logout drops the server-verified session', () => {
  const fn = extract('logout');
  assert.match(fn, /__AUTOCUAN_AUTHENTICATED_SESSION__\s*=\s*null/);
});

// Regression: init() runs while the body is still parsing, but auth-v2.js is
// fetched by website-approved-access.js from a <script src> near the end of the
// document. A plain `if (window.autocuanAuthReady)` test is therefore false at
// that moment, the re-check never registers, and a server-verified admin is
// stranded on the maintenance screen after every reload until they interact.
// Caught end-to-end against a local stub API, not by the unit tests above.
test('the post-auth re-check waits for autocuanAuthReady instead of reading it once', () => {
  const initAt = html.indexOf('(async function init() {');
  const initEnd = html.indexOf('setTimeout(clearStuckDashboardLoadingPlaceholders', initAt);
  const body = html.slice(initAt, initEnd > initAt ? initEnd : initAt + 20000);

  assert.ok(body.indexOf('autocuanAuthReady') > -1, 'init must hook the auth-ready promise');
  // It must poll for the promise, not assume it already exists.
  assert.match(body, /function attempt\(\)/, 'expected a retry loop for a late-loading auth-v2');
  assert.match(body, /setTimeout\(attempt/, 'the retry must be scheduled, not a single read');
  // And the wait must be bounded so a missing auth-v2 cannot hang the re-check.
  assert.match(body, /attempts\s*>\s*\d+/, 'the wait must have a ceiling');
  // Whichever way it settles, a non-admin must end up gated.
  assert.match(body, /isServerVerifiedAdmin\(\)[\s\S]{0,120}applyMaintenanceGate\(\)/,
    'settling must re-assert the gate for anyone who is not a verified admin');
});

test('registration and the auth-choice prompt are unavailable while locked', () => {
  assert.match(extract('openRegisterModal'), /maintenanceLockActive\(\)/);
  assert.match(extract('openAuthChoiceModal'), /maintenanceLockActive\(\)/);
});

test('the gate never consults client-writable storage', () => {
  const gate = extract('isServerVerifiedAdmin') + extract('maintenanceLockActive');
  assert.doesNotMatch(gate, /localStorage/);
  assert.doesNotMatch(gate, /sessionStorage/);
  assert.doesNotMatch(gate, /location\.search/);
  assert.doesNotMatch(gate, /URLSearchParams/);
  assert.doesNotMatch(gate, /document\.cookie/);
  // isAdmin() is the old localStorage-based helper; the gate must not use it.
  assert.doesNotMatch(gate, /\bisAdmin\(\)/);
});

test('the admin entry point is a Telegram approval request, not a login form', () => {
  const fn = extract('startAdminTelegramAccess');
  assert.match(fn, /admin-access-request/);
  // No username/password modal is opened from this control anymore.
  assert.doesNotMatch(fn, /openLoginModal\(\)/);
  // No privileged flag is written client-side; approval status only ever
  // comes back through session-status via validateAutocuanSession().
  assert.doesNotMatch(fn, /isAdmin\s*=\s*(true|1)|setItem\(['"]autocuan_is_admin/i);
});

test('a successful admin-access poll re-validates the server session before entering the app', () => {
  const fn = extract('pollAdminAccess');
  assert.match(fn, /validateAutocuanSession/);
  assert.match(fn, /isServerVerifiedAdmin\(\)/);
});
