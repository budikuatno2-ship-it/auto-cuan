'use strict';

// ===========================================================================
// PROVIDER FAILOVER, AUTH AND DATA HONESTY FOR BOTH AI SURFACES.
//
// These are behavioural tests: the real api/analyze.js handler runs against a
// scripted provider and a scripted Supabase, so what is asserted is what a
// browser would actually receive.
//
// The defects they lock out, all reproduced against the shipped code:
//
//   1. A single slow model ended the whole request. runModels() returned
//      `terminal` on the first AbortError, so a healthy backup model was never
//      tried and the browser fell back to "Jalur AI utama sedang sibuk" after
//      ~38s of waiting.
//   2. A 400/404/422 whose body did not happen to match a keyword list was also
//      terminal. A provider rejecting one optional parameter (max_tokens on a
//      model that wants max_completion_tokens, a fixed-temperature model) took
//      the entire request down with a healthy backup sitting untried.
//   3. The negative cache answered a user-pressed retry with a canned 503 for
//      30s, so the person could not retry even once the provider had recovered.
//   4. portfolioContext() rebuilt the context from scratch and dropped every
//      grounded structure api/analyze.js had just computed — calculation_facts,
//      affordability_facts, the answer policy — so the model never saw them.
//   5. Nothing told the model how old a stored price was, so it could not obey
//      "say so when the price is stale or missing".
//   6. compactAnalysisText() could truncate away the setup state line while
//      keeping entry/stop/target, letting an unconfirmed setup be described as
//      actionable.
//
// LOCAL / STATIC ONLY: no network, no real Supabase, no real provider.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// ---- Supabase stub, installed before anything requires the real client ----
const supabasePath = require.resolve('@supabase/supabase-js');
const supabaseState = {
  account: { id: 'u-1', username: 'budi', is_approved: true, is_blocked: false },
  snapshotRow: null
};
function stubQuery(table) {
  const q = {
    select() { return q; },
    eq() { return q; },
    order() { return q; },
    limit() { return q; },
    async maybeSingle() {
      if (table === 'app_users') return { data: supabaseState.account, error: null };
      if (table === 'ai_context_snapshots') return { data: supabaseState.snapshotRow, error: null };
      return { data: null, error: null };
    },
    async upsert() { return { error: null }; }
  };
  return q;
}
require.cache[supabasePath] = {
  id: supabasePath, filename: supabasePath, loaded: true, paths: [],
  exports: { createClient() { return { from: stubQuery }; } }
};

process.env.SESSION_SECRET = 'ai-failover-test-secret';
process.env.SUPABASE_URL = 'https://stub.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-service-role';
process.env.PORTFOLIO_AI_API_KEY = 'stub-provider-key';
process.env.PORTFOLIO_AI_BASE_URL = 'https://provider.invalid/v1';
// Keep the timing tests quick without disabling the budget logic itself.
process.env.PORTFOLIO_AI_MODEL_TIMEOUT_MS = '1000';
process.env.PORTFOLIO_AI_TOTAL_TIMEOUT_MS = '10000';

const { createSessionToken } = require(path.join(ROOT, 'lib/admin-session.js'));
const routerV4 = require(path.join(ROOT, 'lib/context-ai-router-v4.js'));
const handler = require(path.join(ROOT, 'api/analyze.js'));

const SESSION = createSessionToken({ userId: 'u-1', username: 'budi', isAdmin: false });

// ---- scripted provider ---------------------------------------------------
const provider = { calls: [], script: null, directory: null };
globalThis.fetch = async function (url, options) {
  const target = String(url);
  if (target.endsWith('/models')) {
    if (!provider.directory) throw new Error('no model directory');
    return { ok: true, status: 200, async json() { return { data: provider.directory.map(id => ({ id })) }; } };
  }
  const body = JSON.parse(options.body);
  const outcome = await provider.script(body.model, body, provider.calls.length);
  provider.calls.push({ model: body.model, body, status: outcome.status });
  if (outcome.hangMs) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, outcome.hangMs);
      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }
    });
  }
  const text = outcome.text != null ? outcome.text : JSON.stringify(outcome.json);
  return {
    ok: outcome.status >= 200 && outcome.status < 300,
    status: outcome.status,
    async text() { return text; }
  };
};

const answer = content => ({ status: 200, json: { choices: [{ message: { content } }] } });

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

