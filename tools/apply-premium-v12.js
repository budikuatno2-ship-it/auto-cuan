'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const file = path.join(ROOT, 'public', 'index.html');
let html = fs.readFileSync(file, 'utf8');

function replaceOnce(label, before, after) {
  const count = html.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one match, found ${count}`);
  html = html.replace(before, after);
}

replaceOnce(
  'landing main landmark',
  '</nav>\n    <main>',
  '</nav>\n    <main id="landingMain" aria-label="Auto-Cuan public product overview">'
);

replaceOnce(
  'landing desktop navigation',
  '            <div class="landing-menu hidden md:flex items-center gap-6">\n                <a href="#landingFeatures">Fitur</a><a href="#landingHow">Cara Kerja</a><a href="#landingSafety">Safety</a><a href="#landingPreview">Preview</a><button type="button" onclick="openLoginModal()" class="landing-link">Login</button>\n            </div>',
  '            <div class="landing-menu hidden md:flex items-center gap-6">\n                <a href="#landingFeatures">Fitur</a><a href="#landingHow">Cara Kerja</a><a href="#landingSafety">Safety</a><a href="#landingPreview">Preview</a><a href="/methodology.html" class="hidden lg:inline">Methodology</a><a href="/trust.html" class="hidden lg:inline">Trust</a><button type="button" onclick="openLoginModal()" class="landing-link">Login</button>\n            </div>'
);

replaceOnce(
  'landing hero actions',
  '                    <div class="mt-7 flex landing-mobile-wrap gap-3"><button type="button" onclick="landingPrimaryAction()" class="landing-btn landing-btn-primary"><span class="landing-cta-label">Mulai Sekarang</span></button><a href="#landingPreview" class="landing-btn">Lihat Preview</a><button type="button" onclick="openLoginModal()" class="landing-btn">Login</button></div>',
  '                    <div class="mt-7 flex landing-mobile-wrap gap-3"><button type="button" onclick="landingPrimaryAction()" class="landing-btn landing-btn-primary"><span class="landing-cta-label">Mulai Sekarang</span></button><a href="#landingPreview" class="landing-btn">Lihat Preview</a><a href="/methodology.html" class="landing-btn">Cara Membaca Radar</a><button type="button" onclick="openLoginModal()" class="landing-btn">Login</button></div>'
);

replaceOnce(
  'landing trust rail',
  '                    <div class="landing-trust-rail" aria-label="Prinsip operasional Auto-Cuan">\n                        <span class="landing-trust-item">Fokus pasar IDX</span>\n                        <span class="landing-trust-item">Keputusan & eksekusi manual</span>\n                        <span class="landing-trust-item">Freshness / stale warning</span>\n                    </div>',
  '                    <div class="landing-trust-rail" aria-label="Prinsip operasional Auto-Cuan">\n                        <span class="landing-trust-item">Fokus pasar IDX</span>\n                        <span class="landing-trust-item">Keputusan & eksekusi manual</span>\n                        <a class="landing-trust-item" href="/methodology.html">Freshness & methodology</a>\n                        <a class="landing-trust-item" href="/trust.html">Trust Center & boundaries</a>\n                    </div>'
);

replaceOnce(
  'landing footer diligence links',
  '    <footer class="border-t border-slate-800/80"><div class="landing-container py-8 flex flex-col md:flex-row gap-4 md:items-center md:justify-between"><div><h2 class="font-black text-white">Auto-Cuan</h2><p class="text-sm text-gray-500">IDX Stock Radar</p></div><div class="flex flex-wrap gap-2 text-xs text-gray-500"><span>Bukan penasihat keuangan</span><span>•</span><span>Bukan rekomendasi beli/jual</span><span>•</span><span>Data bisa terlambat</span><span>•</span><span>Gunakan sebagai alat bantu analisis</span></div><button type="button" onclick="landingPrimaryAction()" class="landing-link text-left"><span class="landing-cta-label">Masuk Dashboard</span> →</button></div></footer>',
  '    <footer class="border-t border-slate-800/80"><div class="landing-container py-8 flex flex-col md:flex-row gap-4 md:items-center md:justify-between"><div><h2 class="font-black text-white">Auto-Cuan</h2><p class="text-sm text-gray-500">IDX Stock Radar</p></div><div class="landing-footer-links flex flex-wrap gap-2 text-xs text-gray-500"><a href="/methodology.html">Data & Methodology</a><span>•</span><a href="/trust.html">Trust Center</a><span>•</span><span>Bukan rekomendasi beli/jual</span><span>•</span><span>Data bisa terlambat</span><span>•</span><span>Keputusan manual</span></div><button type="button" onclick="landingPrimaryAction()" class="landing-link text-left"><span class="landing-cta-label">Masuk Dashboard</span> →</button></div></footer>'
);

fs.writeFileSync(file, html);

const testFile = path.join(ROOT, 'test', 'public-landing-diligence.test.js');
fs.writeFileSync(testFile, `'use strict';\n\nconst test = require('node:test');\nconst assert = require('node:assert/strict');\nconst fs = require('node:fs');\nconst path = require('node:path');\n\nconst html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');\n\ntest('public landing exposes trust and methodology without changing app actions', () => {\n  assert.match(html, /<main id="landingMain" aria-label="Auto-Cuan public product overview">/);\n  assert.match(html, /href="\\/methodology\\.html" class="hidden lg:inline">Methodology<\\/a>/);\n  assert.match(html, /href="\\/trust\\.html" class="hidden lg:inline">Trust<\\/a>/);\n  assert.match(html, /href="\\/methodology\\.html" class="landing-btn">Cara Membaca Radar<\\/a>/);\n  assert.match(html, /<a class="landing-trust-item" href="\\/methodology\\.html">Freshness & methodology<\\/a>/);\n  assert.match(html, /<a class="landing-trust-item" href="\\/trust\\.html">Trust Center & boundaries<\\/a>/);\n  assert.match(html, /class="landing-footer-links/);\n  assert.match(html, />Data & Methodology<\\/a>/);\n  assert.match(html, />Trust Center<\\/a>/);\n  assert.match(html, /onclick="landingPrimaryAction\\(\\)"/);\n  assert.match(html, /onclick="openLoginModal\\(\\)"/);\n});\n`);

console.log('Applied premium public-shell integration v12 and regression test');
