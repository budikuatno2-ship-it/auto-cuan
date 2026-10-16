'use strict';

/**
 * FIX-25 (S11): setInterval lifecycle guard when switching tabs.
 *
 * Before this fix:
 *  - public/tab-keepalive-runtime.js only ran a `visibilitychange` handler that
 *    pruned the SWR store. Every page-level polling interval kept firing while
 *    the tab was hidden, so a backgrounded Auto-Cuan window kept hammering
 *    /api/sector-hot, /api/quote, screener polling etc. for no user benefit.
 *  - There was no registry, so nothing could pause or resume them, and no page
 *    could be told "you are no longer the visible page".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Boot tab-keepalive-runtime.js inside a tiny fake DOM so we can drive
 * visibility transitions the way a browser would.
 */
function bootRuntime() {
  const listeners = { document: {}, window: {} };
  const created = [];
  const cleared = [];
  const intervals = [];

  const doc = {
    readyState: 'complete',
    visibilityState: 'visible',
    head: { querySelector: () => null, appendChild: () => {} },
    addEventListener(type, fn) {
      (listeners.document[type] = listeners.document[type] || []).push(fn);
    },
    createElement: () => ({ setAttribute() {}, style: {} }),
    getElementById: () => null,
    querySelector: () => null
  };

  const win = {
    document: doc,
    location: { origin: 'http://localhost' },
    scrollY: 0,
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout: (h) => clearTimeout(h),
    setInterval(fn, ms) {
      const handle = { fn, ms, id: intervals.length, cleared: false };
      intervals.push(handle);
      created.push(handle);
      return handle;
    },
    clearInterval(handle) {
      if (handle) {
        handle.cleared = true;
        cleared.push(handle);
      }
    },
    requestAnimationFrame: (fn) => fn(),
    addEventListener(type, fn) {
      (listeners.window[type] = listeners.window[type] || []).push(fn);
    },
    fetch: () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') })
  };
  win.window = win;

  const sandbox = {
    window: win,
    document: doc,
    console,
    setTimeout: win.setTimeout,
    clearTimeout: win.clearTimeout,
    URL,
    Map,
    WeakSet,
    WeakMap,
    Promise,
    Date,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Math
  };
  sandbox.window.setInterval = win.setInterval.bind(win);
  sandbox.window.clearInterval = win.clearInterval.bind(win);

  const src = read('public/tab-keepalive-runtime.js');
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'tab-keepalive-runtime.js' });

  return {
    win,
    fn: win.AutoCuanKeepAlive,
    fireVisibility(state) {
      doc.visibilityState = state;
      (listeners.document.visibilitychange || []).forEach((fn) => fn());
    },
    created,
    cleared,
    intervals
  };
}

test('FIX-25: tab-keepalive-runtime exposes a timer registry + pause/resume API', () => {
  const boot = bootRuntime();
  const fn = boot.fn;

  assert.ok(fn, 'AutoCuanKeepAlive must still be exported');
  assert.equal(typeof fn.registerTimer, 'function', 'registerTimer must be exported');
  assert.equal(typeof fn.unregisterTimer, 'function', 'unregisterTimer must be exported');
  assert.equal(typeof fn.pauseBackgroundTimers, 'function', 'pauseBackgroundTimers must be exported');
  assert.equal(typeof fn.resumeBackgroundTimers, 'function', 'resumeBackgroundTimers must be exported');
  assert.equal(typeof fn.timersSnapshot, 'function', 'timersSnapshot must be exported for observability');
  assert.equal(typeof fn.setActivePage, 'function', 'setActivePage must be exported');

  const src = read('public/tab-keepalive-runtime.js');
  assert.match(src, /visibilitychange/, 'the runtime must still own the visibilitychange handler');
  assert.match(src, /document\.hidden/, 'the runtime must consult document.hidden / visibilityState');
  assert.match(src, /pauseBackgroundTimers/, 'the runtime must call pauseBackgroundTimers');
  assert.match(src, /resumeBackgroundTimers/, 'the runtime must call resumeBackgroundTimers');
});

