'use strict';

// ===========================================================================
// Batch 3 (HIGH security) regression lock:
//   F-019 / F-094  hardcoded review-access token (api + build runner)
//   F-037          LEGACY_BUDI_PASSWORD_HASH backdoor (api/login-user.js)
//   F-038          BYOK master-key fallback to a source literal
//   F-039          Origin-header device-binding bypass (isVercelPreviewRequest)
//
// LOCAL / STATIC + MOCKED ONLY. No browser, network, or real Supabase.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const RETIRED_BUILD_TOKEN = 'vercel-build-secure-token' + '-entropy-minimum-32b';

// The historical backdoor accepted sha256('._autocuan_salt_2024'). It is split
// here so this test never ships the literal it guards against.
const RETIRED_SALT = '._autocuan' + '_salt_2024';

function requireApiWithSupabaseStub(relPath, createClientImpl) {
  const origLoad = Module._load;
  const abs = require.resolve(relPath);
  delete require.cache[abs];
  Module._load = function (request) {
    if (request === '@supabase/supabase-js') return { createClient: createClientImpl || function () { return {}; } };
    return origLoad.apply(this, arguments);
  };
  try { return require(relPath); }
  finally { Module._load = origLoad; delete require.cache[abs]; }
}

function makeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; }
  };
}

function withEnv(t, values) {
  const previous = {};
  Object.keys(values).forEach((key) => {
    previous[key] = process.env[key];
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  });
  t.after(() => {
    Object.keys(previous).forEach((key) => {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    });
  });
}

// ---------------------------------------------------------------------------
// F-019 / F-094: the review token literal is gone from source, and an unset
// REVIEW_ACCESS_TOKEN now fails closed on Vercel too (no env exception).
// ---------------------------------------------------------------------------
test('F-019/F-094: the retired build token no longer appears in shipped source', () => {
  const files = [
    'api/review-access.js',
    'tools/run-build-test-suite.js',
    'public/index.html'
  ];
  files.forEach((rel) => {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(!source.includes(RETIRED_BUILD_TOKEN),
      'retired build token still present in ' + rel);
  });
});

test('F-019: an unset REVIEW_ACCESS_TOKEN fails closed even under VERCEL', async (t) => {
  withEnv(t, {
    REVIEW_ACCESS_TOKEN: undefined,
    VERCEL: '1',
    SUPABASE_URL: 'https://example.test',
    SUPABASE_SERVICE_ROLE_KEY: 'test-key'
  });
  const handler = requireApiWithSupabaseStub('../api/review-access', () => ({}));

  for (const attempt of [RETIRED_BUILD_TOKEN, '', 'anything']) {
    const res = makeRes();
    await handler({ method: 'POST', body: { token: attempt } }, res);
    assert.equal(res.statusCode, 403,
      'the retired token must be refused even in a Vercel build: ' + JSON.stringify(attempt));
  }
});

test('F-013: the build runner mints an ephemeral token instead of a shared literal', () => {
  const source = fs.readFileSync(path.join(ROOT, 'tools', 'run-build-test-suite.js'), 'utf8');
  assert.match(source, /process\.env\.REVIEW_ACCESS_TOKEN\s*=\s*crypto\.randomBytes/,
    'the runner must generate a per-run token');
  assert.match(source, /require\('crypto'\)/);
});

// ---------------------------------------------------------------------------
// F-037: the legacy budi hash backdoor is removed; login is DB-only.
// ---------------------------------------------------------------------------
test('F-037: no legacy budi password hash path remains in api/login-user.js', () => {
  const source = fs.readFileSync(path.join(ROOT, 'api', 'login-user.js'), 'utf8');
  assert.ok(!source.includes('LEGACY_BUDI_PASSWORD_HASH'));
  assert.ok(!source.includes('matchesLegacyBudiPassword'));
  assert.ok(!source.includes(RETIRED_SALT), 'the salted backdoor seed must not remain in source');
});

