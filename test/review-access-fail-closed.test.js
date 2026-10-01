'use strict';

// ===========================================================================
// Security regression: api/review-access.js carried BOTH of its secrets in
// source, in a repository that is public.
//
//   const EXPECTED_TOKEN = process.env.REVIEW_ACCESS_TOKEN || 'autocuan-review-2026';
//   const REVIEW_PASSWORD_HASH = '42f38b0f...';
//
// The literal token was also written twice into public/index.html, so it was
// readable without even opening the repo.
//
// The password hash mattered more than its comment suggested. The browser
// hashes passwords client-side (public/index.html hashPassword), /api/login-user
// accepts that hash as the submitted credential, and lib/password-credential.js
// compares a LEGACY-format stored hash against it directly — so for a legacy row
// the stored hash IS the credential. Seeding the reviewer account with a
// published hash therefore published the reviewer login:
//
//   POST /api/review-access {"token":"autocuan-review-2026"}      -> seeds the row
//   POST /api/login-user    {"username":"review","passwordHash":"42f38b0f..."}
//                                                                -> valid session
//
// (Bounded impact: `review` resolves to free, not premium or admin — see
// lib/entitlements.js — and a successful legacy login migrates the row to
// scrypt, after which the published hash stops working.)
//
// Both secrets now come from the environment and the endpoint fails closed
// without them, and the seeded row is stored in the protected scrypt form so it
// is never a directly replayable legacy hash.
//
// LOCAL / STATIC + MOCKED ONLY. No browser, network, or real Supabase.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const passwordCredential = require('../lib/password-credential');

const RETIRED_TOKEN = 'autocuan' + '-review-' + '2026';
const RETIRED_HASH = '42f38b0f' + 'cf1e35d9d2f82c462376f33145d1f450aeb216900db3356338686f2b';

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

// Supabase stub where the review row does not yet exist, capturing any insert.
function seedingStub(captured) {
  return () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
      insert: (row) => { captured.row = row; return Promise.resolve({ error: null }); }
    })
  });
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
// The gate fails closed without configuration.
// ---------------------------------------------------------------------------
test('an unset REVIEW_ACCESS_TOKEN closes the gate instead of opening a default', async (t) => {
  withEnv(t, {
    REVIEW_ACCESS_TOKEN: undefined,
    SUPABASE_URL: 'https://example.test',
    SUPABASE_SERVICE_ROLE_KEY: 'test-key'
  });
  const handler = requireApiWithSupabaseStub('../api/review-access', seedingStub({}));

  for (const attempt of [RETIRED_TOKEN, '', 'anything', 'x'.repeat(64)]) {
    const res = makeRes();
    await handler({ method: 'POST', body: { token: attempt } }, res);
    assert.equal(res.statusCode, 403,
      'with no token configured, ' + JSON.stringify(attempt) + ' must be refused');
    assert.equal(res.body.success, false);
  }
});

test('the retired literal token is refused even when a different token is configured', async (t) => {
  withEnv(t, {
    REVIEW_ACCESS_TOKEN: 'a-rotated-reviewer-secret',
    SUPABASE_URL: 'https://example.test',
    SUPABASE_SERVICE_ROLE_KEY: 'test-key'
  });
  const handler = requireApiWithSupabaseStub('../api/review-access', seedingStub({}));
  const res = makeRes();
  await handler({ method: 'POST', body: { token: RETIRED_TOKEN } }, res);
  assert.equal(res.statusCode, 403);
});

// ---------------------------------------------------------------------------
// Seeding requires a configured credential, and stores it protected.
// ---------------------------------------------------------------------------
test('seeding without REVIEW_PASSWORD_HASH refuses rather than creating an account', async (t) => {
  withEnv(t, {
    REVIEW_ACCESS_TOKEN: 'a-rotated-reviewer-secret',
    REVIEW_PASSWORD_HASH: undefined,
    SUPABASE_URL: 'https://example.test',
    SUPABASE_SERVICE_ROLE_KEY: 'test-key'
  });
  const captured = {};
  const handler = requireApiWithSupabaseStub('../api/review-access', seedingStub(captured));
  const res = makeRes();
  await handler({ method: 'POST', body: { token: 'a-rotated-reviewer-secret' } }, res);

  assert.equal(res.statusCode, 503);
  assert.equal(captured.row, undefined, 'no account may be created without a configured credential');
});

