'use strict';

// Every source/receipt/cap in this suite is OFFLINE and lives in os.tmpdir().
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'v6-dispatcher-tests-'));
process.env.ADMIN_SCHEDULE_CONFIG_PATH = path.join(ROOT, 'schedule.json');
process.env.ADMIN_SCHEDULE_HISTORY_PATH = path.join(ROOT, 'history');
process.env.ADMIN_SCHEDULE_AUDIT_PATH = path.join(ROOT, 'schedule-audit.jsonl');
process.env.QUOTA_OPS_CONFIG_PATH = path.join(ROOT, 'quota.json');
process.env.QUOTA_OPS_AUDIT_PATH = path.join(ROOT, 'quota-audit.jsonl');
process.env.SCHEDULE_LEGACY_ACTIVE_PATH = path.join(ROOT, 'legacy.json');
process.env.SESSION_SECRET = 'isolated-local-http-signing-secret-for-tests';
const store = require('../lib/admin-schedule-store');
const quotaStore = require('../lib/quota-config-store');
const control = require('../lib/schedule-control-plane');
const { createDispatcher, paidDecision, policyDue, retryDelayMs } = require('../lib/v6-scheduler-dispatcher.cjs');
const { createAdapters, atomicWrite, publish, verifyOutput, sha, readJson } = require('../lib/v6-scheduler-adapters.cjs');
const session = require('../lib/admin-session');
const scheduleApi = require('../api/admin/schedule-settings');
const quotaApi = require('../api/admin/quota-settings');
const EVIDENCE = process.env.V6_DISPATCHER_TEST_EVIDENCE_DIR;
function write(file, value) { atomicWrite(file, value); }
function read(file) { return JSON.parse(fs.readFileSync(file)); }
function reset() {
  const doc = store.normalizeDoc({});
  for (const j of Object.values(doc.jobs)) j.enabled = false;
  write(store.STORE_PATH, doc); write(quotaStore.STORE_PATH, quotaStore.blankDoc());
  write(process.env.SCHEDULE_LEGACY_ACTIVE_PATH, { executors: Object.fromEntries(control.LEGACY_EXECUTORS.map((e) => [e.name, 'RETIRED'])) });
}
function saveJobs(jobs) {
  const result = store.put({ jobs }, { actor: 'offline-test-admin', reason: 'isolated test', expectedVersion: store.get().doc.version });
  assert.equal(result.ok, true, JSON.stringify(result)); return result;
}
function saveQuota(patch) {
  const result = quotaStore.put(patch, { actor: 'offline-test-admin', reason: 'isolated test', expectedVersion: quotaStore.get().doc.version });
  assert.equal(result.ok, true, JSON.stringify(result)); return result;
}
function setup(t, instant = '2026-11-17T14:05:00Z') {
  reset(); const dir = fs.mkdtempSync(path.join(ROOT, 'case-'));
  const adapterOptions = { realm: 'OFFLINE', outputDir: path.join(dir, 'outputs'), cachedDir: path.join(dir, 'cache') };
  let clock = new Date(instant);
  const options = { statePath: path.join(dir, 'state.json'), adapterOptions, now: () => new Date(clock), random: () => 0.5, legacyGuard: false };
  const real = createAdapters(adapterOptions);
  return { dir, options, real, d: () => createDispatcher(options), setClock: (value) => { clock = new Date(value); } };
}
function source(c, job, rows, extra = {}, date = '2026-11-17') {
  const raw = { trade_date: date, realm: 'OFFLINE', market: 'REGULAR', source: 'yahoo', rows, ...extra };
  const dir = path.join(c.options.adapterOptions.cachedDir, date);
  const rawPath = path.join(dir, job + '.raw.json');
  write(rawPath, raw);
  const receiptFile = job + '.json';
  const receiptPath = path.join(dir, receiptFile);
  write(receiptPath, { job, trade_date: date, realm: 'OFFLINE', status: 'VERIFIED', rawFile: path.basename(rawPath), rawSha256: sha(fs.readFileSync(rawPath)), publishedAt: date + 'T10:00:00Z', retrievedAt: date + 'T13:00:00Z' });
  return { rawPath, receiptPath };
}
const allRows = [
  { ticker: 'BBCA', broker_code: 'AA', bval: 900, sval: 100, bvol: 900, svol: 100 },
  { ticker: 'BBRI', broker_code: 'BB', bval: 500, sval: 100, bvol: 500, svol: 100 }
];
const fRows = [
  { ticker: 'BBCA', broker_code: 'AA', bval: 250, sval: 30, bvol: 200, svol: 30 },
  { ticker: 'BBRI', broker_code: 'BB', bval: 100, sval: 20, bvol: 100, svol: 20 }
];
function brokerSources(c) {
  source(c, 'broksum-all', allRows, { flow: 'ALL', complete: true, units: 'IDR_SHARES' });
  source(c, 'broksum-foreign', fRows, { flow: 'F', complete: true, units: 'IDR_SHARES' });
}
function brokerJobs() {
  return { 'broksum-all': { enabled: true, timeWIB: '20:00', maxDurationSeconds: 1, retryWindowMinutes: 120 }, 'broksum-foreign': { enabled: true, timeWIB: '20:01', maxDurationSeconds: 1, retryWindowMinutes: 120 }, 'domestic-compile': { enabled: true, timeWIB: '20:02', maxDurationSeconds: 1, retryWindowMinutes: 120 } };
}
function outputRows(c, job) {
  const receipt = read(path.join(c.real.outputDir, '2026-11-17', job + '.json.receipt.json'));
  assert.equal(verifyOutput(receipt), true); return read(receipt.path);
}
function truth(cap = 15000, overrides = {}) {
  return { realm: 'PRODUCTION', known: true, limit: cap, used: 100, remaining: cap - 100, verificationStatus: 'PROVIDER_VERIFIED', observedAt: '2026-11-17T13:00:00Z', date: '2026-11-17', currentDayObligations: 100, ...overrides };
}
function budget(cap = 15000) { return { ...quotaStore.blankDoc(), configuredOperatingCap: cap, reserveFloorWeekday: 5000, reserveFloorWeekend: 0 }; }
function evidence(name, data) { if (EVIDENCE) write(path.join(EVIDENCE, name + '.json'), { realm: 'OFFLINE', data }); }
async function server(fn) {
  const app = http.createServer((req, res) => {
    if (req.url === '/api/admin/schedule-settings') return scheduleApi(req, res);
    if (req.url === '/api/admin/quota-settings') return quotaApi(req, res);
    res.writeHead(404); res.end('{}');
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.address().port;
  const admin = session.createSessionToken({ userId: 'offline-admin', username: 'offline-admin', isAdmin: true });
  const regular = session.createSessionToken({ userId: 'offline-user', username: 'offline-user', isAdmin: false });
  const request = (route, body, token = admin, origin = base) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(base + route, { method: body ? 'PUT' : 'GET', headers: { Cookie: session.SESSION_COOKIE_NAME + '=' + token, Origin: origin, 'Content-Type': 'application/json' } }, (res) => {
      let raw = ''; res.on('data', (v) => { raw += v; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    }); req.on('error', reject); req.end(data);
  });
  try { await fn(request, admin, regular); } finally { await new Promise((resolve) => app.close(resolve)); }
}
const policies = {
  financial: { retryDays: 15, windows: [
    { period: 'Q1', start: '04-25', end: '05-31' }, { period: 'Q2', start: '07-25', end: '08-31' }, { period: 'Q3', start: '10-25', end: '11-30' }, { period: 'Q4', start: '01-25', end: '02-28' }, { period: 'FY', start: '03-01', end: '04-30' }
  ] },
  insider: { tiers: [{ name: 'priority', intervalDays: 1, tickers: ['BBCA'] }, { name: 'weekly', intervalDays: 7, tickers: ['BBRI'] }] }
};

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('HTTP signed Admin -> durable version -> dispatcher -> actual ALL/F domestic transform -> immutable readback', async (t) => {
  const c = setup(t); brokerSources(c);
  await server(async (request) => {
    const schedule = await request('/api/admin/schedule-settings', { version: 0, reason: 'OFFLINE HTTP E2E', actor: 'spoof', patch: { jobs: brokerJobs() } });
    assert.equal(schedule.status, 200, JSON.stringify(schedule.body));
    const quota = await request('/api/admin/quota-settings', { version: 0, reason: 'OFFLINE concurrency', patch: { concurrency: 3 } });
    assert.equal(quota.status, 200);
    const result = await c.d().cycle();
    assert.deepEqual(result.ran.map((r) => r.job), ['broksum-all', 'broksum-foreign', 'domestic-compile']);
    assert.equal(result.scheduleVersion, schedule.body.version); assert.equal(result.quotaVersion, quota.body.version);
    const output = outputRows(c, 'domestic-compile');
    assert.equal(output.rows.find((r) => r.ticker === 'BBCA').bval, 650);
    assert.equal(output.rows.find((r) => r.ticker === 'BBCA').sval, 70);
    assert.equal(result.usage.httpRequests, 0); assert.equal(result.usage.billedUnits, 0);
    const audit = fs.readFileSync(store.AUDIT_PATH, 'utf8').trim().split('\n').map(JSON.parse).at(-1);
    assert.equal(audit.actor, 'offline-admin');
    assert.equal((await c.d().cycle()).ran.length, 0);
    evidence('http-admin-domestic', { result, output, actor: audit.actor });
  });
});

test('HTTP RBAC, invalid/tampered/expired session, CSRF, version conflict and policy validation', async (t) => {
  setup(t);
  await server(async (request, admin, regular) => {
    assert.equal((await request('/api/admin/schedule-settings', null, '')).status, 401);
    assert.equal((await request('/api/admin/schedule-settings', null, admin + 'x')).status, 401);
    assert.equal((await request('/api/admin/schedule-settings', null, session.createSessionToken({ userId: 'expired', isAdmin: true }, { maxAgeSeconds: -10 }))).status, 401);
    assert.equal((await request('/api/admin/schedule-settings', null, regular)).status, 403);
    const patch = { reason: 'test', version: 0, patch: { fundamental: { policy: policies.financial }, insider: { policy: policies.insider } } };
    assert.equal((await request('/api/admin/schedule-settings', patch, admin, 'http://evil.invalid')).status, 403);
    const save = await request('/api/admin/schedule-settings', patch);
    assert.equal(save.status, 200, JSON.stringify(save.body));
    assert.deepEqual(save.body.config.jobs.find((j) => j.key === 'fundamental').policy, policies.financial);
    assert.equal((await request('/api/admin/schedule-settings', patch)).status, 409);
    assert.equal((await request('/api/admin/schedule-settings', { ...patch, version: 1, patch: { fundamental: { policy: { retryDays: 1, windows: [] } } } })).status, 400);
    assert.equal((await request('/api/admin/schedule-settings', { ...patch, version: 1, patch: { insider: { policy: { tiers: [{ name: 'bad', intervalDays: 0, tickers: ['BBCA'] }] } } } })).status, 400);
  });
});

test('HTTP schedule/enabled/retry/concurrency/budget/pause/resume/kill edits apply next cycle', async (t) => {
  const c = setup(t);
  source(c, 'yahoo-ohlcv', [{ ticker: 'BBCA', date: '2026-11-17', open: 9, high: 10, low: 9, close: 10, volume: 1, previousClose: 9 }, { ticker: 'BBRI', date: '2026-11-17', open: 10, high: 10, low: 9, close: 9, volume: 1, previousClose: 10 }]);
  await server(async (request) => {
    async function edit(route, patch) { const doc = route.endsWith('schedule-settings') ? store.get().doc : quotaStore.get().doc; const response = await request(route, { version: doc.version, reason: 'OFFLINE next cycle', patch }); assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.version; }
    await edit('/api/admin/schedule-settings', { 'market-context': { enabled: true, timeWIB: '21:10' } });
    assert.equal((await c.d().cycle()).ran.length, 0);
    await edit('/api/admin/schedule-settings', { 'market-context': { timeWIB: '21:00', enabled: false } });
    assert.equal((await c.d().cycle()).ran.length, 0);
    await edit('/api/admin/schedule-settings', { 'market-context': { enabled: true, retryWindowMinutes: 0 } });
    assert.ok((await c.d().cycle()).blocked.some((b) => b.reason === 'MISSED_RETRY_WINDOW'));
    await edit('/api/admin/schedule-settings', { 'market-context': { retryWindowMinutes: 15 } });
    await edit('/api/admin/quota-settings', { killSwitch: true });
    assert.ok((await c.d().cycle()).blocked.some((b) => b.reason === 'KILL_SWITCH'));
    await edit('/api/admin/quota-settings', { killSwitch: false, pausedServices: { all: true } });
    assert.ok((await c.d().cycle()).blocked.some((b) => b.reason === 'PAUSED'));
    const version = await edit('/api/admin/quota-settings', { pausedServices: { all: false }, concurrency: 1, retryCount: 4, backoffBaseMs: 400, configuredOperatingCap: 6000 });
    const result = await c.d().cycle(); assert.equal(result.quotaVersion, version); assert.equal(result.ran[0].job, 'market-context');
    assert.deepEqual([outputRows(c, 'market-context').advancing, outputRows(c, 'market-context').declining], [1, 1]);
    await edit('/api/admin/schedule-settings', { 'market-context': { timeWIB: '21:01' } });
    assert.equal((await c.d().cycle()).ran.length, 0, 'time/version edits cannot duplicate a completed date/job');
  });
});

test('concurrency is a per-cycle work bound; persisted change releases next dependency without restart', async (t) => {
  const c = setup(t); brokerSources(c); saveJobs(brokerJobs()); saveQuota({ concurrency: 1 });
  const first = await c.d().cycle(); assert.deepEqual(first.ran.map((r) => r.job), ['broksum-all']);
  saveQuota({ concurrency: 3 }); const next = await c.d().cycle(); assert.deepEqual(next.ran.map((r) => r.job), ['broksum-foreign', 'domestic-compile']);
});

test('same-date parents require ledger identity and output hash; stale/hash-corrupt/wrong-flow/unit source blocked', async (t) => {
  const c = setup(t); brokerSources(c); saveJobs(brokerJobs()); saveQuota({ concurrency: 3 });
  const result = await c.d().cycle(); assert.ok(result.ran.some((r) => r.job === 'domestic-compile'));
  const parent = result.ran.find((r) => r.job === 'broksum-all').output;
  const originalRun = c.real.run;
  const staleLedger = read(c.options.statePath);
  const snapshot = '2026-11-17/broksum-all/' + sha('v6-pipeline:2026-11-17:OFFLINE');
  staleLedger.jobs[snapshot].output = { ...parent, date: '2026-11-16' };
  const foreignKey = snapshot.replace('/broksum-all/', '/broksum-foreign/');
  staleLedger.jobs[foreignKey].output = { ...staleLedger.jobs[foreignKey].output, date: '2026-11-16' };
  write(c.options.statePath, staleLedger);
  const staleParents = createDispatcher({ ...c.options, adapters: { ...c.real, run: async (job, ctx) => job === 'domestic-compile' ? originalRun(job, { ...ctx, parents: {} }) : originalRun(job, ctx) } });
  c.setClock('2026-11-17T14:06:00Z');
  const stale = await staleParents.cycle();
  assert.ok(stale.blocked.some((r) => r.reason === 'COMPLETED_OUTPUT_CORRUPT'), JSON.stringify(stale));
  fs.appendFileSync(parent.path, ' ');
  const corruptState = read(c.options.statePath);
  corruptState.jobs[snapshot].status = 'DONE';
  corruptState.jobs[foreignKey].status = 'DONE';
  write(c.options.statePath, corruptState);
  const corrupt = await c.d().cycle(); assert.ok(corrupt.blocked.some((r) => r.reason === 'COMPLETED_OUTPUT_CORRUPT'));
  const ctx = { date: '2026-11-17', snapshot: sha('test'), configVersion: 1, now: new Date('2026-11-17T14:05:00Z') };
  const validRawParents = {
    'broksum-all': publish(path.join(c.dir, 'parent-test', 'all.json'), { flow: 'ALL', units: 'IDR_SHARES', complete: true, rows: allRows }, { job: 'broksum-all', date: ctx.date, snapshot: ctx.snapshot, realm: 'OFFLINE' }),
    'broksum-foreign': publish(path.join(c.dir, 'parent-test', 'foreign.json'), { flow: 'F', units: 'IDR_SHARES', complete: true, rows: fRows }, { job: 'broksum-foreign', date: ctx.date, snapshot: ctx.snapshot, realm: 'OFFLINE' })
  };
  assert.equal((await c.real.run('domestic-compile', { ...ctx, parents: {} })).status, 'BLOCKED_SOURCE_INVALID');
  const badParent = { ...validRawParents, 'broksum-all': { ...validRawParents['broksum-all'], date: '2026-11-16' } };
  assert.equal((await c.real.run('domestic-compile', { ...ctx, parents: badParent })).status, 'BLOCKED_SOURCE_INVALID');
  for (const extra of [{ flow: 'ALL', units: 'IDR_SHARES', complete: true }, { flow: 'F', units: 'LOT', complete: true }, { flow: 'F', units: 'IDR_SHARES', complete: false }]) {
    source(c, 'broksum-foreign', fRows, extra);
    assert.equal((await c.real.run('broksum-foreign', ctx)).status, 'BLOCKED_SOURCE_INVALID');
  }
  const changed = source(c, 'broksum-foreign', fRows, { flow: 'F', units: 'IDR_SHARES', complete: true });
  fs.appendFileSync(changed.rawPath, ' ');
  assert.equal((await c.real.run('broksum-foreign', ctx)).status, 'BLOCKED_SOURCE_INVALID');
});

test('pending publication retries with jitter/backoff; retry config change effective next cycle', async (t) => {
  const c = setup(t, '2026-11-17T10:00:00Z'); saveJobs({ 'yahoo-ohlcv': { enabled: true, retryWindowMinutes: 30 } }); saveQuota({ retryCount: 0 });
  const first = await c.d().cycle(); assert.equal(first.blocked[0].reason, 'PENDING_PROVIDER');
  c.setClock('2026-11-17T10:00:02Z'); assert.ok((await c.d().cycle()).blocked.some((b) => b.reason === 'RETRY_EXHAUSTED'));
  saveQuota({ retryCount: 2, backoffBaseMs: 400 });
  const retry = await c.d().cycle(); assert.equal(retry.blocked[0].reason, 'PENDING_PROVIDER');
  assert.ok((await c.d().cycle()).blocked.some((b) => b.reason === 'BACKOFF'));
  assert.equal(retryDelayMs(2, { backoffBaseMs: 400 }, () => 0), 600);
  assert.equal(retryDelayMs(2, { backoffBaseMs: 400 }, () => 1), 1000);
  c.setClock('2026-11-17T10:00:04Z');
  source(c, 'yahoo-ohlcv', [{ ticker: 'BBCA', date: '2026-11-17', open: 9, high: 10, low: 9, close: 10, volume: 1, previousClose: 9 }]);
  const receipt = path.join(c.real.cachedDir, '2026-11-17', 'yahoo-ohlcv.json'); const r = read(receipt); write(receipt, { ...r, retrievedAt: '2026-11-17T10:00:03Z' });
  assert.equal((await c.d().cycle()).ran[0].job, 'yahoo-ohlcv');
});

test('WIB 17:00 boundary, Friday holiday, weekend, midnight and 16-Nov MISSED history preserved', async (t) => {
  const c = setup(t, '2026-11-17T09:59:59Z'); saveJobs({ 'yahoo-ohlcv': { enabled: true } });
  assert.equal((await c.d().cycle()).blocked.length, 0);
  c.setClock('2026-11-17T10:00:00Z'); assert.equal((await c.d().cycle()).blocked[0].reason, 'PENDING_PROVIDER');
  const oldKey = '2026-11-16/manual-separate'; const state = c.d().status(); state.jobs[oldKey] = { date: '2026-11-16', status: 'MISSED', manualCatchup: 'SEPARATE_NOT_EXECUTED' }; write(c.options.statePath, state);
  c.setClock('2026-11-17T17:00:00Z'); assert.equal((await c.d().cycle()).date, '2026-11-18');
  assert.deepEqual(c.d().status().jobs[oldKey], state.jobs[oldKey]);
  c.setClock('2026-11-20T10:00:00Z'); const holiday = createDispatcher({ ...c.options, holidays: ['2026-11-20'] }); assert.equal((await holiday.cycle()).blocked.length, 0);
  c.setClock('2026-11-21T10:00:00Z'); assert.equal((await c.d().cycle()).blocked.length, 0);
});

function child(configFile) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'helpers', 'v6-dispatcher-child.cjs'), configFile], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; p.stdout.on('data', (x) => { stdout += x; }); p.stderr.on('data', (x) => { stderr += x; }); p.on('error', reject); p.on('exit', (code) => { if (code !== 0) reject(new Error(stderr)); else resolve(JSON.parse(stdout)); });
  });
}
test('two actual processes race one ledger: one invocation; fresh process restart/version edit does not duplicate', async (t) => {
  const c = setup(t); source(c, 'yahoo-ohlcv', [{ ticker: 'BBCA', date: '2026-11-17', open: 9, high: 10, low: 9, close: 10, volume: 1, previousClose: 9 }]); saveJobs({ 'market-context': { enabled: true, timeWIB: '21:00' } });
  const file = path.join(c.dir, 'child.json'); write(file, { statePath: c.options.statePath, adapterOptions: c.options.adapterOptions, instant: '2026-11-17T14:05:00Z', legacyGuard: false, delay: 200 });
  const results = await Promise.all([child(file), child(file)]);
  assert.equal(results.filter((r) => r.status === 'LOCKED').length, 1);
  assert.equal(fs.readFileSync(path.join(c.dir, 'invocations.jsonl'), 'utf8').trim().split('\n').length, 1);
  saveJobs({ 'market-context': { timeWIB: '21:01' } }); assert.equal((await child(file)).ran.length, 0);
  assert.equal(fs.readFileSync(path.join(c.dir, 'invocations.jsonl'), 'utf8').trim().split('\n').length, 1);
  evidence('process-race', results);
});

