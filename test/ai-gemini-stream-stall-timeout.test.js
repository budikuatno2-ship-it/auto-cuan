'use strict';

// Regression coverage for the Gemini provider's abort timer.
//
// Both entry points cleared the timeout as soon as the fetch promise resolved
// — i.e. as soon as response HEADERS arrived — and only then read the body.
// That left the body read completely unbounded:
//
//   streamGeminiAnalysis: clearTimeout(timer) then await parseSseStream(res.body)
//   generateGeminiContent: clearTimeout(timer) then await res.json()
//
// lib/context-ai-router-v7.js:393 and :449 pass timeoutMs: 9000 and wrap the
// call in no outer timeout of their own, so a Gemini stream that delivered
// headers and then went silent hung the serverless invocation forever. The
// router's local-deterministic fallback never ran, because nothing ever threw.
//
// The timer must therefore stay armed across the body read. For the streaming
// path it becomes a STALL timer (rearmed on every chunk) so that legitimately
// long answers are not truncated; only genuine silence aborts.

const test = require('node:test');
const assert = require('node:assert/strict');

const { streamGeminiAnalysis, generateGeminiContent } = require('../lib/ai-gemini-provider');

const KEY = 'mock-gemini-key';

// Settles either way, but never lets a hang hang the suite.
async function settlesWithin(ms, promise) {
  let timer;
  const sentinel = Symbol('did-not-settle');
  const guard = new Promise(resolve => { timer = setTimeout(() => resolve(sentinel), ms); });
  try {
    const outcome = await Promise.race([
      promise.then(value => ({ ok: true, value }), error => ({ ok: false, error })),
      guard
    ]);
    if (outcome === sentinel) return { settled: false };
    return Object.assign({ settled: true }, outcome);
  } finally {
    clearTimeout(timer);
  }
}

function sseLine(text) {
  return 'data: {"candidates":[{"content":{"parts":[{"text":' + JSON.stringify(text) + '}]}}]}\n\n';
}

// Models real fetch: aborting the signal errors the response body stream.
function streamResponse(signal, produce) {
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        let closed = false;
        const fail = () => {
          if (closed) return;
          closed = true;
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          try { controller.error(err); } catch (_) {}
        };
        if (signal) {
          if (signal.aborted) return fail();
          signal.addEventListener('abort', fail, { once: true });
        }
        produce({
          push(text) { if (!closed) controller.enqueue(new TextEncoder().encode(text)); },
          close() { if (!closed) { closed = true; try { controller.close(); } catch (_) {} } }
        });
      }
    })
  };
}

// ---------------------------------------------------------------------------
// Streaming path
// ---------------------------------------------------------------------------

test('a stream that stalls after the first chunk rejects instead of hanging', async () => {
  const fetchFn = async (_url, init) => streamResponse(init && init.signal, (sink) => {
    sink.push(sseLine('mulai'));
    // then nothing, ever: the stream is never closed and never errored
  });

  const outcome = await settlesWithin(4000, streamGeminiAnalysis({
    prompt: 'Analisis BBCA',
    apiKey: KEY,
    fetchFn,
    timeoutMs: 250,
    onChunk: () => {}
  }).catch(err => { throw err; }));

  assert.equal(outcome.settled, true, 'stalled stream never settled — the invocation hangs');
  assert.equal(outcome.ok, false, 'a stalled stream must reject');
  assert.equal(outcome.error.code, 'GEMINI_TIMEOUT');
});

test('a stream that never sends any body byte rejects', async () => {
  const fetchFn = async (_url, init) => streamResponse(init && init.signal, () => {});
  const outcome = await settlesWithin(4000, streamGeminiAnalysis({
    prompt: 'x', apiKey: KEY, fetchFn, timeoutMs: 250
  }));
  assert.equal(outcome.settled, true, 'silent stream never settled');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'GEMINI_TIMEOUT');
});

test('a slow but steadily progressing stream is NOT aborted', async () => {
  // Ten chunks, each well inside the stall window, total far beyond it. This is
  // the behaviour a naive total-deadline fix would break.
  const fetchFn = async (_url, init) => streamResponse(init && init.signal, (sink) => {
    let index = 0;
    const tick = () => {
      if (index < 10) { sink.push(sseLine('bagian' + index + ' ')); index++; setTimeout(tick, 60); }
      else { sink.push('data: [DONE]\n\n'); sink.close(); }
    };
    setTimeout(tick, 60);
  });

  const outcome = await settlesWithin(6000, streamGeminiAnalysis({
    prompt: 'x', apiKey: KEY, fetchFn, timeoutMs: 400
  }));
  assert.equal(outcome.settled, true);
  assert.ok(outcome.ok, 'steady stream must not be aborted: ' + (outcome.error && outcome.error.code));
  assert.equal(outcome.value.text, 'bagian0 bagian1 bagian2 bagian3 bagian4 bagian5 bagian6 bagian7 bagian8 bagian9 ');
});

