'use strict';

// ===========================================================================
// Regression BUG-018: three upstream fetches in api/sector-hot.js had no
// timeout.
//
//   callAIConfirmation      — POST <SCREENER_AI_BASE_URL>/chat/completions
//   fetchScreenerCandles    — GET  query2.finance.yahoo.com (90d candles)
//   fetchYahooQuote         — GET  query2.finance.yahoo.com (60d quote)
//
// Node's fetch has no built-in response timeout. An upstream that completes the
// TCP handshake and then goes quiet is waited on until the serverless function
// itself is killed. The two Yahoo calls run per-ticker inside the screener
// loop, so a single hung upstream consumes the whole run's time budget rather
// than failing one ticker.
//
// Two things are asserted here, and they fail for different reasons:
//
//   1. Behaviour — fetchWithTimeout actually aborts a hung upstream. Proven
//      against a real HTTP server that accepts the connection and then never
//      writes a response. No mocking of fetch.
//   2. Wiring — the three call sites go through it. Without this, someone can
//      reintroduce a bare `await fetch(` at any of them and part 1 still
//      passes while production hangs again.
//
// LOCAL ONLY. The server is bound to 127.0.0.1 on an ephemeral port; nothing
// leaves the machine and no Yahoo/AI credentials are involved.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'api', 'sector-hot.js'), 'utf8');
const sectorHot = require('../api/sector-hot.js');
const T = sectorHot.__test;

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

// Registers teardown with the test context BEFORE the body can throw. Without
// this an assertion failure leaves the listener (and any held-open response)
// on the event loop and node --test hangs instead of reporting the failure.
function listen(t, server) {
  const held = [];
  server.on('request', (req, res) => held.push(res));
  t.after(async () => {
    held.forEach((res) => { try { res.destroy(); } catch (_) {} });
    server.closeAllConnections?.();
    await close(server);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// --- 1. Behaviour -----------------------------------------------------------

test('fetchWithTimeout aborts an upstream that accepts the connection then goes silent', async (t) => {
  const server = http.createServer(() => { /* never respond */ });
  const port = await listen(t, server);

  const started = Date.now();
  let error = null;
  try {
    await T.fetchWithTimeout('http://127.0.0.1:' + port + '/hang', {}, 300);
  } catch (err) {
    error = err;
  }
  const elapsed = Date.now() - started;

  assert.ok(error, 'expected the hung request to reject, not hang');
  assert.equal(error.name, 'AbortError', 'expected an AbortError, got: ' + error.name + ' / ' + error.message);
  assert.ok(elapsed < 3000, 'expected the abort near the 300ms bound, took ' + elapsed + 'ms');
});

test('fetchWithTimeout returns the response normally when the upstream answers in time', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const port = await listen(t, server);

  const response = await T.fetchWithTimeout('http://127.0.0.1:' + port + '/fast', {}, 5000);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('fetchWithTimeout forwards method, headers and body to the upstream', async (t) => {
  let seen = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen = { method: req.method, auth: req.headers.authorization, body: body };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  const port = await listen(t, server);

  await T.fetchWithTimeout('http://127.0.0.1:' + port + '/echo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' },
    body: JSON.stringify({ hello: 'world' })
  }, 5000);

  assert.equal(seen.method, 'POST');
  assert.equal(seen.auth, 'Bearer test-token');
  assert.equal(seen.body, '{"hello":"world"}');
});

test('fetchWithTimeout clears its timer so a completed call leaves no pending handle', async (t) => {
  const server = http.createServer((req, res) => { res.end('ok'); });
  const port = await listen(t, server);

  const before = process._getActiveHandles().length;
  await T.fetchWithTimeout('http://127.0.0.1:' + port + '/x', {}, 30000);
  // A leaked 30s timer would keep the event loop alive well past this test.
  const after = process._getActiveHandles().length;
  assert.ok(after <= before + 1, 'expected no lingering timer handle (before=' + before + ', after=' + after + ')');
});

// --- 2. Wiring --------------------------------------------------------------

test('the timeout bounds are configured and sane', () => {
  assert.equal(typeof T.YAHOO_FETCH_TIMEOUT_MS, 'number');
  assert.equal(typeof T.SCREENER_AI_TIMEOUT_MS, 'number');
  // Not so tight that a slow-but-healthy upstream is cut off. api/quote.js:488
  // already runs the same Yahoo host at 8s in production, and this file's own
  // other Yahoo calls use 5s and 10s, so the bound must be at least as generous.
  assert.ok(T.YAHOO_FETCH_TIMEOUT_MS >= 10000, 'Yahoo bound must not be tighter than the 10s already used in this file');
  assert.ok(T.SCREENER_AI_TIMEOUT_MS >= 15000, 'AI bound must leave room for a real completion');
  // And not so loose that it cannot fire inside the function's own ceiling.
  assert.ok(T.YAHOO_FETCH_TIMEOUT_MS <= 30000);
  assert.ok(T.SCREENER_AI_TIMEOUT_MS <= 45000);
});

test('no upstream fetch in api/sector-hot.js is left unbounded', () => {
  // Every `await fetch(` must either be the one inside fetchWithTimeout itself
  // or carry its own AbortController signal. Two call sites in this file
  // (fetchLatestPriceForMonitor, fetchNkQuoteData) already had their own.
  const lines = SOURCE.split('\n');
  const offenders = [];

  lines.forEach((line, idx) => {
    if (!/await fetch\(/.test(line)) return;
    if (/controller\.signal/.test(line)) return; // the wrapper's own call
    // Look ahead through the options object for a signal.
    const window = lines.slice(idx, idx + 12).join('\n');
    if (/signal:\s*\w*[Cc]ontroller\.signal/.test(window)) return;
    offenders.push((idx + 1) + ': ' + line.trim());
  });

  assert.deepEqual(offenders, [], 'unbounded upstream fetch(es) found:\n' + offenders.join('\n'));
});

test('callAIConfirmation sends its request through fetchWithTimeout', () => {
  const start = SOURCE.indexOf('async function callAIConfirmation(');
  assert.ok(start > 0, 'callAIConfirmation not found');
  const body = SOURCE.slice(start, SOURCE.indexOf('\n}', start));
  assert.ok(
    /await fetchWithTimeout\(baseUrl \+ '\/chat\/completions'/.test(body),
    'callAIConfirmation must call the AI endpoint through fetchWithTimeout'
  );
  assert.ok(/SCREENER_AI_TIMEOUT_MS/.test(body), 'callAIConfirmation must pass the AI timeout bound');
});

['fetchScreenerCandles', 'fetchYahooQuote'].forEach((name) => {
  test(name + ' fetches Yahoo through fetchWithTimeout', () => {
    const start = SOURCE.indexOf('async function ' + name + '(');
    assert.ok(start > 0, name + ' not found');
    const body = SOURCE.slice(start, SOURCE.indexOf('\n}', start));
    assert.ok(/await fetchWithTimeout\(url,/.test(body), name + ' must go through fetchWithTimeout');
    assert.ok(/YAHOO_FETCH_TIMEOUT_MS/.test(body), name + ' must pass the Yahoo timeout bound');
  });
});
