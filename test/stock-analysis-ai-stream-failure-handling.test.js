'use strict';

// Audit follow-up on PR #491 (fix/auth-and-ai-ui-integration): the SSE
// contract tests in stock-analysis-ai-streaming-contract.test.js only cover
// consumeSSELines() in isolation and static regex checks against send()'s
// source text — they never actually execute send() end-to-end, so a mid-stream
// failure was never exercised.
//
// This test extracts the real send() function (and the real describeFailure()
// it calls) from public/stock-analysis-ai.js and runs it against a fully
// mocked fetch/reader/DOM — no live network. It exists to first PROVE the gap
// (a stream that fails partway through, or that hangs past the client
// timeout, never cleans up the in-progress streaming bubble because
// removeStreamingBubble() is only called on the happy path) and then, once
// fixed, lock the corrected behavior in place.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const JS_PATH = path.resolve(__dirname, '..', 'public', 'stock-analysis-ai.js');
const src = fs.readFileSync(JS_PATH, 'utf8');

function extractFunction(source, signature) {
  var start = source.indexOf(signature);
  if (start < 0) return null;
  var i = source.indexOf('{', start);
  var depth = 0;
  for (var j = i; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}') { depth--; if (depth === 0) return source.slice(start, j + 1); }
  }
  return null;
}

function realDescribeFailure() {
  var fnSrc = extractFunction(src, 'function describeFailure');
  assert.ok(fnSrc, 'describeFailure must exist');
  return new Function(fnSrc + '\nreturn describeFailure;')();
}

function realConsumeSSELines() {
  var fnSrc = extractFunction(src, 'function consumeSSELines');
  assert.ok(fnSrc, 'consumeSSELines must exist');
  return new Function(fnSrc + '\nreturn consumeSSELines;')();
}

function mkAbortError() {
  var e = new Error('The operation was aborted.');
  e.name = 'AbortError';
  return e;
}

// Builds a mock fetch Response whose SSE body reader's read() calls are
// driven by `behavior(callIndex, signal)`, returning a Promise.
function mockStreamResponse(behavior, signal) {
  var callIndex = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: function (k) { return String(k).toLowerCase() === 'content-type' ? 'text/event-stream' : null; } },
    body: {
      getReader: function () {
        return { read: function () { return behavior(callIndex++, signal); } };
      }
    }
  };
}

function sseFrame(chunk) {
  return new TextEncoder().encode('data: ' + JSON.stringify({ chunk: chunk }) + '\n\n');
}

function makeSendHarness(fetchImpl, timeoutMs) {
  var fnSrc = extractFunction(src, 'async function send');
  assert.ok(fnSrc, 'send must exist');

  var calls = {
    appendStreamingBubble: 0,
    removeStreamingBubble: 0,
    appendNotice: [],
    appendAssistant: [],
    appendLoading: 0,
    removeLoading: 0,
    setBusy: [],
    writeHistory: []
  };
  var bubbleEl = { textContent: '' };

  var params = {
    sending: false,
    byId: function (id) {
      if (id === 'analysisChatInput') return { value: '', disabled: false };
      if (id === 'analysisSendBtn') return { disabled: false, setAttribute: function () {} };
      return null;
    },
    currentTicker: function () { return 'BBCA'; },
    analysisSnapshot: function () { return 'BBCA breakout candidate, snapshot text.'; },
    readHistory: function () { return []; },
    writeHistory: function (ticker, rows) { calls.writeHistory.push({ ticker: ticker, rows: rows.slice() }); },
    lastQuestion: '',
    removeRetry: function () {},
    appendUser: function () {},
    setBusy: function (active) { calls.setBusy.push(active); },
    appendLoading: function () { calls.appendLoading++; },
    removeLoading: function () { calls.removeLoading++; },
    appendStreamingBubble: function () { calls.appendStreamingBubble++; bubbleEl.textContent = ''; return bubbleEl; },
    removeStreamingBubble: function () { calls.removeStreamingBubble++; },
    consumeSSELines: realConsumeSSELines(),
    describeFailure: realDescribeFailure(),
    appendNotice: function (text, retryable) { calls.appendNotice.push({ text: text, retryable: retryable }); },
    appendAssistant: function (text, options) { calls.appendAssistant.push({ text: text, options: options }); },
    REQUEST_TIMEOUT_MS: timeoutMs != null ? timeoutMs : 70000,
    AbortController: global.AbortController,
    TextDecoder: global.TextDecoder,
    fetch: fetchImpl,
    controller: null
  };

  var keys = Object.keys(params);
  var factory = new Function(keys.join(','), fnSrc + '\nreturn send;');
  var send = factory.apply(null, keys.map(function (k) { return params[k]; }));

  return { send: send, calls: calls, bubbleEl: bubbleEl, input: params.byId('analysisChatInput') };
}

