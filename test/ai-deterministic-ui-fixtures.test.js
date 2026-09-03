'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

function loadRenderer() {
  const body = { nodeType:1, matches(){ return false; }, querySelectorAll(){ return []; } };
  const document = {
    readyState:'complete', body,
    head:{ appendChild(){} },
    createElement(){ return { id:'', textContent:'', style:{}, appendChild(){} }; },
    addEventListener(){}
  };
  class MutationObserver { observe(){} }
  const window = {};
  const context = vm.createContext({ window, document, MutationObserver, console });
  vm.runInContext(read('public/ai-chat-renderer.js'), context, { filename:'ai-chat-renderer.js' });
  return window.AutoCuanAI;
}

test('long AI answer fixture renders completely without raw active HTML', () => {
  const renderer = loadRenderer();
  const parts = [];
  for (let i = 1; i <= 180; i += 1) {
    parts.push('### Bagian ' + i);
    parts.push('Pembacaan ke-' + i + ': **fakta snapshot** tetap dipisahkan dari opini dan risiko.');
  }
  parts.push('<script>alert(1)</script>');
  const html = renderer.renderMarkdown(parts.join('\n'));

  assert.match(html, /Bagian 1/);
  assert.match(html, /Bagian 180/);
  assert.match(html, /Pembacaan ke-180/);
  assert.doesNotMatch(html, /<script>/i);
  assert.match(html, /&lt;script&gt;/i);
  assert.ok(html.length > 15000, 'long answer was unexpectedly truncated');
});

test('wide and long structured table fixture remains inside the scroll wrapper', () => {
  const renderer = loadRenderer();
  const headers = ['Ticker','Harga','Entry','Stop','TP1','TP2','RSI','Volume'];
  const rows = ['| ' + headers.join(' | ') + ' |', '| ' + headers.map(() => '---').join(' | ') + ' |'];
  for (let i = 1; i <= 60; i += 1) {
    rows.push('| T' + String(i).padStart(3, '0') + ' | ' + (100+i) + ' | ' + (95+i) + ' | ' + (90+i) + ' | ' + (110+i) + ' | ' + (120+i) + ' | ' + (40 + (i % 30)) + ' | ' + i + 'x |');
  }
  const html = renderer.renderMarkdown(rows.join('\n'));
  assert.match(html, /class="ai-table-wrap"/);
  assert.match(html, /<table>/);
  assert.match(html, /T001/);
  assert.match(html, /T060/);
  assert.equal((html.match(/<tr>/g) || []).length, 61);
});

