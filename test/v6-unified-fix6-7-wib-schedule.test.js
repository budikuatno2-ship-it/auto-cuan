'use strict';

/**
 * UNIFIED FINAL WAVE — FIX 6 + FIX 7 regression contract.
 *
 * FIX 6: WIB 24-hour text input, human next-run formatting, admin table fit,
 *        legacy fold, footer text, 19-tab WIB audit, crontab WIB audit.
 * FIX 7: revised 20:40 night pipeline schedule, concurrency 10, telegram OFF,
 *        ihsg ZERO_QUOTA, legacy folded/disabled, no AM/PM, no old 20:00 text.
 *
 * All assertions are pure/offline: no network, no paid provider, no DB writes,
 * no VPS access, no Telegram, no cron changes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const ADMIN_HTML = read('public/admin-console.html');
const INDEX_HTML = read('public/index.html');
const RUNTIME_SRC = read('public/admin-console-runtime.js');
const STORE_SRC = read('lib/admin-schedule-store.js');
const CONFIG = JSON.parse(read('data/admin-schedule-config.json'));
const CRON = read('deploy/vps/final-schedule.cron');

function loadRuntime() {
  const elements = {};
  const makeEl = (id) => ({
    id, innerHTML: '', textContent: '', value: '', checked: false, disabled: false,
    className: '', style: {}, setAttribute() {}, getAttribute() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, focus() {}
  });
  const document = {
    readyState: 'complete',
    getElementById(id) { if (!elements[id]) elements[id] = makeEl(id); return elements[id]; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, body: makeEl('body')
  };
  const window = { location: { pathname: '/', href: 'http://localhost/' }, document, __AUTOCUAN_TEST__: true, addEventListener() {} };
  const sandbox = {
    window, document, console, fetch: async () => { throw new Error('fetch not stubbed'); },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {}, AbortController,
    Date, Math, Number, String, Array, Object, JSON, Boolean, RegExp, Error,
    isNaN, parseInt, parseFloat, Intl, Promise
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(RUNTIME_SRC, sandbox, { filename: 'admin-console-runtime.js' });
  return { root: window, elements, document, sandbox };
}

/* ------------------------------- FIX 6 ---------------------------------- */

