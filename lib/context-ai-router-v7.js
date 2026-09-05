'use strict';

/**
 * Context AI Router V7 (PR 6: Gemini Direct Replacement & Database Cache)
 *
 * Direct Google Gemini API integration with persistence DB caching,
 * admin toggle control, and graceful local deterministic fallback.
 * WeizeRouter is completely bypassed.
 */

const crypto = require('node:crypto');
const { getGeminiApiKey, generateGeminiContent, streamGeminiAnalysis, DEFAULT_GEMINI_MODEL, FALLBACK_GEMINI_MODEL } = require('./ai-gemini-provider');
const { getCachedAnalysis, setCachedAnalysis } = require('./ai-analysis-cache');
const { recordRequest, recordCacheHit, recordGeminiCall, recordLocalFallback } = require('./ai-telemetry');
const { incrementUserUsage } = require('./chart-analysis-service');
const handleContextAIV6 = require('./context-ai-router-v6');
const handleContextAIV4 = require('./context-ai-router-v4');

const SECONDARY_FAILURE_CODES = new Set([
  'AI_PROVIDER_TEMPORARILY_UNAVAILABLE',
  'AI_MODELS_FAILED_SAFE_STOP',
  'AI_ALL_MODELS_TIMED_OUT',
  'AI_RECENT_FAILURE',
  'AI_TIMEOUT_NO_RETRY',
  'AI_REQUEST_ERROR'
]);

const DEFAULT_SECONDARY_ATTEMPTS = 2;
const DEFAULT_SECONDARY_MODEL_TIMEOUT_MS = 6500;
const DEFAULT_SECONDARY_TOTAL_TIMEOUT_MS = 12000;
const HARD_HANDLER_BUDGET_MS = 57000;

function clean(value, max) {
  return String(value == null ? '' : value).replace(/\u0000/g, '').trim().slice(0, max || 12000);
}

