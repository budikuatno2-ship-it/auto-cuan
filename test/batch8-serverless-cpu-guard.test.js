'use strict';

// ===========================================================================
// BATCH 8 — SERVERLESS CPU GUARD + VPS RUNNER DECOUPLING
//
// Why this file exists
// --------------------
// Heavy screener actions ('daytrade-screener-run', 'nk-screener-run',
// 'refresh-screener', 'refresh') walk a 150-175 ticker universe over Yahoo and
// Supabase. On Vercel they cannot finish inside the invocation budget: the
// function is killed mid-scan and leaves partial rows in the screener tables.
//
// api/sector-hot.js now refuses them outright when process.env.VERCEL === '1',
// returning HTTP 403 with
//   { success: false, error: 'DEPRECATED_ON_SERVERLESS: Heavy screener
//     computation must be executed directly on the VPS daemon.' }
// and the orchestration runner no longer defaults to the deployed Vercel origin.
//
// Every test below is written to FAIL against the pre-fix code (the guard did
// not exist and tools/run-all-screeners-vps.js defaulted to
// https://auto-cuan.vercel.app) and to PASS after the fix.
//
// LOCAL / STATIC ONLY. No network: the Supabase client is stubbed and the
// handler returns before any fetch because the guard runs first.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const EXPECTED_ERROR = 'DEPRECATED_ON_SERVERLESS: Heavy screener computation must be executed directly on the VPS daemon.';

const HEAVY_ACTIONS = ['daytrade-screener-run', 'nk-screener-run', 'refresh-screener', 'refresh'];
const READ_ONLY_ACTIONS = ['daytrade-screener', 'screener', 'nk-screener-results', 'web-daily-picks'];

const VERCEL_ENV = { VERCEL: '1' };
const VPS_ENV = {};

// ---------------------------------------------------------------------------
// Handler harness
// ---------------------------------------------------------------------------

function stubSupabase() {
  const chain = {
    select: () => chain,
    eq: () => chain,
    neq: () => chain,
    or: () => chain,
    in: () => chain,
    lt: () => chain,
    gt: () => chain,
    gte: () => chain,
    lte: () => chain,
    order: () => chain,
    limit: () => chain,
    delete: () => chain,
    insert: () => chain,
    upsert: () => chain,
    update: () => chain,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    single: () => Promise.resolve({ data: null, error: null }),
    then: (resolve) => Promise.resolve({ data: [], error: null }).then(resolve)
  };
  return { from: () => chain };
}

function loadHandler() {
  const resolved = require.resolve('../api/sector-hot.js');
  delete require.cache[resolved];
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === '@supabase/supabase-js') return { createClient: () => stubSupabase() };
    return original.call(Module, request, parent, isMain);
  };
  try {
    return require(resolved);
  } finally {
    Module._load = original;
  }
}

function makeRes() {
  const res = {
    statusCode: 200,
    payload: null,
    headers: {},
    status(code) { res.statusCode = code; return res; },
    json(body) { res.payload = body; return res; },
    setHeader(key, value) { res.headers[String(key).toLowerCase()] = value; return res; },
    end() { return res; }
  };
  return res;
}

const ENV_KEYS = ['VERCEL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'CRON_SECRET', 'SESSION_SECRET'];

function withEnv(env, fn) {
  const saved = {};
  ENV_KEYS.forEach((k) => { saved[k] = process.env[k]; });
  delete process.env.VERCEL;
  // No database configuration: the handler returns before any Supabase call, so
  // the guard under test is always the first thing that can answer.
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.CRON_SECRET = 'stub-cron-secret';
  process.env.SESSION_SECRET = 'stub-session-secret';
  Object.keys(env).forEach((k) => { process.env[k] = env[k]; });
  return Promise.resolve(fn()).finally(() => {
    ENV_KEYS.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    });
  });
}

function callHandler(handler, action, query) {
  const res = makeRes();
  return handler({
    method: 'GET',
    query: Object.assign({ action }, query || {}),
    headers: { host: 'autocuan.web.id' },
    body: {}
  }, res).then(() => res);
}

function isServerlessRefusal(res) {
  return res.statusCode === 403 && !!res.payload && res.payload.error === EXPECTED_ERROR;
}

// ---------------------------------------------------------------------------
// 1. Pure guard predicate
// ---------------------------------------------------------------------------

test('1: guard exports the four heavy compute actions and the four read-only actions', () => {
  const handler = require('../api/sector-hot.js');
  assert.ok(handler.HEAVY_COMPUTE_ACTIONS instanceof Set, 'HEAVY_COMPUTE_ACTIONS must be a Set');
  assert.ok(handler.READ_ONLY_ACTIONS instanceof Set, 'READ_ONLY_ACTIONS must be a Set');
  HEAVY_ACTIONS.forEach((a) => assert.ok(handler.HEAVY_COMPUTE_ACTIONS.has(a), a + ' must be guarded'));
  READ_ONLY_ACTIONS.forEach((a) => assert.ok(handler.READ_ONLY_ACTIONS.has(a), a + ' must stay readable'));
  // A read-only action must never be swept into the heavy set.
  READ_ONLY_ACTIONS.forEach((a) => assert.equal(handler.HEAVY_COMPUTE_ACTIONS.has(a), false, a + ' must not be heavy'));
  assert.equal(handler.DEPRECATED_ON_SERVERLESS_ERROR, EXPECTED_ERROR);
});

