'use strict';

/**
 * ai-evaluator.js — Hybrid AI evaluation router (Vercel primer → VPS fallback).
 *
 * Every AI evaluation goes to the primary Vercel endpoint first with a hard
 * 5-second timeout. When that call fails (network error, timeout, HTTP 503, or
 * HTTP 402 DEPLOYMENT_DISABLED) the SAME request is replayed against the local
 * VPS router (auto-cuan-ai-eval-supervisor / the internal Express bridge), so a
 * paused Vercel deployment never takes the analysis features down.
 *
 * Contract:
 *  - `evaluate(prompt, options)` returns
 *      { ok: true,  text, source: 'vercel'|'vps', attempts }
 *      { ok: false, error, code, source: null|'vercel', attempts }
 *    It NEVER throws: the caller always gets a result object.
 *  - No credential is ever logged; only coarse status codes are surfaced.
 *  - The primary and fallback URLs are read from the environment on every call so
 *    an operator can repoint them without a redeploy.
 *
 * Environment:
 *   AI_EVAL_PRIMARY_URL    (default https://autocuan.web.id/api/analyze)
 *   AI_EVAL_FALLBACK_URL   (default http://127.0.0.1:3001/api/ai-eval)
 *   AI_EVAL_PRIMARY_TIMEOUT_MS  (default 5000)
 *   AI_EVAL_FALLBACK_TIMEOUT_MS (default 20000)
 *   AI_EVAL_FALLBACK_TOKEN (optional bearer for the internal VPS router)
 *   VPS_AI_EVAL_PORT       (default 3001; used when AI_EVAL_FALLBACK_URL is unset)
 */

const DEFAULT_PRIMARY_URL = 'https://autocuan.web.id/api/analyze';
const DEFAULT_PRIMARY_TIMEOUT_MS = 5000;
const DEFAULT_FALLBACK_TIMEOUT_MS = 20000;

// HTTP statuses that mean "the primary host itself is unavailable", so the
// request must be replayed on the fallback instead of being treated as a
// caller error. 402 = Vercel DEPLOYMENT_DISABLED, 503 = upstream unavailable.
const PRIMARY_UNAVAILABLE_STATUSES = new Set([402, 429, 500, 502, 503, 504]);

function envString(env, key, fallback) {
  const value = env && env[key];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function envInt(env, key, fallback) {
  const parsed = Number.parseInt(env && env[key], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function primaryUrl(env) {
  return envString(env, 'AI_EVAL_PRIMARY_URL', DEFAULT_PRIMARY_URL);
}

function fallbackUrl(env) {
  const explicit = envString(env, 'AI_EVAL_FALLBACK_URL', '');
  if (explicit) return explicit;
  const port = envInt(env, 'VPS_AI_EVAL_PORT', 3001);
  return 'http://127.0.0.1:' + port + '/api/ai-eval';
}

// Coarse classification: is this failure a reason to try the fallback?
function shouldFallback(status, errorCode) {
  if (errorCode === 'timeout' || errorCode === 'network_error') return true;
  if (typeof status === 'number' && status > 0) return PRIMARY_UNAVAILABLE_STATUSES.has(status);
  return false;
}

// Single HTTP attempt with a hard timeout. Returns a normalized result and never
// throws. `fetchFn` is injectable for tests.
async function attempt(url, payload, options) {
  const opts = options || {};
  const fetchFn = opts.fetchFn || globalThis.fetch;
  const timeoutMs = opts.timeoutMs || DEFAULT_PRIMARY_TIMEOUT_MS;
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});

  if (typeof fetchFn !== 'function') {
    return { ok: false, code: 'fetch_unavailable', status: 0, text: '' };
  }

  let signal;
  try {
    signal = AbortSignal.timeout(timeoutMs);
  } catch (e) {
    signal = undefined;
  }

  let resp;
  try {
    resp = await fetchFn(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload),
      signal: signal
    });
  } catch (e) {
    const name = e && e.name ? String(e.name) : '';
    const code = (name === 'AbortError' || name === 'TimeoutError') ? 'timeout' : 'network_error';
    return { ok: false, code: code, status: 0, text: '' };
  }

  let text = '';
  try { text = await resp.text(); } catch (e) { text = ''; }

  if (!resp.ok) {
    return { ok: false, code: 'http_error', status: resp.status, text: text.slice(0, 500) };
  }

  return { ok: true, status: resp.status, text: text };
}

