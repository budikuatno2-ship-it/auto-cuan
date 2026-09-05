'use strict';

// Regression test: uploading a chart/orderbook/broker-summary screenshot from
// Analisis Saham calls addUserBubble/addLoadingBubble/addAIBubble, which
// hardcoded `document.getElementById('chatMessages')` as their container.
// #chatMessages only exists inside #aiSection, legacy markup left over from
// before the Unified AI Cockpit that is permanently `class="hidden"` and
// never unhidden anywhere in this build (no nav item routes to it any more).
// handleAnalisisFollowUp() already resolves the real, visible container as
// `document.getElementById('unifiedChatMessages') || document.getElementById('analisisResult')`
// for text follow-ups — the fix mirrors that same fallback via
// getActiveMessagesContainer() so file/image uploads land in the visible
// panel instead of silently appending to the hidden section.

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

function loadWithElements(elements) {
  const sandbox = {
    document: {
      getElementById(id) { return elements[id] || null; },
      createElement() { return { className: '', innerHTML: '', appendChild() {} }; }
    },
    escapeHtml(v) { return String(v); }
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction(html, 'function getActiveMessagesContainer('), sandbox);
  vm.runInContext(extractFunction(html, 'function addUserBubble('), sandbox);
  return sandbox;
}

test('addUserBubble prefers the visible #unifiedChatMessages container', () => {
  const unifiedChatMessages = makeContainer('unifiedChatMessages');
  const analisisResult = makeContainer('analisisResult');
  const chatMessages = makeContainer('chatMessages');
  const sandbox = loadWithElements({ unifiedChatMessages, analisisResult, chatMessages });

  sandbox.addUserBubble('BBCA orderbook.png');

  assert.equal(unifiedChatMessages.children.length, 1);
  assert.equal(analisisResult.children.length, 0);
  assert.equal(chatMessages.children.length, 0);
});

test('addUserBubble falls back to #analisisResult when the cockpit container is absent', () => {
  const analisisResult = makeContainer('analisisResult');
  const chatMessages = makeContainer('chatMessages');
  const sandbox = loadWithElements({ analisisResult, chatMessages });

  sandbox.addUserBubble('hello');

  assert.equal(analisisResult.children.length, 1);
  assert.equal(chatMessages.children.length, 0);
});

test('addUserBubble only reaches the legacy hidden #chatMessages as a last resort', () => {
  const chatMessages = makeContainer('chatMessages');
  const sandbox = loadWithElements({ chatMessages });

  sandbox.addUserBubble('hello');

  assert.equal(chatMessages.children.length, 1);
});
