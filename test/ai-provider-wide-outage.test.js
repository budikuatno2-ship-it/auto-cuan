'use strict';

// E3 + E4 — provider-wide outage classification and the request-waste latch.
//
// The E1 probe settled this in production: directory_state CATALOG_WITH_OVERLAP,
// catalog_size 73, overlap_count 42 of 44 candidate routes — and then every one
// of those catalog-valid routes answered HTTP 400 wz_model_temporarily_unavailable.
// The model ids are fine. The gateway is not.
//
// Before this change one question cost nine upstream chat calls and came back as
// AI_MODELS_FAILED_SAFE_STOP ("every model refused the request or is full"),
// which is not what happened. These tests lock down the opposite: strong evidence
// is required to call the gateway down, and once it is proven the router says so
// truthfully and stops spending.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');

const supabasePath = require.resolve('@supabase/supabase-js');
const account = { id: 'u-wide-outage', username: 'budi', is_approved: true, is_blocked: false };
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

process.env.SESSION_SECRET = 'ai-provider-wide-outage-secret';
process.env.SUPABASE_URL = 'https://stub.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-service-role';
process.env.PORTFOLIO_AI_API_KEY = 'stub-weize-key';
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
const LATCH = routerV4._test.providerOutageLatch;

// The live catalog, as production reports it: our routes are all present.
const CATALOG = [
  'wz/gemini-2.5-flash', 'wz/claude-sonnet-4.6', 'wz/gpt-5.6-luna',
  'wz/gemini-3.5-flash-low', 'wz/gpt-5.6-sol', 'wz/gpt-5.4-mini',
  'wz/claude-haiku-4.5', 'wz/deepseek-v4-pro', 'wz/claude-fable-5', 'wz/gpt-5.6-terra'
];
const NORMAL_ROUTES = ['wz/gemini-2.5-flash', 'wz/claude-sonnet-4.6', 'wz/gpt-5.6-luna'];

const provider = { calls: [], script: null, directoryOk: true, catalog: CATALOG };

function textResponse(status, text) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return text; },
    clone() { return { async text() { return text; } }; }
  };
}

globalThis.fetch = async function (url, options) {
  const target = String(url);
  if (target.endsWith('/models')) {
    if (!provider.directoryOk) return { ok: false, status: 503, async json() { return {}; } };
    return { ok: true, status: 200, async json() { return { object: 'list', data: provider.catalog.map((id) => ({ id })) }; } };
  }
  const body = JSON.parse(options.body);
  const outcome = await provider.script(body.model, provider.calls.length);
  provider.calls.push({ model: body.model });
  if (outcome.abort) {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
  }
  return textResponse(outcome.status, outcome.text != null ? outcome.text : JSON.stringify(outcome.json));
};
routerV5._weizeCompat.installWeizeCompatibilityFetch(globalThis);

// ------------------------------------------------------------------ scripts

const answer = (content) => ({ status: 200, json: { choices: [{ message: { content } }] } });
const temporary = () => ({
  status: 400,
  json: {
    error: {
      code: 'wz_model_temporarily_unavailable',
      type: 'model_unavailable',
      message: 'Model WeizeRouter sedang mengalami gangguan sementara. Token tetap aman untuk request yang gagal.'
    }
  }
});
const genericBadRequest = () => ({ status: 400, json: { error: { message: 'invalid request shape' } } });
const unauthorized = () => ({ status: 401, json: { error: { message: 'unauthorized' } } });
const rateLimited = () => ({ status: 429, json: { error: { message: 'too many requests' } } });
const serverError = () => ({ status: 500, json: { error: { message: 'upstream boom' } } });
const timeout = () => ({ abort: true });

const always = (outcome) => async () => outcome();
const allTemporary = always(temporary);

// ------------------------------------------------------------------ harness

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

const PORTFOLIO = {
  plans: [{ ticker: 'BBCA', entryPriceIdr: 9000, stopLossIdr: 8600, tp1Idr: 9800, lots: 5, estimatedMaxLossIdr: 200000, capitalIdr: 4500000 }],
  prices: { BBCA: 9150 },
  summary: { plan_count: 1, positions_with_price: 1, positions_missing_price: 0, total_estimated_risk: 200000 }
};
const STOCK_SNAPSHOT = [
  'BBCA — Swing Setup',
  'Harga terakhir: 9.150',
  'Entry / Konfirmasi: 9.000 - 9.100',
  'Stop Loss / Invalidasi: 8.600',
  'Target 1: 9.800',
  'Status: READY_PENDING 1/2'
].join('\n');

