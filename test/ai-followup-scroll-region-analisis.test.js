'use strict';

// Regression test: the bounded-scroll treatment for AI follow-up chat
// (`.ai-followup-scroll-region`, `max-height:min(680px,calc(100dvh - 260px))`)
// only ever attached to `#chatMessages`, which lives inside `#aiSection` — a
// permanently-hidden legacy container nothing in this build ever un-hides
// (see the earlier fix pointing addAIBubble at #analisisResult instead). The
// live Analisis Saham follow-up chat renders into `#analisisResult`, so this
// scroll treatment never actually applied to what a user sees: the panel just
// grew forever and only the whole page scrolled, exactly the "kotak yang
// tidak bisa di-scroll dari dalam dirinya sendiri" bug from the scroll audit.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

function loadRenderer() {
  const body = { nodeType: 1, matches() { return false; }, querySelectorAll() { return []; } };
  const document = {
    readyState: 'complete',
    body,
    head: { appendChild() {} },
    createElement() { return { id: '', textContent: '', style: {}, appendChild() {} }; },
    addEventListener() {}
  };
  class MutationObserver { constructor(cb) { this.cb = cb; } observe() {} }
  const window = {};
  const context = vm.createContext({ window, document, MutationObserver, console });
  vm.runInContext(read('public/ai-chat-renderer.js'), context, { filename: 'ai-chat-renderer.js' });
  return window.AutoCuanAI;
}

function makeAnalisisResultAncestor() {
  const classes = new Set();
  const el = {
    classList: { add(c) { classes.add(c); }, contains(c) { return classes.has(c); } },
    hasClass(c) { return classes.has(c); }
  };
  const followupNode = {
    nodeType: 1,
    matches(sel) { return sel === '.ai-message.ai-assistant, .ai-content.ai-followup' ? false : (sel === '.ai-content.ai-followup'); },
    querySelectorAll() { return []; },
    closest(sel) { return sel === '#analisisResult' ? el : null; },
    querySelector() { return null; },
    getAttribute() { return null; },
    setAttribute() {},
    classList: { contains() { return false; }, add() {} },
    textContent: 'Jawaban follow-up.'
  };
  return { el, followupNode };
}

test('a follow-up bubble landing in #analisisResult gets the bounded scroll class', () => {
  const renderer = loadRenderer();
  const { el, followupNode } = makeAnalisisResultAncestor();
  renderer.polishNode(followupNode);
  assert.ok(el.hasClass('ai-followup-scroll-region'), '#analisisResult should receive ai-followup-scroll-region');
});

test('the bounded max-height CSS rule now targets #analisisResult too, not only the dead #chatMessages', () => {
  const source = read('public/ai-chat-renderer.js');
  assert.match(source, /#analisisResult\.ai-followup-scroll-region\{max-height:min\(680px,calc\(100dvh - 260px\)\)/);
});
