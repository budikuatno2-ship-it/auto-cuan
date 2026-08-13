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

test('provider router has bounded retry, malformed-response and timeout semantics', () => {
  const source = read('lib/context-ai-router-v4.js');
  assert.match(source, /STOCK_ANALYSIS_AI_MAX_ATTEMPTS, 2, 1, 3/);
  assert.match(source, /Respons provider bukan JSON\./);
  assert.match(source, /retriable:\s*true/);
  assert.match(source, /timedOut\s*\?\s*false\s*:\s*true/);
  assert.match(source, /if \(result\.timedOut \|\| !result\.retriable\) return/);
  assert.match(source, /AI_TIMEOUT_NO_RETRY/);
  assert.match(source, /attempted_count: outcome\.attempts\.length/);
});

test('stock and portfolio UI always release their sending lock after provider failure', () => {
  const stock = read('public/stock-analysis-ai.js');
  const portfolio = read('public/portfolio-ai-runtime-v2.js');
  assert.match(stock, /catch \(error\)[\s\S]*?appendAssistant/);
  assert.match(stock, /finally \{ setBusy\(false\); \}/);
  assert.match(portfolio, /catch \(error\)[\s\S]*?finally \{\s*setSending\(false\);/);
});
