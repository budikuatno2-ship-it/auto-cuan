'use strict';

/**
 * FINAL POLISH WAVE — TASK 6 LOCAL regression contract.
 *
 * 1. Admin Console must not ship the legacy hardcoded quota capacity string.
 * 2. Forecast panel must have honest terminal states (available / unavailable /
 *    no queue) and must never leave an infinite "Memuat..." loader.
 * 3. Job & Data Pipeline JAM WIB column must be deterministic 24-hour WIB
 *    (HH:MM), never locale-dependent 08:30 PM style.
 * 4. Description text must wrap instead of being severely clipped.
 *
 * All assertions are pure/offline: no network, no paid provider, no DB writes,
 * no VPS access, no Telegram.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_HTML = fs.readFileSync(path.join(ROOT, 'public', 'admin-console.html'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const RUNTIME_SRC = fs.readFileSync(path.join(ROOT, 'public', 'admin-console-runtime.js'), 'utf8');
const SCHEDULE_CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'admin-schedule-config.json'), 'utf8'));

function makeEl(id) {
  return {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    className: '',
    style: {},
    setAttribute() {},
    getAttribute() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    focus() {}
  };
}

/** Load the browser IIFE in a minimal sandbox so its exported helpers can be tested. */
function loadRuntime() {
  const elements = {};
  const document = {
    readyState: 'complete',
    getElementById(id) {
      if (!elements[id]) elements[id] = makeEl(id);
      return elements[id];
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    body: makeEl('body')
  };
  const window = {
    location: { pathname: '/', href: 'http://localhost/' },
    document,
    __AUTOCUAN_TEST__: true,
    addEventListener() {}
  };
  const sandbox = {
    window,
    document,
    console,
    fetch: async () => { throw new Error('fetch not stubbed'); },
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    AbortController,
    Date, Math, Number, String, Array, Object, JSON, Boolean, RegExp, Error,
    isNaN, parseInt, parseFloat, Intl, Promise
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(RUNTIME_SRC, sandbox, { filename: 'admin-console-runtime.js' });
  return { root: window, elements, document, sandbox };
}

/* ------------------------------------------------------------------ */
/* 1. Hardcoded quota text                                             */
/* ------------------------------------------------------------------ */

test('TASK6: legacy hardcoded quota capacity string is gone from all admin surfaces', () => {
  const banned = [
    'Kapasitas: hari kerja',
    '15.000 req/hari',
    '18.030 req/hari',
    'akhir pekan ~18.030'
  ];
  for (const [label, src] of [['admin-console.html', ADMIN_HTML], ['index.html', INDEX_HTML], ['runtime', RUNTIME_SRC]]) {
    for (const needle of banned) {
      assert.equal(src.includes(needle), false, label + ' still contains hardcoded quota text: ' + needle);
    }
  }
});

test('TASK6: capacity source element exists with honest unavailable default', () => {
  for (const [label, html] of [['admin-console.html', ADMIN_HTML], ['index.html', INDEX_HTML]]) {
    assert.match(html, /id="fcCapacity"[^>]*>Kapasitas: data tidak tersedia\.</, label + ' must expose dynamic capacity slot');
  }
});

/* ------------------------------------------------------------------ */
/* 2. Stuck forecast loader                                            */
/* ------------------------------------------------------------------ */

test('TASK6: initial forecast tbody has no permanent loading row', () => {
  for (const [label, html] of [['admin-console.html', ADMIN_HTML], ['index.html', INDEX_HTML]]) {
    assert.equal(html.includes('Memuat forecast penyelesaian backfill'), false,
      label + ' still ships the stuck loader literal');
  }
});

test('TASK6: opening the Data Integration tab refreshes the forecast', async () => {
  const { root, sandbox } = loadRuntime();
  const calls = [];
  sandbox.fetch = async (url, opts) => {
    calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return { ok: false, status: 503, json: async () => ({}) };
  };
  root.switchAdminTab(6);
  await new Promise((r) => setImmediate(r));
  assert.ok(calls.some((c) => c.body && c.body.action === 'backfill_forecast'),
    'tab 6 must trigger backfill_forecast instead of leaving the loader stuck');
});

test('TASK6: initAdminConsole also refreshes the forecast', async () => {
  const { root, sandbox } = loadRuntime();
  const calls = [];
  sandbox.fetch = async (url, opts) => {
    calls.push(opts && opts.body ? JSON.parse(opts.body) : null);
    return { ok: false, status: 503, json: async () => ({}) };
  };
  root.initAdminConsole();
  await new Promise((r) => setImmediate(r));
  assert.ok(calls.some((b) => b && b.action === 'backfill_forecast'),
    'admin console init must trigger backfill_forecast');
});

test('TASK6: forecast available state renders dynamic capacity and rows', () => {
  const { root, elements } = loadRuntime();
  root.renderBackfillForecast({
    remainingRequests: 1200,
    finishDate: '2026-11-25',
    planExpiresAt: '2026-11-30T23:59:59+07:00',
    finishesBeforeExpiry: true,
    capacityPerDay: { weekday: 15000, weekend: 18030 },
    dailyTable: [{ date: '2026-11-21', weekday: 'Jum', capacity: 15000, burn: 1200, remainingAfter: 0, done: true }]
  });
  assert.match(elements.fcCapacity.textContent, /15\.000/, 'weekday capacity must come from data');
  assert.match(elements.fcCapacity.textContent, /18\.030/, 'weekend capacity must come from data');
  assert.match(elements.forecastTbody.innerHTML, /2026-11-21/);
  assert.doesNotMatch(elements.forecastTbody.innerHTML, /Memuat/);
});

test('TASK6: forecast unavailable state is honest and clears the loader', () => {
  const { root, elements } = loadRuntime();
  root.renderBackfillForecast(null);
  assert.match(elements.forecastTbody.innerHTML, /Data tidak tersedia/);
  assert.match(elements.fcCapacity.textContent, /data tidak tersedia/);
  assert.doesNotMatch(elements.forecastTbody.innerHTML, /Memuat/);
});

test('TASK6: no-queue state is explicit, not a loader', () => {
  const { root, elements } = loadRuntime();
  root.renderBackfillForecast({
    remainingRequests: 0,
    dailyTable: [],
    capacityPerDay: { weekday: 15000, weekend: 18030 },
    finishDate: null,
    planExpiresAt: null,
    finishesBeforeExpiry: null
  });
  assert.match(elements.forecastTbody.innerHTML, /Tidak ada antrean backfill/);
  assert.match(elements.fcStatus.textContent, /Tidak ada antrean/);
  assert.doesNotMatch(elements.forecastTbody.innerHTML, /Memuat/);
});

test('TASK6: refreshBackfillForecast clears loader on HTTP failure', async () => {
  const { root, elements, sandbox } = loadRuntime();
  sandbox.fetch = async () => ({ ok: false, status: 404, json: async () => ({ success: false }) });
  await root.refreshBackfillForecast();
  assert.doesNotMatch(elements.forecastTbody.innerHTML, /Memuat/);
  assert.match(elements.forecastTbody.innerHTML, /Data tidak tersedia/);
});

test('TASK6: refreshBackfillForecast clears loader on network failure', async () => {
  const { root, elements, sandbox } = loadRuntime();
  sandbox.fetch = async () => { throw new Error('offline'); };
  await root.refreshBackfillForecast();
  assert.doesNotMatch(elements.forecastTbody.innerHTML, /Memuat/);
  assert.match(elements.forecastTbody.innerHTML, /Data tidak tersedia/);
});

test('TASK6: hanging forecast fetch is aborted by timeout guard', async () => {
  const { root, elements, sandbox } = loadRuntime();
  let timeoutCb = null;
  sandbox.setTimeout = (fn) => { timeoutCb = fn; return 1; };
  sandbox.clearTimeout = () => {};
  sandbox.fetch = (url, opts) => new Promise((resolve, reject) => {
    const sig = opts && opts.signal;
    if (sig) sig.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const pending = root.refreshBackfillForecast();
  assert.equal(typeof timeoutCb, 'function', 'a timeout guard must be installed for the forecast fetch');
  timeoutCb();
  await pending;
  assert.doesNotMatch(elements.forecastTbody.innerHTML, /Memuat/);
  assert.match(elements.forecastTbody.innerHTML, /Data tidak tersedia/);
});

/* ------------------------------------------------------------------ */
/* 3. 24-hour WIB schedule formatting                                  */
/* ------------------------------------------------------------------ */

test('TASK6: formatWib24h normalizes every required schedule time and 12h input', () => {
  const { root } = loadRuntime();
  const f = root.formatWib24h;
  assert.equal(typeof f, 'function', 'formatWib24h must be exported for the 24h contract');
  const required = ['17:00', '20:30', '20:40', '21:20', '21:35', '21:55', '22:05', '22:15', '22:40'];
  for (const t of required) assert.equal(f(t), t, 'required 24h time ' + t);
  assert.equal(f('08:30 PM'), '20:30');
  assert.equal(f('08:40 PM'), '20:40');
  assert.equal(f('09:35 PM'), '21:35');
  assert.equal(f('10:05 PM'), '22:05');
  assert.equal(f('12:00 AM'), '00:00');
  assert.equal(f('12:00 PM'), '12:00');
  assert.equal(f('2026-11-21T20:30:00+07:00'), '20:30');
  assert.equal(f(null), '—');
});

test('TASK6: durable schedule config stores only 24-hour WIB times', () => {
  const times = Object.values(SCHEDULE_CFG.jobs).map((j) => j.timeWIB);
  for (const t of times) {
    assert.match(t, /^([01]\d|2[0-3]):[0-5]\d$/, 'non-24h schedule time: ' + t);
  }
  for (const required of ['17:00', '17:05', '17:15', '17:25', '17:35', '20:40', '20:45', '20:50', '20:55', '21:00', '21:05', '21:10', '21:15', '21:20', '21:30']) {
    assert.ok(times.includes(required), 'expected schedule time missing from config: ' + required);
  }
});

test('TASK6: schedule table renders 24-hour WIB with no AM/PM and wrapping descriptions', () => {
  const { root, elements } = loadRuntime();
  root.renderJobsPipeline({
    version: 5,
    nowWIB: '2026-11-21 20:00 WIB',
    collisions: [],
    nextRuns: {},
    jobs: [
      {
        key: 'locked', name: 'Locked Job', category: 'EOD', costClass: 'LOW',
        editable: false, enabled: true, timeWIB: '20:30', days: [1],
        description: 'Deskripsi panjang yang tidak boleh terpotong', nextRuns: []
      },
      {
        key: 'editable', name: 'Editable Job', category: 'EOD', costClass: 'ZERO_QUOTA',
        editable: true, enabled: true, timeWIB: '21:35', days: [1],
        description: 'Deskripsi lain yang juga tidak boleh terpotong', nextRuns: []
      }
    ]
  });
  const html = elements.jobsPipelineTbody.innerHTML;
  assert.match(html, /20:30/, 'locked row must show 24h time');
  assert.match(html, /21:35/, 'editable row must use a deterministic 24h input');
  assert.doesNotMatch(html, /\b(AM|PM)\b/, 'no locale 12-hour markers allowed');
  assert.match(html, /white-space:\s*normal/, 'description must wrap');
  assert.match(html, /overflow-wrap:\s*anywhere/, 'long words must wrap');
  assert.doesNotMatch(html, /text-overflow:\s*ellipsis/, 'description must not be ellipsis-clipped');
});

test('TASK6: schedule time input is a strict 24-hour text field, not locale time control', () => {
  const { root, elements } = loadRuntime();
  root.renderJobsPipeline({
    version: 5, nowWIB: '2026-11-21 20:00 WIB', collisions: [], nextRuns: {},
    jobs: [{
      key: 'j', name: 'J', category: 'EOD', costClass: 'LOW', editable: true,
      enabled: true, timeWIB: '22:15', days: [1], description: 'd', nextRuns: []
    }]
  });
  const html = elements.jobsPipelineTbody.innerHTML;
  assert.match(html, /type="text"/, 'must not rely on locale-rendered input[type=time]');
  assert.match(html, /data-role="schedule-time"/);
  assert.match(html, /pattern="\^\(\[01\]\\d\|2\[0-3\]\):\[0-5\]\\d\$"/);
  assert.doesNotMatch(html, /type="time"/);
});

/* ------------------------------------------------------------------ */
/* 4. No regressions in guardrails                                     */
/* ------------------------------------------------------------------ */

test('TASK6: no paid-provider / Telegram / DB write surface introduced in changed runtime', () => {
  // The runtime is browser-only; these strings must not appear in the TASK 6 paths.
  const forecastSection = RUNTIME_SRC.slice(RUNTIME_SRC.indexOf('function renderBackfillForecast'), RUNTIME_SRC.indexOf('root.renderBackfillForecast'));
  assert.doesNotMatch(forecastSection, /fetch\((?!'\/api\/admin-users')/, 'forecast must only call the local admin API');
  assert.doesNotMatch(forecastSection, /telegram|sqlite|INSERT|UPDATE\s/i);
});
