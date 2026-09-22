const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Mock browser globals lengkap
global.window = {};
global.document = {
  head: { appendChild: () => {} },
  body: { appendChild: () => {}, removeChild: () => {} },
  createElement: () => ({ setAttribute: () => {}, style: {} }),
  querySelectorAll: () => []
};
global.navigator = { clipboard: { writeText: async () => {} } };
global.MutationObserver = class {
  observe() {}
  disconnect() {}
};

// Muat public/ai-chat-renderer.js
require('../public/ai-chat-renderer.js');
const AutoCuanAI = global.window.AutoCuanAI;

test('FRONTEND FASE 7 BATCH 4: AI Chat Renderer & Markdown Formatting Bugs', async (t) => {

  await t.test('BUG-F7-017: inlineFormat merusak token di dalam inline code yang mengandung double asterisk atau underscore', () => {
    const raw = 'Gunakan fungsi __init__ untuk inisialisasi.';
    const rendered = AutoCuanAI.renderMarkdown(raw);
    
    assert.strictEqual(
      rendered.includes('<code>__init__</code>'),
      true,
      'Konten di dalam tag <code> tidak boleh dirusak oleh stripping markdown __ atau **'
    );
  });

  await t.test('BUG-F7-018: renderTable memecah sel tabel secara keliru saat terdapat escaped pipe \\|', () => {
    const tableText = [
      '| Metric | Value |',
      '| --- | --- |',
      '| Target \\| Stop | 1000 / 950 |'
    ].join('\n');
    
    const rendered = AutoCuanAI.renderMarkdown(tableText);
    
    assert.strictEqual(
      rendered.includes('<td>Target | Stop</td>') || rendered.includes('<td>Target \\| Stop</td>') || rendered.includes('<dt>Target | Stop</dt>') || rendered.includes('<dt>Target \\| Stop</dt>'),
      true,
      'Escaped pipe harus dipertahankan sebagai satu sel, bukan di-split menjadi kolom baru'
    );
  });

});