test('FIX-25: hidden document pauses timers, visible document resumes them exactly once', () => {
  const boot = bootRuntime();
  const fn = boot.fn;

  let ticks = 0;
  const handle = boot.win.setInterval(() => { ticks++; }, 1000);

  fn.registerTimer('dashboard-monitor', handle, { page: 'dashboard', intervalMs: 1000 });

  let snap = fn.timersSnapshot();
  assert.equal(snap.total, 1, 'the registry must track the registered timer');
  assert.equal(snap.paused, false, 'a fresh timer starts unpaused');

  // Hide the tab -> every tracked timer is cleared exactly once.
  fn.pauseBackgroundTimers();
  snap = fn.timersSnapshot();
  assert.equal(snap.paused, true, 'pausing must flip the registry state');
  assert.equal(snap.pausedCount, 1, 'one timer must be reported as paused');
  assert.ok(boot.cleared.length >= 1, 'the underlying interval must actually be cleared');

  // Pausing twice must not double-clear (idempotent).
  const clearedAfterFirst = boot.cleared.length;
  fn.pauseBackgroundTimers();
  assert.equal(boot.cleared.length, clearedAfterFirst, 'pause must be idempotent');

  // Show the tab again -> the timer is re-armed with the same interval.
  const before = boot.created.length;
  fn.resumeBackgroundTimers();
  assert.ok(boot.created.length > before, 'resume must re-arm the cleared timer');
  snap = fn.timersSnapshot();
  assert.equal(snap.paused, false, 'resuming must clear the paused state');
  assert.equal(snap.pausedCount, 0, 'no timer may remain paused after resume');

  // Resuming twice must not create duplicate intervals.
  const afterFirstResume = boot.created.length;
  fn.resumeBackgroundTimers();
  assert.equal(boot.created.length, afterFirstResume, 'resume must be idempotent');
});

test('FIX-25: tab visibility actually drives pause/resume end to end', () => {
  const boot = bootRuntime();
  const fn = boot.fn;

  const handle = boot.win.setInterval(() => {}, 15000);
  fn.registerTimer('screener-poll', handle, { page: 'screener', intervalMs: 15000 });

  boot.fireVisibility('hidden');
  assert.equal(fn.timersSnapshot().paused, true, 'hiding the document must pause timers');
  assert.equal(fn.timersSnapshot().pausedCount, 1);

  boot.fireVisibility('visible');
  assert.equal(fn.timersSnapshot().paused, false, 'showing the document must resume timers');
  assert.equal(fn.timersSnapshot().pausedCount, 0);
});

test('FIX-25: registration is page-scoped and unregistering is honoured', () => {
  const boot = bootRuntime();
  const fn = boot.fn;

  const a = boot.win.setInterval(() => {}, 1000);
  const b = boot.win.setInterval(() => {}, 2000);
  fn.registerTimer('dash', a, { page: 'dashboard', intervalMs: 1000 });
  fn.registerTimer('sektor', b, { page: 'sektor', intervalMs: 2000 });

  fn.setActivePage('sektor');
  let snap = fn.timersSnapshot();
  assert.equal(snap.activePage, 'sektor', 'the active page must be tracked');
  assert.ok(Array.isArray(snap.entries), 'timersSnapshot must expose the entries');
  assert.equal(snap.entries.length, 2);

  // A timer registered on a non-active page is off-page, not deleted.
  const offPage = snap.entries.filter((e) => e.page && e.page !== 'sektor');
  assert.equal(offPage.length, 1, 'off-page timers must be reported honestly');

  // Unregistering removes it from the registry permanently.
  fn.unregisterTimer('dash');
  snap = fn.timersSnapshot();
  assert.equal(snap.total, 1, 'unregisterTimer must drop the entry');
  assert.equal(snap.entries[0].id, 'sektor');
});

test('FIX-25: index.html guards the page-level polling timers against hidden state', () => {
  const html = read('public/index.html');

  // The three page-level pollers identified in the audit must consult visibility.
  assert.match(html, /_screenerPollInterval/, 'screener poller must still exist');
  assert.match(html, /_nkPollInterval/, 'swing non-konglo poller must still exist');
  assert.match(html, /_dashboardMonitorRefreshTimer/, 'dashboard monitor refresh must still exist');

  assert.match(
    html,
    /document\.hidden|document\.visibilityState/,
    'index.html must consult document.hidden / visibilityState before doing background work'
  );
  assert.match(
    html,
    /AutoCuanKeepAlive/,
    'index.html must cooperate with the keep-alive runtime timer registry'
  );
  assert.match(
    html,
    /tab-keepalive-runtime\.js/,
    'the keep-alive runtime script must remain loaded'
  );
});
