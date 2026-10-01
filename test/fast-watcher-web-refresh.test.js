'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const runtimeSource = fs.readFileSync(path.join(ROOT, 'public', 'fast-watcher-live-refresh.js'), 'utf8');
const loaderSource = fs.readFileSync(path.join(ROOT, 'public', 'website-approved-access.js'), 'utf8');

test('approved-access runtime loads the isolated Fast Watcher refresh file', () => {
  assert.match(loaderSource, /fast-watcher-live-refresh\.js\?v=/);
  assert.match(loaderSource, /data-autocuan-fast-watcher-refresh/);
});

test('web refresh is bounded, read-only, and active only for visible Day Trade view', () => {
  assert.match(runtimeSource, /POLL_INTERVAL_MS = 20000/);
  assert.match(runtimeSource, /document\.visibilityState === 'visible'/);
  assert.match(runtimeSource, /currentScreenerType\(\) === 'daytrade'/);
  assert.match(runtimeSource, /action=daytrade-screener&fw_live=/);
  assert.doesNotMatch(runtimeSource, /method:\s*['"]POST['"]/);
  assert.doesNotMatch(runtimeSource, /telegram|supabase|daytrade-screener-run/i);
});

test('changed Fast Watcher rows re-render the open Day Trade page without waiting for full-scan polling', async () => {
  const calls = { meta: 0, table: 0, cards: 0, fetch: 0 };
  const oldData = {
    success: true,
    meta: { status: 'completed' },
    results: [{ ticker: 'BBRI', status: 'EARLY_RADAR', run_id: 'full-1', calculated_at: '2026-07-31T02:05:00Z', last_price: 4000, daytrade_score: 70 }]
  };
  const newData = {
    success: true,
    meta: { status: 'completed' },
    results: [{ ticker: 'PADA', status: 'READY_BREAKOUT', run_mode: 'FAST_WATCHER_LIVE', run_id: 'fw-1', calculated_at: '2026-07-31T02:13:00Z', last_price: 101, daytrade_score: 88 }]
  };

  const document = {
    visibilityState: 'visible',
    addEventListener() {}
  };
  const window = {
    _currentScreenerType: 'daytrade',
    _dtPollInterval: null,
    _dtScreenerCache: oldData,
    updateDtMetaUI() { calls.meta += 1; },
    renderDtTable() { calls.table += 1; },
    renderDtCardGrid() { calls.cards += 1; },
    addEventListener() {},
    dispatchEvent() {},
    CustomEvent: function CustomEvent() {}
  };
  const sandbox = {
    window,
    document,
    fetch: async function fetch(url, options) {
      calls.fetch += 1;
      assert.match(url, /action=daytrade-screener&fw_live=/);
      assert.equal(options.cache, 'no-store');
      assert.equal(options.credentials, 'same-origin');
      return { ok: true, json: async () => newData };
    },
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    Date,
    JSON,
    String,
    Array,
    Boolean
  };

  vm.runInNewContext(runtimeSource, sandbox, { filename: 'fast-watcher-live-refresh.js' });
  const result = await window.AutoCuanFastWatcherRefresh.refreshNow();

  assert.equal(result.refreshed, true);
  assert.equal(calls.fetch, 1);
  assert.equal(calls.meta, 1);
  assert.equal(calls.table, 1);
  assert.equal(calls.cards, 1);
  assert.equal(window._dtScreenerCache.results[0].ticker, 'PADA');
});

test('web refresh does not compete with the existing full-screener poller', async () => {
  const document = { visibilityState: 'visible', addEventListener() {} };
  const window = {
    _currentScreenerType: 'daytrade',
    _dtPollInterval: 123,
    addEventListener() {}
  };
  let fetched = false;
  const sandbox = {
    window,
    document,
    fetch: async function fetch() { fetched = true; throw new Error('must not fetch'); },
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    Date,
    JSON,
    String,
    Array,
    Boolean
  };

  vm.runInNewContext(runtimeSource, sandbox, { filename: 'fast-watcher-live-refresh.js' });
  const result = await window.AutoCuanFastWatcherRefresh.refreshNow();
  assert.equal(result.refreshed, false);
  assert.equal(result.reason, 'inactive');
  assert.equal(fetched, false);
});