// Extract the model text from the various response shapes the two hosts may use.
function extractText(body) {
  if (!body) return '';
  if (typeof body === 'string') return body;
  if (typeof body.text === 'string') return body.text;
  if (typeof body.answer === 'string') return body.answer;
  if (typeof body.result === 'string') return body.result;
  if (body.result && typeof body.result.text === 'string') return body.result.text;
  if (body.candidates && body.candidates[0]) {
    const parts = body.candidates[0].content && body.candidates[0].content.parts;
    if (Array.isArray(parts) && parts[0] && typeof parts[0].text === 'string') return parts[0].text;
  }
  return '';
}

function parseBody(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { return null; }
}

/**
 * Evaluate a prompt through the hybrid router.
 *
 * @param {string} prompt  The full prompt text.
 * @param {object} [options]
 * @param {object} [options.env]        Environment source (default process.env).
 * @param {Function} [options.fetchFn]  Injectable fetch (tests).
 * @param {object} [options.extra]      Extra fields merged into the request body.
 * @param {string} [options.model]      Optional model hint.
 * @param {number} [options.primaryTimeoutMs]
 * @param {number} [options.fallbackTimeoutMs]
 * @returns {Promise<{ok:boolean,text?:string,source?:string,attempts:number,error?:string,code?:string}>}
 */
async function evaluate(prompt, options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const attempts = [];

  const body = Object.assign({ prompt: String(prompt == null ? '' : prompt) }, opts.extra || {});
  if (opts.model) body.model = opts.model;

  const primary = primaryUrl(env);
  const primaryTimeout = opts.primaryTimeoutMs || envInt(env, 'AI_EVAL_PRIMARY_TIMEOUT_MS', DEFAULT_PRIMARY_TIMEOUT_MS);

  // --- 1. Primary (Vercel) --------------------------------------------------
  const primaryResult = await attempt(primary, body, {
    fetchFn: opts.fetchFn,
    timeoutMs: primaryTimeout,
    headers: opts.headers
  });
  attempts.push({ target: 'vercel', url: primary, ok: primaryResult.ok, code: primaryResult.code || null, status: primaryResult.status });

  if (primaryResult.ok) {
    const text = extractText(parseBody(primaryResult.text));
    if (text) return { ok: true, text: text, source: 'vercel', attempts: attempts.length };
    // A 200 with an unparseable/empty body is still a primary failure: fall back.
    attempts[attempts.length - 1].code = 'empty_body';
  }

  const primaryCode = primaryResult.code || 'http_error';
  if (primaryResult.ok || shouldFallback(primaryResult.status, primaryCode)) {
    // --- 2. Fallback (local VPS router) ------------------------------------
    const fallback = fallbackUrl(env);
    const fallbackTimeout = opts.fallbackTimeoutMs || envInt(env, 'AI_EVAL_FALLBACK_TIMEOUT_MS', DEFAULT_FALLBACK_TIMEOUT_MS);
    const fallbackHeaders = {};
    const fallbackToken = envString(env, 'AI_EVAL_FALLBACK_TOKEN', '');
    if (fallbackToken) fallbackHeaders.Authorization = 'Bearer ' + fallbackToken;

    const fallbackResult = await attempt(fallback, body, {
      fetchFn: opts.fetchFn,
      timeoutMs: fallbackTimeout,
      headers: fallbackHeaders
    });
    attempts.push({ target: 'vps', url: fallback, ok: fallbackResult.ok, code: fallbackResult.code || null, status: fallbackResult.status });

    if (fallbackResult.ok) {
      const text = extractText(parseBody(fallbackResult.text));
      if (text) return { ok: true, text: text, source: 'vps', attempts: attempts.length };
      return {
        ok: false,
        error: 'VPS fallback returned an empty response',
        code: 'fallback_empty',
        source: 'vps',
        attempts: attempts.length
      };
    }

    return {
      ok: false,
      error: 'Primary and fallback AI evaluators both failed',
      code: fallbackResult.code === 'timeout' ? 'fallback_timeout' : 'fallback_failed',
      source: 'vps',
      attempts: attempts.length
    };
  }

  // Primary answered with a caller error (400/401/403/...): do not retry on the
  // fallback, surface the coarse code.
  return {
    ok: false,
    error: 'Primary AI evaluator rejected the request',
    code: primaryCode,
    source: 'vercel',
    attempts: attempts.length
  };
}