async function call(body, options) {
  options = options || {};
  routerV4._test.resetState();
  provider.calls = [];
  const { captured, res } = makeRes();
  const req = {
    method: options.method || 'POST',
    headers: Object.assign({
      host: 'app.autocuan.id',
      origin: 'https://app.autocuan.id',
      cookie: options.noSession ? '' : 'ac_sess=' + SESSION
    }, options.headers || {}),
    body
  };
  await handler(req, res);
  return { status: captured.status, payload: captured.payload || {}, calls: provider.calls.slice(), req };
}

const PORTFOLIO = {
  plans: [
    { ticker: 'BBCA', entryPriceIdr: 9000, stopLossIdr: 8600, tp1Idr: 9800, lots: 5, estimatedMaxLossIdr: 200000, capitalIdr: 4500000 },
    { ticker: 'TLKM', entryPriceIdr: 3000, stopLossIdr: 2850, lots: 10, estimatedMaxLossIdr: 150000, capitalIdr: 3000000 }
  ],
  prices: { BBCA: 9150, TLKM: 2950 },
  summary: { plan_count: 2, positions_with_price: 2, positions_missing_price: 0, total_estimated_risk: 350000, total_position_value: 7500000 }
};
const STOCK_SNAPSHOT = [
  'BBCA — Swing Setup',
  'Harga terakhir: 9.150',
  'Entry / Konfirmasi: 9.000 - 9.100',
  'Stop Loss / Invalidasi: 8.600',
  'Target 1: 9.800',
  'Status: READY_PENDING 1/2',
  'Alasan: volume belum konfirmasi'
].join('\n');

const portfolioAsk = (question, context) => ({
  source: 'portfolio_chat', chatMessage: question, context: context || PORTFOLIO, history: []
});
const stockAsk = (question, context) => ({
  source: 'stock_analysis_followup', chatMessage: question,
  context: context || { ticker: 'BBCA', analysis_text: STOCK_SNAPSHOT, captured_at: '2026-08-13T16:00:00+07:00' },
  history: []
});

// =========================== PRIMARY SUCCESS ==============================

