'use strict';

/**
 * Multi-provider BYOK AI client (Gemini / OpenAI / DeepSeek / Claude /
 * OpenRouter / custom OpenAI-compatible gateway).
 *
 * Two responsibilities:
 *  1. Normalize how a stored credential is turned into a concrete endpoint,
 *     model and auth header.
 *  2. Perform an auto-validate handshake against the provider's official
 *     endpoint so a user's key is proven usable WITHOUT manual admin approval.
 *
 * Security boundaries:
 *  - Every outbound URL must be HTTPS with no embedded credentials. Private,
 *    loopback and link-local hosts are refused for the custom gateway path so a
 *    user-supplied BASE_URL cannot be used to probe the VPS metadata service
 *    (SSRF). The refusal happens BEFORE any fetch.
 *  - Provider errors are surfaced as short, coarse codes; raw upstream bodies
 *    are never echoed back into a chat.
 */

const PROVIDERS = Object.freeze({
  gemini: {
    key: 'gemini',
    label: 'Google Gemini',
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-3.8-flash'
  },
  openai: {
    key: 'openai',
    label: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini'
  },
  deepseek: {
    key: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat'
  },
  claude: {
    key: 'claude',
    label: 'Claude',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-3-5-sonnet-latest'
  },
  custom: {
    key: 'custom',
    label: 'Custom / OpenRouter',
    kind: 'openai',
    baseUrl: null,
    model: null
  }
});

const DEFAULT_TIMEOUT_MS = 15000;
const HANDSHAKE_PROMPT = 'Balas dengan satu kata: ok';

function providerMeta(key) {
  const k = String(key || '').trim().toLowerCase();
  return PROVIDERS[k] || PROVIDERS.gemini;
}

// Hosts that must never be reachable through a user-supplied base URL.
function isBlockedHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host === 'metadata.google.internal') return true;
  // IPv6 loopback / unique-local / link-local.
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
  }
  return false;
}

/**
 * Validate an outbound provider URL. Returns { ok, url } or { ok: false, error }.
 * Refuses non-HTTPS, embedded credentials, and private/link-local hosts.
 */
function assertSafeProviderUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { ok: false, error: 'URL provider tidak valid.' };
  }
  let parsed;
  try {
    parsed = new URL(String(rawUrl).trim());
  } catch (_) {
    return { ok: false, error: 'URL provider tidak valid.' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'Provider harus memakai HTTPS.' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'URL provider tidak boleh memuat kredensial.' };
  }
  if (isBlockedHost(parsed.hostname)) {
    return { ok: false, error: 'Host provider tidak diizinkan.' };
  }
  return { ok: true, url: parsed.toString().replace(/\/$/, '') };
}

function joinUrl(base, suffix) {
  return String(base).replace(/\/+$/, '') + suffix;
}

/**
 * Parse the CUSTOM / OpenRouter config line: BASE_URL|MODEL_NAME|API_KEY.
 * Never returns the raw key in the error text.
 */
function parseCustomConfig(raw) {
  const text = String(raw || '').trim();
  const parts = text.split('|').map((p) => p.trim());
  if (parts.length < 3) {
    return {
      ok: false,
      error: 'Format custom: BASE_URL|MODEL|API_KEY. Contoh: https://openrouter.ai/api/v1|deepseek/deepseek-r1|sk-or-v1-xxx'
    };
  }
  const baseUrl = parts[0];
  const model = parts[1];
  const apiKey = parts.slice(2).join('|').trim();
  const safe = assertSafeProviderUrl(baseUrl);
  if (!safe.ok) return { ok: false, error: safe.error };
  if (!model) return { ok: false, error: 'Nama model custom wajib diisi.' };
  if (apiKey.length < 8) return { ok: false, error: 'API key custom terlalu pendek.' };
  return { ok: true, baseUrl: safe.url, model, apiKey };
}

async function readJsonSafe(response) {
  try { return await response.json(); } catch (_) { return null; }
}

function extractText(kind, body) {
  if (!body || typeof body !== 'object') return '';
  if (kind === 'openai') {
    const choice = body.choices && body.choices[0];
    if (choice && choice.message && typeof choice.message.content === 'string') return choice.message.content;
    if (choice && typeof choice.text === 'string') return choice.text;
    return '';
  }
  if (kind === 'anthropic') {
    const block = Array.isArray(body.content) ? body.content[0] : null;
    if (block && typeof block.text === 'string') return block.text;
    return '';
  }
  if (typeof body.text === 'string') return body.text;
  return '';
}

function classifyHttpStatus(status) {
  if (status === 401 || status === 403) return 'Kunci ditolak oleh provider (auth gagal). Periksa kembali API key Anda.';
  if (status === 429) return 'Kuota provider tercapai. Coba lagi nanti atau gunakan kunci lain.';
  if (status === 400) return 'Permintaan ditolak provider. Periksa nama model dan format kunci.';
  if (status === 404) return 'Endpoint atau model tidak ditemukan. Periksa BASE_URL dan nama model.';
  if (status >= 500) return 'Provider sedang bermasalah. Coba lagi nanti.';
  return 'Provider menolak permintaan (HTTP ' + status + ').';
}