test('crash after pending output publication recovers verified receipt without adapter reexecution', async (t) => {
  const c = setup(t); saveJobs({ 'market-context': { enabled: true, timeWIB: '21:00' } });
  const snapshot = sha('v6-pipeline:2026-11-17:OFFLINE'); const key = '2026-11-17/market-context/' + snapshot;
  const receipt = publish(path.join(c.real.outputDir, '2026-11-17', 'market-context.json'), { advancing: 1 }, { job: 'market-context', date: '2026-11-17', snapshot, realm: 'OFFLINE' });
  write(c.options.statePath, { schemaVersion: 1, jobs: { [key]: { status: 'RUNNING', attempts: 1 } }, usage: {}, paidGuard: null });
  let called = false;
  const d = createDispatcher({ ...c.options, adapters: { ...c.real, run: async () => { called = true; throw new Error('unexpected'); } } });
  const result = await d.cycle(); assert.equal(result.ran[0].recovered, true); assert.equal(called, false); assert.equal(d.status().jobs[key].output.sha256, receipt.sha256);
});

test('429 and auth failures persist paid quarantine across restart and quota pause/resume/version edits', async (t) => {
  for (const status of [429, 401, 403]) {
    const c = setup(t); saveJobs({ 'broksum-all': { enabled: true, timeWIB: '20:00', retryWindowMinutes: 120 } });
    const d = createDispatcher({ ...c.options, adapters: { ...c.real, run: async () => ({ status: 'FAILED', httpStatus: status, retryable: true, httpRequests: 0, billedUnits: 0 }) } });
    await d.cycle(); assert.equal(d.status().paidGuard.status, status);
    saveQuota({ pausedServices: { broksum: true } }); await c.d().cycle(); saveQuota({ pausedServices: { broksum: false } });
    assert.ok((await c.d().cycle()).blocked.some((b) => b.reason === 'PERSISTENT_PAID_GUARD'));
  }
});

