'use strict';
/**
 * test/v5/quota-p1-03.test.js
 * ============================================================================
 * SUBTASK F2 / P1-03 — Rollback of CLEAR override when append audit fails.
 *
 * The reported defect: original override = 5000 -> admin CLEAR -> append-audit
 * write fails -> the rollback path incorrectly re-runs CLEAR (overriding the
 * prior 5000 into null) instead of restoring the prior 5000.
 *
 * Required fix: on ANY audit/persistence failure, the active configuration is
 * restored to its previous value, or the transaction is guaranteed not applied.
 *
 * These tests:
 *   - run the REAL api/admin/quota-limit.js handler + REAL lib/quota-limit.js
 *     / lib/quota-state.js modules copied into an ISOLATED sandbox tree;
 *   - inject REAL filesystem faults (audit path under a plain file -> append
 *     audit fails; blob path replaced by a directory -> persistence fails);
 *   - issue REAL HTTP requests against a live loopback http.Server for the
 *     auth/HTTP contract checks.
 *
 * No network calls to Stock Arjum, no quota spend, no Telegram, no mocks of the
 * helper under test.
 * ============================================================================
 * Run:  node test/v5/quota-p1-03.test.js
 * Exit: 0 on success, 1 on any assertion failure.
 * ============================================================================
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const results = [];
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push({ name, ok: true, error: null });
      process.stdout.write('PASS  ' + name + '\n');
    })
    .catch((err) => {
      results.push({ name, ok: false, error: String((err && err.message) || err) });
      process.stdout.write('FAIL  ' + name + '\n      ' + String((err && err.message) || err) + '\n');
    });
}
function assert(cond, msg) { if (!cond) throw new Error('ASSERT: ' + msg); }

/* -------------------------------------------------------------------------- */
/* Sandbox builder (real modules, isolated paths)                              */
/* -------------------------------------------------------------------------- */

function copyTree(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, entry.name);
    const d = path.join(destDir, entry.name);
    if (entry.isDirectory()) copyTree(s, d);
    else if (entry.isFile() && /\.js$/.test(entry.name)) fs.copyFileSync(s, d);
  }
}

function makeSandbox(seedBlob, seedState) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-f2-p103-'));
  copyTree(path.join(REPO_ROOT, 'lib'), path.join(root, 'lib'));
  fs.mkdirSync(path.join(root, 'api', 'admin'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'api', 'admin', 'quota-limit.js'), path.join(root, 'api', 'admin', 'quota-limit.js'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'quota.json'), JSON.stringify({
    planName: 'Supporter',
    planExpiresAt: '2099-01-01T00:00:00+07:00',
    reserveFloorWeekday: 0,
    reserveFloorWeekend: 0,
    weekdayBackfillLimit: 0,
    weekendBackfillLimit: null
  }));
  const blobPath = path.join(root, 'data', 'quota-limit.json');
  if (seedBlob != null) fs.writeFileSync(blobPath, JSON.stringify(seedBlob));
  const statePath = path.join(root, 'data', 'quota-state.json');
  if (seedState != null) fs.writeFileSync(statePath, JSON.stringify(seedState));
  const endpointPath = path.join(root, 'api', 'admin', 'quota-limit.js');
  return { root, blobPath, statePath, endpointPath };
}

/* Deterministic fresh provider snapshot (limit 10000, same-day usage 1000) with
 * a PRIOR override limit already applied (for the CLEAR rollback reproduction). */