test('portfolio: the primary model answer is what reaches the browser', async () => {
  provider.script = async () => answer('Kondisi portofolio kamu terlihat seimbang.');
  const out = await call(portfolioAsk('Bagaimana kondisi portofolio ku?'));
  assert.equal(out.status, 200);
  assert.equal(out.payload.success, true);
  assert.equal(out.payload.reply, 'Kondisi portofolio kamu terlihat seimbang.');
  assert.equal(out.payload.attempted_count, 1);
  assert.equal(out.payload.portfolio_data_used, true);
  assert.match(out.payload.model_used, /^wz\//);
});

test('stock analysis: the primary model answer is what reaches the browser', async () => {
  provider.script = async () => answer('BBCA masih menunggu konfirmasi kedua.');
  const out = await call(stockAsk('Apakah saham ini masih layak dipantau?'));
  assert.equal(out.status, 200);
  assert.equal(out.payload.success, true);
  assert.equal(out.payload.reply, 'BBCA masih menunggu konfirmasi kedua.');
  assert.equal(out.payload.stock_analysis_used, true);
  assert.notEqual(out.payload.model_used, 'local-stock-snapshot-v1');
});

test('a long multiline markdown answer with a table survives intact', async () => {
  const long = [
    '### Ringkasan', 'Baris pertama.', '', '| Ticker | Entry | Stop |', '| --- | --- | --- |',
    '| BBCA | 9000 | 8600 |', '| TLKM | 3000 | 2850 |', '', '- poin satu', '- poin dua',
    'Penutup dengan **tebal** dan angka 9.150.'
  ].join('\n');
  provider.script = async () => answer(long);
  const out = await call(portfolioAsk('Ringkas risiko portofolioku.'));
  assert.equal(out.payload.reply, long);
  assert.ok(out.payload.reply.includes('| BBCA | 9000 | 8600 |'));
});

// ========================== PROVIDER FAILOVER =============================

test('a hung primary model does not end the request: the backup answers', async () => {
  provider.script = async (model, body, index) => (index === 0
    ? { status: 200, hangMs: 30000 }
    : answer('Jawaban dari model cadangan.'));
  const out = await call(portfolioAsk('Posisi mana yang risikonya paling besar?'));
  assert.equal(out.status, 200, 'a timeout on model 1 must not fail the request');
  assert.equal(out.payload.success, true);
  assert.equal(out.payload.reply, 'Jawaban dari model cadangan.');
  assert.equal(out.calls.length, 2);
  assert.notEqual(out.calls[0].model, out.calls[1].model, 'the backup must be a different model');
});

test('a 5xx on the primary model fails over to the backup', async () => {
  provider.script = async (model, body, index) => (index === 0
    ? { status: 502, text: 'bad gateway' }
    : answer('Cadangan menjawab.'));
  const out = await call(portfolioAsk('Bagaimana kondisi portofolio ku?'));
  assert.equal(out.payload.success, true);
  assert.equal(out.payload.reply, 'Cadangan menjawab.');
});

test('a 429 on the primary model fails over to the backup', async () => {
  provider.script = async (model, body, index) => (index === 0
    ? { status: 429, text: 'slow down' }
    : answer('Cadangan menjawab.'));
  const out = await call(portfolioAsk('Bagaimana kondisi portofolio ku?'));
  assert.equal(out.payload.success, true);
  assert.equal(out.payload.reply, 'Cadangan menjawab.');
});

test('an unrelated 400 on the primary model still fails over instead of ending the request', async () => {
  provider.script = async (model, body, index) => (index === 0
    ? { status: 400, text: '{"error":{"message":"this deployment is retired"}}' }
    : answer('Cadangan menjawab.'));
  const out = await call(portfolioAsk('Bagaimana kondisi portofolio ku?'));
  assert.equal(out.status, 200);
  assert.equal(out.payload.reply, 'Cadangan menjawab.');
  assert.equal(out.calls.length, 2);
  assert.notEqual(out.calls[0].model, out.calls[1].model);
});

test('a rejected optional parameter is retried once on the same model without it', async () => {
  provider.script = async (model, body, index) => (index === 0
    ? { status: 400, text: '{"error":{"message":"Unsupported parameter: max_tokens"}}' }
    : answer('Berhasil setelah parameter opsional dilepas.'));
  const out = await call(portfolioAsk('Bagaimana kondisi portofolio ku?'));
  assert.equal(out.payload.success, true);
  assert.equal(out.calls.length, 2);
  assert.equal(out.calls[0].model, out.calls[1].model, 'the compatibility retry stays on the same model');
  assert.ok('max_tokens' in out.calls[0].body, 'the first attempt sends the optional parameters');
  assert.ok(!('max_tokens' in out.calls[1].body), 'the retry drops max_tokens');
  assert.ok(!('temperature' in out.calls[1].body), 'the retry drops temperature');
  assert.deepEqual(out.calls[0].body.messages, out.calls[1].body.messages, 'the question itself is unchanged');
});

test('the compatibility retry happens at most once per request', async () => {
  provider.script = async () => ({ status: 400, text: 'Unsupported parameter: max_tokens' });
  const out = await call(portfolioAsk('Bagaimana kondisi portofolio ku?'));
  assert.equal(out.payload.success, false);
  const perModel = {};
  out.calls.forEach((row) => { perModel[row.model] = (perModel[row.model] || 0) + 1; });
  assert.equal(Object.values(perModel).filter(n => n > 1).length, 1, 'only one model may be retried');
});

test('an empty model response is treated as a failure and fails over', async () => {
  provider.script = async (model, body, index) => (index === 0
    ? { status: 200, json: { choices: [{ message: { content: '   ' } }] } }
    : answer('Cadangan menjawab.'));
  const out = await call(portfolioAsk('Bagaimana kondisi portofolio ku?'));
  assert.equal(out.payload.reply, 'Cadangan menjawab.');
});

test('a malformed (non-JSON) provider body fails over instead of surfacing a parse error', async () => {
  provider.script = async (model, body, index) => (index === 0
    ? { status: 200, text: '<html>502 Bad Gateway</html>' }
    : answer('Cadangan menjawab.'));
  const out = await call(portfolioAsk('Bagaimana kondisi portofolio ku?'));
  assert.equal(out.payload.success, true);
  assert.equal(out.payload.reply, 'Cadangan menjawab.');
});

test('an invalid API key stops immediately rather than burning every model', async () => {
  provider.script = async () => ({ status: 401, text: 'invalid api key' });
  const out = await call(portfolioAsk('Bagaimana kondisi portofolio ku?'));
  assert.equal(out.status, 503);
  assert.equal(out.payload.code, 'AI_KEY_OR_BALANCE_ERROR');
  assert.equal(out.calls.length, 1, 'a credential failure is identical for every model');
});

test('when every model genuinely fails the response says so honestly', async () => {
  provider.script = async () => ({ status: 503, text: 'capacity' });
  const out = await call(portfolioAsk('Bagaimana kondisi portofolio ku?'));
  assert.equal(out.status, 503);
  assert.equal(out.payload.code, 'AI_MODELS_FAILED_SAFE_STOP');
  assert.equal(out.payload.provider_failed, true);
  assert.ok(out.calls.length >= 2, 'at least one backup must have been attempted, got ' + out.calls.length);
  assert.equal(out.payload.attempted_count, out.calls.length);
});

test('when every model times out the response is labelled as a timeout, not a rejection', async () => {
  provider.script = async () => ({ status: 200, hangMs: 30000 });
  const out = await call(portfolioAsk('Bagaimana kondisi portofolio ku?'));
  assert.equal(out.status, 503);
  assert.equal(out.payload.code, 'AI_ALL_MODELS_TIMED_OUT');
  assert.equal(out.payload.timed_out_count, out.payload.attempted_count);
  assert.ok(out.calls.length >= 2, 'a timeout must not stop the failover chain');
});

test('total model time stays inside the configured budget', async () => {
  provider.script = async () => ({ status: 200, hangMs: 30000 });
  const started = Date.now();
  await call(portfolioAsk('Bagaimana kondisi portofolio ku?'));
  const elapsed = Date.now() - started;
  assert.ok(elapsed <= 12000, 'budget overrun: ' + elapsed + 'ms against a 10000ms budget');
});

test('stock analysis falls back to the deterministic snapshot summary only after every model failed', async () => {
  provider.script = async () => ({ status: 503, text: 'capacity' });
  const out = await call(stockAsk('Jelaskan entry, stop loss, target, risiko dan konfirmasinya.'));
  assert.equal(out.status, 200);
  assert.equal(out.payload.local_fallback, true, 'the UI must be able to label this honestly');
  assert.equal(out.payload.model_used, 'local-stock-snapshot-v1');
  assert.ok(out.calls.length >= 2, 'the fallback must come after real failover, not instead of it');
});

// ============================== RETRY =====================================

test('a user retry reaches the provider again once it has recovered', async () => {
  routerV4._test.resetState();
  provider.calls = [];
  provider.script = async () => ({ status: 503, text: 'capacity' });

  const first = makeRes();
  const headers = { host: 'app.autocuan.id', origin: 'https://app.autocuan.id', cookie: 'ac_sess=' + SESSION };
  await handler({ method: 'POST', headers, body: portfolioAsk('Bagaimana kondisi portofolio ku?') }, first.res);
  assert.equal(first.captured.status, 503);

  // Same question, same context: the negative cache used to answer this with a
  // canned 503 and zero provider calls for 30 seconds.
  provider.script = async () => answer('Provider sudah pulih.');
  const callsBefore = provider.calls.length;
  const second = makeRes();
  await handler({
    method: 'POST', headers,
    body: Object.assign(portfolioAsk('Bagaimana kondisi portofolio ku?'), { retry: true })
  }, second.res);

  assert.equal(second.captured.status, 200);
  assert.equal(second.captured.payload.reply, 'Provider sudah pulih.');
  assert.ok(provider.calls.length > callsBefore, 'the retry must actually reach the provider');
});

test('an automatic repeat without the retry flag is still short-circuited to protect tokens', async () => {
  routerV4._test.resetState();
  provider.calls = [];
  provider.script = async () => ({ status: 503, text: 'capacity' });
  const headers = { host: 'app.autocuan.id', origin: 'https://app.autocuan.id', cookie: 'ac_sess=' + SESSION };

  const first = makeRes();
  await handler({ method: 'POST', headers, body: portfolioAsk('Bagaimana kondisi portofolio ku?') }, first.res);
  const callsAfterFirst = provider.calls.length;

  const second = makeRes();
  await handler({ method: 'POST', headers, body: portfolioAsk('Bagaimana kondisi portofolio ku?') }, second.res);
  assert.equal(second.captured.payload.code, 'AI_RECENT_FAILURE');
  assert.equal(provider.calls.length, callsAfterFirst, 'no extra provider spend on an unflagged repeat');
});

// ============================ AUTH / SECURITY =============================

test('an anonymous request is refused before any provider call', async () => {
  provider.script = async () => answer('should never run');
  const out = await call(portfolioAsk('Bagaimana kondisi portofolio ku?'), { noSession: true });
  assert.equal(out.status, 401);
  assert.equal(out.calls.length, 0);
});

test('a forged X-User-Id/X-Username header grants nothing without a signed session', async () => {
  provider.script = async () => answer('should never run');
  const out = await call(portfolioAsk('Bagaimana kondisi portofolio ku?'), {
    noSession: true, headers: { 'x-user-id': 'u-1', 'x-username': 'budi' }
  });
  assert.equal(out.status, 401);
  assert.equal(out.calls.length, 0);
});

test('a body-supplied username or isAdmin flag grants nothing', async () => {
  provider.script = async () => answer('should never run');
  const body = Object.assign(portfolioAsk('Bagaimana kondisi portofolio ku?'), { username: 'budi', isAdmin: true });
  const out = await call(body, { noSession: true });
  assert.equal(out.status, 401);
  assert.equal(out.calls.length, 0);
});

test('a cross-origin request is rejected', async () => {
  provider.script = async () => answer('should never run');
  const out = await call(portfolioAsk('Bagaimana kondisi portofolio ku?'), {
    headers: { origin: 'https://evil.example' }
  });
  assert.equal(out.status, 403);
  assert.equal(out.calls.length, 0);
});

test('a session whose username no longer matches the account is rejected', async () => {
  provider.script = async () => answer('should never run');
  supabaseState.account = { id: 'u-1', username: 'someone-else', is_approved: true, is_blocked: false };
  const out = await call(portfolioAsk('Bagaimana kondisi portofolio ku?'));
  supabaseState.account = { id: 'u-1', username: 'budi', is_approved: true, is_blocked: false };
  assert.equal(out.status, 401);
  assert.equal(out.calls.length, 0);
});

test('a blocked or unapproved account cannot use the assistant', async () => {
  provider.script = async () => answer('should never run');
  supabaseState.account = { id: 'u-1', username: 'budi', is_approved: true, is_blocked: true };
  const blocked = await call(portfolioAsk('Bagaimana kondisi portofolio ku?'));
  supabaseState.account = { id: 'u-1', username: 'budi', is_approved: false, is_blocked: false };
  const unapproved = await call(portfolioAsk('Bagaimana kondisi portofolio ku?'));
  supabaseState.account = { id: 'u-1', username: 'budi', is_approved: true, is_blocked: false };
  assert.equal(blocked.status, 403);
  assert.equal(unapproved.status, 403);
});

test('the per-user rate limit reports how long to wait instead of looking like a provider failure', async () => {
  routerV4._test.resetState();
  provider.script = async () => answer('ok');
  const headers = { host: 'app.autocuan.id', origin: 'https://app.autocuan.id', cookie: 'ac_sess=' + SESSION };
  let limited = null;
  for (let i = 0; i < 20 && !limited; i += 1) {
    const attempt = makeRes();
    await handler({ method: 'POST', headers, body: portfolioAsk('pertanyaan portofolio unik nomor ' + i) }, attempt.res);
    if (attempt.captured.status === 429) limited = attempt.captured.payload;
  }
  assert.ok(limited, 'the limiter must engage within 20 requests');
  assert.equal(limited.code, 'AI_RATE_LIMITED');
  assert.ok(Number(limited.retry_after_seconds) > 0);
  assert.notEqual(limited.provider_failed, true, 'a quota problem is not a provider failure');
});

// ========================= CONTEXT / DATA HONESTY =========================

function systemPromptOf(calls) {
  return calls[0].body.messages[0].content;
}
function contextOf(calls, marker) {
  const prompt = systemPromptOf(calls);
  return JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length).trim());
}