async function call(options) {
  const opts = options || {};
  if (opts.cold !== false) routerV4._test.resetState();
  provider.calls = [];
  const { captured, res } = makeRes();
  const body = opts.stock
    ? {
        source: 'stock_analysis_followup',
        chatMessage: opts.question || 'Apakah setup ini masih layak dipantau?',
        context: { ticker: 'BBCA', analysis_text: STOCK_SNAPSHOT, captured_at: '2026-08-14T23:30:00+07:00' },
        history: []
      }
    : {
        source: 'portfolio_chat',
        chatMessage: opts.question || 'Analisis risiko portofolio saya.',
        context: PORTFOLIO,
        history: []
      };
  if (opts.retry) body.retry = true;
  await handler({
    method: 'POST',
    headers: { host: 'app.autocuan.id', origin: 'https://app.autocuan.id', cookie: 'ac_sess=' + SESSION },
    body
  }, res);
  return {
    status: captured.status,
    payload: captured.payload || {},
    calls: provider.calls.slice(),
    models: provider.calls.map((row) => row.model)
  };
}

// ================================================== normal paths still normal

test('a healthy primary model still answers on the first attempt', async () => {
  provider.directoryOk = true;
  provider.script = always(() => answer('Jawaban dari model utama.'));

  const out = await call();

  assert.equal(out.status, 200);
  assert.equal(out.payload.success, true);
  assert.equal(out.payload.reply, 'Jawaban dari model utama.');
  assert.equal(out.calls.length, 1);
  assert.equal(LATCH.until, 0, 'a success must never arm the latch');
});

test('one unavailable model still fails over to the next route', async () => {
  provider.script = async (model, index) => (index === 0 ? temporary() : answer('Jawaban dari model cadangan.'));

  const out = await call();

  assert.equal(out.status, 200);
  assert.equal(out.payload.reply, 'Jawaban dari model cadangan.');
  assert.equal(out.calls.length, 2);
  assert.equal(LATCH.until, 0);
});

test('a model-specific outage that another vendor survives must NOT trip the circuit', async () => {
  // Two temporary failures then a real answer: the gateway is clearly serving.
  provider.script = async (model, index) => (index < 2 ? temporary() : answer('Vendor ketiga sehat.'));

  const out = await call();

  assert.equal(out.status, 200);
  assert.equal(out.payload.success, true);
  assert.equal(out.calls.length, 3);
  assert.equal(LATCH.until, 0, 'a surviving vendor disproves a gateway-wide outage');
});

// ============================================ E3 provider-wide classification

test('three catalog-valid cross-vendor temporary outages are classified as a provider-wide outage', async () => {
  provider.script = allTemporary;

  const out = await call();

  assert.equal(out.status, 503);
  assert.equal(out.payload.code, 'AI_PROVIDER_TEMPORARILY_UNAVAILABLE');
  assert.equal(out.payload.provider_wide_outage, true);
  assert.equal(out.payload.provider_failed, true);
  assert.equal(out.payload.token_protection, true);
  assert.equal(out.payload.model_directory_state, 'CATALOG_WITH_OVERLAP');
  assert.deepEqual(out.payload.provider_outage_families, ['gemini', 'claude', 'gpt']);
  assert.deepEqual(out.payload.attempted_models, NORMAL_ROUTES);
  // Truthful: names the provider, never calls the user's question invalid, and
  // makes no claim about token accounting the app cannot verify.
  assert.match(out.payload.error, /Provider AI sedang mengalami gangguan sementara/);
  assert.doesNotMatch(out.payload.error, /tidak valid|invalid/i);
  assert.doesNotMatch(out.payload.error, /token tetap aman|token kamu aman/i);
});

test('the router stops at three attempts instead of burning nine to reconfirm', async () => {
  provider.script = allTemporary;

  const out = await call();

  assert.equal(out.calls.length, 3, 'six emergency calls must not re-derive a conclusion already proven');
  assert.deepEqual(out.models, NORMAL_ROUTES);
  assert.equal(out.payload.attempted_count, 3);
});

