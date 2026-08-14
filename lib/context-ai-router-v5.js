'use strict';

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

async function logProviderRejection(input, init, response) {
  if (!response || response.ok) return;
  const meta = chatEndpointMeta(input);
  if (!meta) return;
  let raw = '';
  try { raw = await response.clone().text(); }
  catch (_) { raw = ''; }
  console.warn('context-ai provider rejection', JSON.stringify({
    provider_host: meta.provider_host,
    provider_path: meta.provider_path,
    model: modelFromInit(init) || null,
    status: Number(response.status) || 0,
    reason: diagnosticReason(raw) || null
  }));
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

// Stock analysis gets a quality-oriented but vendor-diverse order. Portfolio
// heavy analysis uses the same pool. Fast chat starts with Gemini Flash for low
// latency/cost, while empathy keeps Sonnet first for response quality.
prioritize('STOCK_ANALYSIS_AI_MODELS', VERIFIED_BALANCED);
prioritize('PORTFOLIO_AI_HEAVY_MODELS', VERIFIED_BALANCED);
prioritize('PORTFOLIO_AI_EMPATHY_MODELS', VERIFIED_EMPATHY);
prioritize('PORTFOLIO_AI_FAST_MODELS', VERIFIED_FAST);
installWeizeCompatibilityFetch(globalThis);

const handler = require('./context-ai-router-v4');
handler._weizeCompat = {
  isWeizeChatUrl,
  chatEndpointMeta,
  redactDiagnostic,
  diagnosticReason,
  modelFromInit,
  minimalWeizeInit,
  logProviderRejection,
  installWeizeCompatibilityFetch
};
module.exports = handler;
