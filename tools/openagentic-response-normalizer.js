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

function normalizeProviderBody(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text || safeJson(text)) return text;

  const withoutDone = text.replace(/(?:\r?\n)?\s*data:\s*\[DONE\]\s*$/i, '').trim();
  if (safeJson(withoutDone)) return withoutDone;

  const ssePayloads = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^data:\s*/i.test(line) && !/^data:\s*\[DONE\]\s*$/i.test(line))
    .map((line) => line.replace(/^data:\s*/i, '').trim())
    .filter(Boolean);
  for (const payload of ssePayloads) if (safeJson(payload)) return payload;

  const balanced = firstBalancedJson(text);
  return balanced && safeJson(balanced) ? balanced : text;
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

function installFetchNormalizer() {
  if (globalThis.__AUTO_CUAN_OPENAGENTIC_NORMALIZER__) return;
  if (typeof globalThis.fetch !== 'function' || typeof globalThis.Response !== 'function') return;
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async function normalizedFetch(input, init) {
    const response = await originalFetch(input, init);
    if (!isTargetRequest(input)) return response;
    const raw = await response.text();
    const normalized = normalizeProviderBody(raw);
    return new Response(normalized, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  };
  globalThis.__AUTO_CUAN_OPENAGENTIC_NORMALIZER__ = true;
}

installFetchNormalizer();

module.exports = { safeJson, firstBalancedJson, normalizeProviderBody, isTargetRequest, installFetchNormalizer };
