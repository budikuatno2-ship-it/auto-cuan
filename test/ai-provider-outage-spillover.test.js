'use strict';

// Regression coverage for the production outage observed on 2026-08-14:
// WeizeRouter returned HTTP 400 + wz_model_temporarily_unavailable for the first
// three otherwise-valid routes. The normal bounded failover then stopped even
// though additional vendor-diverse routes were available. These tests exercise
// the real /api/analyze handler with scripted Supabase + Weize responses.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const supabasePath = require.resolve('@supabase/supabase-js');
const account = { id: 'u-outage', username: 'budi', is_approved: true, is_blocked: false };
function stubQuery(table) {
  const q = {
    select() { return q; },
    eq() { return q; },
    order() { return q; },
    limit() { return q; },
    async maybeSingle() {
      if (table === 'app_users') return { data: account, error: null };
      if (table === 'ai_context_snapshots') return { data: null, error: null };
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

process.env.SESSION_SECRET = 'ai-outage-spillover-test-secret';
process.env.SUPABASE_URL = 'https://stub.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-service-role';
process.env.PORTFOLIO_AI_API_KEY = 'stub-weize-key';
process.env.PORTFOLIO_AI_BASE_URL = 'https://weizerouter.web.id/v1';
process.env.PORTFOLIO_AI_MODEL_TIMEOUT_MS = '1000';
process.env.PORTFOLIO_AI_TOTAL_TIMEOUT_MS = '10000';
process.env.PORTFOLIO_AI_OUTAGE_MODEL_TIMEOUT_MS = '1500';
process.env.PORTFOLIO_AI_OUTAGE_TOTAL_TIMEOUT_MS = '5000';
process.env.PORTFOLIO_AI_OUTAGE_SPILLOVER_ATTEMPTS = '3';
delete process.env.PORTFOLIO_AI_MAX_ATTEMPTS;

const { createSessionToken } = require(path.join(ROOT, 'lib/admin-session.js'));
const routerV4 = require(path.join(ROOT, 'lib/context-ai-router-v4.js'));
const routerV5 = require(path.join(ROOT, 'lib/context-ai-router-v5.js'));
const handler = require(path.join(ROOT, 'api/analyze.js'));

const SESSION = createSessionToken({ userId: account.id, username: account.username, isAdmin: false });

const provider = {
  calls: [],
  script: null,
  directory: [
    'wz/gemini-2.5-flash',
    'wz/claude-sonnet-4.6',
    'wz/gpt-5.6-luna',
    'wz/deepseek-v4-pro',
    'wz/claude-fable-5',
    'wz/gpt-5.6-terra',
    'wz/gpt-5.6-sol'
  ]
};

function makeTextResponse(status, text) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return text; },
    clone() {
      return { async text() { return text; } };
    }
  };
}

const providerFetch = async function (url, options) {
  const target = String(url);
  if (target.endsWith('/models')) {
    return {
      ok: true,
      status: 200,
      async json() { return { data: provider.directory.map((id) => ({ id })) }; }
    };
  }
  const body = JSON.parse(options.body);
  const index = provider.calls.length;
  const outcome = await provider.script(body.model, body, index);
  provider.calls.push({ model: body.model, body, status: outcome.status });
  const text = outcome.text != null ? outcome.text : JSON.stringify(outcome.json);
  return makeTextResponse(outcome.status, text);
};

globalThis.fetch = providerFetch;
routerV5._weizeCompat.installWeizeCompatibilityFetch(globalThis);

const answer = (content) => ({ status: 200, json: { choices: [{ message: { content } }] } });
const outage = () => ({
  status: 400,
  json: {
    error: {
      code: 'wz_model_temporarily_unavailable',
      type: 'model_unavailable',
      message: 'Model WeizeRouter sedang mengalami gangguan sementara. Token tetap aman untuk request yang gagal.'
    }
  }
});

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