test('the grounded portfolio structures survive all the way to the provider', async () => {
  provider.script = async () => answer('ok');
  const out = await call(portfolioAsk('Kalau ada dana Rp 5 juta, berapa lot BBCA yang sanggup saya beli?'));
  const context = contextOf(out.calls, 'KONTEKS PORTOFOLIO:');
  assert.ok(context.calculation_facts, 'calculation_facts must reach the model');
  assert.ok(context.affordability_facts, 'affordability_facts must reach the model');
  assert.ok(context.ai_answer_policy, 'the answer policy must reach the model');
  assert.equal(context.ai_answer_policy.version, 'AUTO_CUAN_AI_RUNTIME_GROUNDING_V1');
  assert.equal(context.plans.length, 2);
});

test('the model is told which prices are missing, stale, or of unknown age', async () => {
  provider.script = async () => answer('ok');
  const context = {
    plans: [
      { ticker: 'BBCA', entryPriceIdr: 9000, stopLossIdr: 8600, lots: 5 },
      { ticker: 'TLKM', entryPriceIdr: 3000, stopLossIdr: 2850, lots: 10 },
      { ticker: 'ASII', entryPriceIdr: 5000, stopLossIdr: 4800, lots: 2 }
    ],
    prices: { BBCA: 9150, TLKM: 2950 },
    price_meta: {
      BBCA: { at: '2026-08-13T09:00:00Z', age_minutes: 4 },
      TLKM: { at: '2026-08-12T09:00:00Z', age_minutes: 1500 }
    },
    summary: { plan_count: 3 }
  };
  const out = await call(portfolioAsk('Bagaimana kondisi portofolio ku?', context));
  const sent = contextOf(out.calls, 'KONTEKS PORTOFOLIO:');
  const freshness = sent.price_freshness;
  assert.ok(freshness, 'price_freshness must be present');
  assert.deepEqual(freshness.tickers_without_price, ['ASII']);
  assert.deepEqual(freshness.tickers_with_stale_price, ['TLKM']);
  assert.ok(!freshness.tickers_with_stale_price.includes('BBCA'));
  assert.match(freshness.policy, /bukan harga real-time/i);
  assert.match(systemPromptOf(out.calls), /price_freshness/);
});

