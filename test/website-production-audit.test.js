'use strict';

// Regression matrix for the production website audit:
//  A. build validates and is idempotent
//  B. access decisions come only from the signed session + database status
//  C. routing stays clean (/dashboard direct, no loader, no redirect loop)
//  D. portfolio UI stays compact, single-scroll, single-send
//  E. admin deletion is guarded end to end (mocked; never touches real data)
//  F. sector hot list survives mapping failures and normalizes group codes

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function requireApiWithSupabaseStub(relPath, createClientImpl) {
  const origLoad = Module._load;
  const abs = require.resolve(relPath);
  delete require.cache[abs];
  Module._load = function (request) {
    if (request === '@supabase/supabase-js') return { createClient: createClientImpl };
    return origLoad.apply(this, arguments);
  };
  try { return require(relPath); }
  finally { Module._load = origLoad; delete require.cache[abs]; }
}

function makeRes() {
  return {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

const SECRET = 'website-audit-test-secret';

function signedCookie(overrides) {
  const admin = require('../lib/admin-session');
  const prior = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = SECRET;
  try {
    const token = admin.createSessionToken(Object.assign({
      userId: 'user-1', username: 'trader', isAdmin: false
    }, overrides || {}));
    return 'ac_sess=' + token;
  } finally {
    if (prior === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = prior;
  }
}

async function withEnv(fn) {
  const saved = {};
  const wanted = {
    SESSION_SECRET: SECRET,
    SUPABASE_URL: 'https://stub.supabase.local',
    SUPABASE_SERVICE_ROLE_KEY: 'stub-service-role'
  };
  Object.keys(wanted).forEach((key) => { saved[key] = process.env[key]; process.env[key] = wanted[key]; });
  try { return await fn(); }
  finally {
    Object.keys(saved).forEach((key) => {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    });
  }
}

// A chainable supabase stub. `tables` maps table name -> handler(op) where op
// records the chain; the handler returns { data, error } for the terminal call.
function chainableSupabase(resolvers, calls) {
  return function createClient() {
    return {
      from(table) {
        const op = { table, filters: [], deletes: false, selectArgs: null, orderArgs: null };
        const terminal = () => {
          if (calls) calls.push(op);
          const resolver = resolvers[table] || (() => ({ data: null, error: null }));
          return Promise.resolve(resolver(op));
        };
        const chain = {
          select(args) { op.selectArgs = args; return chain; },
          delete() { op.deletes = true; return chain; },
          update(values) { op.update = values; return chain; },
          eq(col, val) { op.filters.push([col, val]); return chain; },
          order(col, opts) { op.orderArgs = [col, opts]; return chain; },
          limit() { return terminal(); },
          maybeSingle() { return terminal(); },
          then(onOk, onErr) { return terminal().then(onOk, onErr); }
        };
        return chain;
      },
      rpc() { return Promise.resolve({ data: null, error: null }); }
    };
  };
}

// --- A. build -----------------------------------------------------------------

test('A: build validator passes twice and rewrites nothing', () => {
  const watched = [
    'public/index.html',
    'public/portfolio-planner.html',
    'public/website-approved-access.js',
    'public/ai-chat-renderer.js',
    'lib/context-ai-router-v4.js',
    'api/sector-hot.js'
  ];
  const hash = (file) => crypto.createHash('sha1').update(read(file)).digest('hex');
  const before = watched.map(hash);
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'apply-production-hotfixes.js')], { cwd: ROOT });
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'apply-production-hotfixes.js')], { cwd: ROOT });
  assert.deepEqual(watched.map(hash), before, 'build must not modify sources');
});

test('A: exactly 12 Vercel API functions', () => {
  const files = fs.readdirSync(path.join(ROOT, 'api')).filter((f) => f.endsWith('.js'));
  assert.equal(files.length, 12, 'found: ' + files.join(', '));
});

// --- B. access ------------------------------------------------------------------