test('mobile long-answer fixture has a bounded readable scroll region, not clipped content', () => {
  const source = read('public/ai-chat-renderer.js');
  assert.match(source, /#chatMessages\.ai-followup-scroll-region\{[^}]*overflow-y:auto/);
  assert.match(source, /max-height:min\(680px,calc\(100dvh - 260px\)\)/);
  assert.match(source, /@media\(max-width:640px\)[^{]*\{[^}]*\.ai-rich-text/);
  assert.match(source, /max-height:62dvh/);
  assert.doesNotMatch(source, /overflow-y:hidden/);
});

test('stock AI provider timeout and malformed/error responses have deterministic safe fallback eligibility', () => {
  const router = require('../lib/context-ai-router-v6');
  const req = {
    body: {
      source:'stock_analysis_followup',
      chatMessage:'entry aman di mana?',
      context:{ ticker:'BBCA', analysis_text:'Harga terakhir: 1000\nEntry: 980\nStop Loss: 950\nTP1: 1050' }
    }
  };
  const should = router._test.shouldUseLocalFallback;

  assert.equal(should(req, 504, { code:'AI_TIMEOUT_NO_RETRY' }), true);
  assert.equal(should(req, 502, { code:'AI_REQUEST_ERROR' }), true);
  assert.equal(should(req, 503, { code:'AI_MODELS_FAILED_SAFE_STOP' }), true);
  assert.equal(should(req, 500, {}), true, 'malformed/unclassified 5xx should still fall back from snapshot');
  assert.equal(should(req, 400, {}), false, 'client errors must not be disguised as provider fallback');
  assert.equal(should({ body:{ source:'portfolio_chat', context:req.body.context } }, 503, {}), false);
});

test('stock local fallback quotes only numbers already present in the fixture snapshot', () => {
  const router = require('../lib/context-ai-router-v6');
  const snapshot = 'Harga terakhir: 1000\nEntry: 980\nStop Loss: 950\nTP1: 1050\nTP2: 1100';
  const reply = router._test.buildLocalStockReply('entry aman di mana?', {
    ticker:'BBCA', analysis_text:snapshot, captured_at:'2026-08-13T16:00:00+07:00'
  });

  assert.match(reply, /BBCA/);
  assert.match(reply, /980/);
  assert.match(reply, /950/);
  const numerics = reply.match(/\b\d+(?:[.,]\d+)?\b/g) || [];
  numerics.forEach(token => {
    // Timestamp tokens are source-backed too; every other numeric token must be
    // visibly present in either the snapshot or captured_at fixture.
    assert.ok(snapshot.includes(token) || '2026-08-13T16:00:00+07:00'.includes(token), 'invented numeric token: ' + token);
  });
});

// The previous version of this test asserted the exact source of the failure
// path that WAS the bug: `if (result.timedOut || !result.retriable) return`,
// `timedOut ? false : true`, an attempt cap of 2, and the AI_TIMEOUT_NO_RETRY
// code. Together those meant one slow model ended the request with a healthy
// backup untried. The contract worth protecting is the retry being BOUNDED, not
// the chain being abandoned — so it is asserted behaviourally now, against the
// router's own budget arithmetic and failure classification rather than its
// text. End-to-end coverage of the same contract lives in
// test/ai-provider-failover.test.js.
test('provider router bounds retries without abandoning the failover chain', () => {
  const router = require('../lib/context-ai-router-v4');
  const { attemptSlice, attemptLimit, modelRouteFailure, isKeyOrBalanceFailure } = router._test;

  // Bounded: a first attempt can never consume the whole budget while backups
  // remain, and a slice too small to succeed is not attempted at all.
  assert.equal(attemptSlice(20000, 20000, 3), 10000);
  assert.equal(attemptSlice(20000, 20000, 1), 20000);
  assert.equal(attemptSlice(200, 20000, 3), 0);

  // Bounded: at least one backup is always reachable, and the cap stays small.
  ['stock_analysis_followup', 'portfolio_chat'].forEach((source) => {
    const limit = attemptLimit(source, 'heavy');
    assert.ok(limit >= 2, source + ' must be able to reach a backup model');
    assert.ok(limit <= 6, source + ' must stay bounded, got ' + limit);
  });

  // Only a credential/balance failure — identical for every model behind one
  // key — ends the chain. A timeout, a 5xx, a 429 or a rejected parameter is a
  // property of one model and must move to the next.
  [401, 402, 403].forEach((status) => assert.equal(isKeyOrBalanceFailure(status), true));
  [400, 404, 408, 422, 429, 500, 503, 504].forEach((status) => assert.equal(modelRouteFailure(status), true));

  const source = read('lib/context-ai-router-v4.js');
  assert.match(source, /Respons provider bukan JSON\./, 'a non-JSON body must stay a handled failure');
  assert.match(source, /attempted_count: outcome\.attempts\.length/);
});

test('stock and portfolio UI always release their sending lock after provider failure', () => {
  const stock = read('public/stock-analysis-ai.js');
  const portfolio = read('public/portfolio-ai-runtime-v2.js');
  // Both surfaces must clear the lock from a `finally`, so no thrown path can
  // leave the composer disabled or the spinner running. The assertions allow
  // other cleanup in the same block (abort timers, loading removal) but require
  // the unlock to be present in it.
  // send() now has two finally blocks: an inner one that only cleans up the
  // in-progress SSE streaming bubble on a mid-stream failure, and the outer
  // one (asserted here) that always releases the sending lock. Match all of
  // them and require the lock-release finally specifically, so this stays
  // correct regardless of how many other finally blocks the function grows.
  const stockFinallyBlocks = stock.match(/finally \{[\s\S]*?\n {4}\}/g) || [];
  assert.ok(stockFinallyBlocks.length > 0, 'stock send() must have a finally block');
  const stockLockFinally = stockFinallyBlocks.find((block) => /setBusy\(false\);/.test(block));
  assert.ok(stockLockFinally, 'stock send() must release the sending lock from a finally block');
  assert.match(stockLockFinally, /removeLoading\(\);/, 'the loading bubble must never survive a failure');

  const portfolioFinally = portfolio.match(/finally \{[\s\S]*?\n {4}\}/);
  assert.ok(portfolioFinally, 'portfolio sendMessage() must have a finally block');
  assert.match(portfolioFinally[0], /setSending\(false\);/);
  assert.match(stock, /catch \(error\)[\s\S]*?appendNotice/);
});

test('neither AI surface renders a raw parse error as if it were an answer', () => {
  const stock = read('public/stock-analysis-ai.js');
  const portfolio = read('public/portfolio-ai-runtime-v2.js');
  // A platform error page is not JSON. `await response.json()` threw a
  // SyntaxError whose message ("Unexpected token '<' ...") was rendered into
  // the assistant bubble on the stock surface.
  [['stock-analysis-ai.js', stock], ['portfolio-ai-runtime-v2.js', portfolio]].forEach(([name, source]) => {
    const unguarded = source.match(/await response\.json\(\)(?!\s*\.catch)/g) || [];
    assert.equal(unguarded.length, 0, name + ' has an unguarded response.json()');
  });
  assert.doesNotMatch(stock, /appendAssistant\(friendly\(String\(error/, 'a thrown Error message must not be shown as an AI answer');
});

test('both AI surfaces bound their own request instead of waiting forever', () => {
  const stock = read('public/stock-analysis-ai.js');
  const portfolio = read('public/portfolio-ai-runtime-v2.js');
  [['stock-analysis-ai.js', stock], ['portfolio-ai-runtime-v2.js', portfolio]].forEach(([name, source]) => {
    assert.match(source, /new AbortController\(\)/, name + ' must be able to abort a hung request');
    assert.match(source, /REQUEST_TIMEOUT_MS/, name + ' must define a client-side deadline');
    // The client deadline must sit ABOVE the server's own ceiling, otherwise it
    // throws away an answer the server was still going to return.
    const match = source.match(/REQUEST_TIMEOUT_MS = (\d+)/);
    assert.ok(match && Number(match[1]) >= 60000, name + ' abandons the request before the server can finish');
  });
});