test('a price with no recorded capture time is reported as unknown age, not as fresh', async () => {
  provider.script = async () => answer('ok');
  const context = {
    plans: [{ ticker: 'BBCA', entryPriceIdr: 9000, lots: 1 }],
    prices: { BBCA: 9150 },
    summary: { plan_count: 1 }
  };
  const out = await call(portfolioAsk('Bagaimana kondisi portofolio ku?', context));
  const freshness = contextOf(out.calls, 'KONTEKS PORTOFOLIO:').price_freshness;
  assert.deepEqual(freshness.tickers_with_unknown_price_age, ['BBCA']);
  assert.deepEqual(freshness.tickers_with_stale_price, []);
});

test('a genuine zero survives as zero while a missing field stays missing', async () => {
  const number = routerV4._test.number;
  assert.equal(number(0), 0);
  assert.equal(number('0'), 0);
  assert.equal(number(0.0), 0);
  assert.equal(number(null), null);
  assert.equal(number(undefined), null);
  assert.equal(number(''), null);
  assert.equal(number('   '), null);
  assert.equal(number(true), null);
  assert.equal(number(false), null);
  assert.equal(number('abc'), null);
  assert.equal(number(NaN), null);
  assert.equal(number(Infinity), null);

  const context = routerV4._test.portfolioContext({
    plans: [{ ticker: 'BBCA', entryPriceIdr: 9000, estimatedMaxLossIdr: 0, stopLossIdr: null, lots: '' }]
  });
  assert.equal(context.plans[0].estimated_max_loss, 0, 'a real zero risk is a reading, not a gap');
  assert.equal(context.plans[0].stop_loss, null, 'a missing stop must not become 0');
  assert.equal(context.plans[0].lots, null, 'an empty lot field must not become 0');
});

