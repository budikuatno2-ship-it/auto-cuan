'use strict';

// ===========================================================================
// Regression tests for the startup ordering bug that made every logged-out
// visit sit on the loading spinner for ~4.5 seconds and then show a false
// "features temporarily unavailable" notice on a perfectly healthy site.
//
// Root cause
// ----------
// public/index.html is one long classic script. `var` hoists the binding but
// not the value, so the premium-access state was `undefined` for the whole
// stretch of script above its initialiser. Startup runs inside that stretch:
//
//   init()  ->  handleAppRoute()  ->  showLandingPage()
//           ->  setTopLevelView('landing')
//           ->  resetPremiumAccess()
//           ->  premiumAccessState.premium   <-- TypeError
//
// The throw took out the normal route, then the catch-block fallback, then the
// finally-block fallback, leaving no visible top-level view until the 4.5s
// watchdog fired renderStartupFallback() a fourth time — by which point the
// initialiser had finally run, so it succeeded and appended the degraded-mode
// notice that users then saw on a healthy site.
//
// Measured with Chromium (5 interleaved samples each, shared browser):
//   before  median 4822 ms to landing, 5/5 false notices, 5 uncaught errors
//   after   median  396 ms to landing, 0/5 false notices, 0 uncaught errors
//
// The invariant worth protecting is ORDERING: the state must be assigned above
// its first possible caller. These are static source assertions — no browser,
// no network, no backend — matching the rest of the suite.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const STATE_INIT = /var premiumAccessState\s*=\s*\{[^}]*state:\s*'loading'/;

test('premiumAccessState is initialised exactly once', () => {
  const matches = html.match(/var premiumAccessState\s*=/g) || [];
  assert.equal(
    matches.length,
    1,
    'a second initialiser further down the script would reset whatever startup already resolved'
  );
});

test('premiumAccessState is assigned before setTopLevelView, its first caller', () => {
  const init = html.search(STATE_INIT);
  const setter = html.indexOf('function setTopLevelView(');
  assert.ok(init > 0, 'premiumAccessState initialiser must exist');
  assert.ok(setter > 0, 'setTopLevelView must exist');
  assert.ok(
    init < setter,
    'setTopLevelView() calls resetPremiumAccess() on its first line; initialising the '
    + 'state after it leaves premiumAccessState undefined during init and throws'
  );
});

test('premiumAccessState is assigned before resetPremiumAccess reads it', () => {
  const init = html.search(STATE_INIT);
  const reader = html.indexOf('function resetPremiumAccess(');
  assert.ok(reader > 0, 'resetPremiumAccess must exist');
  assert.ok(init < reader, 'the reader must not be able to run before the value exists');
});

test('premiumAccessState is assigned before the startup entry points that reach it', () => {
  const init = html.search(STATE_INIT);
  for (const caller of ['function renderStartupFallback(', 'function handleAppRoute(']) {
    const at = html.indexOf(caller);
    assert.ok(at > 0, caller + ' must exist');
    assert.ok(init < at, caller + ' runs during startup and reaches premiumAccessState');
  }
});

test('the companion premium-access variables are initialised alongside the state', () => {
  // cancelPremiumAccessRequest() does `premiumAccessGeneration += 1`, which
  // silently becomes NaN — and so never matches a later generation check — if
  // the counter is still undefined when startup calls it.
  const init = html.search(STATE_INIT);
  for (const name of [
    'premiumAccessRequest',
    'premiumAccessController',
    'premiumAccessGeneration',
    'premiumAccessRefreshTimer'
  ]) {
    const at = html.indexOf('var ' + name + ' =');
    assert.ok(at > 0, name + ' must be initialised');
    assert.ok(
      Math.abs(at - init) < 600,
      name + ' must be initialised in the same block as premiumAccessState, above its first caller'
    );
  }
});

test('the 4.5s startup watchdog is still present as a last resort', () => {
  // The fix removes the need for the watchdog on the happy path; it must stay
  // as the safety net for genuinely broken startups.
  assert.match(
    html,
    /setTimeout\(function\(\)\s*\{\s*var loader=document\.getElementById\('initialLoader'\)[\s\S]{0,200}renderStartupFallback\(\);\s*\},\s*4500\)/,
    'the watchdog that rescues a genuinely failed startup must remain'
  );
});
