'use strict';

// ===========================================================================
// Regressions for the Analisis Saham AI path (public/index.html
// runAnalisisFromDashboard + lib/analyze-legacy.js).
//
// Three bugs, all reproduced against the pre-fix build in real Chromium before
// being fixed:
//
//  1. runAnalisisFromDashboard() never checked response.ok. /api/analyze
//     answers a rejected request with a real reason (401 no session, 403/402 no
//     premium entitlement, 429 rate limited, AI_NOT_CONFIGURED...), and every
//     one of them fell through to `rawOutput === ''` and surfaced as the single
//     generic "Analisis belum berhasil. Coba lagi." — actively wrong advice for
//     the non-retryable ones.
//  2. No request-generation guard: switching ticker quickly let an older,
//     slower response land last and repaint the panel with the WRONG emiten,
//     and point the follow-up chat context at it.
//  3. lib/analyze-legacy.js issued five upstream provider calls with no
//     timeout, so a stalled provider held the request open until the platform's
//     own 60s cap for this route killed it.
//
// LOCAL / STATIC + MOCKED ONLY. No browser, network, or backend involvement.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const legacy = require('../lib/analyze-legacy');

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, 'expected to find ' + signature + ' in public/index.html');
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces for ' + signature);
}

// --- minimal element good enough for the failure renderer -------------------
function makeElement() {
  const el = {
    innerHTML: '',
    _children: [],
    querySelector(selector) {
      // renderAnalisisFailure only ever looks up its own message paragraph.
      assert.equal(selector, 'p');
      if (!/<p\b/.test(el.innerHTML)) return null;
      const node = { textContent: '' };
      el._children.push(node);
      return node;
    },
    get renderedMessage() {
      return el._children.length ? el._children[el._children.length - 1].textContent : null;
    }
  };
  return el;
}

function loadFailureHelpers() {
  const sandbox = { Number: Number };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction(html, 'function describeAnalisisFailure('), sandbox);
  vm.runInContext(extractFunction(html, 'function renderAnalisisFailure('), sandbox);
  return sandbox;
}

// ---------------------------------------------------------------------------
// 1. Every rejection class is reported as itself, with the right retryability.
// ---------------------------------------------------------------------------
test('describeAnalisisFailure reports each rejection class as itself', () => {
  const { describeAnalisisFailure } = loadFailureHelpers();

  const noSession = describeAnalisisFailure({ status: 401 }, { success: false, error: 'Sesi tidak valid.' }, null);
  assert.equal(noSession.retryable, false, 'an expired session cannot be fixed by retrying');
  assert.match(noSession.text, /login lagi/i);

  // The exact shape api/analyze.js:31-38 returns when premium is denied.
  const noPremium = describeAnalisisFailure(
    { status: 403 },
    { success: false, code: 'PREMIUM_ACCESS_DENIED', error: 'Akses premium diperlukan.', access_level: 'free' },
    null
  );
  assert.equal(noPremium.retryable, false, 'a missing subscription cannot be fixed by retrying');
  assert.equal(noPremium.text, 'Akses premium diperlukan.', "the server's own reason must reach the user");

  const needsSub = describeAnalisisFailure({ status: 402 }, { code: 'SUBSCRIPTION_REQUIRED' }, null);
  assert.equal(needsSub.retryable, false);

  const limited = describeAnalisisFailure({ status: 429 }, { code: 'AI_RATE_LIMITED', retry_after_seconds: 42 }, null);
  assert.equal(limited.retryable, false, 'retrying a rate limit makes it worse');
  assert.match(limited.text, /42 detik/, 'the wait the server reported must be shown');

  // A rate limit with no usable hint must not print "NaN detik".
  const limitedNoHint = describeAnalisisFailure({ status: 429 }, { code: 'AI_RATE_LIMITED' }, null);
  assert.doesNotMatch(limitedNoHint.text, /NaN|undefined/);

  const notConfigured = describeAnalisisFailure({ status: 200 }, { code: 'AI_NOT_CONFIGURED' }, null);
  assert.equal(notConfigured.retryable, false);
  assert.match(notConfigured.text, /admin/i);

  const serverError = describeAnalisisFailure({ status: 503 }, {}, null);
  assert.equal(serverError.retryable, true, 'a 5xx is worth retrying');

  const aborted = describeAnalisisFailure(null, {}, { name: 'AbortError' });
  assert.equal(aborted.retryable, true);
  assert.match(aborted.text, /terlalu lama/i, 'the client timeout must be named, not disguised as a generic failure');

  const offline = describeAnalisisFailure(null, {}, new Error('Failed to fetch'));
  assert.equal(offline.retryable, true);
  assert.match(offline.text, /[Kk]oneksi/);
});