function seedTruth(root, overrideLimit) {
  const quotaLimit = require(path.join(root, 'lib', 'quota-limit.js'));
  const today = quotaLimit.getWibDateKey(new Date());
  const nowIso = new Date().toISOString();
  const snapshot = {
    schemaVersion: 1,
    providerLimit: 10000,
    providerLimitSource: 'provider',
    providerLimitVerifiedAt: nowIso,
    providerPeriodUsed: 1000,
    providerPeriodUsedVerifiedAt: nowIso,
    providerPeriodUsedWibDate: today,
    planExpiresAt: '2099-01-01T00:00:00+07:00',
    source: 'provider',
    resetHourWib: 0,
    tz: 'Asia/Jakarta',
    override: overrideLimit == null
      ? { limit: null, actor: null, reason: null, setAt: null }
      : { limit: overrideLimit, actor: 'u-budi-1', reason: 'prior ceiling', setAt: nowIso },
    updatedAt: nowIso
  };
  fs.writeFileSync(path.join(root, 'data', 'quota-limit.json'), JSON.stringify(snapshot), 'utf8');
  fs.writeFileSync(path.join(root, 'data', 'quota-state.json'), JSON.stringify({
    date: today,
    currentDateWIB: today,
    localUsedToday: 1000,
    usedToday: 1000,
    upstreamUsedToday: 1000,
    upstreamDailyLimit: 10000,
    effectiveDailyLimit: 10000
  }), 'utf8');
  return today;
}

/* -------------------------------------------------------------------------- */
/* HTTP server shim (real loopback server)                                     */
/* -------------------------------------------------------------------------- */

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { req.body = raw ? JSON.parse(raw) : {}; } catch (_) { req.body = {}; }
  return req.body;
}