test('classification requires a healthy catalog: an unproven directory keeps the old spillover', async () => {
  provider.directoryOk = false;
  provider.script = allTemporary;

  const out = await call();

  assert.equal(out.payload.code, 'AI_MODELS_FAILED_SAFE_STOP');
  assert.notEqual(out.payload.code, 'AI_PROVIDER_TEMPORARILY_UNAVAILABLE');
  assert.equal(out.calls.length, 9, 'without a catalog we cannot prove gateway-wide, so more routes are still tried');
  assert.equal(LATCH.until, 0);
  provider.directoryOk = true;
});

test('mixed evidence does not qualify: two temporary plus one timeout is not a gateway-wide outage', async () => {
  provider.script = async (model, index) => (index < 2 ? temporary() : timeout());

  const out = await call();

  assert.notEqual(out.payload.code, 'AI_PROVIDER_TEMPORARILY_UNAVAILABLE');
  assert.equal(LATCH.until, 0, 'one non-temporary failure disqualifies the whole request');
});

test('a single-family outage does not qualify even when every attempt is temporary', () => {
  const evidence = routerV4._test.providerWideOutageEvidence(
    [
      { model: 'wz/gemini-2.5-flash', temporary_unavailable: true },
      { model: 'wz/gemini-3.5-flash-low', temporary_unavailable: true },
      { model: 'wz/gemini-2.5-flash-lite', temporary_unavailable: true }
    ],
    new Set(['wz/gemini-2.5-flash', 'wz/gemini-3.5-flash-low', 'wz/gemini-2.5-flash-lite']),
    'CATALOG_WITH_OVERLAP'
  );
  assert.equal(evidence.qualifies, false, 'one vendor being down is not the gateway being down');
});

test('two attempts do not qualify even across two families', () => {
  const evidence = routerV4._test.providerWideOutageEvidence(
    [
      { model: 'wz/gemini-2.5-flash', temporary_unavailable: true },
      { model: 'wz/claude-sonnet-4.6', temporary_unavailable: true }
    ],
    new Set(['wz/gemini-2.5-flash', 'wz/claude-sonnet-4.6']),
    'CATALOG_WITH_OVERLAP'
  );
  assert.equal(evidence.qualifies, false);
});

test('a route missing from the live catalog cannot contribute evidence', () => {
  const evidence = routerV4._test.providerWideOutageEvidence(
    [
      { model: 'wz/gemini-2.5-flash', temporary_unavailable: true },
      { model: 'wz/claude-sonnet-4.6', temporary_unavailable: true },
      { model: 'wz/ghost-model', temporary_unavailable: true }
    ],
    new Set(['wz/gemini-2.5-flash', 'wz/claude-sonnet-4.6']),
    'CATALOG_WITH_OVERLAP'
  );
  assert.equal(evidence.qualifies, false, 'only catalog-valid routes count');
});

// ================================================================== E4 latch

test('a warm second request during the latch makes zero chat calls and tells the same truth', async () => {
  provider.script = allTemporary;
  const first = await call();
  assert.equal(first.payload.code, 'AI_PROVIDER_TEMPORARILY_UNAVAILABLE');
  assert.equal(first.calls.length, 3);

  const second = await call({ cold: false, question: 'Pertanyaan lain yang benar-benar berbeda.' });

  assert.equal(second.status, 503);
  assert.equal(second.payload.code, 'AI_PROVIDER_TEMPORARILY_UNAVAILABLE');
  assert.equal(second.payload.provider_outage_latched, true);
  assert.equal(second.calls.length, 0, 'a latched request must not touch the provider at all');
  assert.equal(second.payload.attempted_count, 0);
  assert.deepEqual(second.payload.attempted_models, []);
  assert.ok(second.payload.retry_after_seconds > 0);
});

test('the latched fast return counts nothing, and the /models probe is never a chat attempt', async () => {
  provider.script = allTemporary;
  await call();
  const latched = await call({ cold: false, question: 'Pertanyaan ketiga.' });

  assert.equal(latched.payload.attempted_count, 0);
  assert.deepEqual(latched.payload.attempted_models, []);
  assert.equal(latched.calls.length, 0);
});

