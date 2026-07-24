'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const session = require('../lib/admin-session');
const auth = require('../lib/subscription-auth');

const ROOT = path.resolve(__dirname, '..');
const USER_ID = '00000000-0000-4000-8000-000000000002';
const BUDI_ID = '00000000-0000-4000-8000-000000000001';

function withSessionSecret(fn) {
  const prior = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'phase-6a4-test-secret';
  return Promise.resolve().then(fn).finally(() => {
    if (prior === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = prior;
  });
}

function signedRequest(username, options = {}) {
  const token = session.createSessionToken({
    userId: options.userId || (username === 'budi' ? BUDI_ID : USER_ID),
    username,
    isAdmin: options.isAdmin === true || username === 'budi'
  });
  return { headers: { cookie: `${session.SESSION_COOKIE_NAME}=${token}` } };
}

function account(username = 'ujibot0720', overrides = {}) {
  return Object.assign({
    id: username === 'budi' ? BUDI_ID : USER_ID,
    username,
    is_blocked: false,
    is_approved: true
  }, overrides);
}

function entitlement(overrides = {}) {
  const now = Date.now();
  return Object.assign({
    plan_code: 'PREMIUM_1_MONTH',
    source: 'payment',
    status: 'active',
    starts_at: new Date(now - 60_000).toISOString(),
    expires_at: new Date(now + 86_400_000).toISOString(),
    lifetime: false
  }, overrides);
}

function database(accountRow, rows = [], rowError = null) {
  return {
    from(table) {
      if (table === 'app_users') {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle() { return Promise.resolve({ data: accountRow, error: null }); }
        };
      }
      if (table === 'user_entitlements') {
        return {
          select() { return this; },
          eq() { return Promise.resolve({ data: rows, error: rowError }); }
        };
      }
      throw new Error(`unexpected table ${table}`);
    }
  };
}

function responseCapture() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; }
  };
}

async function withApiHandler(moduleName, db, fn) {
  const originalLoad = Module._load;
  const oldUrl = process.env.SUPABASE_URL;
  const oldKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '@supabase/supabase-js') return { createClient: () => db };
    return originalLoad.call(this, request, parent, isMain);
  };
  const modulePath = require.resolve(moduleName);
  delete require.cache[modulePath];
  try {
    const handler = require(moduleName);
    return await fn(handler);
  } finally {
    delete require.cache[modulePath];
    Module._load = originalLoad;
    if (oldUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = oldUrl;
    if (oldKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = oldKey;
  }
}

test('non-admin account with no active entitlement resolves to Free and is denied premium', async () => withSessionSecret(async () => {
  const db = database(account(), []);
  const access = await auth.resolvePremiumAccess(signedRequest('ujibot0720'), db);
  assert.equal(access.ok, true);
  assert.equal(access.premium, false);
  assert.equal(access.access_level, 'free');
  const denied = await auth.requirePremiumEntitlement(signedRequest('ujibot0720'), db);
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 403);
}));

test('expired, revoked, malformed, and unavailable entitlement storage fail closed', async () => withSessionSecret(async () => {
  const cases = [
    [entitlement({ expires_at: new Date(Date.now() - 1_000).toISOString() })],
    [entitlement({ status: 'revoked' })],
    [entitlement({ starts_at: 'not-a-date', expires_at: 'also-not-a-date' })]
  ];
  for (const rows of cases) {
    const access = await auth.resolvePremiumAccess(signedRequest('ujibot0720'), database(account(), rows));
    assert.equal(access.premium, false);
    assert.equal(access.access_level, 'free');
  }
  const unavailable = await auth.resolvePremiumAccess(
    signedRequest('ujibot0720'),
    database(account(), [], { message: 'storage unavailable' })
  );
  assert.equal(unavailable.premium, false);
  assert.equal(unavailable.access_level, 'free');
}));

test('active Trial, paid term, Lifetime, and protected budi receive premium access', async () => withSessionSecret(async () => {
  const activeCases = [
    entitlement({ plan_code: 'TRIAL', source: 'trial' }),
    entitlement({ plan_code: 'PREMIUM_2_MONTHS', source: 'payment' }),
    entitlement({ plan_code: 'LIFETIME', source: 'payment', lifetime: true, expires_at: null })
  ];
  for (const row of activeCases) {
    const allowed = await auth.requirePremiumEntitlement(
      signedRequest('ujibot0720'),
      database(account(), [row])
    );
    assert.equal(allowed.ok, true);
    assert.equal(allowed.premium, true);
  }

  const admin = await auth.requirePremiumEntitlement(
    signedRequest('budi'),
    database(account('budi'), [], { message: 'entitlement storage unavailable' })
  );
  assert.equal(admin.ok, true);
  assert.equal(admin.premium, true);
  assert.equal(admin.access_level, 'admin');
}));

test('an arbitrary signed admin claim cannot turn a non-budi account into admin', async () => withSessionSecret(async () => {
  const forgedRole = signedRequest('ujibot0720', { isAdmin: true });
  const access = await auth.resolvePremiumAccess(forgedRole, database(account(), []));
  assert.equal(access.ok, true);
  assert.equal(access.premium, false);
  assert.equal(access.access_level, 'free');
}));