test('B: portfolio_access approves only an approved, unblocked, signed account', async () => {
  await withEnv(async () => {
    const account = { id: 'user-1', username: 'trader', is_approved: true, is_blocked: false };
    const handler = requireApiWithSupabaseStub('../api/admin-users',
      chainableSupabase({ app_users: () => ({ data: account, error: null }) }));

    // approved
    let res = makeRes();
    await handler({ method: 'POST', headers: { host: 'x', cookie: signedCookie() }, body: { action: 'portfolio_access' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.user_id, 'user-1');

    // blocked
    account.is_blocked = true;
    res = makeRes();
    await handler({ method: 'POST', headers: { host: 'x', cookie: signedCookie() }, body: { action: 'portfolio_access' } }, res);
    assert.equal(res.statusCode, 403);

    // unapproved
    account.is_blocked = false;
    account.is_approved = false;
    res = makeRes();
    await handler({ method: 'POST', headers: { host: 'x', cookie: signedCookie() }, body: { action: 'portfolio_access' } }, res);
    assert.equal(res.statusCode, 403);
  });
});

test('B: localStorage-style headers alone never grant access', async () => {
  await withEnv(async () => {
    const handler = requireApiWithSupabaseStub('../api/admin-users',
      chainableSupabase({ app_users: () => ({ data: { id: 'user-1', username: 'trader', is_approved: true, is_blocked: false }, error: null }) }));
    const res = makeRes();
    await handler({
      method: 'POST',
      headers: { host: 'x', 'x-user-id': 'user-1', 'x-username': 'trader' },
      body: { action: 'portfolio_access' }
    }, res);
    assert.equal(res.statusCode, 401, 'no signed cookie means no access');
  });
});

test('B: a tampered session token is rejected', async () => {
  await withEnv(async () => {
    const handler = requireApiWithSupabaseStub('../api/admin-users',
      chainableSupabase({ app_users: () => ({ data: { id: 'user-1', username: 'trader', is_approved: true, is_blocked: false }, error: null }) }));
    const res = makeRes();
    const forged = signedCookie().replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
    await handler({ method: 'POST', headers: { host: 'x', cookie: forged }, body: { action: 'portfolio_access' } }, res);
    assert.equal(res.statusCode, 401);
  });
});

// --- C. routing --------------------------------------------------------------------

test('C: /dashboard rewrites straight to index.html with no loader hop', () => {
  const vercel = JSON.parse(read('vercel.json'));
  const dash = (vercel.rewrites || []).find((r) => r.source === '/dashboard');
  assert.ok(dash && dash.destination === '/index.html');
  assert.doesNotMatch(JSON.stringify(vercel), /dashboard-loader/);
  assert.doesNotMatch(read('public/index.html'), /dashboard-loader/);
});

test('C: portfolio back button returns to /dashboard and no subscription redirect exists', () => {
  assert.match(read('public/portfolio-planner.html'), /class="back" href="\/dashboard"/);
  const html = read('public/index.html');
  assert.doesNotMatch(html, /navigateTo\('subscription'\)/);
  assert.match(html, /function openSubscriptionPage\(\)\{if\(isAutocuanLoggedIn\(\)\)enterApp\(\{replaceHistory:true\}\);else showLandingPage\(\{replaceHistory:true\}\);\}/);
});

// --- D. portfolio UI ---------------------------------------------------------------

test('D: portfolio AI layout is vertical, compact, and single-scroll', () => {
  const page = read('public/portfolio-planner.html');
  assert.match(page, /\.ai-shell\{display:grid;grid-template-columns:1fr/);
  assert.match(page, /\.ai-shell aside\{order:2/);
  assert.doesNotMatch(page, /\.ai-messages\{[^}]*overflow\s*:\s*auto/);
  assert.doesNotMatch(page, /\.ai-messages\{[^}]*max-height/);
  assert.doesNotMatch(page, /\.ai-messages\{[^}]*height\s*:\s*\d+vh/);
  assert.match(page, /var ACCESS_TIMEOUT_MS=9000/);
  assert.match(page, /\$\('retryAccess'\)\.onclick=checkAccess/);
});

test('D: one click or Enter sends exactly one portfolio AI request', () => {
  const runtime = read('public/portfolio-ai-runtime-v2.js');
  assert.match(runtime, /if \(!text \|\| state\.sending\) return;/);
  assert.match(runtime, /event\.key === 'Enter' && !event\.shiftKey/);
  // Controls are re-cloned before binding so listeners can never stack.
  assert.match(runtime, /old\.parentNode\.replaceChild\(clone, old\)/);
  // Send is re-enabled on success, failure, and timeout alike. The unlock must
  // live in a finally block; asserting it was the block's FIRST statement pinned
  // an implementation detail, since the block also clears the abort timer now.
  const block = runtime.match(/finally \{[\s\S]*?\n {4}\}/);
  assert.ok(block, 'sendMessage() must release its lock from a finally block');
  assert.match(block[0], /setSending\(false\);/);
});

test('D: stored duplicate consecutive chat rows are cleaned on load', () => {
  const runtime = read('public/portfolio-ai-runtime-v2.js');
  assert.match(runtime, /previous\.role !== row\.role \|\| String\(previous\.content\)\.trim\(\) !== String\(row\.content\)\.trim\(\)/);
});

test('D: AI renderer observes added nodes only and preserves structured output', () => {
  const renderer = read('public/ai-chat-renderer.js');
  assert.doesNotMatch(renderer, /characterData\s*:\s*true/);
  assert.match(renderer, /mutation\.addedNodes/);
  assert.match(renderer, /el\.classList\.contains\('ai-rich-text'\) && !el\.hasAttribute\('data-ai-raw'\)/);
});

// --- E. admin deletion ---------------------------------------------------------------

test('E: delete_user requires an admin session', async () => {
  await withEnv(async () => {
    const handler = requireApiWithSupabaseStub('../api/admin-users',
      chainableSupabase({ app_users: () => ({ data: { id: 'u2', username: 'target' }, error: null }) }));
    const res = makeRes();
    await handler({ method: 'POST', headers: { host: 'x', cookie: signedCookie({ isAdmin: false }) }, body: { action: 'delete_user', username: 'target' } }, res);
    assert.equal(res.statusCode, 403);
  });
});

test('E: delete_user refuses system accounts budi and review', async () => {
  await withEnv(async () => {
    const handler = requireApiWithSupabaseStub('../api/admin-users', chainableSupabase({}));
    for (const name of ['budi', 'review', ' BUDI ']) {
      const res = makeRes();
      await handler({
        method: 'POST',
        headers: { host: 'x', cookie: signedCookie({ userId: 'admin-1', username: 'budi', isAdmin: true }) },
        body: { action: 'delete_user', username: name }
      }, res);
      assert.equal(res.statusCode, 400, name + ' must be protected');
      assert.equal(res.body.success, false);
    }
  });
});

test('E: successful delete removes device and verification records too', async () => {
  await withEnv(async () => {
    const calls = [];
    const handler = requireApiWithSupabaseStub('../api/admin-users', chainableSupabase({
      app_users: (op) => op.deletes
        ? ({ data: [{ id: 'u2', username: 'target' }], error: null })
        : ({ data: { id: 'u2', username: 'target' }, error: null })
    }, calls));
    const res = makeRes();
    await handler({
      method: 'POST',
      headers: { host: 'x', cookie: signedCookie({ userId: 'admin-1', username: 'budi', isAdmin: true }) },
      body: { action: 'delete_user', username: 'Target' }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    const deletedTables = calls.filter((c) => c.deletes).map((c) => c.table);
    assert.ok(deletedTables.includes('app_user_devices'), 'device rows removed');
    assert.ok(deletedTables.includes('app_user_telegram_verifications'), 'verification rows removed');
    assert.ok(deletedTables.includes('app_users'), 'account removed last');
    assert.equal(deletedTables[deletedTables.length - 1], 'app_users');
  });
});

test('E: related-record failure surfaces an error instead of pretending success', async () => {
  await withEnv(async () => {
    const handler = requireApiWithSupabaseStub('../api/admin-users', chainableSupabase({
      app_users: (op) => op.deletes
        ? ({ data: null, error: { message: 'foreign key violation' } })
        : ({ data: { id: 'u2', username: 'target' }, error: null })
    }));
    const res = makeRes();
    await handler({
      method: 'POST',
      headers: { host: 'x', cookie: signedCookie({ userId: 'admin-1', username: 'budi', isAdmin: true }) },
      body: { action: 'delete_user', username: 'target' }
    }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.success, false);
    assert.match(res.body.error, /data terkait/);
  });
});

test('E: delete UI demands the exact username and never decorates budi/review rows', () => {
  const ui = read('public/admin-user-delete-enhancement.js');
  assert.match(ui, /window\.prompt\(/);
  assert.match(ui, /String\(confirmation \|\| ''\)\.trim\(\)\.toLowerCase\(\) !== username/);
  assert.match(ui, /username === 'budi' \|\| username === 'review'/);
  // Failure re-enables the button so a retry stays possible.
  assert.match(ui, /button\.disabled = false;/);
  // The row disappears only after the server confirms success.
  assert.match(ui, /if \(!response\.ok \|\| data\.success !== true\)/);
});

// --- F. sector hot -------------------------------------------------------------------

function sectorHotListStub(overrides, calls) {
  const groups = overrides.groups;
  const members = overrides.members;
  return chainableSupabase({
    app_users: () => ({ data: { id: 'user-1', username: 'trader', is_approved: true, is_blocked: false }, error: null }),
    sector_hot_meta: () => ({ data: { calculated_at: '2026-07-25T09:00:00Z', status: 'done' }, error: null }),
    sector_hot_latest: () => ({ data: groups, error: null }),
    sector_hot_group_members: () => members
  }, calls);
}

async function runSectorHotList(stub) {
  const handler = requireApiWithSupabaseStub('../api/sector-hot', stub);
  const res = makeRes();
  await handler({ method: 'GET', query: {}, headers: { host: 'x', cookie: signedCookie() } }, res);
  return res;
}

test('F: cached groups are returned for an approved non-admin user', async () => {
  await withEnv(async () => {
    const res = await runSectorHotList(sectorHotListStub({
      groups: [{ group_code: 'KONGLO_A', group_name: 'Group A', avg_change_pct: 2 }],
      members: { data: [{ group_code: 'KONGLO_A' }], error: null }
    }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.groups.length, 1);
  });
});

test('F: group-code case/space mismatch cannot hide a cached group', async () => {
  await withEnv(async () => {
    const res = await runSectorHotList(sectorHotListStub({
      groups: [{ group_code: 'konglo_a ', group_name: 'Group A', avg_change_pct: 2 }],
      members: { data: [{ group_code: ' KONGLO_A' }], error: null }
    }));
    assert.equal(res.body.success, true);
    assert.equal(res.body.groups.length, 1, 'normalized codes must match');
  });
});

test('F: a mapping-query failure keeps the last valid cache visible', async () => {
  await withEnv(async () => {
    const res = await runSectorHotList(sectorHotListStub({
      groups: [{ group_code: 'KONGLO_A', group_name: 'Group A', avg_change_pct: 2 }],
      members: { data: null, error: { message: 'timeout' } }
    }));
    assert.equal(res.body.success, true);
    assert.equal(res.body.groups.length, 1, 'cache must not be erased by a transient failure');
  });
});

test('F: an empty cache still reports a clean empty state', async () => {
  await withEnv(async () => {
    const res = await runSectorHotList(sectorHotListStub({
      groups: [],
      members: { data: [], error: null }
    }));
    assert.equal(res.body.success, true);
    assert.deepEqual(res.body.groups, []);
  });
});