function bounded(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

// The primary Gemini path can make up to 3 sequential upstream attempts
// (primary model, fallback model, backup key), each with its own timeout.
// Without a shared cumulative budget, 3 * 25000ms can exceed vercel.json's
// 60s maxDuration for api/analyze.js — the platform then kills the function
// before it ever reaches its own catch/fallback, so the client sees a raw
// timeout/disconnect instead of the graceful local-deterministic reply. This
// mirrors the budget trySecondary() already applies to the legacy spillover
// path, applied here to the primary (production) Gemini attempts too.
const GEMINI_ATTEMPT_TIMEOUT_MS = 25000;
const GEMINI_MIN_VIABLE_TIMEOUT_MS = 5000;

function remainingHandlerBudget(handlerStarted) {
  return Math.max(0, HARD_HANDLER_BUDGET_MS - (Date.now() - handlerStarted));
}

// How long the next Gemini attempt is allowed to run, given what's left of
// the handler's hard budget — or null if there isn't enough time left for a
// worthwhile attempt at all (skip straight to the next fallback instead).
function nextGeminiTimeout(handlerStarted) {
  const remaining = remainingHandlerBudget(handlerStarted);
  if (remaining < GEMINI_MIN_VIABLE_TIMEOUT_MS) return null;
  return Math.min(GEMINI_ATTEMPT_TIMEOUT_MS, remaining);
}

function split(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function dedupe(rows) {
  const seen = new Set();
  return rows.filter((item) => item && !seen.has(item) && seen.add(item));
}

function isPrivateIpv4(hostname) {
  const parts = String(hostname || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (parts[0] === 10 || parts[0] === 127) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return false;
}

function normalizeSecondaryBaseUrl(value) {
  const raw = clean(value, 500).replace(/\/+$/, '');
  if (!raw) return '';
  let url;
  try { url = new URL(raw); }
  catch (_) { return ''; }
  if (url.protocol !== 'https:' || url.username || url.password) return '';
  const host = String(url.hostname || '').toLowerCase();
  if (!host || host === 'localhost' || host === '::1' || host.endsWith('.local') || isPrivateIpv4(host)) return '';
  if (host === 'weizerouter.web.id') return '';
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

function secondaryConfig(env) {
  const source = env || process.env;
  const baseUrl = normalizeSecondaryBaseUrl(source.PORTFOLIO_AI_SECONDARY_BASE_URL);
  const apiKey = clean(source.PORTFOLIO_AI_SECONDARY_API_KEY, 1000);
  const models = dedupe(split(source.PORTFOLIO_AI_SECONDARY_MODELS)).slice(0, 6);
  if (!baseUrl || !apiKey || !models.length) return null;
  return { baseUrl, apiKey, models };
}

// ---------------------------------------------------------------------------
// Cache identity
// ---------------------------------------------------------------------------
// A portfolio_chat answer is computed from the ASKING USER's own holdings —
// tickers, entry prices, lots, capital, estimated max loss, journal (see
// portfolioContext in ./context-ai-router-v4.js). The cache it is stored in is
// shared by everyone: the Supabase table `ai_analysis_cache` plus a
// process-level Map in ./ai-analysis-cache.js. So the key MUST depend on the
// portfolio the answer was derived from. Keyed only on
// analysis_type|ticker|market_date|prompt, two users who ask the same question
// on the same day collide on one entry and the second is served an answer built
// from the first user's portfolio.
//
// Stock-analysis follow-ups are deliberately left on the existing key shape:
// their context is public market data for one ticker on one date, already fully
// described by ticker + market_date + prompt.
const SOURCES_WITH_PRIVATE_CONTEXT = new Set(['portfolio_chat']);

/**
 * Deterministic serialisation: object keys are emitted in sorted order so two
 * equal contexts that merely differ in property order still share one entry.
 * A differing order would only ever cost a cache miss, never a wrong answer,
 * but the miss is free to avoid.
 */
function stableSerialize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return '[' + value.map(stableSerialize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableSerialize(value[k])).join(',') + '}';
}

/**
 * Bounded content digest of everything outside prompt/ticker/date that changes
 * the correct answer. Returns undefined when the source carries no private
 * context, which leaves the existing key shape byte-identical.
 */
function contextFingerprint(source, context, styleRules) {
  if (!SOURCES_WITH_PRIVATE_CONTEXT.has(source)) return undefined;
  let material;
  try {
    material = stableSerialize({ context: context === undefined ? null : context, style: styleRules || '' });
  } catch (_) {
    // A context this function cannot serialise (unexpected depth, an exotic
    // value) must never fall back to a shared key — that is the collision this
    // exists to prevent. A per-request unique tag makes the request behave as an
    // unconditional cache miss: it can read no other user's entry, and the row
    // it writes is readable by nobody and expires with the normal TTL.
    return { ctx: 'unserialisable-' + crypto.randomUUID() };
  }
  return { ctx: crypto.createHash('sha256').update(material).digest('hex') };
}

/**
 * The ONE place cache identity is built, so the read at the top of the handler
 * and the writes at the bottom can never drift apart — a drift would silently
 * disable the cache (write under one key, read under another) or, worse,
 * re-open the collision this closes.
 */
function buildCacheParams(identity, source, context, styleRules) {
  const params = {
    ticker: identity.ticker,
    analysisType: identity.analysisType,
    prompt: identity.prompt,
    marketDate: identity.marketDate
  };
  const extra = contextFingerprint(source, context, styleRules);
  if (extra) params.extra = extra;
  return params;
}

function captureResponse() {
  const state = { statusCode: 200, payload: null, headers: {} };
  const response = {
    status(code) { state.statusCode = Number(code) || 200; return response; },
    json(payload) { state.payload = payload; return response; },
    send(payload) { state.payload = payload; return response; },
    end(payload) { if (payload !== undefined) state.payload = payload; return response; },
    setHeader(name, value) { state.headers[String(name || '').toLowerCase()] = value; return response; },
    getHeader(name) { return state.headers[String(name || '').toLowerCase()]; }
  };
  return { state, response };
}

function forwardCaptured(res, captured) {
  Object.entries(captured.state.headers || {}).forEach(([name, value]) => {
    try { if (res && typeof res.setHeader === 'function') res.setHeader(name, value); }
    catch (_) {}
  });
  const statusCode = captured.state.statusCode || 500;
  if (res && typeof res.status === 'function') res.status(statusCode);
  const payload = captured.state.payload;
  if (res && typeof res.json === 'function' && payload && typeof payload === 'object') return res.json(payload);
  if (res && typeof res.send === 'function') return res.send(payload);
  if (res && typeof res.end === 'function') return res.end(payload);
  return undefined;
}

function shouldTrySecondary(statusCode, payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  if (data.success === true && data.local_fallback === true && data.provider_unavailable === true) return true;
  if (Number(statusCode) < 500) return false;
  return SECONDARY_FAILURE_CODES.has(data.code);
}

function sanitizeHistory(raw) {
  return (Array.isArray(raw) ? raw : []).slice(-4).map((row) => {
    if (!row || !['user', 'assistant'].includes(row.role)) return null;
    const content = clean(row.content, 700);
    return content ? { role: row.role, content } : null;
  }).filter(Boolean);
}

function buildMessages(req) {
  const body = req && req.body && typeof req.body === 'object' ? req.body : {};
  const source = body.source;
  const message = clean(body.chatMessage, 2500);
  const context = source === 'stock_analysis_followup'
    ? handleContextAIV4._test.stockContext(body.context)
    : handleContextAIV4._test.portfolioContext(body.context);
  const styleRules = clean(body.styleRules, 3000);
  const system = handleContextAIV4._test.promptFor(source, context, styleRules);
  return [{ role: 'system', content: system }]
    .concat(sanitizeHistory(body.history), [{ role: 'user', content: message }]);
}

function extractReply(data) {
  if (!data || typeof data !== 'object') return '';
  const choice = data.choices && data.choices[0];
  const message = choice && choice.message;
  if (message && typeof message.content === 'string') return clean(message.content, 10000);
  if (message && Array.isArray(message.content)) {
    return clean(message.content.map((part) => part && (part.text || part.content) || '').join(''), 10000);
  }
  if (message && typeof message.reasoning_content === 'string') return clean(message.reasoning_content, 10000);
  if (choice && typeof choice.text === 'string') return clean(choice.text, 10000);
  if (typeof data.output_text === 'string') return clean(data.output_text, 10000);
  return '';
}

async function callSecondaryModel(config, model, messages, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(config.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + config.apiKey
      },
      body: JSON.stringify({ model, messages }),
      signal: controller.signal
    });
    const raw = await response.text();
    if (!response.ok) return { ok: false, model, status: Number(response.status) || 0, latency: Date.now() - started };
    let data;
    try { data = JSON.parse(raw); }
    catch (_) { return { ok: false, model, status: 502, latency: Date.now() - started }; }
    const reply = extractReply(data);
    return reply
      ? { ok: true, model, reply, status: 200, latency: Date.now() - started }
      : { ok: false, model, status: 502, latency: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      model,
      status: error && error.name === 'AbortError' ? 504 : 502,
      latency: Date.now() - started
    };
  } finally {
    clearTimeout(timer);
  }
}

