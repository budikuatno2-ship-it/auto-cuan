'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const adminSession = require('../lib/admin-session');
const adminUsers = require('../api/admin-users');
const candles = require('../api/candles');
const patternMapScript = fs.readFileSync(path.join(__dirname, '..', 'public', 'pattern-map.js'), 'utf8');
const SECRET = 'pattern-map-admin-access-test-secret';

function withSessionSecret(fn) {
  const prior = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = SECRET;
  return Promise.resolve().then(fn).finally(() => {
    if (prior === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = prior;
  });
}

function signedCookie(overrides) {
  const token = adminSession.createSessionToken(Object.assign({
    userId: 'user-1', username: 'trader', isAdmin: false, deviceId: 'device-1'
  }, overrides || {}));
  return 'ac_sess=' + token;
}

function makeRes() {
  return {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

async function patternAccess(cookie, extra) {
  const res = makeRes();
  await adminUsers({
    method: 'POST',
    headers: Object.assign({ host: 'autocuan.test', origin: 'https://autocuan.test' }, cookie ? { cookie } : {}, extra && extra.headers),
    body: Object.assign({ action: 'pattern_map_access' }, extra && extra.body)
  }, res);
  return res;
}

function element(classes) {
  const values = new Set(String(classes || '').split(/\s+/).filter(Boolean));
  return {
    attributes: {},
    textContent: '',
    classList: {
      add(name) { values.add(name); },
      remove(name) { values.delete(name); },
      contains(name) { return values.has(name); },
      toggle(name, force) {
        if (force === undefined) force = !values.has(name);
        if (force) values.add(name); else values.delete(name);
        return force;
      }
    },
    setAttribute(name, value) { this.attributes[name] = value; }
  };
}

function browserHarness(accessResponse, options) {
  const elements = {
    technicalChartTab: element('bg-emerald-500 text-black'),
    patternChartTab: element('hidden bg-dark-700 text-gray-300'),
    chartPageContainer: element(''),
    patternPageContainer: element('hidden')
  };
  const calls = { fetch: [], render: 0, reset: 0, logout: 0 };
  let currentResponse = accessResponse;
  const sandbox = {
    console,
    Promise,
    Map,
    Set,
    Date,
    JSON,
    Object,
    String,
    Number,
    Boolean,
    Math,
    RegExp,
    AbortController,
    URLSearchParams,
    location: { search: options && options.search || '' },
    __AUTOCUAN_PATTERN_MAP_PREVIEW__: Boolean(options && options.browserFlag),
    document: {
      readyState: 'complete',
      visibilityState: 'visible',
      getElementById(id) { return elements[id] || null; },
      addEventListener() {}
    },
    addEventListener() {},
    setTimeout(fn) { return { fn }; },
    clearTimeout() {},
    fetch: async function(url, fetchOptions) {
      calls.fetch.push({ url, options: fetchOptions });
      const value = typeof currentResponse === 'function' ? currentResponse() : currentResponse;
      return {
        ok: value && value.ok !== false,
        status: value && value.status || 200,
        json: async () => value && value.body || value
      };
    },
    setChartTabSelected(tab, selected) {
      tab.setAttribute('aria-selected', String(selected));
      tab.classList.toggle('bg-emerald-500', selected);
      tab.classList.toggle('text-black', selected);
      tab.classList.toggle('bg-dark-700', !selected);
      tab.classList.toggle('text-gray-300', !selected);
    },
    resetPatternMap() { calls.reset += 1; },
    renderPatternTab: async function() { calls.render += 1; },
    logout: async function() { calls.logout += 1; }
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(patternMapScript, sandbox);
  return {
    sandbox,
    elements,
    calls,
    setResponse(value) { currentResponse = value; }
  };
}

function adminBrowserResponse(offsetMs) {
  return {
    success: true,
    allowed: true,
    access: 'admin',
    username: 'budi',
    expires_at: new Date(Date.now() + (offsetMs == null ? 60_000 : offsetMs)).toISOString()
  };
}

test('server grants Pattern access only to a valid signed budi admin session', async () => {
  await withSessionSecret(async () => {
    let res = await patternAccess();
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.allowed, false);

    res = await patternAccess(signedCookie());
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.allowed, false);

    res = await patternAccess(signedCookie({ userId: 'admin-1', username: 'budi', isAdmin: true }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.allowed, true);
    assert.equal(res.body.access, 'admin');
    assert.equal(res.body.username, 'budi');
    assert.ok(Date.parse(res.body.expires_at) > Date.now());
    assert.equal(res.headers['Cache-Control'], 'private, no-store');

    const forged = signedCookie({ userId: 'admin-1', username: 'budi', isAdmin: true }).replace(/.$/, 'x');
    res = await patternAccess(forged, { headers: { 'x-username': 'budi', 'x-is-admin': 'true' } });
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.allowed, false);
  });
});

test('candles withhold Pattern geometry from guest and non-admin even with browser-style bypass flags', async () => {
  await withSessionSecret(async () => {
    const internal = {
      success: true,
      ticker: 'BBCA',
      candles: [{ time: '2026-07-27', open: 1, high: 2, low: 1, close: 2 }],
      patternMap: { id: 'trusted-secret-geometry' },
      pattern_map_meta: { engine: 'abcd-t1-v1', status: 'found', reason: 'found' }
    };

    const guest = candles.__test.responseForRequest(internal, {
      headers: { 'x-username': 'budi', 'x-is-admin': 'true' },
      query: { patternMapPreview: '1' }
    });
    assert.equal(guest.ticker, 'BBCA');
    assert.equal('patternMap' in guest, false);
    assert.equal('pattern_map_meta' in guest, false);

    const nonAdmin = candles.__test.responseForRequest(internal, {
      headers: { cookie: signedCookie(), 'x-username': 'budi', 'x-is-admin': 'true' },
      query: { patternMapPreview: '1' }
    });
    assert.equal('patternMap' in nonAdmin, false);
    assert.equal('pattern_map_meta' in nonAdmin, false);

    const admin = candles.__test.responseForRequest(internal, {
      headers: { cookie: signedCookie({ userId: 'admin-1', username: 'budi', isAdmin: true }) }
    });
    assert.strictEqual(admin, internal);
    assert.equal(admin.patternMap.id, 'trusted-secret-geometry');
  });
});

test('query string and browser flag cannot expose or render Pattern for non-admin', async () => {
  const h = browserHarness({ ok: false, status: 403, body: { success: false, allowed: false } }, {
    search: '?patternMapPreview=1', browserFlag: true
  });
  await h.sandbox.PatternMapAdminAccess.refresh(true);
  assert.equal(h.sandbox.patternMapPreviewEnabled(), false);
  assert.equal(h.elements.patternChartTab.classList.contains('hidden'), true);
  assert.equal(await h.sandbox.showChartTab('pattern'), false);
  assert.equal(h.elements.chartPageContainer.classList.contains('hidden'), false);
  assert.equal(h.elements.patternPageContainer.classList.contains('hidden'), true);
  assert.equal(h.calls.render, 0);
  assert.ok(h.calls.fetch.every(call => call.url === '/api/admin-users'));
  assert.ok(h.calls.fetch.every(call => call.options.credentials === 'same-origin'));
});

test('admin tab is visible but QuickChart remains lazy until Pattern is selected', async () => {
  const h = browserHarness(adminBrowserResponse());
  await h.sandbox.PatternMapAdminAccess.refresh(true);
  assert.equal(h.sandbox.PatternMapAdminAccess.isAllowed(), true);
  assert.equal(h.elements.patternChartTab.classList.contains('hidden'), false);
  assert.equal(h.elements.patternChartTab.textContent, 'Pattern Map');
  assert.equal(h.calls.render, 0);
  assert.ok(h.calls.fetch.every(call => call.url === '/api/admin-users'));

  assert.equal(await h.sandbox.showChartTab('pattern'), true);
  assert.equal(h.elements.chartPageContainer.classList.contains('hidden'), true);
  assert.equal(h.elements.patternPageContainer.classList.contains('hidden'), false);
  assert.equal(h.calls.render, 1);
});

test('logout or expired access restores Technical Chart and cancels active Pattern state', async () => {
  const h = browserHarness(adminBrowserResponse());
  await h.sandbox.PatternMapAdminAccess.refresh(true);
  await h.sandbox.showChartTab('pattern');
  const resetBeforeLogout = h.calls.reset;
  await h.sandbox.logout();
  assert.equal(h.calls.logout, 1);
  assert.ok(h.calls.reset > resetBeforeLogout);
  assert.equal(h.elements.patternChartTab.classList.contains('hidden'), true);
  assert.equal(h.elements.chartPageContainer.classList.contains('hidden'), false);
  assert.equal(h.elements.patternPageContainer.classList.contains('hidden'), true);

  const expired = browserHarness(adminBrowserResponse(-1_000), {
    search: '?patternMapPreview=1', browserFlag: true
  });
  assert.equal(await expired.sandbox.PatternMapAdminAccess.refresh(true), false);
  assert.equal(expired.elements.patternChartTab.classList.contains('hidden'), true);
  assert.equal(expired.elements.chartPageContainer.classList.contains('hidden'), false);
});
