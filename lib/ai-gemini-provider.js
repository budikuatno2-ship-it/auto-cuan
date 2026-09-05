'use strict';

/**
 * Google Gemini Direct REST API Provider
 * Replaces WeizeRouter with direct calls to Google Gemini Generative Language API.
 */

const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3-flash';
const FALLBACK_GEMINI_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.1-flash-lite';
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
  const apiKey = options.apiKey !== undefined ? options.apiKey : getGeminiApiKey();
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

  const handleChunk = (chunkText) => {
    // Any byte off the wire counts as progress, including SSE keep-alives and
    // partial lines, so the stall timer measures silence rather than total
    // duration.
    if (typeof onProgress === 'function') onProgress();
    buffer += chunkText;
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep partial line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const jsonStr = trimmed.slice(5).trim();
      if (!jsonStr || jsonStr === '[DONE]') continue;

      try {
        const parsed = JSON.parse(jsonStr);
        const text = parsed && parsed.candidates && parsed.candidates[0] && parsed.candidates[0].content && parsed.candidates[0].content.parts && parsed.candidates[0].content.parts[0] && parsed.candidates[0].content.parts[0].text;
        if (text && typeof text === 'string') {
          accumulatedText += text;
          if (typeof onChunk === 'function') {
            onChunk(text);
          }
        }
      } catch (_) {
        // Skip malformed SSE lines
      }
    }
  };

  if (bodyStream && typeof bodyStream.getReader === 'function') {
    const reader = bodyStream.getReader();
    const decoder = new TextDecoder('utf-8');
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      handleChunk(decoder.decode(value, { stream: true }));
    }
  } else if (bodyStream && typeof bodyStream[Symbol.asyncIterator] === 'function') {
    const decoder = new TextDecoder('utf-8');
    for await (const chunk of bodyStream) {
      const decoded = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      handleChunk(decoded);
    }
  } else if (typeof bodyStream === 'string') {
    handleChunk(bodyStream);
  }

  // Flush remaining buffer if any
  if (buffer.trim().startsWith('data:')) {
    try {
      const jsonStr = buffer.trim().slice(5).trim();
      if (jsonStr && jsonStr !== '[DONE]') {
        const parsed = JSON.parse(jsonStr);
        const text = parsed && parsed.candidates && parsed.candidates[0] && parsed.candidates[0].content && parsed.candidates[0].content.parts && parsed.candidates[0].content.parts[0] && parsed.candidates[0].content.parts[0].text;
        if (text && typeof text === 'string') {
          accumulatedText += text;
          if (typeof onChunk === 'function') {
            onChunk(text);
          }
        }
      }
    } catch (_) {}
  }

  return accumulatedText;
}

/**
 * Streams content using Google Gemini Generative Language SSE REST API.
 */
async function streamGeminiAnalysis(options = {}) {
  const apiKey = options.apiKey !== undefined ? options.apiKey : getGeminiApiKey();
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
      err.code = res.status === 429 ? 'GEMINI_RATE_LIMITED' : 'GEMINI_HTTP_ERROR';
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
  DEFAULT_GEMINI_MODEL,
  FALLBACK_GEMINI_MODEL,
  DEFAULT_TIMEOUT_MS,
  GEMINI_BASE_URL
};