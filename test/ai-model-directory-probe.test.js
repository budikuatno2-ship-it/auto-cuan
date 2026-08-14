'use strict';

// E1 — WeizeRouter model-directory observability.
//
// Production showed nine vendor-diverse wz/* routes all answering HTTP 400
// wz_model_temporarily_unavailable. The gateway's own catalog is the evidence
// that would tell a provider-wide outage apart from model ids the provider no
// longer serves, but lib/context-ai-router-v4.js collapsed that catalog into
// `Set | null` and silently discarded an empty intersection:
//
//   if (filtered.length) models = filtered;   // filtered.length === 0 → evidence lost
//
// These tests lock down the five directory states, the safety of the diagnostic
// line, and — critically — that OBSERVING the catalog did not change which
// models get called in any of those states.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// Distinctive sentinels: if any of these ever reach a log line, the secrecy
// assertions below fail loudly instead of silently passing on a generic string.
const API_KEY = 'wz-SECRET-KEY-MUST-NEVER-BE-LOGGED-0123456789';
const SERVICE_ROLE = 'SUPABASE-SERVICE-ROLE-MUST-NEVER-BE-LOGGED';
const QUESTION = 'Berapa risiko gabungan portofolio rahasia saya?';
const SECRET_TICKER = 'BBCA';

const supabasePath = require.resolve('@supabase/supabase-js');
const account = { id: 'u-directory', username: 'budi', is_approved: true, is_blocked: false };
function stubQuery(table) {
  const q = {
    select() { return q; },
    eq() { return q; },
    order() { return q; },
    limit() { return q; },
    async maybeSingle() {
      if (table === 'app_users') return { data: account, error: null };
      return { data: null, error: null };
    },
    async upsert() { return { error: null }; }
  };
  return q;
}
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  paths: [],
  exports: { createClient() { return { from: stubQuery }; } }
};

process.env.SESSION_SECRET = 'ai-model-directory-test-secret';
process.env.SUPABASE_URL = 'https://stub.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE;
process.env.PORTFOLIO_AI_API_KEY = API_KEY;
process.env.PORTFOLIO_AI_BASE_URL = 'https://weizerouter.web.id/v1';
process.env.PORTFOLIO_AI_MODEL_TIMEOUT_MS = '1000';
process.env.PORTFOLIO_AI_TOTAL_TIMEOUT_MS = '10000';
process.env.PORTFOLIO_AI_OUTAGE_MODEL_TIMEOUT_MS = '1500';
process.env.PORTFOLIO_AI_OUTAGE_TOTAL_TIMEOUT_MS = '5000';
process.env.PORTFOLIO_AI_OUTAGE_SPILLOVER_ATTEMPTS = '6';
delete process.env.PORTFOLIO_AI_MAX_ATTEMPTS;

const { createSessionToken } = require(path.join(ROOT, 'lib/admin-session.js'));
const routerV4 = require(path.join(ROOT, 'lib/context-ai-router-v4.js'));
const routerV5 = require(path.join(ROOT, 'lib/context-ai-router-v5.js'));
const handler = require(path.join(ROOT, 'api/analyze.js'));

const SESSION = createSessionToken({ userId: account.id, username: account.username, isAdmin: false });
const STATES = routerV4._test.DIRECTORY_STATE;

const provider = {
  calls: [],
  chat: null,
  models: null // () => response | throws
};

function makeTextResponse(status, text) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return text; },
    clone() { return { async text() { return text; } }; }
  };
}

globalThis.fetch = async function (url, options) {
  const target = String(url);
  if (target.endsWith('/models')) return provider.models();
  const body = JSON.parse(options.body);
  const outcome = await provider.chat(body.model, provider.calls.length);
  provider.calls.push({ model: body.model, body });
  return makeTextResponse(outcome.status, outcome.text != null ? outcome.text : JSON.stringify(outcome.json));
};
routerV5._weizeCompat.installWeizeCompatibilityFetch(globalThis);

// ---------------------------------------------------------------- directories

function jsonModels(payload) {
  return () => ({ ok: true, status: 200, async json() { return payload; } });
}
function catalogOf(ids) {
  return jsonModels({ data: ids.map((id) => ({ id, object: 'model' })) });
}
function statusModels(status) {
  return () => ({ ok: false, status, async json() { return {}; } });
}
function networkFailure() {
  return () => { throw new Error('getaddrinfo ENOTFOUND weizerouter.web.id'); };
}