test('2: on Vercel every heavy action is refused with the exact 403 payload', () => {
  const { evaluateServerlessGuard } = require('../api/sector-hot.js');
  HEAVY_ACTIONS.forEach((action) => {
    const verdict = evaluateServerlessGuard(action, VERCEL_ENV);
    assert.ok(verdict, action + ' must be refused on Vercel');
    assert.equal(verdict.status, 403, action + ' must answer 403');
    assert.deepEqual(verdict.body, { success: false, error: EXPECTED_ERROR });
  });
});

test('3: on Vercel every read-only action is allowed through', () => {
  const { evaluateServerlessGuard } = require('../api/sector-hot.js');
  READ_ONLY_ACTIONS.forEach((action) => {
    assert.equal(evaluateServerlessGuard(action, VERCEL_ENV), null, action + ' must keep serving on Vercel');
  });
});

test('4: off Vercel (local / VPS daemon) no heavy action is refused', () => {
  const { evaluateServerlessGuard } = require('../api/sector-hot.js');
  HEAVY_ACTIONS.forEach((action) => {
    assert.equal(evaluateServerlessGuard(action, VPS_ENV), null, action + ' must run on the VPS daemon');
    assert.equal(evaluateServerlessGuard(action, { VERCEL: '0' }), null, action + ' must run when VERCEL=0');
  });
});

test('5: unset / unknown / non-string actions never trip the guard', () => {
  const { evaluateServerlessGuard } = require('../api/sector-hot.js');
  assert.equal(evaluateServerlessGuard(null, VERCEL_ENV), null, 'a bare list read is not heavy compute');
  assert.equal(evaluateServerlessGuard(undefined, VERCEL_ENV), null);
  assert.equal(evaluateServerlessGuard('', VERCEL_ENV), null);
  assert.equal(evaluateServerlessGuard('telegram-daily-picks', VERCEL_ENV), null, 'cron delivery is not heavy compute');
  assert.equal(evaluateServerlessGuard('landing-snapshot', VERCEL_ENV), null);
});

test('6: isServerlessRuntime only accepts the literal Vercel marker', () => {
  const { isServerlessRuntime } = require('../api/sector-hot.js');
  assert.equal(isServerlessRuntime({ VERCEL: '1' }), true);
  assert.equal(isServerlessRuntime({}), false);
  assert.equal(isServerlessRuntime({ VERCEL: 'true' }), false, 'only the documented "1" marker counts');
  assert.equal(isServerlessRuntime({ VERCEL: 1 }), false);
  assert.equal(isServerlessRuntime({ VERCEL: '' }), false);
});

// ---------------------------------------------------------------------------
// 7-8. Handler-level enforcement (the guard runs before auth and before DB)
// ---------------------------------------------------------------------------

for (const action of HEAVY_ACTIONS) {
  test('7: handler returns 403 DEPRECATED_ON_SERVERLESS for action=' + action + ' on Vercel', () => withEnv(VERCEL_ENV, async () => {
    const res = await callHandler(loadHandler(), action, { force: '1', batch: '0', ai: '1' });
    assert.equal(res.statusCode, 403, action + ' must be refused with 403, got ' + res.statusCode);
    assert.deepEqual(res.payload, { success: false, error: EXPECTED_ERROR });
    assert.equal(res.headers['cache-control'], 'no-store', 'a refusal must never be cached');
  }));

  test('8: handler does not apply the Vercel guard to action=' + action + ' off Vercel', () => withEnv(VPS_ENV, async () => {
    const res = await callHandler(loadHandler(), action, { force: '1', batch: '0', ai: '1' });
    assert.equal(isServerlessRefusal(res), false,
      action + ' must not be refused as serverless-only off Vercel (got ' + res.statusCode + ')');
  }));
}

for (const action of READ_ONLY_ACTIONS) {
  test('9: read-only action=' + action + ' is never answered with the serverless refusal', () => withEnv(VERCEL_ENV, async () => {
    const res = await callHandler(loadHandler(), action);
    assert.equal(isServerlessRefusal(res), false,
      action + ' must keep serving on Vercel, got ' + res.statusCode + ' ' + JSON.stringify(res.payload));
  }));
}

test('10: the guard fires before the database check, so it holds even with a configured Supabase', () => withEnv({ VERCEL: '1', SUPABASE_URL: 'https://stub.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'stub-key' }, async () => {
  const res = await callHandler(loadHandler(), 'refresh-screener', { ai: '1' });
  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.error, EXPECTED_ERROR);
}));

// ---------------------------------------------------------------------------
// 11-13. VPS orchestration runner is decoupled from the deployed origin
// ---------------------------------------------------------------------------

