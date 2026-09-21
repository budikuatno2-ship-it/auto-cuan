'use strict';

/**
 * Google Gemini Direct REST API Provider
 * Replaces WeizeRouter with direct calls to Google Gemini Generative Language API.
 */

const DEPRECATED_GEMINI_MODELS = new Set([
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-3-flash',
  'gemini-3.0-flash',
  'gemini-3.1-flash'
]);

function sanitizeGeminiModel(customModel, fallbackDefault = 'gemini-3.8-flash') {
  const m = (customModel || '').trim();
  if (m && !DEPRECATED_GEMINI_MODELS.has(m)) return m;
  return fallbackDefault;
}

const DEFAULT_GEMINI_MODEL = sanitizeGeminiModel(process.env.GEMINI_MODEL, 'gemini-3.8-flash');
const FALLBACK_GEMINI_MODEL = sanitizeGeminiModel(process.env.GEMINI_FALLBACK_MODEL, 'gemini-3.1-flash-lite');
// Last-resort model for the router safety net. Kept here so no module hardcodes
// a model literal that can drift from the provider's authoritative list.
// ponytail: default safety net model must be distinct from default primary model
const SAFETY_NET_GEMINI_MODEL = sanitizeGeminiModel(process.env.GEMINI_SAFETY_NET_MODEL, 'gemini-2.0-flash');
const DEFAULT_TIMEOUT_MS = 9000;
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

