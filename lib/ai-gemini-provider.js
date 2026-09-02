'use strict';

/**
 * Google Gemini Direct REST API Provider
 * Replaces WeizeRouter with direct calls to Google Gemini Generative Language API.
 */

const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const FALLBACK_GEMINI_MODEL = 'gemini-1.5-flash';
const DEFAULT_TIMEOUT_MS = 9000;
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

function getGeminiApiKey() {
  const primary = process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO;
  if (primary && typeof primary === 'string' && primary.trim().length > 0) {
    return primary.trim();
  }
  const fallback = process.env.GEMINI_API_KEY;
  if (fallback && typeof fallback === 'string' && fallback.trim().length > 0) {
    return fallback.trim();
  }
  return null;
}

/**
 * Generates content using Google Gemini Generative Language REST API.
 */
async function generateGeminiContent(options = {}) {
  const apiKey = options.apiKey || getGeminiApiKey();
  if (!apiKey) {
    const err = new Error('GEMINI_API_KEY_MISSING');
    err.code = 'GEMINI_API_KEY_MISSING';
    throw err;
  }

  const model = options.model || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const fetchFn = options.fetchFn || globalThis.fetch;

  if (typeof fetchFn !== 'function') {
    const err = new Error('FETCH_UNAVAILABLE');
    err.code = 'FETCH_UNAVAILABLE';
    throw err;
  }

  const endpoint = GEMINI_BASE_URL + '/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(apiKey);

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [{ text: String(options.prompt || '') }]
      }
    ],
    generationConfig: {
      temperature: typeof options.temperature === 'number' ? options.temperature : 0.2,
      maxOutputTokens: typeof options.maxOutputTokens === 'number' ? options.maxOutputTokens : 2048
    }
  };

  if (options.systemInstruction && typeof options.systemInstruction === 'string' && options.systemInstruction.trim()) {
    payload.systemInstruction = {
      parts: [{ text: options.systemInstruction.trim() }]
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timer);

    if (!res.ok) {
      let errBody = '';
      try { errBody = await res.text(); } catch (_) {}
      const err = new Error('GEMINI_API_ERROR status=' + res.status + ' body=' + errBody.slice(0, 200));
      err.status = res.status;
      err.code = res.status === 429 ? 'GEMINI_RATE_LIMITED' : 'GEMINI_HTTP_ERROR';
      throw err;
    }

    const data = await res.json();
    const candidate = data && data.candidates && data.candidates[0];
    const textPart = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0] && candidate.content.parts[0].text;

    if (!textPart || typeof textPart !== 'string') {
      const err = new Error('GEMINI_EMPTY_RESPONSE');
      err.code = 'GEMINI_EMPTY_RESPONSE';
      throw err;
    }

    return {
      text: textPart,
      model: model,
      usage: data.usageMetadata || null,
      source: 'gemini_api'
    };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError' || controller.signal.aborted) {
      const timeoutErr = new Error('GEMINI_TIMEOUT after ' + timeoutMs + 'ms');
      timeoutErr.code = 'GEMINI_TIMEOUT';
      throw timeoutErr;
    }
    throw err;
  }
}

module.exports = {
  getGeminiApiKey,
  generateGeminiContent,
  DEFAULT_GEMINI_MODEL,
  FALLBACK_GEMINI_MODEL,
  DEFAULT_TIMEOUT_MS,
  GEMINI_BASE_URL
};