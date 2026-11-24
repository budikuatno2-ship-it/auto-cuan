'use strict';
// Actual loopback Admin HTTP handlers and dispatcher; all state and inputs isolated.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'v6-night-preset-'));
Object.assign(process.env, {
  ADMIN_SCHEDULE_CONFIG_PATH: path.join(ROOT, 'schedule.json'),
  ADMIN_SCHEDULE_HISTORY_PATH: path.join(ROOT, 'history'),
  ADMIN_SCHEDULE_AUDIT_PATH: path.join(ROOT, 'audit.jsonl'),
  QUOTA_OPS_CONFIG_PATH: path.join(ROOT, 'quota.json'),
  QUOTA_OPS_AUDIT_PATH: path.join(ROOT, 'quota-audit.jsonl'),
  SCHEDULE_LEGACY_ACTIVE_PATH: path.join(ROOT, 'legacy.json'),
  SESSION_SECRET: 'isolated-night-pipeline-fixture-session-secret'
});
const store = require('../lib/admin-schedule-store');
const quota = require('../lib/quota-config-store');
const control = require('../lib/schedule-control-plane');
const { createDispatcher } = require('../lib/v6-scheduler-dispatcher.cjs');
const { createAdapters, atomicWrite, publish, sha, verifyOutput } = require('../lib/v6-scheduler-adapters.cjs');
const session = require('../lib/admin-session');
const api = require('../api/admin/schedule-settings');
const rankEngine = require('../lib/saham-potensial-engine');
const DATE = '2026-11-19';
const EVIDENCE = process.env.V6_NIGHT_TEST_EVIDENCE_DIR;
const evidence = (name, data) => { if (EVIDENCE) atomicWrite(path.join(EVIDENCE, name + '.json'), { realm: 'OFFLINE', fixtureOnly: true, data }); };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const nightKeys = ['broksum-all', 'broksum-foreign', 'domestic-compile', 'accumulation', 'bandarmologi', 'top20', 'top5'];
function setup() {
  const dir = fs.mkdtempSync(path.join(ROOT, 'case-'));
  const doc = store.normalizeDoc({});
  for (const job of Object.values(doc.jobs)) job.enabled = nightKeys.includes(job.key);
  atomicWrite(store.STORE_PATH, doc);
  atomicWrite(quota.STORE_PATH, { ...quota.blankDoc(), concurrency: 10 });
  atomicWrite(process.env.SCHEDULE_LEGACY_ACTIVE_PATH, { executors: Object.fromEntries(control.LEGACY_EXECUTORS.map(e => [e.name, 'RETIRED'])) });
  let clock = new Date(DATE + 'T13:29:59Z');
  const adapterOptions = { realm: 'OFFLINE', cachedDir: path.join(dir, 'cache'), outputDir: path.join(dir, 'outputs') };
  const adapters = createAdapters(adapterOptions);
  const options = { statePath: path.join(dir, 'worker.json'), adapterOptions, now: () => new Date(clock), legacyGuard: false, random: () => 0.5 };
  const worker = () => createDispatcher(options);
  return { dir, doc, options, adapters, worker, clock: time => { clock = new Date(DATE + 'T' + time + 'Z'); } };
}
function source(c, job, rows, extra = {}) {
  const raw = { trade_date: DATE, realm: 'OFFLINE', market: 'REGULAR', source: 'yahoo', rows, ...extra };
  const dir = path.join(c.options.adapterOptions.cachedDir, DATE);
  atomicWrite(path.join(dir, job + '.raw.json'), raw);
  atomicWrite(path.join(dir, job + '.json'), { job, trade_date: DATE, realm: 'OFFLINE', status: 'VERIFIED', rawFile: job + '.raw.json', rawSha256: sha(fs.readFileSync(path.join(dir, job + '.raw.json'))), publishedAt: DATE + 'T10:00:00Z', retrievedAt: DATE + 'T10:00:00Z' });
}
function brokerSources(c) {
  source(c, 'broksum-all', [{ ticker: 'BBCA', broker_code: 'AA', bval: 900, sval: 100, bvol: 900, svol: 100 }], { flow: 'ALL', complete: true, units: 'IDR_SHARES' });
  source(c, 'broksum-foreign', [{ ticker: 'BBCA', broker_code: 'AA', bval: 250, sval: 30, bvol: 200, svol: 30 }], { flow: 'F', complete: true, units: 'IDR_SHARES' });
}
function canonical(rr = 1.5) {
  const rows = ['BBCA', 'BBRI', 'BMRI', 'BBNI', 'TLKM', 'ASII'].map((ticker, i) => ({ ticker, score: 90 - i, rr }));
  const ranking = rows.map(r => r.ticker);
  const hash = rankEngine.buildSnapshotContentHash({ session_date: DATE, score_version: rankEngine.SCORE_ALGORITHM_VERSION, horizon: rankEngine.HOLDING_HORIZON_LABEL, rows, ranking });
  return { session_date: DATE, score_version: rankEngine.SCORE_ALGORITHM_VERSION, horizon: rankEngine.HOLDING_HORIZON_LABEL, content_hash: hash.content_hash, snapshot_id: hash.snapshot_id, content_hash_version: rankEngine.CONTENT_HASH_VERSION, universe: ranking.slice().sort(), ranking, row_digests: Object.fromEntries(rows.map(r => [r.ticker, rankEngine.buildRowContentDigest(r)])), top20: rows.map((r, i) => ({ ...r, rank: i + 1, snapshot_id: hash.snapshot_id })) };
}
async function adminServer(fn) {
  const app = http.createServer((req, res) => api(req, res));
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.address().port;
  const token = session.createSessionToken({ userId: 'night-fixture-admin', username: 'night-fixture-admin', isAdmin: true });
  const request = (body, auth = token) => new Promise((resolve, reject) => {
    const req = http.request(base + '/api/admin/schedule-settings', { method: body ? 'PUT' : 'GET', headers: { Cookie: session.SESSION_COOKIE_NAME + '=' + auth, Origin: base, 'Content-Type': 'application/json' } }, res => {
      let raw = ''; res.on('data', chunk => { raw += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  try { await fn(request); } finally { await new Promise(resolve => app.close(resolve)); }
}
function seedDerivedFixture(c, job, parents = {}) {
  const state = c.worker().status();
  const snapshot = sha('v6-pipeline:' + DATE + ':OFFLINE');
  const rows = job === 'yahoo-ohlcv' ? [{ ticker: 'BBCA', date: DATE, open: 9, high: 10, low: 9, close: 10, volume: 1 }] : [];
  const receipt = publish(path.join(c.adapters.outputDir, DATE, job + '.json'), { parents, fixtureOnly: true, source: 'yahoo', rows }, { date: DATE, job, snapshot, realm: 'OFFLINE' });
  state.jobs[DATE + '/' + job + '/' + snapshot] = { status: 'DONE', output: receipt, fixtureOnly: true };
  atomicWrite(c.options.statePath, state);
  return receipt;
}
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('network guard blocks external transports before I/O; Admin UI permits explicit earlier overrides', () => {
  assert.throws(() => require('node:net').connect({ host: 'example.invalid', port: 443 }), /LOCAL_E2E_EXTERNAL_NETWORK_BLOCKED/);
  assert.throws(() => require('node:dns').lookup('example.invalid', () => {}), /LOCAL_E2E_EXTERNAL_NETWORK_BLOCKED/);
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-console-runtime.js'), 'utf8');
  assert.ok(ui.includes('default 20:30 WIB; override Admin dipertahankan'));
  assert.ok(!ui.includes('min="20:00"'));
});

test('night preset: new defaults, mandatory DAG, dependency serialization and safe earlier schema reads', () => {
  setup();
  const doc = store.normalizeDoc({});
  assert.equal(doc.jobs['broksum-all'].timeWIB, '20:30');
  assert.equal(doc.jobs['broksum-foreign'].timeWIB, '20:40');
  assert.deepEqual(doc.jobs['domestic-compile'].dependsOn, ['broksum-all', 'broksum-foreign']);
  assert.ok(doc.jobs.top20.dependsOn.includes('yahoo-ohlcv'));
  assert.ok(doc.jobs.top20.dependsOn.includes('accumulation'));
  assert.equal(store.listCollisions(doc).length, 0, 'gated ALL/F overlap is serialized, not rejected');
  const old = { schemaVersion: 1, version: 7, jobs: { 'broksum-all': { timeWIB: '19:30', enabled: false }, 'broksum-foreign': { timeWIB: '21:00' }, 'domestic-compile': { dependsOn: [] }, fastwatcher: { enabled: true } } };
  atomicWrite(store.STORE_PATH, old); const before = fs.readFileSync(store.STORE_PATH, 'utf8');
  const migrated = store.get().doc;
  assert.equal(migrated.version, 7);
  assert.equal(migrated.jobs['broksum-all'].timeWIB, '19:30');
  assert.equal(migrated.jobs['broksum-all'].enabled, false);
  assert.equal(migrated.jobs['broksum-foreign'].timeWIB, '21:00');
  assert.ok(migrated.jobs['domestic-compile'].dependsOn.includes('broksum-foreign'));
  assert.equal(migrated.jobs.fastwatcher.enabled, false);
  assert.equal(fs.readFileSync(store.STORE_PATH, 'utf8'), before, 'read never persists migration or silently changes Admin values');
  evidence('settings-and-earlier-schema', { defaults: doc, persistedEarlierSchema: old, effective: migrated, diskUnchanged: true });
});

test('HTTP authenticated Admin -> version -> real worker time/order/readback; missing derived parents block FINAL', async () => {
  const c = setup(); brokerSources(c);
  await adminServer(async request => {
    assert.equal((await request(null, '')).status, 401);
    const get = await request(null); assert.equal(get.status, 200);
    const save = await request({ version: 0, reason: 'night pipeline isolated E2E', patch: { jobs: { 'broksum-all': { timeWIB: '20:30' }, 'broksum-foreign': { timeWIB: '20:40' } } } });
    assert.equal(save.status, 200, JSON.stringify(save.body));
    assert.equal(save.body.readbackOk, true);
    assert.equal(read(store.STORE_PATH).version, save.body.version);
    const cycles = [];
    cycles.push(await c.worker().cycle()); assert.equal(cycles.at(-1).ran.length, 0);
    c.clock('13:30:00'); cycles.push(await c.worker().cycle()); assert.deepEqual(cycles.at(-1).ran.map(r => r.job), ['broksum-all']);
    c.clock('13:39:59'); cycles.push(await c.worker().cycle()); assert.equal(cycles.at(-1).ran.length, 0);
    c.clock('13:40:00'); cycles.push(await c.worker().cycle()); assert.deepEqual(cycles.at(-1).ran.map(r => r.job), ['broksum-foreign']);
    c.clock('14:20:00'); cycles.push(await c.worker().cycle()); assert.deepEqual(cycles.at(-1).ran.map(r => r.job), ['domestic-compile']);
    const domestic = read(cycles.at(-1).ran[0].output.path); assert.equal(domestic.rows[0].bval, 650);
    c.clock('14:35:00'); cycles.push(await c.worker().cycle()); assert.deepEqual(cycles.at(-1).ran.map(r => r.job), ['accumulation'], JSON.stringify(cycles.at(-1)));
    const accumulation = read(cycles.at(-1).ran[0].output.path);
    assert.equal(accumulation.units, 'IDR_SHARES');
    assert.equal(accumulation.computed_ticker_count, 1);
    assert.equal(accumulation.foreign_unconfirmed_count, 0);
    assert.equal(accumulation.rows[0].ticker, 'BBCA');
    assert.equal(accumulation.rows[0].windows['1H'].all.net_val, 800);
    c.clock('14:55:00'); cycles.push(await c.worker().cycle()); assert.deepEqual(cycles.at(-1).ran.map(r => r.job), ['bandarmologi'], JSON.stringify(cycles.at(-1)));
    const bandarmologi = read(cycles.at(-1).ran[0].output.path);
    assert.equal(bandarmologi.units, 'IDR_SHARES');
    assert.equal(bandarmologi.computed_ticker_count, 1);
    assert.equal(bandarmologi.rows[0].ticker, 'BBCA');
    assert.equal(bandarmologi.rows[0].bs_ratio_3_1h, 99);
    assert.equal(bandarmologi.rows[0].verdict, 'Akumulasi Kuat');
    evidence('real-derived-adapters', { accumulation, bandarmologi });
    c.clock('15:05:00'); cycles.push(await c.worker().cycle()); assert.ok(cycles.at(-1).blocked.some(b => b.job === 'top20' && b.reason === 'DEPENDENCY_UNVERIFIED'));
    c.clock('15:15:00'); cycles.push(await c.worker().cycle()); assert.ok(cycles.at(-1).blocked.some(b => b.job === 'top5' && b.reason === 'DEPENDENCY_UNVERIFIED'));
    for (const cycle of cycles) { assert.equal(cycle.scheduleVersion, save.body.version); assert.equal(cycle.usage.httpRequests, 0); assert.equal(cycle.usage.billedUnits, 0); }
    const audit = fs.readFileSync(store.AUDIT_PATH, 'utf8').trim().split('\n').map(JSON.parse).at(-1); assert.equal(audit.actor, 'night-fixture-admin');
    evidence('http-time-order-missing-parents', { savedVersion: save.body.version, persisted: read(store.STORE_PATH), cycles, domestic, worker: c.worker().status(), audit });
  });
});

test('verified fixture parents release FINAL Top20 then exact immutable Top5; bad R/R is rejected', async () => {
  const c = setup(); brokerSources(c);
  const doc = store.get().doc; doc.jobs['yahoo-ohlcv'].enabled = true;
  atomicWrite(store.STORE_PATH, doc);
  source(c, 'yahoo-ohlcv', [{ ticker: 'BBCA', date: DATE, open: 9, high: 10, low: 9, close: 10, volume: 1 }]);
  c.clock('10:00:00'); await c.worker().cycle();
  c.clock('13:30:00'); await c.worker().cycle(); c.clock('13:40:00'); await c.worker().cycle(); c.clock('14:20:00'); await c.worker().cycle();
  const parents = Object.fromEntries(Object.values(c.worker().status().jobs).filter(r => r.output).map(r => [r.output.job, r.output]));
  parents.accumulation = seedDerivedFixture(c, 'accumulation', parents);
  parents.bandarmologi = seedDerivedFixture(c, 'bandarmologi', { accumulation: parents.accumulation });
  const snapshot = canonical(); source(c, 'top20', snapshot.top20, { canonicalSnapshot: snapshot });
  c.clock('15:05:00'); const final = await c.worker().cycle(); assert.deepEqual(final.ran.map(r => r.job), ['top20'], JSON.stringify(final));
  c.clock('15:15:00'); const subset = await c.worker().cycle(); assert.deepEqual(subset.ran.map(r => r.job), ['top5']);
  const top20 = read(final.ran[0].output.path), top5 = read(subset.ran[0].output.path);
  assert.deepEqual(top5.rows, top20.canonicalSnapshot.top20.slice(0, 5));
  assert.equal(top5.rankingSnapshot, snapshot.snapshot_id); assert.equal(top5.top20OutputHash, final.ran[0].output.sha256);
  assert.ok(top5.rows.every(r => r.rr >= 1.5)); assert.equal(verifyOutput(final.ran[0].output), true);
  const unchanged = fs.readFileSync(final.ran[0].output.path, 'utf8'); assert.equal((await c.worker().cycle()).ran.length, 0); assert.equal(fs.readFileSync(final.ran[0].output.path, 'utf8'), unchanged);
  const bad = canonical(1.49); source(c, 'top20', bad.top20, { canonicalSnapshot: bad });
  const badResult = await c.adapters.run('top20', { date: DATE, snapshot: final.snapshot, now: new Date(DATE + 'T15:05:00Z'), parents });
  assert.equal(badResult.status, 'BLOCKED_SOURCE_INVALID');
  evidence('final-ranking-fixture-handoff', { derivedComputationExecuted: false, seededFixtureParents: ['accumulation', 'bandarmologi'], final, subset, top20, top5, badRR: badResult });
});

test('every missing, stale or hash-corrupt mandatory parent blocks FINAL before adapter invocation', async () => {
  const cases = [];
  for (const missing of store.normalizeDoc({}).jobs.top20.dependsOn) {
    for (const mode of ['missing', 'stale', 'corrupt']) {
      const c = setup();
      const doc = store.get().doc;
      for (const job of Object.values(doc.jobs)) job.enabled = job.key === 'top20';
      atomicWrite(store.STORE_PATH, doc);
      c.clock('15:05:00');
      await c.worker().cycle();
      for (const dep of doc.jobs.top20.dependsOn) seedDerivedFixture(c, dep);
      const state = c.worker().status();
      const key = DATE + '/' + missing + '/' + sha('v6-pipeline:' + DATE + ':OFFLINE');
      if (mode === 'missing') delete state.jobs[key];
      if (mode === 'stale') state.jobs[key].output.date = '2026-11-18';
      if (mode === 'corrupt') fs.appendFileSync(state.jobs[key].output.path, ' ');
      atomicWrite(c.options.statePath, state);
      let invoked = 0;
      const worker = createDispatcher({ ...c.options, adapters: { ...c.adapters, run: async () => { invoked++; throw Error('parent gate bypass'); } } });
      const result = await worker.cycle();
      assert.equal(invoked, 0);
      assert.ok(result.blocked.some(b => b.job === 'top20' && b.reason === 'DEPENDENCY_UNVERIFIED' && b.dependency === missing), JSON.stringify(result));
      cases.push({ missing, mode, result });
    }
  }
  evidence('final-parent-negative-matrix', cases);
});

test('persisted override reaches next worker cycle; legacy stays disabled and PRODUCTION paid run is hard blocked', async () => {
  const c = setup(); brokerSources(c);
  await adminServer(async request => {
    const save = await request({ version: 0, reason: 'explicit Admin time override', patch: { 'broksum-all': { timeWIB: '20:35' } } }); assert.equal(save.status, 200, JSON.stringify(save.body));
    c.clock('13:30:00'); assert.equal((await c.worker().cycle()).ran.length, 0);
    c.clock('13:35:00'); const run = await c.worker().cycle(); assert.equal(run.ran[0].job, 'broksum-all'); assert.equal(run.scheduleVersion, save.body.version);
    const doc = store.get().doc; for (const key of ['fastwatcher', 'daytrade-producer', 'daytrade-fastwatcher']) doc.jobs[key].enabled = true;
    atomicWrite(store.STORE_PATH, doc);
    let invoked = 0;
    const production = createDispatcher({ ...c.options, statePath: path.join(c.dir, 'production-block.json'), adapterOptions: { ...c.options.adapterOptions, realm: 'PRODUCTION' }, adapters: { realm: 'PRODUCTION', outputDir: c.adapters.outputDir, run: async () => { invoked++; throw Error('must never reach paid adapter'); } } });
    const blocked = await production.cycle(); assert.equal(invoked, 0); assert.ok(blocked.blocked.some(b => b.job === 'broksum-all' && b.reason === 'PAID_ADAPTER_NOT_AUTHORIZED'));
    assert.equal(blocked.ran.length, 0);
    assert.ok(!blocked.blocked.some(b => /fastwatcher|daytrade/.test(b.job)));
    evidence('override-legacy-paid-block', { persisted: read(store.STORE_PATH), effective: store.get().doc, overrideRun: run, productionBlocked: blocked, paidAdapterInvocations: invoked });
  });
});
