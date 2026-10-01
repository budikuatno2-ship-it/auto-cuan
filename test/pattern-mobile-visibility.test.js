'use strict';

// ===========================================================================
// Regression tests for "Pattern does not appear properly on mobile".
//
// ROOT CAUSE
// The runtime-created #page-pattern used to be tagged data-premium-page="true".
// applyPremiumAccessUi() in index.html reacts to that attribute with
//     page.classList.add('hidden'); page.setAttribute('aria-hidden','true');
//     page.inert = true;
// whenever hasConfirmedPremiumAccess() is false — which includes the *loading*
// and *unavailable* states, not just a real denial. Those states are entered on
// every forced refresh, every focus/visibilitychange, every bfcache restore and
// on any request slower than the 6.5s abort timeout, i.e. constantly on a phone.
//
// Nothing ever cleared inert/aria-hidden again: show() and restorePatternPage()
// only removed the `hidden` class. So Pattern either vanished mid-session or
// rendered while being completely dead to touch.
//
// LOCAL / STATIC + MOCKED ONLY. No browser, network, Supabase, Telegram, admin
// session, secret, or backend behaviour is touched.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

const patternStable = read('public/pattern-stable-runtime.js');
const resumeGuard = require('../public/pattern-tab-resume-guard');

// Brace-matched extraction of a function declaration (same approach as siblings).
function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, 'function must exist: ' + signature);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces for ' + signature);
}

function element(className) {
  const classes = new Set(String(className || '').split(/\s+/).filter(Boolean));
  const attributes = Object.create(null);
  return {
    inert: false,
    classList: {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name),
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name); else classes.delete(name);
        return on;
      }
    },
    setAttribute(name, value) { attributes[name] = String(value); },
    getAttribute(name) { return name in attributes ? attributes[name] : null; },
    removeAttribute(name) { delete attributes[name]; },
    hasAttribute(name) { return name in attributes; }
  };
}

function loadSetPageVisible() {
  const sandbox = { Boolean, String, Object };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction(patternStable, 'function setPageVisible(') +
    '\nthis.setPageVisible = setPageVisible;', sandbox);
  return sandbox.setPageVisible;
}