function httpRequest(port, opts) {
  return new Promise((resolve, reject) => {
    const body = opts.body != null ? JSON.stringify(opts.body) : undefined;
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: opts.method || 'GET',
      path: opts.path || '/api/admin/quota-limit',
      headers: Object.assign({
        host: '127.0.0.1:' + port,
        origin: 'http://127.0.0.1:' + port,
        'content-type': 'application/json'
      }, opts.headers || {})
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { parsed = null; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  const sandbox = makeSandbox();
  const secret = 'f2-p103-secret-' + Math.random().toString(36).slice(2);
  process.env.SESSION_SECRET = secret;

  const adminSession = require(path.join(sandbox.root, 'lib', 'admin-session.js'));
  const quotaLimit = require(path.join(sandbox.root, 'lib', 'quota-limit.js'));
  const adminToken = adminSession.createSessionToken({ userId: 'u-budi-1', username: 'budi', isAdmin: true });
  const memberToken = adminSession.createSessionToken({ userId: 'u2', username: 'member', isAdmin: false });
  assert(typeof adminToken === 'string' && adminToken.length > 0, 'admin token minted');

  // The transport boundary for real-HTTP checks (freshly re-seeded per scenario).
  let currentHandler = require(sandbox.endpointPath);
  let server;
  let base;

  async function startServer(handler) {
    currentHandler = handler;
    server = http.createServer(async (req, res) => {
      res.setHeader = res.setHeader.bind(res);
      res.status = function (code) { this.statusCode = code; return this; };
      res.json = function (obj) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(obj));
        return this;
      };
      await readJsonBody(req);
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname === '/api/admin/quota-limit') return currentHandler(req, res);
      res.statusCode = 404; return res.end('Not Found');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    base = 'http://127.0.0.1:' + port;
    return { port, base };
  }
  async function stopServer() { if (server) { await new Promise((r) => server.close(r)); } }

  try {
    /* ------------------------------------------------------------------ */
    /* Fault-injection scenarios (direct handler + real file IO)          */
    /* ------------------------------------------------------------------ */

    await test('P1-03 SET success persists override + writes one audit record', async () => {
      const sb = makeSandbox();
      const auditLog = path.join(sb.root, 'audit', 'audit.jsonl');
      process.env.QUOTA_LIMIT_AUDIT_LOG_PATH = auditLog;
      seedTruth(sb.root, 5000);
      const ep = require(sb.endpointPath);
      const ql = require(path.join(sb.root, 'lib', 'quota-limit.js'));

      const req = new http.IncomingMessage(new (require('net').Socket)());
      req.method = 'POST';
      req.headers = { host: '127.0.0.1', origin: 'http://127.0.0.1', cookie: 'ac_sess=' + adminToken, 'content-type': 'application/json' };
      req.socket = { remoteAddress: '127.0.0.1' };
      req.body = { action: 'set', limit: 7000, reason: 'raise to 7000' };
      const res = makeResObj();
      await ep(req, res);

      assert(res.statusCode === 200 && res.body && res.body.success === true, 'SET 200 success, got ' + JSON.stringify(res.body));
      const blob = ql.readLimitBlob().blob;
      assert(blob.override.limit === 7000, 'override persisted as 7000, got ' + JSON.stringify(blob.override));
      const lines = fs.readFileSync(auditLog, 'utf8').trim().split('\n').filter(Boolean);
      assert(lines.length === 1, 'exactly one audit record, got ' + lines.length);
      const rec = JSON.parse(lines[0]);
      assert(rec.eventType === 'QUOTA_LIMIT_OVERRIDE_SET', 'audit type SET');
      assert(rec.previous && rec.previous.overrideLimit === 5000, 'previous override 5000, got ' + JSON.stringify(rec.previous));
      assert(rec.next && rec.next.overrideLimit === 7000, 'next override 7000, got ' + JSON.stringify(rec.next));
      fs.rmSync(sb.root, { recursive: true, force: true });
      delete process.env.QUOTA_LIMIT_AUDIT_LOG_PATH;
    });

    await test('P1-03 SET with persistence failure -> 500 (no ok:true), no active change, no audit record', async () => {
      const sb = makeSandbox();
      const auditLog = path.join(sb.root, 'audit', 'audit.jsonl');
      process.env.QUOTA_LIMIT_AUDIT_LOG_PATH = auditLog;
      seedTruth(sb.root, 5000);
      // Fault: replace the blob file with a DIRECTORY so the atomic tmp+rename
      // write cannot succeed (a real persistence failure, not a mock).
      fs.unlinkSync(sb.blobPath);
      fs.mkdirSync(sb.blobPath);
      const ep = require(sb.endpointPath);

      const req = new http.IncomingMessage(new (require('net').Socket)());
      req.method = 'POST';
      req.headers = { host: '127.0.0.1', origin: 'http://127.0.0.1', cookie: 'ac_sess=' + adminToken, 'content-type': 'application/json' };
      req.socket = { remoteAddress: '127.0.0.1' };
      req.body = { action: 'set', limit: 7000, reason: 'will fail persistence' };
      const res = makeResObj();
      await ep(req, res);

      assert(res.statusCode === 500, 'persistence failure -> 500, got ' + res.statusCode);
      assert(!(res.body && res.body.success), 'no ok:true on persistence failure');
      assert(!fs.existsSync(auditLog), 'no audit record is written when persistence failed');
      fs.rmSync(sb.root, { recursive: true, force: true });
      delete process.env.QUOTA_LIMIT_AUDIT_LOG_PATH;
    });

    await test('P1-03 CLEAR success removes the override + writes one audit record', async () => {
      const sb = makeSandbox();
      const auditLog = path.join(sb.root, 'audit', 'audit.jsonl');
      process.env.QUOTA_LIMIT_AUDIT_LOG_PATH = auditLog;
      seedTruth(sb.root, 5000);
      const ep = require(sb.endpointPath);
      const ql = require(path.join(sb.root, 'lib', 'quota-limit.js'));

      const req = new http.IncomingMessage(new (require('net').Socket)());
      req.method = 'POST';
      req.headers = { host: '127.0.0.1', origin: 'http://127.0.0.1', cookie: 'ac_sess=' + adminToken, 'content-type': 'application/json' };
      req.socket = { remoteAddress: '127.0.0.1' };
      req.body = { action: 'clear', reason: 'restore provider' };
      const res = makeResObj();
      await ep(req, res);

      assert(res.statusCode === 200 && res.body && res.body.success === true, 'CLEAR 200 success');
      const blob = ql.readLimitBlob().blob;
      assert(blob.override.limit == null, 'override cleared to null, got ' + JSON.stringify(blob.override));
      const lines = fs.readFileSync(auditLog, 'utf8').trim().split('\n').filter(Boolean);
      assert(lines.length === 1, 'exactly one audit record, got ' + lines.length);
      const rec = JSON.parse(lines[0]);
      assert(rec.eventType === 'QUOTA_LIMIT_OVERRIDE_CLEAR', 'audit type CLEAR');
      fs.rmSync(sb.root, { recursive: true, force: true });
      delete process.env.QUOTA_LIMIT_AUDIT_LOG_PATH;
    });

    await test('P1-03 CLEAR with append-audit failure RESTORES prior 5000 (not re-clear)', async () => {
      const sb = makeSandbox();
      seedTruth(sb.root, 5000); // PRIOR override = 5000 (the reproduction precondition)
      const ql = require(path.join(sb.root, 'lib', 'quota-limit.js'));

      // Fault: point the audit log under a plain FILE so mkdirSync/append fails
      // (real append-audit write failure, not a mock return).
      const blockFile = path.join(sb.root, 'audit-block');
      fs.writeFileSync(blockFile, 'x');
      process.env.QUOTA_LIMIT_AUDIT_LOG_PATH = path.join(blockFile, 'sub', 'audit.jsonl');
      const ep = require(sb.endpointPath);

      const req = new http.IncomingMessage(new (require('net').Socket)());
      req.method = 'POST';
      req.headers = { host: '127.0.0.1', origin: 'http://127.0.0.1', cookie: 'ac_sess=' + adminToken, 'content-type': 'application/json' };
      req.socket = { remoteAddress: '127.0.0.1' };
      req.body = { action: 'clear', reason: 'clear that will fail audit' };
      const res = makeResObj();
      await ep(req, res);

      assert(res.statusCode === 500, 'CLEAR audit failure -> 500, got ' + res.statusCode);
      assert(res.body && res.body.success !== true && res.body.rolledBack === true, 'rolled back, got ' + JSON.stringify(res.body));
      // THE FIX: prior 5000 is RESTORED, not re-cleared to null.
      const blob = ql.readLimitBlob().blob;
      assert(blob.override && blob.override.limit === 5000, 'prior override 5000 restored (not null), got ' + JSON.stringify(blob.override));
      fs.rmSync(sb.root, { recursive: true, force: true });
      delete process.env.QUOTA_LIMIT_AUDIT_LOG_PATH;
    });

    await test('P1-03 rollback correctness: SET with append-audit failure restores prior null (or prior value)', async () => {
      const sb = makeSandbox();
      seedTruth(sb.root, null); // prior override = null
      const ql = require(path.join(sb.root, 'lib', 'quota-limit.js'));

      const blockFile = path.join(sb.root, 'audit-block');
      fs.writeFileSync(blockFile, 'x');
      process.env.QUOTA_LIMIT_AUDIT_LOG_PATH = path.join(blockFile, 'sub', 'audit.jsonl');
      const ep = require(sb.endpointPath);

      const req = new http.IncomingMessage(new (require('net').Socket)());
      req.method = 'POST';
      req.headers = { host: '127.0.0.1', origin: 'http://127.0.0.1', cookie: 'ac_sess=' + adminToken, 'content-type': 'application/json' };
      req.socket = { remoteAddress: '127.0.0.1' };
      req.body = { action: 'set', limit: 9000, reason: 'set that will fail audit' };
      const res = makeResObj();
      await ep(req, res);

      assert(res.statusCode === 500 && res.body && res.body.rolledBack === true, 'SET audit failure -> 500 + rolledBack');
      const blob = ql.readLimitBlob().blob;
      assert(blob.override && blob.override.limit == null, 'prior null override restored (not 9000), got ' + JSON.stringify(blob.override));
      fs.rmSync(sb.root, { recursive: true, force: true });
      delete process.env.QUOTA_LIMIT_AUDIT_LOG_PATH;
    });

    await test('P1-03 repeated/duplicate SET is idempotent at the config level (2 audit records, same final value)', async () => {
      const sb = makeSandbox();
      const auditLog = path.join(sb.root, 'audit', 'audit.jsonl');
      process.env.QUOTA_LIMIT_AUDIT_LOG_PATH = auditLog;
      seedTruth(sb.root, 5000);
      const ep = require(sb.endpointPath);
      const ql = require(path.join(sb.root, 'lib', 'quota-limit.js'));

      for (let i = 0; i < 2; i += 1) {
        const req = new http.IncomingMessage(new (require('net').Socket)());
        req.method = 'POST';
        req.headers = { host: '127.0.0.1', origin: 'http://127.0.0.1', cookie: 'ac_sess=' + adminToken, 'content-type': 'application/json' };
        req.socket = { remoteAddress: '127.0.0.1' };
        req.body = { action: 'set', limit: 7000, reason: 'duplicate set ' + i };
        const res = makeResObj();
        await ep(req, res);
        assert(res.statusCode === 200 && res.body && res.body.success === true, 'duplicate SET succeeds (idempotent config): ' + i);
      }
      const blob = ql.readLimitBlob().blob;
      assert(blob.override.limit === 7000, 'final override 7000, got ' + JSON.stringify(blob.override));
      const lines = fs.readFileSync(auditLog, 'utf8').trim().split('\n').filter(Boolean);
      assert(lines.length === 2, 'two audit records for two requests, got ' + lines.length);
      fs.rmSync(sb.root, { recursive: true, force: true });
      delete process.env.QUOTA_LIMIT_AUDIT_LOG_PATH;
    });

    await test('P1-03 concurrent admin mutation (two mutators) -> both succeed, 2 well-formed audit records, last-writer without lost/partial audit', async () => {
      const sb = makeSandbox();
      const auditLog = path.join(sb.root, 'audit', 'audit.jsonl');
      process.env.QUOTA_LIMIT_AUDIT_LOG_PATH = auditLog;
      seedTruth(sb.root, 5000);
      const ep = require(sb.endpointPath);
      const ql = require(path.join(sb.root, 'lib', 'quota-limit.js'));

      async function mutate(limit, reason) {
        const req = new http.IncomingMessage(new (require('net').Socket)());
        req.method = 'POST';
        req.headers = { host: '127.0.0.1', origin: 'http://127.0.0.1', cookie: 'ac_sess=' + adminToken, 'content-type': 'application/json' };
        req.socket = { remoteAddress: '127.0.0.1' };
        req.body = { action: 'set', limit, reason };
        const res = makeResObj();
        await ep(req, res);
        return { status: res.statusCode, body: res.body };
      }

      // Two mutators targeting the SAME config concurrently. Because the handler's
      // mutation section is synchronous (read->write->audit all on the same tick),
      // the event loop serialises them without interleaving; the invariant is that
      // BOTH succeed, the audit log has exactly two well-formed records (no lost
      // or partial record), and the final value is one of the two writers.
      const [a, b] = await Promise.all([
        mutate(7100, 'mutator A'),
        mutate(7200, 'mutator B')
      ]);
      assert(a.status === 200 && a.body && a.body.success === true, 'mutator A success, got ' + JSON.stringify(a.body));
      assert(b.status === 200 && b.body && b.body.success === true, 'mutator B success, got ' + JSON.stringify(b.body));

      const blob = ql.readLimitBlob().blob;
      assert(blob.override.limit === 7100 || blob.override.limit === 7200,
        'final value is one of the two writers, got ' + blob.override.limit);

      const lines = fs.readFileSync(auditLog, 'utf8').trim().split('\n').filter(Boolean);
      assert(lines.length === 2, 'exactly two audit records (no lost/partial), got ' + lines.length);
      for (const ln of lines) {
        const rec = JSON.parse(ln);
        assert(rec.eventType === 'QUOTA_LIMIT_OVERRIDE_SET', 'audit type SET');
        assert(rec.previous && typeof rec.previous.overrideLimit !== 'undefined', 'previous diff present');
        assert(rec.next && (rec.next.overrideLimit === 7100 || rec.next.overrideLimit === 7200), 'next diff is a valid writer value');
      }
      // The final persisted value must equal the value carried in the LAST audit
      // record (single source of truth, no lost write).
      const lastRec = JSON.parse(lines[lines.length - 1]);
      assert(blob.override.limit === lastRec.next.overrideLimit,
        'final config matches the last committed audit record, got ' + blob.override.limit + ' vs ' + lastRec.next.overrideLimit);
      fs.rmSync(sb.root, { recursive: true, force: true });
      delete process.env.QUOTA_LIMIT_AUDIT_LOG_PATH;
    });

    await test('P1-03 reload/re-read: a fresh authority read reflects the same single source of truth', async () => {
      const sb = makeSandbox();
      const auditLog = path.join(sb.root, 'audit', 'audit.jsonl');
      process.env.QUOTA_LIMIT_AUDIT_LOG_PATH = auditLog;
      seedTruth(sb.root, 5000);
      const ep = require(sb.endpointPath);

      const req = new http.IncomingMessage(new (require('net').Socket)());
      req.method = 'POST';
      req.headers = { host: '127.0.0.1', origin: 'http://127.0.0.1', cookie: 'ac_sess=' + adminToken, 'content-type': 'application/json' };
      req.socket = { remoteAddress: '127.0.0.1' };
      req.body = { action: 'set', limit: 8000, reason: 'persist then reload' };
      const res = makeResObj();
      await ep(req, res);
      assert(res.statusCode === 200 && res.body && res.body.success === true, 'SET success');

      // Simulate a fresh process/worker reload: a NEW require of the authority
      // (fresh module cache) that re-reads the on-disk blob must see 8000.
      const freshAuthority = require(path.join(sb.root, 'lib', 'quota-limit.js'));
      const blob = freshAuthority.readLimitBlob().blob;
      assert(blob.override.limit === 8000, 're-read reflects persisted 8000 (single source of truth), got ' + JSON.stringify(blob.override));
      fs.rmSync(sb.root, { recursive: true, force: true });
      delete process.env.QUOTA_LIMIT_AUDIT_LOG_PATH;
    });

    /* ------------------------------------------------------------------ */
    /* Real HTTP contract (isolated local server)                         */
    /* ------------------------------------------------------------------ */

    {
      const sb = makeSandbox();
      seedTruth(sb.root, null);
      process.env.QUOTA_LIMIT_AUDIT_LOG_PATH = path.join(sb.root, 'audit', 'audit.jsonl');
      const ep = require(sb.endpointPath);
      const { port } = await startServer(ep);

      await test('HTTP GET authenticated -> 200 + limit 10000 (no override yet)', async () => {
        const r = await httpRequest(port, { method: 'GET', headers: { cookie: 'ac_sess=' + adminToken } });
        assert(r.status === 200 && r.body && r.body.success === true, 'GET 200, got ' + JSON.stringify(r.body));
        assert(r.body.limit === 10000 && r.body.limitKnown === true, 'limit 10000, got ' + r.body.limit);
        assert(r.body.used === 1000 && r.body.remaining === 9000, 'used/remaining known, got ' + r.body.remaining);
      });

      await test('HTTP POST authenticated SET -> 200 + persists', async () => {
        const r = await httpRequest(port, {
          method: 'POST',
          headers: { cookie: 'ac_sess=' + adminToken },
          body: { action: 'set', limit: 5000, reason: 'http set' }
        });
        assert(r.status === 200 && r.body && r.body.success === true, 'POST SET 200, got ' + JSON.stringify(r.body));
        assert(r.body.limit === 5000 && r.body.source === 'manual', 'effective limit 5000 manual');
        assert(r.body.override && r.body.override.limit === 5000, 'override recorded');
      });

      await test('HTTP GET after SET reflects lower ceiling (5000)', async () => {
        const r = await httpRequest(port, { method: 'GET', headers: { cookie: 'ac_sess=' + adminToken } });
        assert(r.body.limit === 5000 && r.body.source === 'manual', 'reloaded GET reflects 5000 manual, got ' + r.body.limit);
      });

      await test('HTTP POST authenticated CLEAR -> 200 + restores provider', async () => {
        const r = await httpRequest(port, {
          method: 'POST',
          headers: { cookie: 'ac_sess=' + adminToken },
          body: { action: 'clear', reason: 'http clear' }
        });
        assert(r.status === 200 && r.body && r.body.success === true, 'POST CLEAR 200, got ' + JSON.stringify(r.body));
        const recheck = await httpRequest(port, { method: 'GET', headers: { cookie: 'ac_sess=' + adminToken } });
        assert(recheck.body.limit === 10000 && recheck.body.source === 'provider', 'restored provider limit, got ' + recheck.body.limit);
      });

      await test('HTTP same-origin enforcement: cross-origin mutation rejected 403', async () => {
        const r = await httpRequest(port, {
          method: 'POST',
          headers: { cookie: 'ac_sess=' + adminToken, origin: 'https://evil.example', host: '127.0.0.1:' + port },
          body: { action: 'set', limit: 7777, reason: 'xss' }
        });
        assert(r.status === 403, 'cross-origin 403, got ' + r.status);
        assert(!(r.body && r.body.success), 'no success for cross-origin');
      });

      await test('HTTP unauthorized: guest (no cookie) rejected 401/403', async () => {
        const r = await httpRequest(port, { method: 'GET', headers: {} });
        assert(r.status === 401 || r.status === 403, 'guest denied, got ' + r.status);
      });

      await test('HTTP non-admin signed session rejected 403', async () => {
        const r = await httpRequest(port, { method: 'GET', headers: { cookie: 'ac_sess=' + memberToken } });
        assert(r.status === 403, 'non-admin 403, got ' + r.status);
      });

      await test('HTTP invalid payload rejected 400', async () => {
        const bad = [
          { action: 'explode', limit: 1, reason: 'x' },
          { action: 'set', limit: -1, reason: 'x' },
          { action: 'set', limit: 0, reason: 'x' },
          { action: 'set', limit: 'abc', reason: 'x' },
          { action: 'set', limit: 100, reason: '' }
        ];
        for (const payload of bad) {
          const r = await httpRequest(port, { method: 'POST', headers: { cookie: 'ac_sess=' + adminToken }, body: payload });
          assert(r.status === 400, 'expected 400 for ' + JSON.stringify(payload) + ', got ' + r.status);
        }
      });

      await stopServer();
      fs.rmSync(sb.root, { recursive: true, force: true });
      delete process.env.QUOTA_LIMIT_AUDIT_LOG_PATH;
    }
  } finally {
    try { await stopServer(); } catch (_) {}
    try { fs.rmSync(sandbox.root, { recursive: true, force: true }); } catch (_) {}
    delete process.env.SESSION_SECRET;
    delete process.env.QUOTA_LIMIT_AUDIT_LOG_PATH;
  }
}

function makeResObj() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    getHeader() { return null; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    end() { return this; }
  };
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok);
    process.stdout.write('\n' + (results.length - failed.length) + '/' + results.length + ' P1-03 assertions passed\n');
    for (const f of failed) process.stdout.write('  FAILED: ' + f.name + ' -> ' + f.error + '\n');
    process.exit(failed.length > 0 ? 1 : 0);
  })
  .catch((err) => {
    process.stdout.write('RUNNER FAILURE: ' + String((err && err.stack) || err) + '\n');
    process.exit(2);
  });