/**
 * Convenience wrapper that resolves to the text (or a safe Indonesian fallback
 * string) instead of a result object. Useful for chat replies where a missing
 * narrative must never break the surrounding card.
 */
async function evaluateText(prompt, options) {
  const result = await evaluate(prompt, options);
  if (result.ok) return result.text;
  return 'Opini AI sedang tidak tersedia. Silakan coba lagi beberapa saat lagi.';
}

/**
 * Hybrid routing for a caller-owned PRIMARY call (e.g. a BYOK provider request
 * made with the member's own API key). The primary function is invoked first;
 * when it fails with a network error / timeout / 402 / 503 the request is
 * replayed against the local VPS router.
 *
 * @param {Function} primaryFn  async () => { ok, text?, error?, code?, status? }
 * @param {string} prompt       The prompt, forwarded to the VPS router verbatim.
 * @param {object} [options]    Same options as evaluate(), plus `extra`.
 * @returns {Promise<{ok:boolean,text?:string,source?:string,attempts:number,error?:string,code?:string}>}
 */
async function evaluateWithPrimary(primaryFn, prompt, options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const attempts = [];

  let primary = { ok: false, code: 'primary_unavailable' };
  try {
    primary = await primaryFn();
  } catch (e) {
    const name = e && e.name ? String(e.name) : '';
    primary = {
      ok: false,
      code: (name === 'AbortError' || name === 'TimeoutError') ? 'timeout' : 'network_error',
      error: e && e.message ? String(e.message).slice(0, 200) : 'primary_threw'
    };
  }
  attempts.push({ target: 'vercel', ok: primary.ok === true, code: primary.code || null, status: primary.status || 0 });

  if (primary.ok && primary.text) {
    return { ok: true, text: primary.text, source: 'vercel', attempts: attempts.length };
  }

  const primaryCode = primary.code || 'http_error';
  if (!shouldFallback(primary.status, primaryCode)) {
    return {
      ok: false,
      error: primary.error || 'Primary AI evaluator rejected the request',
      code: primaryCode,
      source: 'vercel',
      attempts: attempts.length
    };
  }

  const body = Object.assign({ prompt: String(prompt == null ? '' : prompt) }, opts.extra || {});
  if (opts.model) body.model = opts.model;

  const fallback = fallbackUrl(env);
  const fallbackTimeout = opts.fallbackTimeoutMs || envInt(env, 'AI_EVAL_FALLBACK_TIMEOUT_MS', DEFAULT_FALLBACK_TIMEOUT_MS);
  const fallbackHeaders = {};
  const fallbackToken = envString(env, 'AI_EVAL_FALLBACK_TOKEN', '');
  if (fallbackToken) fallbackHeaders.Authorization = 'Bearer ' + fallbackToken;

  const fallbackResult = await attempt(fallback, body, {
    fetchFn: opts.fetchFn,
    timeoutMs: fallbackTimeout,
    headers: fallbackHeaders
  });
  attempts.push({ target: 'vps', url: fallback, ok: fallbackResult.ok, code: fallbackResult.code || null, status: fallbackResult.status });

  if (fallbackResult.ok) {
    const text = extractText(parseBody(fallbackResult.text));
    if (text) return { ok: true, text: text, source: 'vps', attempts: attempts.length };
    return {
      ok: false,
      error: 'VPS fallback returned an empty response',
      code: 'fallback_empty',
      source: 'vps',
      attempts: attempts.length
    };
  }

  return {
    ok: false,
    error: primary.error || 'Primary and fallback AI evaluators both failed',
    code: fallbackResult.code === 'timeout' ? 'fallback_timeout' : 'fallback_failed',
    source: 'vps',
    attempts: attempts.length
  };
}

module.exports = {
  evaluate,
  evaluateWithPrimary,
  evaluateText,
  attempt,
  extractText,
  shouldFallback,
  primaryUrl,
  fallbackUrl,
  PRIMARY_UNAVAILABLE_STATUSES,
  DEFAULT_PRIMARY_URL,
  DEFAULT_PRIMARY_TIMEOUT_MS,
  DEFAULT_FALLBACK_TIMEOUT_MS,
};
