'use strict';

// Batch 7 (HIGH) F-087: Stored XSS in the admin log viewer + username charset.
//
// Two layers are covered:
//   1. API: api/register-user.js must reject usernames containing HTML/script
//      metacharacters (charset allowlist), so a hostile username can never be
//      stored in the first place.
//   2. UI: loadAdminLogs in public/index.html must HTML-escape every dynamic
//      value (username, ticker, generic table cells and column headers) before
//      it reaches innerHTML, so even a legacy row already in the database
//      renders as inert text.
//
// LOCAL / MOCKED ONLY: no browser, no network, no Supabase, no secrets.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'public', 'index.html');

// HTML entities are built at runtime from fragments: the harness that writes
// this test file decodes literal "<"/">" sequences, so the assertions
// must never rely on those exact characters surviving on disk.
const LT = '&' + 'lt;';
const GT = '&' + 'gt;';

// The exact text escapeAdminHtml should produce for a raw string.
function escaped(raw) {
  return raw.replace(/&/g, '&' + 'amp;').replace(/</g, LT).replace(/>/g, GT);
}

// ---------------------------------------------------------------------------
// UI layer: extract escapeAdminHtml + loadAdminLogs from index.html and run
// them in a headless vm sandbox with a fake DOM + a stubbed fetch.
// ---------------------------------------------------------------------------
function extractBetween(html, startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `expected to find "${startMarker}" before "${endMarker}"`);
  return html.slice(start, end);
}

function makeFakeEl() {
  return { innerHTML: '' };
}

function loadAdminLogsUi(logsPayload) {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const escapeSrc = extractBetween(html, 'function escapeAdminHtml(value) {', '\n// Escape a value for safe use INSIDE');
  const logsSrc = extractBetween(html, 'async function loadAdminLogs(type) {', '\n// openAdminAiDetail and closeAdminAiModal removed');

  const container = makeFakeEl();
  const sandbox = {
    lastAdminLogType: 'login',
    cachedAdminData: null,
    document: { getElementById: function (id) { return id === 'adminLogsContainer' ? container : null; } },
    localStorage: { getItem: function () { return 'budi'; } },
    skeletonRows: function () { return '<div class="skeleton"></div>'; },
    fetch: function () {
      return Promise.resolve({
        ok: true,
        json: function () { return Promise.resolve(logsPayload); }
      });
    },
    console: console
  };
  vm.createContext(sandbox);
  vm.runInContext(escapeSrc + '\n' + logsSrc + '\nthis.__loadAdminLogs = loadAdminLogs;', sandbox);
  return { loadAdminLogs: sandbox.__loadAdminLogs, container: container };
}

const XSS_USERNAME = '<img src=x onerror=alert(1)>';
const XSS_TICKER = '<svg/onload=alert(2)>';

function analysisPayload() {
  return {
    success: true,
    summary: { totalLogins: 1, totalSearches: 1, totalAIAnalyses: 1, mostSearchedTicker: XSS_TICKER },
    aiAnalysisLogs: [{ ticker: XSS_TICKER, username: XSS_USERNAME, mode: '<b>mode</b>', created_at: '2026-01-01T00:00:00Z' }]
  };
}

function genericPayload() {
  return {
    success: true,
    summary: { totalLogins: 1, totalSearches: 1, totalAIAnalyses: 0, mostSearchedTicker: '-' },
    loginLogs: [{ '<th>evil</th>': XSS_USERNAME, username: XSS_USERNAME, is_admin: false }]
  };
}

test('F-087 UI: analysis card escapes username/ticker/mode (no raw HTML reaches innerHTML)', async function () {
  const { loadAdminLogs, container } = loadAdminLogsUi(analysisPayload());
  await loadAdminLogs('analysis');
  assert.ok(container.innerHTML.indexOf(XSS_USERNAME) === -1, 'raw username tag must not appear');
  assert.ok(container.innerHTML.indexOf(XSS_TICKER) === -1, 'raw ticker tag must not appear');
  assert.ok(container.innerHTML.indexOf(escaped(XSS_USERNAME)) >= 0, 'username must be escaped');
  assert.ok(container.innerHTML.indexOf(escaped(XSS_TICKER)) >= 0, 'ticker must be escaped');
  assert.ok(container.innerHTML.indexOf(escaped('<b>mode</b>')) >= 0, 'mode must be escaped');
});

test('F-087 UI: generic table escapes cell values and dynamic column headers', async function () {
  const { loadAdminLogs, container } = loadAdminLogsUi(genericPayload());
  await loadAdminLogs('login');
  assert.ok(container.innerHTML.indexOf('<th>evil</th>') === -1, 'raw header tag must not appear');
  assert.ok(container.innerHTML.indexOf(escaped('<th>evil</th>')) >= 0, 'header must be escaped');
  assert.ok(container.innerHTML.indexOf(XSS_USERNAME) === -1, 'raw cell tag must not appear');
  assert.ok(container.innerHTML.indexOf(escaped(XSS_USERNAME)) >= 0, 'cell value must be escaped');
});