test('premium browser API reads reject guest and Free sessions before returning payloads', async () => withSessionSecret(async () => {
  await withApiHandler('../api/sector-hot', database(account(), []), async handler => {
    const guestRes = responseCapture();
    await handler({ method: 'GET', query: { action: 'screener' }, headers: {} }, guestRes);
    assert.equal(guestRes.statusCode, 401);
    assert.equal(guestRes.body.success, false);
    assert.equal('results' in guestRes.body, false);
    assert.equal('groups' in guestRes.body, false);

    for (const action of [null, 'screener', 'nk-screener-results', 'daytrade-screener']) {
      const freeRes = responseCapture();
      const req = signedRequest('ujibot0720');
      req.method = 'GET';
      req.query = action === null ? {} : { action };
      await handler(req, freeRes);
      assert.equal(freeRes.statusCode, 403, String(action));
      assert.equal(freeRes.body.success, false, String(action));
      assert.equal('results' in freeRes.body, false, String(action));
      assert.equal('groups' in freeRes.body, false, String(action));
    }
  });
}));

test('premium status endpoint returns only signed server state and fails closed for guests', async () => withSessionSecret(async () => {
  await withApiHandler('../api/login-user', database(account(), []), async handler => {
    const guestRes = responseCapture();
    await handler({ method: 'POST', query: { action: 'premium-access-status' }, body: {}, headers: {} }, guestRes);
    assert.equal(guestRes.statusCode, 401);
    assert.equal(guestRes.body.success, false);

    const freeRes = responseCapture();
    const request = signedRequest('ujibot0720');
    request.method = 'POST';
    request.query = { action: 'premium-access-status' };
    request.body = {};
    await handler(request, freeRes);
    assert.equal(freeRes.statusCode, 200);
    assert.deepEqual(freeRes.body, {
      success: true,
      premium: false,
      access_level: 'free',
      entitlement_status: 'none',
      current_plan: null,
      expires_at: null
    });
    assert.equal(freeRes.headers['cache-control'], 'private, no-store');
  });
}));

test('debug diagnostics require the existing server secret and public shares retain their token path', () => {
  const source = fs.readFileSync(path.join(ROOT, 'api', 'sector-hot.js'), 'utf8');
  assert.match(source, /requirePremiumEntitlement/);
  assert.match(source, /action === null[\s\S]*action === 'screener'[\s\S]*action === 'nk-screener-results'[\s\S]*action === 'daytrade-screener'/);
  assert.match(source, /premiumBrowserRead && !verifyCronSecret\(req\)/);
  assert.match(source, /action === 'debug-members'[\s\S]{0,180}!verifyCronSecret\(req\)/);
  assert.match(source, /action === 'public-screener-share'/);
  assert.doesNotMatch(source, /x-premium|x-access-level|x-subscription-plan/i);
});

test('client hides premium navigation, cancels stale checks, and restores accessibility only after confirmation', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok((html.match(/data-premium-nav="true"/g) || []).length >= 9);
  assert.ok((html.match(/data-premium-page="true"/g) || []).length >= 3);
  assert.match(html, /premiumAccessGeneration/);
  assert.match(html, /premiumAccessController\.abort\(\)/);
  assert.match(html, /generation!==premiumAccessGeneration/);
  assert.match(html, /cache:'no-store'/);
  assert.match(html, /schedulePremiumAccessRefresh/);
  assert.match(html, /retainConfirmedAccess/);
  assert.match(html, /page\.removeAttribute\('aria-hidden'\)/);
  assert.match(html, /page\.inert=false/);
  assert.match(html, /clearRenderedPremiumData/);
  assert.match(html, /Fitur ini tersedia untuk pengguna Trial dan Premium/);
  assert.match(html, /function openSubscriptionPage\(\)\{setTopLevelView\('app'\)/);
  assert.doesNotMatch(html, /localStorage[^\n]{0,140}(premium|entitlement|access_level)/i);
});

test('premium status uses signed-session server state, disables caching, and API file count stays fixed', () => {
  const source = fs.readFileSync(path.join(ROOT, 'api', 'login-user.js'), 'utf8');
  assert.match(source, /subscriptionAction === 'premium-access-status'/);
  assert.match(source, /resolvePremiumAccess\(req, db\)/);
  assert.match(source, /Cache-Control', 'private, no-store'/);
  assert.equal(fs.readdirSync(path.join(ROOT, 'api')).filter(name => name.endsWith('.js')).length, 12);
});

test('visible subscription copy is Indonesian and keeps the 10-day/manual-transfer policy', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.match(html, /Kelola Langganan/);
  assert.match(html, /Day Trade Radar, Swing Screener, dan Sektor Hot/);
  assert.match(html, /Pembayaran melalui transfer bank akan tersedia/);
  assert.doesNotMatch(html, /Kelola Subscription/);
  assert.doesNotMatch(html, />Subscription Plans<|Subscription plan catalog|>Edit price</);
  assert.doesNotMatch(html, /Trial\s+17 Hari|17 hari · aktivasi mengikuti server/i);
});


test('unknown sector-hot actions cannot fall through to premium list or detail payloads', async () => withSessionSecret(async () => {
  await withApiHandler('../api/sector-hot', database(account(), []), async handler => {
    for (const query of [{ action: 'unknown-action' }, { action: 'unknown-action', group: 'TEST' }]) {
      const res = responseCapture();
      await handler({ method: 'GET', query, headers: {} }, res);
      assert.equal(res.statusCode, 400);
      assert.deepEqual(res.body, { success: false, error: 'Aksi tidak valid.' });
      assert.equal('groups' in res.body, false);
      assert.equal('members' in res.body, false);
      assert.equal('results' in res.body, false);
    }
  });
}));