test('a portfolio with no positions never reaches the provider and says what is missing', async () => {
  provider.script = async () => answer('should never run');
  const out = await call(portfolioAsk('Bagaimana kondisi portofolio ku?', { plans: [], prices: {}, summary: { plan_count: 0 } }));
  assert.equal(out.status, 200);
  assert.equal(out.payload.model_used, 'local-no-ai');
  assert.equal(out.payload.portfolio_data_used, false);
  assert.equal(out.calls.length, 0);
  assert.match(out.payload.reply, /belum ada posisi/i);
});

test('a twenty-position portfolio is carried without dropping the grounded structures', async () => {
  provider.script = async () => answer('ok');
  const plans = [];
  for (let i = 0; i < 22; i += 1) {
    const ticker = 'AA' + String.fromCharCode(65 + (i % 26)) + String.fromCharCode(65 + ((i * 7) % 26));
    plans.push({ ticker, entryPriceIdr: 1000 + i, stopLossIdr: 900 + i, lots: 1 + i, estimatedMaxLossIdr: 1000 * i });
  }
  const out = await call(portfolioAsk('Apakah alokasi portofolio saya terlalu terkonsentrasi?', { plans, prices: {}, summary: { plan_count: plans.length } }));
  const sent = contextOf(out.calls, 'KONTEKS PORTOFOLIO:');
  assert.ok(sent.plans.length >= 20, 'expected at least 20 positions, got ' + sent.plans.length);
  assert.ok(sent.price_freshness.tickers_without_price.length >= 20);
  assert.ok(sent.calculation_facts, 'grounding must not be dropped on a large portfolio');
});

