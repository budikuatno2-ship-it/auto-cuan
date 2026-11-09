'use strict';

/**
 * test/v5/quota-f1-fix-read-fail-closed.test.js
 * ============================================================================
 * V5 FIX 1 — Fail-closed read of the quota-limit blob in api/admin/quota-limit.js
 * ============================================================================
 * The defect: the GET path and the POST previous-blob capture both called
 * `quotaLimit.readLimitBlob().blob`, discarding `.ok`. A corrupt/readable-failed
 * `data/quota-limit.json` therefore produced HTTP 200 with a BLANK config (GET)
 * and a silent-overwrite of the corrupt file with new config + an audit record
 * (SET/CLEAR). The library already signals failure via `{ ok:false }`; the
 * handler simply ignored it.
 *
 * Required behavior (fail-closed):
 *   - any `readLimitBlob()` result with `ok !== true` is a hard rejection:
 *     GET returns HTTP 500, POST/SET/CLEAR returns HTTP 500 BEFORE any
 *     write/overwrite/delete/audit-append. `result.blob` is used only when ok.
 *   - error kinds (corrupt JSON / permission / missing / IO) are surfaced in the
 *     message; `ok:false` on ENOENT is also treated as a read failure.
 *
 * These are REAL-HTTP integration tests: the real handler + real lib modules are
 * copied into an isolated temp sandbox and mounted on a live loopback http.Server.
 * `QUOTA_LIMIT_BLOB_PATH` AND `QUOTA_LIMIT_AUDIT_LOG_PATH` are redirected into the
 * sandbox so the repository's real `data/quota-limit.json` is never read/written.
 * ============================================================================
 * Run:  node test/v5/quota-f1-fix-read-fail-closed.test.js
 * Exit: 0 when all 10 cases pass, 1 on assertion failure, 2 on runner failure.
 * ============================================================================
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

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
function bytesOf(f) { return fs.readFileSync(f); }
function bytesEqual(a, b) { return Buffer.compare(a, b) === 0; }

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

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-f1-fix-'));
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
  }), 'utf8');
  return {
    root,
    blobPath: path.join(root, 'data', 'quota-limit.json'),
    statePath: path.join(root, 'data', 'quota-state.json'),
    endpointPath: path.join(root, 'api', 'admin', 'quota-limit.js'),
    auditPath: path.join(root, 'data', 'quota-limit-audit.log.jsonl')
  };
}

/* A deterministic, valid, fresh provider snapshot (limit 10000 / used 1000). */
function seedValidBlob(sb, overrideLimit) {
  const quotaLimitProbe = require(path.join(sb.root, 'lib', 'quota-limit.js'));
  const today = quotaLimitProbe.getWibDateKey(new Date());
  const nowIso = new Date().toISOString();
  const blob = {
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
      : { limit: overrideLimit, actor: 'u-budi-1', reason: 'prior', setAt: nowIso },
    updatedAt: nowIso
  };
  fs.writeFileSync(sb.blobPath, JSON.stringify(blob), 'utf8');
  fs.writeFileSync(sb.statePath, JSON.stringify({
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

/* A valid-blob-shaped config with NO provider snapshot (provider limit unknown). */
function seedUnknownProviderBlob(sb) {
  const quotaLimitProbe = require(path.join(sb.root, 'lib', 'quota-limit.js'));
  const today = quotaLimitProbe.getWibDateKey(new Date());
  const blob = {
    schemaVersion: 1,
    providerLimit: null,
    providerLimitSource: null,
    providerLimitVerifiedAt: null,
    providerPeriodUsed: null,
    providerPeriodUsedVerifiedAt: null,
    providerPeriodUsedWibDate: null,
    planExpiresAt: null,
    source: 'unknown',
    resetHourWib: 0,
    tz: 'Asia/Jakarta',
    override: { limit: null, actor: null, reason: null, setAt: null },
    updatedAt: null
  };
  fs.writeFileSync(sb.blobPath, JSON.stringify(blob), 'utf8');
  fs.writeFileSync(sb.statePath, JSON.stringify({
    date: today,
    currentDateWIB: today,
    localUsedToday: 0,
    usedToday: 0,
    upstreamUsedToday: null,
    upstreamDailyLimit: null,
    effectiveDailyLimit: 0
  }), 'utf8');
}

/* -------------------------------------------------------------------------- */
/* HTTP transport (real loopback server)                                       */
/* -------------------------------------------------------------------------- */

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { req.body = raw ? JSON.parse(raw) : {}; } catch (_) { req.body = {}; }
  return req.body;
}

async function startServer(handlerPath) {
  const handler = require(handlerPath);
  const server = http.createServer(async (req, res) => {
    res.setHeader = res.setHeader.bind(res);
    res.status = function (code) { this.statusCode = code; return this; };
    res.json = function (obj) {
      if (!this.getHeader('Content-Type')) this.setHeader('Content-Type', 'application/json; charset=utf-8');
      this.end(JSON.stringify(obj));
      return this;
    };
    await readJsonBody(req);
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/api/admin/quota-limit') return handler(req, res);
    res.statusCode = 404;
    return res.end('Not Found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { server, port, base: 'http://127.0.0.1:' + port };
}

async function stopServer(server) {
  if (server) await new Promise((r) => server.close(r));
}

async function httpJson(base, opts) {
  const res = await fetch(base + '/api/admin/quota-limit', {
    method: opts.method || 'GET',
    headers: Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (_) { body = null; }
  return { status: res.status, body };
}

/* -------------------------------------------------------------------------- */
/* Environment wiring helper: set per-sandbox blob + audit paths so the real   */
/* repo files can NEVER be mutated, then mint tokens from the sandbox session. */
/* -------------------------------------------------------------------------- */

function wireEnv(sb) {
  process.env.QUOTA_LIMIT_BLOB_PATH = sb.blobPath;
  process.env.QUOTA_LIMIT_AUDIT_LOG_PATH = sb.auditPath;
  process.env.SESSION_SECRET = 'f1-fix-secret-' + Math.random().toString(36).slice(2);
  const adminSession = require(path.join(sb.root, 'lib', 'admin-session.js'));
  const adminToken = adminSession.createSessionToken({ userId: 'u-budi-1', username: 'budi', isAdmin: true });
  const memberToken = adminSession.createSessionToken({ userId: 'u-member', username: 'member', isAdmin: false });
  assert(typeof adminToken === 'string' && adminToken.length > 0, 'admin token minted');
  assert(typeof memberToken === 'string' && memberToken.length > 0, 'member token minted');
  return { adminToken, memberToken };
}

function clearEnv() {
  delete process.env.QUOTA_LIMIT_BLOB_PATH;
  delete process.env.QUOTA_LIMIT_AUDIT_LOG_PATH;
  delete process.env.SESSION_SECRET;
}

/* -------------------------------------------------------------------------- */
/* Main: 10 cases                                                              */
/* -------------------------------------------------------------------------- */

async function main() {
  /* --- Case 1: valid JSON -> SET succeeds --- */
  await test('1. valid JSON -> SET succeeds (200, success:true)', async () => {
    const sb = makeSandbox();
    try {
      seedValidBlob(sb, null);
      const { adminToken } = wireEnv(sb);
      const { server, base } = await startServer(sb.endpointPath);
      try {
        const r = await httpJson(base, {
          method: 'POST',
          headers: { cookie: 'ac_sess=' + adminToken, host: '127.0.0.1', origin: base },
          body: { action: 'set', limit: 5000, reason: 'lower ceiling' }
        });
        assert(r.status === 200, 'SET status 200, got ' + r.status);
        assert(r.body && r.body.success === true, 'success:true, got ' + JSON.stringify(r.body).slice(0, 160));
        assert(r.body.override && r.body.override.limit === 5000, 'override recorded 5000');
      } finally { await stopServer(server); }
    } finally { fs.rmSync(sb.root, { recursive: true, force: true }); clearEnv(); }
  });

  /* --- Case 2: valid JSON -> CLEAR succeeds --- */
  await test('2. valid JSON -> CLEAR succeeds (200, success:true)', async () => {
    const sb = makeSandbox();
    try {
      seedValidBlob(sb, 5000);
      const { adminToken } = wireEnv(sb);
      const { server, base } = await startServer(sb.endpointPath);
      try {
        const r = await httpJson(base, {
          method: 'POST',
          headers: { cookie: 'ac_sess=' + adminToken, host: '127.0.0.1', origin: base },
          body: { action: 'clear', reason: 'restore provider' }
        });
        assert(r.status === 200, 'CLEAR status 200, got ' + r.status);
        assert(r.body && r.body.success === true, 'success:true, got ' + JSON.stringify(r.body).slice(0, 160));
        assert(r.body.override && r.body.override.limit == null, 'override cleared to null');
      } finally { await stopServer(server); }
    } finally { fs.rmSync(sb.root, { recursive: true, force: true }); clearEnv(); }
  });

  /* --- Case 3: corrupted JSON -> SET rejected, file bytes UNCHANGED --- */
  await test('3. corrupted JSON -> SET rejected (non-2xx), file bytes UNCHANGED', async () => {
    const sb = makeSandbox();
    try {
      const corrupt = Buffer.from('{"providerLimit": 10000, "override": { "limit": "unterminated"', 'utf8');
      fs.writeFileSync(sb.blobPath, corrupt);
      const before = bytesOf(sb.blobPath);
      const { adminToken } = wireEnv(sb);
      const { server, base } = await startServer(sb.endpointPath);
      try {
        const r = await httpJson(base, {
          method: 'POST',
          headers: { cookie: 'ac_sess=' + adminToken, host: '127.0.0.1', origin: base },
          body: { action: 'set', limit: 5000, reason: 'must not overwrite corrupt config' }
        });
        assert(r.status >= 400, 'SET rejected non-2xx, got ' + r.status);
        assert(r.body && r.body.success !== true, 'never success:true on corrupt read');
        assert(/JSON korup|SyntaxError|Unexpected|json/i.test(String(r.body && r.body.error || '')), 'surfaces JSON-corrupt error, got ' + JSON.stringify(r.body));
      } finally { await stopServer(server); }
      const after = bytesOf(sb.blobPath);
      assert(bytesEqual(before, after), 'config file bytes UNCHANGED after rejected SET');
      assert(!fs.existsSync(sb.auditPath), 'no audit record written for rejected SET');
    } finally { fs.rmSync(sb.root, { recursive: true, force: true }); clearEnv(); }
  });

  /* --- Case 4: corrupted JSON -> CLEAR rejected, file bytes UNCHANGED --- */
  await test('4. corrupted JSON -> CLEAR rejected (non-2xx), file bytes UNCHANGED', async () => {
    const sb = makeSandbox();
    try {
      const corrupt = Buffer.from('this is not valid json at all', 'utf8');
      fs.writeFileSync(sb.blobPath, corrupt);
      const before = bytesOf(sb.blobPath);
      const { adminToken } = wireEnv(sb);
      const { server, base } = await startServer(sb.endpointPath);
      try {
        const r = await httpJson(base, {
          method: 'POST',
          headers: { cookie: 'ac_sess=' + adminToken, host: '127.0.0.1', origin: base },
          body: { action: 'clear', reason: 'must not overwrite corrupt config' }
        });
        assert(r.status >= 400, 'CLEAR rejected non-2xx, got ' + r.status);
        assert(r.body && r.body.success !== true, 'never success:true on corrupt read');
      } finally { await stopServer(server); }
      const after = bytesOf(sb.blobPath);
      assert(bytesEqual(before, after), 'config file bytes UNCHANGED after rejected CLEAR');
      assert(!fs.existsSync(sb.auditPath), 'no audit record written for rejected CLEAR');
    } finally { fs.rmSync(sb.root, { recursive: true, force: true }); clearEnv(); }
  });

  /* --- Case 5: read error (blob path is a directory) -> fail-closed, no write --- */
  await test('5. read error -> fail-closed (non-2xx), no write', async () => {
    const sb = makeSandbox();
    try {
      // A real read fault: make the blob path a DIRECTORY so readFileSync throws.
      fs.mkdirSync(sb.blobPath, { recursive: true });
      const { adminToken } = wireEnv(sb);
      const { server, base } = await startServer(sb.endpointPath);
      try {
        const get = await httpJson(base, { method: 'GET', headers: { cookie: 'ac_sess=' + adminToken, host: '127.0.0.1', origin: base } });
        assert(get.status >= 400, 'GET read failure non-2xx, got ' + get.status);
        assert(get.body && get.body.success !== true, 'GET must not report success on read failure');

        const set = await httpJson(base, {
          method: 'POST',
          headers: { cookie: 'ac_sess=' + adminToken, host: '127.0.0.1', origin: base },
          body: { action: 'set', limit: 5000, reason: 'read failure must block write' }
        });
        assert(set.status >= 400, 'SET read failure non-2xx, got ' + set.status);
        assert(set.body && set.body.success !== true, 'SET must not report success on read failure');
      } finally { await stopServer(server); }
      assert(!fs.existsSync(sb.auditPath), 'no audit record on read failure');
      assert(fs.statSync(sb.blobPath).isDirectory(), 'blob path remains a directory (no file overwrite/delete)');
    } finally { fs.rmSync(sb.root, { recursive: true, force: true }); clearEnv(); }
  });

  /* --- Case 6: audit append failure -> rollback (bytes reverted) --- */
  await test('6. audit append failure -> rollback works (bytes reverted)', async () => {
    const sb = makeSandbox();
    try {
      seedValidBlob(sb, null);
      const priorOverride = null; // seeded override is null
      // Point the audit log under a plain FILE so mkdirSync/append fails.
      const blockFile = path.join(sb.root, 'audit-block');
      fs.writeFileSync(blockFile, 'x');
      process.env.QUOTA_LIMIT_AUDIT_LOG_PATH = path.join(blockFile, 'sub', 'audit.jsonl');
      process.env.QUOTA_LIMIT_BLOB_PATH = sb.blobPath;
      process.env.SESSION_SECRET = 'f1-fix-secret-' + Math.random().toString(36).slice(2);
      const adminSession = require(path.join(sb.root, 'lib', 'admin-session.js'));
      const adminToken = adminSession.createSessionToken({ userId: 'u-budi-1', username: 'budi', isAdmin: true });
      const { server, base } = await startServer(sb.endpointPath);
      try {
        const r = await httpJson(base, {
          method: 'POST',
          headers: { cookie: 'ac_sess=' + adminToken, host: '127.0.0.1', origin: base },
          body: { action: 'set', limit: 6000, reason: 'will fail audit' }
        });
        assert(r.status === 500, 'audit failure -> 500, got ' + r.status);
        assert(r.body && r.body.rolledBack === true, 'rolledBack:true, got ' + JSON.stringify(r.body));
        assert(r.body && r.body.success !== true, 'no success on audit failure');
      } finally { await stopServer(server); }

      // Rollback correctness is verified at the BYTE level of the persisted
      // payload: the prior override must be restored and NO partial/unaudited
      // SET value (6000) may remain in the file. (writeLimitBlob re-serializes
      // with JSON.stringify(payload, null, 2) and a fresh `updatedAt` timestamp,
      // so raw-byte equality with the compact seed embed is not the invariant.)
      const after = bytesOf(sb.blobPath).toString('utf8');
      assert(after.indexOf('6000') === -1, 'no leftover SET value 6000 in persisted bytes');
      const ql = require(path.join(sb.root, 'lib', 'quota-limit.js'));
      const persisted = ql.readLimitBlob();
      assert(persisted.ok === true, 'post-rollback blob is re-readable');
      assert(persisted.blob.override && persisted.blob.override.limit === priorOverride,
        'override restored to prior value null, got ' + JSON.stringify(persisted.blob.override));
      assert(persisted.blob.providerLimit === 10000 && persisted.blob.providerPeriodUsed === 1000,
        'provider limit + usage preserved through rollback, got ' + JSON.stringify(persisted.blob));
    } finally { fs.rmSync(sb.root, { recursive: true, force: true }); clearEnv(); }
  });

  /* --- Case 7: concurrent SET/CLEAR -> no lost update, one winner --- */
  await test('7. concurrent SET/CLEAR -> no lost update (final matches exactly one winner)', async () => {
    const sb = makeSandbox();
    try {
      seedValidBlob(sb, 5000);
      const { adminToken } = wireEnv(sb);
      const { server, base } = await startServer(sb.endpointPath);
      try {
        async function act(body) {
          return httpJson(base, {
            method: 'POST',
            headers: { cookie: 'ac_sess=' + adminToken, host: '127.0.0.1', origin: base },
            body
          });
        }
        const [setRes, clearRes] = await Promise.all([
          act({ action: 'set', limit: 7100, reason: 'race set' }),
          act({ action: 'clear', reason: 'race clear' })
        ]);
        assert(setRes.status === 200 && setRes.body && setRes.body.success === true, 'concurrent SET succeeds, got ' + JSON.stringify(setRes));
        assert(clearRes.status === 200 && clearRes.body && clearRes.body.success === true, 'concurrent CLEAR succeeds, got ' + JSON.stringify(clearRes));

        const ql = require(path.join(sb.root, 'lib', 'quota-limit.js'));
        const blob = ql.readLimitBlob().blob;
        assert(blob.override && (blob.override.limit === 7100 || blob.override.limit == null),
          'final override is exactly one winner (7100 or null), got ' + JSON.stringify(blob.override));

        // The final state must match the value carried in the LAST audit record.
        const lines = fs.readFileSync(sb.auditPath, 'utf8').trim().split('\n').filter(Boolean);
        assert(lines.length === 2, 'exactly two audit records (no lost/partial), got ' + lines.length);
        const lastRec = JSON.parse(lines[lines.length - 1]);
        const expectedFinal = lastRec.next && lastRec.next.overrideLimit != null ? lastRec.next.overrideLimit : null;
        assert(blob.override.limit === expectedFinal,
          'final config matches last audit record, got ' + blob.override.limit + ' vs ' + expectedFinal);
      } finally { await stopServer(server); }
    } finally { fs.rmSync(sb.root, { recursive: true, force: true }); clearEnv(); }
  });

  /* --- Case 8: provider UNKNOWN -> no capacity is created --- */
  await test('8. provider UNKNOWN -> no capacity is created (limit not invented)', async () => {
    const sb = makeSandbox();
    try {
      seedUnknownProviderBlob(sb);
      const { adminToken } = wireEnv(sb);
      const { server, base } = await startServer(sb.endpointPath);
      try {
        // SET a large override over an UNKNOWN provider snapshot.
        const set = await httpJson(base, {
          method: 'POST',
          headers: { cookie: 'ac_sess=' + adminToken, host: '127.0.0.1', origin: base },
          body: { action: 'set', limit: 50000, reason: 'must not invent capacity' }
        });
        assert(set.status === 200 && set.body && set.body.success === true, 'SET persists (override stored), got ' + JSON.stringify(set.body));
        // The override is an OPERATIONAL CAP only; with no fresh provider truth
        // the effective truth must still fail closed (no invented limit).
        assert(set.body.ok === false, 'response truth is fail-closed (ok:false), got ' + JSON.stringify(set.body));
        assert(set.body.limitKnown === false && set.body.limit == null, 'no invented limit, got ' + JSON.stringify({ l: set.body.limit, k: set.body.limitKnown }));

        const get = await httpJson(base, { method: 'GET', headers: { cookie: 'ac_sess=' + adminToken, host: '127.0.0.1', origin: base } });
        assert(get.status === 200, 'GET succeeds (read ok), got ' + get.status);
        assert(get.body && get.body.limitKnown === false && get.body.limit == null,
          'GET still fails closed with no capacity, got ' + JSON.stringify({ l: get.body.limit, k: get.body.limitKnown }));

        // providerLimit was never fabricated into the persisted blob.
        const ql = require(path.join(sb.root, 'lib', 'quota-limit.js'));
        const blob = ql.readLimitBlob().blob;
        assert(blob.providerLimit == null, 'providerLimit remains null (never invented), got ' + JSON.stringify(blob.providerLimit));
      } finally { await stopServer(server); }
    } finally { fs.rmSync(sb.root, { recursive: true, force: true }); clearEnv(); }
  });

  /* --- Case 9: unauthorized request -> rejected --- */
  await test('9. unauthorized request -> rejected', async () => {
    const sb = makeSandbox();
    try {
      seedValidBlob(sb, null);
      const before = bytesOf(sb.blobPath);
      const { adminToken } = wireEnv(sb);
      const adminSession = require(path.join(sb.root, 'lib', 'admin-session.js'));
      const memberToken = adminSession.createSessionToken({ userId: 'u2', username: 'member', isAdmin: false });
      const { server, base } = await startServer(sb.endpointPath);
      try {
        const guest = await httpJson(base, { method: 'GET', headers: { host: '127.0.0.1', origin: base } });
        assert(guest.status === 401 || guest.status === 403, 'guest denied, got ' + guest.status);
        assert(!(guest.body && guest.body.success), 'no success for guest');

        const member = await httpJson(base, { method: 'GET', headers: { cookie: 'ac_sess=' + memberToken, host: '127.0.0.1', origin: base } });
        assert(member.status === 403, 'non-admin 403, got ' + member.status);
        assert(!(member.body && member.body.success), 'no success for non-admin');
      } finally { await stopServer(server); }
      // Unauthorized requests must not touch the config file bytes.
      assert(fs.existsSync(sb.blobPath) && bytesEqual(before, bytesOf(sb.blobPath)), 'config untouched by unauthorized requests');
    } finally { fs.rmSync(sb.root, { recursive: true, force: true }); clearEnv(); }
  });
}

main()
  .then(async () => {
    /* --- Case 10: prior P0 quota suites still pass (run existing suites) --- */
    try {
      await test('10. prior P0 quota suites still PASS', async () => {
        const suites = [
          'test/v5/quota-f1-p0.test.js',
          'test/v5/quota-s2-admin-concurrency.test.js'
        ];
        for (const suite of suites) {
          const r = spawnSync(process.execPath, [path.join(REPO_ROOT, suite)], {
            cwd: REPO_ROOT,
            encoding: 'utf8'
          });
          let tail = '';
          if (r.stdout) {
            const lines = r.stdout.split('\n').filter(Boolean);
            tail = lines.slice(-3).join(' | ');
          }
          assert(r.status === 0, suite + ' must exit 0, got ' + r.status + (tail ? ' (' + tail + ')' : '') + (r.stderr ? ' stderr=' + r.stderr.slice(0, 200) : ''));
        }
      });
    } catch (e) {
      /* swallowed by test() */
    }
    const failed = results.filter((r) => !r.ok);
    process.stdout.write('\n' + (results.length - failed.length) + '/' + results.length + ' FIX1-fail-closed cases passed\n');
    for (const f of failed) process.stdout.write('  FAILED: ' + f.name + ' -> ' + f.error + '\n');
    process.exit(failed.length > 0 ? 1 : 0);
  })
  .catch((err) => {
    process.stdout.write('RUNNER FAILURE: ' + String((err && err.stack) || err) + '\n');
    process.exit(2);
  });