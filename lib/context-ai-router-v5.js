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

function isWeizeChatUrl(input) {
  const value = typeof input === 'string' ? input : (input && input.url);
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'weizerouter.web.id' && /\/v1\/chat\/completions\/?$/.test(url.pathname);
  } catch (_) {
    return false;
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

function installWeizeCompatibilityFetch(target) {
  const root = target || globalThis;
  if (!root || typeof root.fetch !== 'function') return false;
  if (root.fetch[WEIZE_COMPAT_MARK]) return true;
  const baseFetch = root.fetch;
  async function compatibleFetch(input, init) {
    return baseFetch.call(this, input, minimalWeizeInit(input, init));
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
  minimalWeizeInit,
  installWeizeCompatibilityFetch
};
module.exports = handler;