test('the connect timeout still applies when the fetch itself never resolves', async () => {
  const fetchFn = (_url, init) => new Promise((_resolve, reject) => {
    const signal = init && init.signal;
    if (signal) signal.addEventListener('abort', () => {
      const err = new Error('aborted'); err.name = 'AbortError'; reject(err);
    }, { once: true });
  });
  const outcome = await settlesWithin(4000, streamGeminiAnalysis({
    prompt: 'x', apiKey: KEY, fetchFn, timeoutMs: 250
  }));
  assert.equal(outcome.settled, true);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'GEMINI_TIMEOUT');
});

test('a normal completed stream still returns its accumulated text', async () => {
  const received = [];
  const fetchFn = async (_url, init) => streamResponse(init && init.signal, (sink) => {
    sink.push(sseLine('Analisis '));
    sink.push(sseLine('BBCA.'));
    sink.push('data: [DONE]\n\n');
    sink.close();
  });
  const outcome = await settlesWithin(4000, streamGeminiAnalysis({
    prompt: 'x', apiKey: KEY, fetchFn, timeoutMs: 1000, onChunk: c => received.push(c)
  }));
  assert.equal(outcome.settled, true);
  assert.ok(outcome.ok, outcome.error && outcome.error.message);
  assert.equal(outcome.value.text, 'Analisis BBCA.');
  assert.deepEqual(received, ['Analisis ', 'BBCA.']);
});

test('the stall timer is cleared once the stream completes', async () => {
  // A leaked timer would keep the event loop alive past the call. Node's test
  // runner does not fail on that by itself, so assert it directly.
  const before = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
  const fetchFn = async (_url, init) => streamResponse(init && init.signal, (sink) => {
    sink.push(sseLine('ok'));
    sink.close();
  });
  await streamGeminiAnalysis({ prompt: 'x', apiKey: KEY, fetchFn, timeoutMs: 30000 });
  const after = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
  assert.ok(after <= before, 'a timer outlived the call (before=' + before + ' after=' + after + ')');
});

// ---------------------------------------------------------------------------
// Non-streaming path
// ---------------------------------------------------------------------------

test('a response whose json() never resolves rejects instead of hanging', async () => {
  const fetchFn = async (_url, init) => ({
    ok: true,
    status: 200,
    json: () => new Promise((_resolve, reject) => {
      const signal = init && init.signal;
      if (signal) signal.addEventListener('abort', () => {
        const err = new Error('aborted'); err.name = 'AbortError'; reject(err);
      }, { once: true });
    })
  });

  const outcome = await settlesWithin(4000, generateGeminiContent({
    prompt: 'x', apiKey: KEY, fetchFn, timeoutMs: 250
  }));
  assert.equal(outcome.settled, true, 'hanging json() never settled — the invocation hangs');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'GEMINI_TIMEOUT');
});

test('a normal non-streaming response is unaffected', async () => {
  const fetchFn = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: 'Analisis BBCA.' }] } }],
      usageMetadata: { totalTokenCount: 42 }
    })
  });
  const result = await generateGeminiContent({ prompt: 'x', apiKey: KEY, fetchFn, timeoutMs: 1000 });
  assert.equal(result.text, 'Analisis BBCA.');
  assert.equal(result.source, 'gemini_api');
  assert.deepEqual(result.usage, { totalTokenCount: 42 });
});

test('an HTTP error is still reported as GEMINI_HTTP_ERROR, not as a timeout', async () => {
  const fetchFn = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  const outcome = await settlesWithin(4000, generateGeminiContent({
    prompt: 'x', apiKey: KEY, fetchFn, timeoutMs: 1000
  }));
  assert.equal(outcome.settled, true);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'GEMINI_HTTP_ERROR');
});

test('a 429 is still reported as GEMINI_RATE_LIMITED', async () => {
  const fetchFn = async () => ({ ok: false, status: 429, text: async () => 'slow down' });
  const outcome = await settlesWithin(4000, generateGeminiContent({
    prompt: 'x', apiKey: KEY, fetchFn, timeoutMs: 1000
  }));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'GEMINI_RATE_LIMITED');
});