/**
 * Low-level provider call. `providerKey` selects the dialect; `baseUrl`/`model`
 * override the provider default (used by custom gateways).
 */
async function callProvider(options) {
  const opts = options || {};
  const meta = providerMeta(opts.providerKey);
  const kind = opts.kind || meta.kind;
  const apiKey = String(opts.apiKey || '').trim();
  if (!apiKey) {
    return { ok: false, error: 'API key belum tersedia.' };
  }
  const base = opts.baseUrl || meta.baseUrl;
  const model = opts.model || meta.model;
  if (!base) return { ok: false, error: 'Base URL provider belum dikonfigurasi.' };

  // Reject an unsafe/non-HTTPS endpoint BEFORE resolving the model or issuing
  // any request, so a private/link-local base URL is never probed.
  const safe = assertSafeProviderUrl(base);
  if (!safe.ok) return { ok: false, error: safe.error };
  if (!model) return { ok: false, error: 'Model provider belum dikonfigurasi.' };

  const fetchFn = opts.fetchFn || globalThis.fetch;
  const timeoutMs = Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS;
  let signal;
  try { signal = AbortSignal.timeout(timeoutMs); } catch (_) { signal = undefined; }

  const prompt = String(opts.prompt == null ? '' : opts.prompt);
  const systemPrompt = String(opts.systemPrompt == null ? '' : opts.systemPrompt);

  let url;
  let headers = { 'Content-Type': 'application/json' };
  let payload;
  if (kind === 'anthropic') {
    url = joinUrl(safe.url, '/messages');
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    payload = {
      model,
      max_tokens: Number(opts.maxTokens) || 1024,
      messages: [{ role: 'user', content: prompt }]
    };
    if (systemPrompt) payload.system = systemPrompt;
  } else if (kind === 'gemini') {
    url = joinUrl(safe.url, '/models/' + encodeURIComponent(model) + ':generateContent');
    headers['x-goog-api-key'] = apiKey;
    payload = { contents: [{ parts: [{ text: (systemPrompt ? systemPrompt + '\n\n' : '') + prompt }] }] };
  } else {
    url = joinUrl(safe.url, '/chat/completions');
    headers.Authorization = 'Bearer ' + apiKey;
    payload = {
      model,
      messages: (systemPrompt ? [{ role: 'system', content: systemPrompt }] : []).concat([{ role: 'user', content: prompt }]),
      stream: false,
      max_tokens: Number(opts.maxTokens) || 1024
    };
  }

  let response;
  try {
    response = await fetchFn(url, { method: 'POST', headers, body: JSON.stringify(payload), signal });
  } catch (_) {
    return { ok: false, error: 'Koneksi ke provider gagal. Periksa jaringan lalu coba lagi.' };
  }
  const body = await readJsonSafe(response);
  if (!response.ok) {
    return { ok: false, status: response.status, error: classifyHttpStatus(response.status) };
  }
  if (kind === 'gemini') {
    const candidate = body && body.candidates && body.candidates[0];
    const text = candidate && candidate.content && Array.isArray(candidate.content.parts)
      ? candidate.content.parts.map((p) => p.text || '').join('')
      : '';
    if (!text) return { ok: false, error: 'Provider tidak mengembalikan teks.' };
    return { ok: true, text: String(text).slice(0, 6000) };
  }
  const text = extractText(kind, body);
  if (!text) return { ok: false, error: 'Provider tidak mengembalikan teks.' };
  return { ok: true, text: String(text).slice(0, 6000) };
}

/**
 * Handshake an official or custom credential. Route gemini through the shared
 * Gemini provider so the model list stays in one place; everything else goes
 * through the provider dialect above.
 */
async function handshake(options) {
  const opts = options || {};
  const meta = providerMeta(opts.providerKey);
  if (meta.kind === 'gemini' && opts.gemini) {
    try {
      await opts.gemini.generateGeminiContent({
        apiKey: opts.apiKey,
        prompt: 'ok',
        fetchFn: opts.fetchFn,
        timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
        model: opts.model || undefined
      });
      return { ok: true };
    } catch (err) {
      const msg = String((err && (err.code || err.message)) || '');
      if (msg.includes('RATE_LIMIT') || msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
        return { ok: false, error: 'Kuota provider tercapai. Coba lagi nanti atau gunakan kunci lain.' };
      }
      if (msg.includes('API_KEY_INVALID') || msg.includes('400') || msg.includes('401')) {
        return { ok: false, error: 'Kunci ditolak provider (auth gagal). Periksa kembali API key Anda.' };
      }
      return { ok: false, error: 'Koneksi ke provider gagal. Coba lagi nanti.' };
    }
  }

  const result = await callProvider(Object.assign({}, opts, {
    prompt: HANDSHAKE_PROMPT,
    maxTokens: 16
  }));
  if (result.ok) return { ok: true };
  return { ok: false, error: result.error };
}

module.exports = {
  PROVIDERS,
  DEFAULT_TIMEOUT_MS,
  providerMeta,
  isBlockedHost,
  assertSafeProviderUrl,
  parseCustomConfig,
  callProvider,
  handshake
};