test('the style contract travels in the system turn, never as a second consecutive user turn', async () => {
  provider.script = async () => answer('ok');
  const out = await call(portfolioAsk('Bagaimana kondisi portofolio ku?'));
  const roles = out.calls[0].body.messages.map(m => m.role);
  for (let i = 1; i < roles.length; i += 1) {
    assert.ok(!(roles[i] === 'user' && roles[i - 1] === 'user'), 'two consecutive user turns: ' + roles.join(','));
  }
  const system = systemPromptOf(out.calls);
  assert.match(system, /Aturan jawaban wajib/, 'the style rules must be in the system turn');
  assert.match(system, /SIMULASI/, 'the style rules must arrive whole, not clipped at 700 chars');
  assert.equal(roles[roles.length - 1], 'user');
  assert.equal(out.calls[0].body.messages[roles.length - 1].content, 'Bagaimana kondisi portofolio ku?');
});

// ===================== STOCK ANALYSIS STATE HONESTY =======================

test('setup state markers are lifted out so truncation can never drop them', async () => {
  const extract = routerV4._test.extractSetupStates;
  assert.deepEqual(extract('Status: READY_PENDING 1/2'), ['READY_PENDING_1/2']);
  assert.deepEqual(extract('Status: READY_CONFIRMED 2/2'), ['READY_CONFIRMED_2/2']);
  assert.ok(extract('label WATCHING pada radar').includes('WATCHING'));
  assert.ok(extract('BLOCKED_CHASE: harga sudah jauh').includes('BLOCKED_CHASE'));
  assert.ok(extract('WAIT PULLBACK dulu').includes('WAIT_PULLBACK'));
  assert.ok(extract('EARLY_RADAR baru muncul').includes('EARLY_RADAR'));
  assert.deepEqual(extract('tidak ada penanda status apa pun'), []);
});

test('an unconfirmed setup reaches the model flagged as unconfirmed', async () => {
  provider.script = async () => answer('ok');
  const out = await call(stockAsk('Apakah ini sudah boleh dibeli?'));
  const sent = contextOf(out.calls, 'SNAPSHOT ANALISIS SAHAM:');
  assert.ok(sent.setup_states.includes('READY_PENDING_1/2'));
  assert.deepEqual(sent.setup_state_policy.unconfirmed_states_present, ['READY_PENDING_1/2']);
  assert.ok(sent.setup_state_policy.rules.some(rule => /READY_PENDING/.test(rule)));
  assert.match(systemPromptOf(out.calls), /setup_state_policy/);
});

test('a watching-only ticker is never presented to the model as a confirmed buy', async () => {
  provider.script = async () => answer('ok');
  const snapshot = ['ANTM — Radar', 'Status: WATCHING', 'Harga terakhir: 1.500', 'Belum ada konfirmasi.'].join('\n');
  const out = await call(stockAsk('Apakah saham ini masih layak dipantau?', { ticker: 'ANTM', analysis_text: snapshot }));
  const sent = contextOf(out.calls, 'SNAPSHOT ANALISIS SAHAM:');
  assert.ok(sent.setup_states.includes('WATCHING'));
  assert.ok(sent.setup_state_policy.unconfirmed_states_present.includes('WATCHING'));
  assert.ok(!sent.setup_states.includes('READY_CONFIRMED'));
});

