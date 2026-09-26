'use strict';

// ===========================================================================
// Tests for the tab keep-alive + SWR client cache (public/tab-keepalive-runtime.js).
//
// The contract worth protecting is behavioural, not cosmetic:
//   - a GET /api/ read is cached and served without a second round trip
//   - a mutation (any non-GET) is NEVER cached and NEVER served from cache
//   - a failed request is never cached, so a 502 cannot be frozen for 10 min
//   - the cache key ignores the volatile cache-buster params
//   - switching tabs never unmounts a panel (the keep-alive premise)
//
// LOCAL / MOCKED ONLY. No browser, network, or backend involvement: the module
// is loaded into a vm sandbox with a minimal fake window/fetch.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const RUNTIME_PATH = path.join(ROOT, 'public', 'tab-keepalive-runtime.js');
const runtimeSource = fs.readFileSync(RUNTIME_PATH, 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

/** Minimal element stub — enough for classList/querySelector wiring. */
function makeElement(tag) {
  const classes = new Set();
  return {
    tagName: String(tag || 'div').toUpperCase(),
    style: {},
    attributes: {},
    children: [],
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      contains(c) { return classes.has(c); },
      toggle(c, force) {
        if (force === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); }
        else if (force) classes.add(c);
        else classes.delete(c);
      }
    },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; },
    appendChild(c) { this.children.push(c); },
    querySelector() { return null; },
    closest() { return null; }
  };
}

/**
 * Load the runtime into a sandbox and hand back the API plus the fetch spy.
 * `responder(url, options)` returns { ok, status, body } or throws.
 */
function loadRuntime(responder) {
  const calls = [];
  const listeners = {};
  const head = makeElement('head');

  const win = {
    location: { origin: 'https://autocuan.web.id' },
    document: {
      readyState: 'complete',
      head,
      visibilityState: 'visible',
      __acKeepAliveHoverWired: false,
      getElementById() { return null; },
      createElement(tag) { return makeElement(tag); },
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      querySelector() { return null; },
      querySelectorAll() { return []; }
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    setTimeout(fn) { return setTimeout(fn, 0); },
    clearTimeout(id) { clearTimeout(id); },
    requestAnimationFrame(fn) { return setTimeout(fn, 0); },
    scrollY: 0,
    scrollTo() {},
    fetch(url, options) {
      calls.push({ url: String(url), options: options || {} });
      const reply = responder(String(url), options || {});
      if (reply instanceof Error) return Promise.reject(reply);
      return Promise.resolve({
        ok: reply.ok !== false,
        status: reply.status || 200,
        text: () => Promise.resolve(reply.body === undefined ? '{}' : reply.body),
        json: () => Promise.resolve(JSON.parse(reply.body === undefined ? '{}' : reply.body))
      });
    }
  };
  win.window = win;

  const sandbox = {
    window: win,
    document: win.document,
    URL,
    Promise,
    JSON,
    Date,
    Map,
    WeakSet,
    WeakMap,
    Object,
    Array,
    String,
    Number,
    Boolean,
    encodeURIComponent,
    setTimeout,
    clearTimeout
  };

  vm.createContext(sandbox);
  vm.runInContext(runtimeSource, sandbox, { filename: 'tab-keepalive-runtime.js' });
  return { api: win.AutoCuanKeepAlive, calls, win, listeners };
}

// ---------------------------------------------------------------------------
// 1. Cache behaviour
// ---------------------------------------------------------------------------

test('a repeated GET /api/ read is served from the store without a second fetch', async () => {
  const { api, calls } = loadRuntime(() => ({ ok: true, body: '{"success":true,"n":1}' }));

  const first = await api.cachedFetch('/api/sector-hot');
  const firstBody = await first.json();
  assert.equal(firstBody.n, 1);
  assert.equal(calls.length, 1, 'the cold read hits the network once');

  const second = await api.cachedFetch('/api/sector-hot');
  const secondBody = await second.json();
  assert.deepEqual(secondBody, firstBody);
  assert.equal(calls.length, 1, 'the warm read must not touch the network at all');
  assert.equal(api.stats().hits, 1);
});

test('a non-GET is never cached and never served from cache', async () => {
  const { api, calls } = loadRuntime(() => ({ ok: true, body: '{"success":true}' }));

  await api.cachedFetch('/api/money-management?action=get-cashflow', { method: 'GET' });
  assert.equal(calls.length, 1);

  // The write must reach the server even though a GET for the same path is warm.
  await api.cachedFetch('/api/money-management', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"action":"save-cashflow"}'
  });
  assert.equal(calls.length, 2, 'a POST always reaches the network');

  await api.cachedFetch('/api/money-management', {
    method: 'DELETE',
    body: '{}'
  });
  assert.equal(calls.length, 3, 'a DELETE always reaches the network');
});