const OUR_ROUTES = ['wz/gemini-2.5-flash', 'wz/claude-sonnet-4.6', 'wz/gpt-5.6-luna'];
// What the gateway would return if our hard-coded ids were stale or renamed.
const FOREIGN_CATALOG = ['gemini-2.5-flash', 'claude-sonnet-4.6', 'gpt-5.6-luna', 'deepseek-v4-pro'];

// ------------------------------------------------------------- chat behaviour

const answerFirst = (reply) => async () => ({ status: 200, json: { choices: [{ message: { content: reply } }] } });
const genericBadRequest = () => async () => ({ status: 400, json: { error: { message: 'invalid request shape' } } });
const temporaryOutage = () => async () => ({
  status: 400,
  json: {
    error: {
      code: 'wz_model_temporarily_unavailable',
      type: 'model_unavailable',
      message: 'Model WeizeRouter sedang mengalami gangguan sementara. Token tetap aman untuk request yang gagal.'
    }
  }
});

// ------------------------------------------------------------------- harness

function makeRes() {
  const captured = { status: 200, payload: null };
  const res = {
    status(code) { captured.status = code; return res; },
    json(payload) { captured.payload = payload; return res; },
    send(payload) { captured.payload = payload; return res; },
    setHeader() { return res; }
  };
  return { captured, res };
}

async function call(options) {
  const opts = options || {};
  if (!opts.warm) routerV4._test.resetState();
  provider.calls = [];

  const lines = [];
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  console.warn = (...args) => { lines.push(args.map(String).join(' ')); };

  const { captured, res } = makeRes();
  try {
    await handler({
      method: 'POST',
      headers: {
        host: 'app.autocuan.id',
        origin: 'https://app.autocuan.id',
        cookie: 'ac_sess=' + SESSION
      },
      body: {
        source: 'portfolio_chat',
        chatMessage: opts.question || QUESTION,
        retry: true,
        context: {
          plans: [{ ticker: SECRET_TICKER, entryPriceIdr: 9000, stopLossIdr: 8600, tp1Idr: 9800, lots: 5 }],
          prices: { [SECRET_TICKER]: 9150 }
        },
        history: []
      }
    }, res);
  } finally {
    console.log = realLog;
    console.warn = realWarn;
  }

  const directoryLine = lines.find((line) => line.startsWith('context-ai model directory'));
  return {
    status: captured.status,
    payload: captured.payload || {},
    calls: provider.calls.slice(),
    models: provider.calls.map((row) => row.model),
    lines,
    directoryLine: directoryLine || '',
    directory: directoryLine ? JSON.parse(directoryLine.replace('context-ai model directory ', '')) : null
  };
}

// =========================================================== the five states

test('a catalog that overlaps our routes reports CATALOG_WITH_OVERLAP and filters to it', async () => {
  provider.models = catalogOf(['wz/claude-fable-5', 'wz/kimi-k3']);
  provider.chat = answerFirst('Jawaban dari model yang benar-benar ada di katalog.');

  const out = await call();

  assert.equal(out.status, 200);
  assert.equal(out.directory.directory_state, STATES.CATALOG_WITH_OVERLAP);
  assert.equal(out.directory.probe_ok, true);
  assert.equal(out.directory.status, 200);
  assert.equal(out.directory.catalog_size, 2);
  assert.equal(out.directory.empty_catalog, false);
  assert.equal(out.directory.zero_overlap, false);
  assert.equal(out.directory.filter_applied, true);
  // Both catalog ids are also in the router's own CATALOG, so both survive the
  // intersection; the pool is narrowed from ~40 candidates to exactly these two.
  assert.equal(out.directory.overlap_count, 2);
  assert.ok(out.directory.candidate_count > 2);
  // Behaviour parity: the whitelist still narrows the pool exactly as before,
  // so the very first attempt is a catalog member rather than a stale route.
  assert.deepEqual(out.models, ['wz/claude-fable-5']);
});

