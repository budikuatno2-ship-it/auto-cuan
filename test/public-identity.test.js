'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('public identity assets expose a restrained crawl surface', () => {
  const robots = read('public/robots.txt');
  const sitemap = read('public/sitemap.xml');

  assert.match(robots, /Allow: \/\s/);
  assert.match(robots, /Disallow: \/dashboard/);
  assert.match(robots, /Disallow: \/pattern/);
  assert.match(robots, /Sitemap: https:\/\/autocuan\.web\.id\/sitemap\.xml/);

  assert.match(sitemap, /<loc>https:\/\/autocuan\.web\.id\/<\/loc>/);
  assert.match(sitemap, /<loc>https:\/\/autocuan\.web\.id\/trust\.html<\/loc>/);
  assert.match(sitemap, /<loc>https:\/\/autocuan\.web\.id\/methodology\.html<\/loc>/);
  assert.doesNotMatch(sitemap, /\/dashboard|\/pattern|\/review|\/portfolio-planner/);
});

test('branded 404 stays standalone, non-indexable, and gives safe recovery paths', () => {
  const html = read('public/404.html');
  assert.match(html, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(html, /404 \/ ROUTE_NOT_FOUND/);
  assert.match(html, /Halaman ini tidak ada di radar/);
  assert.match(html, /Tidak ada data portofolio atau transaksi yang diubah/);
  assert.match(html, /aria-label="Jalur pemulihan"/);
  assert.match(html, /href="\/dashboard"/);
  assert.match(html, /href="\/trust\.html"/);
  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(html, /https?:\/\/[^"']+\.(?:js|css)/i);
});

test('trust center exposes product operating model without inventing certification', () => {
  const html = read('public/trust.html');
  assert.match(html, /aria-label="Trust Center sections"/);
  assert.match(html, /id="operating-boundaries"/);
  assert.match(html, /id="data-freshness"/);
  assert.match(html, /id="engineering-controls"/);
  assert.match(html, /id="responsible-disclosure"/);
  assert.match(html, /Auto-Cuan tidak mengeksekusi transaksi/);
  assert.match(html, /Auto-Cuan tidak memegang dana pengguna/);
  assert.match(html, /Data dapat terlambat atau stale/);
  assert.match(html, /tidak sama dengan audit atau sertifikasi keamanan pihak ketiga/i);
  assert.match(html, /tidak menyatakan Auto-Cuan memiliki sertifikasi eksternal/i);
  assert.match(html, /Repository Security/);
  assert.match(html, /CodeQL/);
  assert.match(html, /Repository Security Gate/);
  assert.match(html, /Production build contract/);
  assert.match(html, /Cache boundaries/);
  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(html, /guaranteed profit|jaminan profit|regulator approved|certified secure/i);
});

test('methodology explains interpretation boundaries instead of presenting scores as probabilities', () => {
  const html = read('public/methodology.html');
  assert.match(html, /Data & Methodology/);
  assert.match(html, /Sistem berhenti sebelum order/);
  assert.match(html, /Score 85 tidak berarti peluang berhasil 85%/);
  assert.match(html, /Stale warning harus dianggap serius/);
  assert.match(html, /AI dapat salah/);
  assert.match(html, /Bukan rekening kustodian/);
  assert.match(html, /Manual execution/);
  assert.match(html, /Tidak menjanjikan return/);
  assert.match(html, /Tidak menggantikan broker/);
  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(html, /guaranteed profit|jaminan profit|akurasi 100%|pasti naik/i);
});

test('trust center keeps disclosure and public policy references inspectable', () => {
  const html = read('public/trust.html');
  assert.match(html, /href="\/\.well-known\/security\.txt"/);
  assert.match(html, /github\.com\/budikuatno2-ship-it\/auto-cuan\/security/);
  assert.match(html, /Responsible disclosure/);
  assert.match(html, /Jangan menaruh kredensial, token, session material/);
});

test('security.txt points to a public policy and expires', () => {
  const txt = read('public/.well-known/security.txt');
  assert.match(txt, /Contact: https:\/\/github\.com\/budikuatno2-ship-it\/auto-cuan\/security/);
  assert.match(txt, /Policy: https:\/\/autocuan\.web\.id\/trust\.html/);
  assert.match(txt, /Canonical: https:\/\/autocuan\.web\.id\/\.well-known\/security\.txt/);
  assert.match(txt, /Preferred-Languages: id, en/);
  assert.match(txt, /Expires: 2027-08-18T00:00:00Z/);
});

test('favicon is a real multi-kilobyte binary asset', () => {
  const stat = fs.statSync(path.join(ROOT, 'public/favicon.ico'));
  assert.ok(stat.size > 1024, `favicon too small: ${stat.size} bytes`);
});
