'use strict';

// Focused tests for the Portfolio pricing/isolation/refresh fixes and the
// account/device/security audit. Presentation + audit only: no schema, no new
// dependencies, no production calls. Backend handlers are exercised with a stubbed
// @supabase/supabase-js (via Module._load) because node_modules is not installed
// in this sandbox — the same reason the pre-existing api/* tests fail at baseline.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'public', 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

// ---- helpers ----
function extractFunction(signature) {
  const start = html.indexOf(signature);
  assert.ok(start >= 0, 'function must exist: ' + signature);
  const i = html.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}') { depth--; if (depth === 0) return html.slice(start, j + 1); }
  }
  throw new Error('unbalanced braces for ' + signature);
}

function loadPortfolioHelpers() {
  const src = [
    extractFunction('function normalizePortfolioTicker('),
    extractFunction('function acceptQuotePrice('),
    extractFunction('function computePositionPL('),
    extractFunction('function computePortfolioTotals('),
    extractFunction('function sanitizePositionInput(')
  ].join('\n');
  const sandbox = { Math, Number, String, Array, isFinite, Object };
  vm.createContext(sandbox);
  vm.runInContext(src +
    '\nthis.normalizePortfolioTicker=normalizePortfolioTicker;this.acceptQuotePrice=acceptQuotePrice;' +
    'this.computePositionPL=computePositionPL;this.computePortfolioTotals=computePortfolioTotals;' +
    'this.sanitizePositionInput=sanitizePositionInput;', sandbox);
  return sandbox;
}
const P = loadPortfolioHelpers();

// Require an api/* handler with @supabase/supabase-js stubbed out.
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
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; } };
}

function withEnv(fn) {
  const prevUrl = process.env.SUPABASE_URL, prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const prevCodeSecret = process.env.TELEGRAM_VERIFY_CODE_SECRET;
  process.env.SUPABASE_URL = 'https://example.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key-DO-NOT-LEAK';
  // v2 registration issues a one-time Telegram code keyed by this secret.
  process.env.TELEGRAM_VERIFY_CODE_SECRET = 'portfolio-test-verify-secret';
  return Promise.resolve(fn()).finally(function () {
    if (prevUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
    if (prevCodeSecret === undefined) delete process.env.TELEGRAM_VERIFY_CODE_SECRET; else process.env.TELEGRAM_VERIFY_CODE_SECRET = prevCodeSecret;
  });
}

// Chainable supabase mock returning a fixed user for maybeSingle().
function supabaseWithUser(user, capture) {
  return function () {
    return {
      from() {
        const q = {
          select() { return q; }, eq() { return q; }, order() { return q; },
          limit() { return Promise.resolve({ data: [], error: null }); },
          maybeSingle() { return Promise.resolve({ data: user || null, error: null }); },
          update(payload) { if (capture) capture.updated = payload; return q; },
          insert(payload) { if (capture) capture.inserted = payload; return { select() { return Promise.resolve({ data: [{ id: 'u1', username: payload && payload.username }], error: null }); } }; }
        };
        return q;
      },
      // v2 endpoints call service-role RPCs; capture args for assertions.
      rpc(name, args) {
        if (capture) { capture.rpc = capture.rpc || []; capture.rpc.push({ name: name, args: args }); }
        if (name === 'register_pending_user_with_telegram_challenge') {
          return Promise.resolve({ data: [{ id: 'u1', username: args && args.p_username, created_at: new Date().toISOString(), challenge_id: 'ch1' }], error: null });
        }
        if (name === 'issue_telegram_challenge') {
          return Promise.resolve({ data: [{ challenge_id: 'ch1', expires_at: new Date().toISOString() }], error: null });
        }
        return Promise.resolve({ data: null, error: null });
      }
    };
  };
}

// ============================================================
// PART A — PORTFOLIO PRICING / CALCULATION
// ============================================================

// 1. BBCA ticker normalization
test('normalizePortfolioTicker normalizes IDX tickers and rejects junk', () => {
  assert.equal(P.normalizePortfolioTicker('bbca'), 'BBCA');
  assert.equal(P.normalizePortfolioTicker('BBCA.JK'), 'BBCA');
  assert.equal(P.normalizePortfolioTicker(' bbca.jk '), 'BBCA');
  assert.equal(P.normalizePortfolioTicker('tlkm'), 'TLKM');
  assert.equal(P.normalizePortfolioTicker('TOOLONG'), null);
  assert.equal(P.normalizePortfolioTicker('12'), null);
  assert.equal(P.normalizePortfolioTicker(''), null);
  assert.equal(P.normalizePortfolioTicker('<img src=x>'), null);
});

// 2. Valid previous-close fallback when live/screener price is unavailable (ROOT CAUSE)
test('acceptQuotePrice uses the valid T-1 close even when price_stale is true', () => {
  const stale = P.acceptQuotePrice({ success: true, last: 9500, price_stale: true, latestBarDate: '2026-07-17' });
  assert.ok(stale, 'stale-but-valid close must be accepted, not discarded');
  assert.equal(stale.price, 9500);
  assert.equal(stale.stale, true);
  assert.equal(stale.source, 'Close T-1');
  assert.equal(stale.date, '2026-07-17');

  const fresh = P.acceptQuotePrice({ success: true, last: 9500, price_stale: false, price_source: 'screener', price_date: '2026-07-18' });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.source, 'screener');

  // Genuine failures still return null (never fabricates a price)
  assert.equal(P.acceptQuotePrice({ success: false }), null);
  assert.equal(P.acceptQuotePrice({ success: true, last: 0 }), null);
  assert.equal(P.acceptQuotePrice({ success: true, last: null }), null);
  assert.equal(P.acceptQuotePrice(null), null);
});