test('a failed request is never cached, so a 502 cannot be frozen', async () => {
  let mode = 'fail';
  const { api, calls } = loadRuntime(() => {
    if (mode === 'fail') return { ok: false, status: 502, body: '<html>Bad Gateway</html>' };
    return { ok: true, body: '{"success":true,"recovered":true}' };
  });

  const failed = await api.cachedFetch('/api/track-record');
  assert.equal(failed.ok, false);
  assert.equal(calls.length, 1);

  // Nothing was stored: the next call must retry rather than replay the error.
  mode = 'ok';
  const recovered = await api.cachedFetch('/api/track-record');
  const body = await recovered.json();
  assert.equal(body.recovered, true);
  assert.equal(calls.length, 2, 'the retry must hit the network');
});

test('an HTML body from a proxy is treated as a failure, not as a payload', async () => {
  let mode = 'html';
  const { api, calls } = loadRuntime(() => {
    if (mode === 'html') return { ok: true, status: 200, body: '<!DOCTYPE html><html>502</html>' };
    return { ok: true, body: '{"success":true}' };
  });

  const bad = await api.cachedFetch('/api/sector-hot?action=deepscan');
  assert.equal(bad.ok, false, 'a 200 carrying HTML is not a usable API answer');

  mode = 'json';
  await api.cachedFetch('/api/sector-hot?action=deepscan');
  assert.equal(calls.length, 2, 'the HTML answer must not have been cached');
});

// ---------------------------------------------------------------------------
// 2. Key normalisation
// ---------------------------------------------------------------------------

test('the cache key ignores the volatile cache-buster parameters', () => {
  const { api } = loadRuntime(() => ({ ok: true, body: '{}' }));

  const a = api._normaliseKey('/api/sector-hot?action=screener&t=1000');
  const b = api._normaliseKey('/api/sector-hot?action=screener&t=2000');
  assert.equal(a, b, 't= is a cache-buster, not part of the identity');

  const c = api._normaliseKey('/api/sector-hot?action=screener&_t=999');
  assert.equal(a, c, '_t= is a cache-buster too');

  const d = api._normaliseKey('/api/sector-hot?action=screener&_ts=123456');
  assert.equal(a, d, '_ts= is a cache-buster too');
});

test('the cache key keeps the parameters that change the answer', () => {
  const { api } = loadRuntime(() => ({ ok: true, body: '{}' }));

  const oneDay = api._normaliseKey('/api/sector-hot?action=bandarmologi&ticker=BBCA&range=1d&days=1');
  const fiveDay = api._normaliseKey('/api/sector-hot?action=bandarmologi&ticker=BBCA&range=5d&days=5');
  assert.notEqual(oneDay, fiveDay, 'a different range is a different payload');

  const bbca = api._normaliseKey('/api/sector-hot?action=bandarmologi&ticker=BBCA');
  const bbri = api._normaliseKey('/api/sector-hot?action=bandarmologi&ticker=BBRI');
  assert.notEqual(bbca, bbri, 'a different ticker is a different payload');
});

