'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

test('T8: Screener print stylesheet hides chrome, mascot, and buttons while expanding tables to 100%', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'ac-v2.css'), 'utf8');

  // Verify @media print section exists
  assert.match(css, /@media\s+print\s*\{/, 'ac-v2.css must contain @media print block');

  // Verify elements hidden in print
  const hiddenSelectors = [
    '.side',
    '.top',
    '.tape',
    '#siMataMascot',
    '.mata-wrap',
    '.vbtn',
    '.btn',
    '.ph-act',
    '.scr-filter-grid',
    '.adv-tools'
  ];

  for (const sel of hiddenSelectors) {
    assert.ok(css.includes(sel), `ac-v2.css print rules must include selector ${sel}`);
  }

  // Verify table and page expansion
  assert.match(css, /#page-screener\s*\{[^}]*width:\s*100%\s*!important/, 'page-screener must expand to 100%');
  assert.match(css, /table\s*\{[^}]*width:\s*100%\s*!important/, 'tables must expand to 100%');
  assert.match(css, /font-variant-numeric:\s*tabular-nums/, 'numbers must use tabular-nums');
  assert.match(css, /font-family:\s*'Geist Mono'/, 'numbers must use Geist Mono font');

  // Verify print meta header styling
  assert.match(css, /\.scr-print-meta\s*\{[^}]*display:\s*block\s*!important/, 'scr-print-meta must be displayed in print');
});

test('T8: Screener markup and runtime include print meta timestamp hook', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.match(html, /class="scr-print-meta hidden"/, 'index.html must have scr-print-meta element');
  assert.match(html, /id="scrPrintTimestamp"/, 'index.html must have scrPrintTimestamp placeholder');

  const js = fs.readFileSync(path.join(ROOT, 'public', 'market-feature-runtime.js'), 'utf8');
  assert.match(js, /window\.addEventListener\('beforeprint'/, 'market-feature-runtime must register beforeprint listener');
  assert.match(js, /scrPrintTimestamp/, 'beforeprint hook must target scrPrintTimestamp');
});

test('T8: 404 page is styled consistently with v2 design language and preserves security contracts', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', '404.html'), 'utf8');

  // V2 Design Language
  assert.match(html, /<link[^>]+href="\/fonts\/ac-fonts\.css"/, '404 must link to local /fonts/ac-fonts.css');
  assert.match(html, /<link[^>]+href="\/ac-v2\.css"/, '404 must link to /ac-v2.css');
  assert.match(html, /class="stage"/, '404 must use .stage layout wrapper');
  assert.match(html, /class="card dlg"/, '404 must use .card dlg container');
  assert.match(html, /Plus Jakarta Sans/, '404 must use Plus Jakarta Sans typography');

  // Content and Recovery Paths
  assert.match(html, /<meta name="robots" content="noindex,nofollow">/, 'Must have noindex robots meta');
  assert.match(html, /404 \/ ROUTE_NOT_FOUND/, 'Must include route not found code');
  assert.match(html, /Halaman ini tidak ada di radar/, 'Must include standard heading');
  assert.match(html, /Tidak ada data portofolio atau transaksi yang diubah/, 'Must include reassurance note');
  assert.match(html, /aria-label="Jalur pemulihan"/, 'Must include accessible recovery nav');
  assert.match(html, /href="\/dashboard"/, 'Must link to Dashboard');
  assert.match(html, /href="\/trust\.html"/, 'Must link to Trust Center');
  assert.match(html, /href="\/"/, 'Must link to Home');

  // Security & CSP purity: no scripts, no external CDN URLs
  assert.doesNotMatch(html, /<script\b/i, '404 must remain script-free');
  assert.doesNotMatch(html, /https?:\/\/[^"']+\.(?:js|css)/i, '404 must not load external assets');
});