test('a catalog sharing NO id with our routes is reported as CATALOG_ZERO_OVERLAP, not silently ignored', async () => {
  provider.models = catalogOf(FOREIGN_CATALOG);
  provider.chat = temporaryOutage();

  const out = await call();

  assert.equal(out.directory.directory_state, STATES.CATALOG_ZERO_OVERLAP);
  assert.equal(out.directory.probe_ok, true, 'the probe itself succeeded — this is not a network failure');
  assert.equal(out.directory.status, 200);
  assert.equal(out.directory.catalog_size, FOREIGN_CATALOG.length);
  assert.equal(out.directory.zero_overlap, true);
  assert.equal(out.directory.empty_catalog, false);
  assert.equal(out.directory.overlap_count, 0);
  assert.equal(out.directory.filter_applied, false);
  assert.ok(out.directory.candidate_count > 0);
  // The provider's real ids are visible, which is the whole point of E1: this is
  // what distinguishes stale model ids from a provider not serving inference.
  assert.deepEqual(out.directory.sample_ids, FOREIGN_CATALOG);
  // Behaviour parity: an empty intersection still falls back to the unfiltered
  // pool, exactly as the old `if (filtered.length)` guard did.
  assert.deepEqual(out.models.slice(0, 3), OUR_ROUTES);
  // And the state reaches the response for inspection from the browser too.
  assert.equal(out.payload.model_directory_state, STATES.CATALOG_ZERO_OVERLAP);
  assert.equal(out.payload.code, 'AI_MODELS_FAILED_SAFE_STOP', 'E1 does not redesign the failure code yet');
});

test('an empty catalog reports CATALOG_EMPTY and is not confused with a failed probe', async () => {
  provider.models = jsonModels({ data: [] });
  provider.chat = genericBadRequest();

  const out = await call();

  assert.equal(out.directory.directory_state, STATES.CATALOG_EMPTY);
  assert.equal(out.directory.empty_catalog, true);
  assert.equal(out.directory.zero_overlap, false);
  assert.equal(out.directory.probe_ok, true, 'the gateway answered 200; the catalog was just empty');
  assert.equal(out.directory.status, 200);
  assert.equal(out.directory.catalog_size, 0);
  assert.equal(out.directory.filter_applied, false);
  assert.deepEqual(out.directory.payload_keys, ['data']);
  assert.deepEqual(out.models, OUR_ROUTES);
});

test('a rejected key on /models reports AUTH_OR_ACCESS_FAILURE for 401 and 403', async () => {
  for (const status of [401, 403]) {
    provider.models = statusModels(status);
    provider.chat = genericBadRequest();

    const out = await call();

    assert.equal(out.directory.directory_state, STATES.AUTH_OR_ACCESS_FAILURE, 'status ' + status);
    assert.equal(out.directory.probe_ok, false);
    assert.equal(out.directory.status, status);
    assert.equal(out.directory.catalog_size, 0);
    assert.equal(out.directory.empty_catalog, false);
    assert.equal(out.directory.zero_overlap, false);
    // Observation only: an access failure on /models does not itself end the
    // request. The chat call still runs and still classifies itself.
    assert.deepEqual(out.models, OUR_ROUTES);
  }
});

test('an unreachable directory reports PROBE_FAILED and never blocks the chat call', async () => {
  provider.models = networkFailure();
  provider.chat = answerFirst('Jawaban walaupun /models tidak bisa dihubungi.');

  const out = await call();

  assert.equal(out.status, 200);
  assert.equal(out.directory.directory_state, STATES.PROBE_FAILED);
  assert.equal(out.directory.probe_ok, false);
  assert.equal(out.directory.status, 0);
  assert.equal(out.directory.filter_applied, false);
  assert.deepEqual(out.models, ['wz/gemini-2.5-flash']);
});

test('a 5xx and a non-JSON body both degrade to PROBE_FAILED rather than throwing', async () => {
  provider.chat = genericBadRequest();

  provider.models = statusModels(503);
  let out = await call();
  assert.equal(out.directory.directory_state, STATES.PROBE_FAILED);
  assert.equal(out.directory.status, 503);

  provider.models = () => ({ ok: true, status: 200, async json() { throw new SyntaxError('Unexpected token <'); } });
  out = await call();
  assert.equal(out.directory.directory_state, STATES.PROBE_FAILED);
  assert.equal(out.directory.status, 200);
  assert.deepEqual(out.models, OUR_ROUTES, 'a malformed directory must not change routing');
});

// ================================================================== metadata