// ---------------------------------------------------------------------------
// 1. The premium gate can no longer reach the Pattern page
// ---------------------------------------------------------------------------
test('the runtime Pattern page is never tagged as a premium page', () => {
  assert.doesNotMatch(patternStable, /setAttribute\(\s*'data-premium-page'/);
  // index.html's gate keys entirely off that attribute, so an untagged page is
  // structurally out of its reach.
  const html = read('public/index.html');
  assert.match(html, /querySelectorAll\('\[data-premium-page="true"\]'\)/);
  assert.match(html, /page\.inert=true/);
});

test('Pattern is not in the list of pages the approval gate can bounce', () => {
  const html = read('public/index.html');
  const guard = extractFunction(html, 'function isPremiumFeaturePage(');
  assert.doesNotMatch(guard, /pattern/);
});

test('approval-based website access is unchanged and still not subscription-gated', () => {
  const html = read('public/index.html');
  assert.match(html, /function isDeniedWebsiteAccess\(\)/);
  assert.match(html, /body:JSON\.stringify\(\{action:'portfolio_access'\}\)/);
  assert.doesNotMatch(html, /premium-access-status/);
});

// ---------------------------------------------------------------------------
// 2. Visibility now moves hidden + inert + aria-hidden together
// ---------------------------------------------------------------------------
test('showing the Pattern page clears hidden, inert, and aria-hidden together', () => {
  const setPageVisible = loadSetPageVisible();
  const page = element('page-content hidden');
  page.setAttribute('aria-hidden', 'true');
  page.inert = true;

  setPageVisible(page, true);

  assert.equal(page.classList.contains('hidden'), false);
  assert.equal(page.inert, false);
  assert.equal(page.getAttribute('aria-hidden'), null);
});

test('hiding the Pattern page sets all three, so it cannot be half-hidden', () => {
  const setPageVisible = loadSetPageVisible();
  const page = element('page-content');

  setPageVisible(page, false);

  assert.equal(page.classList.contains('hidden'), true);
  assert.equal(page.inert, true);
  assert.equal(page.getAttribute('aria-hidden'), 'true');
});

// This is the exact failure users saw: the page was visible but every button
// was dead because a stale `inert` from an earlier gate pass survived.
test('a page left inert by a cached older build is healed on the next show', () => {
  const setPageVisible = loadSetPageVisible();
  const page = element('page-content');
  page.inert = true;
  page.setAttribute('aria-hidden', 'true');

  setPageVisible(page, true);

  assert.equal(page.inert, false, 'Pattern must be interactive after being shown');
  assert.equal(page.hasAttribute('aria-hidden'), false);
});

test('setPageVisible falls back to the inert attribute on older engines', () => {
  const setPageVisible = loadSetPageVisible();
  const page = element('page-content');
  delete page.inert;

  setPageVisible(page, false);
  assert.equal(page.getAttribute('inert'), '');

  setPageVisible(page, true);
  assert.equal(page.hasAttribute('inert'), false);
});

test('setPageVisible tolerates a missing node', () => {
  const setPageVisible = loadSetPageVisible();
  assert.equal(setPageVisible(null, true), null);
});

// ---------------------------------------------------------------------------
// 3. The resume path (bfcache / visibilitychange) restores an interactive page
// ---------------------------------------------------------------------------
test('revealPatternPage clears every hiding mechanism', () => {
  const page = element('page-content hidden');
  page.inert = true;
  page.setAttribute('aria-hidden', 'true');

  assert.equal(resumeGuard.revealPatternPage(page), true);
  assert.equal(page.classList.contains('hidden'), false);
  assert.equal(page.inert, false);
  assert.equal(page.getAttribute('aria-hidden'), null);
  assert.equal(resumeGuard.revealPatternPage(null), false);
});

test('a mobile tab resume on /pattern restores an interactive Pattern page', () => {
  const page = element('page-content hidden');
  // Simulate the approval gate having inerted the page while the tab was in the
  // background, which is what a phone does on every app switch.
  page.inert = true;
  page.setAttribute('aria-hidden', 'true');
  const chart = element('page-content');
  const navButton = element('nav-btn');
  navButton.setAttribute('data-page', 'pattern');
  const otherNav = element('nav-btn active');
  otherNav.setAttribute('data-page', 'chart');

  const root = {
    location: { pathname: '/pattern' },
    PatternMapAdminAccess: { isAllowed: () => true },
    document: {
      getElementById: id => (id === 'page-pattern' ? page : null),
      querySelectorAll(selector) {
        if (selector === '.page-content') return [page, chart];
        if (selector === '.nav-btn[data-page]') return [navButton, otherNav];
        return [];
      }
    }
  };

  assert.equal(resumeGuard.restorePatternPage(root), true);
  assert.equal(page.classList.contains('hidden'), false);
  assert.equal(page.inert, false, 'a resumed Pattern page must accept taps');
  assert.equal(chart.classList.contains('hidden'), true);
  assert.equal(navButton.classList.contains('active'), true);
  assert.equal(otherNav.classList.contains('active'), false);
});

test('resume still refuses to reveal Pattern without a live admin grant', () => {
  const page = element('page-content hidden');
  const root = {
    location: { pathname: '/pattern' },
    PatternMapAdminAccess: { isAllowed: () => false },
    document: { getElementById: () => page, querySelectorAll: () => [] }
  };

  assert.equal(resumeGuard.restorePatternPage(root), false);
  assert.equal(page.classList.contains('hidden'), true, 'access control must not weaken');
});

// ---------------------------------------------------------------------------
// 4. Access control and protected boundaries are untouched
// ---------------------------------------------------------------------------
test('the signed admin gate around Pattern is still enforced end to end', () => {
  assert.match(patternStable, /PatternMapAdminAccess\.refresh/);
  assert.match(patternStable, /PatternMapAdminAccess\.isAllowed\(\) === true/);
  // Revocation still hides the page and removes its nav entry.
  assert.match(patternStable, /if \(state\.allowed\) ensureNav\(\); else \{ removeNav\(\); hide\(\); \}/);
  assert.match(patternStable, /root\.navigateTo\('chart'\)/);
  assert.doesNotMatch(patternStable, /sendTelegram|telegramNotifier|supabase|createOrder/i);
});