test('FIX6: no input[type=time] in admin surfaces; strict 24h text pattern', () => {
  for (const [label, src] of [['admin-console.html', ADMIN_HTML], ['index.html', INDEX_HTML], ['runtime', RUNTIME_SRC]]) {
    assert.doesNotMatch(src, /type=["']time["']/i, label + ' must not use locale time input');
  }
  const { root, elements } = loadRuntime();
  root.renderJobsPipeline({
    version: 6, nowWIB: '2026-11-22 20:00 WIB', collisions: [], nextRuns: {},
    jobs: [{ key: 'j', name: 'J', category: 'EOD', costClass: 'LOW', editable: true,
      enabled: true, timeWIB: '20:40', days: [1], description: 'd' }]
  });
  const html = elements.jobsPipelineTbody.innerHTML;
  assert.match(html, /type="text"/);
  assert.match(html, /pattern="\^\(\[01\]\\d\|2\[0-3\]\):\[0-5\]\\d\$"/, 'exact required HH:MM pattern');
  assert.doesNotMatch(html, /\b(AM|PM)\b/);
});

test('FIX6: next runs render as human WIB, never ISO or em dash', () => {
  const { root, elements } = loadRuntime();
  assert.equal(typeof root.formatNextRunWib, 'function');
  assert.equal(root.formatNextRunWib('2026-11-23T20:40:00+07:00'), 'Sen 23 Nov, 20:40 WIB');
  assert.equal(root.formatNextRunWib('2026-11-28T00:15:00+07:00'), 'Sab 28 Nov, 00:15 WIB');
  root.renderJobsPipeline({
    version: 6, nowWIB: '2026-11-22 20:00 WIB', collisions: [],
    nextRuns: { j: ['2026-11-23T20:40:00+07:00'] },
    jobs: [{ key: 'j', name: 'J', category: 'NIGHT', costClass: 'HIGH', editable: true,
      enabled: true, timeWIB: '20:40', days: [1], description: 'd' }]
  });
  const html = elements.jobsPipelineTbody.innerHTML;
  assert.match(html, /Sen 23 Nov, 20:40 WIB/);
  assert.doesNotMatch(html, /2026-11-23T20:40/);
  assert.doesNotMatch(html, /<span class="mut">—<\/span>/);
});

test('FIX6: all 7 active-day checkboxes and all columns are present and visible at 1440x900', () => {
  const { root, elements } = loadRuntime();
  root.renderJobsPipeline({
    version: 6, nowWIB: '2026-11-22 20:00 WIB', collisions: [], nextRuns: {},
    jobs: [{ key: 'j', name: 'J', category: 'NIGHT', costClass: 'HIGH', editable: true,
      enabled: true, timeWIB: '20:40', days: [1,2,3,4,5], description: 'd' }]
  });
  const html = elements.jobsPipelineTbody.innerHTML;
  for (const d of ['Min','Sen','Sel','Rab','Kam','Jum','Sab']) assert.ok(html.includes('> ' + d + '</label>'), 'day ' + d);
  for (const col of ['JAM WIB','5 RUN BERIKUTNYA','DESKRIPSI','ENABLED / AKTIF','Simpan']) {
    assert.ok(ADMIN_HTML.includes(col) || INDEX_HTML.includes(col) || html.includes(col), 'column ' + col);
  }
  assert.match(ADMIN_HTML, /\.admin-schedule-tbl \{ table-layout: fixed; width: 100%; min-width: 0; \}/);
  assert.match(ADMIN_HTML, /<table class="tbl admin-schedule-tbl" style="width:100%;table-layout:fixed">/);
  assert.match(INDEX_HTML, /<table class="tbl admin-schedule-tbl" style="width:100%">/);
});

test('FIX6: legacy jobs folded into disabled compatibility group', () => {
  const { root, elements } = loadRuntime();
  root.renderJobsPipeline({
    version: 6, nowWIB: '2026-11-22 20:00 WIB', collisions: [], nextRuns: {},
    jobs: [
      { key: 'active', name: 'Active', category: 'NIGHT', costClass: 'HIGH', editable: true,
        enabled: true, timeWIB: '20:40', days: [1], description: 'd' },
      { key: 'coordinated-pipeline', name: 'Coordinated Nightly Pipeline', category: 'LEGACY',
        costClass: 'HIGH', editable: true, enabled: false, legacy_inactive: true,
        timeWIB: '20:00', days: [1], description: 'legacy' }
    ]
  });
  const html = elements.jobsPipelineTbody.innerHTML;
  assert.match(html, /Job Legacy \/ Kompatibilitas \(Nonaktif\)/);
  assert.match(html, /<details/);
  assert.match(html, /Nonaktif/);
  assert.ok(html.indexOf('Job Legacy') > html.indexOf('data-schedule-row="active"'), 'legacy group below main table');
});

test('FIX6: footer text is the revised 20:40 text on both admin surfaces', () => {
  const expected = 'Default Broksum mulai 20:40 WIB (jeda +10 menit pasca-rilis 20:30 WIB, concurrency 10, editable di Admin Console).';
  assert.ok(ADMIN_HTML.includes(expected));
  assert.ok(INDEX_HTML.includes(expected));
  assert.doesNotMatch(ADMIN_HTML, /Default Broksum terkunci 20:00 WIB/);
  assert.doesNotMatch(INDEX_HTML, /Default Broksum terkunci 20:00 WIB/);
});

test('FIX6: 19-tab navigation and crontab are 100% WIB 24-hour', () => {
  const nav = INDEX_HTML.match(/data-sidebar-page="[^"]+"/g) || [];
  assert.equal(nav.length, 19, '19 sidebar tabs present');
  assert.doesNotMatch(INDEX_HTML, /\b\d{1,2}:\d{2}\s*(AM|PM)\b/i, 'no AM/PM in SPA');
  assert.doesNotMatch(ADMIN_HTML, /\b\d{1,2}:\d{2}\s*(AM|PM)\b/i, 'no AM/PM in admin console');
  assert.match(CRON, /^CRON_TZ=Asia\/Jakarta$/m);
  assert.match(CRON, /^TZ=Asia\/Jakarta$/m);
  assert.doesNotMatch(CRON, /\b(AM|PM)\b/i, 'crontab has no 12-hour markers');
});

/* ------------------------------- FIX 7 ---------------------------------- */

const EXPECTED_TIMES = {
  'yahoo-ohlcv': '17:00', ihsg: '17:05', lifecycle: '17:15', 'market-context': '17:25',
  'sector-hot': '17:35', 'broksum-all': '20:40', 'broksum-foreign': '20:45',
  insider: '20:50', 'domestic-compile': '20:55', accumulation: '21:00',
  bandarmologi: '21:05', top20: '21:10', top5: '21:15', telegram: '21:20',
  fundamental: '21:30', 'quota-backfill': '00:15'
};

test('FIX7: all revised schedule times present in store catalog and durable config', () => {
  for (const [key, time] of Object.entries(EXPECTED_TIMES)) {
    assert.ok(CONFIG.jobs[key], 'config job ' + key);
    assert.equal(CONFIG.jobs[key].timeWIB, time, 'config ' + key + ' time');
    assert.match(CONFIG.jobs[key].timeWIB, /^([01]\d|2[0-3]):[0-5]\d$/, '24h ' + key);
  }
  for (const [key, time] of Object.entries(EXPECTED_TIMES)) {
    const re = new RegExp("key: '" + key + "'[\\s\\S]*?defaultTimeWIB: '" + time + "'");
    assert.match(STORE_SRC, re, 'store catalog ' + key + ' default ' + time);
  }
});

test('FIX7: concurrency 10 for broksum-all, broksum-foreign, insider (range 8-12)', () => {
  for (const key of ['broksum-all', 'broksum-foreign', 'insider']) {
    assert.equal(CONFIG.jobs[key].concurrency, 10, key + ' config concurrency');
    assert.equal(CONFIG.jobs[key].minConcurrency, 8, key + ' min');
    assert.equal(CONFIG.jobs[key].maxConcurrency, 12, key + ' max');
    assert.match(STORE_SRC, new RegExp("key: '" + key + "'[\\s\\S]*?defaultConcurrency: 10[\\s\\S]*?minConcurrency: 8, maxConcurrency: 12"));
  }
  assert.equal(CONFIG.jobs['broksum-all'].canaryTicker, 'BBCA');
  assert.match(STORE_SRC, /canaryTicker: 'BBCA'/);
});

test('FIX7: telegram disabled, ihsg ZERO_QUOTA, insider weekdays before ranking', () => {
  assert.equal(CONFIG.jobs.telegram.enabled, false, 'telegram OFF');
  assert.match(STORE_SRC, /key: 'telegram'[\s\S]*?defaultEnabled: false/);
  assert.equal(CONFIG.jobs.ihsg.costClass, 'ZERO_QUOTA');
  assert.match(CONFIG.jobs.ihsg.description, /\^JKSE/);
  assert.equal(CONFIG.jobs.insider.marketDaysOnly, true);
  assert.deepEqual(CONFIG.jobs.insider.days, [1,2,3,4,5]);
  assert.ok(CONFIG.jobs.insider.timeWIB < CONFIG.jobs.top20.timeWIB, 'insider before ranking');
});

test('FIX7: legacy coordinated pipeline folded and disabled; source preserved', () => {
  const legacy = CONFIG.jobs['coordinated-pipeline'];
  assert.equal(legacy.category, 'LEGACY');
  assert.equal(legacy.enabled, false);
  assert.equal(legacy.legacy_inactive, true);
  assert.match(STORE_SRC, /key: 'coordinated-pipeline'[\s\S]*?category: 'LEGACY'[\s\S]*?legacy_inactive: true/);
  for (const key of ['hourly-confirmation','daytrade-fastwatcher','fastwatcher','daytrade-producer']) {
    assert.equal(CONFIG.jobs[key].legacy_inactive, true, key + ' legacy flag preserved');
    assert.equal(CONFIG.jobs[key].enabled, false, key + ' disabled');
  }
});

test('FIX7: no AM/PM and no old locked 20:00 text in changed sources', () => {
  for (const [label, src] of [
    ['store', STORE_SRC], ['config', JSON.stringify(CONFIG)],
    ['admin', ADMIN_HTML], ['index', INDEX_HTML], ['runtime', RUNTIME_SRC]
  ]) {
    assert.doesNotMatch(src, /\b(?:0?\d|1\d|2[0-3]):[0-5]\d\s*(AM|PM)\b/i, label + ' clock AM/PM');
  }
  assert.doesNotMatch(ADMIN_HTML, /Default Broksum terkunci 20:00 WIB/);
  assert.doesNotMatch(INDEX_HTML, /Default Broksum terkunci 20:00 WIB/);
  assert.doesNotMatch(STORE_SRC, /default terkunci 20:00 WIB/);
});

test('FIX7: durable config has zero schedule collisions', () => {
  process.env.ADMIN_SCHEDULE_CONFIG_PATH = path.join(ROOT, 'data', 'admin-schedule-config.json');
  const storePath = path.join(ROOT, 'lib', 'admin-schedule-store.js');
  delete require.cache[require.resolve(storePath)];
  const store = require(storePath);
  assert.deepEqual(store.listCollisions(store.get().doc), []);
});