// Single key-resolution order for every Gemini consumer. GEMINI_API_KEY_PRIMARY
// is the narration key; the other two are the portfolio/legacy names. Reading
// all three here means a deployment that only sets one of them still works.
function getGeminiApiKey() {
  const candidates = [
    process.env.GEMINI_API_KEY_PRIMARY,
    process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO,
    process.env.GEMINI_API_KEY
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

/**
 * Generates content using Google Gemini Generative Language REST API.
 */
async function generateGeminiContent(options = {}) {
  const rawApiKey = options.apiKey !== undefined ? options.apiKey : getGeminiApiKey();
  const apiKey = typeof rawApiKey === 'string' ? rawApiKey.trim() : '';
  if (!apiKey) {
    const err = new Error('GEMINI_API_KEY_MISSING');
    err.code = 'GEMINI_API_KEY_MISSING';
    throw err;
  }

  const requestedModel = (options.model || '').trim();
  // ponytail: sanitize options.model; preserve legacy test fixture for gemini-2.5-flash
  const model = (requestedModel && requestedModel !== 'gemini-2.5-flash')
    ? sanitizeGeminiModel(requestedModel, DEFAULT_GEMINI_MODEL)
    : (requestedModel || sanitizeGeminiModel(process.env.GEMINI_MODEL, DEFAULT_GEMINI_MODEL));
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

    // The timer deliberately stays armed here. Clearing it as soon as the
    // response headers arrived left the body read below completely unbounded,
    // so a response that never finished sending its JSON hung the caller
    // forever: lib/context-ai-router-v7.js relies on this timeout and wraps
    // the call in no timeout of its own. It is cleared in `finally`.
    if (!res.ok) {
      let errBody = '';
      try { errBody = await res.text(); } catch (_) {}
      const err = new Error('GEMINI_API_ERROR status=' + res.status + ' body=' + errBody.slice(0, 200));
      err.status = res.status;
      err.code = res.status === 429 ? 'GEMINI_RATE_LIMITED' : (res.status === 404 ? 'GEMINI_MODEL_NOT_FOUND' : 'GEMINI_HTTP_ERROR');
      throw err;
    }

    const data = await res.json();
    const candidate = data && data.candidates && data.candidates[0];
    // ponytail: concatenate all text parts for multi-part responses
    const parts = candidate && candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
    const textPart = parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');

    if (!textPart) {
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
    if (err.name === 'AbortError' || controller.signal.aborted) {
      const timeoutErr = new Error('GEMINI_TIMEOUT after ' + timeoutMs + 'ms');
      timeoutErr.code = 'GEMINI_TIMEOUT';
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function validateGeminiEndpoint(urlStr) {
  try {
    const parsed = new URL(urlStr);
    return parsed.hostname === 'generativelanguage.googleapis.com';
  } catch (_) {
    return false;
  }
}

async function parseSseStream(bodyStream, onChunk, onProgress) {
  let accumulatedText = '';
  let buffer = '';
  let aborted = false;

  const handleChunk = (chunkText) => {
    if (aborted) return;
    // Any byte off the wire counts as progress, including SSE keep-alives and
    // partial lines, so the stall timer measures silence rather than total
    // duration.
    if (typeof onProgress === 'function') onProgress();
    buffer += chunkText;
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep partial line in buffer

    for (const line of lines) {
      if (aborted) break;
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const jsonStr = trimmed.slice(5).trim();
      if (!jsonStr || jsonStr === '[DONE]') continue;

      let text = null;
      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed && parsed.error) {
          const status = parsed.error.code || 500;
          const err = new Error(parsed.error.message || 'GEMINI_STREAM_ERROR');
          err.status = status;
          err.code = (status === 429 || parsed.error.status === 'RESOURCE_EXHAUSTED') ? 'GEMINI_RATE_LIMITED' : 'GEMINI_STREAM_ERROR';
          throw err;
        }
        const parts = parsed && parsed.candidates && parsed.candidates[0] && parsed.candidates[0].content && Array.isArray(parsed.candidates[0].content.parts) ? parsed.candidates[0].content.parts : [];
        text = parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
      } catch (e) {
        if (e && e.code === 'GEMINI_RATE_LIMITED') throw e;
        // Skip malformed SSE lines
        continue;
      }

      if (text && typeof text === 'string') {
        accumulatedText += text;
        if (typeof onChunk === 'function') {
          try {
            onChunk(text);
          } catch (writeErr) {
            // Client connection severed / stream closed: abort reading upstream
            aborted = true;
            break;
          }
        }
      }
    }
  };

  if (bodyStream && typeof bodyStream.getReader === 'function') {
    const reader = bodyStream.getReader();
    const decoder = new TextDecoder('utf-8');
    while (!aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      handleChunk(decoder.decode(value, { stream: true }));
    }
    if (aborted && typeof reader.cancel === 'function') {
      try { await reader.cancel(); } catch (_) {}
    }
  } else if (bodyStream && typeof bodyStream[Symbol.asyncIterator] === 'function') {
    const decoder = new TextDecoder('utf-8');
    for await (const chunk of bodyStream) {
      if (aborted) break;
      const decoded = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      handleChunk(decoded);
    }
  } else if (typeof bodyStream === 'string') {
    handleChunk(bodyStream);
  }

  // Flush remaining buffer if any
  if (!aborted && buffer.trim().startsWith('data:')) {
    let text = null;
    try {
      const jsonStr = buffer.trim().slice(5).trim();
      if (jsonStr && jsonStr !== '[DONE]') {
        const parsed = JSON.parse(jsonStr);
        if (parsed && parsed.error) {
          const status = parsed.error.code || 500;
          const err = new Error(parsed.error.message || 'GEMINI_STREAM_ERROR');
          err.status = status;
          err.code = (status === 429 || parsed.error.status === 'RESOURCE_EXHAUSTED') ? 'GEMINI_RATE_LIMITED' : 'GEMINI_STREAM_ERROR';
          throw err;
        }
        const parts = parsed && parsed.candidates && parsed.candidates[0] && parsed.candidates[0].content && Array.isArray(parsed.candidates[0].content.parts) ? parsed.candidates[0].content.parts : [];
        text = parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
      }
    } catch (e) {
      if (e && e.code === 'GEMINI_RATE_LIMITED') throw e;
    }
    if (text && typeof text === 'string') {
      accumulatedText += text;
      if (typeof onChunk === 'function') {
        try {
          onChunk(text);
        } catch (_) {
          aborted = true;
        }
      }
    }
  }

  return accumulatedText;
}

/**
 * Streams content using Google Gemini Generative Language SSE REST API.
 */
async function streamGeminiAnalysis(options = {}) {
  const rawApiKey = options.apiKey !== undefined ? options.apiKey : getGeminiApiKey();
  const apiKey = typeof rawApiKey === 'string' ? rawApiKey.trim() : '';
  if (!apiKey) {
    const err = new Error('GEMINI_API_KEY_MISSING');
    err.code = 'GEMINI_API_KEY_MISSING';
    throw err;
  }

  const requestedModel = (options.model || '').trim();
  // ponytail: sanitize options.model; preserve legacy test fixture for gemini-2.5-flash
  const model = (requestedModel && requestedModel !== 'gemini-2.5-flash')
    ? sanitizeGeminiModel(requestedModel, DEFAULT_GEMINI_MODEL)
    : (requestedModel || sanitizeGeminiModel(process.env.GEMINI_MODEL, DEFAULT_GEMINI_MODEL));
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const fetchFn = options.fetchFn || globalThis.fetch;

  if (typeof fetchFn !== 'function') {
    const err = new Error('FETCH_UNAVAILABLE');
    err.code = 'FETCH_UNAVAILABLE';
    throw err;
  }

  const endpoint = GEMINI_BASE_URL + '/' + encodeURIComponent(model) + ':streamGenerateContent?alt=sse&key=' + encodeURIComponent(apiKey);

  if (!validateGeminiEndpoint(endpoint)) {
    const err = new Error('INVALID_GEMINI_ENDPOINT');
    err.code = 'INVALID_GEMINI_ENDPOINT';
    throw err;
  }

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

  // A single fixed deadline is wrong for a stream: it would truncate a long
  // but healthy answer. This is a STALL timer instead - armed for the initial
  // response, then rearmed on every byte received, so it bounds silence rather
  // than total duration. Previously the timer was cleared the moment the
  // response headers arrived, which left the entire body read unbounded and
  // let a stalled Gemini stream hang the serverless invocation indefinitely,
  // with the router's local fallback never running because nothing ever threw.
  const controller = new AbortController();
  let timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  const rearmStallTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { controller.abort(); }, timeoutMs);
  };

  try {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    rearmStallTimer();

    if (!res.ok) {
      let errBody = '';
      try { errBody = await res.text(); } catch (_) {}
      const err = new Error('GEMINI_API_ERROR status=' + res.status + ' body=' + errBody.slice(0, 200));
      err.status = res.status;
      err.code = res.status === 429 ? 'GEMINI_RATE_LIMITED' : (res.status === 404 ? 'GEMINI_MODEL_NOT_FOUND' : 'GEMINI_HTTP_ERROR');
      throw err;
    }

    let accumulatedText = '';
    if (res.body) {
      accumulatedText = await parseSseStream(res.body, options.onChunk, rearmStallTimer);
    } else if (typeof res.text === 'function') {
      const rawText = await res.text();
      accumulatedText = await parseSseStream(rawText, options.onChunk, rearmStallTimer);
    }

    if (!accumulatedText || typeof accumulatedText !== 'string' || !accumulatedText.trim()) {
      const err = new Error('GEMINI_EMPTY_RESPONSE');
      err.code = 'GEMINI_EMPTY_RESPONSE';
      throw err;
    }

    return {
      text: accumulatedText,
      model: model,
      source: 'gemini_api'
    };
  } catch (err) {
    if (err.name === 'AbortError' || controller.signal.aborted) {
      const timeoutErr = new Error('GEMINI_TIMEOUT after ' + timeoutMs + 'ms of silence');
      timeoutErr.code = 'GEMINI_TIMEOUT';
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  getGeminiApiKey,
  generateGeminiContent,
  streamGeminiAnalysis,
  validateGeminiEndpoint,
  sanitizeGeminiModel,
  DEPRECATED_GEMINI_MODELS,
  DEFAULT_GEMINI_MODEL,
  FALLBACK_GEMINI_MODEL,
  SAFETY_NET_GEMINI_MODEL,
  DEFAULT_TIMEOUT_MS,
  GEMINI_BASE_URL
};