test('a malformed REVIEW_PASSWORD_HASH is refused, not stored', async (t) => {
  withEnv(t, {
    REVIEW_ACCESS_TOKEN: 'a-rotated-reviewer-secret',
    REVIEW_PASSWORD_HASH: 'not-a-sha256-hash',
    SUPABASE_URL: 'https://example.test',
    SUPABASE_SERVICE_ROLE_KEY: 'test-key'
  });
  const captured = {};
  const handler = requireApiWithSupabaseStub('../api/review-access', seedingStub(captured));
  const res = makeRes();
  await handler({ method: 'POST', body: { token: 'a-rotated-reviewer-secret' } }, res);

  assert.equal(res.statusCode, 503);
  assert.equal(captured.row, undefined);
});

test('the seeded row stores a protected credential, never a replayable legacy hash', async (t) => {
  const configuredHash = 'a'.repeat(64);
  withEnv(t, {
    REVIEW_ACCESS_TOKEN: 'a-rotated-reviewer-secret',
    REVIEW_PASSWORD_HASH: configuredHash,
    SUPABASE_URL: 'https://example.test',
    SUPABASE_SERVICE_ROLE_KEY: 'test-key'
  });
  const captured = {};
  const handler = requireApiWithSupabaseStub('../api/review-access', seedingStub(captured));
  const res = makeRes();
  await handler({ method: 'POST', body: { token: 'a-rotated-reviewer-secret' } }, res);

  assert.equal(res.statusCode, 200);
  assert.ok(captured.row, 'the account must be created');
  assert.notEqual(captured.row.password_hash, configuredHash,
    'the raw client hash must never be stored — that form is directly replayable at /api/login-user');
  assert.ok(passwordCredential.isProtectedCredential(captured.row.password_hash),
    'the stored value must be in the protected scrypt form, like api/register-user.js');
  // And it must still verify against the configured hash the reviewer submits.
  assert.equal(
    passwordCredential.verifyStoredCredential(captured.row.password_hash, configuredHash).ok,
    true
  );
});

// ---------------------------------------------------------------------------
// No secret is left in shipped source.
// ---------------------------------------------------------------------------
test('no reviewer secret remains anywhere in shipped source', () => {
  const shipped = [];
  ['api', 'lib', 'public'].forEach((dir) => {
    const walk = (current) => {
      fs.readdirSync(current, { withFileTypes: true }).forEach((entry) => {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) return walk(full);
        if (!/\.(js|html|css)$/.test(entry.name)) return;
        shipped.push(full);
      });
    };
    walk(path.join(ROOT, dir));
  });

  shipped.forEach((file) => {
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(!source.includes(RETIRED_TOKEN),
      'retired review token still present in ' + path.relative(ROOT, file));
    assert.ok(!source.includes(RETIRED_HASH),
      'retired review password hash still present in ' + path.relative(ROOT, file));
  });
});

test('api/review-access.js reads both secrets from the environment', () => {
  const source = fs.readFileSync(path.join(ROOT, 'api', 'review-access.js'), 'utf8');
  assert.match(source, /process\.env\.REVIEW_ACCESS_TOKEN/);
  assert.match(source, /process\.env\.REVIEW_PASSWORD_HASH/);
  // No `|| 'literal'` fallback may creep back in beside either one.
  assert.doesNotMatch(source, /process\.env\.REVIEW_ACCESS_TOKEN\s*\|\|\s*['"][^'"]+['"]/,
    'a literal fallback would reopen the gate for everyone who can read the repo');
  assert.doesNotMatch(source, /process\.env\.REVIEW_PASSWORD_HASH\s*\|\|\s*['"][^'"]+['"]/);
});

// ---------------------------------------------------------------------------
// The page forwards the reviewer's URL token rather than knowing one.
// ---------------------------------------------------------------------------
test('the page carries no token of its own and forwards the URL one', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

  const tokenReader = html.indexOf('function reviewModeToken(');
  assert.ok(tokenReader > 0, 'reviewModeToken() must exist to read the token from the URL');

  // Brace-match the real function body rather than slicing at the first '}',
  // which lands inside the first statement.
  const start = html.indexOf('async function enterReviewMode(');
  assert.ok(start > 0, 'enterReviewMode must exist');
  const open = html.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > 0, 'enterReviewMode must be brace-balanced');
  const body = html.slice(start, end + 1);

  assert.match(body, /reviewModeToken\(\)/,
    'enterReviewMode must take the token from the URL, not from a constant');

  // The token must be captured before the query string is stripped. Compare
  // executable lines only: a comment mentioning replaceState would otherwise be
  // matched as the call itself.
  const code = body.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
  const capture = code.indexOf('reviewModeToken()');
  const strip = code.indexOf('replaceState');
  assert.ok(capture > 0 && strip > 0 && capture < strip,
    'the token must be read before history.replaceState removes the query string');
});