test('F-037: a legacy-shaped budi login without a device is refused generically', async (t) => {
  withEnv(t, {
    SESSION_SECRET: 'test-session-secret-abcdefghijklmnop',
    SUPABASE_URL: 'https://example.test',
    SUPABASE_SERVICE_ROLE_KEY: 'test-key'
  });
  const handler = requireApiWithSupabaseStub('../api/login-user', () => ({}));

  const res = makeRes();
  await handler({
    method: 'POST',
    headers: { host: 'autocuan.web.id', origin: 'https://autocuan.web.id' },
    body: { username: 'budi', passwordHash: 'a'.repeat(64) }
  }, res);

  // No device id -> generic "data tidak lengkap"; never a session.
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
  assert.equal(res.headers['Set-Cookie'], undefined);
});

// ---------------------------------------------------------------------------
// F-039: preview detection keys off the routed host, never the client Origin.
// ---------------------------------------------------------------------------
function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, 'must find: ' + signature);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces for ' + signature);
}

test('F-039: isVercelPreviewRequest ignores a client-supplied Origin', () => {
  const source = fs.readFileSync(path.join(ROOT, 'api', 'login-user.js'), 'utf8');
  const body = extractFunction(source, 'function isVercelPreviewRequest(');
  assert.ok(!/headers\.origin|headers\['origin'\]|headers\.referer/.test(body),
    'preview detection must not read the client Origin/Referer');

  // Reproduce the fixed logic in isolation.
  const OFFICIAL_HOSTS = ['autocuan.web.id', 'www.autocuan.web.id'];
  const isPreview = (req) => {
    const host = String(req.headers.host || '').split(':')[0].trim().toLowerCase();
    if (!host) return false;
    if (OFFICIAL_HOSTS.includes(host)) return false;
    return host.endsWith('.vercel.app');
  };

  // Production host with an attacker Origin must NOT be treated as preview.
  assert.equal(isPreview({ headers: { host: 'autocuan.web.id', origin: 'https://evil.vercel.app' } }), false);
  // Real preview host is still recognised.
  assert.equal(isPreview({ headers: { host: 'auto-cuan-abc123.vercel.app' } }), true);
  // Unknown host is not preview.
  assert.equal(isPreview({ headers: { host: 'example.test' } }), false);
  assert.equal(isPreview({ headers: {} }), false);
});

// ---------------------------------------------------------------------------
// F-038: BYOK encryption is fail-closed without a configured secret.
// ---------------------------------------------------------------------------
test('F-038: encrypting without a configured secret throws a config error, no literal fallback', (t) => {
  const credentials = require('../lib/user-ai-credentials');
  withEnv(t, { APP_SECRET: undefined, ENCRYPTION_SECRET: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined });

  assert.throws(
    () => credentials.encryptApiKey('AIzaSyA_SampleTestKey_ForUserA_12345678'),
    (err) => err && err.code === 'AI_CREDENTIAL_KEY_UNCONFIGURED'
  );

  const source = fs.readFileSync(path.join(ROOT, 'lib', 'user-ai-credentials.js'), 'utf8');
  assert.ok(!source.includes('autocuan-chart-ai-key-secret-seed'),
    'the static fallback seed must be gone');
});

test('F-038: saveUserApiKey reports a configuration error instead of storing under a public key', async (t) => {
  const credentials = require('../lib/user-ai-credentials');
  credentials.clearMemoryStoreForTesting();
  withEnv(t, { APP_SECRET: undefined, ENCRYPTION_SECRET: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined });

  const saved = await credentials.saveUserApiKey(null, 'user-unconfigured', 'AIzaSyA_SampleTestKey_ForUserA_12345678');
  assert.equal(saved.ok, false);
  assert.equal(saved.status, 503);
  assert.equal(saved.error, 'Kunci enkripsi kredensial AI belum dikonfigurasi (APP_SECRET/ENCRYPTION_SECRET).');
});