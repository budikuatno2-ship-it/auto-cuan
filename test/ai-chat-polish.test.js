'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

function loadRenderer() {
  const body = {
    nodeType: 1,
    matches() { return false; },
    querySelectorAll() { return []; }
  };
  const document = {
    readyState: 'complete',
    body,
    head: { appendChild() {} },
    createElement() { return { id: '', textContent: '', style: {}, appendChild() {} }; },
    addEventListener() {}
  };
  class MutationObserver {
    constructor(callback) { this.callback = callback; }
    observe() {}
  }
  const window = {};
  const context = vm.createContext({ window, document, MutationObserver, console });
  vm.runInContext(read('public/ai-chat-renderer.js'), context, { filename: 'ai-chat-renderer.js' });
  return window.AutoCuanAI;
}

test('AI renderer removes raw markdown debris and joins orphan headings', () => {
  const renderer = loadRenderer();
  const html = renderer.renderMarkdown('###\n\nRisikonya\n\ngede.\n\n---\n\n**Intinya:** Entry masih berisiko.');
  assert.doesNotMatch(html, /###|---|\*\*/);
  assert.match(html, /Risikonya:<\/strong> gede\./);
  assert.match(html, /Entry masih berisiko/);
});

test('AI renderer preserves useful multi-word headings before tables', () => {
  const renderer = loadRenderer();
  const html = renderer.renderMarkdown('### Kondisi Sekarang\n\n| Data | Nilai |\n\n|---|---|\n\n| Ticker | BELL |\n| Entry | 113 |');
  assert.match(html, /<h3>Kondisi Sekarang<\/h3>/);
  assert.match(html, /<dl class="ai-kv-grid">/);
  assert.match(html, /<dt>Ticker<\/dt><dd>BELL<\/dd>/);
  assert.doesNotMatch(html, /\|---\|/);
});

test('AI renderer normalizes forced slang without exposing unsafe HTML', () => {
  const renderer = loadRenderer();
  const html = renderer.renderMarkdown('Masih belum aman juga, bestie. Lo sedang nangkap pisau. <script>alert(1)</script>');
  assert.doesNotMatch(html, /bestie|\bLo\b|nangkap pisau/i);
  // The product settled on "Anda" throughout; the normaliser used to rewrite
  // slang to the informal "kamu", which was the only place chat disagreed with
  // the rest of the interface.
  assert.match(html, /\bAnda\b/);
  assert.doesNotMatch(html, /\bkamu\b/i);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('renderer observes added elements only and remains idempotent', () => {
  const source = read('public/ai-chat-renderer.js');
  assert.doesNotMatch(source, /characterData\s*:\s*true/);
  assert.match(source, /mutation\.addedNodes/);
  assert.match(source, /data-ai-rendered/);
  assert.match(source, /ai-rich-text'\) && !el\.hasAttribute\('data-ai-raw'/);
});

test('Portfolio AI uses a bounded workspace and preserves reading position', () => {
  const source = read('public/portfolio-ai-runtime-v2.js');
  assert.match(source, /height:min\(680px,calc\(100dvh - 205px\)\)/);
  assert.match(source, /overflow-y:auto!important/);
  assert.match(source, /state\.userAtBottom/);
  assert.match(source, /Pesan terbaru ↓/);
  assert.match(source, /host\.scrollTop = previousTop/);
  assert.doesNotMatch(source, /scrollIntoView/);
});

test('Portfolio composer keeps duplicate-send and IME protections', () => {
  const source = read('public/portfolio-ai-runtime-v2.js');
  assert.match(source, /if \(!text \|\| state\.sending\) return;/);
  assert.match(source, /compositionstart/);
  assert.match(source, /!state\.composing && !event\.isComposing/);
  assert.match(source, /event\.key === 'Enter' && !event\.shiftKey/);
  assert.match(source, /finally \{\s*setSending\(false\);/);
});

test('context AI receives concise style rules without changing the classified user question', () => {
  const source = read('api/analyze.js');
  assert.match(source, /gunakan kata "kamu"/i);
  assert.match(source, /Jangan gunakan bestie, lo, lu, gue/);
  assert.match(source, /80-180 kata/);
  assert.match(source, /Bedakan snapshot\/data tersimpan dari harga real-time/);
  assert.match(source, /history\.push\(\{ role: 'user', content: styleInstruction/);
  assert.doesNotMatch(source, /chatMessage:\s*original/);
});
