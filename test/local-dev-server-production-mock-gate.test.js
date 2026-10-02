'use strict';

// BUG-RT-03 regression — production must never receive development mock
// admin/review responses from tools/local-dev-server.js.
//
// The real server is spawned twice:
//   1. production signals (NODE_ENV=production, and separately pm_id) — every
//      mock interceptor must be unreachable; traffic reaches canonical api/*.js
//      handlers, which answer 405 to these unauthenticated requests.
//   2. development (NODE_ENV=development) — preview mocks must remain available.
//
// No network calls leave the loopback interface; no production data is touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER_JS = path.join(ROOT, 'tools', 'local-dev-server.js');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function request(port, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'GET', headers: headers || {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8')
        }));
      }
    );
    req.setTimeout(8000, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function waitForServer(port, timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    try {
      const res = await request(port, '/register.html');
      if (res.status === 200) return;
    } catch (_) { /* retry */ }
    if (Date.now() - start > timeoutMs) throw new Error('server did not start on port ' + port);
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function startServer(extraEnv) {
  const port = await getFreePort();
  const runnerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autocuan-runner-empty-'));
  // Non-empty dummy values win over any real repo .env (loadEnvFile is
  // first-wins and only fills missing keys), so canonical handlers can never
  // reach real Supabase/Gemini/Telegram services from this test.
  const isolationEnv = {
    PORT: String(port),
    HOST: '127.0.0.1',
    AUTO_CUAN_RUNNER_DIR: runnerDir,
    SUPABASE_URL: 'http://127.0.0.1:9',
    SUPABASE_SERVICE_ROLE_KEY: 'dummy-service-role-key',
    CRON_SECRET: 'dummy-cron-secret',
    SESSION_SECRET: 'dummy-session-secret',
    TELEGRAM_ENABLED: '0'
  };
  const child = spawn(process.execPath, [SERVER_JS], {
    cwd: ROOT,
    env: Object.assign({}, process.env, isolationEnv, extraEnv),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (d) => { output += String(d); });
  child.stderr.on('data', (d) => { output += String(d); });

  try {
    await waitForServer(port);
  } catch (err) {
    child.kill();
    throw new Error(err.message + '\n--- server output ---\n' + output.slice(0, 4000));
  }
  return {
    port,
    stop() {
      try { child.kill(); } catch (_) {}
      fs.rmSync(runnerDir, { recursive: true, force: true });
    }
  };
}

const MOCK_MARKERS = ['admin-budi-id', '"isAdmin":true', '"role":"ADMIN"', 'local-dev-admin'];

function assertNoMockMarkers(body, label) {
  for (const marker of MOCK_MARKERS) {
    assert.equal(
      body.includes(marker),
      false,
      label + ' must not expose development mock marker ' + marker
    );
  }
}

test('RT-03 A+B: production unauthenticated admin/review requests never return mock JSON', async () => {
  const server = await startServer({ NODE_ENV: 'production' });
  try {
    const admin = await request(server.port, '/api/admin-users');
    assert.equal(admin.status, 405, 'canonical api/admin-users.js answers 405 to GET');
    assertNoMockMarkers(admin.body, 'GET /api/admin-users');

    const review = await request(server.port, '/api/review-access');
    assert.equal(review.status, 405, 'canonical api/review-access.js answers 405 to GET');
    assertNoMockMarkers(review.body, 'GET /api/review-access');

    // Same requests while attempting to self-enable preview mode.
    const adminPreview = await request(server.port, '/api/admin-users?preview=1', { 'X-AutoCuan-Preview': '1' });
    assert.equal(adminPreview.status, 405, 'client preview headers cannot re-enable mocks in production');
    assertNoMockMarkers(adminPreview.body, 'preview-forced GET /api/admin-users');

    const reviewPreview = await request(server.port, '/api/review-access?preview=1', { 'X-AutoCuan-Preview': '1' });
    assert.equal(reviewPreview.status, 405, 'client preview headers cannot re-enable mocks in production');
    assertNoMockMarkers(reviewPreview.body, 'preview-forced GET /api/review-access');
  } finally {
    server.stop();
  }
});

test('RT-03 C: production cannot reach preview HTML or other dev mock interceptors', async () => {
  const server = await startServer({ NODE_ENV: 'production' });
  try {
    for (const previewPath of ['/preview/dashboard', '/preview/landing', '/preview/kelola-keuangan']) {
      const res = await request(server.port, previewPath);
      assert.equal(res.status, 404, previewPath + ' must be 404 in production');
      assert.equal(res.body.includes('autocuan-preview-bar'), false);
      assert.equal(res.body.includes('__AUTOCUAN_PREVIEW_USER__'), false);
    }

    // Maintenance bypass must be gone: canonical handler answers (no DB env in
    // the test env resolves to the documented degraded 200/500, never the old
    // unconditional maintenance:false mock object shape).
    const maintenance = await request(server.port, '/api/maintenance-settings');
    assert.notEqual(maintenance.status, 200, 'GET is not a canonical maintenance method');
    assert.equal(maintenance.body.includes('"operational":true'), false);

    // Reset-password dev fallback (admin-budi-id session-status) unreachable.
    const sessionStatus = await request(server.port, '/api/reset-password?action=session-status');
    assertNoMockMarkers(sessionStatus.body, 'GET /api/reset-password?action=session-status');

    // Sector-hot mock bucket unreachable even with the preview signal.
    // action=screener is cron-gated in the canonical handler (401 before any
    // external call), so the old MOCK_SWING_KONGLO payload must never come
    // back to a client that sends X-AutoCuan-Preview: 1.
    const sector = await request(server.port, '/api/sector-hot?action=screener', { 'X-AutoCuan-Preview': '1' });
    assert.equal(sector.status, 401, 'canonical sector-hot denies unauthenticated screener');
    assert.equal(sector.body.includes('MOCK'), false);
    assert.equal(sector.body.includes('"results"'), false, 'mock screener payload must not be served');
  } finally {
    server.stop();
  }
});

test('RT-03 C2: PM2 runtime signal alone (pm_id) also disables preview mocks', async () => {
  const server = await startServer({ NODE_ENV: '', pm_id: '7' });
  try {
    const preview = await request(server.port, '/preview/dashboard');
    assert.equal(preview.status, 404, 'a PM2-managed process must never serve preview HTML');

    const admin = await request(server.port, '/api/admin-users', { 'X-AutoCuan-Preview': '1' });
    assertNoMockMarkers(admin.body, 'PM2-mode GET /api/admin-users');
  } finally {
    server.stop();
  }
});

test('RT-03 D: development mode keeps the explicit preview boundary working', async () => {
  // pm_id: undefined is skipped by child_process, so the child env truly has no
  // PM2 signal (an empty-string pm_id would count as present).
  const server = await startServer({ NODE_ENV: 'development', pm_id: undefined });
  try {
    const preview = await request(server.port, '/preview/dashboard');
    assert.equal(preview.status, 200, 'preview HTML must remain available in development');
    assert.match(preview.body, /autocuan-preview-bar/);

    const admin = await request(server.port, '/api/admin-users');
    assert.equal(admin.status, 200, 'development admin mock must remain for SPA verification');
    assert.match(admin.body, /admin-budi-id/);
  } finally {
    server.stop();
  }
});

test('RT-03 static: the preview gate is centralized and every mock block is guarded', () => {
  const src = fs.readFileSync(SERVER_JS, 'utf8');
  assert.match(src, /const PREVIEW_MOCKS_ENABLED = !IS_PRODUCTION_RUNTIME/);
  assert.match(src, /process\.env\.NODE_ENV === 'production'/);
  assert.match(src, /process\.env\.VERCEL_ENV === 'production'/);
  assert.match(src, /process\.env\.pm_id != null/);

  // The isPreview signal itself is gated, so it can never be true in
  // production even when a client sends X-AutoCuan-Preview: 1 or ?preview=1.
  assert.match(src, /const isPreview = PREVIEW_MOCKS_ENABLED && Boolean\(/);

  // Every endpoint-specific mock block must carry the explicit gate.
  const guardedBlocks = (src.match(/PREVIEW_MOCKS_ENABLED &&/g) || []).length;
  assert.ok(guardedBlocks >= 12, 'expected at least 12 guarded mock blocks, found ' + guardedBlocks);

  // Raw client-controllable preview headers may only be consulted in the
  // single centralized isPreview computation.
  const rawPreviewHeaderUses = (src.match(/x-autocuan-preview/g) || []).length;
  assert.equal(rawPreviewHeaderUses, 1, 'client preview header must only be read once (central gate)');

  // The preview HTML route must be closed by the production guard.
  assert.match(src, /if \(!PREVIEW_MOCKS_ENABLED && \(pathname === '\/preview' \|\| pathname\.startsWith\('\/preview\/'\)\)\)/);
});
