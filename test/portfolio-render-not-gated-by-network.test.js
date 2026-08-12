'use strict';

// ===========================================================================
// Regression test for the portfolio's stuck "Memuat…" state.
//
// Reported from a real production screenshot: the Portfolio Command Center sat
// with POSTUR PORTOFOLIO showing "Memuat…" and every KPI reading 0 / Rp 0.
//
// Root cause
// ----------
// checkAccess() revealed the app shell and only afterwards awaited a network
// call that had no timeout:
//
//   hide('accessGate'); show('app'); bind();
//   await loadSectorHot();     <-- bare fetch, no AbortController
//   calculateBudget();
//   renderAll();               <-- never reached while that fetch was pending
//
// /api/sector-hot is a large serverless function; a slow or hanging response
// left the shell visible showing nothing but the static HTML defaults from
// portfolio-command-center.html — "Memuat…" under the posture card and Rp 0 in
// every metric. Those defaults are indistinguishable from a real, empty,
// fully-loaded portfolio, so the page silently lied about the user's positions.
//
// Reproduced in Chromium by holding /api/sector-hot open for 60s:
//   before   posture "Memuat…",        app visible   <-- stuck
//   after    posture "Perlu perhatian", app visible
//
// Two independent guarantees now:
//   1. the portfolio renders from already-loaded local state BEFORE any network
//      call, because nothing in that render needs the network
//   2. loadSectorHot is time-boxed like every other fetch on the page
//
// LOCAL / STATIC ONLY.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(ROOT, 'public', 'portfolio-command-center.js'), 'utf8');
const markup = fs.readFileSync(path.join(ROOT, 'public', 'portfolio-command-center.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'portfolio-command-center.css'), 'utf8');

// Comments are stripped before any index comparison. The source documents this
// very ordering in prose, and `indexOf('loadSectorHot()')` would otherwise find
// the explanatory comment rather than the call.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

function extract(signature) {
  const start = js.indexOf(signature);
  assert.ok(start > 0, signature + ' must exist');
  let depth = 0;
  for (let i = js.indexOf('{', start); i < js.length; i++) {
    if (js[i] === '{') depth += 1;
    else if (js[i] === '}') {
      depth -= 1;
      if (depth === 0) return js.slice(start, i + 1);
    }
  }
  throw new Error('could not delimit ' + signature);
}

const checkAccess = stripComments(extract('async function checkAccess('));

// ---------------------------------------------------------------------------
// The render must not wait on the network
// ---------------------------------------------------------------------------

test('the portfolio renders before any network call follows the reveal', () => {
  const reveal = checkAccess.indexOf("show('app')");
  const render = checkAccess.indexOf('renderAll()');
  const sector = checkAccess.indexOf('loadSectorHot()');
  assert.ok(reveal > 0 && render > 0 && sector > 0, 'all three steps must be present');
  assert.ok(
    render < sector,
    'renderAll() must run before loadSectorHot(); reversing them is what left the '
    + 'shell visible showing "Memuat…" and Rp 0 for as long as that fetch hung'
  );
});

test('loadSectorHot is not awaited on the reveal path', () => {
  assert.doesNotMatch(
    checkAccess,
    /await\s+loadSectorHot\(\)/,
    'sector context is supporting information, not a precondition for the portfolio'
  );
  assert.match(checkAccess, /\n\s*loadSectorHot\(\);/, 'it must still be started');
});

test('everything the first render needs is already local', () => {
  // loadLocalState() reads localStorage only; calculateBudget() and renderAll()
  // work off state.plans / state.prices. If a fetch crept into that path the
  // stuck state could return by another route.
  const reveal = checkAccess.indexOf("show('app')");
  const render = checkAccess.indexOf('renderAll()');
  const between = checkAccess.slice(reveal, render);
  assert.doesNotMatch(between, /await\s/, 'nothing between reveal and render may await');
  assert.ok(checkAccess.indexOf('loadLocalState()') < reveal, 'local state is loaded first');
});

// ---------------------------------------------------------------------------
// Every fetch on this page is time-boxed
// ---------------------------------------------------------------------------

test('loadSectorHot uses the timeout helper', () => {
  const fn = stripComments(extract('async function loadSectorHot('));
  assert.match(fn, /fetchWithTimeout\('\/api\/sector-hot'/, 'a bare fetch here can hang indefinitely');
  assert.doesNotMatch(fn, /await fetch\(/, 'no untimed fetch may remain');
});

test('no bare fetch survives anywhere on this page', () => {
  // fetchWithTimeout is the only sanctioned caller.
  const bare = stripComments(js).match(/\bawait fetch\(/g) || [];
  assert.equal(bare.length, 0, 'found an untimed fetch: every network call needs an AbortController');
});

test('the timeout helper actually aborts', () => {
  const fn = extract('function fetchWithTimeout(');
  assert.match(fn, /AbortController/);
  assert.match(fn, /controller\.abort\(\)/);
  assert.match(fn, /clearTimeout/, 'the timer must be cleared so it cannot leak');
});

// ---------------------------------------------------------------------------
// Loading, empty and zero must stay distinguishable
// ---------------------------------------------------------------------------

test('the markup default is a loading state, not a plausible value', () => {
  assert.match(markup, /id="postureLabel">Memuat/, 'the pre-render default states that it is loading');
});

test('an empty portfolio is marked as such, not left looking like data', () => {
  assert.match(js, /function renderEmptyPortfolioState\(/, 'the empty case must be explicit');
  assert.match(js, /renderEmptyPortfolioState\(summary\.planCount === 0\)/, 'driven by the real count');
  assert.match(js, /portfolio-empty/, 'the shell is marked so the stylesheet can demote the figures');
});

test('the empty state explains itself and offers the next action', () => {
  assert.match(js, /Portofolio masih kosong/);
  assert.match(js, /Buka Planner/, 'a way forward, not just a statement');
  assert.match(css, /\.portfolio-empty \.metric strong/, 'zero figures are demoted, not deleted');
});

test('a real zero is still rendered as zero', () => {
  // Demoting is a visual weight change only — the figure itself must remain,
  // because zero exposure on a real portfolio is a real reading.
  const rule = css.match(/\.portfolio-empty \.metric strong \{[^}]*\}/);
  assert.ok(rule, 'the demotion rule must exist');
    assert.doesNotMatch(rule[0], /display:\s*none/, 'the value must stay on screen');
  assert.doesNotMatch(rule[0], /visibility:\s*hidden/);
});
