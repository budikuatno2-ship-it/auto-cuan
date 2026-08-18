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
  assert.doesNotMatch(sitemap, /\/dashboard|\/pattern|\/review|\/portfolio-planner/);
});

test('branded 404 stays standalone and non-indexable', () => {
  const html = read('public/404.html');
  assert.match(html, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(html, /404 \/ ROUTE_NOT_FOUND/);
  assert.match(html, /Halaman ini tidak ada di radar/);
  assert.match(html, /Tidak ada data portofolio atau transaksi yang diubah/);
  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(html, /https?:\/\/[^"']+\.(?:js|css)/i);
});

test('trust center states operating boundaries without inventing certification', () => {
  const html = read('public/trust.html');
  assert.match(html, /Auto-Cuan tidak mengeksekusi transaksi/);
  assert.match(html, /tidak memegang dana pengguna/);
  assert.match(html, /Data dapat terlambat atau stale|Data dapat terlambat\. Freshness/i);
  assert.match(html, /tidak sama dengan audit atau sertifikasi keamanan pihak ketiga/i);
  assert.match(html, /tidak menyatakan Auto-Cuan memiliki sertifikasi eksternal/i);
  assert.match(html, /Repository Security/);
});

test('security.txt points to a public policy and expires', () => {
  const txt = read('public/.well-known/security.txt');
  assert.match(txt, /Contact: https:\/\/github\.com\/budikuatno2-ship-it\/auto-cuan\/security/);
  assert.match(txt, /Policy: https:\/\/autocuan\.web\.id\/trust\.html/);
  assert.match(txt, /Canonical: https:\/\/autocuan\.web\.id\/\.well-known\/security\.txt/);
  assert.match(txt, /Expires: 2027-08-18T00:00:00Z/);
});

test('favicon is a real multi-kilobyte binary asset', () => {
  const stat = fs.statSync(path.join(ROOT, 'public/favicon.ico'));
  assert.ok(stat.size > 1024, `favicon too small: ${stat.size} bytes`);
});
