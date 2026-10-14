'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const session = require('../lib/admin-session');
const quoteEndpoint = require('../api/quote');
const adminUsersHandler = require('../api/admin-users');

const SECRET = 'fase-5-server-gate-test-secret';

function withEnv(fn) {
  const prevSecret = process.env.SESSION_SECRET;
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SESSION_SECRET = SECRET;
  process.env.SUPABASE_URL = 'https://example.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prevSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = prevSecret;
      if (prevUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prevUrl;
      if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
    });
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(d) { this.body = d; return this; }
  };
}

function makeMockSupabase(account) {
  return {
    from(table) {
      if (table === 'app_users') {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle() { return Promise.resolve({ data: account || null, error: null }); },
          single() { return Promise.resolve({ data: account || null, error: null }); }
        };
      }
      if (table === 'user_entitlements') {
        return {
          select() { return this; },
          eq() {
            if (account && account.entitlementRows) {
              return Promise.resolve({ data: account.entitlementRows, error: null });
            }
            return Promise.resolve({ data: [], error: null });
          }
        };
      }
      if (table === 'stock_daily_features') {
        return {
          select() { return this; },
          order() { return this; },
          limit() {
            return Promise.resolve({
              data: [
                { ticker: 'BBCA', close: 10000, change_pct: 1.5, week52_high_dist_pct: -2.0, rsi_14: 55, volume_ratio_vs_7d_avg: 1.2, foreign_net_7d: 50000000000 }
              ],
              error: null
            });
          }
        };
      }
      if (table === 'stock_boards') {
        return {
          select() { return this; },
          limit() {
            return Promise.resolve({
              data: [
                { ticker: 'BBCA', company_name: 'Bank Central Asia', board: 'UTAMA', is_fca: false, is_active: true }
              ],
              error: null
            });
          }
        };
      }
      return {
        select() { return this; },
        eq() { return this; },
        limit() { return Promise.resolve({ data: [], error: null }); }
      };
    }
  };
}

test('Server-Side Gate: Ranking Harian (GET /api/quote?action=daily-market-context-list) rejects unauthenticated request (401)', () => withEnv(async () => {
  const req = {
    method: 'GET',
    headers: {},
    query: { action: 'daily-market-context-list' },
    __enforceAuth: true
  };
  const res = makeRes();
  const mockDb = makeMockSupabase(null);

  await quoteEndpoint.__test.handleDailyMarketContextListAction(req, res, mockDb);
  assert.equal(res.statusCode, 401, 'Unauthenticated request must receive HTTP 401');
  assert.equal(res.body.success, false);
  assert.match(res.body.error, /sesi|login|diperlukan/i);
}));

test('Server-Side Gate: Ranking Harian rejects free/unapproved user without PRO entitlement (402 or 403)', () => withEnv(async () => {
  const token = session.createSessionToken({ userId: 'user-free-1', username: 'freeuser', isAdmin: false });
  const req = {
    method: 'GET',
    headers: {
      cookie: session.SESSION_COOKIE_NAME + '=' + token
    },
    query: { action: 'daily-market-context-list' },
    __enforceAuth: true
  };
  const res = makeRes();
  const freeAccount = {
    id: 'user-free-1',
    username: 'freeuser',
    is_approved: true,
    is_blocked: false,
    subscription: null // No active paid subscription
  };
  const mockDb = makeMockSupabase(freeAccount);

  await quoteEndpoint.__test.handleDailyMarketContextListAction(req, res, mockDb);
  assert.ok(res.statusCode === 402 || res.statusCode === 403, 'Free account must receive 402 or 403: ' + res.statusCode);
  assert.equal(res.body.success, false);
}));

test('Server-Side Gate: Ranking Harian allows PRO user and returns 200 with data', () => withEnv(async () => {
  const proId = '11111111-1111-4111-8111-111111111111';
  const token = session.createSessionToken({ userId: proId, username: 'prouser', isAdmin: false });
  const req = {
    method: 'GET',
    headers: {
      cookie: session.SESSION_COOKIE_NAME + '=' + token
    },
    query: { action: 'daily-market-context-list' },
    __enforceAuth: true
  };
  const res = makeRes();
  const proAccount = {
    id: proId,
    username: 'prouser',
    is_approved: true,
    is_blocked: false,
    entitlementRows: [
      {
        plan_code: 'pro',
        source: 'stripe',
        status: 'active',
        starts_at: new Date(Date.now() - 3600000).toISOString(),
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        lifetime: false
      }
    ]
  };
  const mockDb = makeMockSupabase(proAccount);

  await quoteEndpoint.__test.handleDailyMarketContextListAction(req, res, mockDb);
  assert.equal(res.statusCode, 200, 'PRO account must receive HTTP 200');
  assert.equal(res.body.success, true);
  assert.ok(Array.isArray(res.body.data), 'Data should be an array');
  assert.equal(res.body.data[0].ticker, 'BBCA');
}));

test('Server-Side Gate: Pattern Radar (POST /api/admin-users action=pattern_map_access) rejects unauthenticated request', () => withEnv(async () => {
  const req = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://example.test',
      host: 'example.test'
    },
    body: { action: 'pattern_map_access' }
  };
  const res = makeRes();

  await adminUsersHandler(req, res);
  assert.ok(res.statusCode === 401 || res.statusCode === 403, 'Unauthenticated access must be rejected with 401/403: ' + res.statusCode);
  assert.equal(res.body.allowed, false);
}));

test('Server-Side Gate: Pattern Radar rejects non-admin user (403)', () => withEnv(async () => {
  const token = session.createSessionToken({ userId: 'user-pro-1', username: 'alice', isAdmin: false });
  const req = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: session.SESSION_COOKIE_NAME + '=' + token,
      origin: 'https://example.test',
      host: 'example.test'
    },
    body: { action: 'pattern_map_access' }
  };
  const res = makeRes();

  await adminUsersHandler(req, res);
  assert.equal(res.statusCode, 403, 'Non-admin user must receive HTTP 403');
  assert.equal(res.body.allowed, false);
}));

test('Server-Side Gate: Pattern Radar allows verified budi admin user (200)', () => withEnv(async () => {
  const token = session.createSessionToken({ userId: 'admin-budi-id', username: 'budi', isAdmin: true });
  const req = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: session.SESSION_COOKIE_NAME + '=' + token,
      origin: 'https://example.test',
      host: 'example.test'
    },
    body: { action: 'pattern_map_access' }
  };
  const res = makeRes();

  await adminUsersHandler(req, res);
  assert.equal(res.statusCode, 200, 'Budi admin user must receive HTTP 200');
  assert.equal(res.body.success, true);
  assert.equal(res.body.allowed, true);
  assert.equal(res.body.access, 'admin');
  assert.equal(res.body.username, 'budi');
}));