test('describeAnalisisFailure matches the contract public/stock-analysis-ai.js already uses', () => {
  const { describeAnalisisFailure } = loadFailureHelpers();
  const followUp = fs.readFileSync(path.join(ROOT, 'public', 'stock-analysis-ai.js'), 'utf8');
  const sibling = { Number: Number };
  vm.createContext(sibling);
  vm.runInContext(extractFunction(followUp, 'function describeFailure('), sibling);

  // The initial analysis and the follow-up chat hit the SAME endpoint, so they
  // must not disagree about whether a given rejection is worth retrying.
  [
    [{ status: 401 }, {}],
    [{ status: 403 }, { error: 'ditolak' }],
    [{ status: 402 }, {}],
    [{ status: 429 }, { retry_after_seconds: 9 }],
    [null, {}]
  ].forEach(([response, data]) => {
    assert.equal(
      describeAnalisisFailure(response, data, null).retryable,
      sibling.describeFailure(response, data, null).retryable,
      'retryability disagreement for status ' + (response ? response.status : 'no-response')
    );
  });
});

// ---------------------------------------------------------------------------
// 2. A server-supplied message is text, never markup.
// ---------------------------------------------------------------------------
test('renderAnalisisFailure puts the server message in textContent, never innerHTML', () => {
  const { describeAnalisisFailure, renderAnalisisFailure } = loadFailureHelpers();
  const el = makeElement();
  const hostile = '<img src=x onerror="alert(1)">';
  renderAnalisisFailure(el, describeAnalisisFailure({ status: 403 }, { error: hostile }, null));

  assert.equal(el.renderedMessage, hostile, 'the message is assigned as text');
  assert.ok(!el.innerHTML.includes('onerror'), 'the server string must never be concatenated into innerHTML');
  assert.ok(!el.innerHTML.includes('<img'), 'the server string must never be concatenated into innerHTML');
});

test('renderAnalisisFailure only invites a retry when retrying can work', () => {
  const { describeAnalisisFailure, renderAnalisisFailure } = loadFailureHelpers();

  const denied = makeElement();
  renderAnalisisFailure(denied, describeAnalisisFailure({ status: 403 }, { error: 'Akses premium diperlukan.' }, null));
  assert.ok(!/bisa mencoba lagi/i.test(denied.innerHTML), 'a non-retryable failure must not tell the user to retry');

  const transient = makeElement();
  renderAnalisisFailure(transient, describeAnalisisFailure({ status: 503 }, {}, null));
  assert.match(transient.innerHTML, /bisa mencoba lagi/i);
});

// ---------------------------------------------------------------------------
// 3. The request-generation guard.
// ---------------------------------------------------------------------------
function runAnalysisHarness() {
  const results = { painted: [], contextUpdates: [] };
  const resultArea = {
    set innerHTML(value) { results.painted.push(String(value)); resultArea._html = String(value); },
    get innerHTML() { return resultArea._html || ''; },
    querySelector() { return { set textContent(v) { results.painted.push('TEXT:' + v); }, get textContent() { return ''; } }; }
  };
  const followUp = { classList: { remove() {}, add() {} } };

  const sandbox = {
    Number, JSON, String, Math, Date, Array, Object, Boolean, Promise, Error,
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    AbortController,
    results,
    document: {
      getElementById(id) {
        if (id === 'analisisResult') return resultArea;
        if (id === 'analisisFollowUp') return followUp;
        return null;
      }
    },
    localStorage: { getItem() { return ''; }, setItem() {} },
    // Collaborators runAnalisisFromDashboard calls unguarded.
    isIndexTicker: () => false,
    canAnalyze: () => true,
    getAnalysisLimitMsg: () => 'limit',
    buildManualConfluenceHtml: () => '<div class="confluence"></div>',
    incrementAnalysisUsage: () => {},
    setActiveTicker: () => {},
    getCompanyName: () => null,
    buildContextForApi: () => ({}),
    fetchQuoteContext: async () => '',
    updateAnalysisContext: (ticker, htmlOut) => { results.contextUpdates.push(ticker); },
    logUsage: () => {},
    isNetworkError: () => false,
    clientSanitizeFCA: (x) => x,
    sanitizeAIHtml: (x) => x,
    normalizeFinalStockHtml: (x) => x,
    sanitizeIHSGOutput: (x) => x,
    reorderBrokerCTA: (x) => x,
    convertStrayMarkdownBold: (x) => x
  };
  vm.createContext(sandbox);
  vm.runInContext('var _analisisRequestSeq = 0; var ANALISIS_REQUEST_TIMEOUT_MS = 70000;', sandbox);
  vm.runInContext(extractFunction(html, 'function describeAnalisisFailure('), sandbox);
  vm.runInContext(extractFunction(html, 'function renderAnalisisFailure('), sandbox);
  vm.runInContext(extractFunction(html, 'async function runAnalisisFromDashboard('), sandbox);
  return { sandbox, results };
}