test('availability metadata the provider returns is recorded verbatim, without inventing meaning', async () => {
  provider.models = jsonModels({
    object: 'list',
    data: [
      { id: 'wz/claude-fable-5', status: 'operational', available: true, is_active: 1 },
      { id: 'wz/gemini-2.5-flash', status: 'degraded', state: 'maintenance' },
      { id: 'wz/kimi-k3', enabled: false, health: { upstream: 'down' } }
    ]
  });
  provider.chat = answerFirst('Jawaban.');

  const out = await call();

  assert.deepEqual(out.directory.metadata_fields, ['available', 'enabled', 'health', 'is_active', 'state', 'status']);
  assert.deepEqual(out.directory.payload_keys, ['object', 'data']);
  assert.equal(out.directory.metadata_sample.length, 3);
  assert.deepEqual(out.directory.metadata_sample[0], {
    id: 'wz/claude-fable-5', status: 'operational', available: 'true', is_active: '1'
  });
  assert.deepEqual(out.directory.metadata_sample[1], {
    id: 'wz/gemini-2.5-flash', status: 'degraded', state: 'maintenance'
  });
  // A nested object is reduced to a type marker so a surprise payload shape can
  // never dump arbitrary content into a log line.
  assert.equal(out.directory.metadata_sample[2].health, '[object]');
  assert.equal(out.directory.metadata_sample[2].enabled, 'false');

  // E1 observes availability; it must not route on it. 'degraded' is still
  // called because the catalog contains it.
  assert.deepEqual(out.models, ['wz/gemini-2.5-flash']);
});

test('a directory with no availability fields reports empty metadata rather than guessing', async () => {
  provider.models = catalogOf(['wz/gemini-2.5-flash']);
  provider.chat = answerFirst('Jawaban.');

  const out = await call();

  assert.deepEqual(out.directory.metadata_fields, []);
  assert.deepEqual(out.directory.metadata_sample, []);
});

test('sample_ids is bounded to five even for a large catalog', async () => {
  const big = Array.from({ length: 40 }, (_, i) => 'wz/model-' + i).concat(['wz/gemini-2.5-flash']);
  provider.models = catalogOf(big);
  provider.chat = answerFirst('Jawaban.');

  const out = await call();

  assert.equal(out.directory.catalog_size, 41);
  assert.equal(out.directory.sample_ids.length, 5);
  assert.equal(out.directory.directory_state, STATES.CATALOG_WITH_OVERLAP);
});

// ==================================================================== safety

test('the diagnostic line carries no key, header, cookie, Supabase secret, question or portfolio figure', async () => {
  provider.models = catalogOf(FOREIGN_CATALOG);
  provider.chat = temporaryOutage();

  const out = await call({ question: QUESTION });
  const line = out.directoryLine;

  assert.ok(line.length > 0, 'the diagnostic line must be emitted');
  for (const secret of [API_KEY, SERVICE_ROLE, 'Bearer', 'Authorization', 'authorization', 'ac_sess', SESSION]) {
    assert.ok(!line.includes(secret), 'diagnostic must not contain ' + secret.slice(0, 24));
  }
  // No user prompt and no portfolio figures.
  assert.ok(!line.includes(QUESTION));
  assert.ok(!line.includes('9000') && !line.includes('9150') && !line.includes('8600'));
  assert.ok(!line.includes(SECRET_TICKER));
  // Only the host is taken from the base URL, never a credentialed URL.
  assert.equal(out.directory.provider_host, 'weizerouter.web.id');

  // Nothing else logged during the request leaks the key either.
  out.lines.forEach((row) => {
    assert.ok(!row.includes(API_KEY), 'no log line may contain the API key');
    assert.ok(!row.includes(SERVICE_ROLE), 'no log line may contain the service-role key');
  });
});

test('provider_host comes from the URL host only, discarding any embedded credentials', () => {
  const host = routerV4._test.providerHost;
  assert.equal(host('https://weizerouter.web.id/v1'), 'weizerouter.web.id');
  assert.equal(host('https://user:hunter2@weizerouter.web.id/v1'), 'weizerouter.web.id');
  assert.equal(host('not a url'), null);
});

// =================================================================== caching

test('the directory probe is cached, and a cache hit is labelled as one', async () => {
  let probes = 0;
  provider.models = () => { probes += 1; return { ok: true, status: 200, async json() { return { data: [{ id: 'wz/gemini-2.5-flash' }] }; } }; };
  provider.chat = answerFirst('Jawaban.');

  const first = await call();
  assert.equal(probes, 1);
  assert.equal(first.directory.cached, false);

  const second = await call({ warm: true, question: 'Pertanyaan kedua yang berbeda.' });
  assert.equal(probes, 1, 'a warm instance must not re-probe inside the TTL');
  assert.equal(second.directory.cached, true);
  assert.equal(second.directory.directory_state, STATES.CATALOG_WITH_OVERLAP);
});

// ========================================================== routing parity

