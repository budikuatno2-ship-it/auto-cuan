'use strict';

const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { requireAuthenticatedSession } = require('./admin-session');

// Reorder configured model pools once per serverless instance.
// The provider exposes a validated /models directory, but that probe can fail
// transiently. In that case stale Vercel env model lists used to stay in front
// of the known-good defaults and could consume the whole bounded attempt budget
// before a healthy route was ever tried. Keep a small, vendor-diverse set of
// recently validated routes at the front while preserving configured extras as
// fallback candidates.

const VERIFIED_BALANCED = Object.freeze([
  'wz/gemini-2.5-flash',
  'wz/claude-sonnet-4.6',
  'wz/gpt-5.6-luna',
  'wz/deepseek-v4-pro',
  'wz/claude-fable-5',
  'wz/gpt-5.6-terra',
  'wz/gpt-5.6-sol'
]);

const VERIFIED_FAST = Object.freeze([
  'wz/gemini-2.5-flash',
  'wz/claude-haiku-4.5',
  'wz/gpt-5.4-mini',
  'wz/gpt-5.6-luna',
  'wz/claude-sonnet-4.6'
]);

const VERIFIED_EMPATHY = Object.freeze([
  'wz/claude-sonnet-4.6',
  'wz/gemini-2.5-flash',
  'wz/claude-fable-5',
  'wz/gpt-5.6-luna',
  'wz/claude-haiku-4.5'
]);

// Emergency candidates intentionally start with routes that are NOT already
// clustered directly behind the three balanced primaries. Production showed
// that DeepSeek/Fable/Terra could share the same temporary outage at the same
// moment as Gemini 2.5/Sonnet/Luna, while newer/lighter aliases never got a turn
// because the old emergency cap stopped after three attempts.
const OUTAGE_FALLBACK_EXTRAS = Object.freeze([
  'wz/gemini-3.5-flash-low',
  'wz/gpt-5.6-sol',
  'wz/gpt-5.4-mini',
  'wz/claude-haiku-4.5',
  'wz/deepseek-v4-pro',
  'wz/claude-fable-5',
  'wz/gpt-5.6-terra'
]);

const DEFAULT_OUTAGE_SPILLOVER_ATTEMPTS = 6;
const DEFAULT_OUTAGE_MODEL_TIMEOUT_MS = 4500;
const DEFAULT_OUTAGE_TOTAL_TIMEOUT_MS = 12000;
const OUTAGE_HARD_HANDLER_BUDGET_MS = 52000;
const providerTraceStorage = new AsyncLocalStorage();

function clean(value, max) {
  return String(value == null ? '' : value).replace(/\u0000/g, '').trim().slice(0, max);
}