async function trySecondary(req, originalPayload, handlerStarted) {
  const config = secondaryConfig(process.env);
  if (!config) return null;
  const messages = buildMessages(req);
  const maxAttempts = bounded(process.env.PORTFOLIO_AI_SECONDARY_MAX_ATTEMPTS, DEFAULT_SECONDARY_ATTEMPTS, 1, 3);
  const perModel = bounded(process.env.PORTFOLIO_AI_SECONDARY_MODEL_TIMEOUT_MS, DEFAULT_SECONDARY_MODEL_TIMEOUT_MS, 1500, 9000);
  const configuredTotal = bounded(process.env.PORTFOLIO_AI_SECONDARY_TOTAL_TIMEOUT_MS, DEFAULT_SECONDARY_TOTAL_TIMEOUT_MS, 3000, 15000);
  const hardRemaining = Math.max(0, HARD_HANDLER_BUDGET_MS - (Date.now() - handlerStarted));
  const totalBudget = Math.min(configuredTotal, hardRemaining);
  const started = Date.now();
  let attempts = 0;

  for (const model of config.models.slice(0, maxAttempts)) {
    const remaining = totalBudget - (Date.now() - started);
    if (remaining < 1000) break;
    const result = await callSecondaryModel(config, model, messages, Math.min(perModel, remaining));
    attempts += 1;
    let host = '';
    try { host = new URL(config.baseUrl).hostname; } catch (_) {}
    console.warn('context-ai secondary provider attempt', JSON.stringify({
      provider_host: host || null,
      model,
      status: result.status,
      ok: result.ok,
      latency_ms: result.latency,
      attempt: attempts
    }));
    if (result.ok) {
      const body = req.body || {};
      const primaryAttempts = Number(originalPayload && originalPayload.attempted_count) || 0;
      return {
        success: true,
        reply: result.reply,
        model_used: result.model,
        fallback_count: Math.max(0, primaryAttempts + attempts - 1),
        attempted_count: primaryAttempts + attempts,
        task_type: body.source === 'stock_analysis_followup' ? 'heavy' : 'secondary-failover',
        portfolio_data_used: body.source === 'portfolio_chat',
        stock_analysis_used: body.source === 'stock_analysis_followup',
        secondary_provider: true,
        provider_failover: true,
        primary_provider_failed: true,
        local_fallback: false
      };
    }
    if (result.status === 401 || result.status === 402 || result.status === 403) break;
  }
  return null;
}

