'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ketentuanHtml = fs.readFileSync(path.join(ROOT, 'public', 'ketentuan.html'), 'utf8');
const vercelJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const localDevServer = fs.readFileSync(path.join(ROOT, 'tools', 'local-dev-server.js'), 'utf8');

test('Ketentuan page structure matches canvas specifications', () => {
  assert.match(ketentuanHtml, /<h1[^>]*>Ketentuan dan batasan<\/h1>/);
  assert.match(ketentuanHtml, /id="ketentuan"/);
  assert.match(ketentuanHtml, /id="risiko"/);
  assert.match(ketentuanHtml, /id="tocLinkKetentuan"/);
  assert.match(ketentuanHtml, /id="tocLinkRisiko"/);
  assert.match(ketentuanHtml, /Bukan rekomendasi beli atau jual/);
  assert.match(ketentuanHtml, /id="themeToggleBtn"/);
});

test('Ketentuan contains 12 terms and 8 risk boundaries', () => {
  // Extract items in #termsList
  const termsMatch = ketentuanHtml.match(/<ol id="termsList">([\s\S]*?)<\/ol>/);
  assert.ok(termsMatch, 'expected #termsList ol element');
  const termItems = termsMatch[1].match(/<li><div><b>([^<]+)<\/b><p>([^<]+)<\/p><\/div><\/li>/g) || [];
  assert.equal(termItems.length, 12, 'expected exactly 12 term items');

  // Extract items in #risksList
  const risksMatch = ketentuanHtml.match(/<ol id="risksList">([\s\S]*?)<\/ol>/);
  assert.ok(risksMatch, 'expected #risksList ol element');
  const riskItems = risksMatch[1].match(/<li><div><b>([^<]+)<\/b><p>([^<]+)<\/p><\/div><\/li>/g) || [];
  assert.equal(riskItems.length, 8, 'expected exactly 8 risk items');
});

test('Ketentuan route is mapped in vercel.json and local-dev-server.js', () => {
  const vercelRewrite = vercelJson.rewrites.find(r => r.source === '/ketentuan');
  assert.ok(vercelRewrite, 'expected rewrite rule for /ketentuan in vercel.json');
  assert.equal(vercelRewrite.destination, '/ketentuan.html');

  assert.match(localDevServer, /'\/ketentuan':\s*'\/ketentuan\.html'/);
});

test('Ketentuan copy has zero em dashes inside prose sentences', () => {
  assert.doesNotMatch(ketentuanHtml, /[a-zA-Z0-9] — [a-zA-Z0-9]/);
});

test('Ketentuan includes responsive layout and theme switching scripts', () => {
  assert.match(ketentuanHtml, /@media\s*\(max-width:\s*760px\)/);
  assert.match(ketentuanHtml, /autocuan_theme/);
  assert.match(ketentuanHtml, /IntersectionObserver/);
});