test('a confirmed setup keeps its confirmed marker and is not downgraded', async () => {
  provider.script = async () => answer('ok');
  const snapshot = ['BBRI — Swing', 'Status: READY_CONFIRMED 2/2', 'Entry: 4.500', 'Stop Loss: 4.300'].join('\n');
  const out = await call(stockAsk('Jelaskan entry, stop loss, target, risiko dan konfirmasinya.', { ticker: 'BBRI', analysis_text: snapshot }));
  const sent = contextOf(out.calls, 'SNAPSHOT ANALISIS SAHAM:');
  assert.ok(sent.setup_states.includes('READY_CONFIRMED_2/2'));
  assert.deepEqual(sent.setup_state_policy.unconfirmed_states_present, []);
});

test('a state line buried in a snapshot long enough to be truncated still reaches the model', async () => {
  provider.script = async () => answer('ok');
  const filler = [];
  for (let i = 0; i < 900; i += 1) filler.push('Catatan teknikal baris ke-' + i + ' dengan konteks tambahan yang panjang.');
  const snapshot = ['GOTO — Setup', 'Harga terakhir: 60']
    .concat(filler.slice(0, 450), ['Status: BLOCKED_CHASE'], filler.slice(450), ['Target 1: 70'])
    .join('\n');
  const out = await call(stockAsk('Masih layak dikejar?', { ticker: 'GOTO', analysis_text: snapshot }));
  const sent = contextOf(out.calls, 'SNAPSHOT ANALISIS SAHAM:');
  assert.equal(sent.truncated, true, 'this fixture must actually exercise truncation');
  assert.ok(!sent.analysis_text.includes('BLOCKED_CHASE'), 'the fixture must place the state inside the dropped region');
  assert.ok(sent.setup_states.includes('BLOCKED_CHASE'), 'the state must survive truncation');
});

test('a stock question without a rendered analysis is refused with an actionable code', async () => {
  provider.script = async () => answer('should never run');
  const out = await call(stockAsk('Apakah ini layak?', { ticker: 'BBCA', analysis_text: '' }));
  assert.equal(out.status, 400);
  assert.equal(out.payload.code, 'AI_STOCK_SNAPSHOT_MISSING');
  assert.equal(out.calls.length, 0);
});

// ============================== BUDGETING =================================

test('attemptSlice never lets the first attempt swallow the whole budget', () => {
  const slice = routerV4._test.attemptSlice;
  assert.equal(slice(40000, 20000, 3), 20000);
  assert.equal(slice(20000, 20000, 3), 10000, 'with backups left, at most half the remainder');
  assert.equal(slice(20000, 20000, 1), 20000, 'the last attempt may use the remainder');
  assert.equal(slice(500, 20000, 3), 0, 'a slice too small to succeed is not attempted');
});

test('at least one backup model is always reachable whatever the configured limit', () => {
  const previous = process.env.PORTFOLIO_AI_HEAVY_MAX_ATTEMPTS;
  process.env.PORTFOLIO_AI_HEAVY_MAX_ATTEMPTS = '1';
  assert.ok(routerV4._test.attemptLimit('portfolio_chat', 'heavy') >= 2);
  process.env.PORTFOLIO_AI_HEAVY_MAX_ATTEMPTS = '99';
  assert.ok(routerV4._test.attemptLimit('portfolio_chat', 'heavy') <= 6);
  if (previous === undefined) delete process.env.PORTFOLIO_AI_HEAVY_MAX_ATTEMPTS;
  else process.env.PORTFOLIO_AI_HEAVY_MAX_ATTEMPTS = previous;
});

test('only credential failures are terminal; every other status keeps the chain alive', () => {
  const { modelRouteFailure, isKeyOrBalanceFailure } = routerV4._test;
  [401, 402, 403].forEach((status) => {
    assert.equal(isKeyOrBalanceFailure(status), true, status + ' must be terminal');
    assert.equal(modelRouteFailure(status), false);
  });
  [400, 404, 408, 409, 422, 425, 429, 500, 502, 503, 504].forEach((status) => {
    assert.equal(modelRouteFailure(status), true, status + ' must keep failing over');
  });
});

test('parameter rejections are recognised only on the statuses that carry them', () => {
  const { isParameterRejection } = routerV4._test;
  assert.equal(isParameterRejection(400, 'Unsupported parameter: max_tokens'), true);
  assert.equal(isParameterRejection(422, 'temperature is not supported for this model'), true);
  assert.equal(isParameterRejection(400, 'use max_completion_tokens instead'), true);
  assert.equal(isParameterRejection(400, 'this deployment is retired'), false);
  assert.equal(isParameterRejection(500, 'Unsupported parameter: max_tokens'), false);
});
