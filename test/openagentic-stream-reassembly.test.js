'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseSseBody,
  normalizeProviderResponse,
  forceStreaming
} = require('../tools/openagentic-response-normalizer');

test('reassembles all SSE deltas into one valid chat completion', () => {
  const raw = [
    'data: {"id":"abc","model":"auto","choices":[{"index":0,"delta":{"content":"{\\"status\\": "},"finish_reason":null}]}',
    '',
    'data: {"id":"abc","model":"auto","choices":[{"index":0,"delta":{"content":"\\"OK\\"}"},"finish_reason":"stop"}]}',
    '',
    'data: {"id":"abc","model":"auto","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}',
    '',
    'data: [DONE]',
    ''
  ].join('\n');

  const result = parseSseBody(raw);
  assert.equal(result.ok, true);
  const parsed = JSON.parse(result.body);
  assert.equal(parsed.choices[0].message.content, '{"status": "OK"}');
  assert.deepEqual(parsed.usage, {
    prompt_tokens: 10,
    completion_tokens: 4,
    total_tokens: 14
  });
});

test('rejects a stream that ends without DONE', () => {
  const raw = 'data: {"choices":[{"delta":{"content":"partial"}}]}\n';
  const result = normalizeProviderResponse(raw);
  assert.equal(result.ok, false);
  assert.match(result.error, /terputus/i);
});

test('rejects truncated non-stream JSON instead of salvaging partial content', () => {
  const result = normalizeProviderResponse('{"choices":[{"message":{"content":"partial');
  assert.equal(result.ok, false);
  assert.match(result.error, /terpotong|tidak valid/i);
});

test('forces streaming and usage reporting for OpenAgentic requests', () => {
  const init = forceStreaming({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4.6', stream: false })
  });
  const body = JSON.parse(init.body);
  assert.equal(body.stream, true);
  assert.equal(body.stream_options.include_usage, true);
  assert.equal(init.headers.Accept, 'text/event-stream');
});