test('OFFLINE caps 1000/6000/12752/15000, unknown/null/stale quota, obligations, endpoint cost and HTTP vs units', async (t) => {
  setup(t); const instant = new Date('2026-11-17T13:05:00Z'); const cost = { verified: true, httpRequests: 1, billedUnits: 3 };
  const results = [];
  for (const cap of [1000, 6000, 12752, 15000]) {
    const q = budget(cap); const result = paidDecision({}, q, truth(cap), {}, instant, cost); results.push({ cap, realm: 'OFFLINE', result });
    assert.equal(result.ok, cap >= 6000); if (result.ok) { assert.equal(result.httpRequests, 1); assert.equal(result.billedUnits, 3); }
    assert.equal(paidDecision({}, q, truth(cap, { realm: 'OFFLINE' }), {}, instant, cost).reason, 'QUOTA_UNKNOWN');
  }
  assert.equal(paidDecision({}, budget(), truth(15000, { remaining: null }), {}, instant, cost).reason, 'QUOTA_UNKNOWN');
  assert.equal(paidDecision({}, budget(), truth(15000, { observedAt: '2026-11-16T13:00:00Z' }), {}, instant, cost).reason, 'QUOTA_STALE_OR_UNVERIFIED');
  assert.equal(paidDecision({}, budget(), truth(15000, { currentDayObligations: null }), {}, instant, cost).reason, 'BUDGET_OBLIGATIONS_UNKNOWN');
  assert.equal(paidDecision({}, budget(), truth(), {}, instant, null).reason, 'ENDPOINT_COST_UNKNOWN');
  assert.equal(paidDecision({}, budget(1000), truth(), {}, instant, cost).ok, false, 'new cap immediately constrains budget');
  evidence('offline-quota-scenarios', results);
});