function generateLocalDeterministicReply(source, context, message) {
  if (source === 'stock_analysis_followup') {
    const t = (context && context.ticker) || 'Saham';
    const st = (context && context.status) || 'PEMERIKSAAN';
    const raw = (context && (context.analysis_text || context.analysisText)) || '';
    if (raw && raw.length > 50) {
      return `Berdasarkan data snapshot ${t} (Status: ${st}):\n\n` +
        `• Saham ${t} saat ini berada dalam radar setup ${st}.\n` +
        `• Disiplin pada area trading plan yang telah dihitung (Stop Loss & Target Profit).\n` +
        `• Catatan analisis: ${raw.slice(0, 300)}...\n\n` +
        `Pastikan konfirmasi volume dan candle sebelum melakukan eksekusi.`;
    }
    return `Analisis untuk ${t} (${st}): Tetap disiplin dengan batas risiko dan perhatikan konfirmasi pergerakan harga hari ini.`;
  }

  // portfolio_chat
  const plans = (context && context.plans) || [];
  if (!plans.length) {
    return 'Portofolio kamu saat ini masih kosong atau belum ada posisi aktif yang dicatat. ' +
      'Silakan masukkan saham pilihanmu ke jurnal portofolio untuk mulai mendapatkan evaluasi alokasi dan risiko.';
  }

  // `plans` is the DETAILED list, which the client caps (PLAN_DETAIL_LIMIT in
  // public/portfolio-ai-runtime-v2.js). summary.plan_count carries the real
  // position count, so quoting plans.length here understated the portfolio.
  const summary = (context && context.summary) || {};
  const realCount = Number.isFinite(Number(summary.plan_count)) && Number(summary.plan_count) >= plans.length
    ? Number(summary.plan_count)
    : plans.length;
  const listNote = realCount > plans.length ? `, ${plans.length} dirinci` : '';
  const tickerList = plans.map(p => p.ticker || p.symbol).filter(Boolean).slice(0, 5).join(', ');
  return `Evaluasi Portofolio (${realCount} posisi${listNote}: ${tickerList}):\n\n` +
    `• Alokasi dan manajemen risiko berjalan sesuai rencana.\n` +
    `• Jaga porsi cash untuk fleksibilitas jika market mengalami volatilitas.\n` +
    `• Evaluasi berkala level cut loss dan target profit pada setiap posisi aktif.`;
}

function initSSE(res) {
  if (typeof res.setHeader === 'function') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
  }
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }
}

function sendSSEChunk(res, data) {
  if (typeof res.write === 'function') {
    res.write('data: ' + JSON.stringify(data) + '\n\n');
  }
}

function sendSSEDone(res) {
  if (typeof res.write === 'function') {
    res.write('data: [DONE]\n\n');
  }
  if (typeof res.end === 'function') {
    res.end();
  }
}