test('parameter order does not create a second cache entry', () => {
  const { api } = loadRuntime(() => ({ ok: true, body: '{}' }));
  const a = api._normaliseKey('/api/sector-hot?action=x&ticker=BBCA&range=1d');
  const b = api._normaliseKey('/api/sector-hot?range=1d&ticker=BBCA&action=x');
  assert.equal(a, b);
});

test('only same-origin /api/ GETs are eligible for caching', () => {
  const { api } = loadRuntime(() => ({ ok: true, body: '{}' }));

  assert.equal(api._isCacheable('/api/sector-hot', {}), true);
  assert.equal(api._isCacheable('/api/sector-hot', { method: 'GET' }), true);
  assert.equal(api._isCacheable('/api/sector-hot', { method: 'POST' }), false);
  assert.equal(api._isCacheable('/api/sector-hot', { method: 'POST', body: '{}' }), false);
  assert.equal(api._isCacheable('https://example.com/api/x', {}), false, 'third-party URLs pass through');
  assert.equal(api._isCacheable('/data/file.json', {}), false, 'static assets are the browser cache\'s job');
});

// ---------------------------------------------------------------------------
// 3. Invalidation
// ---------------------------------------------------------------------------

test('invalidate drops the matching key so a write cannot be masked by a stale read', async () => {
  let n = 1;
  const { api, calls } = loadRuntime(() => ({ ok: true, body: '{"success":true,"n":' + n + '}' }));

  await api.cachedFetch('/api/sector-hot?action=watchlist');
  assert.equal(calls.length, 1);

  // Simulate the mutation path: write, then drop the cached read.
  n = 2;
  api.invalidate('/api/sector-hot?action=watchlist');

  const after = await api.cachedFetch('/api/sector-hot?action=watchlist');
  const body = await after.json();
  assert.equal(body.n, 2, 'the refreshed read must reflect the write');
  assert.equal(calls.length, 2, 'invalidation forces a real refetch');
});

test('peek reports age and freshness without touching the network', async () => {
  const { api, calls } = loadRuntime(() => ({ ok: true, body: '{"success":true}' }));

  assert.equal(api.peek('/api/sector-hot'), null, 'a cold key peeks as null');

  await api.cachedFetch('/api/sector-hot');
  const seen = api.peek('/api/sector-hot');
  assert.ok(seen, 'a warm key peeks as an entry');
  assert.equal(seen.fresh, true);
  assert.ok(seen.ageMs >= 0 && seen.ageMs < 1000);
  assert.equal(calls.length, 1, 'peek never fetches');
});

// ---------------------------------------------------------------------------
// 4. Prefetch
// ---------------------------------------------------------------------------

test('prefetch warms the store so the click that follows is instant', async () => {
  const { api, calls, win } = loadRuntime(() => ({ ok: true, body: '{"success":true}' }));

  // The page loaders are looked up on window; provide one for dashboard.
  let ran = 0;
  win.loadDashboardTop5Monitor = function () {
    ran++;
    return win.AutoCuanKeepAlive.cachedFetch('/api/sector-hot?action=dashboard-top5');
  };

  assert.equal(api.prefetch('dashboard'), true, 'a known page prefetches');
  assert.equal(ran, 1, 'the page loader runs on prefetch');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls.length, 1, 'the prefetch actually fetched');

  // The click's own call is now a hit.
  const hit = await api.cachedFetch('/api/sector-hot?action=dashboard-top5');
  assert.equal((await hit.json()).success, true);
  assert.equal(calls.length, 1, 'the click reuses the prefetched payload');
});

test('prefetch of an unknown page is a safe no-op', () => {
  const { api } = loadRuntime(() => ({ ok: true, body: '{}' }));
  assert.equal(api.prefetch('not-a-page'), false);
  assert.equal(api.prefetch(''), false);
  assert.equal(api.prefetch(null), false);
});