test('Admin financial windows and insider tiers gate actual next-cycle decisions without asserting publication', async (t) => {
  const c = setup(t, '2026-11-17T16:05:00Z');
  saveJobs({ fundamental: { enabled: true, timeWIB: '23:00', policy: policies.financial }, insider: { enabled: true, timeWIB: '22:40', retryWindowMinutes: 60, policy: policies.insider } });
  const empty = await c.d().cycle(); assert.ok(empty.blocked.some((b) => b.reason === 'PENDING_PUBLICATION_WINDOW')); assert.ok(empty.blocked.some((b) => b.reason === 'PENDING_DISCLOSURE'));
  const items = [{ kind: 'financial', ticker: 'BBCA', period: 'Q3', fiscalYear: 2026, publishedAt: '2026-11-16', nextDueDate: '2026-11-17' }, { kind: 'insider', ticker: 'BBCA', publishedAt: '2026-11-16', nextDueDate: '2026-11-17' }];
  const next = createDispatcher({ ...c.options, readDisclosures: () => items }); assert.ok((await next.cycle()).blocked.some((b) => b.reason === 'BLOCKED_UNPROVEN_ADAPTER'));
  for (const [period, date] of [['Q1', '2026-04-30'], ['Q2', '2026-07-31'], ['Q3', '2026-10-31'], ['Q4', '2027-01-31'], ['FY', '2027-03-31']]) assert.equal(policyDue({ key: 'fundamental', policy: policies.financial }, date, [{ kind: 'financial', ticker: 'BBCA', period, publishedAt: date, nextDueDate: date }]).ok, true);
  assert.equal(policyDue({ key: 'insider', policy: policies.insider }, '2026-11-17', [{ kind: 'insider', ticker: 'BBRI', publishedAt: '2026-11-10', nextDueDate: '2026-11-17', lastCheckedDate: '2026-11-16' }]).ok, false);
});

