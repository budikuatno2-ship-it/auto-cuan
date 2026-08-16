'use strict';

/**
 * Context AI Router V7
 *
 * V6 remains the primary WeizeRouter path and owns authentication, rate limits,
 * provider health, deterministic stock fallback, caching, and token protection.
 * V7 adds one independent OpenAI-compatible provider as a last real-model path.
 *
 * The secondary route is opt-in through server-only environment variables:
 *   PORTFOLIO_AI_SECONDARY_BASE_URL
 *   PORTFOLIO_AI_SECONDARY_API_KEY
 *   PORTFOLIO_AI_SECONDARY_MODELS   (comma separated)
 *
 * It is attempted only after V6 has already authenticated the request and the
 * returned failure is specifically provider/transport related. It is never used
 * to bypass session, permission, quota, rate-limit, or key/balance errors.
 */

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
  // A second URL pointing at the same gateway is not independent failover.
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
    catch (_) { /* Response forwarding must stay best-effort. */ }
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

async function handleContextAIV7(req, res) {
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

handleContextAIV7._test = {
  isPrivateIpv4,
  normalizeSecondaryBaseUrl,
  secondaryConfig,
  shouldTrySecondary,
  sanitizeHistory,
  buildMessages,
  extractReply,
  SECONDARY_FAILURE_CODES
};

module.exports = handleContextAIV7;