// 4. Correct lot-to-share calculation & 5. modal/value/PL/PL%
test('computePositionPL uses shares = lot x 100 and correct P/L', () => {
  const m = P.computePositionPL(100, 4900, 5000);
  assert.equal(m.shares, 10000);
  assert.equal(m.cost, 49000000);
  assert.equal(m.marketValue, 50000000);
  assert.equal(m.plRp, 1000000);
  assert.ok(Math.abs(m.plPct - 2.040816) < 0.001);
  assert.equal(m.priced, true);
});

// The exact user-reported case: BBCA 100 lot @ 4900 -> Total Modal 49,000,000
test('user-reported BBCA position: modal is 49,000,000 and prices once a T-1 close is present', () => {
  const totals0 = P.computePortfolioTotals([{ ticker: 'BBCA', lot: 100, avgBuy: 4900 }]);
  assert.equal(totals0.totalModal, 49000000);
  assert.equal(totals0.priced, 0); // no price yet -> Nilai/PL '—'
  const accepted = P.acceptQuotePrice({ success: true, last: 10000, price_stale: true, latestBarDate: '2026-07-17' });
  const totals1 = P.computePortfolioTotals([{ ticker: 'BBCA', lot: 100, avgBuy: 4900, _lastPrice: accepted.price }]);
  assert.equal(totals1.priced, 1);
  assert.equal(totals1.totalValue, 100000000);
  assert.equal(totals1.plRp, 51000000);
});

// 3. Missing price for one ticker does not break other positions
test('per-ticker isolation: a priced position still contributes when another is unpriced', () => {
  const totals = P.computePortfolioTotals([
    { ticker: 'BBCA', lot: 100, avgBuy: 4900, _lastPrice: 5000 },
    { ticker: 'GOTO', lot: 50, avgBuy: 80 } // unpriced
  ]);
  assert.equal(totals.total, 2);
  assert.equal(totals.priced, 1);
  assert.equal(totals.unpriced, 1);
  assert.equal(totals.totalValue, 50000000); // only BBCA's market value
  assert.equal(totals.plRp, 1000000);        // measured vs priced modal only
  assert.ok(totals.totalModal > 49000000);   // full modal includes both positions
});

// 6. Partial unavailable-price warning is dynamic (count of unpriced)
test('renderPortfolioView emits a dynamic partial-failure warning with counts', () => {
  const src = extractFunction('function renderPortfolioView(');
  assert.match(src, /totals\.unpriced > 0/);
  assert.match(src, /dari '\s*\+\s*totals\.total\s*\+\s*' posisi belum bisa dihargai/);
  assert.match(src, /warningEl\.classList\.remove\('hidden'\)/);
});