test('an expired latch resumes probing the provider', async () => {
  provider.script = allTemporary;
  await call();
  assert.ok(LATCH.until > Date.now());

  LATCH.until = Date.now() - 1;
  provider.script = always(() => answer('Provider sudah pulih.'));
  const after = await call({ cold: false, question: 'Sudah pulih belum?' });

  assert.equal(after.status, 200);
  assert.equal(after.payload.reply, 'Provider sudah pulih.');
  assert.ok(after.calls.length > 0, 'once the latch expires the provider must be tried again');
});

// ------------------------------------------- correction A: retry semantics

test('an explicit retry bypasses the latch for that request only, without clearing it for everyone', async () => {
  provider.script = allTemporary;
  await call();
  const armedUntil = LATCH.until;
  assert.ok(armedUntil > Date.now());

  // The retry itself fails for an unrelated reason, so provider-wide state must
  // survive: a timeout is not evidence that the gateway recovered.
  provider.script = always(timeout);
  const retried = await call({ cold: false, retry: true, question: 'Coba lagi dong.' });

  assert.ok(retried.calls.length > 0, 'retry must actually reach the provider');
  assert.notEqual(retried.payload.code, 'AI_PROVIDER_TEMPORARILY_UNAVAILABLE');
  assert.ok(LATCH.until > Date.now(), 'an unrelated failure must not clear the instance-wide latch');
  assert.equal(LATCH.until, armedUntil, 'nor should it re-arm it');

  // A different user on the same instance is still protected.
  provider.script = allTemporary;
  const other = await call({ cold: false, question: 'Pertanyaan pengguna lain.' });
  assert.equal(other.calls.length, 0);
  assert.equal(other.payload.code, 'AI_PROVIDER_TEMPORARILY_UNAVAILABLE');
});

test('a retry that gets a real answer clears the latch', async () => {
  provider.script = allTemporary;
  await call();
  assert.ok(LATCH.until > Date.now());

  provider.script = always(() => answer('Jawaban asli dari model.'));
  const retried = await call({ cold: false, retry: true, question: 'Coba lagi ya.' });

  assert.equal(retried.status, 200);
  assert.equal(retried.payload.success, true);
  assert.equal(LATCH.until, 0, 'only a real model answer proves recovery');
});

test('a retry that proves the outage again re-arms the latch TTL', async () => {
  provider.script = allTemporary;
  await call();
  const firstUntil = LATCH.until;

  await new Promise((resolve) => setTimeout(resolve, 15));
  const retried = await call({ cold: false, retry: true, question: 'Masih gangguan?' });

  assert.equal(retried.payload.code, 'AI_PROVIDER_TEMPORARILY_UNAVAILABLE');
  assert.equal(retried.calls.length, 3);
  assert.ok(LATCH.until > firstUntil, 'fresh proof extends the window rather than shortening it');
});

// -------------------------------- correction B: latch outranks negative cache

test('an active latch outranks the negative failure cache for a repeated question', async () => {
  const QUESTION = 'Pertanyaan yang diulang persis sama.';

  // 1. A generic failure populates the negative cache for this exact question.
  provider.script = always(genericBadRequest);
  const seed = await call({ question: QUESTION });
  assert.equal(seed.payload.code, 'AI_MODELS_FAILED_SAFE_STOP');

  // 2. A different question proves the gateway is down and arms the latch.
  provider.script = allTemporary;
  const proof = await call({ cold: false, question: 'Pertanyaan berbeda yang membuktikan outage.' });
  assert.equal(proof.payload.code, 'AI_PROVIDER_TEMPORARILY_UNAVAILABLE');

  // 3. The original question repeats. AI_RECENT_FAILURE would describe the wrong
  //    problem and hide the fact that the gateway itself is unavailable.
  const repeat = await call({ cold: false, question: QUESTION });
  assert.equal(repeat.payload.code, 'AI_PROVIDER_TEMPORARILY_UNAVAILABLE');
  assert.notEqual(repeat.payload.code, 'AI_RECENT_FAILURE');
  assert.equal(repeat.calls.length, 0, 'no chat completion may be issued');
  assert.equal(repeat.payload.attempted_count, 0);
  assert.deepEqual(repeat.payload.attempted_models, []);
});

