'use strict';

// Regression test: the "Chart & AI Vision" tab (public/chart-analysis-runtime.js)
// built its own hand-rolled line-by-line HTML formatter (formatAnalysisText)
// instead of the shared window.AutoCuanAI.renderMarkdown/inlineFormat used by
// every other AI surface (Analisis Saham, Portofolio AI). It escaped text but
// never converted **bold**/`---` markdown, so Gemini's raw markdown leaked to
// the user while the exact same syntax rendered correctly everywhere else.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

function loadRuntime() {
  const window = {};
  const rendererContext = vm.createContext({
    window,
    document: {
      readyState: 'complete',
      body: { nodeType: 1, matches() { return false; }, querySelectorAll() { return []; } },
      head: { appendChild() {} },
      createElement() { return { id: '', textContent: '', style: {}, appendChild() {} }; },
      addEventListener() {}
    },
    MutationObserver: class { observe() {} },
    console
  });
  vm.runInContext(read('public/ai-chat-renderer.js'), rendererContext, { filename: 'ai-chat-renderer.js' });

  const chartContext = vm.createContext({ window, document: {}, console });
  vm.runInContext(read('public/chart-analysis-runtime.js'), chartContext, { filename: 'chart-analysis-runtime.js' });
  return window.__test.formatAnalysisText;
}

test('chart AI vision formatter converts raw ** markdown into <strong>', () => {
  const format = loadRuntime();
  const html = format('## Tren Umum\nHarga menembus **resistance kuat** di area 4.500.');
  assert.match(html, /<strong>resistance kuat<\/strong>/);
  assert.doesNotMatch(html, /\*\*/);
});

test('chart AI vision formatter drops literal markdown dividers', () => {
  const format = loadRuntime();
  const html = format('## Catatan Risiko\nRentang waktu pendek.\n----\nBukan rekomendasi transaksi.');
  assert.doesNotMatch(html, />----</);
  assert.doesNotMatch(html, /----/);
});