test('Top5 reads same canonical Top20 snapshot, exact subset, and tamper rejected; no independent scanner', async (t) => {
  const c = setup(t); const rankEngine = require('../lib/saham-potensial-engine');
  const rows = ['BBCA', 'BBRI', 'BMRI', 'BBNI', 'TLKM', 'ASII'].map((ticker, i) => ({ ticker, score: 90 - i, rr: 1.5 }));
  const ranking = rows.map((r) => r.ticker);
  const hash = rankEngine.buildSnapshotContentHash({ session_date: '2026-11-17', score_version: rankEngine.SCORE_ALGORITHM_VERSION, horizon: rankEngine.HOLDING_HORIZON_LABEL, rows, ranking });
  const top20 = rows.map((r, i) => ({ ...r, rank: i + 1, snapshot_id: hash.snapshot_id }));
  const canonicalSnapshot = { session_date: '2026-11-17', score_version: rankEngine.SCORE_ALGORITHM_VERSION, horizon: rankEngine.HOLDING_HORIZON_LABEL, content_hash: hash.content_hash, snapshot_id: hash.snapshot_id, content_hash_version: rankEngine.CONTENT_HASH_VERSION, universe: ranking.slice().sort(), ranking, row_digests: Object.fromEntries(rows.map((r) => [r.ticker, rankEngine.buildRowContentDigest(r)])), top20 };
  // Row digest excludes rank/snapshot stamps, matching the real engine contract.
  assert.equal(require('../lib/saham-potensial-snapshot-store').recomputeContentHash(canonicalSnapshot), hash.content_hash);
  const snapshot = sha('v6-pipeline:2026-11-17:OFFLINE');
  const parent = publish(path.join(c.real.outputDir, '2026-11-17', 'top20.json'), { canonicalSnapshot }, { job: 'top20', date: '2026-11-17', snapshot, realm: 'OFFLINE' });
  const ctx = { date: '2026-11-17', snapshot, configVersion: 1, now: new Date('2026-11-17T15:15:00Z'), parents: { top20: parent } };
  const result = await c.real.run('top5', ctx); assert.equal(result.status, 'DONE', result.detail); assert.deepEqual(read(result.output.path).rows, top20.slice(0, 5));
  fs.appendFileSync(parent.path, ' '); assert.equal((await c.real.run('top5', ctx)).status, 'BLOCKED_SOURCE_INVALID');
});