// ---- Baseline: normal completion still works through the real send() ----

test('send(): a clean stream still renders the final answer and writes history', async () => {
  var fetchImpl = async function () {
    return mockStreamResponse(function (i) {
      if (i === 0) return Promise.resolve({ done: false, value: sseFrame('BBCA ') });
      if (i === 1) return Promise.resolve({ done: false, value: sseFrame('breakout confirmed.') });
      return Promise.resolve({ done: true });
    });
  };
  var h = makeSendHarness(fetchImpl);
  await h.send('Gimana BBCA?');

  assert.equal(h.calls.appendStreamingBubble, 1);
  assert.equal(h.calls.removeStreamingBubble, 1, 'the streaming bubble must be removed once the answer is finalized');
  assert.equal(h.calls.appendNotice.length, 0);
  assert.equal(h.calls.appendAssistant.length, 1);
  assert.equal(h.calls.appendAssistant[0].text, 'BBCA breakout confirmed.');
  assert.equal(h.calls.writeHistory.length, 1, 'a real model answer must be saved to history');
});

// ---- Gap #1: mid-stream disconnect ----

test('send(): a stream that dies mid-flight must still remove the streaming bubble and show a clear error (no dangling partial UI)', async () => {
  var fetchImpl = async function () {
    return mockStreamResponse(function (i) {
      if (i === 0) return Promise.resolve({ done: false, value: sseFrame('BBCA sedang ') });
      // Simulate a dropped connection: the second read() rejects, exactly what
      // a real ReadableStreamDefaultReader does on a network failure mid-stream.
      return Promise.reject(new TypeError('Failed to fetch'));
    });
  };
  var h = makeSendHarness(fetchImpl);
  await h.send('Gimana BBCA?');

  assert.equal(h.calls.appendStreamingBubble, 1);
  assert.equal(h.calls.removeStreamingBubble, 1,
    'BUG: the streaming bubble is left in the DOM forever when reader.read() rejects mid-stream, ' +
    'because removeStreamingBubble() was only called on the loop\'s normal-completion path, not in a finally.');
  assert.equal(h.calls.appendAssistant.length, 0, 'a partial, unverified reply must never be presented as the final answer');
  assert.equal(h.calls.appendNotice.length, 1, 'the user must see exactly one clear, actionable error');
  assert.equal(h.calls.appendNotice[0].retryable, true);
});

// ---- Gap #2: a stream that hangs past the client-side timeout ----

test('send(): a stream that never emits an event is aborted at the client timeout, cleans up, and reports it clearly', async () => {
  var fetchImpl = async function (url, opts) {
    var signal = opts && opts.signal;
    return mockStreamResponse(function () {
      // Never resolves on its own — mirrors a genuinely hung SSE connection.
      // Rejects only when the shared AbortController fires, exactly like a
      // real browser's fetch/ReadableStreamDefaultReader on abort().
      return new Promise(function (resolve, reject) {
        if (signal && signal.aborted) { reject(mkAbortError()); return; }
        if (signal) signal.addEventListener('abort', function () { reject(mkAbortError()); });
      });
    }, signal);
  };
  var h = makeSendHarness(fetchImpl, 25); // 25ms timeout instead of the real 70s, same mechanism
  await h.send('Gimana BBCA?');

  assert.equal(h.calls.appendStreamingBubble, 1);
  assert.equal(h.calls.removeStreamingBubble, 1,
    'a hung stream must not leave the streaming bubble on screen once the client-side timeout fires');
  assert.equal(h.calls.appendAssistant.length, 0);
  assert.equal(h.calls.appendNotice.length, 1);
  assert.equal(h.calls.appendNotice[0].text, 'Permintaan dihentikan karena terlalu lama. Coba lagi ya.');
  assert.equal(h.calls.appendNotice[0].retryable, true);
});

// ---- Regression guard: repeated failures must not accumulate dangling bubbles ----

test('send(): two consecutive mid-stream failures each clean up their own bubble (no duplicate #stockAiStreamWrap left behind)', async () => {
  var fetchImpl = async function () {
    return mockStreamResponse(function (i) {
      if (i === 0) return Promise.resolve({ done: false, value: sseFrame('partial ') });
      return Promise.reject(new TypeError('Failed to fetch'));
    });
  };
  var h = makeSendHarness(fetchImpl);
  await h.send('Pertanyaan 1');
  await h.send('Pertanyaan 2');

  assert.equal(h.calls.appendStreamingBubble, 2);
  assert.equal(h.calls.removeStreamingBubble, 2, 'every failed stream must clean up its own bubble, or duplicate-id elements pile up in the DOM');
});