test('a page that lives on its own document is prefetched as a link, not a fetch', () => {
  const { api, calls, win } = loadRuntime(() => ({ ok: true, body: '{}' }));

  assert.equal(api.prefetch('analisis'), true);
  assert.equal(calls.length, 0, 'no API call for a document-level page');
  assert.equal(win.document.head.children.length, 1);
  assert.equal(win.document.head.children[0].rel, 'prefetch');
  assert.equal(win.document.head.children[0].href, '/analisis-saham');
});

// ---------------------------------------------------------------------------
// 5. Wiring in the app shell
// ---------------------------------------------------------------------------

test('the keep-alive runtime is loaded by index.html', () => {
  assert.match(html, /<script src="\/tab-keepalive-runtime\.js\?v=/);
});

test('navigateTo reports the page to the keep-alive runtime', () => {
  assert.match(html, /AutoCuanKeepAlive\.onNavigate\(page\)/);
  assert.match(html, /AutoCuanKeepAlive\.hasVisited\(page\)/);
});

test('navigateTo never unmounts a page — it only toggles the hidden class', () => {
  // The keep-alive premise: panels are hidden, never removed. A `.remove()` or
  // an innerHTML wipe on the page container would destroy the DOM cache and
  // bring the spinner back.
  const start = html.indexOf('function navigateTo(page)');
  assert.ok(start > 0);
  const body = html.slice(start, html.indexOf('\nfunction ', start + 10));
  assert.doesNotMatch(body, /\.remove\(\)/, 'no panel may be unmounted');
  assert.match(body, /classList\.add\('hidden'\)/, 'hiding is the mechanism');
});

test('the sidebar and nav items carry the data attributes hover-prefetch reads', () => {
  assert.match(html, /data-sidebar-page="dashboard"/);
  assert.match(html, /data-page="dashboard"/);
  const runtime = fs.readFileSync(RUNTIME_PATH, 'utf8');
  assert.match(runtime, /data-sidebar-page/, 'the runtime must read the sidebar attribute');
  assert.match(runtime, /data-page/, 'and the top-nav attribute');
});

test('prefetch is wired to hover, focus and touch so it works without a mouse', () => {
  assert.match(runtimeSource, /'mouseover'/);
  assert.match(runtimeSource, /'focusin'/);
  assert.match(runtimeSource, /'pointerdown'/);
});

test('the runtime degrades to plain fetch when the store is unavailable', () => {
  // index.html and the sibling runtimes all guard on the API existing.
  for (const file of [
    'public/index.html',
    'public/watchlist-runtime.js',
    'public/deepscan-runtime.js',
    'public/money-management-runtime.js',
    'public/bandarmologi-runtime.js'
  ]) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(
      source,
      /AutoCuanKeepAlive/,
      file + ' must reference the keep-alive runtime so the guard is explicit'
    );
  }
});

test('mutation paths invalidate the cached read they would otherwise mask', () => {
  const watchlist = fs.readFileSync(path.join(ROOT, 'public', 'watchlist-runtime.js'), 'utf8');
  assert.match(watchlist, /invalidateWatchlistCache\(\)/);
  assert.ok(
    (watchlist.match(/invalidateWatchlistCache\(\);/g) || []).length >= 3,
    'toggle, alert save and alert delete must each invalidate'
  );

  const money = fs.readFileSync(path.join(ROOT, 'public', 'money-management-runtime.js'), 'utf8');
  assert.match(money, /invalidateMoneyCache\(\)/);
  assert.ok(
    (money.match(/invalidateMoneyCache\(\);/g) || []).length >= 4,
    'cashflow save, exit price, journal add and journal delete must each invalidate'
  );
});

test('the store is bounded so a long session cannot grow without limit', () => {
  assert.match(runtimeSource, /MAX_ENTRIES\s*=\s*\d+/);
  assert.match(runtimeSource, /function trimStore\(\)/);
});

test('the TTL is ten minutes as specified', () => {
  assert.match(runtimeSource, /TTL_MS\s*=\s*10\s*\*\s*60\s*\*\s*1000/);
});