const runner = require('../tools/run-all-screeners-vps');

test('11: runner defaults to the local VPS daemon, not the Vercel origin', () => {
  assert.equal(runner.DEFAULT_LOCAL_BASE_URL, 'http://127.0.0.1:3000');
  assert.equal(runner.resolveBaseUrl({}), 'http://127.0.0.1:3000');
  assert.equal(runner.resolveBaseUrl({ APP_BASE_URL: 'http://127.0.0.1:3001/' }), 'http://127.0.0.1:3001');
  assert.equal(runner.resolveBaseUrl({ VPS_LOCAL_BASE_URL: 'http://10.0.0.5:3000' }), 'http://10.0.0.5:3000');
  assert.equal(runner.resolveBaseUrl({ APP_BASE_URL: 'https://internal.example.id' }), 'https://internal.example.id');
});

test('12: runner detects a serverless host and refuses to execute against it', () => {
  assert.equal(runner.isServerlessHost('https://auto-cuan.vercel.app'), true);
  assert.equal(runner.isServerlessHost('https://auto-cuan-git-main.vercel.app'), true);
  assert.equal(runner.isServerlessHost('http://127.0.0.1:3000'), false);
  assert.equal(runner.isServerlessHost('https://autocuan.web.id'), false);
  assert.equal(runner.isServerlessHost('not-a-url'), false, 'an unparsable value must not crash the runner');

  assert.throws(
    () => runner.assertNotServerlessForExecute('https://auto-cuan.vercel.app', true),
    /Vercel host/,
    '--execute against a Vercel host must be refused'
  );
  // Dry-run stays usable for inspection, and the VPS/local origin is always fine.
  assert.equal(runner.assertNotServerlessForExecute('https://auto-cuan.vercel.app', false), true);
  assert.equal(runner.assertNotServerlessForExecute('http://127.0.0.1:3000', true), true);
});

test('13: main() refuses --execute against Vercel and defaults to the local daemon', async () => {
  await assert.rejects(
    () => runner.main(runner.parseArgs(['node', 'runner', '--execute']), {
      env: { CRON_SECRET: 'test', APP_BASE_URL: 'https://auto-cuan.vercel.app' },
      client: { call: async () => ({ meta: {} }) },
      log: () => {}
    }),
    /Vercel host/,
    'the orchestration run must never be pointed at a serverless origin'
  );

  const calls = [];
  const result = await runner.main(
    runner.parseArgs(['node', 'runner', '--dry-run', '--skip-progress']),
    {
      env: { CRON_SECRET: 'test' },
      client: {
        call: async (query) => {
          calls.push(query);
          if (query.action === 'telegram-daily-picks') return { ready: false };
          return { meta: {} };
        }
      },
      log: () => {}
    }
  );
  assert.equal(result.base_url, runner.DEFAULT_LOCAL_BASE_URL,
    'without APP_BASE_URL the runner must target the local VPS daemon');
  assert.equal(calls.some((q) => HEAVY_ACTIONS.includes(q.action)), false,
    'a dry-run must never call a heavy action');
});

// ---------------------------------------------------------------------------
// 14. PowerShell runner carries the same safeguard
// ---------------------------------------------------------------------------

test('14: local_scan_runner.ps1 warns on a Vercel base URL and guards every heavy scan entry point', () => {
  const ps1 = fs.readFileSync(path.join(ROOT, 'tools', 'local_scan_runner.ps1'), 'utf8');

  assert.match(ps1, /function Test-IsVercelBaseUrl/, 'the Vercel URL predicate must exist');
  assert.match(ps1, /function Assert-NotVercelForHeavyScan/, 'the safeguard helper must exist');
  assert.match(ps1, /DEPRECATED_ON_SERVERLESS/, 'the warning must name the API refusal code');

  // Every heavy scan executor must call the safeguard before hitting the API.
  const guardedCallSites = ps1.match(/Assert-NotVercelForHeavyScan \$cfg/g) || [];
  assert.ok(guardedCallSites.length >= 5,
    'expected the safeguard in Run-Konglo, Run-NonKonglo, Run-DayTrade, Run-SektorHot and the auto loop, found ' + guardedCallSites.length);

  ['Run-Konglo', 'Run-NonKonglo', 'Run-DayTrade', 'Run-SektorHot', 'Run-DayTradeAutoLoop'].forEach((fn) => {
    const start = ps1.indexOf('function ' + fn);
    assert.ok(start > 0, fn + ' must exist');
    const body = ps1.slice(start, ps1.indexOf('\nfunction ', start + 1) === -1 ? undefined : ps1.indexOf('\nfunction ', start + 1));
    assert.match(body, /Assert-NotVercelForHeavyScan \$cfg/, fn + ' must refuse a Vercel base URL');
  });

  // The heavy action list must match the API-side guard.
  HEAVY_ACTIONS.forEach((action) => {
    assert.ok(ps1.includes('"' + action + '"'), 'the PowerShell safeguard must cover ' + action);
  });
});