test('a positive cache hit is still served during an active latch', async () => {
  provider.script = always(() => answer('Jawaban yang akan di-cache.'));
  const first = await call({ question: 'Pertanyaan yang berhasil.' });
  assert.equal(first.payload.success, true);

  // Arm the latch with a different question.
  provider.script = allTemporary;
  await call({ cold: false, question: 'Pertanyaan yang membuktikan outage.' });
  assert.ok(LATCH.until > Date.now());

  const cached = await call({ cold: false, question: 'Pertanyaan yang berhasil.' });
  assert.equal(cached.status, 200);
  assert.equal(cached.payload.success, true);
  assert.equal(cached.payload.cache_hit, true);
  assert.equal(cached.calls.length, 0);
});

// ========================================== other failure classes unchanged

test('a generic HTTP 400 is not a provider-wide outage', async () => {
  provider.script = always(genericBadRequest);

  const out = await call();

  assert.equal(out.payload.code, 'AI_MODELS_FAILED_SAFE_STOP');
  assert.equal(out.payload.provider_wide_outage, undefined);
  assert.equal(LATCH.until, 0);
  assert.equal(out.calls.length, 3);
});

test('401 remains a terminal credential failure after a single attempt', async () => {
  provider.script = always(unauthorized);

  const out = await call();

  assert.equal(out.status, 503);
  assert.equal(out.payload.code, 'AI_KEY_OR_BALANCE_ERROR');
  assert.equal(out.calls.length, 1);
  assert.equal(LATCH.until, 0, 'a rejected key is not a gateway outage');
});

test('429 and 5xx keep their existing retry classification', async () => {
  for (const script of [rateLimited, serverError]) {
    provider.script = always(script);
    const out = await call();
    assert.equal(out.payload.code, 'AI_MODELS_FAILED_SAFE_STOP');
    assert.equal(LATCH.until, 0);
  }
});

test('an all-timeout request still reports AI_ALL_MODELS_TIMED_OUT', async () => {
  provider.script = always(timeout);

  const out = await call();

  assert.equal(out.payload.code, 'AI_ALL_MODELS_TIMED_OUT');
  assert.equal(LATCH.until, 0);
});

// ================================== attempted_count and emergency bookkeeping

test('attempted_count equals the real number of chat calls on the provider-wide path', async () => {
  provider.script = allTemporary;
  const out = await call();
  assert.equal(out.payload.attempted_count, out.calls.length);
  assert.equal(out.payload.attempted_count, 3);
});

test('attempted_count equals the real number of chat calls when spillover runs and fails', async () => {
  provider.directoryOk = false;
  provider.script = allTemporary;

  const out = await call();

  assert.equal(out.calls.length, 9);
  assert.equal(out.payload.attempted_count, 9, 'nine calls must not be reported as three');
  assert.equal(out.payload.emergency_attempted_count, 6);
  assert.equal(out.payload.attempted_models.length, 9);
  provider.directoryOk = true;
});

test('emergency spillover failures are recorded in model health and earn a cooldown', async () => {
  provider.directoryOk = false;
  provider.script = allTemporary;

  await call();
  const health = routerV4._test.health;
  assert.ok(health.has('wz/gemini-3.5-flash-low'), 'emergency routes were previously exempt from health tracking');
  assert.ok(health.has('wz/gpt-5.4-mini'));
  assert.equal(health.get('wz/gemini-3.5-flash-low').consecutive, 1);

  // A second warm request pushes them over the threshold into cooldown.
  await call({ cold: false, question: 'Pertanyaan kedua.' });
  assert.ok(health.get('wz/gemini-3.5-flash-low').cooldownUntil > Date.now(), 'a dead route must stop being re-probed forever');
  provider.directoryOk = true;
});

// ======================================================= surface protection

test('stock analysis keeps its deterministic local fallback under a provider-wide outage', async () => {
  provider.script = allTemporary;

  const out = await call({ stock: true, question: 'Stop loss-nya di mana?' });

  assert.equal(out.status, 200);
  assert.equal(out.payload.success, true);
  assert.equal(out.payload.local_fallback, true, 'the stock surface must not lose its fallback to the new code');
  assert.equal(out.payload.provider_unavailable, true);
  assert.equal(out.payload.provider_code, 'AI_PROVIDER_TEMPORARILY_UNAVAILABLE');
  assert.equal(out.payload.model_used, 'local-stock-snapshot-v1');
  // Quotes the snapshot it was handed and nothing else: the level comes from the
  // rendered analysis, and the reply says plainly it is not a real-time price.
  assert.ok(out.payload.reply.includes('8.600'), 'the summary may only quote the snapshot it was given');
  assert.match(out.payload.reply, /bukan harga real-time/);
  assert.equal(out.calls.length, 3, 'and it still must not burn nine calls first');
});

