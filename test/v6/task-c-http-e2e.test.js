'use strict';
/**
 * TASK C — isolated HTTP E2E: UI-equivalent click -> authenticated API ->
 * handler -> mocked upstream transport -> state update -> UI readback.
 * Also verifies Admin quota controls via authenticated PUT with 409 guard.
 * ZERO live provider calls. ZERO billed units. ZERO DB writes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

if (process.env.TASK_C_E2E !== '1') throw new Error('TASK_C_E2E=1 required');
const ROOT = path.resolve(__dirname, '../..');
const EVIDENCE = path.join(ROOT, 'audit-evidence/v6_recovery_17nov/final_fix_10files_20261120_v1/task_c');
const sha = (s) => crypto.createHash('sha256').update(Buffer.isBuffer(s) ? s : String(s)).digest('hex');
const receipts = [];
const results = [];

const session = require('../../lib/admin-session');
const cookies = {
  guest: '',
  user: 'ac_sess=' + session.createSessionToken({ userId: 'offline-user', username: 'offline-user', isAdmin: false }),
  admin: 'ac_sess=' + session.createSessionToken({ userId: 'offline-admin', username: 'offline-admin', isAdmin: true }),
  tampered: 'ac_sess=v1.invalid.invalid'
};

let server;
const PORT = Number(process.env.TASK_C_HTTP_PORT || 43117);

function request(name, url, opts = {}) {
  const role = opts.role || 'guest';
  const method = opts.method || 'GET';
  const body = opts.body;
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  const headers = { connection: 'close' };
  if (cookies[role]) headers.cookie = cookies[role];
  if (opts.origin !== 'none') headers.origin = opts.origin === 'cross' ? 'https://disallowed.invalid' : 'http://127.0.0.1:' + PORT;
  if (payload !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: PORT, path: url, method, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let data;
        try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
        const rec = {
          name, url, role, method, origin: headers.origin || null,
          request_body_sha256: payload === undefined ? null : sha(payload),
          status: res.statusCode, response_sha256: sha(text), response: data
        };
        results.push(rec);
        if (opts.expect !== undefined) assert.equal(res.statusCode, opts.expect, name + ': ' + text.slice(0, 500));
        resolve(data);
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('LOCAL_REQUEST_TIMEOUT')));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

test.before(async () => {
  // Seed durable quota config so the manual-fetch quota guard has real limits.
  const quotaStore = require('../../lib/quota-config-store');
  quotaStore.put({
    configuredOperatingCap: 18080,
    reserveFloorWeekday: 5000,
    priorityOrder: ['broksum-ALL', 'broksum-Foreign', 'insider-tiered', 'candles', 'financial']
  }, { actor: 'offline-admin', reason: 'OFFLINE SYNTHETIC TASK C seed', now: new Date('2026-11-20T06:00:00Z') });

  // Seed an incomplete issuer through the isolated store (UI would show a button).
  const incomplete = require('../../lib/financial-incomplete-store');
  incomplete.upsert({
    ticker: 'E2E', fiscal_year: 2026, period: 'Q3', status: 'MISSING',
    source: 'OFFLINE SYNTHETIC observation', as_of: '2026-11-20',
    reason: 'no verified publication receipt', target_period: '2026Q3'
  }, { actor: 'offline-admin', now: new Date('2026-11-20T07:00:00Z') });

  // Build a tiny HTTP server that mounts the REAL handlers with an injected
  // mocked transport. No production server, no provider, no DB.
  const financialHandler = require('../../api/admin/financial-publication');
  const quotaHandler = require('../../api/admin/quota-settings');
  const scheduleHandler = require('../../api/admin/schedule-settings');
  const mockedTransport = {
    id: 'MOCK-OFFLINE-E2E',
    async fetch(query) {
      receipts.push({ at: new Date().toISOString(), query, offline: true, liveProviderCalls: 0, billedUnits: 0 });
      return { published: false, source: 'MOCK-OFFLINE-E2E', as_of: '2026-11-20', reason: 'OFFLINE SYNTHETIC no publication' };
    }
  };
  server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      let raw = '';
      for await (const chunk of req) raw += chunk;
      req.body = raw ? JSON.parse(raw) : {};
      req.query = Object.fromEntries(u.searchParams.entries());
      if (u.pathname === '/api/admin/financial-publication') {
        req.mockedTransport = mockedTransport;
        return await financialHandler(req, res);
      }
      if (u.pathname === '/api/admin/quota-settings') return await quotaHandler(req, res);
      if (u.pathname === '/api/admin/schedule-settings') return await scheduleHandler(req, res);
      res.statusCode = 404; res.end('not found');
    } catch (err) {
      res.statusCode = 500; res.end(String(err && err.message));
    }
  });
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
});

test.after(async () => {
  fs.writeFileSync(path.join(EVIDENCE, 'e2e-requests.json'), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(EVIDENCE, 'mocked-transport-receipts.json'), JSON.stringify(receipts, null, 2));
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('E2E-1: auth + CSRF guards on financial publication endpoint', async () => {
  const url = '/api/admin/financial-publication?view=status';
  await request('financial guest', url, { role: 'guest', expect: 401 });
  await request('financial tampered', url, { role: 'tampered', expect: 401 });
  await request('financial non-admin', url, { role: 'user', expect: 403 });
  await request('financial admin', url, { role: 'admin', expect: 200 });
  await request('financial CSRF', url, { role: 'admin', method: 'POST', body: { action: 'set_interval', retry_interval_days: 7 }, origin: 'cross', expect: 403 });
});

test('E2E-2: UI readback shows windows and incomplete issuer with period/status/source', async () => {
  const data = await request('financial UI readback', '/api/admin/financial-publication?view=status', { role: 'admin', expect: 200 });
  assert.equal(data.success, true);
  assert.ok(data.fetch_windows);
  assert.equal(data.fetch_windows.periods.Q1.startDay, 5);
  assert.equal(data.fetch_windows.periods.FY.endDay, 15);
  assert.ok(data.incomplete_issuers);
  const e = data.incomplete_issuers.entries.find((x) => x.ticker === 'E2E');
  assert.ok(e, 'incomplete E2E entry must be visible');
  assert.equal(e.period, 'Q3');
  assert.equal(e.status, 'MISSING');
  assert.ok(e.source && e.as_of && e.reason);
});

test('E2E-3: manual fetch button -> authenticated API -> mocked transport -> state -> readback', async () => {
  const before = await request('before manual fetch', '/api/admin/financial-publication?view=status', { role: 'admin', expect: 200 });
  const beforeEntry = before.incomplete_issuers.entries.find((x) => x.ticker === 'E2E');
  assert.equal(beforeEntry.attempts, 0);

  const r = await request('manual fetch click', '/api/admin/financial-publication', {
    role: 'admin', method: 'POST',
    body: { action: 'manual_fetch', ticker: 'E2E', fiscal_year: 2026, period: 'Q3', attemptId: 'e2e-attempt-1' },
    expect: 200
  });
  assert.equal(r.success, true);
  assert.equal(r.outcome, 'NOT_PUBLISHED');
  assert.equal(r.httpRequests, 0);
  assert.equal(r.billedUnits, 0);
  assert.equal(r.transport, 'MOCK-OFFLINE-E2E');
  assert.equal(r.readbackOk, true);
  assert.equal(receipts.length, 1, 'exactly one mocked transport call');

  const after = await request('after manual fetch readback', '/api/admin/financial-publication?view=status', { role: 'admin', expect: 200 });
  const afterEntry = after.incomplete_issuers.entries.find((x) => x.ticker === 'E2E');
  assert.equal(afterEntry.attempts, 1);
  assert.equal(afterEntry.last_attempt_id, 'e2e-attempt-1');
  assert.equal(afterEntry.status, 'UNPUBLISHED');

  // Idempotent replay: same attemptId => no second transport call.
  const replay = await request('manual fetch replay', '/api/admin/financial-publication', {
    role: 'admin', method: 'POST',
    body: { action: 'manual_fetch', ticker: 'E2E', fiscal_year: 2026, period: 'Q3', attemptId: 'e2e-attempt-1' },
    expect: 200
  });
  assert.equal(replay.outcome, 'ALREADY_ATTEMPTED');
  assert.equal(receipts.length, 1, 'idempotent replay must not call transport again');
});

test('E2E-4: manual fetch without mocked transport is blocked (production-safe)', async () => {
  // Direct handler call with no req.mockedTransport — production behavior.
  const handler = require('../../api/admin/financial-publication');
  const res = {
    statusCode: 0, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    end(text) { this.text = text; }
  };
  const req = {
    method: 'POST', url: '/api/admin/financial-publication',
    headers: { host: '127.0.0.1:' + PORT, origin: 'http://127.0.0.1:' + PORT, cookie: cookies.admin },
    body: { action: 'manual_fetch', ticker: 'E2E', fiscal_year: 2026, period: 'Q3', attemptId: 'e2e-no-transport' }
  };
  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'TRANSPORT_REQUIRED');
  assert.equal(receipts.length, 1, 'no transport => no upstream call');
});

test('E2E-5: Admin quota controls via authenticated PUT, persisted version, reload, 409 guard', async () => {
  const get1 = await request('quota GET before', '/api/admin/quota-settings', { role: 'admin', expect: 200 });
  const v0 = get1.config.version;
  const put = await request('quota PUT', '/api/admin/quota-settings', {
    role: 'admin', method: 'PUT',
    body: {
      reason: 'OFFLINE SYNTHETIC TASK C quota control test',
      expectedVersion: v0,
      patch: {
        configuredOperatingCap: 18080,
        reserveFloorWeekday: 5000,
        priorityOrder: ['broksum-ALL', 'broksum-Foreign', 'insider-tiered', 'candles', 'financial']
      }
    },
    expect: 200
  });
  assert.equal(put.success, true);
  assert.equal(put.readbackOk, true);
  assert.equal(put.version, v0 + 1);
  assert.equal(put.config.configured_operating_cap, 18080);
  assert.equal(put.config.reserve_floor_weekday || put.config.reserveFloorWeekday, 5000);

  const reload = await request('quota GET after reload', '/api/admin/quota-settings', { role: 'admin', expect: 200 });
  assert.equal(reload.config.version, put.version);
  assert.equal(reload.config.configured_operating_cap, 18080);

  // Stale version => 409 CONFLICT, no mutation.
  const stale = await request('quota stale version', '/api/admin/quota-settings', {
    role: 'admin', method: 'PUT',
    body: { reason: 'OFFLINE SYNTHETIC stale', expectedVersion: v0, patch: { configuredOperatingCap: 999 } },
    expect: 409
  });
  assert.equal(stale.code, 'CONFIG_VERSION_CONFLICT');
  const after = await request('quota GET after stale', '/api/admin/quota-settings', { role: 'admin', expect: 200 });
  assert.equal(after.config.version, put.version, '409 must not mutate');

  // Auth/CSRF guards on PUT.
  await request('quota PUT guest', '/api/admin/quota-settings', { role: 'guest', method: 'PUT', body: { reason: 'x', patch: { configuredOperatingCap: 1 } }, expect: 401 });
  await request('quota PUT user', '/api/admin/quota-settings', { role: 'user', method: 'PUT', body: { reason: 'x', patch: { configuredOperatingCap: 1 } }, expect: 403 });
  await request('quota PUT CSRF', '/api/admin/quota-settings', { role: 'admin', method: 'PUT', origin: 'cross', body: { reason: 'x', patch: { configuredOperatingCap: 1 } }, expect: 403 });
});

test('E2E-6: Admin schedule settings job priority + cron time via PUT with 409 guard', async () => {
  const get1 = await request('schedule GET before', '/api/admin/schedule-settings', { role: 'admin', expect: 200 });
  const v0 = get1.config.version;
  const put = await request('schedule PUT', '/api/admin/schedule-settings', {
    role: 'admin', method: 'PUT',
    body: {
      reason: 'OFFLINE SYNTHETIC TASK C schedule control test',
      expectedVersion: v0,
      patch: { jobs: { fundamental: { priority: 41, timeWIB: '23:05' } } }
    },
    expect: 200
  });
  assert.equal(put.success, true);
  assert.equal(put.readbackOk, true);
  const reload = await request('schedule GET after reload', '/api/admin/schedule-settings', { role: 'admin', expect: 200 });
  const job = reload.config.jobs.find((j) => j.key === 'fundamental');
  assert.equal(job.priority, 41);
  assert.equal(job.timeWIB, '23:05');
  const stale = await request('schedule stale version', '/api/admin/schedule-settings', {
    role: 'admin', method: 'PUT',
    body: { reason: 'OFFLINE SYNTHETIC stale', expectedVersion: v0, patch: { jobs: { fundamental: { priority: 99 } } } },
    expect: 409
  });
  assert.equal(stale.code, 'CONFIG_VERSION_CONFLICT');
});

test('E2E-7: dispatcher reads back persisted quota + schedule versions (isolated)', async () => {
  const { createDispatcher } = require('../../lib/v6-scheduler-dispatcher.cjs');
  const statePath = path.join(EVIDENCE, 'isolated-state', 'dispatcher-readback.json');
  const dispatcher = createDispatcher({
    statePath,
    adapterOptions: {
      realm: 'OFFLINE',
      outputDir: path.join(EVIDENCE, 'isolated-state', 'outputs'),
      cachedDir: path.join(EVIDENCE, 'isolated-state', 'cached')
    },
    now: () => new Date('2026-11-20T08:00:00Z'),
    legacyGuard: false
  });
  const result = await dispatcher.cycle();
  assert.equal(result.status, 'OK');
  assert.ok(Number.isSafeInteger(result.scheduleVersion));
  assert.ok(Number.isSafeInteger(result.quotaVersion));
  const quota = await request('quota final readback', '/api/admin/quota-settings', { role: 'admin', expect: 200 });
  const schedule = await request('schedule final readback', '/api/admin/schedule-settings', { role: 'admin', expect: 200 });
  assert.equal(result.quotaVersion, quota.config.version);
  assert.equal(result.scheduleVersion, schedule.config.version);
  fs.writeFileSync(path.join(EVIDENCE, 'dispatcher-readback.json'), JSON.stringify(result, null, 2));
});
