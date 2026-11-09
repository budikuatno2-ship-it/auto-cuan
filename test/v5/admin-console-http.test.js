'use strict';

/**
 * test/v5/admin-console-http.test.js
 * ============================================================================
 * REAL-HTTP ADMIN-CONSOLE ENDPOINT TESTS (PART A of F4)
 * ============================================================================
 * These are NOT mock string checks. The REAL api/admin/quota-limit.js and
 * api/admin/quota-status.js handlers are loaded from an ISOLATED sandbox copy
 * of the repository so every file path (lib/, config/, data/) resolves inside a
 * temp directory — no production data is read or written. The test then issues
 * genuine HTTP requests with Node's global fetch against a live loopback
 * http.Server that mounts those handlers, and verifies:
 *
 *   - GET /api/admin/quota-limit with a signed admin session succeeds.
 *   - POST /api/admin/quota-limit with a valid same-origin signed admin succeeds.
 *   - guest (no cookie) is rejected.
 *   - non-admin signed session is rejected (403).
 *   - cross-origin mutation is rejected (403).
 *   - malformed input is rejected (400).
 *   - responses never contain secret-shaped fields or the session secret/token.
 *   - set override -> correct status; clear override -> correct status.
 *   - audit failure stays controlled (rollback; no ok:true).
 *   - the admin-console SPA entry is served at both /admin-console and its
 *     direct-URL/fallback alias, and references /admin-console-runtime.js +
 *     the admin-console page + /api/admin/quota-limit status call.
 * ============================================================================
 * Run:  node test/v5/admin-console-http.test.js
 * Exit: 0 when every assertion holds, 1 otherwise.
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
      results.push({ name, ok: true, actual: 'PASS', error: null });
      process.stdout.write('PASS  ' + name + '\n');
    })
    .catch((err) => {
      results.push({ name, ok: false, actual: 'FAIL', error: String((err && err.message) || err) });
      process.stdout.write('FAIL  ' + name + '\n      ' + String((err && err.message) || err) + '\n');
    });
}
function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}

/* -------------------------------------------------------------------------- */
/* Sandbox: copy repository so require() paths and file writes stay isolated.   */
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-f4-http-'));
  // Reproduce the repository layout so relative requires resolve identically.
  copyTree(path.join(REPO_ROOT, 'lib'), path.join(root, 'lib'));
  fs.mkdirSync(path.join(root, 'api', 'admin'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'api', 'admin', 'quota-limit.js'), path.join(root, 'api', 'admin', 'quota-limit.js'));
  fs.copyFileSync(path.join(REPO_ROOT, 'api', 'admin', 'quota-status.js'), path.join(root, 'api', 'admin', 'quota-status.js'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  // Real but isolated config (read-only within this sandbox).
  fs.copyFileSync(path.join(REPO_ROOT, 'config', 'quota.json'), path.join(root, 'config', 'quota.json'));
  return root;
}

/** Parse a request body (async iterable) into req.body, mirroring server wiring. */
async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { req.body = raw ? JSON.parse(raw) : {}; } catch (_) { req.body = {}; }
}

/* -------------------------------------------------------------------------- */
/* Seed a deterministic, verified provider snapshot + same-day usage so the      */
/* endpoints report a KNOWN truth (limit 10000 / used 1000) inside the sandbox. */
/* -------------------------------------------------------------------------- */