test('legacy jobs, quota burner and Telegram remain disabled even when desired enabled; PRODUCTION rejects OFFLINE receipts', async (t) => {
  const c = setup(t); const doc = store.get().doc;
  for (const key of ['telegram', 'quota-backfill', 'coordinated-pipeline', 'daytrade-producer', 'fastwatcher']) doc.jobs[key].enabled = true;
  write(store.STORE_PATH, doc); assert.equal((await c.d().cycle()).ran.length, 0);
  brokerSources(c); const production = createAdapters({ ...c.options.adapterOptions, realm: 'PRODUCTION' });
  assert.equal((await production.run('broksum-all', { date: '2026-11-17', snapshot: 'test', now: new Date('2026-11-17T14:05:00Z') })).status, 'BLOCKED_SOURCE_INVALID');
});

for (const [label, patch] of Object.entries({ negativeClose: { close: -1 }, negativeVolume: { volume: -3 }, inverted: { high: 5, low: 20 }, openOutside: { open: 30 }, closeOutside: { close: 30 }, zeroPrice: { low: 0 }, missingVolume: { volume: null }, wrongDate: { date: '2026-11-16' }, wrongTicker: { ticker: '../BBCA' } })) {
  test('followup invalid candle ' + label + ' cannot complete or release dependency', async (t) => {
    const c = setup(t);
    source(c, 'yahoo-ohlcv', [{ ticker: 'BBCA', date: '2026-11-17', open: 10, high: 12, low: 8, close: 11, volume: 0, ...patch }], { source: 'yahoo' });
    saveJobs({ 'yahoo-ohlcv': { enabled: true, timeWIB: '20:00', retryWindowMinutes: 120 }, lifecycle: { enabled: true, timeWIB: '20:30', retryWindowMinutes: 120 } });
    const result = await c.d().cycle();
    assert.ok(result.blocked.some((r) => r.job === 'yahoo-ohlcv' && r.reason === 'INVALID_OUTPUT'), JSON.stringify(result));
    assert.ok(result.blocked.some((r) => r.job === 'lifecycle' && r.reason === 'DEPENDENCY_UNVERIFIED'));
    assert.equal(result.ran.length, 0);
  });
}
for (const mode of ['exhausted', 'expired']) {
  test('followup committed output recovers when ' + mode, async (t) => {
    const c = setup(t); saveJobs({ 'market-context': { enabled: true, timeWIB: '21:00', retryWindowMinutes: mode === 'expired' ? 0 : 15 } });
    saveQuota({ retryCount: 0 });
    const snapshot = sha('v6-pipeline:2026-11-17:OFFLINE'); const key = '2026-11-17/market-context/' + snapshot;
    const receipt = publish(path.join(c.real.outputDir, '2026-11-17', 'market-context.json'), { advancing: 1 }, { job: 'market-context', date: '2026-11-17', snapshot, realm: 'OFFLINE' });
    write(c.options.statePath, { schemaVersion: 1, jobs: { [key]: { status: 'RUNNING', attempts: 1, job: 'market-context', date: '2026-11-17', snapshot } }, usage: {} });
    let calls = 0;
    const d = createDispatcher({ ...c.options, adapters: { ...c.real, run: async () => { calls++; throw Error('must not run'); } } });
    const result = await d.cycle();
    assert.equal(result.ran[0]?.recovered, true, JSON.stringify(result));
    assert.equal(calls, 0); assert.equal(d.status().jobs[key].output.sha256, receipt.sha256);
    assert.equal((await d.cycle()).ran.length, 0);
  });
}
test('followup explicit zero reserve survives Admin store and diagnostic minimum caps', (t) => {
  setup(t); saveQuota({ reserveFloorWeekday: 0, configuredOperatingCap: 1000 });
  const q = quotaStore.get().doc;
  assert.equal(q.reserveFloorWeekday, 0);
  assert.equal(require('../lib/quota-policy-bridge').getEffectivePolicy(new Date('2026-11-17T13:05:00Z')).reserveFloorWeekday, 0);
  for (const [limit, cap, available] of [[1000, 1000, 1000], [6000, 1000, 1000], [1000, 6000, 1000], [1000, 0, 0]]) {
    const result = paidDecision({}, { ...q, configuredOperatingCap: cap }, truth(limit, { used: 0, remaining: limit, currentDayObligations: 0 }), {}, new Date('2026-11-17T13:05:00Z'), { verified: true, httpRequests: 1, billedUnits: 1 });
    assert.equal(result.floor, 0); assert.equal(result.available, available); assert.equal(result.ok, available > 0);
  }
  assert.equal(paidDecision({}, q, null, {}, new Date(), null).reason, 'QUOTA_UNKNOWN');
});