async function handleContextAIV7(req, res) {
  const handlerStarted = Date.now();
  const body = (req && req.body && typeof req.body === 'object') ? req.body : {};
  const source = body.source;

  if (!['portfolio_chat', 'stock_analysis_followup'].includes(source)) {
    return res.status(400).json({ success: false, error: 'Sumber AI tidak valid.' });
  }

  const message = clean(body.chatMessage, 2500);
  if (!message) {
    return res.status(400).json({ success: false, code: 'AI_EMPTY_QUESTION', error: 'Pertanyaan belum diisi.' });
  }

  const context = source === 'stock_analysis_followup'
    ? handleContextAIV4._test.stockContext(body.context)
    : handleContextAIV4._test.portfolioContext(body.context);

  if (source === 'stock_analysis_followup' && (!context.ticker || !context.analysis_text)) {
    return res.status(400).json({
      success: false,
      code: 'AI_STOCK_SNAPSHOT_MISSING',
      error: 'Jalankan analisis ticker terlebih dahulu sebelum bertanya lanjutan.'
    });
  }

  const ticker = (context && context.ticker) || (body.context && body.context.ticker)
    ? String((context && context.ticker) || (body.context && body.context.ticker)).toUpperCase()
    : null;
  const analysisType = source;
  const marketDate = (context && context.as_of_trade_date) ||
    (context && context.captured_at ? String(context.captured_at).slice(0, 10) : null) ||
    new Date().toISOString().slice(0, 10);

  const isStreaming = Boolean(
    (body && body.stream === true) ||
    (req && req.headers && req.headers.accept === 'text/event-stream')
  );

  recordRequest();

  // Cache identity, built ONCE and reused by every read/write below.
  const styleRules = clean(body.styleRules, 3000);
  const cacheParams = buildCacheParams(
    { ticker, analysisType, prompt: message, marketDate },
    source, context, styleRules
  );

  // 1. Check Database Response Cache
  const cached = await getCachedAnalysis(Object.assign({}, cacheParams));

  if (cached) {
    recordCacheHit();
    if (isStreaming) {
      initSSE(res);
      const reply = cached.reply || cached.text;
      sendSSEChunk(res, { chunk: reply, model: cached.model, source: 'db_cache', cache_hit: true });
      sendSSEDone(res);
      return;
    }
    return res.status(200).json(Object.assign({}, cached, {
      success: true,
      reply: cached.reply || cached.text,
      source: 'db_cache',
      cache_hit: true,
      token_saved: true
    }));
  }

  // 2. Check Admin Toggle & Gemini API Key (supports request-injected key and server key)
  let geminiApiKey = (body && body.apiKey) || (req.body && req.body.apiKey) || getGeminiApiKey();
  if (geminiApiKey && process.env.PORTFOLIO_AI_API_KEY && geminiApiKey === process.env.PORTFOLIO_AI_API_KEY) {
    geminiApiKey = getGeminiApiKey();
  }
  const fallbackApiKey = (body && body.fallbackApiKey) || (req.body && req.body.fallbackApiKey) || null;
  const isGeminiDisabled = process.env.GEMINI_AI_DISABLED === 'true';

  // If configured with an OpenAI-compatible/Weize endpoint
  // via PORTFOLIO_AI_BASE_URL (or in test suites like test/ai-provider-failover),
  // delegate directly to V6 to exercise the multi-model failover contract.
  if (process.env.PORTFOLIO_AI_BASE_URL && process.env.PORTFOLIO_AI_API_KEY && !isGeminiDisabled) {
    recordLocalFallback();
    const handlerStarted = Date.now();
    const captured = captureResponse();
    await handleContextAIV6(req, captured.response);
    const payload = captured.state.payload && typeof captured.state.payload === 'object'
      ? captured.state.payload
      : { success: false, error: clean(captured.state.payload, 300) || 'Asisten AI belum tersedia.' };

    if (!shouldTrySecondary(captured.state.statusCode, payload)) return forwardCaptured(res, captured);

    let recovered = null;
    try { recovered = await trySecondary(req, payload, handlerStarted); }
    catch (error) {
      console.warn('context-ai secondary provider exception', JSON.stringify({ message: clean(error && error.message, 160) || 'unknown' }));
    }
    if (recovered) return res.status(200).json(recovered);
    return forwardCaptured(res, captured);
  }

  // If Gemini API is available and not disabled -> Primary direct Gemini path (PR 6 & PR 8 streaming)
  if (!isGeminiDisabled && geminiApiKey) {
    const systemInstruction = handleContextAIV4._test.promptFor(source, context, styleRules);
    const geminiStart = Date.now();
    const rawPrimary = (process.env.GEMINI_MODEL || '').trim();
    const primaryModel = (rawPrimary && rawPrimary !== 'gemini-3-flash') ? rawPrimary : DEFAULT_GEMINI_MODEL;
    const rawFallback = (process.env.GEMINI_FALLBACK_MODEL || '').trim();
    const fallbackModel = (rawFallback && rawFallback !== 'gemini-3.1-flash-lite') ? rawFallback : FALLBACK_GEMINI_MODEL;

    if (isStreaming) {
      initSSE(res);
      let geminiResult = null;
      let lastErr = null;

      // Attempt 1: Primary key + Primary model (gemini-3-flash)
      let attempt1Timeout = nextGeminiTimeout(handlerStarted);
      if (attempt1Timeout != null) {
        try {
          let accumulated = '';
          geminiResult = await streamGeminiAnalysis({
            prompt: message,
            systemInstruction,
            apiKey: geminiApiKey,
            model: primaryModel,
            timeoutMs: attempt1Timeout,
            onChunk: (chunk) => {
              if (chunk) {
                accumulated += chunk;
                sendSSEChunk(res, { chunk });
              }
            }
          });
          geminiResult.text = geminiResult.text || accumulated;
        } catch (err) {
          lastErr = err;
        }
      } else {
        lastErr = lastErr || new Error('AI_HANDLER_BUDGET_EXHAUSTED');
      }

      // Attempt 2: If primary model failed, try fallback model (gemini-3.1-flash-lite)
      const attempt2Timeout = !geminiResult ? nextGeminiTimeout(handlerStarted) : null;
      if (!geminiResult && fallbackModel && fallbackModel !== primaryModel && attempt2Timeout != null) {
        try {
          console.warn('[ContextAI] Primary model failed, trying fallback model ' + fallbackModel + '...');
          let accumulated = '';
          geminiResult = await streamGeminiAnalysis({
            prompt: message,
            systemInstruction,
            apiKey: geminiApiKey,
            model: fallbackModel,
            timeoutMs: attempt2Timeout,
            onChunk: (chunk) => {
              if (chunk) {
                accumulated += chunk;
                sendSSEChunk(res, { chunk });
              }
            }
          });
          geminiResult.text = geminiResult.text || accumulated;
          lastErr = null;
        } catch (err) {
          lastErr = err;
        }
      }

      // Attempt 3: If still failed and fallbackApiKey exists, try with backup key
      const attempt3Timeout = !geminiResult ? nextGeminiTimeout(handlerStarted) : null;
      if (!geminiResult && fallbackApiKey && fallbackApiKey !== geminiApiKey && attempt3Timeout != null) {
        try {
          console.warn('[ContextAI] Primary key failed, trying backup key...');
          let accumulatedFallback = '';
          geminiResult = await streamGeminiAnalysis({
            prompt: message,
            systemInstruction,
            apiKey: fallbackApiKey,
            model: primaryModel,
            timeoutMs: attempt3Timeout,
            onChunk: (chunk) => {
              if (chunk) {
                accumulatedFallback += chunk;
                sendSSEChunk(res, { chunk });
              }
            }
          });
          geminiResult.text = geminiResult.text || accumulatedFallback;
          lastErr = null;
        } catch (err) {
          lastErr = err;
        }
      }

      // Attempt 4 (Safety Net): Try stable gemini-1.5-flash if all previous failed
      const attempt4Timeout = !geminiResult ? nextGeminiTimeout(handlerStarted) : null;
      if (!geminiResult && attempt4Timeout != null && primaryModel !== 'gemini-1.5-flash' && fallbackModel !== 'gemini-1.5-flash') {
        try {
          console.warn('[ContextAI] Trying stable gemini-1.5-flash fallback...');
          let accumulatedSafe = '';
          geminiResult = await streamGeminiAnalysis({
            prompt: message,
            systemInstruction,
            apiKey: geminiApiKey || fallbackApiKey,
            model: 'gemini-1.5-flash',
            timeoutMs: attempt4Timeout,
            onChunk: (chunk) => {
              if (chunk) {
                accumulatedSafe += chunk;
                sendSSEChunk(res, { chunk });
              }
            }
          });
          geminiResult.text = geminiResult.text || accumulatedSafe;
          lastErr = null;
        } catch (err) {
          lastErr = err;
        }
      }

      if (geminiResult && geminiResult.text) {
        const latencyMs = Date.now() - geminiStart;
        recordGeminiCall(latencyMs);

        const payload = {
          success: true,
          reply: geminiResult.text || '',
          model: geminiResult.model,
          provider: 'gemini_api',
          source: 'gemini_api',
          local_fallback: false
        };

        if (req._aiQuota) {
          try {
            const updatedCount = await incrementUserUsage(req._supabaseDb || null, req._aiQuota.userId, req._aiQuota.wibDate);
            payload.quota = {
              tier: req._aiQuota.tier,
              usedToday: updatedCount,
              maxDaily: req._aiQuota.quota.maxDaily,
              remaining: req._aiQuota.quota.maxDaily === Infinity ? Infinity : Math.max(0, req._aiQuota.quota.maxDaily - updatedCount)
            };
          } catch (_) {}
        }

        await setCachedAnalysis(Object.assign({}, cacheParams, {
          payloadResponse: payload,
          ttlSeconds: 4 * 3600
        }));

        sendSSEDone(res);
        return;
      } else {
        recordLocalFallback();
        if (lastErr && (lastErr.status === 400 || lastErr.status === 403 || lastErr.code === 'GEMINI_KEY_REJECTED')) {
          sendSSEChunk(res, {
            error: 'Google Gemini menolak API key Anda. Periksa kembali apakah API key valid dan memiliki kuota di Google AI Studio.',
            code: 'AI_KEY_INVALID',
            success: false
          });
          sendSSEDone(res);
          return;
        }
        if (lastErr && (lastErr.status === 429 || lastErr.code === 'GEMINI_RATE_LIMITED')) {
          sendSSEChunk(res, {
            error: 'Layanan AI sedang ramai (Rate Limit). Tunggu sebentar lalu coba lagi.',
            code: 'AI_RATE_LIMITED',
            success: false
          });
          sendSSEDone(res);
          return;
        }

        const fallbackReply = generateLocalDeterministicReply(source, context, message);
        sendSSEChunk(res, {
          chunk: fallbackReply,
          model: 'local-deterministic',
          provider: 'local_fallback',
          source: 'local_fallback',
          local_fallback: true,
          error_degraded: true
        });
        sendSSEDone(res);
        return;
      }
    }

    // Non-streaming direct Gemini path
    try {
      let geminiResult = null;
      let lastErr = null;

      const attempt1Timeout = nextGeminiTimeout(handlerStarted);
      if (attempt1Timeout != null) {
        try {
          geminiResult = await generateGeminiContent({
            prompt: message,
            systemInstruction,
            apiKey: geminiApiKey,
            model: primaryModel,
            timeoutMs: attempt1Timeout
          });
        } catch (err) {
          lastErr = err;
        }
      } else {
        lastErr = lastErr || new Error('AI_HANDLER_BUDGET_EXHAUSTED');
      }

      const attempt2Timeout = !geminiResult ? nextGeminiTimeout(handlerStarted) : null;
      if (!geminiResult && fallbackModel && fallbackModel !== primaryModel && attempt2Timeout != null) {
        try {
          geminiResult = await generateGeminiContent({
            prompt: message,
            systemInstruction,
            apiKey: geminiApiKey,
            model: fallbackModel,
            timeoutMs: attempt2Timeout
          });
          lastErr = null;
        } catch (err) {
          lastErr = err;
        }
      }

      const attempt3Timeout = !geminiResult ? nextGeminiTimeout(handlerStarted) : null;
      if (!geminiResult && fallbackApiKey && fallbackApiKey !== geminiApiKey && attempt3Timeout != null) {
        try {
          geminiResult = await generateGeminiContent({
            prompt: message,
            systemInstruction,
            apiKey: fallbackApiKey,
            model: primaryModel,
            timeoutMs: attempt3Timeout
          });
          lastErr = null;
        } catch (err) {
          lastErr = err;
        }
      }

      // Attempt 4 (Safety Net): Try stable gemini-1.5-flash if all previous failed
      const attempt4Timeout = !geminiResult ? nextGeminiTimeout(handlerStarted) : null;
      if (!geminiResult && attempt4Timeout != null && primaryModel !== 'gemini-1.5-flash' && fallbackModel !== 'gemini-1.5-flash') {
        try {
          console.warn('[ContextAI] Trying stable gemini-1.5-flash non-streaming fallback...');
          geminiResult = await generateGeminiContent({
            prompt: message,
            systemInstruction,
            apiKey: geminiApiKey || fallbackApiKey,
            model: 'gemini-1.5-flash',
            timeoutMs: attempt4Timeout
          });
          lastErr = null;
        } catch (err) {
          lastErr = err;
        }
      }

      if (!geminiResult || !geminiResult.text) {
        throw (lastErr || new Error('GEMINI_EMPTY_RESPONSE'));
      }

      const latencyMs = Date.now() - geminiStart;
      recordGeminiCall(latencyMs);

      const payload = {
        success: true,
        reply: geminiResult.text,
        model: geminiResult.model,
        provider: 'gemini_api',
        source: 'gemini_api',
        local_fallback: false
      };

      if (req._aiQuota) {
        try {
          const updatedCount = await incrementUserUsage(req._supabaseDb || null, req._aiQuota.userId, req._aiQuota.wibDate);
          payload.quota = {
            tier: req._aiQuota.tier,
            usedToday: updatedCount,
            maxDaily: req._aiQuota.quota.maxDaily,
            remaining: req._aiQuota.quota.maxDaily === Infinity ? Infinity : Math.max(0, req._aiQuota.quota.maxDaily - updatedCount)
          };
        } catch (_) {}
      }

      await setCachedAnalysis(Object.assign({}, cacheParams, {
        payloadResponse: payload,
        ttlSeconds: 4 * 3600
      }));

      return res.status(200).json(payload);
    } catch (err) {
      recordLocalFallback();
      if (err.status === 400 || err.status === 403 || err.code === 'GEMINI_KEY_REJECTED') {
        return res.status(403).json({
          success: false,
          code: 'AI_KEY_INVALID',
          error: 'Google Gemini menolak API key Anda. Periksa kembali apakah API key valid dan memiliki kuota di Google AI Studio.'
        });
      }
      if (err.status === 429 || err.code === 'GEMINI_RATE_LIMITED') {
        return res.status(429).json({
          success: false,
          code: 'AI_RATE_LIMITED',
          error: 'Layanan AI sedang ramai (Rate Limit). Tunggu sebentar lalu coba lagi.'
        });
      }

      console.warn('Gemini API call failed, degrading to local deterministic reply:', err.message || err.code);
      const fallbackReply = generateLocalDeterministicReply(source, context, message);
      return res.status(200).json({
        success: true,
        reply: fallbackReply,
        model: 'local-deterministic',
        provider: 'local_fallback',
        source: 'local_fallback',
        local_fallback: true,
        error_degraded: true
      });
    }
  }

  // If PORTFOLIO_AI_API_KEY is configured (legacy test harness / fallback ONLY when no Gemini key is available)
  if (process.env.PORTFOLIO_AI_API_KEY && !isGeminiDisabled) {
    recordLocalFallback();
    const handlerStarted = Date.now();
    const captured = captureResponse();
    await handleContextAIV6(req, captured.response);
    const payload = captured.state.payload && typeof captured.state.payload === 'object'
      ? captured.state.payload
      : { success: false, error: clean(captured.state.payload, 300) || 'Asisten AI belum tersedia.' };

    if (!shouldTrySecondary(captured.state.statusCode, payload)) return forwardCaptured(res, captured);

    let recovered = null;
    try { recovered = await trySecondary(req, payload, handlerStarted); }
    catch (error) {
      console.warn('context-ai secondary provider exception', JSON.stringify({ message: clean(error && error.message, 160) || 'unknown' }));
    }
    if (recovered) return res.status(200).json(recovered);
    return forwardCaptured(res, captured);
  }

  // Otherwise, graceful local deterministic fallback for test harnesses
  recordLocalFallback();
  const fallbackReply = generateLocalDeterministicReply(source, context, message);
  if (isStreaming) {
    initSSE(res);
    sendSSEChunk(res, {
      chunk: fallbackReply,
      model: 'local-deterministic',
      provider: 'local_fallback',
      source: 'local_fallback',
      local_fallback: true
    });
    sendSSEDone(res);
    return;
  }
  return res.status(200).json({
    success: true,
    reply: fallbackReply,
    model: 'local-deterministic',
    provider: 'local_fallback',
    source: 'local_fallback',
    local_fallback: true
  });
}

handleContextAIV7._test = {
  stableSerialize,
  contextFingerprint,
  buildCacheParams,
  SOURCES_WITH_PRIVATE_CONTEXT,
  isPrivateIpv4,
  normalizeSecondaryBaseUrl,
  secondaryConfig,
  shouldTrySecondary,
  sanitizeHistory,
  buildMessages,
  extractReply,
  generateLocalDeterministicReply,
  initSSE,
  sendSSEChunk,
  sendSSEDone,
  SECONDARY_FAILURE_CODES,
  HARD_HANDLER_BUDGET_MS,
  GEMINI_ATTEMPT_TIMEOUT_MS,
  GEMINI_MIN_VIABLE_TIMEOUT_MS,
  remainingHandlerBudget,
  nextGeminiTimeout
};

module.exports = handleContextAIV7;
