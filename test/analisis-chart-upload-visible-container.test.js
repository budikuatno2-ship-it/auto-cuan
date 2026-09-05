'use strict';

// Regression test: uploading a chart/orderbook/broker-summary screenshot from
// Analisis Saham calls addUserBubble/addLoadingBubble/addAIBubble, which used
// to hardcode `document.getElementById('chatMessages')` as their container.
// #chatMessages only exists inside #aiSection, legacy markup that is
// permanently `class="hidden"` and never unhidden anywhere in this build (no
// nav item routes to it any more — it was kept only so those functions don't
// throw on a missing node). Every real invocation of these handlers happens
// while on the Analisis Saham page (the only page with a reachable send
// button), so the AI's response was silently appended to an invisible
// section and the user saw nothing happen after an image upload.
//
// The fix adds getActiveMessagesContainer(), which resolves to #analisisResult
// when on the analisis page. This extracts it (and addUserBubble, whose
// dependency surface is small enough to sandbox) straight from
// public/index.html and proves messages now land in the visible container.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

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

function makeContainer(id) {
  return {
    id,
    children: [],
    appendChild(node) { this.children.push(node); },
    get scrollHeight() { return this.children.length; },
    scrollTop: 0
  };
}

function loadWithPage(currentPage) {
  const analisisResult = makeContainer('analisisResult');
  const chatMessages = makeContainer('chatMessages');
  const elements = { analisisResult, chatMessages };

  const sandbox = {
    currentPage,
    document: {
      getElementById(id) { return elements[id] || null; },
      createElement() { return { className: '', innerHTML: '', appendChild() {} }; }
    },
    escapeHtml(v) { return String(v); }
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction(html, 'function getActiveMessagesContainer('), sandbox);
  vm.runInContext(extractFunction(html, 'function addUserBubble('), sandbox);
  return { sandbox, analisisResult, chatMessages };
}

test('addUserBubble appends to the visible #analisisResult on the Analisis Saham page', () => {
  const { sandbox, analisisResult, chatMessages } = loadWithPage('analisis');
  sandbox.addUserBubble('BBCA orderbook.png');
  assert.equal(analisisResult.children.length, 1);
  assert.equal(chatMessages.children.length, 0);
});

test('getActiveMessagesContainer falls back to #chatMessages off the analisis page', () => {
  const { sandbox, analisisResult, chatMessages } = loadWithPage('dashboard');
  sandbox.addUserBubble('hello');
  assert.equal(chatMessages.children.length, 1);
  assert.equal(analisisResult.children.length, 0);
});