test('F-087 UI: summary error string is escaped too', async function () {
  const raw = '<script>alert(3)</script>';
  const { loadAdminLogs, container } = loadAdminLogsUi({ success: false, error: raw });
  await loadAdminLogs('login');
  assert.ok(container.innerHTML.indexOf(raw) === -1, 'raw error tag must not appear');
  assert.ok(container.innerHTML.indexOf(escaped(raw)) >= 0, 'error must be escaped');
});

// ---------------------------------------------------------------------------
// API layer: registration must reject hostile usernames before any write.
// ---------------------------------------------------------------------------
const registerModule = require('../api/register-user');
const { USERNAME_RE } = registerModule.__test;
const accountTerms = require('../lib/account-terms');
const TERMS_FIELDS = { termsAccepted: true, termsVersion: accountTerms.CURRENT_TERMS_VERSION };

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; }
  };
}

// Mirrors the handler's data access: username lookup, the atomic RPC, and the
// terms-acceptance audit insert.
function makeSupabaseMock() {
  const captured = { rpcName: null, auditInserted: null };
  const client = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        insert(row) { captured.auditInserted = row; return Promise.resolve({ data: row, error: null }); },
        update() { return this; }
      };
    },
    rpc(name, args) {
      captured.rpcName = name;
      return Promise.resolve({ data: [{ id: 1, username: args && args.p_username, created_at: 'now', challenge_id: 'ch-1' }], error: null });
    }
  };
  return { client: client, captured: captured };
}

function loadHandlerWithMock(mock) {
  const supabasePath = require.resolve('@supabase/supabase-js');
  const registerPath = require.resolve('../api/register-user');
  const prevSupabase = require.cache[supabasePath];
  delete require.cache[registerPath];
  require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true,
    exports: { createClient: function () { return mock.client; } }
  };
  const handler = require('../api/register-user');
  delete require.cache[registerPath];
  if (prevSupabase) require.cache[supabasePath] = prevSupabase; else delete require.cache[supabasePath];
  return handler;
}

function withEnv(fn) {
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const prevCode = process.env.TELEGRAM_VERIFY_CODE_SECRET;
  process.env.SUPABASE_URL = 'https://example.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  process.env.TELEGRAM_VERIFY_CODE_SECRET = 'register-test-code-secret';
  return Promise.resolve(fn()).finally(function () {
    if (prevUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
    if (prevCode === undefined) delete process.env.TELEGRAM_VERIFY_CODE_SECRET; else process.env.TELEGRAM_VERIFY_CODE_SECRET = prevCode;
  });
}

const VALID_HASH = 'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4';

test('F-087 API: USERNAME_RE accepts normal usernames', function () {
  ['ab', 'alice', 'user.name', 'user_name', 'user-name', 'A1B2C3', 'a'.repeat(30)].forEach(function (u) {
    assert.ok(USERNAME_RE.test(u), `expected "${u}" to be accepted`);
  });
});

test('F-087 API: USERNAME_RE rejects HTML/script and other forbidden characters', function () {
  [
    '<img src=x onerror=alert(1)>',
    '<script>alert(1)</script>',
    'a<b',
    'a>b',
    'a"b',
    "a'b",
    'a&b',
    'a b',
    'a/b',
    'a\\b',
    'a;b',
    'a(b)',
    'a\u0000b',
    'a'.repeat(31),
    'a'
  ].forEach(function (u) {
    assert.ok(!USERNAME_RE.test(u), `expected "${u}" to be rejected`);
  });
});

test('F-087 API: registration with an HTML/script username is rejected with a validation error', async function () {
  await withEnv(async function () {
    const mock = makeSupabaseMock();
    const handler = loadHandlerWithMock(mock);
    const res = makeRes();
    await handler({ method: 'POST', body: { username: XSS_USERNAME, passwordHash: VALID_HASH, deviceId: 'dev-1', userAgent: 'ua', ...TERMS_FIELDS } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    assert.ok(/Username hanya boleh/.test(res.body.error), 'must return the charset validation error');
    assert.equal(mock.captured.rpcName, null, 'no account may be created for a hostile username');
  });
});

test('F-087 API: registration with a valid username still succeeds', async function () {
  await withEnv(async function () {
    const mock = makeSupabaseMock();
    const handler = loadHandlerWithMock(mock);
    const res = makeRes();
    await handler({ method: 'POST', body: { username: 'alice', passwordHash: VALID_HASH, deviceId: 'dev-1', userAgent: 'ua', ...TERMS_FIELDS } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(mock.captured.rpcName, 'register_pending_user_with_telegram_challenge');
  });
});