test('the new code is in the router fallback set, so the stock surface can never silently lose it', () => {
  const source = fs.readFileSync(path.join(ROOT, 'lib/context-ai-router-v6.js'), 'utf8');
  assert.match(source, /FALLBACK_CODES[\s\S]*AI_PROVIDER_TEMPORARILY_UNAVAILABLE/);
  // The codes a user must act on stay out of it: dressing those up as an outage
  // buries the only thing that would fix them.
  const block = source.slice(source.indexOf('FALLBACK_CODES'), source.indexOf(']);'));
  assert.ok(!block.includes('AI_KEY_OR_BALANCE_ERROR'));
  assert.ok(!block.includes('AI_NOT_CONFIGURED'));
});

test('the portfolio surface labels the outage and keeps its summary explicitly non-AI', () => {
  const source = fs.readFileSync(path.join(ROOT, 'public/portfolio-ai-runtime-v2.js'), 'utf8');
  assert.match(source, /AI_PROVIDER_TEMPORARILY_UNAVAILABLE/);
  assert.match(source, /Provider AI sedang mengalami gangguan sementara\. Ringkasan di bawah dihitung secara lokal dan bukan jawaban AI\./);
  // The bubble badge and the summary's own opening line both still disclaim it.
  assert.match(source, /Ringkasan lokal — bukan jawaban AI/);
  assert.match(source, /bukan jawaban AI/);
  // Local summaries stay out of the history replayed to the model.
  assert.match(source, /return !row\.local/);
});

test('the stock surface promises a local analysis only when one is actually rendered', () => {
  const source = fs.readFileSync(path.join(ROOT, 'public/stock-analysis-ai.js'), 'utf8');
  // Shown alongside a real local summary.
  assert.match(source, /Provider AI sedang mengalami gangguan sementara\. Analisis lokal ditampilkan sementara\./);
  // Shown when there is no local summary — must not claim one is on screen.
  assert.match(source, /Provider AI sedang mengalami gangguan sementara\. Coba lagi sebentar\./);
  const failureBranch = source.slice(source.indexOf('function describeFailure'), source.indexOf('function addScopeNote'));
  assert.ok(!failureBranch.includes('Analisis lokal ditampilkan'), 'the no-fallback path must not promise a local analysis');
  assert.match(source, /Ringkasan lokal — bukan jawaban AI/);
  assert.match(source, /data\.local_fallback !== true/);
});

// ============================================================== E1 intact

test('E1 model-directory diagnostics still work alongside the outage classifier', async () => {
  provider.script = allTemporary;
  const lines = [];
  const realLog = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  let out;
  try { out = await call(); }
  finally { console.log = realLog; }

  const line = lines.find((row) => row.startsWith('context-ai model directory'));
  assert.ok(line, 'the E1 diagnostic line must still be emitted');
  const directory = JSON.parse(line.replace('context-ai model directory ', ''));
  assert.equal(directory.directory_state, 'CATALOG_WITH_OVERLAP');
  assert.equal(directory.catalog_size, CATALOG.length);
  assert.equal(directory.filter_applied, true);
  assert.ok(!line.includes('stub-weize-key'));
  assert.equal(out.payload.model_directory_state, 'CATALOG_WITH_OVERLAP');
});

test('model families are derived structurally, so unseen catalog entries still classify', () => {
  const family = routerV4._test.modelFamily;
  assert.equal(family('wz/gemini-2.5-flash'), 'gemini');
  assert.equal(family('wz/claude-sonnet-4.6'), 'claude');
  assert.equal(family('wz/gpt-5.6-luna'), 'gpt');
  assert.equal(family('wz/deepseek-v4-pro'), 'deepseek');
  assert.equal(family('wz/kimi-k2.7-code'), 'kimi');
  assert.equal(family('wz/jokowi'), 'jokowi');
  assert.equal(family(''), 'unknown');
  assert.equal(family(null), 'unknown');
});