function bounded(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function split(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function dedupe(rows) {
  const seen = new Set();
  return rows.filter((item) => item && !seen.has(item) && seen.add(item));
}

function prioritize(name, preferred) {
  const configured = split(process.env[name]);
  // Always put the validated routes first. Existing env configuration is kept
  // afterwards so an operator's custom route is still available as a fallback.
  process.env[name] = dedupe(preferred.concat(configured)).join(',');
}

// WeizeRouter documents the OpenAI-compatible chat contract with only `model`
// and `messages`. Different upstream model families behind the gateway do not
// all accept the same optional generation controls. The router already had a
// compatibility retry, but that depended on the upstream error body explicitly
// naming `temperature` or `max_tokens`; a generic 400 could therefore burn all
// bounded attempts even while the model directory itself was healthy.
//
// Normalize only requests to the exact WeizeRouter chat endpoint. Other fetches
// (including /models, Supabase, and scripted regression providers) are untouched.
// This keeps the provider request on its documented common denominator and lets
// the model pool/failover code decide reliability rather than optional params.
const WEIZE_COMPAT_MARK = '__autoCuanWeizeMinimalChatV1';

function requestUrl(input) {
  const value = typeof input === 'string' ? input : (input && input.url);
  if (!value) return null;
  try { return new URL(value); }
  catch (_) { return null; }
}

function isWeizeChatUrl(input) {
  const url = requestUrl(input);
  return Boolean(url && url.protocol === 'https:' && url.hostname === 'weizerouter.web.id' && /\/v1\/chat\/completions\/?$/.test(url.pathname));
}

function chatEndpointMeta(input) {
  const url = requestUrl(input);
  if (!url || !/^https?:$/.test(url.protocol) || !/\/chat\/completions\/?$/.test(url.pathname)) return null;
  return { provider_host: url.hostname, provider_path: url.pathname };
}

function redactDiagnostic(value) {
  return String(value == null ? '' : value)
    .replace(/Bearer\s+[A-Za-z0-9._~+\/=\-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:wz|sk(?:-[A-Za-z0-9]+)*)-[A-Za-z0-9._\-]{8,}\b/g, '[REDACTED_KEY]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_TOKEN]')
    .replace(/([?&](?:key|api_key|token|access_token)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function diagnosticReason(raw) {
  const text = String(raw == null ? '' : raw);
  if (!text) return '';
  try {
    const data = JSON.parse(text);
    const error = data && typeof data.error === 'object' ? data.error : null;
    const parts = [
      error && error.code,
      error && error.type,
      error && error.message,
      data && data.code,
      data && data.message,
      data && data.detail
    ].filter((value) => typeof value === 'string' || typeof value === 'number');
    if (parts.length) return redactDiagnostic(parts.join(' | '));
    return 'structured_error_without_safe_message';
  } catch (_) {
    return redactDiagnostic(text.slice(0, 300));
  }
}

function isTemporaryModelUnavailable(value) {
  return /\bwz_model_temporarily_unavailable\b/i.test(String(value || ''));
}

function modelFromInit(init) {
  if (!init || typeof init.body !== 'string') return '';
  try {
    const payload = JSON.parse(init.body);
    return String(payload && payload.model || '').trim().slice(0, 120);
  } catch (_) {
    return '';
  }
}

function minimalWeizeInit(input, init) {
  if (!isWeizeChatUrl(input) || !init || typeof init.body !== 'string') return init;
  try {
    const payload = JSON.parse(init.body);
    if (!payload || typeof payload !== 'object' || !String(payload.model || '').startsWith('wz/')) return init;
    const nextPayload = Object.assign({}, payload);
    delete nextPayload.temperature;
    delete nextPayload.max_tokens;
    delete nextPayload.max_completion_tokens;
    delete nextPayload.top_p;
    return Object.assign({}, init, { body: JSON.stringify(nextPayload) });
  } catch (_) {
    return init;
  }
}

async function providerRejectionMeta(input, init, response) {
  if (!response || response.ok) return null;
  const meta = chatEndpointMeta(input);
  if (!meta) return null;
  let raw = '';
  try { raw = await response.clone().text(); }
  catch (_) { raw = ''; }
  const reason = diagnosticReason(raw) || null;
  return {
    provider_host: meta.provider_host,
    provider_path: meta.provider_path,
    model: modelFromInit(init) || null,
    status: Number(response.status) || 0,
    reason,
    temporary_unavailable: isTemporaryModelUnavailable(reason)
  };
}

async function logProviderRejection(input, init, response) {
  const row = await providerRejectionMeta(input, init, response);
  if (!row) return null;
  const trace = providerTraceStorage.getStore();
  if (trace && Array.isArray(trace.rejections)) trace.rejections.push(row);
  console.warn('context-ai provider rejection', JSON.stringify(row));
  return row;
}

function installWeizeCompatibilityFetch(target) {
  const root = target || globalThis;
  if (!root || typeof root.fetch !== 'function') return false;
  if (root.fetch[WEIZE_COMPAT_MARK]) return true;
  const baseFetch = root.fetch;
  async function compatibleFetch(input, init) {
    const nextInit = minimalWeizeInit(input, init);
    const response = await baseFetch.call(this, input, nextInit);
    try { await logProviderRejection(input, nextInit, response); }
    catch (_) { /* Diagnostics must never alter provider behavior. */ }
    return response;
  }
  compatibleFetch[WEIZE_COMPAT_MARK] = true;
  compatibleFetch.__baseFetch = baseFetch;
  root.fetch = compatibleFetch;
  return true;
}

function captureResponse() {
  const state = { statusCode: 200, payload: null, ended: false, headers: {} };
  const response = {
    status(code) { state.statusCode = Number(code) || 200; return response; },
    json(payload) { state.payload = payload; state.ended = true; return response; },
    send(payload) { state.payload = payload; state.ended = true; return response; },
    end(payload) { if (payload !== undefined) state.payload = payload; state.ended = true; return response; },
    setHeader(name, value) { state.headers[String(name || '').toLowerCase()] = value; return response; },
    getHeader(name) { return state.headers[String(name || '').toLowerCase()]; }
  };
  return { state, response };
}

function forwardCaptured(res, captured) {
  Object.entries(captured.state.headers || {}).forEach(([name, value]) => {
    try { if (res && typeof res.setHeader === 'function') res.setHeader(name, value); }
    catch (_) { /* Preserve response even if a test double rejects a header. */ }
  });
  const statusCode = captured.state.statusCode || 500;
  if (res && typeof res.status === 'function') res.status(statusCode);
  if (res && typeof res.json === 'function' && captured.state.payload && typeof captured.state.payload === 'object') return res.json(captured.state.payload);
  if (res && typeof res.send === 'function') return res.send(captured.state.payload);
  if (res && typeof res.end === 'function') return res.end(captured.state.payload);
  return undefined;
}

function allPrimaryFailuresAreTemporary(payload, trace) {
  if (!payload || payload.code !== 'AI_MODELS_FAILED_SAFE_STOP') return false;
  const attempted = Array.isArray(payload.attempted_models) ? payload.attempted_models.filter(Boolean) : [];
  if (attempted.length < 2) return false;
  const rows = trace && Array.isArray(trace.rejections) ? trace.rejections : [];
  return attempted.every((model) => {
    const matches = rows.filter((row) => row && row.model === model && row.provider_host === 'weizerouter.web.id');
    return matches.length > 0 && matches.every((row) => row.temporary_unavailable === true);
  });
}

function classify(message, context) {
  const text = String(message || '').toLowerCase();
  if (/cemas|takut|panik|stres|sedih|menyesal|curhat|khawatir|gelisah/.test(text)) return 'empathy';
  if (/analisis|evaluasi|bandingkan|skenario|simulasi|alokasi|diversifikasi|risiko|average down|cut loss|stop loss|prioritas|strategi/.test(text) || (context.plans && context.plans.length)) return 'heavy';
  return 'fast';
}

function sanitizeHistory(raw) {
  return (Array.isArray(raw) ? raw : []).slice(-4).map((row) => {
    if (!row || !['user', 'assistant'].includes(row.role)) return null;
    const content = clean(row.content, 700);
    return content ? { role: row.role, content } : null;
  }).filter(Boolean);
}

function cacheKeyContext(context) {
  const input = context && typeof context === 'object' ? context : {};
  const stable = {};
  Object.keys(input).forEach((key) => {
    if (key === 'captured_at' || key === 'price_meta') return;
    if (key === 'price_freshness') {
      const freshness = input[key] && typeof input[key] === 'object' ? input[key] : {};
      stable.price_freshness = {
        without_price: freshness.tickers_without_price || [],
        stale: freshness.tickers_with_stale_price || [],
        unknown_age: freshness.tickers_with_unknown_price_age || []
      };
      return;
    }
    stable[key] = input[key];
  });
  return stable;
}

function requestKey(userId, source, task, message, context, historyRows) {
  return crypto.createHash('sha256').update(JSON.stringify({
    userId, source, task, message: message.toLowerCase(), context: cacheKeyContext(context), historyRows
  })).digest('hex');
}

function emergencyContext(req, handleContextAIV4) {
  const body = req && req.body && typeof req.body === 'object' ? req.body : {};
  const source = body.source;
  const message = clean(body.chatMessage, 2500);
  const context = source === 'stock_analysis_followup'
    ? handleContextAIV4._test.stockContext(body.context)
    : handleContextAIV4._test.portfolioContext(body.context);
  const task = source === 'stock_analysis_followup' ? 'heavy' : classify(message, context);
  const historyRows = sanitizeHistory(body.history);
  const styleRules = clean(body.styleRules, 3000);
  const messages = [{ role: 'system', content: handleContextAIV4._test.promptFor(source, context, styleRules) }]
    .concat(historyRows, [{ role: 'user', content: message }]);
  return { source, message, context, task, historyRows, messages };
}

function outageCandidatePool(source, task, attemptedModels) {
  let preferred;
  if (source === 'stock_analysis_followup' || task === 'heavy') preferred = VERIFIED_BALANCED;
  else if (task === 'empathy') preferred = VERIFIED_EMPATHY;
  else preferred = VERIFIED_FAST;
  const attempted = new Set(attemptedModels || []);
  // Emergency-only aliases go first. The task-specific normal pool is still
  // retained afterwards, but it can no longer consume every emergency slot.
  return dedupe(OUTAGE_FALLBACK_EXTRAS.concat(preferred, VERIFIED_BALANCED, VERIFIED_FAST, VERIFIED_EMPATHY))
    .filter((model) => model && !attempted.has(model));
}

function globalAttemptCap() {
  const raw = Number.parseInt(process.env.PORTFOLIO_AI_MAX_ATTEMPTS, 10);
  return Number.isFinite(raw) ? Math.max(2, Math.min(48, raw)) : Number.POSITIVE_INFINITY;
}

function extractReply(data) {
  if (!data || typeof data !== 'object') return '';
  const choice = data.choices && data.choices[0];
  const message = choice && choice.message;
  if (message && typeof message.content === 'string') return message.content.trim();
  if (message && Array.isArray(message.content)) return message.content.map((p) => p && (p.text || p.content) || '').join('').trim();
  if (message && typeof message.reasoning_content === 'string') return message.reasoning_content.trim();
  if (choice && typeof choice.text === 'string') return choice.text.trim();
  if (typeof data.output_text === 'string') return data.output_text.trim();
  return '';
}

async function callEmergencyModel(baseUrl, apiKey, model, messages, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ model, messages }),
      signal: controller.signal
    });
    const raw = await response.text();
    if (!response.ok) return { ok: false, model, status: response.status, latency: Date.now() - started };
    let data;
    try { data = JSON.parse(raw); }
    catch (_) { return { ok: false, model, status: 502, latency: Date.now() - started }; }
    const reply = clean(extractReply(data), 10000);
    return reply
      ? { ok: true, model, status: 200, reply, latency: Date.now() - started }
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

function rememberEmergencySuccess(handleContextAIV4, req, prepared, result, payload, totalAttempts) {
  const auth = requireAuthenticatedSession(req);
  const userId = auth && auth.ok && auth.session ? String(auth.session.uid || '') : '';
  const successPayload = {
    success: true,
    reply: result.reply,
    model_used: result.model,
    fallback_count: Math.max(0, totalAttempts - 1),
    attempted_count: totalAttempts,
    task_type: prepared.task,
    portfolio_data_used: prepared.source === 'portfolio_chat' && prepared.context.plans && prepared.context.plans.length > 0,
    stock_analysis_used: prepared.source === 'stock_analysis_followup',
    deduplicated_request: false,
    emergency_failover: true,
    provider_outage_recovered: true,
    primary_outage_attempts: Number(payload.attempted_count) || 0
  };

  if (userId && handleContextAIV4._test) {
    const key = requestKey(userId, prepared.source, prepared.task, prepared.message, prepared.context, prepared.historyRows);
    if (handleContextAIV4._test.failureCache) handleContextAIV4._test.failureCache.delete(key);
    if (handleContextAIV4._test.responseCache) {
      const ttl = bounded(process.env.PORTFOLIO_AI_CACHE_TTL_MS, 10 * 60 * 1000, 30000, 60 * 60 * 1000);
      handleContextAIV4._test.responseCache.set(key, { payload: successPayload, expiresAt: Date.now() + ttl });
    }
    if (handleContextAIV4._test.sticky) {
      handleContextAIV4._test.sticky.set(userId + ':' + prepared.source + ':' + prepared.task, result.model);
      handleContextAIV4._test.sticky.set(userId + ':global', result.model);
    }
    if (handleContextAIV4._test.health) {
      const current = handleContextAIV4._test.health.get(result.model) || { failures: 0, consecutive: 0, cooldownUntil: 0, avgLatency: null, successes: 0 };
      const totalSuccesses = Number(current.successes || 0) + 1;
      current.avgLatency = current.avgLatency == null
        ? result.latency
        : Math.round(((current.avgLatency * (totalSuccesses - 1)) + result.latency) / totalSuccesses);
      current.successes = totalSuccesses;
      current.consecutive = 0;
      current.cooldownUntil = 0;
      handleContextAIV4._test.health.set(result.model, current);
    }
  }
  return successPayload;
}

async function tryOutageSpillover(req, originalPayload, trace, handleContextAIV4, handlerStarted) {
  if (!allPrimaryFailuresAreTemporary(originalPayload, trace)) return null;
  const apiKey = process.env.PORTFOLIO_AI_API_KEY;
  const baseUrl = String(process.env.PORTFOLIO_AI_BASE_URL || 'https://weizerouter.web.id/v1').replace(/\/+$/, '');
  if (!apiKey || !/^https:\/\/weizerouter\.web\.id\/v1$/i.test(baseUrl)) return null;

  const prepared = emergencyContext(req, handleContextAIV4);
  const attemptedModels = Array.isArray(originalPayload.attempted_models) ? originalPayload.attempted_models.filter(Boolean) : [];
  const configuredExtra = bounded(process.env.PORTFOLIO_AI_OUTAGE_SPILLOVER_ATTEMPTS, DEFAULT_OUTAGE_SPILLOVER_ATTEMPTS, 0, 6);
  const capRoom = Math.max(0, globalAttemptCap() - attemptedModels.length);
  const extraLimit = Math.min(configuredExtra, capRoom);
  if (extraLimit <= 0) return null;

  const candidates = outageCandidatePool(prepared.source, prepared.task, attemptedModels).slice(0, extraLimit);
  if (!candidates.length) return null;

  const perModel = bounded(process.env.PORTFOLIO_AI_OUTAGE_MODEL_TIMEOUT_MS, DEFAULT_OUTAGE_MODEL_TIMEOUT_MS, 1500, 7000);
  const configuredTotal = bounded(process.env.PORTFOLIO_AI_OUTAGE_TOTAL_TIMEOUT_MS, DEFAULT_OUTAGE_TOTAL_TIMEOUT_MS, 3000, 15000);
  const hardRemaining = Math.max(0, OUTAGE_HARD_HANDLER_BUDGET_MS - (Date.now() - handlerStarted));
  const totalBudget = Math.min(configuredTotal, hardRemaining);
  const spillStarted = Date.now();
  let emergencyAttempts = 0;

  for (const model of candidates) {
    const remaining = totalBudget - (Date.now() - spillStarted);
    if (remaining < 1000) break;
    const result = await callEmergencyModel(baseUrl, apiKey, model, prepared.messages, Math.min(perModel, remaining));
    emergencyAttempts += 1;
    console.warn('context-ai outage spillover attempt', JSON.stringify({
      source: prepared.source,
      task: prepared.task,
      model,
      status: result.status,
      ok: result.ok,
      latency_ms: result.latency,
      emergency_attempt: emergencyAttempts
    }));
    if (result.ok) {
      const totalAttempts = attemptedModels.length + emergencyAttempts;
      const payload = rememberEmergencySuccess(handleContextAIV4, req, prepared, result, originalPayload, totalAttempts);
      console.log('context-ai outage spillover success', JSON.stringify({
        source: prepared.source,
        task: prepared.task,
        model: result.model,
        attempts: totalAttempts,
        elapsed_ms: Date.now() - handlerStarted
      }));
      return payload;
    }
    if (result.status === 401 || result.status === 402 || result.status === 403) break;
  }
  return null;
}

// Stock analysis gets a quality-oriented but vendor-diverse order. Portfolio
// heavy analysis uses the same pool. Fast chat starts with Gemini Flash for low
// latency/cost, while empathy keeps Sonnet first for response quality.
prioritize('STOCK_ANALYSIS_AI_MODELS', VERIFIED_BALANCED);
prioritize('PORTFOLIO_AI_HEAVY_MODELS', VERIFIED_BALANCED);
prioritize('PORTFOLIO_AI_EMPATHY_MODELS', VERIFIED_EMPATHY);
prioritize('PORTFOLIO_AI_FAST_MODELS', VERIFIED_FAST);
installWeizeCompatibilityFetch(globalThis);

const handleContextAIV4 = require('./context-ai-router-v4');

async function handleContextAIV5(req, res) {
  const handlerStarted = Date.now();
  const trace = { rejections: [] };
  return providerTraceStorage.run(trace, async () => {
    const captured = captureResponse();
    await handleContextAIV4(req, captured.response);
    const payload = captured.state.payload && typeof captured.state.payload === 'object'
      ? captured.state.payload
      : { success: false, error: clean(captured.state.payload, 300) || 'Asisten AI belum tersedia.' };

    let recovered = null;
    try { recovered = await tryOutageSpillover(req, payload, trace, handleContextAIV4, handlerStarted); }
    catch (error) {
      console.warn('context-ai outage spillover exception', JSON.stringify({ message: clean(error && error.message, 160) || 'unknown' }));
    }
    if (recovered) return res.status(200).json(recovered);
    return forwardCaptured(res, captured);
  });
}

handleContextAIV5._test = handleContextAIV4._test;
handleContextAIV5._weizeCompat = {
  isWeizeChatUrl,
  chatEndpointMeta,
  redactDiagnostic,
  diagnosticReason,
  isTemporaryModelUnavailable,
  modelFromInit,
  minimalWeizeInit,
  providerRejectionMeta,
  logProviderRejection,
  installWeizeCompatibilityFetch,
  allPrimaryFailuresAreTemporary,
  outageCandidatePool
};
module.exports = handleContextAIV5;