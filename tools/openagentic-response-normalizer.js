'use strict';

function safeJson(value) {
  try { return JSON.parse(value); } catch (_) { return null; }
}

function firstBalancedJson(text) {
  const source = String(text || '').trim();
  const start = source.search(/[\[{]/);
  if (start < 0) return null;
  const opener = source[start];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === opener) depth += 1;
    else if (ch === closer) {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

function contentText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    return typeof part.text === 'string' ? part.text : (typeof part.content === 'string' ? part.content : '');
  }).join('');
}

function parseSseBody(raw) {
  const text = String(raw == null ? '' : raw);
  const payloads = [];
  let sawDone = false;
  let sawData = false;
  let malformedPayloads = 0;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/^data:\s*/i.test(trimmed)) continue;
    sawData = true;
    const payload = trimmed.replace(/^data:\s*/i, '').trim();
    if (!payload) continue;
    if (payload === '[DONE]') {
      sawDone = true;
      continue;
    }
    const parsed = safeJson(payload);
    if (parsed) payloads.push(parsed);
    else malformedPayloads += 1;
  }

  if (!sawData) return null;
  if (!sawDone) {
    return { ok: false, error: 'Provider stream terputus sebelum [DONE].', malformedPayloads };
  }
  if (malformedPayloads > 0) {
    return { ok: false, error: 'Provider stream memuat potongan JSON yang rusak.', malformedPayloads };
  }

  let id = null;
  let created = null;
  let model = null;
  let finishReason = null;
  let usage = null;
  let deltaContent = '';
  let completeContent = '';
  let providerError = null;

  for (const payload of payloads) {
    if (payload.error) {
      providerError = typeof payload.error === 'string'
        ? payload.error
        : String(payload.error.message || JSON.stringify(payload.error));
    }
    if (payload.id) id = payload.id;
    if (payload.created != null) created = payload.created;
    if (payload.model) model = payload.model;
    if (payload.usage && typeof payload.usage === 'object') usage = payload.usage;

    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;

    const delta = contentText(choice.delta && choice.delta.content);
    if (delta) deltaContent += delta;

    const message = contentText(choice.message && choice.message.content);
    if (message) completeContent = message;
  }

  if (providerError) return { ok: false, error: providerError };

  const content = deltaContent || completeContent;
  if (!content) return { ok: false, error: 'Provider stream selesai tanpa isi jawaban.' };

  return {
    ok: true,
    body: JSON.stringify({
      id: id || 'chatcmpl-stream-reassembled',
      object: 'chat.completion',
      created: created || Math.floor(Date.now() / 1000),
      model: model || 'auto',
      choices: [{
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: finishReason || 'stop'
      }],
      usage: usage || undefined
    })
  };
}

function normalizeProviderResponse(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { ok: false, error: 'Respons provider kosong.' };

  const parsed = safeJson(text);
  if (parsed) return { ok: true, body: text };

  const stream = parseSseBody(text);
  if (stream) return stream;

  const withoutDone = text.replace(/(?:\r?\n)?\s*data:\s*\[DONE\]\s*$/i, '').trim();
  if (safeJson(withoutDone)) return { ok: true, body: withoutDone };

  const balanced = firstBalancedJson(text);
  if (balanced && safeJson(balanced) && balanced.length === text.length) {
    return { ok: true, body: balanced };
  }

  return { ok: false, error: 'Respons JSON provider terpotong atau tidak valid.' };
}

function normalizeProviderBody(raw) {
  const result = normalizeProviderResponse(raw);
  return result.ok ? result.body : JSON.stringify({ error: { message: result.error } });
}

function isTargetRequest(input) {
  const url = typeof input === 'string' ? input : input && input.url;
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'openagentic.id' && /\/chat\/completions\/?$/.test(parsed.pathname);
  } catch (_) {
    return false;
  }
}

function forceStreaming(init) {
  if (!init || typeof init.body !== 'string') return init;
  const payload = safeJson(init.body);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return init;
  return {
    ...init,
    headers: {
      ...(init.headers || {}),
      Accept: 'text/event-stream'
    },
    body: JSON.stringify({
      ...payload,
      stream: true,
      stream_options: {
        ...(payload.stream_options || {}),
        include_usage: true
      }
    })
  };
}

function installFetchNormalizer() {
  if (globalThis.__AUTO_CUAN_OPENAGENTIC_NORMALIZER__) return;
  if (typeof globalThis.fetch !== 'function' || typeof globalThis.Response !== 'function') return;
  const originalFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async function normalizedFetch(input, init) {
    if (!isTargetRequest(input)) return originalFetch(input, init);

    const response = await originalFetch(input, forceStreaming(init));
    const raw = await response.text();
    if (!response.ok) {
      return new Response(raw, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    }

    const normalized = normalizeProviderResponse(raw);
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    headers.set('content-type', 'application/json');

    if (!normalized.ok) {
      return new Response(JSON.stringify({ error: { message: normalized.error } }), {
        status: 502,
        statusText: 'Bad Gateway',
        headers
      });
    }

    return new Response(normalized.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  };

  globalThis.__AUTO_CUAN_OPENAGENTIC_NORMALIZER__ = true;
}

installFetchNormalizer();

module.exports = {
  safeJson,
  firstBalancedJson,
  contentText,
  parseSseBody,
  normalizeProviderResponse,
  normalizeProviderBody,
  isTargetRequest,
  forceStreaming,
  installFetchNormalizer
};