async function call(body) {
  routerV4._test.resetState();
  provider.calls = [];
  const { captured, res } = makeRes();
  const req = {
    method: 'POST',
    headers: {
      host: 'app.autocuan.id',
      origin: 'https://app.autocuan.id',
      cookie: 'ac_sess=' + SESSION
    },
    body
  };
  await handler(req, res);
  return { status: captured.status, payload: captured.payload || {}, calls: provider.calls.slice() };
}

const PORTFOLIO = {
  plans: [
    { ticker: 'BBCA', entryPriceIdr: 9000, stopLossIdr: 8600, tp1Idr: 9800, lots: 5, estimatedMaxLossIdr: 200000, capitalIdr: 4500000 }
  ],
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

function portfolioAsk() {
  return { source: 'portfolio_chat', chatMessage: 'Analisis risiko portofolio saya.', context: PORTFOLIO, history: [] };
}

function stockAsk() {
  return {
    source: 'stock_analysis_followup',
    chatMessage: 'Apakah setup ini masih layak dipantau?',
    context: { ticker: 'BBCA', analysis_text: STOCK_SNAPSHOT, captured_at: '2026-08-14T23:30:00+07:00' },
    history: []
  };
}

function firstThreeOutThenRecover(reply) {
  return async (model, body, index) => index < 3 ? outage() : answer(reply);
}

test('portfolio: three explicit Weize model outages spill over to a fourth route', async () => {
  provider.script = firstThreeOutThenRecover('Jawaban dari jalur darurat keempat.');
  const out = await call(portfolioAsk());

  assert.equal(out.status, 200);
  assert.equal(out.payload.success, true);
  assert.equal(out.payload.reply, 'Jawaban dari jalur darurat keempat.');
  assert.equal(out.payload.emergency_failover, true);
  assert.equal(out.payload.provider_outage_recovered, true);
  assert.equal(out.payload.primary_outage_attempts, 3);
  assert.equal(out.payload.attempted_count, 4);
  assert.equal(out.calls.length, 4);
  assert.deepEqual(out.calls.slice(0, 3).map((row) => row.model), [
    'wz/gemini-2.5-flash',
    'wz/claude-sonnet-4.6',
    'wz/gpt-5.6-luna'
  ]);
  assert.equal(out.calls[3].model, 'wz/deepseek-v4-pro');
  assert.equal(out.payload.model_used, 'wz/deepseek-v4-pro');
});

test('stock analysis: the same outage spillover runs before deterministic local fallback', async () => {
  provider.script = firstThreeOutThenRecover('BBCA masih layak dipantau, tetapi belum terkonfirmasi.');
  const out = await call(stockAsk());

  assert.equal(out.status, 200);
  assert.equal(out.payload.success, true);
  assert.equal(out.payload.local_fallback, undefined);
  assert.equal(out.payload.emergency_failover, true);
  assert.equal(out.payload.stock_analysis_used, true);
  assert.equal(out.payload.model_used, 'wz/deepseek-v4-pro');
  assert.equal(out.calls.length, 4);
});

test('generic HTTP 400 failures do not unlock extra outage attempts', async () => {
  provider.script = async () => ({ status: 400, json: { error: { message: 'invalid request shape' } } });
  const out = await call(portfolioAsk());

  assert.equal(out.status, 503);
  assert.equal(out.payload.code, 'AI_MODELS_FAILED_SAFE_STOP');
  assert.equal(out.payload.emergency_failover, undefined);
  assert.equal(out.calls.length, 3, 'only explicit temporary-unavailable outages may exceed the normal attempt cap');
});

test('an explicit global max-attempt cap still disables emergency spillover', async () => {
  process.env.PORTFOLIO_AI_MAX_ATTEMPTS = '3';
  try {
    provider.script = firstThreeOutThenRecover('should not be reached');
    const out = await call(portfolioAsk());
    assert.equal(out.status, 503);
    assert.equal(out.payload.code, 'AI_MODELS_FAILED_SAFE_STOP');
    assert.equal(out.calls.length, 3);
  } finally {
    delete process.env.PORTFOLIO_AI_MAX_ATTEMPTS;
  }
});