test('reconciliation selects exactly what the previous whitelist filter selected', () => {
  const reconcile = routerV4._test.reconcileModelDirectory;
  const candidates = ['wz/a', 'wz/b', 'wz/c'];

  // The behaviour this replaces:
  //   if (available) { const f = models.filter(m => available.has(m)); if (f.length) models = f; }
  const legacy = (ids) => {
    let models = candidates.slice();
    if (ids) {
      const filtered = models.filter((model) => ids.has(model));
      if (filtered.length) models = filtered;
    }
    return models;
  };

  // 'CATALOG_PRESENT' is what the probe records when a usable catalog comes
  // back; overlap belongs to the request, so reconciliation resolves it.
  const cases = [
    { name: 'overlap', report: { state: 'CATALOG_PRESENT', ids: new Set(['wz/b', 'wz/zzz']) }, ids: new Set(['wz/b', 'wz/zzz']) },
    { name: 'zero overlap', report: { state: 'CATALOG_PRESENT', ids: new Set(['wz/zzz']) }, ids: new Set(['wz/zzz']) },
    { name: 'empty catalog', report: { state: STATES.CATALOG_EMPTY, ids: null }, ids: null },
    { name: 'probe failed', report: { state: STATES.PROBE_FAILED, ids: null }, ids: null },
    { name: 'auth failure', report: { state: STATES.AUTH_OR_ACCESS_FAILURE, ids: null }, ids: null }
  ];

  cases.forEach((row) => {
    assert.deepEqual(reconcile(row.report, candidates).models, legacy(row.ids), row.name);
  });

  assert.equal(reconcile({ state: 'CATALOG_PRESENT', ids: new Set(['wz/zzz']) }, candidates).state, STATES.CATALOG_ZERO_OVERLAP);
  assert.equal(reconcile({ state: 'CATALOG_PRESENT', ids: new Set(['wz/b']) }, candidates).state, STATES.CATALOG_WITH_OVERLAP);
  assert.equal(reconcile(null, candidates).state, STATES.PROBE_FAILED);
  assert.deepEqual(reconcile(null, candidates).models, candidates);
});

test('every reachable directory outcome resolves to one of the five documented states', async () => {
  const documented = new Set(Object.values(STATES));
  assert.equal(documented.size, 5);
  provider.chat = genericBadRequest();

  const directories = [
    catalogOf(['wz/gemini-2.5-flash']),          // overlap
    catalogOf(FOREIGN_CATALOG),                  // zero overlap
    jsonModels({ data: [] }),                    // empty
    jsonModels({ object: 'list', models: [] }),  // unexpected envelope
    statusModels(401),                           // access
    statusModels(500),                           // probe failure
    networkFailure()                             // transport failure
  ];

  for (const directory of directories) {
    provider.models = directory;
    const out = await call();
    assert.ok(documented.has(out.directory.directory_state), 'emitted ' + out.directory.directory_state);
    assert.notEqual(out.directory.directory_state, 'CATALOG_PRESENT', 'the probe-stage marker must never be emitted');
  }
});

test('existing failover is unchanged: nine temporary outages still spill over and still stop safely', async () => {
  provider.models = catalogOf(FOREIGN_CATALOG);
  provider.chat = temporaryOutage();

  const out = await call();

  assert.equal(out.status, 503);
  assert.equal(out.payload.code, 'AI_MODELS_FAILED_SAFE_STOP');
  assert.equal(out.calls.length, 9, 'three normal attempts plus six outage spillover attempts');
  assert.deepEqual(out.models.slice(0, 3), OUR_ROUTES);
  assert.equal(out.payload.provider_failed, true);
});

test('a credential failure on the chat call is still terminal after one attempt', async () => {
  provider.models = catalogOf(FOREIGN_CATALOG);
  provider.chat = async () => ({ status: 401, json: { error: { message: 'unauthorized' } } });

  const out = await call();

  assert.equal(out.status, 503);
  assert.equal(out.payload.code, 'AI_KEY_OR_BALANCE_ERROR');
  assert.equal(out.calls.length, 1, 'a rejected key must never fan out across the pool');
});

test('a generic 400 is still not treated as a temporary outage', async () => {
  provider.models = catalogOf(FOREIGN_CATALOG);
  provider.chat = genericBadRequest();

  const out = await call();

  assert.equal(out.status, 503);
  assert.equal(out.payload.code, 'AI_MODELS_FAILED_SAFE_STOP');
  assert.equal(out.calls.length, 3, 'only wz_model_temporarily_unavailable may exceed the normal attempt cap');
  assert.equal(out.payload.model_directory_state, STATES.CATALOG_ZERO_OVERLAP);
});