test('a slow earlier analysis never overwrites the ticker the user asked for last', async () => {
  const { sandbox, results } = runAnalysisHarness();

  // First call answers LAST; second answers immediately.
  let call = 0;
  sandbox.fetch = (url, options) => {
    const body = JSON.parse(options.body);
    const ticker = /\b([A-Z]{4})\b/.exec(body.chatMessage)[1];
    const delay = ++call === 1 ? 60 : 0;
    return new Promise((resolve) => setTimeout(() => resolve({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ html: '<p>ANALYSIS FOR ' + ticker + '</p>' })
    }), delay));
  };

  const first = sandbox.runAnalisisFromDashboard('BBCA');
  await new Promise((r) => setTimeout(r, 10));
  const second = sandbox.runAnalisisFromDashboard('BBRI');
  await Promise.all([first, second]);
  await new Promise((r) => setTimeout(r, 80));

  const finalPaint = results.painted[results.painted.length - 1];
  assert.match(finalPaint, /ANALYSIS FOR BBRI/, 'the panel must show the ticker the user asked for last');
  assert.doesNotMatch(finalPaint, /ANALYSIS FOR BBCA/, 'the stale response must never repaint the panel');

  // The follow-up chat context must not be pointed at the abandoned ticker.
  assert.deepEqual(results.contextUpdates, ['BBRI']);
});

test('a rejected analysis surfaces the server reason instead of the generic retry line', async () => {
  const { sandbox, results } = runAnalysisHarness();
  sandbox.fetch = async () => ({
    ok: false,
    status: 403,
    headers: { get: () => 'application/json' },
    json: async () => ({ success: false, code: 'PREMIUM_ACCESS_DENIED', error: 'Akses premium diperlukan.' })
  });

  await sandbox.runAnalisisFromDashboard('BBCA');

  const shown = results.painted.join(' | ');
  assert.match(shown, /Akses premium diperlukan\./);
  assert.doesNotMatch(shown, /Analisis belum berhasil/, 'the real reason must replace the generic message');
  assert.deepEqual(results.contextUpdates, [], 'a rejected analysis must not become follow-up context');
});

// ---------------------------------------------------------------------------
// 4. Upstream provider calls are bounded.
// ---------------------------------------------------------------------------
test('fetchWithTimeout aborts a stalled upstream instead of holding the request open', async () => {
  const { fetchWithTimeout } = legacy.__test;
  const originalFetch = globalThis.fetch;

  // A provider that never answers, and only settles when the signal aborts.
  globalThis.fetch = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });

  try {
    const started = Date.now();
    await assert.rejects(() => fetchWithTimeout('https://example.invalid', { method: 'POST' }, 50),
      (err) => err.name === 'AbortError');
    assert.ok(Date.now() - started < 2000, 'it must give up promptly, not hang');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchWithTimeout clears its timer so a fast response leaves nothing pending', async () => {
  const { fetchWithTimeout } = legacy.__test;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200 });
  try {
    const response = await fetchWithTimeout('https://example.invalid', {}, 60000);
    assert.equal(response.ok, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  // If the 60s timer were still armed the process would stay alive past this
  // test; node:test would then report the run as hanging.
});

test('two chained provider calls still fit inside the route 60s ceiling', () => {
  const { UPSTREAM_TIMEOUT_MS, UPSTREAM_TIMEOUT_CHAINED_MS } = legacy.__test;
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const routeCapMs = vercel.functions['api/analyze.js'].maxDuration * 1000;

  // handleChartDeepSeek runs first and handleChartVision is its fallback, so
  // the worst case is both timing out back to back in one request.
  assert.ok(UPSTREAM_TIMEOUT_CHAINED_MS * 2 < routeCapMs,
    'chained provider timeouts (' + (UPSTREAM_TIMEOUT_CHAINED_MS * 2) + 'ms) must stay under the route cap (' + routeCapMs + 'ms)');
  assert.ok(UPSTREAM_TIMEOUT_MS < routeCapMs);
});

test('no upstream provider call in lib/analyze-legacy.js is left unbounded', () => {
  const source = fs.readFileSync(path.join(ROOT, 'lib', 'analyze-legacy.js'), 'utf8');
  const lines = source.split('\n');

  lines.forEach((line, index) => {
    if (!/await fetch\(/.test(line)) return;
    // The one bare fetch left is inside fetchWithTimeout itself, which supplies
    // the signal. Every other call site must either pass its own signal or go
    // through the helper; check the enclosing function has an AbortController.
    const before = lines.slice(Math.max(0, index - 40), index).join('\n');
    assert.match(
      before, /new AbortController\(\)/,
      'unbounded upstream fetch at lib/analyze-legacy.js:' + (index + 1) + ' — a stalled provider would hold the whole request open'
    );
  });
});