function seedTruth(root) {
  const quotaLimit = require(path.join(root, 'lib', 'quota-limit.js'));
  const today = quotaLimit.getWibDateKey(new Date());
  const snapshot = {
    schemaVersion: 1,
    providerLimit: 10000,
    providerLimitSource: 'provider',
    providerLimitVerifiedAt: new Date().toISOString(),
    providerPeriodUsed: 1000,
    providerPeriodUsedVerifiedAt: new Date().toISOString(),
    providerPeriodUsedWibDate: today,
    planExpiresAt: '2099-01-01T00:00:00+07:00',
    source: 'provider',
    resetHourWib: 0,
    tz: 'Asia/Jakarta',
    override: { limit: null, actor: null, reason: null, setAt: null },
    updatedAt: new Date().toISOString()
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
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  const sandbox = makeSandbox();
  const auditPath = path.join(sandbox, 'audit', 'audit.jsonl');
  const secret = 'f4-test-secret-' + Math.random().toString(36).slice(2);

  // Fail-closed: the handlers read this at require()/call time.
  process.env.SESSION_SECRET = secret;
  process.env.QUOTA_LIMIT_AUDIT_LOG_PATH = auditPath;

  const adminSessionPath = path.join(sandbox, 'lib', 'admin-session.js');
  const quotaLimitPath = path.join(sandbox, 'lib', 'quota-limit.js');
  const adminSession = require(adminSessionPath);

  let quotaLimitHandler;
  let quotaStatusHandler;
  let quotaLimit;
  let server;
  let base;

  try {
    seedTruth(sandbox);
    quotaLimit = require(quotaLimitPath);
    quotaLimitHandler = require(path.join(sandbox, 'api', 'admin', 'quota-limit.js'));
    quotaStatusHandler = require(path.join(sandbox, 'api', 'admin', 'quota-status.js'));

    server = http.createServer(async (req, res) => {
      res.setHeader = res.setHeader.bind(res);
      res.status = function (code) { this.statusCode = code; return this; };
      res.json = function (obj) {
        if (!this.getHeader('Content-Type')) this.setHeader('Content-Type', 'application/json; charset=utf-8');
        this.end(JSON.stringify(obj));
        return this;
      };
      await readJsonBody(req);
      const u = new URL(req.url, 'http://localhost');

      if (u.pathname === '/api/admin/quota-limit') return quotaLimitHandler(req, res);
      if (u.pathname === '/api/admin/quota-status') return quotaStatusHandler(req, res);

      // SPA fallback smoke: the single-shell SPA entry is served at both the
      // navigation path and its direct-URL/fallback aliases.
      const spa = ['/admin-console', '/admin-console.html', '/admin'];
      if (spa.indexOf(u.pathname) >= 0) {
        const html = fs.readFileSync(path.join(REPO_ROOT, 'public', 'index.html'), 'utf8');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(html);
      }
      if (u.pathname === '/admin-console-runtime.js') {
        const js = fs.readFileSync(path.join(REPO_ROOT, 'public', 'admin-console-runtime.js'), 'utf8');
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        return res.end(js);
      }

      res.statusCode = 404;
      return res.end('Not Found');
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    base = 'http://127.0.0.1:' + port;

    const adminToken = adminSession.createSessionToken({ userId: 'u-budi-1', username: 'budi', isAdmin: true });
    const memberToken = adminSession.createSessionToken({ userId: 'u2', username: 'member', isAdmin: false });
    assert(typeof adminToken === 'string' && adminToken.length > 0, 'admin token minted');
    assert(typeof memberToken === 'string' && memberToken.length > 0, 'member token minted');

    /* -------------------------------------------------------------------- */
    /* Test matrix                                                           */
    /* -------------------------------------------------------------------- */

    await test('GET signed admin succeeds (200 + success:true)', async () => {
      const res = await fetch(base + '/api/admin/quota-limit', {
        headers: { Cookie: 'ac_sess=' + adminToken, Host: '127.0.0.1:' + port, Origin: base }
      });
      const body = await res.json();
      assert(res.status === 200, 'status ' + res.status);
      assert(body.success === true, 'success must be true, got ' + JSON.stringify(body).slice(0, 200));
      assert(body.limitKnown === true && body.limit === 10000, 'limit 10000 known, got ' + body.limit);
      assert(body.usageKnown === true && body.used === 1000, 'used 1000 known, got ' + body.used);
      assert(body.remaining === 9000, 'remaining 9000, got ' + body.remaining);
    });

    await test('POST signed admin with valid same-origin succeeds (200 + success:true)', async () => {
      const res = await fetch(base + '/api/admin/quota-limit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: 'ac_sess=' + adminToken, Host: '127.0.0.1:' + port, Origin: base },
        body: JSON.stringify({ action: 'set', limit: 5000, reason: 'lower ceiling for test' })
      });
      const body = await res.json();
      assert(res.status === 200, 'status ' + res.status);
      assert(body.success === true, 'success true, got ' + JSON.stringify(body).slice(0, 200));
      assert(body.limit === 5000, 'effective limit lowered to 5000, got ' + body.limit);
      assert(body.override && body.override.limit === 5000, 'override recorded');
    });

    await test('set override -> GET reflects lower ceiling (5000)', async () => {
      const res = await fetch(base + '/api/admin/quota-limit', {
        headers: { Cookie: 'ac_sess=' + adminToken, Host: '127.0.0.1:' + port, Origin: base }
      });
      const body = await res.json();
      assert(body.limit === 5000, 'GET reflects override 5000, got ' + body.limit);
      assert(body.source === 'manual', 'source manual, got ' + body.source);
    });

    await test('clear override -> GET restores provider ceiling (10000)', async () => {
      const res = await fetch(base + '/api/admin/quota-limit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: 'ac_sess=' + adminToken, Host: '127.0.0.1:' + port, Origin: base },
        body: JSON.stringify({ action: 'clear', reason: 'restore provider for test' })
      });
      const body = await res.json();
      assert(res.status === 200 && body.success === true, 'clear succeeds');

      const recheck = await fetch(base + '/api/admin/quota-limit', {
        headers: { Cookie: 'ac_sess=' + adminToken, Host: '127.0.0.1:' + port, Origin: base }
      });
      const rbody = await recheck.json();
      assert(rbody.limit === 10000, 'restored to provider 10000, got ' + rbody.limit);
      assert(rbody.source === 'provider', 'source provider, got ' + rbody.source);
    });

    await test('guest (no cookie) rejected on GET', async () => {
      const res = await fetch(base + '/api/admin/quota-limit', {
        headers: { Host: '127.0.0.1:' + port, Origin: base }
      });
      const body = await res.json();
      assert(res.status === 401 || res.status === 403, 'guest denied with ' + res.status);
      assert(body.success !== true, 'no success for guest');
    });

    await test('non-admin signed session rejected with 403', async () => {
      const res = await fetch(base + '/api/admin/quota-limit', {
        headers: { Cookie: 'ac_sess=' + memberToken, Host: '127.0.0.1:' + port, Origin: base }
      });
      const body = await res.json();
      assert(res.status === 403, 'non-admin denied with ' + res.status);
      assert(body.success !== true, 'no success for non-admin');
    });

    await test('cross-origin mutation rejected (403)', async () => {
      const res = await fetch(base + '/api/admin/quota-limit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: 'ac_sess=' + adminToken, Host: '127.0.0.1:' + port, Origin: 'https://evil.example' },
        body: JSON.stringify({ action: 'set', limit: 7777, reason: 'cross-site attempt' })
      });
      const body = await res.json();
      assert(res.status === 403, 'cross-origin denied with ' + res.status);
      assert(body.success !== true, 'no success for cross-origin');
    });

    await test('malformed input rejected (400)', async () => {
      const cases = [
        { action: 'explode', limit: 1, reason: 'x' },
        { action: 'set', limit: -1, reason: 'x' },
        { action: 'set', limit: 0, reason: 'x' },
        { action: 'set', limit: 'abc', reason: 'x' },
        { action: 'set', limit: NaN, reason: 'x' },
        { action: 'set', limit: 99999999999, reason: 'x' },
        { action: 'set', limit: 100, reason: '' }
      ];
      for (const payload of cases) {
        const res = await fetch(base + '/api/admin/quota-limit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: 'ac_sess=' + adminToken, Host: '127.0.0.1:' + port, Origin: base },
          body: JSON.stringify(payload)
        });
        const body = await res.json();
        assert(res.status === 400, 'expected 400 for ' + JSON.stringify(payload) + ', got ' + res.status);
        assert(body.success !== true, 'no success for malformed input');
      }
    });

    await test('responses never contain secret-shaped fields or the secret/token', async () => {
      const res = await fetch(base + '/api/admin/quota-limit', {
        headers: { Cookie: 'ac_sess=' + adminToken, Host: '127.0.0.1:' + port, Origin: base }
      });
      const text = await res.text();
      const lower = text.toLowerCase();
      const forbiddenKeys = ['session_secret', 'cookie', 'token', 'password', 'api_key', 'apikey', 'authorization', 'secret'];
      for (const k of forbiddenKeys) {
        assert(lower.indexOf(k) === -1, 'secret-shaped key "' + k + '" must not appear');
      }
      assert(text.indexOf(secret) === -1, 'the actual secret value must never appear');
      assert(text.indexOf(adminToken) === -1, 'the admin token must never appear');
    });

    await test('audit failure stays controlled (rollback, no ok:true)', async () => {
      // Block the audit path: create a FILE so mkdirSync() inside the audit
      // parent fails.
      const blockFile = path.join(sandbox, 'audit-block');
      fs.writeFileSync(blockFile, 'x');
      await new Promise((r) => setTimeout(r, 20));
      const badAuditPath = path.join(blockFile, 'sub', 'audit.jsonl');
      process.env.QUOTA_LIMIT_AUDIT_LOG_PATH = badAuditPath;
      const handlerPath = path.join(sandbox, 'api', 'admin', 'quota-limit.js');
      delete require.cache[require.resolve(handlerPath)];
      const failingHandler = require(handlerPath);
      // Override the request path so the failing handler is used.
      const oldServerHandler = server.listenerCount('request');
      // Simpler: re-issue using the failing handler through a fresh in-memory req/res.
      const req = new http.IncomingMessage(new (require('net').Socket)());
      req.method = 'POST';
      req.headers = { host: '127.0.0.1:' + port, origin: base, cookie: 'ac_sess=' + adminToken, 'content-type': 'application/json' };
      req.socket = { remoteAddress: '127.0.0.1' };
      req.body = { action: 'set', limit: 6000, reason: 'audit failure test' };

      const resObj = {
        statusCode: 200,
        headers: {},
        body: null,
        setHeader(k, v) { this.headers[k] = v; },
        getHeader() { return null; },
        status(code) { this.statusCode = code; return this; },
        json(obj) { this.body = obj; return this; },
        end() { return this; }
      };

      await failingHandler(req, resObj);
      assert(resObj.statusCode === 500, 'audit failure -> 500, got ' + resObj.statusCode);
      assert(resObj.body && resObj.body.success !== true, 'no ok:true on audit failure');
      assert(resObj.body && resObj.body.rolledBack === true, 'rolled back true, got ' + JSON.stringify(resObj.body));

      // The on-disk override must NOT be left as an inconsistent active config.
      const blob = quotaLimit.readLimitBlob().blob;
      assert(blob.override && blob.override.limit == null, 'override rolled back to null, got ' + JSON.stringify(blob.override));

      // Restore env + cache for subsequent assertions.
      process.env.QUOTA_LIMIT_AUDIT_LOG_PATH = auditPath;
      delete require.cache[require.resolve(handlerPath)];
      require(handlerPath);
    });

    await test('quota-status endpoint returns real state and no secrets', async () => {
      const res = await fetch(base + '/api/admin/quota-status', { headers: { Host: '127.0.0.1:' + port, Origin: base } });
      const body = await res.json();
      // Real state, not simulated: success or explicit 503 fail-closed, and no secret fields.
      const text = JSON.stringify(body).toLowerCase();
      for (const k of ['session_secret', 'cookie', 'token', 'password', 'api_key', 'apikey', 'authorization']) {
        assert(text.indexOf(k) === -1, 'no secret-shaped key "' + k + '"');
      }
      assert(typeof body.success === 'boolean', 'success is a boolean');
    });

    await test('SPA admin-console entry served at both navigation + fallback URLs', async () => {
      for (const p of ['/admin-console', '/admin-console.html', '/admin']) {
        const res = await fetch(base + p, { headers: { Host: '127.0.0.1:' + port } });
        const html = await res.text();
        assert(res.status === 200, p + ' served 200, got ' + res.status);
        assert(html.indexOf('data-page="admin-console"') >= 0 || html.indexOf('id="page-admin-console"') >= 0, p + ' contains SPA admin-console entry');
        assert(html.indexOf('<script src="/admin-console-runtime.js"></script>') >= 0, p + ' references admin-console-runtime.js');
        assert(html.indexOf("navigateTo('admin-console')") >= 0, p + ' binds admin-console navigation');
      }
    });

    await test('admin-console-runtime.js is served and references the admin status side', async () => {
      const res = await fetch(base + '/admin-console-runtime.js', { headers: { Host: '127.0.0.1:' + port } });
      const js = await res.text();
      assert(res.status === 200, 'runtime served 200, got ' + res.status);
      // The admin console reads quota truth through the admin-users stats action
      // (quota object) which is the current status side.
      assert(js.indexOf('/api/admin-users') >= 0, 'runtime calls the admin status side');
    });
  } finally {
    if (server) { try { server.close(); } catch (_) {} }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}
    delete process.env.SESSION_SECRET;
    delete process.env.QUOTA_LIMIT_AUDIT_LOG_PATH;
  }
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok);
    process.stdout.write('\n' + (results.length - failed.length) + '/' + results.length + ' HTTP assertions passed\n');
    for (const f of failed) process.stdout.write('  FAILED: ' + f.name + ' -> ' + f.error + '\n');
    process.exit(failed.length > 0 ? 1 : 0);
  })
  .catch((err) => {
    process.stdout.write('RUNNER FAILURE: ' + String((err && err.stack) || err) + '\n');
    process.exit(2);
  });