// 7. Refresh loading + duplicate-click guard + recovery
test('refreshPortfolioPrices guards concurrent runs, shows loading, and restores in finally', () => {
  const src = extractFunction('async function refreshPortfolioPrices(');
  assert.match(src, /if \(_portRefreshInFlight\) return;/);
  assert.match(src, /_portRefreshInFlight = true;/);
  assert.match(src, /btn\.innerHTML = '<span class="spinner-sm"><\/span>Memuat\.\.\.';/);
  assert.match(src, /finally \{/);
  assert.match(src, /_portRefreshInFlight = false;/);
  // per-ticker isolation in the network layer
  assert.match(src, /failed\.push\(ticker\)/);
  assert.match(src, /acceptQuotePrice\(data\)/);
  // saved lot/avgBuy untouched — only price fields updated
  assert.match(src, /_lastPrice = pm\.price/);
  assert.doesNotMatch(src, /\.lot\s*=/);
  assert.doesNotMatch(src, /\.avgBuy\s*=/);
});

// 8/9. Persistence: positions survive re-render and logout (localStorage not wiped)
test('positions persist across render and logout does not delete the portfolio', () => {
  const key = extractFunction('function getPortfolioKey(');
  assert.match(key, /autocuan_portfolio_/);
  assert.match(key, /userId \|\| user/); // keyed by immutable user id, falls back to username
  const save = extractFunction('function savePortfolio(');
  assert.match(save, /localStorage\.setItem\(key/);
  const logoutSrc = extractFunction('function logout(');
  assert.doesNotMatch(logoutSrc, /autocuan_portfolio/); // logout must NOT remove portfolio keys
  // rendered view reads persisted _lastPrice
  const view = extractFunction('function renderPortfolioView(');
  assert.match(view, /pos\._lastPrice/);
});

// 10/11. User isolation: portfolio key is per-user; delete operates on that user's list
test('portfolio storage is per-user and delete stays within the current user list', () => {
  const del = extractFunction('function deletePosition(');
  assert.match(del, /loadPortfolio\(\)/);
  assert.match(del, /splice\(index, 1\)/);
  const load = extractFunction('function loadPortfolio(');
  assert.match(load, /getPortfolioKey\(\)/);
});

// 12. No server-side portfolio endpoint exists -> no server IDOR/forged-userId surface
test('there is no server portfolio endpoint (client-only), so no server-side userId can be forged', () => {
  const apiFiles = fs.readdirSync(path.join(ROOT, 'api')).filter(f => f.endsWith('.js'));
  assert.ok(!apiFiles.some(f => /portfolio|portofolio|position/i.test(f)), 'no portfolio API endpoint should exist');
  // getAuthHeaders userId is a client-local value, only used as a header hint
  const gah = extractFunction('function getAuthHeaders(');
  assert.match(gah, /autocuan_user_id/);
});

// 22/23/24. Input validation: XSS, NaN/Infinity/negative/zero, oversized
test('sanitizePositionInput rejects unsafe, invalid, and oversized inputs', () => {
  assert.equal(P.sanitizePositionInput('<script>', '1', '1').ok, false);
  assert.equal(P.sanitizePositionInput('BBCA', '0', '5000').ok, false);
  assert.equal(P.sanitizePositionInput('BBCA', '-5', '5000').ok, false);
  assert.equal(P.sanitizePositionInput('BBCA', 'NaN', '5000').ok, false);
  assert.equal(P.sanitizePositionInput('BBCA', 'Infinity', '5000').ok, false);
  assert.equal(P.sanitizePositionInput('BBCA', '1.5', '5000').ok, false); // non-integer lot
  assert.equal(P.sanitizePositionInput('BBCA', '100', '0').ok, false);
  assert.equal(P.sanitizePositionInput('BBCA', '100', '-1').ok, false);
  assert.equal(P.sanitizePositionInput('BBCA', '999999999', '5000').ok, false); // oversized lot
  assert.equal(P.sanitizePositionInput('BBCA', '100', '9999999999').ok, false); // oversized avg
  const ok = P.sanitizePositionInput('bbca', '100', '4900');
  assert.equal(ok.ok, true);
  assert.equal(ok.ticker, 'BBCA');
  assert.equal(ok.lot, 100);
  assert.equal(ok.avgBuy, 4900);
});

test('computePositionPL treats NaN/Infinity/negative price as unpriced (never throws)', () => {
  assert.equal(P.computePositionPL(100, 4900, Infinity).priced, false);
  assert.equal(P.computePositionPL(100, 4900, NaN).priced, false);
  assert.equal(P.computePositionPL(100, 4900, -5).priced, false);
  assert.equal(P.computePositionPL(0, 4900, 5000).valid, false);
  assert.equal(P.computePositionPL(100, 0, 5000).valid, false);
});

// 22 (cont). Reflected/stored XSS rendered safely
test('renderPortfolioView escapes ticker in both table and mobile cards', () => {
  const view = extractFunction('function renderPortfolioView(');
  assert.match(view, /escapeHtml\(String\(pos\.ticker\)\)/);
  assert.doesNotMatch(view, /'>' \+ pos\.ticker \+ '/); // no raw ticker interpolation
  const cell = extractFunction('function portfolioPriceCellHtml(');
  assert.match(cell, /escapeHtml\(String\(pos\._priceSource\)\)/);
});

// ============================================================
// PART B — ACCOUNT / DEVICE / AUTH SECURITY
// ============================================================

// 13. Registration includes a valid device id (server backfills a fallback)
test('register-user normalizes/ backfills device id (never null)', () => {
  const reg = requireApiWithSupabaseStub('../api/register-user');
  const norm = reg.__test.normalizeDeviceId;
  assert.equal(norm('dev_abc'), 'dev_abc');
  assert.ok(norm('').indexOf('srv_') === 0);
  assert.ok(norm(null).indexOf('srv_') === 0);
});

// 14 + 16 + 20 + 21. Login validates account+password; device id alone cannot auth.
test('login-user requires the correct password; device id alone cannot authenticate', async () => {
  await withEnv(async function () {
    const user = { id: 'u1', username: 'alice', password_hash: 'goodhash', devices: ['dev_known'], is_blocked: false, is_approved: true };
    // Correct password + known device -> success, and NO password in response
    let handler = requireApiWithSupabaseStub('../api/login-user', supabaseWithUser(user));
    let res = makeRes();
    await handler({ method: 'POST', body: { username: 'alice', passwordHash: 'goodhash', deviceId: 'dev_known' } }, res);
    assert.equal(res.body.success, true);
    assert.ok(!('password_hash' in res.body) && !('password' in res.body), 'response must not include password');

    // Known device but WRONG password -> rejected (device id is not a credential)
    handler = requireApiWithSupabaseStub('../api/login-user', supabaseWithUser(user));
    res = makeRes();
    await handler({ method: 'POST', body: { username: 'alice', passwordHash: 'WRONG', deviceId: 'dev_known' } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    assert.doesNotMatch(res.body.error || '', /goodhash/); // never leak the stored hash
  });
});

// 26. User/auth endpoints reject missing credentials
test('login/register/reset reject missing credentials with 400', async () => {
  await withEnv(async function () {
    const login = requireApiWithSupabaseStub('../api/login-user', supabaseWithUser(null));
    let res = makeRes();
    await login({ method: 'POST', body: { username: 'a' } }, res);
    assert.equal(res.statusCode, 400);

    const reg = requireApiWithSupabaseStub('../api/register-user', supabaseWithUser(null));
    res = makeRes();
    await reg({ method: 'POST', body: { username: 'a' } }, res);
    assert.equal(res.statusCode, 400);

    const reset = requireApiWithSupabaseStub('../api/reset-password', supabaseWithUser(null));
    res = makeRes();
    await reset({ method: 'POST', body: { username: 'a' } }, res);
    assert.equal(res.statusCode, 400);
  });
});

// 25. Admin endpoints reject non-admin callers
// NOTE: Admin authorization is now enforced by a server-signed session cookie
// (see lib/admin-session.js and test/admin-session-auth.test.js). A client-supplied
// `adminName` is ignored, so callers without a valid admin session are rejected with
// 401 (unauthenticated) rather than 403. This test confirms the body `adminName`
// alone can never reach an admin operation.
test('admin endpoints reject callers that only supply adminName (no signed session)', async () => {
  await withEnv(async function () {
    const adminUsers = requireApiWithSupabaseStub('../api/admin-users', supabaseWithUser(null));
    let res = makeRes();
    await adminUsers({ method: 'POST', body: { adminName: 'budi', action: 'list' } }, res);
    assert.equal(res.statusCode, 401);
    assert.notEqual(res.statusCode, 200);

    res = makeRes();
    await adminUsers({ method: 'POST', body: { action: 'list' } }, res); // missing adminName
    assert.equal(res.statusCode, 401);

    const maint = requireApiWithSupabaseStub('../api/maintenance-settings', supabaseWithUser(null));
    res = makeRes();
    await maint({ method: 'POST', body: { adminName: 'budi', action: 'save', config: {} } }, res);
    assert.equal(res.statusCode, 401);
  });
});

// 15. Password never present in client storage (only hash sent transiently)
test('client never stores the raw password or the password hash in localStorage', () => {
  const doLogin = extractFunction('async function doLogin(');
  const doRegister = extractFunction('async function doRegister(');
  [doLogin, doRegister].forEach(function (src) {
    assert.doesNotMatch(src, /localStorage\.setItem\([^)]*password/i);
    assert.doesNotMatch(src, /localStorage\.setItem\([^)]*passwordHash/);
  });
  // hashing is client-side SHA-256 (project's existing mechanism), plaintext never stored
  const hash = extractFunction('async function hashPassword(');
  assert.match(hash, /SHA-256/);
});

// 17. Logs redact passwords/tokens (never inserted)
test('log endpoint never persists password or token fields', async () => {
  await withEnv(async function () {
    const capture = {};
    const logh = requireApiWithSupabaseStub('../api/log', supabaseWithUser(null, capture));
    // Re-wire capture into insert: rebuild mock that records insert payload
    const handler = requireApiWithSupabaseStub('../api/log', function () {
      return { from() { return { insert(row) { capture.inserted = row; return { select() { return Promise.resolve({ data: [row], error: null }); } }; } }; } };
    });
    const res = makeRes();
    await handler({ method: 'POST', body: { action: 'login', username: 'alice', password: 'sneaky', token: 'sneaky', userAgent: 'ua' } }, res);
    assert.ok(capture.inserted, 'insert should be called');
    assert.ok(!('password' in capture.inserted), 'password must never be logged');
    assert.ok(!('token' in capture.inserted), 'token must never be logged');
  });
});

// 28. Error responses do not leak secrets or stack traces
test('handler exceptions do not leak the service key or a stack trace', async () => {
  await withEnv(async function () {
    const handler = requireApiWithSupabaseStub('../api/login-user', function () { throw new Error('boom-internal'); });
    const res = makeRes();
    await handler({ method: 'POST', body: { username: 'alice', passwordHash: 'h', deviceId: 'd' } }, res);
    assert.equal(res.statusCode, 500);
    const msg = String(res.body.error || '');
    assert.doesNotMatch(msg, /test-service-key-DO-NOT-LEAK/);
    assert.doesNotMatch(msg, /SUPABASE_SERVICE_ROLE_KEY/);
    assert.doesNotMatch(msg, /\n\s+at\s/); // no JS stack trace
  });
});

// 27. CORS is not wildcard-open for credentialed endpoints
test('no wildcard CORS is configured for the API', () => {
  const vercel = fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8');
  assert.doesNotMatch(vercel, /Access-Control-Allow-Origin["']?\s*[:=]\s*["']\*/);
  ['login-user', 'admin-users', 'quote', 'log'].forEach(function (name) {
    const src = fs.readFileSync(path.join(ROOT, 'api', name + '.js'), 'utf8');
    assert.doesNotMatch(src, /Access-Control-Allow-Origin[^\n]*\*/);
  });
});

// 19. Documented gap: no server-side rate limiting on auth endpoints (see report)
test('SECURITY GAP (documented): auth endpoints have no server-side rate limiting', () => {
  const login = fs.readFileSync(path.join(ROOT, 'api', 'login-user.js'), 'utf8');
  const register = fs.readFileSync(path.join(ROOT, 'api', 'register-user.js'), 'utf8');
  // Confirm the gap exists (no limiter present) — remediation requires shared infra.
  assert.doesNotMatch(login, /rateLimit|rate_limit|tooManyRequests|429/i);
  assert.doesNotMatch(register, /rateLimit|rate_limit|tooManyRequests|429/i);
});

// 30. API endpoint count remains exactly 12
test('api/ still exposes exactly 12 endpoint JS files', () => {
  const files = fs.readdirSync(path.join(ROOT, 'api')).filter(f => f.endsWith('.js'));
  assert.equal(files.length, 12, 'found: ' + files.join(', '));
});

// 29. Existing valid register behavior still works (v2: atomic RPC path via stub).
// The device id is normalized in Node and passed to the RPC, which stores it in
// the devices array (jsonb_build_array) inside the migration.
test('valid registration still succeeds and passes the normalized device id to the RPC', async () => {
  await withEnv(async function () {
    const capture = {};
    const handler = requireApiWithSupabaseStub('../api/register-user', supabaseWithUser(null, capture));
    const res = makeRes();
    await handler({ method: 'POST', body: { username: 'newuser', passwordHash: 'h', deviceId: 'dev_x', userAgent: 'ua' } }, res);
    assert.equal(res.body.success, true);
    const call = (capture.rpc || []).find(function (c) { return c.name === 'register_pending_user_with_telegram_challenge'; });
    assert.ok(call, 'registration uses the atomic RPC');
    assert.equal(call.args.p_device_id, 'dev_x');
    assert.ok(!('password' in res.body));
    assert.ok(!('telegram_channel_url' in res.body), 'no channel URL in v2 response');
  });
});