test('followup candle zero volume is observed, never inferred NO_TRADE; source and duplicates rejected', async (t) => {
  const c = setup(t);
  const row = { ticker: 'BBCA', date: '2026-11-17', open: 10, high: 10, low: 10, close: 10, volume: 0 };
  const ctx = { date: row.date, snapshot: sha('fixture'), now: new Date('2026-11-17T14:05:00Z') };
  for (const job of ['yahoo-ohlcv', 'ihsg']) {
    const candle = { ...row, ticker: job === 'ihsg' ? '^JKSE' : row.ticker };
    source(c, job, [candle]);
    const good = await c.real.run(job, ctx);
    assert.equal(good.status, 'DONE');
    assert.deepEqual(read(good.output.path).rows, [candle]);
    source(c, job, [candle, candle]);
    assert.equal((await c.real.run(job, ctx)).status, 'INVALID_OUTPUT');
    source(c, job, [candle], { source: 'unknown' });
    assert.equal((await c.real.run(job, ctx)).status, 'INVALID_OUTPUT');
  }
});
for (const conflict of ['missing', 'hash', 'date', 'job', 'snapshot', 'realm', 'json']) {
  test('followup expired recovery rejects ' + conflict + ' without execution', async (t) => {
    const c = setup(t); saveJobs({ 'market-context': { enabled: true, timeWIB: '21:00', retryWindowMinutes: 0 } });
    const snapshot = sha('v6-pipeline:2026-11-17:OFFLINE'); const key = '2026-11-17/market-context/' + snapshot;
    const file = path.join(c.real.outputDir, '2026-11-17', 'market-context.json');
    const receipt = publish(file, { advancing: 1 }, { job: 'market-context', date: '2026-11-17', snapshot, realm: 'OFFLINE' });
    if (conflict === 'missing') fs.unlinkSync(file + '.receipt.json');
    else if (conflict === 'hash') fs.appendFileSync(receipt.path, ' ');
    else if (conflict === 'json') fs.writeFileSync(file + '.receipt.json', '{');
    else write(file + '.receipt.json', { ...receipt, [conflict]: 'conflicting' });
    write(c.options.statePath, { schemaVersion: 1, jobs: { [key]: { status: 'RUNNING', attempts: 1 } }, usage: {} });
    let calls = 0;
    const d = createDispatcher({ ...c.options, adapters: { ...c.real, run: async () => { calls++; return { status: 'DONE' }; } } });
    const result = await d.cycle();
    assert.equal(calls, 0); assert.equal(result.ran.length, 0);
    assert.equal(result.blocked[0].reason, 'RECOVERY_OUTPUT_MISSING_OR_CONFLICTING');
    assert.notEqual(d.status().jobs[key].status, 'DONE');
  });
}

test('PRODUCTION dispatcher never invokes an injected paid adapter while quota truth is unknown', async (t) => {
  const c = setup(t); saveJobs({ 'broksum-all': { enabled: true, timeWIB: '20:00', retryWindowMinutes: 120 } });
  const productionAdapter = createAdapters({ ...c.options.adapterOptions, realm: 'PRODUCTION' });
  let calls = 0;
  const d = createDispatcher({ ...c.options, adapters: { ...productionAdapter, run: async () => { calls++; return { status: 'DONE', httpRequests: 0, billedUnits: 0 }; } } });
  const result = await d.cycle();
  assert.equal(calls, 0);
  assert.ok(result.blocked.some((entry) => entry.job === 'broksum-all' && entry.reason === 'PAID_ADAPTER_NOT_AUTHORIZED'));
});
